import { useEffect } from "react";
import { Bot, Copy, Info, Pencil, Plus, Trash2 } from "lucide-react";
import { CARD } from "../api/panelChrome";
import { ToolbarButton } from "../db/dbChrome";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { deleteWorkspaceAgent, upsertWorkspaceAgent } from "../../lib/tauri/commands";
import { AI_PROVIDERS, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import type { WorkspaceAgent } from "../../types/domain";

/**
 * The workspace's agent roster — the "manage agents" half of this view.
 *
 * It is the *same* roster the AI chat's agent picker reads, not a second one:
 * an agent is a role with a provider, a model and instructions, and having two places that each
 * hold half of them is how a role ends up meaning one thing in the chat and another here. What
 * this panel adds is the model picker — Settings only offers a free-text field — which is also why
 * an agent edited here is far less likely to end up in the one state that silently misbehaves: a
 * provider with no model, which the backend quietly answers with the normal chat routing instead.
 */
export function AgentRosterPanel({
  width,
  onEdit,
}: {
  width: number;
  onEdit: (agent: WorkspaceAgent | "new") => void;
}) {
  const t = useT();
  const roster = useAgentsStore((s) => s.roster);
  const workspaceId = useAgentsStore((s) => s.workspaceId);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    // Checked once per session; re-running it on every roster change would spawn a process per
    // provider each time a checkbox is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (agent: WorkspaceAgent, enabled: boolean) => {
    if (!workspaceId) return;
    await upsertWorkspaceAgent(
      agent.id,
      workspaceId,
      agent.name,
      agent.role,
      agent.provider,
      agent.model,
      agent.prompt,
      enabled,
    );
    await useAgentsStore.getState().reloadRoster();
  };

  const duplicate = async (agent: WorkspaceAgent) => {
    if (!workspaceId) return;
    await upsertWorkspaceAgent(
      undefined,
      workspaceId,
      `${agent.name} (2)`,
      agent.role,
      agent.provider,
      agent.model,
      agent.prompt,
      agent.enabled,
    );
    await useAgentsStore.getState().reloadRoster();
  };

  const remove = async (agent: WorkspaceAgent) => {
    const name = agent.name || t("settings.sddNewAgent");
    if (!(await confirmAction(t("settings.sddRemoveAgentConfirm", { name })))) return;
    await deleteWorkspaceAgent(agent.id);
    await useAgentsStore.getState().reloadRoster();
  };

  return (
    <div style={{ width }} className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("agents.roster")}
        </span>
        <ToolbarButton onClick={() => onEdit("new")} title={t("agents.newAgent")}>
          <Plus size={13} />
        </ToolbarButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {roster.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <div className="w-full">
              <EmptyState icon={Bot} title={t("agents.rosterEmpty")} subtitle={t("agents.rosterEmptyHint")} />
            </div>
            <button
              type="button"
              onClick={() => onEdit("new")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Plus size={13} />
              {t("agents.newAgent")}
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)] divide-y divide-[var(--cf-border)]">
            {roster.map((agent, at) => {
              const runnable = isRunnableAgent(agent);
              const providerMeta = AI_PROVIDERS.find((p) => p.id === agent.provider) ?? null;
              const Icon = providerMeta?.icon ?? Bot;
              const missing = agent.provider !== "" && !isProviderReady(statuses, agent.provider);
              const summary = agent.provider
                ? `${providerDisplayLabel(agent.provider, t)} · ${
                    agent.model ? modelDisplayLabel(agent.provider, agent.model, t) : t("agents.agentNoModel")
                  }`
                : t("agents.agentNoModel");

              return (
                <div
                  key={agent.id}
                  style={riseDelay(at)}
                  className="cf-rise group flex items-start gap-2 px-2 py-2"
                >
                  <span className="mt-[1px] shrink-0">
                    <Checkbox checked={agent.enabled} onChange={(checked) => void toggle(agent, checked)} />
                  </span>
                  <button
                    type="button"
                    onClick={() => onEdit(agent)}
                    className="min-w-0 flex-1 text-left"
                    title={agent.role || agent.name}
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                      <span
                        className={`min-w-0 truncate text-[13px] ${
                          agent.enabled ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
                        }`}
                      >
                        {agent.name || t("settings.sddNewAgent")}
                      </span>
                    </span>
                    <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{summary}</span>
                    {/* Named rather than merely greyed: an agent with no model runs, it just runs
                        on the wrong engine, and "nothing happened" is a worse thing to debug. */}
                    {!runnable && agent.enabled && (
                      <span className="mt-0.5 block truncate text-[10.5px] text-[var(--cf-warning)]">
                        {t("agents.agentIncomplete")}
                      </span>
                    )}
                    {missing && (
                      <span className="mt-0.5 block truncate text-[10.5px] text-[var(--cf-warning)]">
                        {t("settings.providerMissing")}
                      </span>
                    )}
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <ToolbarButton onClick={() => onEdit(agent)} title={t("agents.editAgent")}>
                      <Pencil size={12} />
                    </ToolbarButton>
                    <ToolbarButton onClick={() => void duplicate(agent)} title={t("agents.duplicateAgent")}>
                      <Copy size={12} />
                    </ToolbarButton>
                    <button
                      type="button"
                      onClick={() => void remove(agent)}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="flex shrink-0 items-start gap-1.5 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        <Info size={11} className="mt-[2px] shrink-0" />
        <span>{t("agents.rosterHint")}</span>
      </p>
    </div>
  );
}
