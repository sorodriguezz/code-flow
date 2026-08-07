import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { AgentTaskList } from "./AgentTaskList";
import { AgentTaskDetail } from "./AgentTaskDetail";
import { AgentRosterPanel } from "./AgentRosterPanel";
import { AgentEditorModal } from "./AgentEditorModal";
import { AgentProjectModal } from "./AgentProjectModal";
import { AgentsHelpModal } from "./AgentsHelpModal";
import { ChainDetail } from "./ChainDetail";
import { NewChainModal } from "./NewChainModal";
import { NewTaskModal } from "./NewTaskModal";
import { StoryRealizerModal } from "./StoryRealizerModal";
import { TemplateDetail } from "./TemplateDetail";
import { useChainStore } from "../../state/chainStore";
import { CARD } from "../api/panelChrome";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useAgentsStore } from "../../state/agentsStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { AgentProject, WorkspaceAgent } from "../../types/domain";

const LIST_MIN = 240;
/** Wider than the other rails in the app: this one nests a folder, a chain inside it and that
 * chain's steps inside that, and three levels of indent have to leave a task's name room to read. */
const LIST_MAX = 600;
const ROSTER_MIN = 240;
const ROSTER_MAX = 460;

/** What the chain dialog was opened for: the folder to file the plan under, and — when it was
 * opened from a saved plan — which template it is editing rather than merely copying. */
type ChainDraft = { agentProjectId: string; templateId: string | null };

/**
 * The agent console: the workspace's agents, the tasks they are working on, and the conversation
 * with whichever task is open.
 *
 * Three flush columns, the same shape the API client and the editor use — the task list on the
 * left, the open thing in the middle, and the roster as a rail on the right that is toggled rather
 * than always present, because managing *who the agents are* is a much rarer act than talking to
 * one of them.
 *
 * A task is a conversation with a role attached: its turns are ordinary chat turns run with the
 * agent's provider, model and instructions, against one repository of this workspace. That is why
 * there is no second engine here and no second history — reopening a task replays the same rows
 * the AI panel would.
 */
