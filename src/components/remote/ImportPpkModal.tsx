import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Segmented } from "../common/Segmented";
import { remoteImportPpk, type ImportedPpk } from "../../lib/tauri/remoteCommands";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * A PuTTY key (`.ppk`) made usable by the `ssh` this app runs, which cannot read one: unlocked with
 * its passphrase and either handed to the SSH agent (nothing written to disk) or written beside
 * itself as an OpenSSH key — without a passphrase, which the second choice says.
 */
export function ImportPpkModal({
  path,
  onDone,
  onClose,
}: {
  path: string;
  onDone: (imported: ImportedPpk) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [passphrase, setPassphrase] = useState("");
  const [target, setTarget] = useState<"agent" | "file">("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const imported = await remoteImportPpk(path, passphrase, target === "agent");
      useToastStore
        .getState()
        .pushToast(imported.path ? t("remote.ppkWritten", { path: imported.path }) : t("remote.ppkInAgent", { comment: imported.comment || imported.algorithm }), "success");
      onDone(imported);
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={KeyRound}
      title={t("remote.ppkTitle")}
      subtitle={path}
      width="max-w-md"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void run()} disabled={busy}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("remote.ppkConvert")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("remote.ppkExplain")}</p>
        <label className="block space-y-1">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.ppkPassphrase")}</span>
          <Field type="password" value={passphrase} onChange={setPassphrase} mono />
        </label>
        <Segmented<"agent" | "file">
          size="sm"
          value={target}
          onChange={setTarget}
          layoutId="cf-ppk-target"
          full
          options={[
            { value: "agent", label: t("remote.ppkToAgent") },
            { value: "file", label: t("remote.ppkToFile") },
          ]}
        />
        <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{target === "agent" ? t("remote.ppkToAgentHint") : t("remote.ppkToFileHint")}</p>
        {error && <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-danger)]">{error}</p>}
      </div>
    </ApiModal>
  );
}
