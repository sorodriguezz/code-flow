import { useState } from "react";
import { FolderInput, Settings, Users } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { Note } from "./settingsChrome";
import { Select } from "../common/Select";
import { useImportCollaborative } from "./CollaborationPanel";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";

/**
 * Accepting an invitation, from inside the API client.
 *
 * Import lives here and sharing does not, on purpose. Someone who was handed a code needs one box
 * to paste it into and one choice to make — which workspace — and that is a dialog. Sharing is the
 * opposite: it is a decision about the whole setup (which Supabase project, what is already shared
 * from where, who still holds a code), so it belongs in the collaboration settings, where all of
 * that is on screen at once. The tree's "share this collection" goes there.
 */
export function CollabModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const importCollaborative = useImportCollaborative();

  const [code, setCode] = useState("");
  const [target, setTarget] = useState(activeWorkspaceId ?? "");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      if (await importCollaborative(code, target)) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Users}
      title={t("api.collab.joinTitle")}
      subtitle={t("api.collab.modalSubtitle")}
      width="max-w-lg"
      busy={busy}
      onClose={onClose}
      toolbar={
        <GhostButton
          onClick={() => {
            onClose();
            useUiStore.getState().openApiSettings("collab");
          }}
          title={t("api.collab.openSettings")}
        >
          <Settings size={12} />
        </GhostButton>
      }
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">
            {t("api.collab.shareFromSettings")}
          </span>
          <PrimaryButton onClick={() => void run()} disabled={busy || code.trim() === "" || target === ""}>
            <FolderInput size={13} />
            {busy ? t("api.collab.importing") : t("api.collab.join")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <Note>{t("api.collab.joinHint")}</Note>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
            {t("api.collab.invitationCode")}
          </span>
          <textarea
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("api.collab.joinPlaceholder")}
            rows={3}
            className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
            {t("api.collab.pickWorkspace")}
          </span>
          <Select
            value={target}
            onChange={setTarget}
            placeholder={t("api.collab.pickWorkspace")}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </label>
      </div>
    </ApiModal>
  );
}
