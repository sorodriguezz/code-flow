import { useEffect, useMemo, useRef, useState } from "react";
import { Bug, Check, Layers, Loader2, Search, Sparkles, X } from "lucide-react";
import { searchWorkItems } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import type { WorkItem } from "../../types/domain";

/**
 * Picks the Azure DevOps work items a pull request will be linked to.
 *
 * Azure only, and drawn only for an Azure project — a work item is not a concept the other two
 * hosts have. It matters more than it looks because "Work items must be linked" is a standard
 * branch policy: a pull request opened without one is created *failing*, and the only fix is to go
 * to the web UI and link it there, which is exactly the round trip this app exists to save.
 *
 * The search is deliberately forgiving about what a person types. A bare number is almost always an
 * id — `391974`, or pasted from an `AB#391974` reference — so the backend matches it as an id *and*
 * as title text and merges both. An empty box is not an empty result either: it asks for the
 * caller's own open items, which is the useful list before anything has been typed.
 */

/** Long enough that typing an id doesn't fire a WIQL query per digit. */
const DEBOUNCE_MS = 300;

/** Anything Azure would call a bug, whatever the process template names it. */
function iconFor(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes("bug") || lower.includes("defect")) return Bug;
  if (lower.includes("epic") || lower.includes("feature")) return Layers;
  return Sparkles;
}

/**
 * The colours Azure's own boards use, so a row is recognisable at a glance rather than needing to
 * be read. Deliberately literal rather than palette tokens: these are *Azure's* semantics, not this
 * app's, and mapping them onto the accent would make two different bug types look the same.
 */
function colourFor(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("bug") || lower.includes("defect")) return "#cc293d";
  if (lower.includes("epic")) return "#ff7b00";
  if (lower.includes("feature")) return "#773b93";
  if (lower.includes("task")) return "#f2cb1d";
  return "#009ccc";
}

/** Pulls an id out of `AB#391974`, `#391974`, `391974` or a bare mention in a branch name. */
export function guessWorkItemId(text: string): number | null {
  const match = text.match(/(?:AB#|#)(\d{2,})/i) ?? text.match(/\b(\d{4,})\b/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function WorkItemPicker({
  projectId,
  selected,
  onChange,
  /** Text to mine for an id worth suggesting — the branch name and the PR title. */
  suggestFrom,
}: {
  projectId: string;
  selected: WorkItem[];
  onChange: (next: WorkItem[]) => void;
  suggestFrom?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Only the newest search may write results — the same guard the project search panel uses, and
  // for the same reason: a slow query for "3" must not land on top of a fast one for "391974".
  const runRef = useRef(0);

  const suggestedId = useMemo(
    () => (suggestFrom ? guessWorkItemId(suggestFrom) : null),
    [suggestFrom],
  );

  useEffect(() => {
    if (!open) return;
    const token = ++runRef.current;
    const id = window.setTimeout(() => {
      setSearching(true);
      void searchWorkItems(projectId, query)
        .then((found) => {
          if (token !== runRef.current) return;
          setResults(found);
          setError(null);
        })
        .catch((e: unknown) => {
          if (token !== runRef.current) return;
          setResults([]);
          // Shown inline rather than as a toast: a PAT without work-item read scope fails here on
          // every keystroke, and the picker must degrade to "you can still open the PR" rather
          // than burying the form in toasts.
          setError(String(e));
        })
        .finally(() => {
          if (token === runRef.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [projectId, query, open]);

  const add = (item: WorkItem) => {
    if (!selected.some((existing) => existing.id === item.id)) onChange([...selected, item]);
    setQuery("");
  };

  const remove = (id: number) => onChange(selected.filter((item) => item.id !== id));

  const unpicked = results.filter((item) => !selected.some((existing) => existing.id === item.id));

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-[var(--cf-text-muted)]">
        {t("createPr.workItems")}
      </label>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((item) => {
            const Icon = iconFor(item.work_item_type);
            return (
              <span
                key={item.id}
                title={item.title}
                className="flex max-w-full items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text)]"
              >
                <Icon size={10} style={{ color: colourFor(item.work_item_type) }} className="shrink-0" />
                <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">
                  {item.id}
                </span>
                <span className="truncate">{item.title}</span>
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  aria-label={t("createPr.workItemRemove")}
                  className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                >
                  <X size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2">
        <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={t("createPr.workItemsPlaceholder")}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] outline-none"
        />
        {searching && <Loader2 size={11} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />}
      </div>

      {/* A number in the branch name or title is very often the work item this PR is for, so it is
          offered — as a suggestion, never pre-selected. Linking the wrong item is worse than
          linking none, and silently attaching one nobody chose would be exactly that. */}
      {suggestedId !== null && !selected.some((item) => item.id === suggestedId) && (
        <button
          type="button"
          onClick={() => setQuery(String(suggestedId))}
          className="flex items-center gap-1.5 text-[11px] text-[var(--cf-accent)] hover:underline"
        >
          <Check size={10} />
          {t("createPr.workItemSuggested", { id: suggestedId })}
        </button>
      )}

      {open && error && (
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("createPr.workItemsUnavailable")}</p>
      )}

      {open && !error && unpicked.length > 0 && (
        <div className="max-h-40 overflow-auto rounded-md border border-[var(--cf-border)]">
          {unpicked.map((item) => {
            const Icon = iconFor(item.work_item_type);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => add(item)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                <Icon size={11} style={{ color: colourFor(item.work_item_type) }} className="shrink-0" />
                <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">{item.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                  {item.title}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{item.state}</span>
                {item.assigned_to && (
                  <span className="shrink-0 truncate text-[10px] text-[var(--cf-text-muted)] opacity-70">
                    {item.assigned_to}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {open && !error && !searching && unpicked.length === 0 && (
        <p className="text-[11px] text-[var(--cf-text-muted)]">
          {query.trim() ? t("createPr.workItemsNone") : t("createPr.workItemsEmpty")}
        </p>
      )}
    </div>
  );
}
