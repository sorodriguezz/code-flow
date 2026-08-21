/**
 * Bringing a keyring across from Bitwarden or 1Password.
 *
 * **Nothing is written until Import is pressed**, and what will be written is on screen first: the
 * format that was recognised, how many entries and folders, and every warning the parser produced.
 * An import that silently drops eleven entries is the failure this screen exists to prevent, and
 * the way to prevent it is to say so before rather than after.
 *
 * The last thing it says is the one people forget: **an unencrypted export is your whole vault in
 * plain text on the disk.** It is shown after a successful import, when there is finally something
 * to do about it.
 */

import { useState } from "react";
import { FileUp, ShieldAlert, Upload } from "lucide-react";

import { ApiModal } from "../api/ApiModal";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import { keyvaultReadImportFile } from "../../lib/tauri/keyvaultCommands";
import { importVaultExport, type ImportFormat, type ImportResult } from "../../lib/vault/import";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useVaultStore } from "../../state/vaultStore";
import { BUTTON, BUTTON_QUIET } from "./vaultChrome";

/** The extensions the picker offers. `1pux` is a zip; the backend sniffs the magic anyway. */
const EXTENSIONS = ["json", "csv", "1pux"];

const FORMAT_LABELS: Record<ImportFormat, string> = {
  "bitwarden-json": "vault.import.formatBitwardenJson",
  "bitwarden-csv": "vault.import.formatBitwardenCsv",
  "onepassword-csv": "vault.import.formatOnePasswordCsv",
  "onepassword-1pux": "vault.import.formatOnePux",
  unknown: "vault.import.formatUnknown",
};

export function VaultImportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [done, setDone] = useState(false);

  const choose = async () => {
    setReading(true);
    try {
      const path = await apiPickFile(EXTENSIONS);
      if (!path) return;
      // The keyring's own reader, not `apiReadTextFile`: it caps the size and it unpacks a `.1pux`,
      // which is a zip and unreadable from here — there is no zip reader on this side.
      const text = await keyvaultReadImportFile(path);
      const name = path.split(/[\\/]/).pop() ?? "";
      setFileName(name);
      setResult(importVaultExport(text, name));
      setDone(false);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setReading(false);
    }
  };

  const run = async () => {
    if (!result || result.items.length === 0) return;
    setRunning(true);
    try {
      const imported = await useVaultStore.getState().runImport(result);
      useToastStore.getState().pushToast(t("vault.import.done", { n: imported }), "success");
      setDone(true);
    } finally {
      setRunning(false);
    }
  };

  const items = result?.items.length ?? 0;
  const folders = result?.folders.length ?? 0;

  return (
    <ApiModal
      icon={FileUp}
      title={t("vault.import.title")}
      subtitle={t("vault.import.body")}
      width="max-w-xl"
      busy={running}
      dismissOnBackdrop={!running}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running} className={BUTTON_QUIET}>
            {t("vault.hide")}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || items === 0 || done}
            className={BUTTON}
          >
            <Upload size={12} className="mr-1 inline" />
            {running ? t("vault.import.running") : t("vault.import.run", { n: items })}
          </button>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void choose()} disabled={reading} className={BUTTON_QUIET}>
            {reading ? t("vault.import.reading") : t("vault.import.chooseFile")}
          </button>
          {fileName && (
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">
              {fileName}
            </span>
          )}
        </div>

        {result && (
          <>
            <dl className="flex flex-col gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-3 py-2 text-[12px]">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--cf-text-muted)]">{t("vault.import.format")}</dt>
                <dd className="text-[var(--cf-text)]">{t(FORMAT_LABELS[result.format] as never)}</dd>
              </div>
              {items > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--cf-text-muted)]">{t("vault.allItems")}</dt>
                  <dd className="text-[var(--cf-text)]">
                    {folders > 0
                      ? t("vault.import.summary", { items, folders })
                      : t("vault.import.summaryNoFolders", { items })}
                  </dd>
                </div>
              )}
            </dl>

            {items === 0 && result.format !== "unknown" && (
              <p className="text-[12px] text-[var(--cf-text-muted)]">{t("vault.import.nothing")}</p>
            )}

            {/* Every warning, always shown rather than folded away. This is the screen where a
                dropped entry has to be visible before the import, not discovered after it. */}
            {result.warnings.length > 0 && (
              <section>
                <h3 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("vault.import.warnings")}
                </h3>
                <ul className="flex flex-col gap-1">
                  {result.warnings.map((warning, at) => (
                    <li
                      key={`${warning.key}-${at}`}
                      className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]"
                    >
                      <ShieldAlert size={12} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
                      <span>{t(warning.key, warning.params)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Only once there is something to delete. Said at the end because that is when it is
                actionable — and it is the step people skip. */}
            {done && (
              <p className="flex items-start gap-2 rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--cf-text)]">
                <ShieldAlert size={14} className="mt-[1px] shrink-0 text-[var(--cf-warning)]" />
                <span>{t("vault.import.deleteTheFile")}</span>
              </p>
            )}
          </>
        )}
      </div>
    </ApiModal>
  );
}
