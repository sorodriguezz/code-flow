import { useRef, useState } from "react";
import { X } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { buttonClass, iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { ArchifyRefineDialog } from "./ArchifyRefineDialog";
import { archifyDocKind, parseArchify, type ArchifyMode } from "../../lib/diagrams/archify/ir";
import { storedDocument } from "../../lib/diagrams/archify/sourceFile";
import { FORMAT_ARCHIFY } from "../../lib/diagrams/doc";
import {
  diagramsArchifyRefine,
  diagramsArchifyRepoFor,
  diagramsKeepVersion,
  diagramsSaveDiagram,
} from "../../lib/tauri/diagramsCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useT } from "../../state/languageStore";
import { notify } from "../../state/notificationStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/** How a refinement is named in the run store — and how this control finds its own. */
const REFINE_KIND = "archify.refine.runKind" as const;

/**
 * "Adjust" for an archify diagram: say what to change, and the model reads the repository again and
 * hands the diagram back corrected.
 *
 * **Why it exists.** What a diagram should be about is easier to say over a drawing than before one:
 * the first answer shows what the repository really holds, and the second sentence is usually obvious
 * from it. So the first run is a guess that costs a click, and this is how it is corrected — without
 * starting over, since the model is given the diagram as it stands and told to change only what was
 * asked.
 *
 * **Undoable, always.** A restore point is kept before the new document is written
 * (`diagrams_keep_version`, which unlike the autosave's does not wait out a throttle), and the header's
 * history button — next to this one — brings it back.
 *
 * **Which repository.** The diagram does not say; `diagrams_archify_repo_for` finds it by the address
 * the first run pinned. When that cannot — the repository had no `origin`, or the diagram was imported —
 * the workspace's only repository is used, or the user is asked which.
 *
 * The run belongs to the diagram and its workspace, stamped before anything is awaited: it finishes
 * wherever the user has gone, and then writes to the diagram by id.
 */
export function ArchifyRefineControls({ diagramId, title }: { diagramId: string; title: string }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // The type of the diagram on screen — absent for a page archify itself rendered, which cannot be
  // asked to change: there is no document behind it, only HTML.
  const mode = useDiagramsStore((s): ArchifyMode | null => {
    const draft = s.draft;
    if (!draft || draft.id !== diagramId) return null;
    const found = archifyDocKind(draft.doc);
    return found.kind === "document" ? found.ir.diagram_type : null;
  });
  const running = useAiRunStore((s) => {
    for (const [runId, on] of Object.entries(s.active)) {
      const about = s.aboutByRun[runId];
      if (on && about?.kindKey === REFINE_KIND && about.target?.select?.id === diagramId) return runId;
    }
    return null;
  });

  if (!mode) return null;

  const apply = async (projectId: string, instruction: string) => {
    const store = useDiagramsStore.getState();
    const document = store.draft?.id === diagramId ? store.draft.doc : null;
    const workspaceId = store.workspaceId;
    if (!document || !workspaceId) return;
    const runId = newRunId("archify-refine");
    useAiRunStore.getState().start(runId, {
      kindKey: REFINE_KIND,
      detail: title,
      workspaceId,
      target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
    });
    try {
      const raw = await diagramsArchifyRefine({ projectId, document, instruction, runId });
      const parsed = parseArchify(raw, title);
      if ("error" in parsed) throw new Error(t("archify.refine.error"));
      // The row's name stays the diagram's: a refinement changes what is drawn, not what it is called.
      const next = storedDocument({ ...parsed.ir, meta: { ...parsed.ir.meta, title } });

      await diagramsKeepVersion(diagramId);
      const now = useDiagramsStore.getState();
      if (now.activeId === diagramId && now.draft?.id === diagramId) {
        now.editDoc(next);
        await useDiagramsStore.getState().flush();
        pushSuccessToast(t("archify.refine.done"));
      } else {
        // Left for another diagram, or another workspace, while it ran: written by id, and the
        // notification is the way back.
        await diagramsSaveDiagram(diagramId, next, FORMAT_ARCHIFY, "");
        notify({
          source: "diagrams",
          titleKey: "notifications.archifyRefined",
          target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
          status: "success",
          detail: title,
          workspaceId,
        });
      }
    } catch (error) {
      if (!isCancellation(error)) pushErrorToast(String(error));
    } finally {
      useAiRunStore.getState().finish(runId);
    }
  };

  const submit = async (instruction: string) => {
    setOpen(false);
    const workspaceId = useDiagramsStore.getState().workspaceId;
    const projects = (workspaceId && useWorkspaceStore.getState().projectsByWorkspace[workspaceId]) || [];
    let projectId = await diagramsArchifyRepoFor(diagramId).catch(() => null);
    if (!projectId && projects.length === 1) projectId = projects[0].id;
    if (projectId) return void apply(projectId, instruction);
    if (projects.length === 0) return void pushErrorToast(t("archify.refine.noRepo"));
    const box = button.current?.getBoundingClientRect();
    setMenu({
      x: box?.left ?? 80,
      y: (box?.bottom ?? 60) + 4,
      items: [
        { label: t("archify.refine.which"), disabled: true, onClick: () => {} },
        ...projects.map((project) => ({
          label: project.name,
          separated: false,
          onClick: () => void apply(project.id, instruction),
        })),
      ],
    });
  };

  return (
    <>
      {running ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
          <ThinkingOrb size="sm" />
          {t("archify.refine.running")}
          <Tooltip label={t("archify.refine.stop")}>
            <button
              type="button"
              onClick={() => void useAiRunStore.getState().cancel(running)}
              className={iconButtonClass({ size: "sm" })}
              aria-label={t("archify.refine.stop")}
            >
              <X size={12} />
            </button>
          </Tooltip>
        </span>
      ) : (
        <Tooltip label={t("archify.refine.hint")}>
          <button
            ref={button}
            type="button"
            onClick={() => setOpen(true)}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            <AiSparkles size={13} />
            {t("archify.refine.action")}
          </button>
        </Tooltip>
      )}
      {open && <ArchifyRefineDialog mode={mode} onSubmit={(instruction) => void submit(instruction)} onClose={() => setOpen(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
