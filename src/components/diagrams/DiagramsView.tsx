import { useEffect, useState } from "react";
import { ArrowLeft, Undo2, Workflow } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { DiagramExplorer } from "./DiagramExplorer";
import { DiagramGallery } from "./DiagramGallery";
import { DrawioFrame } from "./DrawioFrame";
import { DiagramAiPanel } from "./DiagramAiPanel";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { CARD, ICON_BUTTON } from "./diagramsChrome";
import { relativeTime } from "../notes/notesChrome";
import { ensureDiagramsStoreLoaded, useDiagramsStore } from "../../state/diagramsStore";
import { useLayoutStore } from "../../state/layoutStore";
import { promptAction } from "../../state/promptStore";
import { useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * The Diagrams workspace's shell: the explorer, and whichever surface the selection calls for.
 *
 * It sits in the app rail below Notes rather than in the tab bar, for the same reason every app on
 * that rail does — a diagram belongs to the workspace, not to whichever repository happens to be
 * selected. An architecture drawing describes the system, not a checkout.
 *
 * **The editor is mounted only while a diagram is open.** That is the memory strategy, and it is
 * the same one `NotesView` uses for Monaco, applied to something an order of magnitude heavier:
 * booting draw.io costs ~25 MB of JavaScript, and going back to the gallery gives all of it back.
 * See `DrawioFrame`.
 *
 * The unsaved edit is written by `flush` on every path that could drop it — closing the diagram,
 * switching workspace, hiding the window, leaving the view.
 */
export function DiagramsView() {
  const workspaceId = useDiagramsStore((s) => s.workspaceId);
  const loading = useDiagramsStore((s) => s.loading);
  const activeId = useDiagramsStore((s) => s.activeId);
  const closeDiagram = useDiagramsStore((s) => s.closeDiagram);
  const createTemplate = useDiagramsStore((s) => s.createTemplate);
  const requestExport = useDiagramsStore((s) => s.requestExport);
  const undoLastGeneration = useDiagramsStore((s) => s.undoLastGeneration);
  /** A boolean, not the document: this component must not re-render when the drawing changes. */
  const canUndoGeneration = useDiagramsStore((s) => s.undoGeneration !== null);
  // Booleans and a string, deliberately, and not `s.draft`. The draft object is replaced on every
  // edit, so subscribing to it would re-render this component — and therefore the whole explorer
  // beside it — once per stroke of the pen.
  const dirty = useDiagramsStore((s) => s.draft?.dirty ?? false);
  const saving = useDiagramsStore((s) => s.saving);
  const savedAt = useDiagramsStore((s) => s.savedAt);
  const openTitle = useDiagramsStore(
    (s) => s.diagrams.find((d) => d.id === s.activeId)?.title ?? "",
  );

  const sidebarWidth = useLayoutStore((s) => s.sizes.diagramsSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const language = useLanguageStore((s) => s.language);
  const t = useT();
  // In the store rather than here, so the guided tour can put this window on screen for the step
  // that is about it. See `aiOpen` in `diagramsStore`.
  const aiOpen = useDiagramsStore((s) => s.aiOpen);
  const setAiOpen = useDiagramsStore((s) => s.setAiOpen);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(
    null,
  );

  useEffect(() => {
    void ensureDiagramsStoreLoaded();
  }, []);

  // The unsaved edit, written when the view goes away — a workspace switch, a window close, the
  // user navigating to another app on the rail. `flush` is a no-op when nothing is dirty, so this
  // costs nothing in the common case and is the difference between losing a shape and not in the
  // uncommon one.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void useDiagramsStore.getState().flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void useDiagramsStore.getState().flush();
      // The AI window does not survive leaving the app, which is what it did for free while this
      // was component state. It focuses its box as it opens, so a panel left up in March would
      // otherwise take the caret the next time this view is walked into.
      useDiagramsStore.getState().setAiOpen(false);
    };
  }, []);

  if (workspaceId === null) {
    return (
      <EmptyState
        icon={Workflow}
        title={t("diagrams.noWorkspaceTitle")}
        subtitle={t("diagrams.noWorkspaceSubtitle")}
      />
    );
  }

  /**
   * Saves the open diagram as a template.
   *
   * The draft is read at call time rather than subscribed to: this component deliberately does not
   * re-render per stroke (see the selectors above), so a subscribed copy would be one edit stale.
   */
  const saveAsTemplate = () => {
    const draft = useDiagramsStore.getState().draft;
    if (!draft) return;
    void promptAction(t("diagrams.saveTemplatePrompt"), {
      initial: openTitle,
      confirmLabel: t("diagrams.saveAsTemplate"),
    }).then(async (name) => {
      if (!name) return;
      await createTemplate(name, "", "workflow", draft.doc, draft.format, []);
      useToastStore.getState().pushToast(t("diagrams.templateSaved"), "success");
    });
  };

  /** `at` is in window coordinates — see `injectToolbarButtons`, which translates them out of the
   *  iframe so the menu lands under the pointer. */
  const openExportMenu = (at: { x: number; y: number }) => {
    setExportMenu({
      x: at.x,
      y: at.y,
      // `.drawio` last, after the three pictures: it is the one that leaves with the diagram still
      // editable, so it reads as "or take the whole thing elsewhere" rather than as a fourth image.
      items: (["png", "svg", "pdf", "drawio"] as const).map((format) => ({
        label: t(`diagrams.exportAs.${format}`),
        onClick: () => requestExport(format),
      })),
    });
  };

  const status = saving
    ? t("diagrams.saving")
    : dirty
      ? t("diagrams.unsaved")
      : savedAt
        ? t("diagrams.savedAt", { when: relativeTime(savedAt, language) })
        : "";

  return (
    <div className={`flex h-full min-h-0 ${CARD}`} data-tour="diagrams-view">
      <div
        style={{ width: sidebarWidth }}
        className="flex shrink-0 flex-col border-r border-[var(--cf-border)]"
      >
        {loading ? <ViewSkeleton /> : <DiagramExplorer />}
      </div>

      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={200}
        max={480}
        onChange={(value) => setSize("diagramsSidebarWidth", value)}
        onCommit={(value) => commitSize("diagramsSidebarWidth", value)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {activeId === null ? (
          <DiagramGallery />
        ) : (
          <>
            {/* The one strip of CodeFlow's own chrome over the editor. Everything below it is
                draw.io's UI, which cannot be restyled — so this bar carries the two things the
                editor has no way to say: which diagram this is, and whether it is saved. */}
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
              <button
                type="button"
                className={ICON_BUTTON}
                title={t("diagrams.backToGallery")}
                aria-label={t("diagrams.backToGallery")}
                onClick={() => void closeDiagram()}
              >
                <ArrowLeft size={14} />
              </button>
              {/* Only while undoing the generation is still what the user would mean by "undo".
                  It disappears on the next real edit — see `clearGenerationUndo`. draw.io's own
                  ⌘Z cannot do this: a `load` resets its undo stack. */}
              {canUndoGeneration && (
                <button
                  type="button"
                  className={ICON_BUTTON}
                  title={t("diagrams.undoGeneration")}
                  aria-label={t("diagrams.undoGeneration")}
                  onClick={() => undoLastGeneration()}
                  // The tour has a step about this button. It is conditional, so that step lists
                  // the editor pane behind it as a fallback — see `DIAGRAMS_TOUR`.
                  data-tour="diagrams-undo"
                >
                  <Undo2 size={14} />
                </button>
              )}
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                {openTitle || (
                  <span className="italic text-[var(--cf-text-muted)]">
                    {t("diagrams.untitled")}
                  </span>
                )}
              </span>
              {status && (
                <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{status}</span>
              )}
            </header>
            {/* Keyed on the diagram, so switching from one to another rebuilds the frame rather
                than reusing an editor that already holds the previous document. draw.io takes its
                document once, at `init`, and has no "replace everything" that also resets the undo
                history — which a different diagram must. */}
            {/* `relative`, because the AI panel positions itself against this box — the editor
                pane — rather than against the window. Dragging it can then be clamped to the canvas
                it is written about. */}
            <div className="relative min-h-0 flex-1">
              <DrawioFrame
                key={activeId}
                diagramId={activeId}
                onSaveAsTemplate={saveAsTemplate}
                onExport={openExportMenu}
                onAskAi={() => setAiOpen(true)}
              />
              {aiOpen && <DiagramAiPanel onClose={() => setAiOpen(false)} />}
            </div>
          </>
        )}
      </div>

      {exportMenu && (
        <ContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          items={exportMenu.items}
          onClose={() => setExportMenu(null)}
        />
      )}
    </div>
  );
}
