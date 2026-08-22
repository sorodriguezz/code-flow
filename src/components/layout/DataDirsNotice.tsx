import { useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCw, TriangleAlert, UserCheck, X } from "lucide-react";
import { useDataDirsStore } from "../../state/dataDirsStore";
import { useT } from "../../state/languageStore";
import {
  acknowledgeSharedRoot,
  retryLayoutMigration,
  revealInFileManager,
} from "../../lib/tauri/commands";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * What the app says about its own directories when there is something to say.
 *
 * Two shapes, chosen by one field:
 *
 * * **A dismissable card**, for `migrated` (the single launch where the files actually moved) and
 *   `notPersistent` (the state root is being discarded every logoff). Both are information; the app
 *   works and the user can carry on.
 *
 * * **A blocking screen**, for anything with `ok: false`. This is the one modal in the app that
 *   cannot be closed, and it is deliberate. Every one of those verdicts means the database the app
 *   is about to write into is not the database the user's work is in — a failed copy, an
 *   unrecognised occupant, a shared Windows root that needs a person. Letting them type a note into
 *   it and find it gone tomorrow would be worse than any inconvenience of being stopped. The old
 *   data is untouched and named on screen.
 *
 * It follows `RequirementsModal`'s grammar on purpose — same warning triangle, same "quote the
 * machine verbatim in monospace" rule — because a person who has seen one of these should recognise
 * the other as the same kind of message.
 */
export function DataDirsNotice() {
  const t = useT();
  const status = useDataDirsStore((s) => s.status);
  const dismissed = useDataDirsStore((s) => s.noticeDismissed);
  const dismissNotice = useDataDirsStore((s) => s.dismissNotice);
  const load = useDataDirsStore((s) => s.load);
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const blocking = status !== null && !status.ok;

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The focus trap, and the reason it is not optional.
   *
   * A `fixed inset-0` overlay stops the mouse and nothing else. Without this, plain Tab walks
   * straight out of the card into the sidebar, Settings and every button in the app underneath —
   * all of which write to a database this screen exists to say is not the user's. `useGlobalShortcuts`
   * closes the other half of the same hole by suspending every chord while this is up.
   *
   * A cycle rather than `inert` on the rest of the tree: the app shell has no single wrapper node
   * to mark, and `inert` would have to be threaded through several roots that each mount at the top
   * level (the tour overlay, the toasts, the confirm dialog).
   */
  useEffect(() => {
    if (!blocking) return;
    const card = cardRef.current;
    if (!card) return;

    const focusable = () =>
      Array.from(
        card.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      );
    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Anything focused outside the card — the app underneath, or nothing at all — is pulled back
      // in rather than merely wrapped, because the trap has to survive a stray programmatic focus.
      if (!active || !card.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [blocking, status?.kind]);

  if (!status) return null;

  const informational = status.kind === "migrated" || status.kind === "notPersistent";
  if (!blocking && (!informational || dismissed)) return null;

  const title = t(`dataDirs.${status.kind}` as TranslationKey);
  const body = t(`dataDirs.${status.kind}Hint` as TranslationKey);

  const paths = (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
      {[
        [t("dataDirs.stateDir"), status.stateDir],
        [t("dataDirs.userDir"), status.userDir],
        [t("dataDirs.legacyDir"), status.legacyDir],
      ].map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--cf-text-muted)]">{label}</dt>
          {/* Selectable, because the next thing anybody does with a path in an error is paste it
              somewhere. `break-all` rather than truncation for the same reason. */}
          <dd className="select-text break-all font-mono text-[var(--cf-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );

  const card = (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      className="flex max-h-[75vh] w-[560px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--cf-border)] p-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <TriangleAlert
              size={14}
              className={`shrink-0 ${blocking ? "text-[var(--cf-danger)]" : "text-[var(--cf-warning)]"}`}
            />
            {title}
          </h3>
        </div>
        {!blocking && (
          <button
            onClick={dismissNotice}
            aria-label={t("dataDirs.dismiss")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={15} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-[12.5px] leading-snug text-[var(--cf-text-muted)]">{body}</p>
        {paths}
        {status.detail && (
          <p className="mt-3 select-text break-all rounded-md bg-black/[0.04] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.06]">
            {status.detail}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] p-3">
        <button
          onClick={() => void revealInFileManager(status.legacyDir)}
          className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] font-medium hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <FolderOpen size={13} />
          {t("dataDirs.openOldFolder")}
        </button>
        {blocking && status.kind === "sharedAccount" && (
          <button
            disabled={acknowledged}
            onClick={async () => {
              await acknowledgeSharedRoot();
              setAcknowledged(true);
            }}
            className="flex items-center gap-1.5 rounded-md border border-[var(--cf-accent)]/40 px-2.5 py-1.5 text-[12px] font-medium text-[var(--cf-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_8%,transparent)] disabled:opacity-50"
          >
            <UserCheck size={13} />
            {acknowledged ? t("dataDirs.retryArmed") : t("dataDirs.soleUser")}
          </button>
        )}
        {blocking && status.kind !== "sharedAccount" && (
          <button
            disabled={retrying || retried}
            onClick={async () => {
              setRetrying(true);
              try {
                await retryLayoutMigration();
                setRetried(true);
              } finally {
                setRetrying(false);
              }
            }}
            className="flex items-center gap-1.5 rounded-md border border-[var(--cf-accent)]/40 px-2.5 py-1.5 text-[12px] font-medium text-[var(--cf-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_8%,transparent)] disabled:opacity-50"
          >
            <RotateCw size={13} className={retrying ? "animate-spin" : ""} />
            {retried ? t("dataDirs.retryArmed") : t("dataDirs.retry")}
          </button>
        )}
        {!blocking && (
          <button
            onClick={dismissNotice}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
          >
            {t("dataDirs.dismiss")}
          </button>
        )}
      </div>
    </div>
  );

  return (
    // Above `RequirementsModal`'s `z-[60]` — if both fire on the same launch this is the one that
    // has to be read first, because a data directory that cannot be written is a smaller problem
    // than a database that is not the user's — and above `TourOverlay`'s `z-[100000]`, which is
    // otherwise the one thing in the app that can paint over this. The tour is also prevented from
    // auto-opening at all while a blocking verdict stands (see `App.tsx`); this is the backstop for
    // a tour the user starts by hand.
    <div
      className="fixed inset-0 z-[100001] flex items-start justify-center bg-black/40 pt-20"
      onClick={blocking ? undefined : dismissNotice}
    >
      {card}
    </div>
  );
}
