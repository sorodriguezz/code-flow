import { useEffect, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { deleteWorkspaceMcp, listWorkspaceMcps, upsertWorkspaceMcp } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceMcp } from "../../types/domain";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { useTaskProvider } from "../../state/aiProviderStore";
import { isAgenticProvider } from "../../lib/aiProviders";

export function McpSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // MCP servers are handed to the review/analyze/chat flows; the chat task is the representative
  // one for "will MCP be used at all".
  const agentic = isAgenticProvider(useTaskProvider("chat"));
  const [mcps, setMcps] = useState<WorkspaceMcp[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = async (id: string) => {
    setMcps(await listWorkspaceMcps(id));
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId);
    else setMcps([]);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("settings.mcpsTitle")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.mcpsSelectWorkspace")}</p>
      </section>
    );
  }

  const addMcp = async () => {
    const created = await upsertWorkspaceMcp(undefined, workspaceId, t("settings.newMcpName"), "", "", "", true);
    await reload(workspaceId);
    setExpandedId(created.id);
  };

  const update = async (mcp: WorkspaceMcp, patch: Partial<WorkspaceMcp>) => {
    const next = { ...mcp, ...patch };
    setMcps((prev) => prev.map((m) => (m.id === mcp.id ? next : m)));
    await upsertWorkspaceMcp(mcp.id, workspaceId, next.name, next.command, next.args, next.env, next.enabled);
  };

  const remove = async (mcp: WorkspaceMcp) => {
    if (!(await confirmAction(t("settings.removeMcpConfirm", { name: mcp.name })))) return;
    await deleteWorkspaceMcp(mcp.id);
    await reload(workspaceId);
  };

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("settings.mcpsTitle")}</h3>
        <button onClick={addMcp} className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
          <Plus size={13} /> {t("settings.addMcp")}
        </button>
      </div>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.mcpsHint")}</p>

      {!agentic && (
        <p className="mb-3 rounded-md border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text-muted)]">
          {t("settings.mcpsNotAgentic")}
        </p>
      )}

      <div className="space-y-2">
        {mcps.map((mcp) => {
          const isOpen = expandedId === mcp.id;
          return (
            <div key={mcp.id} className="rounded-lg border border-[var(--cf-border)]">
              <div className="flex items-center gap-2 p-2.5">
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : mcp.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronDown
                    size={14}
                    className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  />
                  <span className={`truncate text-[13px] font-medium ${mcp.enabled ? "" : "text-[var(--cf-text-muted)]"}`}>
                    {mcp.name || t("settings.newMcpName")}
                  </span>
                  {mcp.command && !isOpen && (
                    <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{mcp.command}</span>
                  )}
                  {!mcp.enabled && (
                    <span className="shrink-0 rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                      {t("settings.disabled")}
                    </span>
                  )}
                </button>
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                  <Checkbox checked={mcp.enabled} onChange={(checked) => update(mcp, { enabled: checked })} />
                  {t("settings.enabled")}
                </label>
                <button onClick={() => remove(mcp)} className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
                  <Trash2 size={13} />
                </button>
              </div>

              {isOpen && (
                <div className="border-t border-[var(--cf-border)] p-3">
                  <input
                    value={mcp.name}
                    onChange={(e) => update(mcp, { name: e.target.value })}
                    placeholder={t("settings.newMcpName")}
                    className="mb-1.5 w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
                  />
                  <div className="mb-1.5 flex gap-1.5">
                    <input
                      value={mcp.command}
                      onChange={(e) => update(mcp, { command: e.target.value })}
                      placeholder={t("settings.mcpCommandPlaceholder")}
                      className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
                    />
                    <input
                      value={mcp.args}
                      onChange={(e) => update(mcp, { args: e.target.value })}
                      placeholder={t("settings.mcpArgsPlaceholder")}
                      className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
                    />
                  </div>
                  <textarea
                    value={mcp.env}
                    onChange={(e) => update(mcp, { env: e.target.value })}
                    rows={2}
                    placeholder={t("settings.mcpEnvPlaceholder")}
                    className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
                  />
                </div>
              )}
            </div>
          );
        })}
        {mcps.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noMcps")}</p>}
      </div>
    </section>
  );
}
