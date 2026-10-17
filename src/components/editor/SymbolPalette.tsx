import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hash, Loader2 } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { Kbd } from "../common/Button";
import { codemapFind, type SymbolHit } from "../../lib/tauri/codemapCommands";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { useT } from "../../state/languageStore";

/** How long typing has to pause before the index is asked — one lookup per word, not per key. */
const DEBOUNCE_MS = 120;

/**
 * Go to Symbol in Workspace (⌘T): a function, class, type or method of any file of the repository by
 * name, over the repo map's index (`codemap_find` — exact, then case-insensitive, then prefix, then
 * containing; `Class.method` narrows to a member). The index is the one the «Mapa» tab and the agents
 * use, built once per repository and kept current by blob id, so the first search of a session may
 * wait for it and the rest do not.
 *
 * The file palette's shell, row for row: the same gesture — type, arrow, Enter.
 */
export function SymbolPalette({
  repoPath,
  onPick,
  onClose,
}: {
  repoPath: string;
  onPick: (path: string, line: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const chord = useShortcutChord()("editor.goToSymbol");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void codemapFind(repoPath, needle)
        .then((found) => {
          if (!live) return;
          setHits(found);
          setActive(0);
        })
        .catch(() => live && setHits([]))
        .finally(() => live && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repoPath, query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (hit: SymbolHit | undefined) => {
    if (!hit) return;
    onPick(hit.path, hit.start);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[active]);
    }
  };

  // Portalled for the reason spelled out on `FilePalette`.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[64vh] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4">
          {loading ? (
            <Loader2 size={17} className="shrink-0 animate-spin text-[var(--cf-text-faint)]" />
          ) : (
            <Hash size={17} className="shrink-0 text-[var(--cf-text-faint)]" />
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("editor.goToSymbolPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--cf-text-faint)]"
          />
          {chord && <Kbd>{chord}</Kbd>}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {query.trim() && !loading && hits.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-[var(--cf-text-muted)]">{t("editor.goToSymbolNone")}</p>
          ) : (
            hits.map((hit, index) => {
              const cut = hit.path.lastIndexOf("/");
              return (
                <button
                  key={`${hit.path}:${hit.start}:${hit.name}`}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(hit)}
                  className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left ${
                    index === active ? "bg-[var(--cf-accent-soft)]" : ""
                  }`}
                >
                  <span className="w-[62px] shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-[var(--cf-text-faint)]">
                    {hit.kind}
                  </span>
                  <span className="shrink-0 text-[13px] text-[var(--cf-text)]">
                    {hit.parent ? <span className="text-[var(--cf-text-muted)]">{hit.parent}.</span> : null}
                    {hit.name}
                  </span>
                  <FileGlyph path={hit.path} size={12} />
                  <span className="truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
                    {cut < 0 ? hit.path : hit.path.slice(cut + 1)}:{hit.start}
                    {cut < 0 ? "" : ` · ${hit.path.slice(0, cut)}`}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 border-t border-[var(--cf-border)] px-3.5 py-2 text-[12px] text-[var(--cf-text-faint)]">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
          </span>
          <span className="ml-auto truncate">{t("editor.goToSymbolHint")}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
