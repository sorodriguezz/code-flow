import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Plus, Trash2, Users, Workflow, type LucideIcon } from "lucide-react";
import { deleteWorkspaceAgent, listWorkspaceAgents, upsertWorkspaceAgent } from "../../lib/tauri/commands";
import { WorkspacePromptEditor } from "./WorkspacePromptEditor";
import { useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { renderMarkdown } from "../../lib/markdown";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { WorkspaceAgent } from "../../types/domain";
import { ActiveUnderline } from "../common/ActivePill";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { SDD_GUIDE_EN, SDD_GUIDE_ES } from "./sddGuide";

type TabId = "guide" | "agents" | "stages";

const TABS: { id: TabId; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "guide", labelKey: "settings.sddTabGuide", icon: BookOpen },
  { id: "agents", labelKey: "settings.sddTabAgents", icon: Users },
  { id: "stages", labelKey: "settings.sddTabStages", icon: Workflow },
];

/**
 * SDD / Harness workspace section. Everything is user-defined (no presets): a customizable roster
 * of agents (roles + models), the pipeline stages, and an editable best-practices guide. The guide
 * and stages piggyback on the per-workspace prompt store (kinds `sdd_guide` / `sdd_stages`).
 */
export function SddSettings() {
  const t = useT();
  const workspaceName = useWorkspaceStore((s) => {
    const id = s.activeWorkspaceId;
    return s.workspaces.find((w) => w.id === id)?.name ?? "";
  });
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [tab, setTab] = useState<TabId>("guide");

  if (!workspaceId) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("settings.sdd")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.sddSelectWorkspace")}</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">
        {workspaceName ? t("settings.sddTitleForProject", { name: workspaceName }) : t("settings.sdd")}
      </h3>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--cf-border)]">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative -mb-px flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] ${
              tab === id ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {tab === id && <ActiveUnderline layoutId="cf-sdd-tab-underline" />}
            <Icon size={13} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {tab === "guide" && <GuideTab />}
      {tab === "agents" && <AgentsTab workspaceId={workspaceId} />}
      {tab === "stages" && (
        <div className="space-y-4">
          {/* The executable half. The free-text editor below it is kept, and kept *below*: it is
              what people already wrote their process in, and nothing here destroys it — but a
              template is the one of the two that actually runs. */}
          <ChainTemplatesSection workspaceId={workspaceId} />
          <WorkspacePromptEditor
            kind="sdd_stages"
            hintKey="settings.sddStagesHint"
            placeholderKey="settings.sddStagesPlaceholder"
            resetConfirmKey="settings.sddStagesResetConfirm"
            rows={8}
          />
        </div>
      )}
    </section>
  );
}

/** A static, read-only manual (a wiki) explaining SDD + harness and how to configure this section.
 * Picked by the app's language; not editable and not stored per workspace. */
