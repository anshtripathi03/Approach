import type { AIProvider, CompletionResult } from "./types";
import { extractJsonArray, sleep } from "./shared";

// ─── Model configuration — env-driven, free-tier only ────────────────────────
//
// OpenRouter's free-model catalog rotates: model IDs get deprecated, moved to
// paid-only, or upstream-rate-limited with no notice. Two independent guards
// protect against ever silently spending money:
//   1. Static: every configured model string must literally end in ":free".
//   2. Dynamic: cross-checked against OpenRouter's live /models catalog
//      (getLiveFreeModelIds below) before any model is actually called.
// Any model failing either check is dropped, not substituted with something
// paid. If the resulting list is empty, complete() fails with "config_error".
//
// Configure via OPENROUTER_MODELS (comma-separated, in priority order). Falls
// back to the chain below — verified working (latency + valid JSON output
// against the real extraction prompt) on 2026-07-31 — if unset.
const DEFAULT_MODEL_CHAIN = [
  "inclusionai/ling-3.0-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
] as const;

function getConfiguredModelChain(): string[] {
  const fromEnv = process.env.OPENROUTER_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : [...DEFAULT_MODEL_CHAIN];
}

// In-memory cache of OpenRouter's live free-model catalog — avoids hitting
// /models on every request. /models is metadata-only and doesn't consume the
// chat-completions request quota, but caching keeps things fast regardless.
let liveFreeModelsCache: { ids: Set<string>; fetchedAt: number } | null = null;
const LIVE_CATALOG_TTL_MS = 15 * 60_000;

async function getLiveFreeModelIds(apiKey: string): Promise<Set<string> | null> {
  const now = Date.now();
  if (liveFreeModelsCache && now - liveFreeModelsCache.fetchedAt < LIVE_CATALOG_TTL_MS) {
    return liveFreeModelsCache.ids;
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error(`[AI-IMPORT][openrouter] Failed to fetch live model catalog: HTTP ${res.status}`);
      return liveFreeModelsCache?.ids ?? null;
    }
    const json = await res.json();
    const ids = new Set<string>(
      (json?.data ?? [])
        .map((m: { id?: string }) => m.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.endsWith(":free")),
    );
    liveFreeModelsCache = { ids, fetchedAt: now };
    return ids;
  } catch (err) {
    console.error("[AI-IMPORT][openrouter] Error fetching live model catalog:", err);
    return liveFreeModelsCache?.ids ?? null;
  }
}

