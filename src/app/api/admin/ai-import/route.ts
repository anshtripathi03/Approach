import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { COMPANY_CATEGORIES } from "@/src/models/CompanySchema";
import { rateLimiter, rateLimitResponse } from "@/src/lib/rateLimiter";
import { getAIProvider, SYSTEM_PROMPT } from "@/src/lib/ai-providers";
import type { CompletionFailure } from "@/src/lib/ai-providers";

// ─── Types ────────────────────────────────────────────────────────────────────

type CompanyCategory = (typeof COMPANY_CATEGORIES)[number];

export interface ParsedRecord {
  email: string;
  name: string;
  category: CompanyCategory[];
  website: string | null;
  location: string | null;
  description: string | null;
  tags: string[];
}

interface SkippedRecord {
  raw: unknown;
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const VALID_CATEGORIES = new Set<string>([...COMPANY_CATEGORIES]);

const MAX_RAW_INPUT_LENGTH = 4000;

// Strip non-printable/control characters (keep newlines and tabs) before
// handing raw user text to the model.
function sanitizeRawInput(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (ch === "\n" || ch === "\t" || ch === "\r") return true;
      const isControl = code <= 0x1f || code === 0x7f;
      return !isControl;
    })
    .join("");
}

// Maps a provider-agnostic failure to the right HTTP status/response body —
// same failure kind means the same response regardless of which AI provider
// (OpenRouter, Gemini) produced it.
function failureToResponse(failure: CompletionFailure) {
  switch (failure.kind) {
    case "payment_required":
      return NextResponse.json({ error: failure.message }, { status: 402 });
    case "quota_exhausted":
      return NextResponse.json(
        {
          error: failure.message,
          ...(failure.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: failure.retryAfterSeconds }
            : {}),
        },
        { status: 429 },
      );
    case "invalid_model":
      return NextResponse.json({ error: failure.message }, { status: 400 });
    case "config_error":
      return NextResponse.json({ error: failure.message }, { status: 503 });
    case "network_or_parse_failure":
    default:
      return NextResponse.json(
        {
          error: failure.message,
          ...(failure.rawText ? { raw: failure.rawText } : {}),
        },
        { status: 502 },
      );
  }
}

// ─── POST /api/admin/ai-import ────────────────────────────────────────────────
//
// Top-level catch-all: no matter what fails inside handleImport (a bug in
// validation logic, an unexpected shape from the AI provider, etc.), the
// client always gets a JSON error response instead of an unhandled-exception
// 500.
export async function POST(req: NextRequest) {
  try {
    return await handleImport(req);
  } catch (err) {
    console.error("[AI-IMPORT] Unhandled error in POST handler:", err);
    return NextResponse.json(
      { error: "Unexpected server error while processing the import." },
      { status: 500 },
    );
  }
}

async function handleImport(req: NextRequest) {
  // 1. Auth — must be admin
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden: Admins only" }, { status: 403 });
  }

  // 2. Rate limit — 5 calls per minute per user
  const rl = rateLimiter(session.user.id, { limit: 5, windowMs: 60_000 });
  if (!rl.success) {
    return rateLimitResponse(rl.retryAfter);
  }

  // 3. Parse + sanitize body
  let rawInput: string;
  try {
    const body = await req.json();
    rawInput = body?.rawInput;
    if (typeof rawInput !== "string" || !rawInput.trim()) {
      return NextResponse.json(
        { error: "rawInput must be a non-empty string" },
        { status: 400 },
      );
    }
    if (rawInput.length > MAX_RAW_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `rawInput exceeds ${MAX_RAW_INPUT_LENGTH} characters` },
        { status: 400 },
      );
    }
    rawInput = sanitizeRawInput(rawInput);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 4. Call the configured AI provider (AI_PROVIDER=openrouter|gemini).
  //    Each provider handles its own model fallback chain, backoff, and
  //    free-tier safety gating internally — see src/lib/ai-providers/.
  const provider = getAIProvider();
  const result = await provider.complete({ systemPrompt: SYSTEM_PROMPT, userInput: rawInput });

  if (!result.ok) {
    console.error(`[AI-IMPORT] Provider "${provider.name}" failed: ${result.error.kind} — ${result.error.message}`);
    return failureToResponse(result.error);
  }

  const parsed = result.value.records;

  // 5. Validate each record
  const records: ParsedRecord[] = [];
  const skipped: SkippedRecord[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      skipped.push({ raw: item, reason: "Not an object" });
      continue;
    }

    const r = item as Record<string, unknown>;

    // email
    const email = String(r.email ?? "").toLowerCase().trim();
    if (!email || !EMAIL_REGEX.test(email)) {
      skipped.push({ raw: r, reason: `Invalid email: "${r.email}"` });
      continue;
    }

    // name
    const name = String(r.name ?? "").trim();
    if (!name || name.length < 2) {
      skipped.push({ raw: r, reason: `Name too short or missing: "${r.name}"` });
      continue;
    }

    // category
    const rawCats = Array.isArray(r.category) ? r.category : [];
    const category = rawCats.filter(
      (c): c is CompanyCategory =>
        typeof c === "string" && VALID_CATEGORIES.has(c),
    );
    if (category.length === 0) {
      skipped.push({
        raw: r,
        reason: `No valid categories found in: ${JSON.stringify(r.category)}`,
      });
      continue;
    }

    records.push({
      email,
      name,
      category,
      website: typeof r.website === "string" && r.website ? r.website : null,
      location: typeof r.location === "string" && r.location ? r.location : null,
      description:
        typeof r.description === "string" && r.description ? r.description : null,
      tags: Array.isArray(r.tags)
        ? r.tags.filter((t): t is string => typeof t === "string")
        : [],
    });
  }

  return NextResponse.json({
    records,
    skipped,
    total: parsed.length,
    valid: records.length,
    invalidCount: skipped.length,
  });
}
