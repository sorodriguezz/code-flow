/**
 * Getting the keyring out: an encrypted CodeFlow file that imports back, or a plain-text file
 * another password manager imports.
 *
 * **The master password is asked for both.** An unlocked window is not consent to put every password
 * in a file — Bitwarden asks for its own exports for the same reason — and it is checked the only
 * way this vault checks it, by unwrapping the data key (see `keyvault::export`).
 *
 * The plain-text side is made deliberately heavier: a danger button, a box to tick, and the list of
 * what it cannot carry *before* the file exists, counted from this keyring. Nothing leaves the
 * backend in the clear — it writes the file itself, where the save dialog pointed.
 */

import { useMemo, useState } from "react";
import { FileDown, ShieldAlert } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";

import { ApiModal } from "../api/ApiModal";
import { Segmented } from "../common/Segmented";
import { buttonClass } from "../common/Button";
import { keyvaultExport, type VaultExportFormat } from "../../lib/tauri/keyvaultCommands";
import { vaultErrorKey } from "../../lib/vault/errors";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useVaultStore } from "../../state/vaultStore";
import { BUTTON, BUTTON_QUIET, INPUT } from "./vaultChrome";

/** Mirrors `crypto::MIN_MASTER_LENGTH`, which the export passphrase is held to as well. */
const MIN_LENGTH = 10;

const EXTENSION: Record<VaultExportFormat, string> = {
  codeflow: "cfkeyring",
  "bitwarden-json": "json",
  "bitwarden-csv": "csv",
};

export function VaultExportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const items = useVaultStore((s) => s.items);
  const [mode, setMode] = useState<"encrypted" | "plain">("encrypted");
  const [plainFormat, setPlainFormat] = useState<"bitwarden-json" | "bitwarden-csv">("bitwarden-json");
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [master, setMaster] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  // What the plain-text file will not carry, counted from what is loaded — the list the backend
  // reports afterwards, said before the file exists.
  const lost = useMemo(
    () => ({
      attachments: items.reduce((sum, item) => sum + item.attachments, 0),
      tagged: items.filter((item) => item.tags.length > 0).length,
      flattened: items.filter((item) => ["key", "storage", "file"].includes(item.kind)).length,
    }),
    [items],
  );

  const format: VaultExportFormat = mode === "encrypted" ? "codeflow" : plainFormat;
  const ready =
    master.length > 0 &&
    (mode === "encrypted" ? passphrase.length >= MIN_LENGTH && passphrase === repeat : understood);

  const run = async () => {
    setError("");
    const path = await save({
      defaultPath: `keyring.${EXTENSION[format]}`,
      filters: [{ name: format === "codeflow" ? "CodeFlow" : "Bitwarden", extensions: [EXTENSION[format]] }],
    }).catch(() => null);
    if (!path) return;
    setRunning(true);
    try {
      const summary = await keyvaultExport(path, format, master, mode === "encrypted" ? passphrase : null);
      useToastStore
        .getState()
        .pushToast(t("vault.export.done", { n: summary.items, files: summary.attachments }), "success");
      onClose();
    } catch (failure) {
      const key = vaultErrorKey(failure);
      if (key) setError(t(key));
      else pushErrorToast(String(failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <ApiModal
      icon={FileDown}
      title={t("vault.export.title")}
      width="max-w-lg"
      busy={running}
      dismissOnBackdrop={!running}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running} className={BUTTON_QUIET}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!ready || running}
            className={mode === "encrypted" ? BUTTON : buttonClass({ variant: "danger", size: "sm" })}
          >
            {running ? t("vault.export.running") : mode === "encrypted" ? t("vault.export.run") : t("vault.export.runPlain")}
          </button>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <Segmented
          size="sm"
          full
          layoutId="vault-export-mode"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setError("");
          }}
          options={[
            { value: "encrypted", label: t("vault.export.encrypted"), title: t("vault.export.encryptedHint") },
            { value: "plain", label: t("vault.export.plain"), title: t("vault.export.plainHint") },
          ]}
        />

        {mode === "encrypted" ? (
          <>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={t("vault.export.passphrase")}
              aria-label={t("vault.export.passphrase")}
              title={t("vault.export.passphraseHint", { n: MIN_LENGTH })}
              autoComplete="new-password"
              className={INPUT}
            />
            <input
              type="password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              placeholder={t("vault.export.repeat")}
              aria-label={t("vault.export.repeat")}
              autoComplete="new-password"
              className={INPUT}
            />
            {repeat.length > 0 && repeat !== passphrase && (
              <p className="text-[11.5px] text-[var(--cf-warning)]">{t("vault.export.mismatch")}</p>
            )}
          </>
        ) : (
          <>
            <Segmented
              size="sm"
              layoutId="vault-export-plain-format"
              value={plainFormat}
              onChange={setPlainFormat}
              options={[
                { value: "bitwarden-json", label: "JSON" },
                { value: "bitwarden-csv", label: "CSV" },
              ]}
            />
            <div className="space-y-1.5 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/10 px-3 py-2 text-[12px] leading-relaxed text-[var(--cf-text)]">
              <p className="flex items-start gap-2 font-medium">
                <ShieldAlert size={14} className="mt-[2px] shrink-0 text-[var(--cf-danger)]" />
                {t("vault.export.plainWarning")}
              </p>
              <ul className="list-disc space-y-0.5 pl-9 text-[var(--cf-text-muted)]">
                <li>{t("vault.export.lostAttachments", { n: lost.attachments })}</li>
                <li>{t("vault.export.lostTags", { n: lost.tagged })}</li>
                <li>{t("vault.export.lostKinds", { n: lost.flattened })}</li>
                <li>{t("vault.export.lostFiling")}</li>
              </ul>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
              <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
              {t("vault.export.understood")}
            </label>
          </>
        )}

        <input
          type="password"
          value={master}
          onChange={(event) => {
            setMaster(event.target.value);
            setError("");
          }}
          placeholder={t("vault.export.master")}
          aria-label={t("vault.export.master")}
          autoComplete="current-password"
          className={INPUT}
        />
        {error && <p className="text-[11.5px] text-[var(--cf-danger)]">{error}</p>}
      </div>
    </ApiModal>
  );
}
