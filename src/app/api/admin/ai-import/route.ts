import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { COMPANY_CATEGORIES } from "@/src/models/CompanySchema";
import { rateLimiter, rateLimitResponse } from "@/src/lib/rateLimiter";

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

function stripMarkdownFences(text: string): string {
  // Remove ```json ... ``` or ``` ... ``` wrappers some models add
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// Some free models wrap the JSON array in a stray preamble/trailing note
// despite instructions not to. Extract the outermost [...] substring instead
// of requiring the whole trimmed response to be valid JSON on its own.
function extractJsonArray(text: string): unknown[] | null {
  const cleaned = stripMarkdownFences(text);

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
  } catch {
    // fall through to substring extraction
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const sliced = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(sliced) ? sliced : null;
  } catch {
    return null;
  }
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Free-tier fallback chain: each attempt tries a different model (from a
// different upstream provider where possible) so one saturated model/provider
// doesn't burn all 3 attempts against the same rate limit. Ordered
// fastest-and-most-reliable first — openai/gpt-oss-20b:free was tried and
// dropped: it took ~49s per call and produced trailing junk after the JSON
// array on real inputs.
//
// IMPORTANT: OpenRouter's free-model catalog changes often — models get
// deprecated or moved to paid-only with little notice. If this chain starts
// failing again, check the live catalog before re-guessing model names:
//   curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY"
//   → filter for ids ending in ":free", then sanity-check latency + output
//   validity against the real system prompt before trusting a new pick.
// Verified working (latency, valid JSON) against the real extraction prompt
// on 2026-07-31: ling-3.0-flash ~3.4s, nemotron-3-super-120b ~7.5s,
// nemotron-3-nano-30b ~9.8s.
const MODEL_FALLBACK_CHAIN = [
  "inclusionai/ling-3.0-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
] as const;

// ─── System prompt (hardcoded) ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data extraction assistant. The user will give you a raw list of company emails, possibly with some extra context like company names, websites, locations, or job fields mixed in.

Your job is to extract structured company records and return ONLY a valid JSON array. No explanation, no reasoning, no markdown, no code fences, no text before or after — your entire response must be the raw JSON array and nothing else, starting with [ and ending with ].

Each object in the array must follow this exact structure:
{
  "email": string (required, must be a valid email),
  "name": string (use the company name if it is explicitly present in the input text. Otherwise derive a readable name from the email domain, e.g. "acmecorp.com" → "Acmecorp". Never leave it blank.),
  "category": array of one or more from exactly this list: ["Technology","Finance","Healthcare","Education","Marketing","E-Commerce","Logistics","Media","Real Estate","Manufacturing","Consulting","Other"],
  "website": string (only if a URL is clearly present in the input, otherwise null),
  "location": string (only if a location is clearly present in the input, otherwise null),
  "description": string (only if a description is clearly present in the input, otherwise null),
  "tags": array of strings (only keywords explicitly stated in the input, e.g. an industry or role mentioned next to the email — empty array if none)
}

Critical accuracy rules — do not guess or invent facts that are not in the input:
- Do NOT infer "category" from wordplay, guesswork, or assumptions about what a domain name might mean. Only assign a specific category if the input text contains explicit evidence (e.g. the words "healthcare startup", "law firm", "logistics company" appear next to the email). If there is no explicit evidence, use ["Other"].
- Do NOT invent "tags" from the domain name or company name. Only include a tag if that exact keyword or a close synonym is explicitly present in the input text. If no such keywords exist, return an empty array.
- Do NOT fabricate "website", "location", or "description" — only fill them when the input text plainly contains that information. Leave them null otherwise.
- It is correct and expected for most records to end up with category: ["Other"] and tags: [] when the input is just a bare email with no extra context. That is the accurate answer, not a failure.

Formatting rules:
- Every object MUST have email, name, category, and tags (even if tags is an empty array)
- website, location, description are nullable — use null if not available
- Deduplicate by email (lowercase)
- Ignore any input line that does not contain a valid email
- Return ONLY the JSON array — no other characters before "[" or after "]"`;

// ─── POST /api/admin/ai-import ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
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

  // 4. Call OpenRouter — one attempt per model in the fallback chain, with
  //    exponential backoff between attempts so retries don't instantly re-hit
  //    the same rate limit.
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not configured. Add it to .env.local" },
      { status: 500 },
    );
  }

  const MAX_ATTEMPTS = MODEL_FALLBACK_CHAIN.length;
  let parsed: unknown[] | null = null;
  let lastRawText: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const model = MODEL_FALLBACK_CHAIN[attempt - 1];

    if (attempt > 1) {
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4000);
      console.log(`[AI-IMPORT] Backing off ${backoffMs}ms before attempt ${attempt}`);
      await sleep(backoffMs);
    }

    console.log(`[AI-IMPORT] Attempt ${attempt}/${MAX_ATTEMPTS} → model=${model}`);

    try {
      const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://approach-ten.vercel.app",
          "X-Title": "Approach AI Import",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: rawInput },
          ],
          temperature: 0.1,
          max_tokens: 3000,
        }),
      });

      if (!aiRes.ok) {
        const errorBody = await aiRes.text().catch(() => "<unreadable body>");
        console.error(
          `[AI-IMPORT] Attempt ${attempt} (${model}) → HTTP ${aiRes.status}: ${errorBody}`,
        );
        continue;
      }

      const aiJson = await aiRes.json();
      const content: string = aiJson?.choices?.[0]?.message?.content ?? "";

      if (!content.trim()) {
        console.warn(`[AI-IMPORT] Attempt ${attempt} (${model}) → empty response`);
        continue;
      }

      lastRawText = content;

      const extracted = extractJsonArray(content);
      if (!extracted) {
        console.warn(
          `[AI-IMPORT] Attempt ${attempt} (${model}) → response was not a parseable JSON array, trying next model`,
        );
        continue;
      }

      parsed = extracted;
      console.log(`[AI-IMPORT] Success on attempt ${attempt} (${model})`);
      break;
    } catch (err) {
      console.error(`[AI-IMPORT] Attempt ${attempt} (${model}) → network error:`, err);
    }
  }

  if (!parsed) {
    return NextResponse.json(
      {
        error: `Failed after ${MAX_ATTEMPTS} attempts. Please try again in a few seconds.`,
        ...(lastRawText ? { raw: lastRawText } : {}),
      },
      { status: 502 },
    );
  }

  // 6. Validate each record
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
