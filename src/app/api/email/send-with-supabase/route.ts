import { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/src/lib/auth";
import EmailLog from "@/src/models/EmailSchema";
import Company from "@/src/models/CompanySchema";
import { sendEmailWithLinks } from "@/src/lib/nodemailer-supabase";
import { createClient } from "@supabase/supabase-js";
import { connectDB } from "@/src/lib/db";
import UserModel from "@/src/models/UserSchema";
import { decrypt } from "@/src/lib/encrypt";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["application/pdf"];

export const dynamic = "force-dynamic";
// No maxDuration needed — each request sends exactly ONE email and returns
// immediately. The 8-second gap between emails lives entirely in the browser,
// so Vercel's tiny computer is never held open between sends.

// ─── POST ─────────────────────────────────────────────────────────────────────
//
// Sends ONE email to ONE company per request.
// The frontend is responsible for looping through companies and waiting
// 8 seconds between each call.
//
export async function POST(req: NextRequest) {
  // Instantiate Supabase client at request time
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
  );

  // ─── SESSION CHECK ──────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── FETCH USER GMAIL CREDENTIALS ──────────────────────────────────────────
  await connectDB();
  const user = await UserModel.findOne({ email: session.user.email }).select(
    "+googleAppPassword"
  );

  if (!user) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!user.senderEmail || !user.googleAppPassword) {
    return new Response(
      JSON.stringify({
        error: "Gmail credentials not configured. Please update your profile.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const gmailUser = user.senderEmail;
  const gmailPass = decrypt(user.googleAppPassword);
  const senderName = user.name || session.user?.name || undefined;

  // ─── PARSE FormData ─────────────────────────────────────────────────────────
  const formData = await req.formData();
  const subject = formData.get("subject") as string;
  const emailBody = formData.get("emailBody") as string;
  const companyId = formData.get("companyId") as string; // single company per request
  const fileEntries = formData.getAll("attachments") as File[];

  // ─── VALIDATION ─────────────────────────────────────────────────────────────
  if (!subject?.trim()) {
    return new Response(JSON.stringify({ error: "Subject is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!emailBody?.trim()) {
    return new Response(JSON.stringify({ error: "Email body is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!companyId) {
    return new Response(JSON.stringify({ error: "companyId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── UPLOAD PDFs TO SUPABASE & GET SIGNED URLS ─────────────────────────────
  const attachmentUrls: Array<{ filename: string; url: string }> = [];

  for (const file of fileEntries) {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: `File ${file.name} is not a PDF` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: `File ${file.name} exceeds 5MB limit` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const uniqueFilename = `${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}-${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from("email-attachments")
      .upload(uniqueFilename, buffer, {
        contentType: "application/pdf",
        cacheControl: "3600",
      });

    if (uploadError) {
      console.error("❌ Supabase upload error:", uploadError);
      return new Response(
        JSON.stringify({ error: `Failed to upload ${file.name}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: signedUrlData, error: signUrlError } =
      await supabase.storage
        .from("email-attachments")
        .createSignedUrl(uniqueFilename, 7 * 24 * 60 * 60);

    if (signUrlError) {
      console.error("❌ Supabase signed URL error:", signUrlError);
      return new Response(
        JSON.stringify({
          error: `Failed to generate download link for ${file.name}`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    attachmentUrls.push({ filename: file.name, url: signedUrlData.signedUrl });
  }

  // ─── FETCH COMPANY ───────────────────────────────────────────────────────────
  const company = await Company.findById(companyId).lean();

  if (!company) {
    return new Response(
      JSON.stringify({ error: "Company not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // ─── SEND THE SINGLE EMAIL ───────────────────────────────────────────────────
  try {
    const messageId = await sendEmailWithLinks({
      to: company.email,
      subject: subject.trim(),
      html: emailBody.trim(),
      attachmentUrls,
      companyName: company.name,
      gmailUser,
      gmailPass,
      senderName,
    });

    // ─── LOG TO DB ────────────────────────────────────────────────────────────
    try {
      await EmailLog.create({
        sentBy: user._id,
        senderEmail: gmailUser,
        subject: subject.trim(),
        body: emailBody.trim(),
        companies: [company._id],
        deliveryResults: [
          {
            company: company._id,
            companyEmail: company.email,
            companyName: company.name,
            status: "sent",
            messageId,
          },
        ],
        totalTargeted: 1,
        totalSent: 1,
        totalFailed: 0,
        status: "completed",
        attachmentUrls,
        sentAt: new Date(),
      });
    } catch (logErr) {
      // Non-fatal — don't fail the response if logging fails
      console.error("❌ EmailLog save error:", logErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        companyId: String(company._id),
        companyEmail: company.email,
        companyName: company.name,
        messageId,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    // ─── LOG FAILURE TO DB ────────────────────────────────────────────────────
    try {
      await EmailLog.create({
        sentBy: user._id,
        senderEmail: gmailUser,
        subject: subject.trim(),
        body: emailBody.trim(),
        companies: [company._id],
        deliveryResults: [
          {
            company: company._id,
            companyEmail: company.email,
            companyName: company.name,
            status: "failed",
            errorMessage: err.message || "Unknown error",
          },
        ],
        totalTargeted: 1,
        totalSent: 0,
        totalFailed: 1,
        status: "all_failed",
        attachmentUrls,
        sentAt: new Date(),
      });
    } catch (logErr) {
      console.error("❌ EmailLog save error:", logErr);
    }

    return new Response(
      JSON.stringify({
        success: false,
        companyId: String(company._id),
        companyEmail: company.email,
        companyName: company.name,
        error: err.message || "Email delivery failed",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}