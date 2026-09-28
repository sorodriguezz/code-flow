import { ArchiveRestore, Trash2, X } from "lucide-react";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { ICON_BUTTON, relativeTime } from "./notesChrome";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useNotesStore } from "../../state/notesStore";

/**
 * The Notes trash: what was deleted in this workspace (and the global notes), newest first, each
 * with Restore and Delete for good — and one Empty for all of it.
 *
 * Read when opened and never kept fresh behind the user's back: nothing else on screen shows it,
 * and a deletion elsewhere drops the cached list so the next opening reads again. The thirty-day
 * limit is stated in the empty button's tooltip rather than in a paragraph — the list itself is
 * the whole screen.
 */
export function NoteTrash() {
  const trash = useNotesStore((s) => s.trash);
  const closeTrash = useNotesStore((s) => s.closeTrash);
  const restoreFromTrash = useNotesStore((s) => s.restoreFromTrash);
  const purgeFromTrash = useNotesStore((s) => s.purgeFromTrash);
  const emptyTrash = useNotesStore((s) => s.emptyTrash);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  if (trash === null) return <ViewSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
        <Trash2 size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <h2 className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text-muted)]">
          {t("notes.trashCount", { n: trash.length })}
        </h2>
        <button
          type="button"
          disabled={trash.length === 0}
          title={t("notes.emptyTrashHint")}
          onClick={() =>
            void confirmAction(
              t("notes.emptyTrashConfirm", { n: trash.length }),
              true,
              t("notes.emptyTrash"),
            ).then((ok) => ok && void emptyTrash())
          }
          className="rounded-md px-2 py-1 text-[12px] text-[var(--cf-danger)] hover:bg-[var(--cf-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("notes.emptyTrash")}
        </button>
        <button
          type="button"
          onClick={closeTrash}
          title={t("notes.closeTrash")}
          aria-label={t("notes.closeTrash")}
          className={ICON_BUTTON}
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {trash.length > 0 && (
          <ul className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-md border border-[var(--cf-border)]">
            {trash.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-[var(--cf-text)]">
                    {entry.title.trim() || t("notes.untitled")}
                  </p>
                  <p className="truncate text-[11px] text-[var(--cf-text-muted)]">
                    {[entry.book_name, relativeTime(entry.deleted_at, language)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void restoreFromTrash(entry.id)}
                  title={t("notes.restore")}
                  aria-label={t("notes.restore")}
                  className={ICON_BUTTON}
                >
                  <ArchiveRestore size={13} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void confirmAction(
                      t("notes.purgeConfirm", { name: entry.title.trim() || t("notes.untitled") }),
                      true,
                      t("notes.purge"),
                    ).then((ok) => ok && void purgeFromTrash(entry.id))
                  }
                  title={t("notes.purge")}
                  aria-label={t("notes.purge")}
                  className={`${ICON_BUTTON} hover:text-[var(--cf-danger)]`}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
