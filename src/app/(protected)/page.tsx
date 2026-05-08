"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEmailStore } from "@/src/store/Emailstore";
import { emailService } from "@/src/services/Email.service";
import {
  Search,
  X,
  Paperclip,
  AlertCircle,
  CheckCircle,
  Send,
  CheckSquare,
  Square,
  Loader2,
  MailCheck,
  MailX,
  ChevronDown,
} from "lucide-react";
import toast from "react-hot-toast";
import { useDebounce } from "@/src/Hooks/useDebounce";
import { useThrottle } from "@/src/Hooks/useThrottle";
import { stripEmojis } from "@/src/utils/sanitization";
import { SkeletonCard } from "@/src/components/ui/Skeleton";
import { useAuth } from "@/src/Hooks/Useauth";
import { useSentEmails } from "@/src/Hooks/useSentEmails";
import { useCompanyStore } from "@/src/store/Companystore";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  "Technology", "Finance", "Healthcare", "Education", "Marketing",
  "E-Commerce", "Logistics", "Media", "Real Estate", "Manufacturing",
  "Consulting", "Other",
];

const PAGE_SIZE = 20;
const ALLOWED_PDF_TYPES = ["application/pdf"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ─── Component ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { user } = useAuth();
  const hasSenderEmail = !!user?.senderEmail;
  const store = useEmailStore();
  const { fetchNonSentCompanies } = useAuth();

  // ── Already-sent tracking ────────────────────────────────────────────────
  const { sentSet, markAsSent } = useSentEmails();

  const {
    companySearchResults,
    companySearchPagination,
    selectedCompanies,
    subject,
    emailBody,
    isSending,
    sendResult,
    sendError,
  } = store;

  // ── Local state ─────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showCompanyPanel, setShowCompanyPanel] = useState(false);

  // ── Streaming progress state ────────────────────────────────────────────────
  const [streamTotal, setStreamTotal] = useState(0);
  const [streamResults, setStreamResults] = useState<any[]>([]);
  const [streamDone, setStreamDone] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showSelectDropdown, setShowSelectDropdown] = useState(false);
  const selectDropdownRef = useRef<HTMLDivElement>(null);

  // ── Infinite-scroll state ───────────────────────────────────────────────────
  const [isFirstLoad, setIsFirstLoad] = useState(true);   // skeleton on page 1
  const [isLoadingMore, setIsLoadingMore] = useState(false); // spinner on page 2+
  const pageRef = useRef(1);                               // current loaded page
  const isFetchingRef = useRef(false);                     // prevents concurrent fetches
  const sentinelRef = useRef<HTMLDivElement>(null);        // bottom sentinel div

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === "loading") return;
    if (!session) router.push("/login");
  }, [session, status, router]);

  // ── Clear send state on mount ───────────────────────────────────────────────
  useEffect(() => {
    store.setSendError(null);
    store.setSendResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Suppress unhandled promise rejections in dev overlay ────────────────────
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => { e.preventDefault(); };
    window.addEventListener("unhandledrejection", handler);

    // Close dropdown on click outside
    const handleClickOutside = (event: MouseEvent) => {
      if (selectDropdownRef.current && !selectDropdownRef.current.contains(event.target as Node)) {
        setShowSelectDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      window.removeEventListener("unhandledrejection", handler);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // ── Core page fetcher ───────────────────────────────────────────────────────
  const fetchPage = useCallback(
    async (page: number, append: boolean) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      if (append) setIsLoadingMore(true);
      else setIsFirstLoad(true);

      try {
        const res = await emailService.searchCompanies({
          search: debouncedSearch || undefined,
          category: selectedCategories.length > 0 ? selectedCategories.join(",") : undefined,
          page,
          limit: PAGE_SIZE,
        });

        if (append) {
          store.appendCompanySearchResults(res.data, res.pagination);
        } else {
          store.setCompanySearchResults(res.data, res.pagination);
        }
      } catch {
        toast.error("Failed to load companies");
      } finally {
        isFetchingRef.current = false;
        if (append) setIsLoadingMore(false);
        else setIsFirstLoad(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedSearch, selectedCategories],
  );

  // ── Reset & fetch page 1 whenever filters change ───────────────────────────
  useEffect(() => {
    pageRef.current = 1;
    fetchPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, selectedCategories]);

  // ── IntersectionObserver: fire when sentinel enters viewport ───────────────
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (isFetchingRef.current) return;
        if (!companySearchPagination?.hasNextPage) return;

        const nextPage = pageRef.current + 1;
        pageRef.current = nextPage;
        fetchPage(nextPage, true);
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage, companySearchPagination]);

  // ── Auto-clear send feedback after 5 s ─────────────────────────────────────
  useEffect(() => {
    if (!sendError && !sendResult) return;
    const timer = setTimeout(() => {
      store.setSendError(null);
      store.setSendResult(null);
    }, 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendError, sendResult]);

  const clearState = () => { store.setSendError(null); store.setSendResult(null); };

  // ── Select All / Deselect All ───────────────────────────────────────────────
  const allCurrentSelected =
    companySearchResults.length > 0 &&
    companySearchResults.every((c) =>
      selectedCompanies.some((sc) => sc._id === c._id),
    );

  const handleSelectAll = () => {
    if (allCurrentSelected) {
      // Deselect only the currently visible companies
      const visibleIds = new Set(companySearchResults.map((c) => c._id));
      store.setSelectedCompanies(
        selectedCompanies.filter((c) => !visibleIds.has(c._id)),
      );
    } else {
      // Merge all visible companies that aren't already selected
      const existingIds = new Set(selectedCompanies.map((c) => c._id));
      const toAdd = companySearchResults.filter((c) => !existingIds.has(c._id));
      store.setSelectedCompanies([...selectedCompanies, ...toAdd]);
    }
    setShowSelectDropdown(false);
  };

  const handleSelectNonSent = async () => {
    const { nonSentCompanies, nonSentLoaded, nonSentLoading } = useCompanyStore.getState();

    setShowSelectDropdown(false);

    let companies = nonSentCompanies;

    if (!nonSentLoaded && !nonSentLoading) {
      try {
        companies = await fetchNonSentCompanies();
      } catch {
        toast.error("Failed to load non-sent companies");
        return;
      }
    }

    if (companies.length === 0) {
      toast.error("No non-sent companies found");
      return;
    }

    store.setSelectedCompanies(companies);
    toast.success(`Selected ${companies.length} non-sent companies`);
  };

  // ── Send (streaming) ────────────────────────────────────────────────────────
  const handleSend = useThrottle(async () => {
    if (!subject.trim()) { toast.error("Please enter an email subject"); return; }
    if (!emailBody.trim()) { toast.error("Please write an email body"); return; }
    if (selectedCompanies.length === 0) { toast.error("Please select at least one company"); return; }

    clearState();
    // Reset progress state
    setStreamResults([]);
    setStreamTotal(0);
    setStreamDone(false);
    setShowProgress(true);
    store.setIsSending(true);

    const formData = new FormData();
    formData.append("subject", subject.trim());
    formData.append("emailBody", emailBody.trim());
    selectedCompanies.forEach((c) => formData.append("companyIds", c._id));
    attachments.forEach((f) => formData.append("attachments", f));

    try {
      const response = await fetch("/api/email/send-with-supabase", {
        method: "POST",
        body: formData,
      });

      if (!response.ok || !response.body) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to send emails");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === "start") {
              setStreamTotal(event.total);
            }

            if (event.type === "result") {
              setStreamResults((prev) => [...prev, event.data]);
              if (event.data.status === "sent") {
                markAsSent(String(event.data.company));
              }
            }

            if (event.type === "done") {
              setStreamDone(true);
              store.setSendResult({
                success: true,
                summary: event.summary,
                deliveryResults: event.deliveryResults,
              });
              store.clearCompose();
              setAttachments([]);
              toast.success(
                `Sent to ${event.summary.totalSent} / ${event.summary.totalTargeted} company(ies)!`
              );
            }

            if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch (parseErr) {
            // skip malformed lines
          }
        }
      }
    } catch (err: any) {
      const msg = err.message || "Failed to send emails";
      store.setSendError(msg);
      toast.error(msg);
      setShowProgress(false);
    } finally {
      store.setIsSending(false);
    }
  }, 2000);

  // ── Category toggle ─────────────────────────────────────────────────────────
  const toggleCategory = (cat: string) =>
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  // ── Attachment handlers ─────────────────────────────────────────────────────
  const handleAttachClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (fileInputRef.current) { fileInputRef.current.value = ""; fileInputRef.current.click(); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const validFiles: File[] = [];
    Array.from(files).forEach((file) => {
      if (!ALLOWED_PDF_TYPES.includes(file.type)) { toast.error(`${file.name} is not a PDF.`); return; }
      if (file.size > MAX_FILE_SIZE) { toast.error(`${file.name} exceeds 5MB limit`); return; }
      validFiles.push(file);
    });
    if (validFiles.length > 0) {
      if (attachments.length + validFiles.length > 10) { toast.error("Maximum 10 attachments allowed"); return; }
      setAttachments((prev) => [...prev, ...validFiles]);
      toast.success(`Added ${validFiles.length} PDF(s)`);
    }
  };

  const removeAttachment = (index: number) =>
    setAttachments((prev) => prev.filter((_, i) => i !== index));

  // ── Loading screen ──────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" />
      </div>
    );
  }

  if (!session) return null;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0">

      {/* ── LEFT PANEL: Company selector ──────────────────────────────────── */}
      <div
        className={`
          flex-shrink-0 bg-white border-r border-slate-200
          flex flex-col
          transition-all duration-300
          /* Desktop */
          lg:w-72 lg:relative lg:translate-x-0 lg:shadow-none
          /* Mobile: full-screen overlay */
          ${showCompanyPanel ? "fixed inset-0 z-30 w-full" : "hidden lg:flex"}
        `}
      >
        {/* Mobile header */}
        <div className="lg:hidden flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <span className="font-semibold text-slate-800">Select Companies</span>
          <button
            onClick={() => setShowCompanyPanel(false)}
            className="p-1 rounded-lg hover:bg-slate-100"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto">
          {/* Desktop heading */}
          <h2 className="hidden lg:block text-base font-semibold text-slate-800 mb-4">
            Select Companies
          </h2>

          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
            <input
              placeholder="Search companies..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 text-slate-900 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50
                focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent"
            />
          </div>

          {/* Categories */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Categories
            </p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${selectedCategories.includes(cat)
                      ? "bg-amber-500 text-white border-amber-500"
                      : "bg-white border-slate-200 text-slate-600 hover:border-amber-300"
                    }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* ── Select All row ──────────────────────────────────────────────── */}
          {!isFirstLoad && companySearchResults.length > 0 && (
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-slate-500">
                {companySearchResults.length} loaded
                {companySearchPagination?.total
                  ? ` / ${companySearchPagination.total} total`
                  : ""}
              </span>

              <div className="relative" ref={selectDropdownRef}>
                <button
                  onClick={() => setShowSelectDropdown(!showSelectDropdown)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                    border transition-all ${allCurrentSelected
                      ? "bg-amber-500 text-white border-amber-500 hover:bg-amber-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-amber-400 hover:text-amber-700"
                    }`}
                >
                  {allCurrentSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                  Select
                  <ChevronDown size={12} className="ml-0.5 opacity-60" />
                </button>

                {showSelectDropdown && (
                  <div className="absolute right-0 mt-2 w-32 bg-white border border-slate-200 rounded-xl shadow-xl z-20 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                    <button
                      onClick={handleSelectAll}
                      className="w-full text-left px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-amber-50 hover:text-amber-700 border-b border-slate-50"
                    >
                      {allCurrentSelected ? "Deselect All" : "All"}
                    </button>
                    <button
                      onClick={handleSelectNonSent}
                      className="w-full text-left px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-amber-50 hover:text-amber-700"
                    >
                      Non-Sent
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Company list (Sorted: Non-sent first) ─────────────────────────── */}
          <div className="space-y-2">
            {isFirstLoad ? (
              // Skeleton on initial / filter-reset load
              <div className="space-y-2">
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : companySearchResults.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-sm">
                No companies found.
              </div>
            ) : (
              <>
                {[...companySearchResults]
                  .sort((a, b) => {
                    const aSent = sentSet.has(String(a._id));
                    const bSent = sentSet.has(String(b._id));
                    if (aSent && !bSent) return 1;
                    if (!aSent && bSent) return -1;
                    return 0;
                  })
                  .map((c) => {
                    const selected = selectedCompanies.some((sc) => sc._id === c._id);
                    const alreadySent = sentSet.has(String(c._id));
                    return (
                      <div
                        key={c._id}
                        onClick={() => {
                          selected
                            ? store.removeSelectedCompany(c._id)
                            : store.addSelectedCompany(c);
                        }}
                        className={`p-3.5 rounded-xl border cursor-pointer transition-all ${selected
                            ? "bg-amber-50 border-amber-400 shadow-sm"
                            : "bg-white border-slate-200 hover:border-amber-300 hover:bg-amber-50/30"
                          }`}
                      >
                        {/* Name row + Already Sent badge */}
                        <div className="flex items-center justify-between gap-2">
                          <div className={`font-medium text-sm truncate ${alreadySent ? "text-slate-400" : "text-slate-800"}`}>
                            {c.name}
                          </div>
                          {alreadySent && (
                            <span
                              className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5
                                rounded-full text-[10px] font-semibold
                                bg-emerald-50 text-emerald-600 border border-emerald-200"
                            >
                              <CheckCircle size={9} />
                              Sent
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 truncate">
                          {Array.isArray(c.category) ? c.category.join(", ") : c.category}
                        </div>
                      </div>
                    );
                  })}

                {/* Sentinel: triggers next page load when visible */}
                <div ref={sentinelRef} className="h-4" aria-hidden="true" />

                {/* Bottom spinner while loading more */}
                {isLoadingMore && (
                  <div className="flex items-center justify-center py-4 gap-2 text-slate-400 text-xs">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-amber-400 border-r-transparent" />
                    Loading more…
                  </div>
                )}

                {/* End-of-list message */}
                {!isLoadingMore && companySearchPagination && !companySearchPagination.hasNextPage && (
                  <div className="text-center py-3 text-slate-300 text-xs">
                    All {companySearchPagination.total} companies loaded
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Mobile: done button */}
        {showCompanyPanel && (
          <div className="lg:hidden p-4 border-t border-slate-100">
            <button
              onClick={() => setShowCompanyPanel(false)}
              className="w-full py-3 bg-amber-500 text-white rounded-xl font-medium text-sm"
            >
              Done ({selectedCompanies.length} selected)
            </button>
          </div>
        )}
      </div>

      {/* ── RIGHT PANEL: Compose ──────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <div className="flex-1 p-4 sm:p-6 lg:p-8 flex flex-col max-w-3xl w-full mx-auto">

          {/* Selected companies + mobile "choose" button */}
          <div className="mb-5">
            {/* Mobile button to open company selector */}
            <button
              onClick={() => setShowCompanyPanel(true)}
              className="lg:hidden w-full mb-3 flex items-center justify-between px-4 py-3
                bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-700
                hover:border-amber-400 transition"
            >
              <span>
                {selectedCompanies.length === 0
                  ? "Choose companies to send to..."
                  : `${selectedCompanies.length} compan${selectedCompanies.length !== 1 ? "ies" : "y"} selected`}
              </span>
              <Search size={16} className="text-slate-400" />
            </button>

            {selectedCompanies.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Selected ({selectedCompanies.length})
                  </p>
                  <button
                    onClick={() => store.clearSelectedCompanies()}
                    className="text-xs text-slate-400 hover:text-red-500 transition"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedCompanies.map((c) => (
                    <div
                      key={c._id}
                      className="flex items-center gap-1.5 pl-3 pr-2 py-1.5
                        bg-amber-100 text-amber-900 rounded-full text-xs font-medium"
                    >
                      {c.name}
                      <button
                        onClick={() => store.removeSelectedCompany(c._id)}
                        className="rounded-full hover:bg-amber-200 p-0.5 transition"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Live Streaming Progress Panel (Simplified Bar + Percentage) ── */}
          {showProgress && (
            <div className="mb-6 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  {!streamDone ? (
                    <div className="relative flex items-center justify-center">
                      <Loader2 size={18} className="animate-spin text-amber-500" />
                    </div>
                  ) : (
                    <CheckCircle size={18} className="text-emerald-500" />
                  )}
                  <span className="text-sm font-bold text-slate-800">
                    {streamDone ? "Sending Complete" : "Sending Emails..."}
                  </span>
                </div>
                <span className="text-sm font-black text-amber-600 bg-amber-50 px-3 py-1 rounded-full">
                  {streamTotal > 0
                    ? `${Math.round((streamResults.length / streamTotal) * 100)}%`
                    : "0%"}
                </span>
              </div>

              {/* Progress bar container */}
              <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-700 ease-out rounded-full ${streamDone ? "bg-emerald-500" : "bg-gradient-to-r from-amber-400 to-amber-500"
                    }`}
                  style={{ width: `${streamTotal > 0 ? (streamResults.length / streamTotal) * 100 : 0}%` }}
                />
              </div>

              <div className="flex justify-between mt-3 text-[11px] font-medium text-slate-400 uppercase tracking-widest">
                <span>{streamResults.length} Processed</span>
                <span>{streamTotal} Total</span>
              </div>

              {streamDone && (
                <button
                  onClick={() => setShowProgress(false)}
                  className="w-full mt-5 py-2.5 text-xs font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-50 border border-slate-100 rounded-xl transition-all"
                >
                  Dismiss Progress
                </button>
              )}
            </div>
          )}

          {/* Alerts */}
          {!showProgress && sendResult && (
            <div
              onClick={clearState}
              className="mb-4 p-4 bg-green-50 border border-green-200 rounded-xl
                flex items-start gap-3 cursor-pointer hover:bg-green-100 transition"
            >
              <CheckCircle size={18} className="text-green-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-green-900 text-sm">Emails sent successfully!</p>
                <p className="text-xs text-green-700 mt-0.5">
                  {sendResult?.summary?.totalSent ?? 0} sent
                  {(sendResult?.summary?.totalFailed ?? 0) > 0 && (
                    <span className="text-orange-600"> · {sendResult?.summary?.totalFailed} failed</span>
                  )}
                </p>
              </div>
              <X size={14} className="text-green-500 flex-shrink-0" />
            </div>
          )}

          {sendError && (
            <div
              onClick={clearState}
              className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl
                flex items-start gap-3 cursor-pointer hover:bg-red-100 transition"
            >
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 flex-1 min-w-0">{sendError}</p>
              <X size={14} className="text-red-400 flex-shrink-0" />
            </div>
          )}

          {/* Subject */}
          <div className="mb-4">
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Email Subject
            </label>
            <input
              placeholder="e.g., Partnership Opportunity"
              maxLength={150}
              value={subject}
              onChange={(e) => store.setSubject(stripEmojis(e.target.value))}
              className="w-full px-4 py-3 text-sm text-slate-900 rounded-xl border border-slate-200 bg-white
                focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent"
            />
          </div>

          {/* Body */}
          <div className="mb-4 flex flex-col flex-1 min-h-0">
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Email Body
            </label>
            <textarea
              placeholder="Write your message here... (HTML supported)"
              maxLength={10000}
              value={emailBody}
              onChange={(e) => store.setEmailBody(stripEmojis(e.target.value))}
              className="flex-1 min-h-[180px] lg:min-h-0 p-4 text-sm text-slate-900 border border-slate-200 rounded-xl
                focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent resize-none"
            />
            <p className="text-xs text-slate-400 mt-1.5">{emailBody.length} characters</p>
          </div>

          {/* Attachments */}
          <div className="mb-5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,application/pdf"
              onChange={handleFileChange}
              style={{ position: "absolute", width: "1px", height: "1px", opacity: 0, overflow: "hidden" }}
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={handleAttachClick}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                border-2 border-dashed border-slate-300 rounded-xl text-sm font-medium text-slate-600
                hover:border-amber-400 hover:bg-amber-50 hover:text-amber-700 transition"
            >
              <Paperclip size={15} />
              Add PDF Attachments {attachments.length > 0 && `(${attachments.length})`}
            </button>
            <p className="text-xs text-slate-400 mt-1">PDFs only · Max 5MB per file · Max 10 files</p>

            {attachments.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {attachments.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-3 py-2
                      bg-slate-50 border border-slate-200 rounded-lg"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Paperclip size={13} className="text-slate-400 flex-shrink-0" />
                      <span className="text-xs text-slate-700 truncate">{file.name}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {(file.size / 1024).toFixed(0)}KB
                      </span>
                    </div>
                    <button
                      onClick={() => removeAttachment(idx)}
                      className="ml-2 flex-shrink-0 text-red-400 hover:text-red-600 transition"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Send button */}
          {!hasSenderEmail ? (
            <button
              onClick={() => {
                toast.error("Please update your sender email first!");
                router.push("/profile");
              }}
              className="w-full py-3.5 bg-gradient-to-r from-slate-400 to-slate-500 text-white
                rounded-xl font-semibold text-sm flex items-center justify-center gap-2
                hover:shadow-lg transition-all"
            >
              ✉️ Update Your Sender Email
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={
                isSending ||
                selectedCompanies.length === 0 ||
                !subject.trim() ||
                !emailBody.trim()
              }
              className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-amber-600 text-white
                rounded-xl font-semibold text-sm flex items-center justify-center gap-2
                hover:shadow-lg hover:shadow-amber-500/30 transition-all
                disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {isSending ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-r-transparent" />
                  Sending...
                </>
              ) : (
                <>
                  <Send size={16} />
                  Send to {selectedCompanies.length} Compan{selectedCompanies.length !== 1 ? "ies" : "y"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}