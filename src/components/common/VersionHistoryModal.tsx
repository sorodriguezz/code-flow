/**
 * The past versions of a note or a diagram, and the way back to one.
 *
 * One component for both, because they need the same three things — a list, a look at one, and a
 * button that puts it back — and two copies would be two places to fix the day the restore is
 * wrong. The caller supplies how to read and how to restore; everything else is here.
 *
 * **Why this exists.** Notes and diagrams autosave, and they are the only two workspaces in the app
 * whose content is original rather than a reflection of something on disk: everywhere else git or
 * the file system is the undo. Here there was none, so a select-all and a keystroke was final the
 * moment the editor session ended. The DBML workbench next door has had a history panel since it
 * shipped, which is what made the absence conspicuous.
 *
 * Restoring writes a *new* version rather than rewinding to an old one — the current text is
 * snapshotted on the way past, because "I restored the wrong one" is the next thing that happens.
 *
 * **Versions can be deleted from here**, one at a time or the lot. The table already prunes itself
 * at fifty per document, so this is not about disk — it is about the list being *readable*. Fifty
 * snapshots of one afternoon's typing, dated four minutes apart, is a list nobody scans; the two
 * that are worth keeping are invisible inside it. Pruning is how a reader turns the pile back into
 * a shortlist, so the single-row delete is deliberately one click with no dialog in the way. The
 * dialog is on "empty it", which is the button that can actually cost something.
 */

