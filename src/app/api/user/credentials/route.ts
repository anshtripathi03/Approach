import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { connectDB } from "@/src/lib/db";
import UserModel from "@/src/models/UserSchema";
import { encrypt } from "@/src/lib/encrypt";
import nodemailer from "nodemailer";
import { z } from "zod";
import { rateLimiter, rateLimitResponse } from "@/src/lib/rateLimiter";

export async function PUT(req: NextRequest) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── 1. Rate Limiting ──────────────────────────────────────────────────────
    const userEmail = session.user.email;
    const { success, retryAfter } = rateLimiter(`update-credentials-${userEmail}`, {
      limit: 5,           // Max 5 credential updates
      windowMs: 3600000,  // per 1 hour
    });

    if (!success) {
      return rateLimitResponse(retryAfter);
    }

    // ── 2. Parse and Validate ─────────────────────────────────────────────────
    const body = await req.json();
    const updateSchema = z.object({
      senderEmail: z.string().email().regex(/@gmail\.com$/, "Only Gmail supported").optional(),
      googleAppPassword: z.string().optional(),
    }).refine(data => data.senderEmail || data.googleAppPassword, {
      message: "Provide at least senderEmail or googleAppPassword",
    });

    const result = updateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { senderEmail, googleAppPassword } = result.data;

    // ── Test credentials with Nodemailer BEFORE saving ────────────────────────
    // We need both senderEmail and appPassword to verify — fetch existing if one is missing
    await connectDB();

    const existingUser = await UserModel.findOne({
      email: session.user.email,
    }).select("+googleAppPassword");

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const emailToTest = senderEmail ?? existingUser.senderEmail;

    // Only verify if credentials are being changed
    if (senderEmail || googleAppPassword) {
      let passwordToTest: string;

      if (googleAppPassword) {
        passwordToTest = googleAppPassword; // use the new one (plain)
      } else {
        // Decrypt the stored one to test with new senderEmail
        const { decrypt } = await import("@/src/lib/encrypt");
        passwordToTest = decrypt(existingUser.googleAppPassword);
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: emailToTest, pass: passwordToTest },
      });

      try {
        await transporter.verify();
      } catch {
        return NextResponse.json(
          {
            error:
              "Gmail verification failed. Please check your sender email and Google App Password.",
          },
          { status: 400 },
        );
      }
    }

    // ── Build update object ───────────────────────────────────────────────────
    const updateData: Record<string, string> = {};
    if (senderEmail) updateData.senderEmail = senderEmail.toLowerCase().trim();
    if (googleAppPassword) {
      const clean = googleAppPassword.replace(/\s/g, "");
      updateData.googleAppPassword = encrypt(clean);
    }
    
    // ── Save ──────────────────────────────────────────────────────────────────
    const updatedUser = await UserModel.findOneAndUpdate(
      { email: session.user.email },
      { $set: updateData },
      { new: true },
    );

    return NextResponse.json({
      message: "Credentials updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("[UPDATE CREDENTIALS ERROR]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
