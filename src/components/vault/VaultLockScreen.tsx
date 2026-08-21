/**
 * The keyring's front door: first-run setup, or the unlock prompt.
 *
 * One component for both, because they are the same screen with a different number of boxes and it
 * is the same decision being asked about. What is *not* shared is the warning: setup says, in as
 * many words, that a forgotten master password cannot be recovered. That sentence has to be on the
 * screen where the password is chosen, not buried in a settings panel someone finds later.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, Lock, ShieldAlert } from "lucide-react";

import { useVaultStore } from "../../state/vaultStore";
import { useVaultModalStore } from "../../state/vaultModalStore";
import { useT } from "../../state/languageStore";
import { BUTTON, INPUT, passwordStrength } from "./vaultChrome";

/** Mirrors `crypto::MIN_MASTER_LENGTH`. The backend is what enforces it; this is what explains it. */
const MIN_LENGTH = 10;

export function VaultLockScreen() {
  const initialised = useVaultStore((s) => s.initialised);
  const unlocking = useVaultStore((s) => s.unlocking);
  const unlockError = useVaultStore((s) => s.unlockError);
  const remembered = useVaultStore((s) => s.remembered);
  const t = useT();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(remembered);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [initialised]);

  // There is deliberately NO "try the remembered password" effect here, and this comment is where
  // one used to be. Mounting is the wrong trigger: this screen mounts every time the vault locks,
  // so an attempt here re-opened the vault the instant it closed — "Lock now" flashed a lock screen
  // and landed straight back inside, and an idle auto-lock did the same, which quietly made the
  // auto-lock setting do nothing at all for anyone who had asked this machine to remember.
  //
  // The remembered password is a convenience for *starting the app*, not a way around a lock. It is
  // tried once per session, from `ensureVaultStoreLoaded`.

  // `null` means the backend has not answered yet. Nothing is drawn until it has — see the field's
  // comment in `vaultStore`: guessing `false` here is what showed a *create a keyring* form to
  // people who already had one, and let them type a password into it.
  if (initialised === null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("vault.checking")}</span>
      </div>
    );
  }

  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = !initialised && confirm.length > 0 && confirm !== password;
  const canSubmit =
    password.length >= MIN_LENGTH && (initialised || confirm === password) && !unlocking;

  const submit = async () => {
    if (!canSubmit) return;
    const store = useVaultStore.getState();
    const opened = initialised
      ? await store.unlock(password, remember)
      : await store.initialise(password, remember);
    if (opened) {
      // Cleared whatever happens next: the password must not sit in a React state object for the
      // rest of the session just because the form stayed mounted.
      setPassword("");
      setConfirm("");
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-sm" data-tour="vault-lock">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            {initialised ? <Lock size={22} /> : <KeyRound size={22} />}
          </div>
          <h2 className="text-[15px] font-semibold text-[var(--cf-text)]">
            {t(initialised ? "vault.unlockTitle" : "vault.setupTitle")}
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {t(initialised ? "vault.unlockBody" : "vault.setupBody")}
          </p>
        </div>

        {/* Only on setup. This is the one thing about the design a user must know *before* choosing
            a password, and it is the reason the app cannot help them later. */}
        {!initialised && (
          <p className="mb-4 flex items-start gap-2 rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--cf-text)]">
            <ShieldAlert size={14} className="mt-[1px] shrink-0 text-[var(--cf-warning)]" />
            <span>{t("vault.setupWarning")}</span>
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2.5"
        >
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("vault.masterPassword")}
            autoComplete={initialised ? "current-password" : "new-password"}
            className={INPUT}
          />

          {!initialised && (
            <>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={t("vault.confirmPassword")}
                autoComplete="new-password"
                className={INPUT}
              />
              {password.length > 0 && (
                <div className="flex items-center gap-2">
                  <div className="flex h-1 flex-1 gap-1">
                    {[0, 1, 2].map((step) => (
                      <span
                        key={step}
                        className={`h-1 flex-1 rounded-full ${
                          strength > step ? "bg-[var(--cf-accent)]" : "bg-[var(--cf-border)]"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="text-[10.5px] text-[var(--cf-text-muted)]">
                    {t(
                      strength === 0
                        ? "vault.strengthWeak"
                        : strength === 1
                          ? "vault.strengthFair"
                          : strength === 2
                            ? "vault.strengthGood"
                            : "vault.strengthStrong",
                    )}
                  </span>
                </div>
              )}
            </>
          )}

          <label className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="mt-[3px] accent-[var(--cf-accent)]"
            />
            <span>
              <span className="text-[var(--cf-text)]">{t("vault.remember")}</span>
              <br />
              {t("vault.rememberHint")}
            </span>
          </label>

          {tooShort && (
            <p className="text-[11.5px] text-[var(--cf-danger)]">
              {t("vault.tooShort", { n: MIN_LENGTH })}
            </p>
          )}
          {mismatch && (
            <p className="text-[11.5px] text-[var(--cf-danger)]">{t("vault.passwordsDiffer")}</p>
          )}
          {/* The backend's own message, shown beside the box it is about rather than as a toast:
              a wrong password is an answer to what was just typed. */}
          {unlockError && !tooShort && !mismatch && (
            <p className="text-[11.5px] text-[var(--cf-danger)]">{unlockError}</p>
          )}

          <button type="submit" disabled={!canSubmit} className={`${BUTTON} mt-1`}>
            {unlocking
              ? t("vault.unlocking")
              : t(initialised ? "vault.unlock" : "vault.create")}
          </button>

          {/* Only on the unlock screen, and deliberately quiet: this is the way out of a forgotten
              master password, and there is no other — but it destroys the keyring, so it must not
              sit next to the unlock button looking like an alternative to remembering. */}
          {initialised && (
            <button
              type="button"
              onClick={() => useVaultModalStore.getState().openVaultModal({ kind: "settings" })}
              className="mt-1 self-center text-[11px] text-[var(--cf-text-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--cf-text)]"
            >
              {t("vault.forgotPassword")}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
