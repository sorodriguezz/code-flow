import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsedPanelBar, useCollapsiblePanel } from "../common/CollapsedPanelBar";
import { explorerClass } from "../common/recipes";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { ContainersList, ContainersPane, useContainersPulse } from "./ContainersPanel";

/**
 * Contenedores as an app of the rail — Docker, Podman, Kubernetes and Azure, found on this machine.
 *
 * It lived in the bottom dock, beside the terminals and the services, until 2026-11-19: by then it
 * held three providers, seven sections, topology, compose, build and log analysis, and the dock's
 * height was the wrong shape for all of it (user: «tiene muchas funcionalidades»). The navigation is
 * the explorer on the left — foldable to a bar like every other side panel — and the page picked
 * there fills the rest.
 */
export function ContainersView() {
  const t = useT();
  // Views stay mounted once visited (see `App`): the engines are read only while this one is on
  // screen. A satellite's `activeView` is the app it holds, so the same test covers an island.
  const visible = useUiStore((s) => s.activeView === "containers");
  useContainersPulse(visible);
  const width = useLayoutStore((s) => s.sizes.containersListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const fold = useCollapsiblePanel("containersListWidth");

  return (
    <div className="flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="containers-view">
      {fold.collapsed ? (
        <CollapsedPanelBar label={t("containers.m.providers")} title={t("common.expandPanel")} onExpand={fold.expand} />
      ) : (
        <>
          <aside aria-label={t("containers.m.providers")} style={{ width }} className={`${explorerClass} flex min-h-0 shrink-0 flex-col`}>
            <ContainersList />
          </aside>
          <ResizeHandle
            axis="x"
            value={width}
            min={200}
            max={520}
            onChange={(value) => setSize("containersListWidth", value)}
            onCommit={(value) => commitSize("containersListWidth", value)}
            {...fold.handleProps}
          />
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <ContainersPane />
      </div>
    </div>
  );
}