import { useEffect, useState } from "react";
import { History, RotateCcw, Trash2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { DocVersion } from "../../types/notes";

/** "12 KB" / "840 characters" — enough to tell two versions apart at a glance. */
function sizeLabel(characters: number, t: ReturnType<typeof useT>): string {
  if (characters < 1024) return t("versions.sizeChars", { n: characters });
  return t("versions.sizeKb", { n: (characters / 1024).toFixed(1) });
}

export function VersionHistoryModal({
  title,
  listVersions,
  readVersion,
  onRestore,
  deleteVersion,
  clearVersions,
  onClose,
}: {
  /** The document's current name, for the dialog's subtitle. */
  title: string;
  listVersions: () => Promise<DocVersion[]>;
  readVersion: (versionId: string) => Promise<string | null>;
  /** Puts the text back. The caller owns the write, because a note and a diagram save differently. */
  onRestore: (content: string, version: DocVersion) => Promise<void>;
  /** Drops one version. Owned by the caller for the same reason `listVersions` is: the command is
   *  per kind. */
  deleteVersion: (versionId: string) => Promise<void>;
  /** Drops every version of this document. The document itself is untouched. */
  clearVersions: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [selected, setSelected] = useState<DocVersion | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listVersions()
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        // Open on the newest, because "what did it look like before I broke it" is almost always
        // the last snapshot — and a dialog that opens on an empty pane makes you click twice to
        // find that out.
        if (rows.length > 0) setSelected(rows[0]);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setVersions([]);
          pushErrorToast(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContent(null);
    void readVersion(selected.id)
      .then((text) => {
        if (!cancelled) setContent(text ?? "");
      })
      .catch(() => {
        if (!cancelled) setContent("");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const restore = async () => {
    if (!selected || content === null) return;
    if (!(await confirmAction(t("versions.restoreConfirm"), false, t("versions.restore")))) return;
    setRestoring(true);
    try {
      await onRestore(content, selected);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
      setRestoring(false);
    }
  };

  /**
   * Drops one version, without a dialog in the way.
   *
   * No confirmation on purpose. Pruning a fifty-row list into the three snapshots worth keeping is
   * forty-seven decisions, and a modal on each turns the one feature people asked for into a chore
   * they abandon halfway. The row it acts on is the row under the pointer, the list redraws
   * immediately, and every *other* version is untouched — the table holds whole documents, so there
   * is no chain to break. The dialog is on "empty it" below, where one click really does take
   * everything.
   */
  const removeOne = async (version: DocVersion) => {
    // Optimistic, and the reload on failure is what makes that safe: a delete that did not happen
    // must not leave a row missing from a list people are about to trust.
    setVersions((rows) => (rows ?? []).filter((row) => row.id !== version.id));
    if (selected?.id === version.id) {
      // Onto its neighbour rather than onto nothing: an emptied preview pane reads as "the delete
      // took more than one row with it". The one below, or the one above when it was the last.
      const rows = versions ?? [];
      const at = rows.findIndex((row) => row.id === version.id);
      setSelected(rows[at + 1] ?? rows[at - 1] ?? null);
    }
    try {
      await deleteVersion(version.id);
    } catch (e) {
      pushErrorToast(String(e));
      await listVersions()
        .then(setVersions)
        .catch(() => undefined);
    }
  };

  const clearAll = async () => {
    if (!(await confirmAction(t("versions.clearConfirm"), true, t("versions.clear")))) return;
    try {
      await clearVersions();
      setVersions([]);
      setSelected(null);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <ApiModal
      icon={History}
      title={t("versions.title")}
      subtitle={title}
      width="max-w-4xl"
      height="h-[72vh]"
      busy={restoring}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {/* What the list weighs, before the hint about restoring. It is here because "am I
                hoarding these?" is the question that sends people looking for the delete button in
                the first place, and a list you have to count yourself never answers it. */}
            {versions !== null && versions.length > 0 && (
              <span className="mr-1 text-[var(--cf-text)]">
                {t("versions.count", { n: versions.length })} ·{" "}
                {sizeLabel(
                  versions.reduce((total, version) => total + version.size, 0),
                  t,
                )}
                {" · "}
              </span>
            )}
            {t("versions.footerHint")}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {versions !== null && versions.length > 0 && (
              <GhostButton onClick={() => void clearAll()} title={t("versions.clearHint")}>
                <Trash2 size={12} />
                {t("versions.clear")}
              </GhostButton>
            )}
            <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
            <PrimaryButton onClick={() => void restore()} disabled={!selected || content === null || restoring}>
              <RotateCcw size={12} className="mr-1 inline" />
              {t("versions.restore")}
            </PrimaryButton>
          </div>
        </div>
      }
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1">
        {/* The list. Narrow, because a row is a date and a size. */}
        <div className="w-[230px] shrink-0 overflow-y-auto border-r border-[var(--cf-border)] p-2">
          {versions === null ? (
            <div className="space-y-1" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : versions.length === 0 ? (
            <p className="px-1 py-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("versions.empty")}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {versions.map((version) => {
                const active = selected?.id === version.id;
                return (
                  // `group` and `relative` for the delete button below, which is positioned over
                  // the row rather than laid out beside it: a flex sibling would take width from
                  // the date, and the date is the whole reason a reader can tell two rows apart.
                  <li key={version.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => setSelected(version)}
                      className={`w-full rounded-md py-1.5 pl-2 pr-7 text-left transition-colors ${
                        active
                          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                          : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      }`}
                    >
                      {/* Date and time in full — a list of versions from one afternoon differs only
                          by the time, so a truncated one is a row you cannot pick out. */}
                      <span className="block break-words text-[12px] leading-snug">
                        {new Date(version.created_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="mt-0.5 block break-words text-[10.5px] leading-snug opacity-70">
                        {version.title || t("versions.untitled")} · {sizeLabel(version.size, t)}
                      </span>
                    </button>
                    {/* A sibling and not a child: a button inside a button is invalid, and the row
                        is already the "look at this one" target. Revealed on hover, and on keyboard
                        focus so it is not mouse-only. */}
                    <button
                      type="button"
                      onClick={() => void removeOne(version)}
                      title={t("versions.delete")}
                      aria-label={t("versions.delete")}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* The version itself, as plain text. Deliberately not rendered: this is a dialog for
            deciding *which* version, and a Markdown preview or a drawn diagram hides exactly the
            details — a deleted paragraph, a lost node — that tell two versions apart. */}
        <div className="min-w-0 flex-1 overflow-auto">
          {versions !== null && versions.length === 0 ? (
            <EmptyState icon={History} title={t("versions.empty")} subtitle={t("versions.emptyHint")} />
          ) : content === null ? (
            <div className="space-y-2 p-4" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[11.5px] leading-relaxed text-[var(--cf-text)]">
              {content}
            </pre>
          )}
        </div>
      </div>
    </ApiModal>
  );
}
