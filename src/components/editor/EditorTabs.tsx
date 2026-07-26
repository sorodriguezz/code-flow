import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { fileIconFor } from "../../lib/fileIcon";
import { useT } from "../../state/languageStore";

export interface EditorTabItem {
  path: string;
  dirty: boolean;
  /** Ephemeral tab (single click in the tree): shown in italics and reused by the next
   * single-click open instead of piling up a tab per file you merely peeked at. */
  preview: boolean;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentDir(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/** Only files whose basename collides with another open tab get a dimmed folder suffix —
 * two `index.ts` tabs are indistinguishable otherwise, but adding the path to every tab
 * would just be noise. */
function buildSuffixes(tabs: EditorTabItem[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const name = baseName(tab.path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const suffixes = new Map<string, string>();
  for (const tab of tabs) {
    if ((counts.get(baseName(tab.path)) ?? 0) > 1) suffixes.set(tab.path, parentDir(tab.path));
  }
  return suffixes;
}

export function EditorTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
  onPin,
  onReorder,
  actions,
}: {
  tabs: EditorTabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onPin: (path: string) => void;
  onReorder: (from: number, to: number) => void;
  actions?: ReactNode;
}) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const suffixes = useMemo(() => buildSuffixes(tabs), [tabs]);

  // Selecting a tab from the palette/tree (or closing its neighbour) can leave the active
  // one scrolled out of the strip — pull it back into view the way the editor does.
  useEffect(() => {
    if (!activePath) return;
    tabRefs.current.get(activePath)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  // A tab strip is a horizontal row inside a vertical layout, so a trackpad-less mouse can
  // only ever produce vertical wheel deltas over it — translate those into scrolling.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
  };

  return (
    <div className="flex shrink-0 items-stretch border-b border-[var(--cf-border)] bg-[var(--cf-bg)]">
      <div ref={stripRef} onWheel={onWheel} className="cf-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab, index) => {
          const active = tab.path === activePath;
          const { Icon, color } = fileIconFor(tab.path);
          const suffix = suffixes.get(tab.path);
          return (
            <div
              key={tab.path}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.path, el);
                else tabRefs.current.delete(tab.path);
              }}
              role="tab"
              aria-selected={active}
              title={tab.path}
              draggable
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without payload; the index in React state
                // is what the drop handler actually reads.
                e.dataTransfer.setData("text/plain", tab.path);
              }}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
              }}
              onClick={() => onSelect(tab.path)}
              onDoubleClick={() => onPin(tab.path)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.path);
                }
              }}
              className={`group relative flex h-9 max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-[var(--cf-border)] pl-3 pr-2 text-[12px] transition-colors ${
                active
                  ? "bg-[var(--cf-surface)] text-[var(--cf-text)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              } ${dropIndex === index && dragIndex !== index ? "border-l border-l-[var(--cf-accent)]" : ""} ${
                dragIndex === index ? "opacity-50" : ""
              }`}
            >
              {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-[var(--cf-accent)]" />}
              <Icon size={13} className="shrink-0" style={{ color }} />
              <span className={`truncate ${tab.preview ? "italic" : ""}`}>{baseName(tab.path)}</span>
              {suffix && <span className="truncate text-[10px] text-[var(--cf-text-muted)] opacity-70">{suffix}</span>}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.path);
                }}
                title={t("editor.closeTab")}
                className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${
                  active ? "" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                {/* The dirty dot lives in the close button's slot, like VS Code: it turns into
                    an × on hover so a modified tab is still one click from closing. */}
                {tab.dirty ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-[var(--cf-text)] group-hover:hidden" />
                    <X size={12} className="hidden group-hover:block" />
                  </>
                ) : (
                  <X size={12} />
                )}
              </button>
            </div>
          );
        })}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2 border-l border-[var(--cf-border)] px-2">{actions}</div>
      )}
    </div>
  );
}