export function AgentsView() {
  const t = useT();
  const activeView = useUiStore((s) => s.activeView);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const rosterOpen = useAgentsStore((s) => s.rosterOpen);
  const selectedId = useAgentsStore((s) => s.selectedId);
  const listWidth = useLayoutStore((s) => s.sizes.agentsListWidth);
  const rosterWidth = useLayoutStore((s) => s.sizes.agentsRosterWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  /** The agent being created or edited in the modal — `null` when it's closed. `"new"` opens it
   * empty, since an agent that hasn't been saved yet has no row to point at. */
  const [editing, setEditing] = useState<WorkspaceAgent | "new" | null>(null);
  /** The folder being created or edited. Same convention as `editing`. */
  const [editingProject, setEditingProject] = useState<AgentProject | "new" | null>(null);
  /** The folder a new task should land in, or `null` when the dialog is closed. A string and not a
   * boolean because "which folder" is part of what the dialog was opened *for*. */
  const [composing, setComposing] = useState<string | null>(null);
  const [chaining, setChaining] = useState<ChainDraft | null>(null);
  /** The folder a new story run should land in, or `null` when the dialog is closed. Same
   * convention as `composing` — a string, because "which folder" is part of what it was opened for. */
  const [storying, setStorying] = useState<string | null>(null);
  const [helping, setHelping] = useState(false);
  const selectedChainId = useChainStore((s) => s.selectedId);
  const selectedTemplateId = useChainStore((s) => s.selectedTemplateId);

  useEffect(() => {
    void useAgentsStore.getState().setWorkspace(workspaceId);
    // `chainStore` subscribes to the workspace at module scope, so it is already following along
    // whether or not this view has ever been mounted — this call only covers the very first mount,
    // where the subscription has had no change to react to yet.
    void useChainStore.getState().setWorkspace(workspaceId);
  }, [workspaceId]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘N would open the new-task
  // dialog while the user is looking at a diff.
  useEffect(() => {
    if (activeView !== "agents") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Lower-cased: with caps lock on, `key` is "N" and a bare comparison silently misses.
      if (e.key.toLowerCase() !== "n") return;
      // A dialog already covers the view, and Settings covers the whole app — opening a second
      // one behind either is the same bug the API client guards against.
      if (
        composing !== null ||
        chaining !== null ||
        storying !== null ||
        editing !== null ||
        editingProject !== null ||
        useUiStore.getState().settingsOpen
      ) {
        return;
      }
      e.preventDefault();
      setComposing("");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, composing, chaining, storying, editing, editingProject]);

  if (!workspaceId) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <EmptyState icon={Bot} title={t("agents.noWorkspace")} subtitle={t("agents.noWorkspaceHint")} />
      </div>
    );
  }

  /** Opening a saved plan: the authoring dialog, loaded from it and pointed back at it, so saving
   * updates the template instead of leaving a near-identical copy beside it. */
  const openTemplate = (templateId: string) => {
    const template = useChainStore.getState().templates.find((candidate) => candidate.id === templateId) ?? null;
    setChaining({ agentProjectId: "", templateId: template ? template.id : null });
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        {/* Flush: no padding, no gaps — the only thing between two columns is a `ResizeHandle`'s
            one-pixel seam, the same as everywhere else in the app. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <AgentTaskList
            width={listWidth}
            onNewTask={(agentProjectId) => setComposing(agentProjectId)}
            onNewChain={(agentProjectId) => setChaining({ agentProjectId, templateId: null })}
            onNewStory={setStorying}
            onNewAgent={() => setEditing("new")}
            onNewProject={() => setEditingProject("new")}
            onEditProject={setEditingProject}
            onUseTemplate={openTemplate}
            onHelp={() => setHelping(true)}
          />
          <ResizeHandle
            axis="x"
            value={listWidth}
            min={LIST_MIN}
            max={LIST_MAX}
            onChange={(value) => setSize("agentsListWidth", value)}
            onCommit={(value) => commitSize("agentsListWidth", value)}
          />

          {/* A template, a chain and a task are mutually exclusive in the middle column: selecting
              any one clears the other two, so there is exactly one thing on screen and one thing
              the action bar belongs to. All three are keyed, for the same reason — every bit of
              local state in those panes belongs to one row. */}
          <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
            {selectedTemplateId ? (
              <TemplateDetail key={selectedTemplateId} templateId={selectedTemplateId} onUse={openTemplate} />
            ) : selectedChainId ? (
              <ChainDetail key={selectedChainId} chainId={selectedChainId} />
            ) : selectedId ? (
              <AgentTaskDetail key={selectedId} taskId={selectedId} />
            ) : (
              <EmptyState icon={Bot} title={t("agents.selectTask")} subtitle={t("agents.selectTaskHint")} />
            )}
          </div>

          {rosterOpen && (
            <>
              <ResizeHandle
                axis="x"
                value={rosterWidth}
                min={ROSTER_MIN}
                max={ROSTER_MAX}
                invert
                onChange={(value) => setSize("agentsRosterWidth", value)}
                onCommit={(value) => commitSize("agentsRosterWidth", value)}
              />
              <AgentRosterPanel width={rosterWidth} onEdit={setEditing} />
            </>
          )}
        </div>
      </div>

      {editing !== null && (
        <AgentEditorModal
          workspaceId={workspaceId}
          agent={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {editingProject !== null && (
        <AgentProjectModal
          project={editingProject === "new" ? null : editingProject}
          onClose={() => setEditingProject(null)}
        />
      )}
      {composing !== null && (
        <NewTaskModal
          suspended={editing !== null}
          initialAgentProjectId={composing}
          onClose={() => setComposing(null)}
          onManageAgents={() => setEditing("new")}
        />
      )}
      {chaining !== null && (
        <NewChainModal
          initialAgentProjectId={chaining.agentProjectId}
          templateId={chaining.templateId}
          onClose={() => setChaining(null)}
          onManageAgents={() => setEditing("new")}
        />
      )}
      {storying !== null && (
        <StoryRealizerModal
          initialAgentProjectId={storying}
          onClose={() => setStorying(null)}
          onManageAgents={() => setEditing("new")}
        />
      )}
      {helping && <AgentsHelpModal onClose={() => setHelping(false)} />}
    </>
  );
}
