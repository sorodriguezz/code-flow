import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { sshScanHostKey, sshTrustHostKey, type HostKeyScan } from "../../lib/tauri/sshCommands";
import { useHostKeyStore } from "../../state/hostKeyStore";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";
import { buttonClass } from "./Button";

/**
 * "Trust this SSH host?" — the question `ssh` asks on a first connection, asked in the app.
 *
 * Every SSH connection here runs with `BatchMode=yes` (nothing may wait on a prompt with no terminal
 * behind it), so a host not yet in `known_hosts` used to be a dead end: "Host key verification
 * failed", go and run `ssh` in a terminal once. This dialog scans what the host presents and shows
 * each key's type and SHA256 fingerprint, and writes the chosen one only when the user says so.
 *
 * A scan is not authentication: with somebody in the middle, the key scanned is theirs. So the one
 * sentence the dialog spends is on checking the fingerprint against one obtained another way, and
 * there is no Enter shortcut — trusting a host should take a deliberate click.
 *
 * Generic: it takes a host, a port and a user and knows nothing of what wanted to connect — the
 * database tunnel opens it today, the Remote workspace can open it the same way. Mounted once by
 * whichever workspace can need it; opened through `useHostKeyStore`.
 */
export function HostKeyDialog() {
  const t = useT();
  const target = useHostKeyStore((s) => s.target);
  const close = useHostKeyStore((s) => s.close);
  const panelRef = useRef<HTMLDivElement>(null);
  const [scan, setScan] = useState<HostKeyScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Above the early return — see `PromptModal` for what a hook after it does to the whole window.
  useFocusTrap(panelRef, target !== null);

  useEffect(() => {
    if (!target) return;
    let current = true;
    setScan(null);
    setError(null);
    setPicked(null);
    sshScanHostKey(target.host, target.port, target.user)
      .then((found) => {
        if (!current) return;
        setScan(found);
        // The first untrusted key — the list comes strongest first.
        setPicked((found.keys.find((key) => !key.trusted) ?? found.keys[0])?.key ?? null);
      })
      .catch((e) => current && setError(String(e)));
    return () => {
      current = false;
    };
  }, [target, attempt]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // Capture, so the Escape closes this and not the dialog underneath it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [target, close]);

  if (!target) return null;

  const chosen = scan?.keys.find((key) => key.key === picked) ?? null;

  const trust = async () => {
    if (!chosen || !scan) return;
    // Trusted meanwhile — elsewhere, or by an earlier run of this dialog: nothing to write, and the
    // opener's retry is what the user is waiting for.
    if (chosen.trusted) {
      const after = useHostKeyStore.getState().onTrusted;
      close();
      after?.();
      return;
    }
    setBusy(true);
    try {
      const file = await sshTrustHostKey(target.host, target.port, target.user, chosen.key_type, chosen.key);
      useToastStore.getState().pushToast(t("hostKey.trusted", { host: scan.known_as, file }), "success");
      const after = useHostKeyStore.getState().onTrusted;
      close();
      after?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4" onClick={close}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("hostKey.title")}
        tabIndex={-1}
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[520px] max-w-[92vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <KeyRound size={15} />
          </span>
          <p className="flex-1 text-[13px] font-medium text-[var(--cf-text)]">{t("hostKey.title")}</p>
        </div>

        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-[var(--cf-text-muted)]">{t("hostKey.host")}</dt>
          <dd className="truncate font-mono text-[var(--cf-text)]" title={scan?.hostname ?? target.host}>
            {scan?.hostname ?? target.host}
          </dd>
          <dt className="text-[var(--cf-text-muted)]">{t("hostKey.port")}</dt>
          <dd className="font-mono text-[var(--cf-text)]">{scan?.port ?? (target.port || 22)}</dd>
        </dl>

        {!scan && !error && (
          <p className="flex items-center gap-2 py-3 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("hostKey.scanning")}
          </p>
        )}

        {scan && (
          <div role="radiogroup" aria-label={t("hostKey.keys")} className="mb-3 space-y-1">
            {scan.keys.map((key) => (
              <label
                key={key.key}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 ${
                  key.key === picked
                    ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                    : "border-[var(--cf-border)] hover:bg-[var(--cf-hover)]"
                }`}
              >
                <input
                  type="radio"
                  name="host-key"
                  checked={key.key === picked}
                  onChange={() => setPicked(key.key)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
                    {key.key_type}
                    {key.trusted && (
                      <span className="flex items-center gap-0.5 text-[11px] text-[var(--cf-success)]">
                        <Check size={11} />
                        {t("hostKey.alreadyTrusted")}
                      </span>
                    )}
                  </span>
                  {/* Selectable, so it can be copied into whatever it is being compared against. */}
                  <span className="block select-text break-all font-mono text-[11.5px] text-[var(--cf-text-muted)]">
                    {key.fingerprint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {error && (
          <p className="mb-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-danger)]">
            {error}
          </p>
        )}

        <p className="mb-4 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--cf-warning)]">
          <TriangleAlert size={12} className="mt-[2px] shrink-0" />
          {t("hostKey.verify")}
        </p>

        <div className="flex items-center justify-end gap-2">
          {scan && (
            <span className="mr-auto truncate text-[11px] text-[var(--cf-text-faint)]" title={scan.known_hosts_file}>
              {scan.known_hosts_file}
            </span>
          )}
          {error && !scan && (
            <button onClick={() => setAttempt((n) => n + 1)} className={buttonClass({ variant: "ghost" })}>
              <RotateCw size={12} />
              {t("hostKey.retry")}
            </button>
          )}
          <button onClick={close} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void trust()}
            disabled={!chosen || busy}
            className={buttonClass({ variant: "primary" })}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {chosen?.trusted ? t("hostKey.continue") : t("hostKey.trust")}
          </button>
        </div>
      </div>
    </div>
  );
}
