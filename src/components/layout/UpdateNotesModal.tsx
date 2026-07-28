import { useEffect } from "react";
import { Download, Loader2, RotateCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "../../lib/markdown";
import { useUpdateStore } from "../../state/updateStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/** The `date` the updater reports comes straight from the release manifest and isn't always a
 * shape `Date` can read (Tauri writes it as `2026-07-28 09:14:02.000 +00:00:00`). A release
 * without a legible date simply doesn't show one. */
function releaseDate(raw: string | undefined, locale: string): string | null {
  if (!raw) return null;
  const parsed = new Date(raw.replace(" ", "T").replace(/ \+00:00:00$/, "Z"));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Sends links inside the notes to the system browser.
 *
 * These are markdown links rendered by `marked`, which doesn't add `target="_blank"` — so
 * without this a click would navigate the app's own webview to GitHub and leave the user
 * staring at a website where CodeFlow used to be, with no way back. The notes are written by
 * whoever cut the release, so only http(s) is followed; anything else is simply swallowed.
 */
function openLinkExternally(e: React.MouseEvent<HTMLDivElement>) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => {});
}

/**
 * What's new in the release that's waiting — the release notes themselves, not just "an update
 * is available", so the user can decide whether to restart their work for it now or later.
 *
 * Also where the install happens: it's the one surface reached from the title bar badge, so
 * everything the user needs (read, install, restart) is in one place instead of sending them to
 * Settings to finish what they started here.
 */
export function UpdateNotesModal() {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const open = useUpdateStore((s) => s.notesOpen);
  const closeNotes = useUpdateStore((s) => s.closeNotes);
  const update = useUpdateStore((s) => s.update);
  const status = useUpdateStore((s) => s.status);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNotes();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeNotes]);

  if (!open || !update) return null;

  const notes = update.body?.trim();
  const date = releaseDate(update.date, locale);
  const busy = status === "downloading";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-20" onClick={closeNotes}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-[540px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--cf-border)] p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Sparkles size={14} className="shrink-0 text-[var(--cf-accent)]" />
              {t("update.whatsNew", { version: `v${update.version}` })}
            </h3>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <span className="font-mono">v{update.currentVersion}</span>
              <span aria-hidden>→</span>
              <span className="font-mono text-[var(--cf-accent)]">v{update.version}</span>
              {date && <span>· {date}</span>}
            </p>
          </div>
          <button onClick={closeNotes} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {notes ? (
            <div
              className="cf-markdown-preview text-[13px]"
              onClick={openLinkExternally}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }}
            />
          ) : (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("update.noNotes")}</p>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--cf-border)] p-4">
          {error && status === "error" && (
            <p className="mb-2 flex items-start gap-1.5 text-[11px] text-[var(--cf-danger)]">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-all">{error}</span>
            </p>
          )}

          {busy && (
            <div className="mb-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
                <Loader2 size={13} className="animate-spin" />
                {t("settings.downloadingUpdate", { progress })}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--cf-border)]">
                <div
                  className="h-full rounded-full bg-[var(--cf-accent)] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {status === "ready" ? (
              <>
                <p className="mr-auto flex items-center gap-1.5 text-[12px] text-[var(--cf-success)]">
                  {t("settings.updateReady")}
                </p>
                <button
                  onClick={() => void restart()}
                  className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
                >
                  <RotateCw size={13} />
                  {t("settings.restartNow")}
                </button>
              </>
            ) : (
              <>
                {/* Deliberately just closes: an update is never forced, and the badge stays in
                    the title bar so this window is one click away again. */}
                <button
                  onClick={closeNotes}
                  disabled={busy}
                  className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
                >
                  {t("update.later")}
                </button>
                <button
                  onClick={() => void install()}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                >
                  <Download size={13} />
                  {t("settings.installUpdate", { version: `v${update.version}` })}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
