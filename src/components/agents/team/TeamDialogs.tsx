import { useState } from "react";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../../api/ApiModal";
import { useTeamStore } from "../../../state/teamStore";
import { useT } from "../../../state/languageStore";
import type { Team } from "../../../types/team";
import { NewTeamRunModal } from "./NewTeamRunModal";
import { TeamEditorModal } from "./TeamEditorModal";

/** The team dialogs, opened from anywhere through `teamStore.dialog`. Mounted once by the Agents view. */
export function TeamDialogs() {
  const dialog = useTeamStore((s) => s.dialog);
  const close = () => useTeamStore.setState({ dialog: null });
  if (!dialog) return null;
  if (dialog.kind === "run") return <NewTeamRunModal initialProjectId={dialog.projectId} onClose={close} />;
  return <TeamsManager onClose={close} />;
}

function TeamsManager({ onClose }: { onClose: () => void }) {
  const t = useT();
  const teams = useTeamStore((s) => s.teams);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  if (editing) return <TeamEditorModal team={editing === "new" ? null : editing} onClose={() => setEditing(null)} />;
  return (
    <ApiModal
      icon={Users}
      title={t("team.manageTitle")}
      subtitle={t("team.editorHint")}
      width="max-w-lg"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
          <PrimaryButton onClick={() => setEditing("new")}>
            <Plus size={13} />
            {t("team.newTitle")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
        {teams.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("team.noTeams")}</p>}
        {teams.map((team) => (
          <div key={team.id} className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium">{team.name}</p>
              <p className="truncate text-[11px] text-[var(--cf-text-muted)]">
                {team.members.map((m) => m.name).join(", ")}
                {team.lead ? ` · ${t("team.ledBy", { name: team.members.find((m) => m.id === team.lead)?.name ?? "—" })}` : ` · ${t("team.noLead")}`}
              </p>
            </div>
            <button type="button" onClick={() => setEditing(team)} title={t("common.edit")} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t("team.deleteTeamConfirm", { name: team.name }))) void useTeamStore.getState().deleteTeam(team.id);
              }}
              title={t("common.delete")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </ApiModal>
  );
}
