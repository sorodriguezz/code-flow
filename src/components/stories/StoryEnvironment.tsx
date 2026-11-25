import { useCallback, useEffect, useState } from "react";
import { Boxes, GitBranch } from "lucide-react";
import { NewSandboxDialog } from "../containers/NewSandboxDialog";
import { showSandbox } from "../containers/sandboxFocus";
import { statusTone } from "../containers/sandboxModel";
import { StateDot } from "../containers/containerBits";
import { containersSandboxForStory } from "../../lib/tauri/containersSandboxCommands";
import { useT } from "../../state/languageStore";
import type { SandboxView } from "../../types/containersSandbox";

/**
 * «Crear ambiente de ingeniería» on a story: a branch and worktree named after it and an isolated
 * agent sandbox linked to it — and, once made, the link back, one chip per environment, each opening
 * its sandbox in Contenedores (whose detail links back to the story).
 */
export function StoryEnvironment({ storyId, title, workspaceId, projectId }: { storyId: string; title: string; workspaceId: string; projectId: string | null }) {
  const t = useT();
  const [linked, setLinked] = useState<SandboxView[]>([]);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    void containersSandboxForStory(storyId)
      .then(setLinked)
      .catch(() => setLinked([]));
  }, [storyId]);
  useEffect(() => reload(), [reload]);

  const live = linked.filter((s) => s.status !== "destroyed");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => setCreating(true)}
        title={t("containers.sandbox.story.hint")}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <Boxes size={11} />
        {t("containers.sandbox.story.action")}
      </button>
      {live.map((sandbox) => (
        <button
          key={sandbox.id}
          type="button"
          onClick={() => showSandbox(sandbox.runtime, sandbox.id)}
          title={t("containers.sandbox.story.open", { name: sandbox.containerName })}
          className="flex items-center gap-1.5 rounded-full bg-[var(--cf-press)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
        >
          <StateDot tone={statusTone(sandbox.status)} />
          {t("containers.sandbox.story.linked")}
          <GitBranch size={9} />
          <span className="font-mono">{sandbox.branch}</span>
        </button>
      ))}
      {creating && (
        <NewSandboxDialog
          workspaceId={workspaceId}
          projectId={projectId}
          storyId={storyId}
          title={title}
          onClose={() => {
            setCreating(false);
            reload();
          }}
          onCreated={(sandbox) => {
            setCreating(false);
            reload();
            showSandbox(sandbox.runtime, sandbox.id);
          }}
        />
      )}
    </div>
  );
}