function GuideTab() {
  const language = useLanguageStore((s) => s.language);
  const content = language === "es" ? SDD_GUIDE_ES : SDD_GUIDE_EN;
  return (
    <div
      className="cf-markdown-preview max-h-[460px] overflow-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-4 py-3 text-[13px]"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
}

/**
 * The workspace's reusable chain plans, listed and removable.
 *
 * Read-only apart from delete, on purpose: a plan is authored where it is used — in the new-chain
 * dialog, against the live roster, with the agent picker that knows which agents can actually run.
 * A second editor here would be a second place for those rules to drift out of agreement.
 */
function ChainTemplatesSection({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const templates = useChainStore((s) => s.templates);
  const roster = useAgentsStore((s) => s.roster);

  useEffect(() => {
    // The Agents view may never have been opened in this session, and this section is reachable
    // without it — so both stores are asked for the workspace rather than assumed to have it. The
    // roster is what turns a template's agent ids back into names.
    void useAgentsStore.getState().setWorkspace(workspaceId);
    void useChainStore.getState().setWorkspace(workspaceId);
    void useChainStore.getState().reloadTemplates();
  }, [workspaceId]);

  const remove = async (id: string, name: string) => {
    if (!(await confirmAction(t("agents.deleteTemplateConfirm", { name })))) return;
    await useChainStore.getState().removeTemplate(id);
  };

  return (
    <section>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("agents.templates")}
      </h4>
      <p className="mb-2 text-[13px] text-[var(--cf-text-muted)]">{t("agents.templatesHint")}</p>

      {templates.length === 0 ? (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("agents.templatesEmpty")}</p>
      ) : (
        <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {templates.map((template) => (
            <div key={template.id} className="flex items-start gap-2 p-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{template.name}</span>
                <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                  {t("agents.templateStepsN", { n: template.steps.length })}
                  {" · "}
                  {template.steps
                    .map(
                      (step) =>
                        roster.find((a) => a.id === step.agent_id)?.name || t("settings.sddNewAgent"),
                    )
                    .join(" → ")}
                </span>
                {template.description && (
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
                    {template.description}
                  </span>
                )}
              </span>
              <button
                onClick={() => void remove(template.id, template.name)}
                title={t("common.delete")}
                aria-label={t("common.delete")}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The user's SDD/Harness agent roster — empty by default. Collapsible rows (name/model summary),
 * each expanding to edit role, model and an optional prompt. */
function AgentsTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [agents, setAgents] = useState<WorkspaceAgent[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = async () => setAgents(await listWorkspaceAgents(workspaceId));

  useEffect(() => {
    setAgents(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const add = async () => {
    const created = await upsertWorkspaceAgent(undefined, workspaceId, t("settings.sddNewAgent"), "", "", "", "", true);
    await reload();
    setExpandedId(created.id);
  };

  const update = async (agent: WorkspaceAgent, patch: Partial<WorkspaceAgent>) => {
    const next = { ...agent, ...patch };
    setAgents((prev) => (prev ? prev.map((a) => (a.id === agent.id ? next : a)) : prev));
    await upsertWorkspaceAgent(agent.id, workspaceId, next.name, next.role, next.provider, next.model, next.prompt, next.enabled);
  };

  const remove = async (agent: WorkspaceAgent) => {
    if (!(await confirmAction(t("settings.sddRemoveAgentConfirm", { name: agent.name || t("settings.sddNewAgent") })))) return;
    await deleteWorkspaceAgent(agent.id);
    await reload();
  };

  if (agents === null) return <Skeleton className="h-24 w-full" />;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.sddAgentsHint")}</p>
        <button onClick={() => void add()} className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
          <Plus size={13} /> {t("settings.sddAddAgent")}
        </button>
      </div>

      <div className="space-y-2">
        {agents.map((agent) => {
          const isOpen = expandedId === agent.id;
          return (
            <div key={agent.id} className="rounded-lg border border-[var(--cf-border)]">
              <div className="flex items-center gap-2 p-2.5">
                <button type="button" onClick={() => setExpandedId(isOpen ? null : agent.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <ChevronDown size={14} className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                  <span className={`truncate text-[13px] font-medium ${agent.enabled ? "" : "text-[var(--cf-text-muted)]"}`}>
                    {agent.name || t("settings.sddNewAgent")}
                  </span>
                  {agent.model && !isOpen && <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{agent.model}</span>}
                </button>
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                  <Checkbox checked={agent.enabled} onChange={(checked) => void update(agent, { enabled: checked })} />
                  {t("settings.enabled")}
                </label>
                <button onClick={() => void remove(agent)} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
                  <Trash2 size={13} />
                </button>
              </div>

              {isOpen && (
                <div className="space-y-1.5 border-t border-[var(--cf-border)] p-3">
                  <input
                    value={agent.name}
                    onChange={(e) => void update(agent, { name: e.target.value })}
                    placeholder={t("settings.sddAgentNamePlaceholder")}
                    className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
                  />
                  <div className="flex gap-1.5">
                    <div className="w-44 shrink-0">
                      <Select
                        size="sm"
                        value={agent.provider}
                        onChange={(v) => void update(agent, { provider: v })}
                        options={[
                          { value: "", label: t("settings.sddAgentProviderDefault") },
                          ...AI_PROVIDERS.filter((p) => p.available).map((p) => ({
                            value: p.id,
                            label: p.label ?? (p.labelKey ? t(p.labelKey) : p.id),
                          })),
                        ]}
                      />
                    </div>
                    <input
                      value={agent.model}
                      onChange={(e) => void update(agent, { model: e.target.value })}
                      placeholder={t("settings.sddAgentModelPlaceholder")}
                      className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
                    />
                  </div>
                  <input
                    value={agent.role}
                    onChange={(e) => void update(agent, { role: e.target.value })}
                    placeholder={t("settings.sddAgentRolePlaceholder")}
                    className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[var(--cf-accent)]"
                  />
                  <textarea
                    value={agent.prompt}
                    onChange={(e) => void update(agent, { prompt: e.target.value })}
                    rows={5}
                    placeholder={t("settings.sddAgentPromptPlaceholder")}
                    className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                  />
                </div>
              )}
            </div>
          );
        })}
        {agents.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.sddNoAgents")}</p>}
      </div>
    </div>
  );
}
