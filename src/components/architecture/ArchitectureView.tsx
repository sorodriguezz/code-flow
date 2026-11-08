import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { LoaderCircle, PanelLeft } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { explorerClass, toolbarClass } from "../common/recipes";
import { ensureArchitectureStoreLoaded, useArchitectureStore } from "../../state/architectureStore";
import { useArchitectureViewStore } from "../../state/architectureViewStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { ArchitectureExplorer } from "./ArchitectureExplorer";
import { ArchitectureHome } from "./ArchitectureHome";
import { ArchSourceDialog } from "./sources/ArchSourceDialog";

/** React Flow, the layout engine and the icon packs arrive the first time a document is opened. */
const ArchEditor = lazy(() => import("./ArchEditor").then((m) => ({ default: m.ArchEditor })));

function ArchitectureLoading({ opening = false }: { opening?: boolean }) {
  const t = useT();
  return (
    <div role="status" className="grid min-h-0 flex-1 place-items-center bg-[var(--cf-sunken)] text-[13px] text-[var(--cf-text-muted)]">
      <span className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin text-[var(--cf-accent)]" />{t(opening ? "arch.loading.document" : "arch.loading.workspace")}</span>
    </div>
  );
}

/**
 * Arquitectura — architecture diagrams built by dragging components onto a canvas or generated
 * from a source (repositories, documents, a brief, a cloud account), with lenses that review,
 * simulate, record decisions and answer questions from those same sources. The explorer on the left,
 * the open document beside it.
 */
export function ArchitectureView() {
  const t = useT();
  const loading = useArchitectureStore((s) => s.loading);
  const opening = useArchitectureStore((s) => s.opening);
  const draftId = useArchitectureStore((s) => s.draft?.id ?? null);
  const sidebarWidth = useLayoutStore((s) => s.sizes.architectureSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const root = useRef<HTMLDivElement>(null);
  const explorerPanel = useRef<HTMLElement>(null);
  const documentsButton = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [wideExplorer, setWideExplorer] = useState(true);
  const [compactExplorer, setCompactExplorer] = useState(false);
  const explorerOpen = compact ? compactExplorer : wideExplorer;
  const setExplorerOpen = compact ? setCompactExplorer : setWideExplorer;
  const closeExplorer = () => {
    setExplorerOpen(false);
    requestAnimationFrame(() => documentsButton.current?.focus());
  };

  useEffect(() => {
    void ensureArchitectureStoreLoaded();
  }, []);

  useEffect(() => {
    const view = root.current;
    if (!view) return;
    const resize = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 920));
    resize.observe(view);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    if (compact && explorerOpen) {
      const panel = explorerPanel.current;
      (panel?.querySelector("input") ?? panel)?.focus();
    }
  }, [compact, explorerOpen]);

  // A different document: what was selected, the environment and the simulation's dials go.
  useEffect(() => {
    useArchitectureViewStore.getState().resetForDocument();
    setCompactExplorer(false);
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

  const documentsLabel = t(explorerOpen ? "arch.documents.hide" : "arch.documents.show");
  const documentsControl = (
    <Tooltip label={documentsLabel}>
      <button ref={documentsButton} type="button" className={iconButtonClass({ size: "md", active: explorerOpen })} aria-label={documentsLabel} aria-expanded={explorerOpen} aria-controls={explorerOpen ? "arch-documents" : undefined} onClick={() => setExplorerOpen(!explorerOpen)}>
        <PanelLeft size={16} />
      </button>
    </Tooltip>
  );

  return (
    <div ref={root} className="relative isolate flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="arch-view">
      {explorerOpen ? (
        <>
          {compact ? <div aria-hidden className="absolute inset-0 z-30 bg-black/30" onClick={closeExplorer} /> : null}
          <aside
            ref={explorerPanel}
            id="arch-documents"
            aria-label={t("arch.documents")}
            tabIndex={compact ? -1 : undefined}
            style={{ width: compact ? Math.min(Math.max(sidebarWidth, 240), 320) : sidebarWidth }}
            className={`${explorerClass} ${compact ? "absolute inset-y-0 left-0 z-40 max-w-[calc(100%_-_40px)] !bg-[var(--cf-surface-solid,var(--cf-surface))] shadow-[var(--cf-shadow)]" : ""}`}
            onKeyDown={(event) => {
              if (compact && event.key === "Escape" && !event.defaultPrevented) closeExplorer();
            }}
          >
            {loading ? <ViewSkeleton /> : <ArchitectureExplorer onClose={closeExplorer} />}
          </aside>
          {!compact ? (
            <ResizeHandle axis="x" value={sidebarWidth} min={180} max={420} onChange={(value) => setSize("architectureSidebarWidth", value)} onCommit={(value) => commitSize("architectureSidebarWidth", value)} />
          ) : null}
        </>
      ) : null}
      <div className="@container relative flex min-w-0 flex-1 flex-col" inert={compact && explorerOpen}>
        {draftId ? (
          <Suspense fallback={<ArchitectureLoading opening />}>
            <div className={`flex min-h-0 flex-1 flex-col ${opening ? "invisible" : ""}`} inert={!!opening}>
              <ArchEditor key={draftId} documentsControl={documentsControl} />
            </div>
          </Suspense>
        ) : (
          <>
            <header className={`${toolbarClass} gap-2 pl-2.5`}>
              {documentsControl}
              <span className="text-[13px] font-semibold text-[var(--cf-text)]">{t("arch.home.overview")}</span>
            </header>
            {loading ? <ArchitectureLoading /> : <ArchitectureHome />}
          </>
        )}
        {opening ? <div className="absolute inset-0 z-20 flex"><ArchitectureLoading opening /></div> : null}
      </div>
      <ArchSourceDialog />
    </div>
  );
}
