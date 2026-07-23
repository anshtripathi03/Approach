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

// ─── Build professional attachment cards ─────────────────────────────────────
function buildAttachmentsSection(
  attachmentUrls: Array<{ filename: string; url: string }>
): string {
  if (attachmentUrls.length === 0) return "";

  const cards = attachmentUrls
    .map(
      (att) => `
      <tr>
        <td style="padding: 6px 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding: 8px 0;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" 
                       style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px;">
                  <tr>
                    <td style="vertical-align: middle;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td style="padding-right: 12px; vertical-align: middle;">
                            <span style="font-size: 24px;">📄</span>
                          </td>
                          <td style="vertical-align: middle;">
                            <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 19px; font-weight: 700; color: #1e293b; line-height: 1.2;">
                              ${att.filename}
                            </span>
                            <br></br>
                            <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px;">
                              PDF Document
                            </span>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td style="text-align: right; vertical-align: middle;">
                      <a href="${att.url}"
                         target="_blank"
                         style="
                           display: inline-block;
                           padding: 10px 22px;
                           background-color: #6366f1;
                           color: #ffffff;
                           text-decoration: none;
                           border-radius: 8px;
                           font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                           font-size: 17px;
                           font-weight: 700;
                           box-shadow: 0 2px 4px rgba(99, 102, 241, 0.2);
                         ">
                        Download
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    )
    .join("");

  return `
    <!-- Attachments heading -->
    <tr>
      <td style="padding: 32px 0 8px 0;">
        <span style="
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          font-size: 15px;
          font-weight: 700;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        ">📎 Attachments (Link expires in 7 days)</span>
      </td>
    </tr>

    <!-- Attachment links -->
    ${cards}
  `;
}

// ─── Wrap the user's plain-text / HTML body in a professional shell ──────────
function buildFinalHtml(
  bodyText: string,
  senderEmail: string,
  attachmentUrls: Array<{ filename: string; url: string }>
): string {
  const year = new Date().getFullYear();
  const attachmentsHtml = buildAttachmentsSection(attachmentUrls);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Email</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; line-height: 1.6; color: #0f172a;">

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #ffffff;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width: 100%;">
          <tr>
            <td style="padding: 0 16px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">

                <tr>
                  <td style="
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    font-size: 26px;
                    line-height: 1.6;
                    color: #0f172a;
                    mso-line-height-rule: exactly;
                  ">
                    <div style="
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                      font-size: 26px;
                      line-height: 1.6;
                      color: #0f172a;
                      word-break: break-word;
                      width: 100%;
                    ">${escapeAndConvertNewlines(bodyText)}</div>
                  </td>
                </tr>

                ${attachmentsHtml}

                <tr>
                  <td style="padding-top: 40px; border-top: 1px solid #f1f5f9;">
                    <p style="
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                      font-size: 15px;
                      color: #94a3b8;
                      margin: 0;
                    ">
                      Sent by <a href="mailto:${senderEmail}" style="color: #6366f1; text-decoration: none;">${senderEmail}</a> · © ${year}
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
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

    const finalHtml = buildFinalHtml(html, gmailUser, attachmentUrls);

    const cleanSenderName = senderName?.trim().replace(/"/g, "") || undefined;
    const fromHeader = cleanSenderName
      ? `"${cleanSenderName}" <${gmailUser}>`
      : gmailUser;

    // Provide an explicit plain-text body so nodemailer does NOT auto-generate
    // one from the HTML template. The auto-generated text version of nested
    // tables can contain ">" characters that Gmail interprets as quoted content,
    // causing the entire email to collapse behind "Show quoted text".
    // We run the raw body through stripForPlainText() to remove any leading ">"
    // characters and collapse excessive blank lines.
    const info = await transporter.sendMail({
      from: fromHeader,
      to,
      subject,
      text: stripForPlainText(html),
      html: finalHtml,
    });

    console.log(
      `✅ Email sent to ${to} (${companyName}) with ${attachmentUrls.length} download link(s) — Message ID: ${info.messageId}`
    );
    return info.messageId;
  } catch (error: any) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    throw new Error(`Email delivery failed: ${error.message}`);
  }
}

