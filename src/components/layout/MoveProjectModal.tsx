import { useEffect, useState } from "react";
import { Briefcase, Check, FolderInput, Loader2 } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { ActivePill } from "../common/ActivePill";
import { ConfirmFlowDiagram } from "../common/ConfirmFlowDiagram";
import type { Project } from "../../types/domain";

/**
 * Moving a project to another workspace, in the same shape as the branch dialogs: one centred
 * `cf-fade-in` card, a pick-then-confirm body, Escape and Cancel as the ways out.
 *
 * It replaces a dropdown anchored to the row's button, which the sidebar clipped — the aside is
 * `overflow-hidden` and the project list scrolls inside it, so a menu opening below a row near the
 * bottom was cut off at the pane edge with its workspaces unreachable. A dialog has no such frame
 * to escape from, and the list can be as long as the workspaces are.
 */
export function MoveProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const moveProject = useWorkspaceStore((s) => s.moveProject);
  const t = useT();

  const options = workspaces.filter((w) => w.id !== project.workspace_id);
  const current = workspaces.find((w) => w.id === project.workspace_id);
  // Nothing preselected: a row that arrives already ticked reads as a statement about the project
  // rather than as the choice it is. The diagram below fills in once a destination is picked, the
  // same way the create-branch one waits on a name.
  const [targetId, setTargetId] = useState("");
  const target = options.find((w) => w.id === targetId);
  const [moving, setMoving] = useState(false);

  const submit = async () => {
    if (!targetId || moving) return;
    setMoving(true);
    try {
      await moveProject(project.id, project.workspace_id, targetId);
      onClose();
    } finally {
      setMoving(false);
    }
  };

  // On the window rather than the dialog, for the reason `CreateBranchModal` gives: the card isn't
  // focusable, so a handler bound to it goes deaf the moment anything inside is clicked.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (moving) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Rebound when the selection changes so Enter always commits the row that is highlighted.
  }, [moving, targetId, onClose]);

  return (
    // Backdrop click closes: unlike the branch form there is nothing half-typed to lose here, so
    // this one behaves like `ConfirmModal` rather than guarding the click.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={() => !moving && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // Matched to the other dialogs that draw the flow diagram — its two pills carry workspace
        // names here, which run as long as branch names do.
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[520px] max-w-[90vw] overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <FolderInput size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold">{t("sidebar.moveToWorkspace")}</h3>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("sidebar.moveProjectHint", { name: project.name })}
            </p>
          </div>
        </div>

        {/* The same diagram every branch dialog draws, and for the same reason: "move craft-kit to
            Test" says nothing about where it is leaving from. It sits above the list so what is
            about to happen is stated first and the picker below it is what edits that statement —
            source and target swap as rows are picked. */}
        <ConfirmFlowDiagram
          flow={{
            kind: "workspace-move",
            source: current?.name ?? t("sidebar.moveProjectUnknownSource"),
            target: target?.name ?? t("sidebar.moveProjectTargetPlaceholder"),
            note: t("sidebar.moveProjectNote", { name: project.name }),
          }}
        />

        <div className="mb-4 space-y-0.5">
          {options.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setTargetId(ws.id)}
              aria-pressed={targetId === ws.id}
              // The same sliding pill the rails and tabs use, so picking a destination reads as the
              // one selection idiom the app has rather than a new kind of radio button.
              className={`relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                targetId === ws.id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              {targetId === ws.id && <ActivePill layoutId="cf-move-project-pill" radius="rounded-lg" />}
              {/* Above the pill, which covers the whole row. */}
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                {/* Briefcase in the workspace's own colour, as in Settings — one mark rather than a
                    dot and an icon saying the same thing twice. */}
                <Briefcase size={13} className="shrink-0" style={{ color: ws.color }} />
                <span className="truncate">{ws.name}</span>
                {targetId === ws.id && <Check size={13} className="ml-auto shrink-0" />}
              </span>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={moving}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!targetId || moving}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {moving ? <Loader2 size={13} className="animate-spin" /> : <FolderInput size={13} />}
            {t("sidebar.moveProjectConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
