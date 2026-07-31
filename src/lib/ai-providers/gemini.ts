import { GoogleGenAI } from "@google/genai";
import type { AIProvider, CompletionResult } from "./types";
import { extractJsonArray, sleep } from "./shared";

// ─── Model configuration — env-driven, free-tier only ────────────────────────
//
// IMPORTANT: model availability on a Gemini API key is NOT the same as what
// GoogleGenAI.models.list() reports — a model can be listed yet still return
// 404 "no longer available to new users" for a given key/account cohort.
// Verified LIVE against this project's actual key on 2026-08-01:
//   gemini-2.5-flash        → 404 (not available to new users)
//   gemini-2.5-flash-lite   → 404 (not available to new users)
//   gemini-2.0-flash        → 429 (zero free quota for this account)
//   gemini-2.0-flash-lite   → 429 (zero free quota for this account)
//   gemini-flash-lite-latest→ 200 OK, ~1s, valid JSON
//   gemini-flash-latest     → 200 OK, ~10s, valid JSON
// Do not assume a specific version string stays free — re-verify against a
// real generateContent() call (not just the model list) if this chain starts
// failing, since Google's free-tier eligibility varies by model and account.
//
// Configure via GEMINI_MODELS (comma-separated, in priority order).
const DEFAULT_MODEL_CHAIN = ["gemini-flash-lite-latest", "gemini-flash-latest"] as const;

function getConfiguredModelChain(): string[] {
  const fromEnv = process.env.GEMINI_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : [...DEFAULT_MODEL_CHAIN];
}

interface GeminiApiError {
  status?: number;
  message?: string;
}

export const geminiProvider: AIProvider = {
  name: "gemini",

  async complete({ systemPrompt, userInput }): Promise<CompletionResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: { kind: "config_error", message: "GEMINI_API_KEY is not configured." },
      };
    }

    const models = getConfiguredModelChain();
    if (models.length === 0) {
      return {
        ok: false,
        error: { kind: "config_error", message: "GEMINI_MODELS resolved to an empty list." },
      };
    }

    const ai = new GoogleGenAI({ apiKey });

    let lastRawText: string | null = null;
    let sawQuotaExhausted = false;
    let sawInvalidModel = false;

    for (let attempt = 1; attempt <= models.length; attempt++) {
      const model = models[attempt - 1];

      if (attempt > 1) {
        const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4000);
        console.log(`[AI-IMPORT][gemini] Backing off ${backoffMs}ms before attempt ${attempt}`);
        await sleep(backoffMs);
      }

      console.log(`[AI-IMPORT][gemini] Attempt ${attempt}/${models.length} → model=${model}`);

      try {
        const response = await ai.models.generateContent({
          model,
          contents: userInput,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: "application/json",
            temperature: 0.1,
            maxOutputTokens: 3000,
          },
        });

        const text = response.text ?? "";
        if (!text.trim()) {
          console.warn(`[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → empty response`);
          continue;
        }

        lastRawText = text;

        const extracted = extractJsonArray(text);
        if (!extracted) {
          console.warn(
            `[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → response was not a parseable JSON array, trying next model`,
          );
          continue;
        }

        console.log(`[AI-IMPORT][gemini] Success on attempt ${attempt} (${model})`);
        return { ok: true, value: { records: extracted, rawText: text, modelUsed: model } };
      } catch (err) {
        const apiErr = err as GeminiApiError;
        const status = apiErr?.status;
        const message = apiErr?.message ?? String(err);

        if (status === 404) {
          sawInvalidModel = true;
          console.error(
            `[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → HTTP 404, model unavailable for this key: ${message}`,
          );
        } else if (status === 429) {
          sawQuotaExhausted = true;
          console.error(
            `[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → HTTP 429 quota exceeded: ${message}`,
          );
        } else if (status === 402) {
          // Gemini doesn't typically emit 402, but handle defensively in case
          // that changes — never treat this as license to fall back to a
          // billed call.
          sawQuotaExhausted = true;
          console.error(
            `[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → HTTP 402 payment required: ${message}`,
          );
        } else {
          console.error(`[AI-IMPORT][gemini] Attempt ${attempt} (${model}) → error (status=${status}):`, message);
        }
      }
    }

    if (sawQuotaExhausted) {
      return {
        ok: false,
        error: {
          kind: "quota_exhausted",
          message:
            "Gemini's free-tier quota is exhausted for the configured model(s). " +
            "Not falling back to a paid tier — wait for the quota to reset or update GEMINI_MODELS.",
        },
      };
    }
    if (sawInvalidModel) {
      return {
        ok: false,
        error: {
          kind: "invalid_model",
          message:
            "Gemini rejected the configured model ID(s) as unavailable for this API key (HTTP 404). " +
            "Update GEMINI_MODELS — verify replacement IDs with a real generateContent() call, not just the model list.",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "network_or_parse_failure",
        message: `Gemini: failed after ${models.length} attempts (network errors or empty/unparseable responses).`,
        rawText: lastRawText,
      },
    };
  },
};
