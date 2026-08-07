import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder } from "lucide-react";
import { useHiddenFilesStore } from "../../state/hiddenFilesStore";
import { fileIconFor } from "../../lib/fileIcon";
import { useT } from "../../state/languageStore";

/** Splits a repo-relative path into the folders leading to it and its own name, so the name can be
 *  the readable part of a row that is mostly path. */
function split(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

function HiddenRow({ path, isDir, onShow }: { path: string; isDir: boolean; onShow: () => void }) {
  const t = useT();
  const { dir, name } = split(path);
  const { Icon, color } = fileIconFor(path);

  return (
    <button
      type="button"
      onClick={onShow}
      title={t("editor.hiddenShow")}
      // The whole row restores, with the eye as the affordance — a 20px target for an action whose
      // only cost when mis-clicked is that a row comes back.
      className="group flex w-full items-center gap-1.5 rounded-md py-0.5 pl-2 pr-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
    >
      {isDir ? (
        <Folder size={13} className="shrink-0" />
      ) : (
        <Icon size={13} className="shrink-0" style={{ color }} />
      )}
      {/* The folders it sits in stay dimmer than the name: two entries called `index.ts` are only
          told apart by the path, so it has to be there — but it is not what you read first. */}
      <span className="min-w-0 flex-1 truncate" title={path}>
        {dir && <span className="opacity-50">{dir}</span>}
        {name}
      </span>
      <Eye
        size={13}
        className="shrink-0 text-[var(--cf-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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
    <div className="shrink-0 border-t border-[var(--cf-border)]">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={t("editor.hiddenHint")}
          className="flex min-w-0 flex-1 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? (
            <ChevronDown size={11} className="shrink-0" />
          ) : (
            <ChevronRight size={11} className="shrink-0" />
          )}
          <EyeOff size={12} className="shrink-0" />
          <span className="truncate">{t("editor.hiddenSection")}</span>
          <span className="tabular-nums opacity-70">({entries.length})</span>
        </button>
        {open && (
          <button
            type="button"
            onClick={showAll}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            {t("editor.hiddenShowAll")}
          </button>
        )}
      </div>
      {/* Capped and scrollable: someone who hides thirty build folders must not lose the tree to
          the list of what they hid. */}
      {open && (
        <div className="max-h-[180px] overflow-y-auto pb-1">
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
