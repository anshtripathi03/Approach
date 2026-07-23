import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { connectDB } from "@/src/lib/db";
import { decrypt } from "@/src/lib/encrypt";
import User from "@/src/models/UserSchema";
import Company from "@/src/models/CompanySchema";
import EmailLog, { IDeliveryResult } from "@/src/models/EmailSchema";
import { rateLimiter, rateLimitResponse } from "@/src/lib/rateLimiter";
import { SendEmailSchema } from "@/src/lib/validations";

export async function POST(req: NextRequest) {
  try {
    // ── 1. Auth check ─────────────────────────────────────────────────────────
    const session = await getServerSession(authOptions);

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── 2. Rate Limiting (by user) ──────────────────────────────────────────
    const userEmail = session.user.email;
    const { success, retryAfter } = rateLimiter(`send-email-${userEmail}`, {
      limit: 3,           // Max 3 bulk send actions
      windowMs: 3600000,  // per 1 hour
    });

    if (!success) {
      return rateLimitResponse(retryAfter);
    }

    // ── 3. Parse and Validate Form data ───────────────────────────────────────
    const formData = await req.formData();
    const companyIds = formData.getAll("companyIds") as string[];
    const subject = formData.get("subject") as string;
    const emailBody = formData.get("emailBody") as string;

    const validation = SendEmailSchema.safeParse({
      companyIds,
      subject,
      emailBody,
    });

    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error.issues[0].message },
        { status: 400 }
      );
    }

    // ── 3. Connect DB ─────────────────────────────────────────────────────────
    await connectDB();

    // ── 4. Fetch user with sensitive fields ───────────────────────────────────
    const user = await User.findOne({ email: session.user.email }).select(
      "+googleAppPassword +password",
    );

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!user.googleAppPassword || !user.senderEmail) {
      return NextResponse.json(
        { error: "Sender email or Google App Password not configured" },
        { status: 400 },
      );
    }

    // ── 5. Decrypt Google App Password ────────────────────────────────────────
    let appPassword: string;
    try {
      appPassword = decrypt(user.googleAppPassword);
    } catch {
      return NextResponse.json(
        {
          error: "Failed to decrypt credentials. Please re-save your settings.",
        },
        { status: 500 },
      );
    }

    // ── 6. Fetch target companies ─────────────────────────────────────────────
    const companies = await Company.find({
      _id: { $in: companyIds },
      isActive: true,
    });

    if (!companies.length) {
      return NextResponse.json(
        { error: "No active companies found for the given IDs" },
        { status: 404 },
      );
    }

    // ── 7. Create Nodemailer transporter ──────────────────────────────────────
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: user.senderEmail,
        pass: appPassword,
      },
    });

    // ── 8. Verify transporter (catches wrong credentials early) ───────────────
    try {
      await transporter.verify();
    } catch {
      return NextResponse.json(
        {
          error:
            "Gmail authentication failed. Check your sender email and Google App Password.",
        },
        { status: 400 },
      );
    }

    // ── 9. Send emails to all companies ───────────────────────────────────────
    const cleanSenderName = (user.name || session.user?.name || "").trim().replace(/"/g, "");
    const fromHeader = cleanSenderName
      ? `"${cleanSenderName}" <${user.senderEmail}>`
      : user.senderEmail;

    const settled = await Promise.allSettled(
      companies.map((company) =>
        transporter.sendMail({
          from: fromHeader,
          to: company.email,
          subject: subject,
          text: emailBody,
          html: emailBody,
        }),
      ),
    );

    // ── 10. Build delivery results ────────────────────────────────────────────
    const deliveryResults: IDeliveryResult[] = companies.map((company, i) => {
      const result = settled[i];
      if (result.status === "fulfilled") {
        return {
          company: company._id,
          companyEmail: company.email,
          companyName: company.name,
          status: "sent",
          messageId: result.value.messageId ?? undefined,
        };
      } else {
        return {
          company: company._id,
          companyEmail: company.email,
          companyName: company.name,
          status: "failed",
          errorMessage:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error",
        };
      }
    });

    // ── 11. Compute totals and status ─────────────────────────────────────────
    const totalSent = deliveryResults.filter((r) => r.status === "sent").length;
    const totalFailed = deliveryResults.filter(
      (r) => r.status === "failed",
    ).length;

    // Determine overall status BEFORE saving
    let computedStatus: "completed" | "partial" | "all_failed";
    if (totalFailed === 0) {
      computedStatus = "completed";
    } else if (totalSent === 0) {
      computedStatus = "all_failed";
    } else {
      computedStatus = "partial";
    }

    // ── 12. Save email log with all required fields ───────────────────────────
    const emailLog = await EmailLog.create({
      sentBy: user._id,
      senderEmail: user.senderEmail,
      subject,
      body: emailBody,
      companies: companies.map((c) => c._id),
      deliveryResults,
      totalTargeted: companies.length,
      totalSent, // ✅ EXPLICITLY SET
      totalFailed, // ✅ EXPLICITLY SET
      status: computedStatus, // ✅ EXPLICITLY SET - This is the key fix!
      sentAt: new Date(),
    });

    // ── 13. Increment user's email sent count ─────────────────────────────────
    await User.findByIdAndUpdate(user._id, {
      $inc: { emailsSentCount: totalSent },
    });

    // ── 14. Return result ─────────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      summary: {
        totalTargeted: emailLog.totalTargeted,
        totalSent: emailLog.totalSent,
        totalFailed: emailLog.totalFailed,
        status: emailLog.status,
      },
      deliveryResults,
    });
  } catch (error) {
    console.error("[EMAIL SEND ERROR]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
