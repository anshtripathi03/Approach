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
  // Remove ```json ... ``` or ``` ... ``` wrappers Gemini sometimes adds
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// ─── System prompt (hardcoded) ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data extraction assistant. The user will give you a raw list of company emails, possibly with some extra context like company names, websites, locations, or job fields mixed in.

Your job is to extract structured company records and return ONLY a valid JSON array. No explanation, no markdown, no code fences — just the raw JSON array.

Each object in the array must follow this exact structure:
{
  "email": string (required, must be a valid email),
  "name": string (use company name if found. If the company name is not found or the domain is not mentioned, label the name as "HR"),
  "category": array of one or more from exactly this list: ["Technology","Finance","Healthcare","Education","Marketing","E-Commerce","Logistics","Media","Real Estate","Manufacturing","Consulting","Other"] — infer from context, default to ["Other"] if unknown,
  "website": string (only if a URL is clearly present, otherwise null),
  "location": string (only if a location is clearly present, otherwise null),
  "description": string (only if a description is clearly present, otherwise null),
  "tags": array of strings (extract any relevant keywords, empty array if none)
}

Rules:
- Every object MUST have email, name, category, and tags (even if tags is empty array)
- website, location, description are nullable — use null if not available
- Deduplicate by email (lowercase)
- Ignore any input that does not contain a valid email
- Return ONLY the JSON array, starting with [ and ending with ]`;

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

  // 3. Parse body
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
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 4. Call OpenRouter API — let OpenRouter pick any free model, retry up to 3 times
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not configured. Add it to .env.local" },
      { status: 500 },
    );
  }

  const MAX_ATTEMPTS = 3;
  let geminiText: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[AI-IMPORT] Attempt ${attempt}/${MAX_ATTEMPTS}`);

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
          model: "openrouter/auto",
          route: "fallback",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: rawInput },
          ],
          temperature: 0.1,
          max_tokens: 8192,
        }),
      });

      if (!aiRes.ok) {
        console.warn(`[AI-IMPORT] Attempt ${attempt} → HTTP ${aiRes.status}, retrying…`);
        continue;
      }

      const aiJson = await aiRes.json();
      const content: string = aiJson?.choices?.[0]?.message?.content ?? "";

      if (!content.trim()) {
        console.warn(`[AI-IMPORT] Attempt ${attempt} → empty response, retrying…`);
        continue;
      }

      geminiText = content;
      console.log(`[AI-IMPORT] Success on attempt ${attempt}`);
      break;
    } catch (err) {
      console.error(`[AI-IMPORT] Attempt ${attempt} → network error:`, err);
    }
  }

  if (!geminiText) {
    return NextResponse.json(
      { error: `Failed after ${MAX_ATTEMPTS} attempts. Please try again in a few seconds.` },
      { status: 502 },
    );
  }

  // 5. Strip markdown fences and parse JSON
  const cleanText = stripMarkdownFences(geminiText);
  let parsed: unknown[];
  try {
    parsed = JSON.parse(cleanText);
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  } catch {
    return NextResponse.json(
      {
        error: "Gemini returned unparseable response",
        raw: geminiText,
      },
      { status: 422 },
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
