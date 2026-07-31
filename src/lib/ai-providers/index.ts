import type { AIProvider } from "./types";
import { openRouterProvider } from "./openrouter";
import { geminiProvider } from "./gemini";

export type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  CompletionFailure,
  CompletionFailureKind,
} from "./types";
export { SYSTEM_PROMPT } from "./shared";

// Manual provider selection via AI_PROVIDER — "openrouter" (default) | "gemini".
// This does NOT automatically fail over between providers within a single
// request; it picks one provider for the whole deployment. Switching which
// provider is active is just an env var change, no code change.
export function getAIProvider(): AIProvider {
  const selected = (process.env.AI_PROVIDER ?? "openrouter").trim().toLowerCase();

  if (selected === "gemini") return geminiProvider;
  if (selected === "openrouter") return openRouterProvider;

  console.warn(`[AI-IMPORT] Unknown AI_PROVIDER="${selected}", falling back to openrouter`);
  return openRouterProvider;
}
