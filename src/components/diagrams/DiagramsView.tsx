import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, History as HistoryIcon, Sparkles, Undo2, Workflow } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { DiagramExplorer } from "./DiagramExplorer";
import { DiagramGallery } from "./DiagramGallery";
import { DrawioFrame } from "./DrawioFrame";
/**
 * The schema editor, behind a `lazy` boundary for the reason `NoteEditor` puts Monaco behind one:
 * it carries the code editor and four panels, and a workspace of drawings should not pay for it.
 * `DrawioFrame` needs no such treatment — its weight is an iframe, which is already only fetched
 * when one is mounted.
 */
const DbmlWorkbench = lazy(() =>
  import("../dbml/DbmlWorkbench").then((module) => ({ default: module.DbmlWorkbench })),
);
import { DiagramAiPanel } from "./DiagramAiPanel";
import { ExportImageModal } from "./ExportImageModal";
import { VersionHistoryModal } from "../common/VersionHistoryModal";
import { diagramsListVersions, diagramsVersionContent } from "../../lib/tauri/diagramsCommands";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { CARD, ICON_BUTTON } from "./diagramsChrome";
import { relativeTime } from "../notes/notesChrome";
import { FORMAT_DBML } from "../../lib/diagrams/doc";
import { ensureDiagramsStoreLoaded, useDiagramsStore } from "../../state/diagramsStore";
import type { ImageExportFormat } from "../../lib/diagrams/exportOptions";
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
  /**
   * Whether the open diagram has a generation waiting to be looked at. A boolean for the same
   * reason as the one above it — the graph itself would re-render this component for nothing.
   *
   * It exists because a result now outlives the window that asked for it: a run followed from
   * another workspace lands the user on the right diagram with the answer parked and *nothing on
   * screen saying so*, since the AI window closed with the workspace it was opened in. This is
   * what says so, and re-opens the window on the preview rather than applying anything itself.
   */
  const hasParkedGeneration = useDiagramsStore(
    (s) => s.activeId !== null && s.aiByDiagram[s.activeId]?.status === "ready",
  );
  // Booleans and a string, deliberately, and not `s.draft`. The draft object is replaced on every
  // edit, so subscribing to it would re-render this component — and therefore the whole explorer
  // beside it — once per stroke of the pen.
  const dirty = useDiagramsStore((s) => s.draft?.dirty ?? false);
  const saving = useDiagramsStore((s) => s.saving);
  const savedAt = useDiagramsStore((s) => s.savedAt);
  const openTitle = useDiagramsStore(
    (s) => s.diagrams.find((d) => d.id === s.activeId)?.title ?? "",
  );
  /**
   * Which editor the open diagram calls for.
   *
   * Read from the *row* rather than from the draft, so it is known before the document arrives —
   * the editor is mounted on `activeId`, and waiting for `draft.format` would flash the drawing
   * editor over a schema for as long as the fetch takes.
   */
  const openFormat = useDiagramsStore(
    (s) => s.diagrams.find((d) => d.id === s.activeId)?.format ?? "",
  );
  const isSchema = openFormat === FORMAT_DBML;

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
  /**
   * The format whose picture options are being edited, or `null` for "no dialog".
   *
   * Local state, like `exportMenu` beside it, and for the same reason: nothing outside this
   * component has any say in whether the dialog is up, and a store field would be one more thing
   * to remember to clear on a workspace switch. It also costs nothing here — this component's
   * selectors are picked so that drawing on the canvas does not re-render it (see above), and a
   * boolean that changes twice per export does not undo that.
   */
  const [optionsFor, setOptionsFor] = useState<ImageExportFormat | null>(null);
  /** The version-history dialog. Local: nothing outside this view opens it. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeTitle = useDiagramsStore(
    (s) => s.diagrams.find((entry) => entry.id === s.activeId)?.title ?? "",
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
      // It is also the only one that exports on the click, which is why it is the only label
      // without an ellipsis — the three pictures open the options dialog first, and `.drawio` has
      // nothing to ask about because nothing is rendered for it. TypeScript narrows the other
      // branch to `ImageExportFormat` on its own, so `ExportImageModal` needs no cast to be sure
      // of that. `ContextMenu` closes itself before running this, so the menu is not left hanging
      // behind the dialog.
      items: (["png", "svg", "pdf", "drawio"] as const).map((format) => ({
        label: t(`diagrams.exportAs.${format}`),
        onClick: () => (format === "drawio" ? requestExport({ format }) : setOptionsFor(format)),
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
              <button
                type="button"
                className={ICON_BUTTON}
                title={t("versions.open")}
                aria-label={t("versions.open")}
                onClick={() => setHistoryOpen(true)}
              >
                <HistoryIcon size={14} />
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
              {/* The parked answer's way back onto the screen, and conditional for the same reason
                  the undo button beside it is: it is here only while there is something waiting on
                  this diagram, and gone the moment it is applied or replaced. It *opens the
                  window* rather than applying — nothing goes onto the canvas unread. */}
              {hasParkedGeneration && !aiOpen && (
                <button
                  type="button"
                  className={ICON_BUTTON}
                  title={t("diagrams.ai.apply")}
                  aria-label={t("diagrams.ai.apply")}
                  onClick={() => setAiOpen(true)}
                >
                  <Sparkles size={14} />
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
              {/* The one place the format decides anything. Both editors take the same two
                  callbacks and write through the same store; what differs is the dialect they
                  read — see `types/diagrams.ts`. The schema workbench carries its own toolbar, so
                  it needs no `onExport`: draw.io's export lives in draw.io's toolbar, and this
                  one's lives in its own. */}
              {isSchema ? (
                <Suspense fallback={<ViewSkeleton />}>
                  <DbmlWorkbench
                    key={activeId}
                    diagramId={activeId}
                    onSaveAsTemplate={saveAsTemplate}
                    onAskAi={() => setAiOpen(true)}
                  />
                </Suspense>
              ) : (
                <DrawioFrame
                  key={activeId}
                  diagramId={activeId}
                  onSaveAsTemplate={saveAsTemplate}
                  onExport={openExportMenu}
                  onAskAi={() => setAiOpen(true)}
                />
              )}
              {/* Keyed on the diagram for the same reason the frame above it is, and told which
                  one it is drawing for rather than reading "whatever is open" when its answer
                  lands. Without the key, an instruction typed about one diagram — and the busy
                  chrome around it — would straddle a switch to the next; without `diagramId`, a
                  generation could only ever be applied to the diagram that happened to be open
                  when it came back. */}
              {aiOpen && (
                <DiagramAiPanel
                  key={activeId}
                  diagramId={activeId}
                  onClose={() => setAiOpen(false)}
                />
              )}
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

      {optionsFor && <ExportImageModal format={optionsFor} onClose={() => setOptionsFor(null)} />}

      {historyOpen && activeId && (
        <VersionHistoryModal
          title={activeTitle}
          listVersions={() => diagramsListVersions(activeId)}
          readVersion={(versionId) => diagramsVersionContent(versionId)}
          // Through `editDoc` and then `flush`, not a direct write: `editDoc` is what the draw.io
          // frame is reloaded from, and `flush` is what records the pre-restore drawing as a
          // version on the way past. See the same pair in `NoteEditor`.
          onRestore={async (doc) => {
            useDiagramsStore.getState().editDoc(doc);
            await useDiagramsStore.getState().flush();
            await useDiagramsStore.getState().openDiagram(activeId);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
