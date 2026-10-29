import { useEffect, useId, useMemo, useRef, useState } from "react";
import { trackPaletteCommand } from "../../lib/usageTracker";
import { ensureFlowContextEntries, useFlowContextStore } from "../../state/flowContextStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useMissingProjectsStore } from "../../state/missingProjectsStore";
import { useWindowStore } from "../../state/windowStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore, type PaletteScope } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { Search } from "lucide-react";
import { Kbd } from "../common/Button";
import { useDialog } from "../../lib/useFocusTrap";
import { useQuickAskHotkeyStore } from "../../state/quickAskHotkeyStore";
import { usageRows } from "../../lib/tauri/commands";
import {
  GROUP_LABEL_KEY,
  SCOPE_GROUPS,
  aliasHint,
  buildPaletteItems,
  filterPaletteItems,
  frequentItems,
  type PaletteItem,
} from "../../lib/paletteItems";

export function CommandPalette({ scope = "all", onClose }: { scope?: PaletteScope; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Selecting the raw (stably-referenced) map and only applying the `?? []` fallback in the
  // render body — not inside the selector — avoids handing useSyncExternalStore a brand-new
  // array on every store update, which previously caused a real infinite-render loop elsewhere
  // in this app (see prStore's EMPTY_PRS fix).
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const projects = activeWorkspaceId ? projectsByWorkspace[activeWorkspaceId] ?? [] : [];
  const missing = useMissingProjectsStore((s) => s.missing);
  const notARepo = useMissingProjectsStore((s) => s.notARepo);
  // Repositories that are open in windows of their own. Left out for the same reason the
  // broken ones are: pressing Return here would select a repository this window has moved out,
  // and the row that *is* the way to that window is in the sidebar.
  const satellites = useWindowStore((s) => s.satellites);
  const branches = useRepoStore((s) => s.branches);
  const activeView = useUiStore((s) => s.activeView);
  const quickAskChord = useQuickAskHotkeyStore((s) => s.accelerator);
  // Read so the list is rebuilt when the armed flows arrive — the rows themselves ask the store.
  const folderFlows = useFlowContextStore((s) => s.entries.folder);
  useEffect(() => {
    void useQuickAskHotkeyStore.getState().load();
    ensureFlowContextEntries();
  }, []);

  // The rows themselves are `lib/paletteItems`' — «Codi» lists and runs the same ones. Rebuilt when
  // anything they are built from changes; the actions they call are the stores' own, which never do.
  const items = useMemo<PaletteItem[]>(
    () =>
      buildPaletteItems({ t, workspaces, projects, missing, notARepo, satellites, branches, activeView, quickAskChord }),
    // `folderFlows` is read by the rows through the store, not passed — listed so the armed flows
    // arriving rebuilds them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, projects, missing, notARepo, satellites, branches, t, activeView, quickAskChord, folderFlows],
  );

  // How often each place and action was used in the last 30 days, every workspace — read once per
  // opening, from the counters Estadísticas keeps. Missing (still loading, or the read failed) is
  // simply no «Frecuentes» group.
  const [usage, setUsage] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    usageRows(null, null, 30)
      .then((rows) => {
        const counts = new Map<string, number>();
        for (const row of rows) {
          if (row.kind !== "view" && row.kind !== "command") continue;
          const key = `${row.kind}:${row.key}`;
          counts.set(key, (counts.get(key) ?? 0) + row.count);
        }
        if (live) setUsage(counts);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const withFrequent = useMemo(
    () => (usage && scope === "all" ? [...frequentItems(items, usage), ...items] : items),
    [items, usage, scope],
  );

  const groups = SCOPE_GROUPS[scope];

  // Every word has to appear, in any order and without regard to case or accents. Laid out in group
  // order, because that is the order the rows are drawn in and the arrow keys walk.
  const filtered = useMemo(() => filterPaletteItems(withFrequent, groups, query), [withFrequent, groups, query]);

  // The row Enter would pick, moved by ↑/↓ and by the pointer. Back to the top whenever the list
  // changes under it.
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, scope]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem) => {
    // A «Frecuentes» row counts as the row it repeats — or it would only ever count itself.
    trackPaletteCommand(item.origin?.group ?? item.group, item.origin?.key ?? item.key);
    item.onSelect();
    onClose();
  };

  // A dialog like any other: Tab stays in it, Escape closes it while it is on top, and no app chord
  // runs behind it but the ones that open it (`data-shortcut-owner` below).
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, true, onClose);
  // The combobox pattern: the field keeps the focus, the list is announced as its popup, and the
  // row the arrows are on is named through `aria-activedescendant` — so a screen reader reads the
  // highlighted row the way a sighted user sees it.
  const listId = useId();
  const rowId = (index: number) => `${listId}-row-${index}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.cmdCommandPalette")}
        data-shortcut-owner="app.commandPalette project.switcher workspace.switcher"
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[64vh] w-[600px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4">
          <Search size={17} className="shrink-0 text-[var(--cf-text-faint)]" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? rowId(active) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
              }
              if (e.key === "Enter" && filtered[active]) choose(filtered[active]);
            }}
            placeholder={scope === "all" ? t("titlebar.searchPlaceholder") : t(GROUP_LABEL_KEY[groups[0]])}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--cf-text-faint)]"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label={t("shortcuts.cmdCommandPalette")} className="flex-1 overflow-auto p-1.5">
          {groups.map((group) => {
            const groupItems = filtered.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} role="group" aria-labelledby={`${listId}-${group}`} className="mb-1">
                <p
                  id={`${listId}-${group}`}
                  className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]"
                >
                  {t(GROUP_LABEL_KEY[group])}
                </p>
                {groupItems.map((item) => {
                  const Icon = item.icon;
                  const index = filtered.indexOf(item);
                  const on = index === active;
                  return (
                    <button
                      key={item.key}
                      id={rowId(index)}
                      data-row={index}
                      role="option"
                      // Out of the tab order: the field holds the focus and the arrows move the
                      // highlight, as in any combobox.
                      tabIndex={-1}
                      onClick={() => choose(item)}
                      onMouseMove={() => !on && setActive(index)}
                      aria-selected={on}
                      className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${
                        on ? "bg-[var(--cf-accent-soft)]" : ""
                      }`}
                    >
                      <Icon
                        size={15}
                        className={`shrink-0 ${on ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`}
                      />
                      <span className="truncate">{item.label}</span>
                      {(() => {
                        // The hidden word that found it, so "postman" landing on «Cliente API»
                        // reads as an answer rather than a mistake.
                        const hint = aliasHint(item, query);
                        return hint ? (
                          <span className="shrink-0 truncate text-[12px] text-[var(--cf-text-faint)]">· {hint}</span>
                        ) : null;
                      })()}
                      {item.keys && (
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {item.keys.map((key, i) => (
                            <Kbd key={`${key}-${i}`}>{key}</Kbd>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("titlebar.noResults")}</p>
          )}
        </div>
        {/* The keys, always in view: this is a keyboard surface, and the keys are its controls. */}
        <div className="flex shrink-0 items-center gap-4 border-t border-[var(--cf-border)] px-3.5 py-2 text-[12px] text-[var(--cf-text-faint)]">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd></span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd></span>
          <span className="ml-auto tabular-nums">{filtered.length}</span>
        </div>
      </div>
    </div>
  );
}
