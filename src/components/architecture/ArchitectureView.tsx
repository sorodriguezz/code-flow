import { lazy, Suspense, useEffect } from "react";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { explorerClass } from "../common/recipes";
import { ensureArchitectureStoreLoaded, useArchitectureStore } from "../../state/architectureStore";
import { useArchitectureViewStore } from "../../state/architectureViewStore";
import { useLayoutStore } from "../../state/layoutStore";
import { ArchitectureExplorer } from "./ArchitectureExplorer";
import { ArchSourceDialog } from "./sources/ArchSourceDialog";

/** React Flow, the layout engine and the icon packs arrive the first time a document is opened. */
const ArchEditor = lazy(() => import("./ArchEditor").then((m) => ({ default: m.ArchEditor })));

/** The empty canvas: the same dotted well the editor's drawing sits on, with nothing on it. */
const DOTS = {
  backgroundImage: "radial-gradient(color-mix(in oklab, var(--cf-text) 14%, transparent) 1px, transparent 1.4px)",
  backgroundSize: "20px 20px",
} as const;

/**
 * Arquitectura — architecture diagrams built by dragging components onto a canvas or generated
 * from a source (repositories, documents, a brief, a cloud account), with lenses that review,
 * simulate, record decisions and answer questions from those same sources. The explorer on the left,
 * the open document beside it.
 */
export function ArchitectureView() {
  const loading = useArchitectureStore((s) => s.loading);
  const activeId = useArchitectureStore((s) => s.activeId);
  const draftId = useArchitectureStore((s) => s.draft?.id ?? null);
  const sidebarWidth = useLayoutStore((s) => s.sizes.architectureSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  useEffect(() => {
    void ensureArchitectureStoreLoaded();
  }, []);

  // A different document: what was selected, the environment and the simulation's dials go.
  useEffect(() => {
    useArchitectureViewStore.getState().resetForDocument();
  }, [draftId]);

  // The unsaved edit, written when the window hides and when the view goes away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void useArchitectureStore.getState().flush({ interactive: false });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void useArchitectureStore.getState().flush({ interactive: false });
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="arch-view">
      <div style={{ width: sidebarWidth }} className={explorerClass}>
        {loading ? <ViewSkeleton /> : <ArchitectureExplorer />}
      </div>
      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={180}
        max={420}
        onChange={(value) => setSize("architectureSidebarWidth", value)}
        onCommit={(value) => commitSize("architectureSidebarWidth", value)}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <Suspense fallback={<ViewSkeleton />}>
            <ArchEditor />
          </Suspense>
        ) : (
          <div className="h-full bg-[var(--cf-sunken)]" style={DOTS} />
        )}
      </div>
      <ArchSourceDialog />
    </div>
  );
}
