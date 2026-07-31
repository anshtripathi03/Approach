// Logic shared by every AI provider implementation: the extraction prompt
// and the JSON-array parsing helpers. Keeping one copy means both providers
// stay behaviorally identical regardless of which is selected.

export const SYSTEM_PROMPT = `You are a data extraction assistant. The user will give you a raw list of company emails, possibly with some extra context like company names, websites, locations, or job fields mixed in.

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

function stripMarkdownFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// Some free models wrap the JSON array in a stray preamble/trailing note
// despite instructions not to. Extract the outermost [...] substring instead
// of requiring the whole trimmed response to be valid JSON on its own.
export function extractJsonArray(text: string): unknown[] | null {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
