import nodemailer from "nodemailer";

// ─── HTML-safety helpers ──────────────────────────────────────────────────────

/** Escape HTML-special characters so user text never breaks the template. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape HTML entities AND convert `\n` to `<br>` so line breaks render
 * correctly in every email client (Gmail strips `white-space: pre-wrap`).
 */
function escapeAndConvertNewlines(str: string): string {
  return escapeHtml(str).replace(/\n/g, "<br>");
}

/**
 * Produce a plain-text version of the body that will NOT trigger Gmail's
 * "Show quoted text" collapse.  Rules:
 *  - Strip any `>` at the start of lines (Gmail treats them as quoting)
 *  - Collapse runs of 3+ blank lines into 2
 *  - Trim trailing whitespace per line
 */
function stripForPlainText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^>+\s?/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface SendEmailWithLinksOptions {
  to: string;
  subject: string;
  html: string;
  companyName?: string;
  gmailUser: string;
  gmailPass: string;
  senderName?: string;
  attachmentUrls?: Array<{
    filename: string;
    url: string;
  }>;
}

// ─── Build a minimal attachment list (plain links, not marketing cards) ───────
function buildAttachmentsSection(
  attachmentUrls: Array<{ filename: string; url: string }>
): string {
  if (attachmentUrls.length === 0) return "";

  const links = attachmentUrls
    .map(
      (att) =>
        `<p style="margin: 6px 0;">
          📄 <a href="${att.url}" target="_blank"
               style="color: #1a73e8; text-decoration: none; font-weight: 600;">
            ${escapeHtml(att.filename)}
          </a>
          <span style="color: #5f6368; font-size: 13px;"> — link valid for 7 days</span>
        </p>`
    )
    .join("");

  return `
    <br>
    <p style="margin: 0 0 6px 0; color: #5f6368; font-size: 14px; font-weight: 600;">
      Attached files:
    </p>
    ${links}
  `;
}

// ─── Build a clean, personal-looking HTML shell ───────────────────────────────
//
// IMPORTANT: Keep this as simple as possible.
// Deeply nested tables, large fonts, footers with "Sent by © year",
// and marketing-card designs are the #1 reason bulk emails land in spam.
// This template intentionally looks like a human wrote it in Gmail.
//
function buildFinalHtml(
  bodyText: string,
  attachmentUrls: Array<{ filename: string; url: string }>
): string {
  const attachmentsHtml = buildAttachmentsSection(attachmentUrls);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;
             font-family: Arial, sans-serif;
             font-size: 15px; line-height: 1.6; color: #202124;">

  <div style="max-width: 680px; padding: 8px 16px;">

    <!-- Email body — user's composed text -->
    <div style="font-size: 15px; line-height: 1.6; color: #202124; word-break: break-word;">
      ${escapeAndConvertNewlines(bodyText)}
    </div>

    <!-- Attachment links (only shown when files are attached) -->
    ${attachmentsHtml}

  </div>

</body>
</html>`.trim();
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function sendEmailWithLinks(
  options: SendEmailWithLinksOptions
): Promise<string> {
  const {
    to,
    subject,
    html,
    companyName,
    gmailUser,
    gmailPass,
    senderName,
    attachmentUrls = [],
  } = options;

  try {
    if (!gmailUser || !gmailPass) {
      throw new Error("Gmail credentials not configured");
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });

    await transporter.verify();

    const finalHtml = buildFinalHtml(html, attachmentUrls);

    // ── From header ────────────────────────────────────────────────────────────
    // Use the user's real name so the recipient sees e.g. "Ansh Tripathi <ansh@gmail.com>"
    // instead of just the raw email address or the app name.
    const cleanSenderName = senderName?.trim().replace(/"/g, "") || undefined;
    const fromHeader = cleanSenderName
      ? `"${cleanSenderName}" <${gmailUser}>`
      : gmailUser;

    // ── Send ───────────────────────────────────────────────────────────────────
    // Key deliverability headers:
    //  • text:     explicit plain-text avoids Gmail auto-generating one from
    //              our HTML tables (which adds ">" quoting characters that
    //              trigger the "Show quoted text" collapse).
    //  • replyTo:  without this, replies go to the From address which is fine,
    //              but setting it explicitly tells spam filters this is a real
    //              two-way conversation email, not a no-reply blast.
    const info = await transporter.sendMail({
      from: fromHeader,
      to,
      replyTo: fromHeader,   // ← tells spam filters this is a real 2-way email
      subject,
      text: stripForPlainText(html),
      html: finalHtml,
    });

    console.log(
      `✅ Email sent to ${to} (${companyName}) with ${attachmentUrls.length} attachment link(s) — Message ID: ${info.messageId}`
    );
    return info.messageId;
  } catch (error: any) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    throw new Error(`Email delivery failed: ${error.message}`);
  }
}