export const openRouterProvider: AIProvider = {
  name: "openrouter",

  async complete({ systemPrompt, userInput }): Promise<CompletionResult> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: { kind: "config_error", message: "OPENROUTER_API_KEY is not configured." },
      };
    }

    // Cost-safety gate — never call a model that isn't confirmed free.
    const configuredChain = getConfiguredModelChain();
    const staticallyFree = configuredChain.filter((m) => m.endsWith(":free"));
    if (staticallyFree.length < configuredChain.length) {
      console.warn(
        `[AI-IMPORT][openrouter] Dropped non-":free" model(s) from OPENROUTER_MODELS: ${configuredChain
          .filter((m) => !m.endsWith(":free"))
          .join(", ")}`,
      );
    }

    const liveFreeIds = await getLiveFreeModelIds(apiKey);
    const verifiedChain = liveFreeIds
      ? staticallyFree.filter((m) => liveFreeIds.has(m))
      : staticallyFree; // live catalog fetch failed — fall back to the static check only

    if (liveFreeIds) {
      const droppedByLiveCheck = staticallyFree.filter((m) => !liveFreeIds.has(m));
      if (droppedByLiveCheck.length > 0) {
        console.warn(
          `[AI-IMPORT][openrouter] These configured models are no longer on the live free-tier list, skipping: ${droppedByLiveCheck.join(", ")}`,
        );
      }
    }

    if (verifiedChain.length === 0) {
      return {
        ok: false,
        error: {
          kind: "config_error",
          message:
            "No configured OpenRouter model is currently available on the free tier. " +
            "Update OPENROUTER_MODELS with a currently-free model ID — refusing to fall back to a paid model.",
        },
      };
    }

    let lastRawText: string | null = null;
    let sawPaymentRequired = false;
    let sawDailyQuotaExhausted = false;
    let dailyQuotaResetAt: string | null = null;
    let sawInvalidModel = false;

    for (let attempt = 1; attempt <= verifiedChain.length; attempt++) {
      const model = verifiedChain[attempt - 1];

      if (attempt > 1) {
        const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4000);
        console.log(`[AI-IMPORT][openrouter] Backing off ${backoffMs}ms before attempt ${attempt}`);
        await sleep(backoffMs);
      }

      console.log(`[AI-IMPORT][openrouter] Attempt ${attempt}/${verifiedChain.length} → model=${model}`);

      try {
        const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://approach-ten.vercel.app",
            "X-Title": "Approach AI Import",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userInput },
            ],
            temperature: 0.1,
            max_tokens: 3000,
          }),
        });

        if (!aiRes.ok) {
          const errorBody = await aiRes.text().catch(() => "<unreadable body>");

          if (aiRes.status === 402) {
            sawPaymentRequired = true;
            console.error(
              `[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → HTTP 402 Payment Required — ` +
              `treating as free-tier exhaustion, will NOT fall back to a paid model: ${errorBody}`,
            );
          } else if (aiRes.status === 429 && errorBody.includes("free-models-per-day")) {
            sawDailyQuotaExhausted = true;
            const resetHeader = aiRes.headers.get("X-RateLimit-Reset");
            if (resetHeader) {
              dailyQuotaResetAt = new Date(Number(resetHeader)).toISOString();
            }
            console.error(
              `[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → HTTP 429 daily free-tier quota exhausted ` +
              `(resets ${dailyQuotaResetAt ?? "unknown"}): ${errorBody}`,
            );
          } else if (aiRes.status === 400) {
            sawInvalidModel = true;
            console.error(
              `[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → HTTP 400, likely an invalid/retired model ID: ${errorBody}`,
            );
          } else {
            console.error(
              `[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → HTTP ${aiRes.status}: ${errorBody}`,
            );
          }
          continue;
        }

        const aiJson = await aiRes.json();
        const content: string = aiJson?.choices?.[0]?.message?.content ?? "";

        if (!content.trim()) {
          console.warn(`[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → empty response`);
          continue;
        }

        lastRawText = content;

        const extracted = extractJsonArray(content);
        if (!extracted) {
          console.warn(
            `[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → response was not a parseable JSON array, trying next model`,
          );
          continue;
        }

        console.log(`[AI-IMPORT][openrouter] Success on attempt ${attempt} (${model})`);
        return { ok: true, value: { records: extracted, rawText: content, modelUsed: model } };
      } catch (err) {
        console.error(`[AI-IMPORT][openrouter] Attempt ${attempt} (${model}) → network error:`, err);
      }
    }

    if (sawPaymentRequired) {
      return {
        ok: false,
        error: {
          kind: "payment_required",
          message:
            "OpenRouter's free tier is exhausted for the configured model(s) (402 Payment Required). " +
            "Not falling back to a paid model — wait for the free-tier reset or update OPENROUTER_MODELS.",
        },
      };
    }
    if (sawDailyQuotaExhausted) {
      return {
        ok: false,
        error: {
          kind: "quota_exhausted",
          message:
            "OpenRouter's shared free-tier daily quota (50 requests/day) is exhausted for this account." +
            (dailyQuotaResetAt ? ` Resets at ${dailyQuotaResetAt}.` : " It resets daily."),
          retryAfterSeconds: dailyQuotaResetAt
            ? Math.max(0, Math.round((new Date(dailyQuotaResetAt).getTime() - Date.now()) / 1000))
            : undefined,
        },
      };
    }
    if (sawInvalidModel) {
      return {
        ok: false,
        error: {
          kind: "invalid_model",
          message:
            "OpenRouter rejected the configured model ID(s) as invalid (HTTP 400). " +
            "Update OPENROUTER_MODELS — one or more entries may have been renamed or retired.",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "network_or_parse_failure",
        message: `OpenRouter: failed after ${verifiedChain.length} attempts (network errors or empty/unparseable responses).`,
        rawText: lastRawText,
      },
    };
  },
};
