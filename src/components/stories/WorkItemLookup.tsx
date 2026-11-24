import { useEffect, useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { adoSearchWorkItems } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { colourFor, iconFor } from "../layout/WorkItemPicker";
import type { WorkItem } from "../../types/domain";

/** Long enough that typing an id doesn't fire a WIQL query per digit. */
const DEBOUNCE_MS = 300;

/** A link, not a search: pasted from a board's address bar, it goes straight to «Cargar». */
const looksLikeLink = (text: string) => /^\w+:\/\//.test(text.trim()) || text.includes("/");

/**
 * The review screen's lookup box: a link or a number still loads as before, and a list under it
 * offers the work items themselves — your open ones before anything is typed, then whatever matches
 * the id or the title — so the item is picked rather than its number remembered (user ask,
 * 2026-11-23). Azure organisations only: the search is theirs, and the box is a plain field
 * without one.
 */
export function WorkItemLookup({
  org,
  project,
  value,
  onChange,
  onPick,
  onSubmit,
  placeholder,
  className,
}: {
  /** The Azure organisation to search; empty, and the box is only a field. */
  org: string;
  /** Narrows the search to one Azure project; empty searches the whole organisation. */
  project: string;
  value: string;
  onChange: (value: string) => void;
  /** A row was chosen: load this work item. */
  onPick: (id: number) => void;
  /** Enter with no row highlighted — the box's own «Cargar». */
  onSubmit: () => void;
  placeholder: string;
  className: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<WorkItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(-1);
  // Only the newest search may write results: a slow query for "3" must not land on a fast one
  // for "391974" — the PR form's picker has the same guard.
  const runRef = useRef(0);

  const query = value.trim();
  const searchable = open && Boolean(org) && !looksLikeLink(value);

  useEffect(() => {
    if (!searchable) return;
    const token = ++runRef.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void adoSearchWorkItems(org, project, query)
        .then((found) => {
          if (token !== runRef.current) return;
          setResults(found);
          setError("");
          setCursor(-1);
        })
        .catch((e: unknown) => {
          if (token !== runRef.current) return;
          setResults([]);
          // Inline, not a toast: a token without work-item read scope would fail on every key.
          setError(String(e));
        })
        .finally(() => {
          if (token === runRef.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchable, org, project, query]);

  const pick = (item: WorkItem) => {
    setOpen(false);
    onPick(item.id);
  };

  return (
    <div className="relative min-w-[14rem] max-w-xl flex-1">
      <ScanSearch
        size={12}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
      />
      <input
        value={value}
        role="combobox"
        aria-expanded={searchable}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (searchable && results.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setCursor((c) => (c + step + results.length) % results.length);
            return;
          }
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key === "Enter") {
            if (searchable && cursor >= 0 && results[cursor]) pick(results[cursor]);
            else {
              setOpen(false);
              onSubmit();
            }
          }
        }}
        placeholder={placeholder}
        className={className}
      />
      {searchable && (
        <div
          role="listbox"
          // Keeps the focus in the box, so a click on a row is not a blur that closes the list first.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
        >
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[10.5px] font-medium text-[var(--cf-text-faint)]">
            {searching && <Loader2 size={10} className="animate-spin" />}
            {query ? t("huReview.pickMatches") : t("huReview.pickMine")}
          </div>
          {error ? (
            <p className="px-2 py-2 text-[11.5px] leading-snug text-[var(--cf-danger)]">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">
              {searching ? t("huReview.pickSearching") : t("huReview.pickNone")}
            </p>
          ) : (
            results.map((item, index) => {
              const Icon = iconFor(item.work_item_type);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  onClick={() => pick(item)}
                  onMouseEnter={() => setCursor(index)}
                  title={`${item.work_item_type} · ${item.state}${item.assigned_to ? ` · ${item.assigned_to}` : ""}`}
                  className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${
                    index === cursor ? "bg-[var(--cf-hover)]" : ""
                  }`}
                >
                  <Icon size={12} style={{ color: colourFor(item.work_item_type) }} className="shrink-0" />
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-muted)]">{item.id}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--cf-text)]">{item.title}</span>
                  <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">
                    {[item.state, project ? null : item.project].filter(Boolean).join(" · ")}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
