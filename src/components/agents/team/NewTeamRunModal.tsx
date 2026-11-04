import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Plus, Users } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../../api/ApiModal";
import { Note } from "../../api/settingsChrome";
import { Select } from "../../common/Select";
import { fieldClass } from "../../common/recipes";
import { Field as Labeled } from "../../settings/modelPicker";
import { listBranches } from "../../../lib/tauri/commands";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useT } from "../../../state/languageStore";
import type { Team, TeamPolicy } from "../../../types/team";
import { Chip, PolicyEditor, TeamEditorModal } from "./TeamEditorModal";

let lastTeamId = "";

/**
 * «Nueva tarea de equipo»: one goal for a team, across one repository or several, each landing on the
 * branch picked here. The team's rules apply as saved unless they are adjusted for this run only.
 */
export function NewTeamRunModal({ initialProjectId, onClose }: { initialProjectId?: string; onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? "";
  const projects = useWorkspaceStore((s) => (workspaceId ? (s.projectsByWorkspace[workspaceId] ?? []) : []));
  const teams = useTeamStore((s) => s.teams);
  const roster = useAgentsStore((s) => s.roster);
  const [teamId, setTeamId] = useState(() => (teams.some((x) => x.id === lastTeamId) ? lastTeamId : (teams[0]?.id ?? "")));
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [repos, setRepos] = useState<string[]>(() => {
    const first = projects.find((p) => p.id === initialProjectId) ?? projects[0];
    return first ? [first.id] : [];
  });
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, { name: string; head: boolean }[]>>({});
  const [override, setOverride] = useState<TeamPolicy | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideTab, setOverrideTab] = useState<"permissions" | "git" | "review" | "limits">("permissions");
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const team = teams.find((x) => x.id === teamId) ?? null;
  useEffect(() => {
    if (!teamId && teams[0]) setTeamId(teams[0].id);
  }, [teams, teamId]);
  useEffect(() => setOverride(null), [teamId]);

  // Local branches of every chosen repository, for its target.
  useEffect(() => {
    for (const id of repos) {
      if (branches[id]) continue;
      const project = projects.find((p) => p.id === id);
      if (!project) continue;
      void listBranches(project.local_path)
        .then((list) => setBranches((b) => ({ ...b, [id]: list.filter((x) => !x.is_remote).map((x) => ({ name: x.name, head: x.is_head })) })))
        .catch(() => setBranches((b) => ({ ...b, [id]: [] })));
    }
  }, [repos, projects, branches]);

  const policy = override ?? team?.policy ?? null;
  const ready = !!team && goal.trim().length > 0 && repos.length > 0;

  const start = async () => {
    if (!team || !ready || busy) return;
    setBusy(true);
    lastTeamId = team.id;
    const id = await useTeamStore.getState().start({
      teamId: team.id,
      goal: goal.trim(),
      title: title.trim() || undefined,
      repos: repos.map((projectId) => ({ projectId, targetBranch: targets[projectId] ?? "" })),
      policy: override,
    });
    setBusy(false);
    if (id) onClose();
  };

  if (editing) {
    return (
      <TeamEditorModal
        team={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setTeamId(saved.id);
          setOverride(null);
        }}
      />
    );
  }

  return (
    <ApiModal
      icon={Users}
      title={t("team.runTitle")}
      subtitle={t("team.runSubtitle")}
      width="max-w-2xl"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void start()} disabled={!ready || busy}>
            {t("team.runStart")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {teams.length === 0 ? (
          <div className="space-y-2">
            <Note>{t("team.noTeams")}</Note>
            <PrimaryButton onClick={() => setEditing("new")}>
              <Plus size={13} />
              {t("team.newTitle")}
            </PrimaryButton>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Labeled label={t("team.team")}>
                <Select
                  size="field"
                  value={teamId}
                  onChange={setTeamId}
                  options={teams.map((x) => ({ value: x.id, label: `${x.name} · ${x.members.length} ${t("team.membersCount")}` }))}
                />
              </Labeled>
            </div>
            {team && (
              <GhostButton onClick={() => setEditing(team)}>
                <Pencil size={13} />
                {t("common.edit")}
              </GhostButton>
            )}
            <GhostButton onClick={() => setEditing("new")}>
              <Plus size={13} />
              {t("team.new")}
            </GhostButton>
          </div>
        )}
        {team && (
          <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {team.lead
              ? t("team.ledBy", { name: team.members.find((m) => m.id === team.lead)?.name || "—" })
              : t("team.fixedPlanSteps", { n: String(team.plan.length) })}
            {" · "}
            {team.members.map((m) => m.name || roster.find((a) => a.id === m.agent_id)?.name).join(", ")}
          </p>
        )}

        <Labeled label={t("team.goal")}>
          <textarea
            autoFocus
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void start();
              }
            }}
            placeholder={t("team.goalPlaceholder")}
            className={fieldClass({ className: "h-auto w-full resize-y py-2 leading-relaxed" })}
          />
        </Labeled>
        <Labeled label={t("team.runName")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("team.runNamePlaceholder")} className={fieldClass({ className: "w-full" })} />
        </Labeled>

        <Labeled label={t("team.repos")} hint={t("team.reposHint")}>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <Chip key={p.id} active={repos.includes(p.id)} onClick={() => setRepos((r) => (r.includes(p.id) ? r.filter((x) => x !== p.id) : [...r, p.id]))}>
                {p.name}
              </Chip>
            ))}
          </div>
        </Labeled>
        {repos.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
            {repos.map((id) => {
              const project = projects.find((p) => p.id === id);
              const list = branches[id] ?? [];
              const head = list.find((b) => b.head)?.name ?? "";
              return (
                <div key={id} className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
                  <span className="truncate text-[12.5px]">{project?.name}</span>
                  <Select
                    value={targets[id] ?? ""}
                    onChange={(v) => setTargets((x) => ({ ...x, [id]: v }))}
                    ariaLabel={t("team.targetBranch")}
                    options={[
                      { value: "", label: t("team.targetCurrent", { branch: head || "HEAD" }) },
                      ...list.filter((b) => !b.head).map((b) => ({ value: b.name, label: b.name })),
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}

        {team && policy && (
          <div className="rounded-lg border border-[var(--cf-border)]">
            <button type="button" onClick={() => setOverrideOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[12.5px]">
              {overrideOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t("team.overrideTitle")}
              {override && <span className="ml-auto text-[11px] text-[var(--cf-accent)]">{t("team.overridden")}</span>}
            </button>
            {overrideOpen && (
              <div className="space-y-3 border-t border-[var(--cf-border)] px-3 py-3">
                <div className="flex gap-1">
                  {(["permissions", "git", "review", "limits"] as const).map((tab) => (
                    <Chip key={tab} active={overrideTab === tab} onClick={() => setOverrideTab(tab)}>
                      {t(tab === "permissions" ? "team.tabPermissions" : tab === "git" ? "team.tabGit" : tab === "review" ? "team.tabReview" : "team.tabLimits")}
                    </Chip>
                  ))}
                  {override && (
                    <button type="button" onClick={() => setOverride(null)} className="ml-auto text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
                      {t("team.overrideReset")}
                    </button>
                  )}
                </div>
                <PolicyEditor
                  tab={overrideTab}
                  policy={policy}
                  members={team.members}
                  roster={roster}
                  projects={projects.filter((p) => repos.includes(p.id))}
                  onPatch={(p) => setOverride({ ...policy, ...p })}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </ApiModal>
  );
}
