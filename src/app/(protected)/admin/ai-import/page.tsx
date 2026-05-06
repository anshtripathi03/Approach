"use client";

import { useReducer, useState, useCallback } from "react";
import { COMPANY_CATEGORIES, CompanyCategory } from "@/src/types/admin.types";
import {
  Sparkles,
  X,
  Trash2,
  Save,
  ChevronDown,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

// CompanyCategory already imported from types

interface ParsedRecord {
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

interface ParseResponse {
  records: ParsedRecord[];
  skipped: SkippedRecord[];
  total: number;
  valid: number;
  invalidCount: number;
}

interface SaveResponse {
  saved: number;
  duplicates: number;
  failed: number;
  total: number;
  errors: { email: string; reason: string }[];
}

// ─── Row shape in state (adds ui state) ──────────────────────────────────────

interface Row extends ParsedRecord {
  id: string;           // stable client key
  saveFailed?: boolean; // highlighted red after a failed save
  catOpen?: boolean;    // category dropdown open
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

type Action =
  | { type: "SET_ROWS"; rows: Row[] }
  | { type: "DELETE_ROW"; id: string }
  | { type: "UPDATE_CELL"; id: string; field: keyof ParsedRecord; value: unknown }
  | { type: "TOGGLE_CAT_DROPDOWN"; id: string }
  | { type: "TOGGLE_CATEGORY"; id: string; cat: CompanyCategory }
  | { type: "MARK_FAILED"; emails: string[] }
  | { type: "CLEAR" };

function rowReducer(state: Row[], action: Action): Row[] {
  switch (action.type) {
    case "SET_ROWS":
      return action.rows;
    case "DELETE_ROW":
      return state.filter((r) => r.id !== action.id);
    case "UPDATE_CELL":
      return state.map((r) =>
        r.id === action.id ? { ...r, [action.field]: action.value } : r,
      );
    case "TOGGLE_CAT_DROPDOWN":
      return state.map((r) =>
        r.id === action.id ? { ...r, catOpen: !r.catOpen } : { ...r, catOpen: false },
      );
    case "TOGGLE_CATEGORY":
      return state.map((r) => {
        if (r.id !== action.id) return r;
        const has = r.category.includes(action.cat);
        return {
          ...r,
          category: has
            ? r.category.filter((c) => c !== action.cat)
            : [...r.category, action.cat],
        };
      });
    case "MARK_FAILED":
      return state.map((r) => ({
        ...r,
        saveFailed: action.emails.includes(r.email),
      }));
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

let idCounter = 0;
const uid = () => `row-${++idCounter}`;

function toRows(records: ParsedRecord[]): Row[] {
  return records.map((r) => ({ ...r, id: uid(), saveFailed: false, catOpen: false }));
}

// ─── Inline editable cell ─────────────────────────────────────────────────────

function EditableCell({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "—"}
      className={`w-full bg-transparent text-sm text-slate-700 placeholder:text-slate-300
        border-b border-transparent focus:border-amber-400 outline-none py-0.5 transition ${className}`}
    />
  );
}

// ─── Category multi-select dropdown ──────────────────────────────────────────

function CategoryCell({
  row,
  dispatch,
}: {
  row: Row;
  dispatch: React.Dispatch<Action>;
}) {
  return (
    <div className="relative">
      <button
        onClick={() => dispatch({ type: "TOGGLE_CAT_DROPDOWN", id: row.id })}
        className="flex items-center gap-1 text-xs text-left w-full"
      >
        <span className="flex flex-wrap gap-0.5 flex-1">
          {row.category.length > 0 ? (
            row.category.map((c) => (
              <span
                key={c}
                className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-medium"
              >
                {c}
              </span>
            ))
          ) : (
            <span className="text-slate-300 text-xs">Select…</span>
          )}
        </span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>

      {row.catOpen && (
        <div
          className="absolute top-full left-0 z-20 mt-1 w-48 bg-white rounded-xl shadow-lg
            border border-slate-100 p-2 grid grid-cols-1 gap-0.5"
        >
          {COMPANY_CATEGORIES.map((cat) => {
            const selected = row.category.includes(cat);
            return (
              <button
                key={cat}
                onClick={() => dispatch({ type: "TOGGLE_CATEGORY", id: row.id, cat })}
                className={`text-left px-2.5 py-1.5 rounded-lg text-xs font-medium transition
                  ${selected
                    ? "bg-amber-500 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                  }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main page component ──────────────────────────────────────────────────────

export default function AIImportPage() {
  const [rawInput, setRawInput] = useState("");
  const [rows, dispatch] = useReducer(rowReducer, []);

  const [isParsing, setIsParsing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [parseError, setParseError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<SkippedRecord[]>([]);
  const [skippedDismissed, setSkippedDismissed] = useState(false);

  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null);

  // ── Batch progress state ─────────────────────────────────────────────────────
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);

  const BATCH_SIZE = 10;

  // ── Parse with AI — batched 10 lines at a time ─────────────────────────────
  const handleParse = useCallback(async () => {
    if (!rawInput.trim()) return;

    // Split into non-empty lines and chunk into groups of BATCH_SIZE
    const lines = rawInput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const batches: string[][] = [];
    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      batches.push(lines.slice(i, i + BATCH_SIZE));
    }

    setIsParsing(true);
    setParseError(null);
    setSkipped([]);
    setSkippedDismissed(false);
    setSaveResult(null);
    dispatch({ type: "CLEAR" });
    setBatchCurrent(0);
    setBatchTotal(batches.length);

    const allRecords: ParsedRecord[] = [];
    const allSkipped: SkippedRecord[] = [];
    const MAX_BATCH_ATTEMPTS = 3;
    let skippedBatches = 0;

    for (let i = 0; i < batches.length; i++) {
      setBatchCurrent(i + 1);
      const batchText = batches[i].join("\n");
      let batchSuccess = false;

      for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
        try {
          console.log(`[AI-IMPORT] Batch ${i + 1}/${batches.length} — attempt ${attempt}/${MAX_BATCH_ATTEMPTS}`);

          const res = await fetch("/api/admin/ai-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rawInput: batchText }),
          });

          const data: ParseResponse & { error?: string } = await res.json();

          if (!res.ok) {
            console.warn(`[AI-IMPORT] Batch ${i + 1} attempt ${attempt} failed — HTTP ${res.status}`);
            if (attempt < MAX_BATCH_ATTEMPTS) {
              // Wait a bit before retrying (1s, then 2s)
              await new Promise((r) => setTimeout(r, attempt * 1000));
              continue;
            }
            // All attempts exhausted — skip this batch
            break;
          }

          allRecords.push(...(data.records ?? []));
          allSkipped.push(...(data.skipped ?? []));
          batchSuccess = true;
          break; // success — move to next batch
        } catch (err) {
          console.warn(
            `[AI-IMPORT] Batch ${i + 1} attempt ${attempt} — network error:`,
            err instanceof Error ? err.message : err
          );
          if (attempt < MAX_BATCH_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, attempt * 1000));
            continue;
          }
          // All attempts exhausted — skip this batch
          break;
        }
      }

      if (!batchSuccess) {
        skippedBatches++;
        console.warn(`[AI-IMPORT] Skipping batch ${i + 1}/${batches.length} after ${MAX_BATCH_ATTEMPTS} failed attempts`);
      }
    }

    if (skippedBatches > 0) {
      setParseError(
        `⚠️ ${skippedBatches} batch${skippedBatches > 1 ? "es" : ""} skipped after ${MAX_BATCH_ATTEMPTS} failed attempts each. ` +
        `${allRecords.length} records were still imported successfully.`
      );
    }

    dispatch({ type: "SET_ROWS", rows: toRows(allRecords) });
    setSkipped(allSkipped);
    setIsParsing(false);
    setBatchCurrent(0);
    setBatchTotal(0);
  }, [rawInput]);

  // ── Save to DB ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (rows.length === 0) return;

    setIsSaving(true);
    setSaveResult(null);

    // Strip UI-only fields before sending
    const records = rows.map(({ email, name, category, website, location, description, tags }) => ({
      email,
      name,
      category,
      website,
      location,
      description,
      tags,
    }));

    try {
      const res = await fetch("/api/admin/ai-import/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });

      const data: SaveResponse & { error?: string } = await res.json();

      if (!res.ok) {
        setParseError(data.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }

      setSaveResult(data);

      // Mark failed rows red so admin can fix and retry
      if (data.errors?.length > 0) {
        dispatch({ type: "MARK_FAILED", emails: data.errors.map((e) => e.email) });
      }

      // Remove successfully saved rows from the table
      const failedEmails = new Set(data.errors?.map((e) => e.email) ?? []);
      const duplicateCount = data.duplicates;
      // Keep only rows that errored (not duplicates — those are already in DB)
      if (failedEmails.size > 0) {
        dispatch({
          type: "SET_ROWS",
          rows: rows
            .filter((r) => failedEmails.has(r.email))
            .map((r) => ({ ...r, saveFailed: true })),
        });
      } else {
        dispatch({ type: "CLEAR" });
      }
    } catch (err) {
      setParseError(
        `Save failed: ${err instanceof Error ? err.message : "Network error"}`,
      );
    } finally {
      setIsSaving(false);
    }
  }, [rows]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
      <div className="max-w-7xl mx-auto">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600
              flex items-center justify-center shadow-md shadow-amber-200">
              <Sparkles size={18} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">AI Email Importer</h1>
          </div>
          <p className="text-sm text-slate-400 ml-12">
            Paste raw emails — Gemini structures them into your Company database
          </p>
        </div>

        {/* ── Global error banner ────────────────────────────────────────── */}
        {parseError && (
          <div className="mb-5 flex items-start gap-3 p-4 bg-red-50 border border-red-200
            rounded-2xl text-sm text-red-700">
            <XCircle size={16} className="mt-0.5 flex-shrink-0 text-red-500" />
            <span className="flex-1">{parseError}</span>
            <button onClick={() => setParseError(null)}>
              <X size={14} className="text-red-400 hover:text-red-600" />
            </button>
          </div>
        )}

        {/* ── Skipped warning ────────────────────────────────────────────── */}
        {skipped.length > 0 && !skippedDismissed && (
          <div className="mb-5 p-4 bg-yellow-50 border border-yellow-200 rounded-2xl text-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 font-semibold text-yellow-800">
                <AlertTriangle size={15} />
                {skipped.length} record{skipped.length !== 1 ? "s" : ""} skipped by Gemini
              </div>
              <button onClick={() => setSkippedDismissed(true)}>
                <X size={14} className="text-yellow-500 hover:text-yellow-700" />
              </button>
            </div>
            <ul className="space-y-1 pl-1">
              {skipped.map((s, i) => (
                <li key={i} className="text-yellow-700 text-xs">
                  · {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Save result banner ─────────────────────────────────────────── */}
        {saveResult && (
          <div className={`mb-5 flex items-center gap-3 p-4 rounded-2xl text-sm border
            ${saveResult.failed > 0
              ? "bg-orange-50 border-orange-200 text-orange-800"
              : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}>
            <CheckCircle size={16} className="flex-shrink-0" />
            <span>
              ✅ Saved: <strong>{saveResult.saved}</strong>
              {saveResult.duplicates > 0 && (
                <> &nbsp;⚠️ Duplicates: <strong>{saveResult.duplicates}</strong></>
              )}
              {saveResult.failed > 0 && (
                <> &nbsp;❌ Failed: <strong>{saveResult.failed}</strong></>
              )}
            </span>
            <button onClick={() => setSaveResult(null)} className="ml-auto">
              <X size={14} />
            </button>
          </div>
        )}

        {/* ── Two-panel layout ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6 items-start">

          {/* LEFT — Input panel */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col gap-4">
            <h2 className="font-semibold text-slate-800 text-base">Paste Emails</h2>

            <textarea
              id="raw-email-input"
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              rows={14}
              placeholder={`Paste emails here — one per line or comma separated.\nYou can include extra context like company names, websites, or industry.\n\nExample:\nhr@acmecorp.com — Acme Corp, technology company in Delhi\ncontact@healthplus.in, healthcare startup\njohn@financegroup.com`}
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50
                text-sm text-slate-800 placeholder:text-slate-400 p-4
                focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent
                leading-relaxed"
            />

            {/* ── Batch progress bar ──────────────────────────── */}
            {isParsing && batchTotal > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-amber-500" />
                    Processing batch {batchCurrent} of {batchTotal}…
                  </span>
                  <span className="font-semibold text-amber-600">
                    {Math.round((batchCurrent / batchTotal) * 100)}%
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-2 bg-gradient-to-r from-amber-400 to-amber-600 rounded-full transition-all duration-500"
                    style={{ width: `${(batchCurrent / batchTotal) * 100}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-400 text-center">
                  Each batch sends 10 emails to AI — please wait
                </p>
              </div>
            )}

            <button
              id="parse-ai-btn"
              onClick={handleParse}
              disabled={isParsing || !rawInput.trim()}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
                bg-gradient-to-r from-amber-500 to-amber-600 text-white text-sm font-semibold
                shadow-md shadow-amber-200 hover:shadow-lg hover:from-amber-600 hover:to-amber-700
                transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {isParsing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {batchTotal > 0
                    ? `Batch ${batchCurrent}/${batchTotal} — AI parsing…`
                    : "Preparing batches…"}
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Parse with AI ✨
                </>
              )}
            </button>
          </div>

          {/* RIGHT — Preview table */}
          {rows.length > 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">

              {/* Table header bar */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-700
                    text-xs font-bold flex items-center justify-center">
                    {rows.length}
                  </span>
                  <span className="text-sm font-semibold text-slate-700">
                    record{rows.length !== 1 ? "s" : ""} ready to import
                  </span>
                </div>
                <button
                  id="save-all-btn"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500 text-white
                    text-sm font-semibold hover:bg-emerald-600 shadow-sm hover:shadow-md transition-all
                    disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <Save size={14} />
                      Save All to Database
                    </>
                  )}
                </button>
              </div>

              {/* Scrollable table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[860px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/70">
                      {["Email", "Name", "Category", "Website", "Location", "Tags", ""].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`border-b border-slate-50 group transition
                          ${row.saveFailed
                            ? "bg-red-50 hover:bg-red-100/60"
                            : "hover:bg-amber-50/30"
                          }`}
                      >
                        {/* Email */}
                        <td className="px-4 py-3 min-w-[200px]">
                          <EditableCell
                            value={row.email}
                            onChange={(v) =>
                              dispatch({ type: "UPDATE_CELL", id: row.id, field: "email", value: v.toLowerCase() })
                            }
                            placeholder="email@domain.com"
                          />
                        </td>

                        {/* Name */}
                        <td className="px-4 py-3 min-w-[140px]">
                          <EditableCell
                            value={row.name}
                            onChange={(v) =>
                              dispatch({ type: "UPDATE_CELL", id: row.id, field: "name", value: v })
                            }
                            placeholder="Company name"
                          />
                        </td>

                        {/* Category */}
                        <td className="px-4 py-3 min-w-[160px]">
                          <CategoryCell row={row} dispatch={dispatch} />
                        </td>

                        {/* Website */}
                        <td className="px-4 py-3 min-w-[160px]">
                          <EditableCell
                            value={row.website ?? ""}
                            onChange={(v) =>
                              dispatch({ type: "UPDATE_CELL", id: row.id, field: "website", value: v || null })
                            }
                            placeholder="https://…"
                          />
                        </td>

                        {/* Location */}
                        <td className="px-4 py-3 min-w-[130px]">
                          <EditableCell
                            value={row.location ?? ""}
                            onChange={(v) =>
                              dispatch({ type: "UPDATE_CELL", id: row.id, field: "location", value: v || null })
                            }
                            placeholder="City, Country"
                          />
                        </td>

                        {/* Tags */}
                        <td className="px-4 py-3 min-w-[130px]">
                          <EditableCell
                            value={(row.tags ?? []).join(", ")}
                            onChange={(v) =>
                              dispatch({
                                type: "UPDATE_CELL",
                                id: row.id,
                                field: "tags",
                                value: v
                                  .split(",")
                                  .map((t) => t.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="tag1, tag2"
                          />
                        </td>

                        {/* Delete */}
                        <td className="px-4 py-3">
                          <button
                            id={`delete-row-${row.id}`}
                            onClick={() => dispatch({ type: "DELETE_ROW", id: row.id })}
                            className="p-1.5 rounded-lg text-slate-300 hover:text-red-500
                              hover:bg-red-50 transition opacity-0 group-hover:opacity-100"
                            title="Remove row"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer save button (repeated for long tables) */}
              <div className="px-5 py-4 border-t border-slate-100 flex justify-end">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 text-white
                    text-sm font-semibold hover:bg-emerald-600 shadow-sm transition-all
                    disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <><Loader2 size={14} className="animate-spin" /> Saving…</>
                  ) : (
                    <><Save size={14} /> Save All to Database</>
                  )}
                </button>
              </div>
            </div>
          ) : (
            /* Empty state — shown before first parse */
            <div className="hidden lg:flex items-center justify-center rounded-2xl
              border-2 border-dashed border-slate-200 bg-white/50 min-h-[400px]">
              <div className="text-center text-slate-400 p-8">
                <Sparkles size={32} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">Parsed records will appear here</p>
                <p className="text-sm mt-1">Paste emails on the left and click "Parse with AI"</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
