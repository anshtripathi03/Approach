// Shared contract both AI providers (OpenRouter, Gemini) implement, so
// route.ts can call whichever is selected via AI_PROVIDER without caring
// about the underlying SDK/API shape.

export interface CompletionRequest {
  systemPrompt: string;
  userInput: string;
}

export interface CompletionSuccess {
  records: unknown[];
  rawText: string;
  modelUsed: string;
}

// Every failure is classified into one of these kinds so route.ts can map it
// to the right HTTP status/message without needing to know which provider
// produced it.
export type CompletionFailureKind =
  | "config_error" // missing API key / no usable model configured at all
  | "invalid_model" // provider rejected the model ID as unavailable/unknown
  | "payment_required" // provider demands payment (must never be retried into a paid call)
  | "quota_exhausted" // free-tier quota (daily/per-minute) used up
  | "network_or_parse_failure"; // network error, empty response, or unparseable JSON

export interface CompletionFailure {
  kind: CompletionFailureKind;
  message: string;
  retryAfterSeconds?: number;
  rawText?: string | null;
}

export type CompletionResult =
  | { ok: true; value: CompletionSuccess }
  | { ok: false; error: CompletionFailure };

export interface AIProvider {
  name: string;
  // Must never throw — every failure mode is returned as a typed result.
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
