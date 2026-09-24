import { useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { KeyRound } from "lucide-react";
import { closeTerminal, openTerminal, writeTerminal } from "../../lib/tauri/commands";
import { startTerminalRouter } from "../../state/terminalStore";
import { useT } from "../../state/languageStore";
import { TerminalPane } from "../terminal/TerminalPane";

/**
 * A shell opened *as* one account, with the CLI's own sign-in already typed into it.
 *
 * The login is the one step this app must not do for the user — it would mean touching the token —
 * so it runs the provider's official flow where the user can see it: a browser page, a device code,
 * whatever that CLI does. Everything the CLI stores lands in the account's own folder, because the
 * shell carries the account's variable.
 *
 * The shell is closed with the dialog. Closing it mid-login is harmless — the CLI simply never wrote
 * anything — and "Done" asks the CLI who it is now signed in as.
 */
export function AccountTerminalDialog({
  title,
  provider,
  accountId,
  command,
  hint,
  onClose,
}: {
  title: string;
  provider: string;
  /** `null` opens the shell as the system account. */
  accountId: string | null;
  /** Typed into the shell once it is up; `null` leaves it at a prompt. */
  command: string | null;
  /** One line under the title, for a flow with a step the CLI will not say — Gemini's `/logout`. */
  hint?: string;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // No `useFocusTrap` here, unlike the other dialogs: it takes Tab to cycle its controls, and in a
  // shell Tab is completion. The terminal takes focus itself (`autoFocus`) instead.

  useEffect(() => {
    let cancelled = false;
    let opened: string | null = null;
    // Before the await, as the dock does: the shell can print its first prompt while
    // `open_terminal` is still returning, and that has to be held for the pane, not dropped.
    startTerminalRouter();
    void (async () => {
      try {
        const cwd = await homeDir();
        const { id } = await openTerminal(cwd, undefined, accountId ? { provider, accountId } : null);
        opened = id;
        if (cancelled) {
          void closeTerminal(id).catch(() => {});
          return;
        }
        setSessionId(id);
        // `\r` is what Enter sends to a terminal — see `terminalStore.runCommand`.
        if (command) await writeTerminal(id, `${command}\r`);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void closeTerminal(opened).catch(() => {});
    };
  }, [provider, accountId, command]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape belongs to the terminal (vim, a CLI's own menus) once it has focus, so only a
      // press that reaches the window with nothing focused inside the shell closes the dialog.
      if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest?.(".xterm")) onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="cf-fade-in flex h-[min(520px,calc(100vh-2rem))] w-[760px] max-w-[94vw] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-2 flex items-start gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <KeyRound size={14} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-[13px] font-medium text-[var(--cf-text)]">{title}</p>
            {hint && <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            {t("accounts.loginDone")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
          {error ? (
            <p className="p-3 text-[12px] text-[var(--cf-danger)]">{error}</p>
          ) : sessionId ? (
            <TerminalPane sessionId={sessionId} visible autoFocus />
          ) : null}
        </div>
      </div>
    </div>
  );
}
