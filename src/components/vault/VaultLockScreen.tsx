/**
 * The keyring's front door: first-run setup, or the unlock prompt — or, before either, the moment
 * of working out which of the two it is.
 *
 * One component for both forms, because they are the same screen with a different number of boxes
 * and it is the same decision being asked about. What is *not* shared is the warning: setup says,
 * in as many words, that a forgotten master password cannot be recovered. That sentence has to be
 * on the screen where the password is chosen, not buried in a settings panel someone finds later.
 *
 * The third state, `VaultBooting`, is not decoration. Deciding which form to draw means asking the
 * database whether a keyring exists *and* the operating system whether it is holding the master
 * password — two questions that can take a noticeable moment, and one of which can put a system
 * prompt in front of the answer. Drawing a form before both are answered is how this screen used to
 * show a locked keyring that then unlocked itself, unasked, a moment later.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Lock, ShieldAlert, Unplug } from "lucide-react";

import { useVaultStore } from "../../state/vaultStore";
import { useVaultModalStore } from "../../state/vaultModalStore";
import { useT } from "../../state/languageStore";
import { BUTTON, INPUT, passwordStrength } from "./vaultChrome";

/** Mirrors `crypto::MIN_MASTER_LENGTH`. The backend is what enforces it; this is what explains it. */
const MIN_LENGTH = 10;

export function VaultLockScreen() {
  const initialised = useVaultStore((s) => s.initialised);
  const resuming = useVaultStore((s) => s.resuming);
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

  // The box follows the answer, rather than only the value it had at mount. This component is on
  // screen *before* the backend has said whether this machine remembers anything — and it is also
  // the screen the settings dialog's "stop remembering it here" is clicked from. Both used to leave
  // the box saying the opposite of the truth, and a box that says "remember" while unchecked is not
  // cosmetic here: unlocking with it unchecked is what *deletes* the stored password.
  useEffect(() => {
    setRemember(remembered);
  }, [remembered]);

  // There is deliberately NO "try the remembered password" effect here, and this comment is where
  // one used to be. Mounting is the wrong trigger: this screen mounts every time the vault locks,
  // so an attempt here re-opened the vault the instant it closed — "Lock now" flashed a lock screen
  // and landed straight back inside, and an idle auto-lock did the same, which quietly made the
  // auto-lock setting do nothing at all for anyone who had asked this machine to remember.
  //
  // The remembered password is a convenience for *starting the app*, not a way around a lock. It is
  // tried once per session, from `ensureVaultStoreLoaded`.

  // No door until the app knows which one. `initialised === null` is *we have not asked yet*, and
  // `resuming` is *we asked, and the answer was that this machine opens the keyring itself* — see
  // both fields in `vaultStore`. Guessing at either produced a screen that was wrong for a moment
  // and then corrected itself: a setup form to someone who already had a keyring, or an unlock form
  // that unlocked on its own a breath later.
  if (initialised === null || resuming) {
    return <VaultBooting resuming={resuming} />;
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

/**
 * The keyring deciding where to send you.
 *
 * Two questions are in flight behind this, and it says which: whether a keyring exists here, and
 * then — when it does and this machine remembers the master password — the opening itself. Naming
 * the second one matters. A password manager that flashes *locked* and then lets itself in without
 * being asked reads as something having gone wrong, even though it is exactly what the user asked
 * for when they ticked "remember on this machine"; a line of text saying so turns the same second
 * into the app doing its job.
 *
 * No "I lost my master password" way out and no form: there is nothing here to be stuck on, and an
 * escape hatch offered mid-decision is one offered to people whose only problem is waiting.
 */
function VaultBooting({ resuming }: { resuming: boolean }) {
  const statusError = useVaultStore((s) => s.statusError);
  const t = useT();
  /** Whether this has taken long enough to be worth explaining. See below. */
  const [slow, setSlow] = useState(false);

  // Reading the credential store pops a system permission dialog on macOS the first time, and that
  // dialog can open *behind* the app window — a spinner with no explanation is indistinguishable
  // from a hang, which is what it looked like. Nothing is said for the first 1.2 s, because on the
  // ordinary path the whole thing is over well before then and a warning about a dialog that never
  // appeared is worse than silence.
  useEffect(() => {
    if (statusError) return;
    // Reset as well as arm, so a retry after a failure starts its own 1.2 s rather than showing the
    // hint the instant it is clicked.
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 1200);
    return () => window.clearTimeout(timer);
  }, [statusError]);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        {/* The same tile, in the same place, as the lock and setup screens draw their icon in: what
            follows this panel should look like it replaced one glyph, not like a different page. */}
        <div
          className={`mb-3 flex h-12 w-12 items-center justify-center rounded-xl ${
            statusError
              ? "bg-[var(--cf-danger)]/10 text-[var(--cf-danger)]"
              : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          }`}
        >
          {statusError ? <Unplug size={22} /> : <Loader2 size={22} className="animate-spin" />}
        </div>

        <h2 className="text-[15px] font-semibold text-[var(--cf-text)]">
          {t(
            statusError
              ? "vault.statusFailedTitle"
              : resuming
                ? "vault.resumingTitle"
                : "vault.checkingTitle",
          )}
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {t(
            statusError
              ? "vault.statusFailedBody"
              : resuming
                ? "vault.resumingBody"
                : "vault.checkingBody",
          )}
        </p>

        {statusError ? (
          <>
            {/* The backend's own words, kept: "it did not work" without saying what happened is not
                something anyone can act on, and this is the one failure with no door behind it. */}
            <p className="mt-2 max-w-xs break-words text-[11.5px] leading-relaxed text-[var(--cf-danger)]">
              {statusError}
            </p>
            <button
              type="button"
              onClick={() => void useVaultStore.getState().refreshStatus()}
              className={`${BUTTON} mt-4`}
            >
              {t("vault.retry")}
            </button>
          </>
        ) : (
          slow && (
            <p className="cf-fade-in mt-3 max-w-xs text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("vault.checkingSlow")}
            </p>
          )
        )}
      </div>
    </div>
  );
}
