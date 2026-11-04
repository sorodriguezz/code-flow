import { useMemo, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../../api/ApiModal";
import { Note } from "../../api/settingsChrome";
import { Checkbox } from "../../common/Checkbox";
import { Select } from "../../common/Select";
import { fieldClass } from "../../common/recipes";
import { Field as Labeled } from "../../settings/modelPicker";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { hasCli } from "../../../lib/agents/cliLaunch";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useT } from "../../../state/languageStore";
import type { TranslationKey } from "../../../lib/i18n/translations";
import {
  applyPreset,
  emptyMember,
  emptyTeam,
  presetOf,
  type Team,
  type TeamMember,
  type TeamPlanStep,
  type TeamPolicy,
} from "../../../types/team";
import type { Project, WorkspaceAgent } from "../../../types/domain";

type Tab = "members" | "lead" | "permissions" | "git" | "review" | "limits";
const TABS: { id: Tab; key: TranslationKey }[] = [
  { id: "members", key: "team.tabMembers" },
  { id: "lead", key: "team.tabLead" },
  { id: "permissions", key: "team.tabPermissions" },
  { id: "git", key: "team.tabGit" },
  { id: "review", key: "team.tabReview" },
  { id: "limits", key: "team.tabLimits" },
];

const inputClass = fieldClass({ className: "w-full" });
const smallInput = fieldClass({ size: "sm", className: "w-full" });

/**
 * Create or edit a team: who is in it, who leads (or the fixed plan when nobody does), and every
 * rule of the policy. Nothing here is fixed: members are any roster agents with any role, the lead
 * is any member or none, and each policy field stands on its own.
 */
