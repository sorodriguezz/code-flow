/**
 * «Pasar al Llavero»: one value out of a file and into the keyring, with the file left holding a
 * reference (`repo_env::edit`). Asks first — the user's rule is that a secret is never handled
 * without asking — and unlocks the keyring in place when it is locked, the way `VaultPicker` does,
 * rather than sending the user to the Llavero and back.
 *
 * The value itself never reaches this dialog: Rust reads it from the file, seals it and rewrites
 * the line in one command.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Lock } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ensureVaultStoreLoaded, useVaultStore } from "../../state/vaultStore";
import { repoEnvMoveToVault, VAULT_LOCKED, type EnvFormat } from "../../lib/tauri/envCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

const AFTER: Record<EnvFormat, TranslationKey> = {
  dotenv: "env.move.afterDotenv",
  appsettings: "env.move.afterJson",
  json: "env.move.afterJson",
  launchSettings: "env.move.afterJson",
  compose: "env.move.afterYaml",
  yaml: "env.move.afterYaml",
  properties: "env.move.afterProperties",
};

export function EnvMoveDialog({
  projectId,
  repoPath,
  repoName,
  sourceId,
  path,
  sub,
  format,
  envKey,
  onClose,
  onMoved,
}: {
  projectId: string;
  repoPath: string;
  repoName: string;
  sourceId: string;
  path: string;
  sub: string | null;
  format: EnvFormat;
  envKey: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const t = useT();
  const initialised = useVaultStore((s) => s.initialised);
  const resuming = useVaultStore((s) => s.resuming);
  const unlocked = useVaultStore((s) => s.unlocked);
  const unlocking = useVaultStore((s) => s.unlocking);
  const unlockError = useVaultStore((s) => s.unlockError);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Every door into the keyring has to start its status read — see `ensureVaultStoreLoaded`.
  useEffect(() => {
    ensureVaultStoreLoaded();
  }, []);
  const booting = initialised === null || resuming;
  useEffect(() => {
    if (!booting && !unlocked) passwordRef.current?.focus();
  }, [booting, unlocked]);

  const title = sub ? `${repoName}/${path}/${sub}/${envKey}` : `${repoName}/${path}/${envKey}`;

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await useVaultStore.getState().unlock(password, false)) setPassword("");
  };

  const move = async () => {
    setBusy(true);
    try {
      await repoEnvMoveToVault({ projectId, repoPath, sourceId, key: envKey, note: t("env.move.note", { file: path, key: envKey }) });
      pushSuccessToast(t("env.move.done", { key: envKey }));
      void useVaultStore.getState().refresh();
      onMoved();
      onClose();
    } catch (error) {
      const message = String(error);
      if (message === VAULT_LOCKED) void useVaultStore.getState().refreshStatus();
      else pushErrorToast(message.startsWith("env.") ? t(message as TranslationKey) : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal icon={KeyRound} title={t("env.move.title")} width="max-w-md" busy={busy} dismissOnBackdrop={!busy} onClose={onClose}>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {booting ? (
          <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("vault.checkingTitle")}
          </p>
        ) : !initialised ? (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("vault.pick.noVault")}</p>
        ) : !unlocked ? (
          <form onSubmit={(event) => void unlock(event)} className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
              <Lock size={13} className="text-[var(--cf-text-muted)]" />
              {t("env.move.locked")}
            </p>
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("vault.masterPassword")}
              autoComplete="current-password"
              className={fieldClass()}
            />
            {unlockError && <p className="text-[12px] text-[var(--cf-danger)]">{unlockError}</p>}
            <Button type="submit" size="sm" className="self-start" disabled={password.length === 0 || unlocking}>
              {unlocking ? t("vault.unlocking") : t("vault.unlock")}
            </Button>
          </form>
        ) : (
          <>
            <p className="text-[12.5px] leading-relaxed text-[var(--cf-text)]">{t("env.move.body", { key: envKey, file: path })}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-[var(--cf-text-muted)]">{t("env.move.entry")}</dt>
              <dd className="min-w-0 break-all font-mono text-[11.5px] text-[var(--cf-text)]">{title}</dd>
            </dl>
            <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t(AFTER[format], { key: envKey })}</p>
            <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("env.move.services")}</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void move()} disabled={busy}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                {t("env.move.confirm")}
              </Button>
            </div>
          </>
        )}
      </div>
    </ApiModal>
  );
}
