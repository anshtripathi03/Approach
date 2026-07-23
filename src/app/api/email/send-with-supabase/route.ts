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
const DELAY_BETWEEN_EMAILS_MS = 5000;

export const dynamic = "force-dynamic";
export const maxDuration = 3000; // Allow up to 5 minutes for bulk email sends (Vercel Pro)

// ─── Helper ──────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Encode an event as a newline-delimited JSON string */
function encodeEvent(payload: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload) + "\n");
}

// ─── POST ─────────────────────────────────────────────────────────────────────
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
  const companyIds = formData.getAll("companyIds") as string[];
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
  if (!companyIds || companyIds.length === 0) {
    return new Response(
      JSON.stringify({ error: "At least one company is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
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

  // ─── FETCH COMPANIES ─────────────────────────────────────────────────────────
  const companies = await Company.find({ _id: { $in: companyIds } }).lean();

  if (companies.length === 0) {
    return new Response(
      JSON.stringify({ error: "No valid companies found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // ─── STREAM: Send emails one-by-one, emit NDJSON events ────────────────────
  const deliveryResults: any[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Event 1 — total count so the UI can show a progress bar
        controller.enqueue(
          encodeEvent({ type: "start", total: companies.length })
        );

        for (let i = 0; i < companies.length; i++) {
          const company = companies[i];

          let result: any;
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

            result = {
              company: company._id,
              companyEmail: company.email,
              companyName: company.name,
              status: "sent" as const,
              messageId,
            };
          } catch (err: any) {
            result = {
              company: company._id,
              companyEmail: company.email,
              companyName: company.name,
              status: "failed" as const,
              errorMessage: err.message || "Unknown error",
            };
          }

          deliveryResults.push(result);

          // Event 2 — one result per email
          controller.enqueue(
            encodeEvent({ type: "result", index: i, data: result })
          );

          // 5-second delay before next email (skip after last)
          if (i < companies.length - 1) {
            await delay(DELAY_BETWEEN_EMAILS_MS);
          }
        }

        // ─── Save log to DB ───────────────────────────────────────────────────
        const totalSent = deliveryResults.filter(
          (r) => r.status === "sent"
        ).length;
        const totalFailed = deliveryResults.filter(
          (r) => r.status === "failed"
        ).length;

        let status: "completed" | "partial" | "all_failed";
        if (totalFailed === 0) status = "completed";
        else if (totalSent === 0) status = "all_failed";
        else status = "partial";

        try {
          await EmailLog.create({
            sentBy: session.user.id,
            senderEmail: gmailUser,
            subject: subject.trim(),
            body: emailBody.trim(),
            companies: companyIds,
            deliveryResults,
            totalTargeted: companies.length,
            totalSent,
            totalFailed,
            status,
            attachmentUrls,
            sentAt: new Date(),
          });
        } catch (logErr) {
          console.error("❌ EmailLog save error:", logErr);
        }

        // Event 3 — done summary
        controller.enqueue(
          encodeEvent({
            type: "done",
            summary: {
              totalTargeted: companies.length,
              totalSent,
              totalFailed,
              status,
            },
            deliveryResults,
          })
        );
      } catch (err: any) {
        controller.enqueue(
          encodeEvent({ type: "error", message: err.message || "Server error" })
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no", // disable Nginx/Vercel proxy buffering
    },
  });
}