export function TeamEditorModal({ team, onClose, onSaved }: { team: Team | null; onClose: () => void; onSaved?: (team: Team) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? "";
  const projects = useWorkspaceStore((s) => (workspaceId ? (s.projectsByWorkspace[workspaceId] ?? []) : []));
  const roster = useAgentsStore((s) => s.roster);
  const [draft, setDraft] = useState<Team>(() => (team ? structuredClone(team) : emptyTeam(workspaceId)));
  const [tab, setTab] = useState<Tab>("members");
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<Team>) => setDraft((d) => ({ ...d, ...p }));
  const patchPolicy = (p: Partial<TeamPolicy>) => setDraft((d) => ({ ...d, policy: { ...d.policy, ...p } }));
  const patchMember = (id: string, p: Partial<TeamMember>) =>
    setDraft((d) => ({ ...d, members: d.members.map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  const problems = useMemo(() => {
    const out: TranslationKey[] = [];
    if (!draft.name.trim()) out.push("team.needName");
    if (draft.members.length === 0) out.push("team.needMembers");
    if (draft.members.some((m) => !m.agent_id)) out.push("team.needAgent");
    if (!draft.lead && draft.plan.filter((s) => s.instruction.trim() && s.member).length === 0) out.push("team.needPlan");
    return out;
  }, [draft]);

  const save = async () => {
    setSaving(true);
    const saved = await useTeamStore.getState().saveTeam(draft);
    setSaving(false);
    if (saved) {
      onSaved?.(saved);
      onClose();
    }
  };

  return (
    <ApiModal
      icon={Users}
      title={t(team ? "team.editTitle" : "team.newTitle")}
      subtitle={t("team.editorHint")}
      width="max-w-3xl"
      height="h-[80vh]"
      busy={saving}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-[var(--cf-text-muted)]">{problems.length > 0 ? t(problems[0]) : ""}</span>
          <GhostButton onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={saving || problems.length > 0}>
            {t("common.save")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid grid-cols-[1fr_2fr] gap-3 border-b border-[var(--cf-border)] px-4 py-3">
          <Labeled label={t("team.name")}>
            <input autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder={t("team.namePlaceholder")} className={inputClass} />
          </Labeled>
          <Labeled label={t("team.description")}>
            <input value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder={t("team.descriptionPlaceholder")} className={inputClass} />
          </Labeled>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-[var(--cf-border)] px-3 py-1.5">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setTab(x.id)}
              className={`h-7 rounded-md px-2.5 text-[12px] transition-colors ${
                tab === x.id ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
              }`}
            >
              {t(x.key)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === "members" && (
            <MembersTab
              members={draft.members}
              roster={roster}
              projects={projects}
              onAdd={() => patch({ members: [...draft.members, emptyMember()] })}
              onRemove={(id) =>
                patch({
                  members: draft.members.filter((m) => m.id !== id),
                  lead: draft.lead === id ? "" : draft.lead,
                  plan: draft.plan.filter((s) => s.member !== id),
                })
              }
              onPatch={patchMember}
            />
          )}
          {tab === "lead" && <LeadTab draft={draft} projects={projects} onPatch={patch} />}
          {tab !== "members" && tab !== "lead" && <PolicyEditor tab={tab} policy={draft.policy} members={draft.members} roster={roster} projects={projects} onPatch={patchPolicy} />}
        </div>
      </div>
    </ApiModal>
  );
}

function agentLabel(agent: WorkspaceAgent | undefined): string {
  return agent ? `${agent.name}${agent.model ? ` · ${agent.model}` : ""}${agent.effort ? ` · ${agent.effort}` : ""}` : "";
}

function MembersTab({
  members,
  roster,
  projects,
  onAdd,
  onRemove,
  onPatch,
}: {
  members: TeamMember[];
  roster: WorkspaceAgent[];
  projects: Project[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, p: Partial<TeamMember>) => void;
}) {
  const t = useT();
  const runnable = roster.filter((a) => a.enabled && a.provider && a.model);
  return (
    <div className="space-y-2.5">
      {runnable.length === 0 && <Note tone="warning">{t("team.noRoster")}</Note>}
      {members.map((m) => {
        const agent = roster.find((a) => a.id === m.agent_id);
        const cli = agent ? hasCli(agent.provider) : false;
        return (
          <div key={m.id} className="space-y-2 rounded-lg border border-[var(--cf-border)] p-2.5">
            <div className="grid grid-cols-[1.4fr_1fr_1.6fr_auto] items-end gap-2">
              <Labeled label={t("team.memberAgent")}>
                <Select
                  size="field"
                  value={m.agent_id}
                  onChange={(agentId) => {
                    const a = roster.find((x) => x.id === agentId);
                    onPatch(m.id, {
                      agent_id: agentId,
                      name: m.name || a?.name || "",
                      role: m.role || a?.role || "",
                      run_in: a && !hasCli(a.provider) ? "headless" : m.run_in,
                    });
                  }}
                  options={[
                    { value: "", label: t("team.pickAgent") },
                    ...runnable.map((a) => ({ value: a.id, label: agentLabel(a), leading: <ProviderGlyph providerId={a.provider} size={13} /> })),
                  ]}
                />
              </Labeled>
              <Labeled label={t("team.memberName")}>
                <input value={m.name} onChange={(e) => onPatch(m.id, { name: e.target.value })} placeholder={agent?.name ?? ""} className={inputClass} />
              </Labeled>
              <Labeled label={t("team.memberRole")}>
                <input value={m.role} onChange={(e) => onPatch(m.id, { role: e.target.value })} placeholder={t("team.memberRolePlaceholder")} className={inputClass} />
              </Labeled>
              <button
                type="button"
                onClick={() => onRemove(m.id)}
                title={t("common.delete")}
                className="mb-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <Labeled label={t("team.memberEdits")}>
                <Select
                  size="field"
                  value={m.edits ? "yes" : "no"}
                  onChange={(v) => onPatch(m.id, { edits: v === "yes" })}
                  options={[
                    { value: "yes", label: t("team.editsYes") },
                    { value: "no", label: t("team.editsNo") },
                  ]}
                />
              </Labeled>
              <Labeled label={t("team.memberRunIn")}>
                <Select
                  size="field"
                  value={m.run_in}
                  onChange={(v) => onPatch(m.id, { run_in: v as TeamMember["run_in"] })}
                  options={[
                    { value: "headless", label: t("team.runHeadless") },
                    ...(cli ? [{ value: "terminal", label: t("team.runTerminal") }] : []),
                  ]}
                />
              </Labeled>
              <Labeled label={t("team.memberParallel")}>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={m.max_parallel}
                  onChange={(e) => onPatch(m.id, { max_parallel: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
                  className={inputClass}
                />
              </Labeled>
              <Labeled label={t("team.memberEscalate")}>
                <Select
                  size="field"
                  value={m.escalate_to}
                  onChange={(v) => onPatch(m.id, { escalate_to: v })}
                  options={[{ value: "", label: t("team.nobody") }, ...members.filter((o) => o.id !== m.id).map((o) => ({ value: o.id, label: o.name || t("team.unnamed") }))]}
                />
              </Labeled>
            </div>
            {projects.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("team.memberRepos")}</span>
                <Chip active={m.repos.length === 0} onClick={() => onPatch(m.id, { repos: [] })}>
                  {t("team.allRepos")}
                </Chip>
                {projects.map((p) => (
                  <Chip
                    key={p.id}
                    active={m.repos.includes(p.id)}
                    onClick={() => onPatch(m.id, { repos: m.repos.includes(p.id) ? m.repos.filter((r) => r !== p.id) : [...m.repos, p.id] })}
                  >
                    {p.name}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <GhostButton onClick={onAdd}>
        <Plus size={13} />
        {t("team.addMember")}
      </GhostButton>
    </div>
  );
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-6 rounded-full border px-2 text-[11.5px] transition-colors ${
        active ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

function LeadTab({ draft, projects, onPatch }: { draft: Team; projects: Project[]; onPatch: (p: Partial<Team>) => void }) {
  const t = useT();
  const setStep = (at: number, p: Partial<TeamPlanStep>) => onPatch({ plan: draft.plan.map((s, i) => (i === at ? { ...s, ...p } : s)) });
  return (
    <div className="space-y-3">
      <Labeled label={t("team.lead")} hint={t(draft.lead ? "team.leadHint" : "team.fixedPlanHint")}>
        <Select
          size="field"
          value={draft.lead}
          onChange={(lead) => onPatch({ lead })}
          options={[{ value: "", label: t("team.noLead") }, ...draft.members.map((m) => ({ value: m.id, label: m.name || t("team.unnamed") }))]}
        />
      </Labeled>
      {!draft.lead && (
        <div className="space-y-2">
          {draft.plan.map((step, at) => (
            <div key={at} className="space-y-2 rounded-lg border border-[var(--cf-border)] p-2.5">
              <div className="grid grid-cols-[0.8fr_1.2fr_1fr_1fr_auto] items-end gap-2">
                <Labeled label={t("team.stepKey")}>
                  <input value={step.key} onChange={(e) => setStep(at, { key: e.target.value })} placeholder={`p${at + 1}`} className={smallInput} />
                </Labeled>
                <Labeled label={t("team.stepMember")}>
                  <Select
                    value={step.member}
                    onChange={(member) => setStep(at, { member })}
                    options={[{ value: "", label: t("team.pickMember") }, ...draft.members.map((m) => ({ value: m.id, label: m.name || t("team.unnamed") }))]}
                  />
                </Labeled>
                <Labeled label={t("team.stepRepo")}>
                  <Select
                    value={step.repo}
                    onChange={(repo) => setStep(at, { repo })}
                    options={[{ value: "", label: t("team.firstRepo") }, { value: "*", label: t("team.eachRepo") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                  />
                </Labeled>
                <Labeled label={t("team.stepKind")}>
                  <Select
                    value={step.kind}
                    onChange={(kind) => setStep(at, { kind: kind as TeamPlanStep["kind"] })}
                    options={[
                      { value: "work", label: t("team.kindWork") },
                      { value: "investigate", label: t("team.kindInvestigate") },
                    ]}
                  />
                </Labeled>
                <button
                  type="button"
                  onClick={() => onPatch({ plan: draft.plan.filter((_, i) => i !== at) })}
                  className="mb-0.5 flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                rows={2}
                value={step.instruction}
                onChange={(e) => setStep(at, { instruction: e.target.value })}
                placeholder={t("team.stepInstruction")}
                className={fieldClass({ className: "h-auto w-full resize-y py-1.5 leading-relaxed" })}
              />
              {at > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("team.stepDepends")}</span>
                  {draft.plan.slice(0, at).map((other, j) => {
                    const key = other.key || `p${j + 1}`;
                    return (
                      <Chip
                        key={j}
                        active={step.depends_on.includes(key)}
                        onClick={() => setStep(at, { depends_on: step.depends_on.includes(key) ? step.depends_on.filter((d) => d !== key) : [...step.depends_on, key] })}
                      >
                        {key}
                      </Chip>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          <GhostButton
            onClick={() =>
              onPatch({
                plan: [
                  ...draft.plan.map((s, i) => ({ ...s, key: s.key || `p${i + 1}` })),
                  { key: `p${draft.plan.length + 1}`, member: draft.members[0]?.id ?? "", repo: "", kind: "work", title: "", instruction: "", depends_on: [] },
                ],
              })
            }
          >
            <Plus size={13} />
            {t("team.addStep")}
          </GhostButton>
        </div>
      )}
    </div>
  );
}

/**
 * The policy's fields, by tab. Shared with the run dialog, where the same rules can be changed for one
 * run without touching the team.
 */
export function PolicyEditor({
  tab,
  policy,
  members,
  roster,
  projects,
  onPatch,
}: {
  tab: "permissions" | "git" | "review" | "limits";
  policy: TeamPolicy;
  members: TeamMember[];
  roster: WorkspaceAgent[];
  projects: Project[];
  onPatch: (p: Partial<TeamPolicy>) => void;
}) {
  const t = useT();
  const nameOf = (m: TeamMember) => m.name || roster.find((a) => a.id === m.agent_id)?.name || t("team.unnamed");
  const preset = presetOf(policy);
  if (tab === "permissions") {
    return (
      <div className="space-y-3">
        <div className="flex gap-1.5">
          {(["autonomous", "supervised", "stepwise"] as const).map((p) => (
            <Chip key={p} active={preset === p} onClick={() => onPatch(applyPreset(policy, p))}>
              {t(`team.preset.${p}` as TranslationKey)}
            </Chip>
          ))}
        </div>
        <Toggle label={t("team.approvePlan")} checked={policy.approve_plan} onChange={(v) => onPatch({ approve_plan: v })} />
        <Labeled label={t("team.approveCode")}>
          <Select
            size="field"
            value={policy.approve_code}
            onChange={(v) => onPatch({ approve_code: v as TeamPolicy["approve_code"] })}
            options={[
              { value: "never", label: t("team.approveCode.never") },
              { value: "first", label: t("team.approveCode.first") },
              { value: "each", label: t("team.approveCode.each") },
            ]}
          />
        </Labeled>
        <Toggle label={t("team.approveMerge")} checked={policy.approve_merge} onChange={(v) => onPatch({ approve_merge: v })} />
        <Labeled label={t("team.questions")} hint={t("team.questionsHint")}>
          <Select
            size="field"
            value={policy.questions}
            onChange={(v) => onPatch({ questions: v as TeamPolicy["questions"] })}
            options={[
              { value: "allow", label: t("team.questions.allow") },
              { value: "plan", label: t("team.questions.plan") },
              { value: "never", label: t("team.questions.never") },
            ]}
          />
        </Labeled>
      </div>
    );
  }
  if (tab === "git") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <Labeled label={t("team.integrate")}>
          <Select
            size="field"
            value={policy.integrate}
            onChange={(v) => onPatch({ integrate: v as TeamPolicy["integrate"] })}
            options={[
              { value: "merge", label: t("team.integrate.merge") },
              { value: "branch", label: t("team.integrate.branch") },
            ]}
          />
        </Labeled>
        <Labeled label={t("team.commit")}>
          <Select
            size="field"
            value={policy.commit}
            onChange={(v) => onPatch({ commit: v as TeamPolicy["commit"] })}
            options={[
              { value: "item", label: t("team.commit.item") },
              { value: "squash", label: t("team.commit.squash") },
              { value: "none", label: t("team.commit.none") },
            ]}
          />
        </Labeled>
        <Labeled label={t("team.commitStyle")}>
          <Select
            size="field"
            value={policy.commit_style}
            onChange={(v) => onPatch({ commit_style: v as TeamPolicy["commit_style"] })}
            options={[
              { value: "conventional", label: t("team.commitStyle.conventional") },
              { value: "free", label: t("team.commitStyle.free") },
            ]}
          />
        </Labeled>
        <Labeled label={t("team.conflicts")}>
          <Select
            size="field"
            value={policy.conflicts}
            onChange={(v) => onPatch({ conflicts: v })}
            options={[
              { value: "author", label: t("team.conflicts.author") },
              { value: "user", label: t("team.conflicts.user") },
              ...members.filter((m) => m.edits).map((m) => ({ value: m.id, label: nameOf(m) })),
            ]}
          />
        </Labeled>
        <Toggle label={t("team.push")} checked={policy.push} onChange={(v) => onPatch({ push: v })} />
        <Toggle label={t("team.cleanup")} checked={policy.cleanup} onChange={(v) => onPatch({ cleanup: v })} />
        <p className="col-span-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("team.gitHint")}</p>
      </div>
    );
  }
  if (tab === "review") {
    const review = policy.review;
    const setReview = (p: Partial<TeamPolicy["review"]>) => onPatch({ review: { ...review, ...p } });
    return (
      <div className="space-y-3">
        <Toggle label={t("team.reviewEnabled")} checked={review.enabled} onChange={(v) => setReview({ enabled: v })} />
        {review.enabled && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Labeled label={t("team.reviewer")}>
                <Select
                  size="field"
                  value={review.reviewer}
                  onChange={(v) => setReview({ reviewer: v })}
                  options={[{ value: "", label: t("team.pickMember") }, ...members.map((m) => ({ value: m.id, label: nameOf(m) }))]}
                />
              </Labeled>
              <Labeled label={t("team.exigence")}>
                <Select
                  size="field"
                  value={review.exigence}
                  onChange={(v) => setReview({ exigence: v as "correct" | "polished" })}
                  options={[
                    { value: "correct", label: t("team.exigence.correct") },
                    { value: "polished", label: t("team.exigence.polished") },
                  ]}
                />
              </Labeled>
              <Labeled label={t("team.laps")}>
                <input type="number" min={1} max={8} value={review.laps} onChange={(e) => setReview({ laps: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} className={inputClass} />
              </Labeled>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("team.reviewOf")}</span>
              <Chip active={review.of.length === 0} onClick={() => setReview({ of: [] })}>
                {t("team.everyone")}
              </Chip>
              {members
                .filter((m) => m.edits && m.id !== review.reviewer)
                .map((m) => (
                  <Chip key={m.id} active={review.of.includes(m.id)} onClick={() => setReview({ of: review.of.includes(m.id) ? review.of.filter((x) => x !== m.id) : [...review.of, m.id] })}>
                    {nameOf(m)}
                  </Chip>
                ))}
            </div>
          </>
        )}
        <div className="space-y-2 border-t border-[var(--cf-border)] pt-3">
          <p className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("team.checks")}</p>
          {policy.checks.map((check, at) => (
            <div key={at} className="grid grid-cols-[1fr_2fr_1fr_auto] items-center gap-2">
              <Select
                value={check.repo}
                onChange={(repo) => onPatch({ checks: policy.checks.map((c, i) => (i === at ? { ...c, repo } : c)) })}
                options={[{ value: "*", label: t("team.allRepos") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
              <input
                value={check.command}
                onChange={(e) => onPatch({ checks: policy.checks.map((c, i) => (i === at ? { ...c, command: e.target.value } : c)) })}
                placeholder="pnpm test && pnpm build"
                className={fieldClass({ size: "sm", className: "w-full font-mono" })}
              />
              <Select
                value={check.when}
                onChange={(when) => onPatch({ checks: policy.checks.map((c, i) => (i === at ? { ...c, when: when as "item" | "final" } : c)) })}
                options={[
                  { value: "item", label: t("team.checkItem") },
                  { value: "final", label: t("team.checkFinal") },
                ]}
              />
              <button
                type="button"
                onClick={() => onPatch({ checks: policy.checks.filter((_, i) => i !== at) })}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <GhostButton onClick={() => onPatch({ checks: [...policy.checks, { repo: "*", command: "", when: "final" }] })}>
            <Plus size={13} />
            {t("team.addCheck")}
          </GhostButton>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumberField label={t("team.maxParallel")} value={policy.max_parallel} min={1} max={8} onChange={(v) => onPatch({ max_parallel: v })} />
      <NumberField label={t("team.maxAttempts")} value={policy.max_attempts} min={1} max={6} onChange={(v) => onPatch({ max_attempts: v })} />
      <NumberField label={t("team.maxDispatches")} value={policy.max_dispatches} min={1} max={256} onChange={(v) => onPatch({ max_dispatches: v })} />
      <NumberField label={t("team.leadRounds")} value={policy.lead_rounds} min={1} max={20} onChange={(v) => onPatch({ lead_rounds: v })} />
      <Toggle label={t("team.leadFinalCheck")} checked={policy.lead_final_check} onChange={(v) => onPatch({ lead_final_check: v })} />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
      <Checkbox checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Labeled label={label}>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} className={inputClass} />
    </Labeled>
  );
}
