import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { listWorkspaceAgents } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useChatStore } from "../../state/chatStore";
import { useT } from "../../state/languageStore";
import type { WorkspaceAgent } from "../../types/domain";
import { Select } from "../common/Select";

/**
 * Picks an SDD/Harness agent to run the chat as. Selecting one makes each turn use that agent's
 * provider + model and prepends its prompt (the role's instructions). "None" restores the normal
 * chat routing. Only shows when the workspace has usable agents (enabled, with a provider + model).
 */
export function ChatAgentPicker({ projectId }: { projectId: string }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const selected = useChatStore((s) => s.agentByProject[projectId] ?? null);
  const setAgent = useChatStore((s) => s.setAgent);

  useEffect(() => {
    if (!workspaceId) {
      setAgents([]);
      return;
    }
    void listWorkspaceAgents(workspaceId).then((list) =>
      setAgents(list.filter((a) => a.enabled && a.provider.trim() && a.model.trim())),
    );
  }, [workspaceId]);

  if (agents.length === 0) return null;

  const onChange = (id: string) => {
    if (!id) {
      setAgent(projectId, null);
      return;
    }
    const a = agents.find((x) => x.id === id);
    if (a) setAgent(projectId, { id: a.id, provider: a.provider, model: a.model, prompt: a.prompt });
  };

  return (
    <span className="flex items-center gap-1" title={t("chat.agentHint")}>
      <Users size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
      <Select
        size="sm"
        value={selected?.id ?? ""}
        onChange={onChange}
        options={[
          { value: "", label: t("chat.agentNone") },
          ...agents.map((a) => ({ value: a.id, label: a.name || t("settings.sddNewAgent") })),
        ]}
      />
    </span>
  );
}
