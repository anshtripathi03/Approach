import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { connectDB } from "@/src/lib/db";
import Company, { COMPANY_CATEGORIES } from "@/src/models/CompanySchema";
import UserModel from "@/src/models/UserSchema";
import {
  rateLimiter,
  rateLimitResponse,
  getIdempotentResult,
  storeIdempotentResult,
} from "@/src/lib/rateLimiter";

// ─── Types ────────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const VALID_CATEGORIES = new Set<string>([...COMPANY_CATEGORIES]);

const MAX_RECORDS_PER_SAVE = 500;
const FIELD_LIMITS = {
  name: 100,
  description: 500,
  location: 100,
  tag: 50,
  maxTags: 20,
} as const;

interface IncomingRecord {
  email: string;
  name: string;
  category: string[];
  website?: string | null;
  location?: string | null;
  description?: string | null;
  tags?: string[];
}

interface SaveError {
  email: string;
  reason: string;
}

// ─── POST /api/admin/ai-import/save ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Auth — must be admin
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden: Admins only" }, { status: 403 });
  }

  // 2. Rate limit — 10 saves per minute per user
  const rl = rateLimiter(`ai-import-save-${session.user.id}`, { limit: 10, windowMs: 60_000 });
  if (!rl.success) {
    return rateLimitResponse(rl.retryAfter);
  }

  // 3. Idempotency — replaying the same Idempotency-Key within the TTL
  //    window returns the original result instead of re-inserting records
  //    (protects against double-click / retried-request duplicate saves).
  const idempotencyKey = req.headers.get("Idempotency-Key");
  const idempotencyNamespace = idempotencyKey
    ? `ai-import-save-${session.user.id}-${idempotencyKey}`
    : null;

  if (idempotencyNamespace) {
    const cached = getIdempotentResult(idempotencyNamespace);
    if (cached) {
      return NextResponse.json(cached.result, { status: cached.status });
    }
  }

  // 4. Parse body
  let records: IncomingRecord[];
  try {
    const body = await req.json();
    records = body?.records;
    if (!Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { error: "records must be a non-empty array" },
        { status: 400 },
      );
    }
    if (records.length > MAX_RECORDS_PER_SAVE) {
      return NextResponse.json(
        { error: `Cannot save more than ${MAX_RECORDS_PER_SAVE} records in one request` },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 5. Connect to DB + resolve addedBy from session (NEVER from frontend)
  await connectDB();

  const adminUser = await UserModel.findOne({ email: session.user.email })
    .select("_id")
    .lean();

  if (!adminUser) {
    return NextResponse.json(
      { error: "Admin user not found in database" },
      { status: 500 },
    );
  }

  const addedBy = adminUser._id;

  // 6. Use Promise.allSettled so one failure never aborts the rest
  const results = await Promise.allSettled(
    records.map(async (rec) => {
      // Lightweight re-validation server-side (never trust frontend alone)
      const email = String(rec.email ?? "").toLowerCase().trim();
      if (!EMAIL_REGEX.test(email)) throw new Error(`Invalid email: ${rec.email}`);

      const name = String(rec.name ?? "").trim();
      if (name.length < 2) throw new Error(`Name too short: ${rec.name}`);
      if (name.length > FIELD_LIMITS.name) {
        throw new Error(`Name exceeds ${FIELD_LIMITS.name} characters`);
      }

      const category = (rec.category ?? []).filter(
        (c) => typeof c === "string" && VALID_CATEGORIES.has(c),
      );
      if (category.length === 0) throw new Error("No valid categories");

      const location = typeof rec.location === "string" ? rec.location.trim() : "";
      if (location.length > FIELD_LIMITS.location) {
        throw new Error(`Location exceeds ${FIELD_LIMITS.location} characters`);
      }

      const description = typeof rec.description === "string" ? rec.description.trim() : "";
      if (description.length > FIELD_LIMITS.description) {
        throw new Error(`Description exceeds ${FIELD_LIMITS.description} characters`);
      }

      const tags = Array.isArray(rec.tags)
        ? rec.tags.filter((t) => typeof t === "string").slice(0, FIELD_LIMITS.maxTags)
        : [];
      if (tags.some((t) => t.length > FIELD_LIMITS.tag)) {
        throw new Error(`One or more tags exceed ${FIELD_LIMITS.tag} characters`);
      }

      const doc: Record<string, unknown> = {
        email,
        name,
        category,
        addedBy,
        isActive: true,
        tags,
      };
      if (rec.website) doc.website = rec.website;
      if (location) doc.location = location;
      if (description) doc.description = description;

      return Company.create(doc);
    }),
  );

  // 5. Tally outcomes
  let saved = 0;
  let duplicates = 0;
  let failed = 0;
  const errors: SaveError[] = [];

  results.forEach((result, idx) => {
    const email = records[idx]?.email ?? `row ${idx + 1}`;
    if (result.status === "fulfilled") {
      saved++;
    } else {
      const err = result.reason as { code?: number; message?: string };
      if (err?.code === 11000) {
        duplicates++;
      } else {
        failed++;
        errors.push({ email, reason: err?.message ?? "Unknown error" });
      }
    }
  });

  const responseBody = {
    saved,
    duplicates,
    failed,
    total: records.length,
    errors,
  };

  if (idempotencyNamespace) {
    storeIdempotentResult(idempotencyNamespace, responseBody, 200);
  }

  return NextResponse.json(responseBody);
}
