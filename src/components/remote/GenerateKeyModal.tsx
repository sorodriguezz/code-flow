import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { remoteGenerateKey } from "../../lib/tauri/remoteCommands";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";
import type { SshKey } from "../../types/remote";

/**
 * A new ed25519 key, made by `ssh-keygen` into `~/.ssh` — the step that used to mean a trip to a
 * terminal before a host could be given a key at all.
 *
 * Three fields and no choices: ed25519 is the type every current server takes and the one to
 * recommend; the name is the file (the backend refuses one that exists, so nothing is ever
 * overwritten); the passphrase may be empty, which `ssh-keygen` allows too. The key is the user's,
 * in `~/.ssh`, exactly as if they had typed the command — see `remotes::keys`.
 */
export function GenerateKeyModal({
  suggestedName,
  onCreated,
  onClose,
}: {
  suggestedName: string;
  onCreated: (key: SshKey) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(suggestedName);
  const [passphrase, setPassphrase] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = await remoteGenerateKey(name.trim(), passphrase, comment.trim());
      useToastStore.getState().pushToast(t("remote.generateKeyDone", { path: key.path }), "success");
      onCreated(key);
      onClose();
    } catch (failure) {
      // In the dialog, beside the name it is most likely about: "already exists" is the usual one.
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={KeyRound}
      title={t("remote.generateKeyTitle")}
      subtitle="ssh-keygen -t ed25519"
      width="max-w-md"
      busy={busy}
      // A half-typed passphrase is not something a stray click should throw away.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void generate()} disabled={busy || !name.trim()}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("remote.generateKeyCreate")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <label className="block space-y-1">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.generateKeyName")}</span>
          <Field value={name} onChange={setName} mono />
          <span className="block text-[11px] text-[var(--cf-text-muted)]">{t("remote.generateKeyNameHint")}</span>
        </label>
        <label className="block space-y-1">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.generateKeyPassphrase")}</span>
          <Field type="password" value={passphrase} onChange={setPassphrase} mono />
          <span className="block text-[11px] text-[var(--cf-text-muted)]">
            {t("remote.generateKeyPassphraseHint")}
          </span>
        </label>
        <label className="block space-y-1">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.generateKeyComment")}</span>
          <Field value={comment} onChange={setComment} mono placeholder="user@machine" />
        </label>
        {error && (
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-danger)]">{error}</p>
        )}
      </div>
    </ApiModal>
  );
}
