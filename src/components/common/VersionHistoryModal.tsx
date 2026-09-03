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
 */

import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
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
  onClose,
}: {
  /** The document's current name, for the dialog's subtitle. */
  title: string;
  listVersions: () => Promise<DocVersion[]>;
  readVersion: (versionId: string) => Promise<string | null>;
  /** Puts the text back. The caller owns the write, because a note and a diagram save differently. */
  onRestore: (content: string, version: DocVersion) => Promise<void>;
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
            {t("versions.footerHint")}
          </span>
          <div className="flex shrink-0 items-center gap-2">
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
                  <li key={version.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(version)}
                      className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
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
