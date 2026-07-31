import { z } from "zod";

// ─── EMOJI DETECTION ─────────────────────────────────────────────────────────
// A function-based approach avoids the broken character-class negation pattern
// that was incorrectly rejecting normal ASCII text.

export function containsEmoji(str: string): boolean {
  return /[\u2700-\u27BF\uE000-\uF8FF\u2011-\u26FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD10-\uDDFF]/.test(
    str
  );
}

// ─── AUTH SCHEMAS ─────────────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name cannot exceed 50 characters")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in name"),
  email: z.string().email("Invalid email address").toLowerCase().trim(),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters for better security")
    .max(128, "Password too long"),
});

export const LoginSchema = z.object({
  email: z.string().email("Invalid email address").toLowerCase().trim(),
  password: z.string().min(1, "Password is required"),
});

// ─── COMPANY SCHEMAS ──────────────────────────────────────────────────────────
// Admin only needs to provide: name, email, and category.

export const CompanySchemaValidation = z.object({
  name: z
    .string()
    .min(2, "Company name must be at least 2 characters")
    .max(100, "Company name cannot exceed 100 characters")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in the company name"),
  email: z
    .string()
    .email("Please enter a valid email address")
    .toLowerCase()
    .trim(),
  category: z
    .array(z.string())
    .min(1, "Please select at least one category"),
});

// ─── EMAIL SCHEMAS ────────────────────────────────────────────────────────────

export const SendEmailSchema = z.object({
  subject: z
    .string()
    .min(1, "Subject is required")
    .max(150, "Subject too long")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in the subject"),
  emailBody: z
    .string()
    .min(10, "Email body too short")
    .max(10000, "Email body too long (max 10,000 chars)")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in the email body"),
  companyIds: z.array(z.string()).min(1, "Select at least one company"),
});

// Single-company variant used by the attachment-download-link sender
// (src/app/api/email/send-with-supabase/route.ts) — same content rules as
// SendEmailSchema but targets one companyId instead of a batch.
export const SendEmailWithAttachmentSchema = z.object({
  subject: z
    .string()
    .min(1, "Subject is required")
    .max(150, "Subject too long")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in the subject"),
  emailBody: z
    .string()
    .min(10, "Email body too short")
    .max(10000, "Email body too long (max 10,000 chars)")
    .refine((val) => !containsEmoji(val), "Emojis are not allowed in the email body"),
  companyId: z.string().min(1, "companyId is required"),
});
