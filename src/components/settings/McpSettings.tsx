import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { deleteWorkspaceMcp, listWorkspaceMcps, upsertWorkspaceMcp } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceMcp } from "../../types/domain";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";

export function McpSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [mcps, setMcps] = useState<WorkspaceMcp[]>([]);

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
    await upsertWorkspaceMcp(undefined, workspaceId, t("settings.newMcpName"), "", "", "", true);
    await reload(workspaceId);
  };

  const update = async (mcp: WorkspaceMcp, patch: Partial<WorkspaceMcp>) => {
    const next = { ...mcp, ...patch };
    setMcps((prev) => prev.map((m) => (m.id === mcp.id ? next : m)));
    await upsertWorkspaceMcp(mcp.id, workspaceId, next.name, next.command, next.args, next.env, next.enabled);
  };

  const remove = async (id: string) => {
    await deleteWorkspaceMcp(id);
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

      <div className="space-y-3">
        {mcps.map((mcp) => (
          <div key={mcp.id} className="rounded-lg border border-[var(--cf-border)] p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={mcp.name}
                onChange={(e) => update(mcp, { name: e.target.value })}
                className="flex-1 rounded-md border border-transparent bg-transparent px-1 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
              />
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                <Checkbox checked={mcp.enabled} onChange={(checked) => update(mcp, { enabled: checked })} />
                {t("settings.enabled")}
              </label>
              <button onClick={() => remove(mcp.id)} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
                <Trash2 size={13} />
              </button>
            </div>
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
        ))}
        {mcps.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noMcps")}</p>}
      </div>
    </section>
  );
}
