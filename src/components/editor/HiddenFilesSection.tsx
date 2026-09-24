import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder } from "lucide-react";
import { useHiddenFilesStore } from "../../state/hiddenFilesStore";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { buttonClass } from "../common/Button";
import { splitPath } from "../../lib/splitPath";
import { useT } from "../../state/languageStore";

function HiddenRow({ path, isDir, onShow }: { path: string; isDir: boolean; onShow: () => void }) {
  const t = useT();
  const { dir, name } = splitPath(path);

  return (
    <button
      type="button"
      onClick={onShow}
      title={t("editor.hiddenShow")}
      // The whole row restores, with the eye as the affordance — a full tree-row target for an
      // action whose only cost when mis-clicked is that a row comes back.
      className="group flex h-[26px] w-full items-center gap-1.5 rounded-md pl-2 pr-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
    >
      {isDir ? (
        <Folder size={13} className="shrink-0" />
      ) : (
        <FileGlyph path={path} />
      )}
      {/* The folders it sits in stay dimmer than the name: two entries called `index.ts` are only
          told apart by the path, so it has to be there — but it is not what you read first. */}
      <span className="min-w-0 flex-1 truncate" title={path}>
        {dir && <span className="text-[var(--cf-text-faint)]">{dir}/</span>}
        {name}
      </span>
      <Eye
        size={14}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/**
 * The list of what has been taken out of the explorer, and the way back.
 *
 * Pinned under the tree rather than folded into it, because it is the only place a hidden entry
 * still exists: a section that scrolled away with the tree would make "where did my folder go?"
 * a question with no answer on screen. It renders nothing at all while nothing is hidden — an
 * empty "Hidden" header on every project would be a permanent reminder of a feature most people
 * use once.
 */
export function HiddenFilesSection() {
  const entries = useHiddenFilesStore((s) => s.entries);
  const show = useHiddenFilesStore((s) => s.show);
  const showAll = useHiddenFilesStore((s) => s.showAll);
  const [open, setOpen] = useState(false);
  const t = useT();

  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] p-2">
      <div className="flex items-center gap-1">
        <Tooltip side="top" label={t("editor.hiddenSection")} description={t("editor.hiddenHint")}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            {open ? (
              <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
            )}
            <EyeOff size={14} className="shrink-0" />
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em]">
              {t("editor.hiddenSection")}
            </span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
              {entries.length}
            </span>
          </button>
        </Tooltip>
        {open && (
          <button type="button" onClick={showAll} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("editor.hiddenShowAll")}
          </button>
        )}
      </div>
      {/* Capped and scrollable: someone who hides thirty build folders must not lose the tree to
          the list of what they hid. */}
      {open && (
        <div className="mt-1 max-h-[180px] overflow-y-auto">
          {entries.map((entry) => (
            <HiddenRow
              key={entry.path}
              path={entry.path}
              isDir={entry.isDir}
              onShow={() => show(entry.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
