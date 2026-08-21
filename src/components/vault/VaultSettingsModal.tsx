/**
 * The keyring's settings — and its escape hatch.
 *
 * Four things, in the order they get less reversible: how long before it locks itself, whether this
 * machine remembers the master password, changing that password, and destroying the keyring.
 *
 * **The reset is the reason this dialog exists.** A forgotten master password cannot be recovered —
 * that is the whole design, stated on the setup screen — but without a way to *replace* the vault,
 * "unrecoverable" would also mean "unreplaceable": the app would refuse to create a new keyring
 * forever, and the only way out would be a text editor and the database file. So the door exists,
 * and it is made hard to open by accident rather than hidden.
 *
 * It opens in two states. From the keyring's toolbar it shows everything. From the *lock screen*'s
 * "I have lost my master password" link the vault is locked, so the two actions that need the
 * current password are inert and only the reset is offered — which is the honest shape of that
 * moment.
 */

import { useState } from "react";
import { KeyRound, ShieldAlert, Trash2 } from "lucide-react";

import { ApiModal } from "../api/ApiModal";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";
import { useVaultStore } from "../../state/vaultStore";
import { BUTTON, BUTTON_QUIET, INPUT, passwordStrength } from "./vaultChrome";

/** Mirrors `crypto::MIN_MASTER_LENGTH`. */
const MIN_LENGTH = 10;

/** The idle windows offered. `0` is never — a real choice on a desktop that locks itself. */
const AUTOLOCK_CHOICES = [0, 5, 15, 30, 60];

export function VaultSettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const unlocked = useVaultStore((s) => s.unlocked);
  const remembered = useVaultStore((s) => s.remembered);
  const autolockMinutes = useVaultStore((s) => s.autolockMinutes);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [changing, setChanging] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** The word the user has to type to arm the reset. Compared against the translated one, so the
   *  confirmation is in the language the warning is written in. */
  const [confirmWord, setConfirmWord] = useState("");

  const resetWord = t("vault.reset.word");
  const canChange = unlocked && current.length > 0 && next.length >= MIN_LENGTH && !changing;
  const canReset = confirmWord.trim().toLowerCase() === resetWord.toLowerCase() && !resetting;

  const changePassword = async () => {
    setChanging(true);
    try {
      const ok = await useVaultStore.getState().changePassword(current, next);
      if (ok) {
        setCurrent("");
        setNext("");
        useToastStore.getState().pushToast(t("vault.passwordChanged"), "success");
      }
    } finally {
      setChanging(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const ok = await useVaultStore.getState().reset();
      if (ok) {
        useToastStore.getState().pushToast(t("vault.reset.done"), "success");
        onClose();
      }
    } finally {
      setResetting(false);
    }
  };

  return (
    <ApiModal
      icon={KeyRound}
      title={t("vault.settings")}
      width="max-w-lg"
      busy={changing || resetting}
      dismissOnBackdrop={!changing && !resetting}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        {/* ---- auto-lock ---- */}
        <section className={unlocked ? "" : "pointer-events-none opacity-40"}>
          <h3 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("vault.autolock")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {AUTOLOCK_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => void useVaultStore.getState().setAutolock(minutes)}
                className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${
                  autolockMinutes === minutes
                    ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "border-[var(--cf-border)] text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                }`}
              >
                {minutes === 0 ? t("vault.autolockNever") : t("vault.autolockMinutes", { n: minutes })}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("vault.autolockHint")}
          </p>
        </section>

        {/* ---- remembered password ---- */}
        <section>
          <h3 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("vault.remember")}
          </h3>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11.5px] text-[var(--cf-text)]">
              {t(remembered ? "vault.rememberedOn" : "vault.rememberedOff")}
            </span>
            {remembered && (
              <button
                type="button"
                onClick={() => void useVaultStore.getState().forgetPassword()}
                className={BUTTON_QUIET}
              >
                {t("vault.forgetPassword")}
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("vault.rememberHint")}
          </p>
        </section>

        {/* ---- change the master password ---- */}
        <section className={unlocked ? "" : "pointer-events-none opacity-40"}>
          <h3 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("vault.changePassword")}
          </h3>
          <div className="flex flex-col gap-2">
            <input
              type="password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              placeholder={t("vault.currentPassword")}
              autoComplete="current-password"
              className={INPUT}
            />
            <input
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              placeholder={t("vault.newPassword")}
              autoComplete="new-password"
              className={INPUT}
            />
            {next.length > 0 && (
              <div className="flex h-1 gap-1">
                {[0, 1, 2].map((step) => (
                  <span
                    key={step}
                    className={`h-1 flex-1 rounded-full ${
                      passwordStrength(next) > step
                        ? "bg-[var(--cf-accent)]"
                        : "bg-[var(--cf-border)]"
                    }`}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => void changePassword()}
              disabled={!canChange}
              className={`${BUTTON} self-start`}
            >
              {t("vault.changePassword")}
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("vault.changePasswordHint")}
          </p>
        </section>

        {/* ---- the escape hatch ---- */}
        <section className="rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-danger)]">
            <ShieldAlert size={12} />
            {t("vault.reset.title")}
          </h3>
          <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--cf-text)]">
            {t("vault.reset.body")}
          </p>
          <div className="flex items-center gap-2">
            <input
              value={confirmWord}
              onChange={(event) => setConfirmWord(event.target.value)}
              placeholder={t("vault.reset.typeWord", { word: resetWord })}
              className={INPUT}
            />
            <button
              type="button"
              onClick={() => void reset()}
              disabled={!canReset}
              className="shrink-0 rounded-md bg-[var(--cf-danger)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={12} className="mr-1 inline" />
              {resetting ? t("vault.reset.running") : t("vault.reset.action")}
            </button>
          </div>
        </section>
      </div>
    </ApiModal>
  );
}
