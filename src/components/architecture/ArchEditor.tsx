import { useRef, type ReactNode } from "react";
import { AlertTriangle, Gauge, PanelRight, Scale, ShieldCheck, Workflow } from "lucide-react";
import { variesByEnvironment } from "../../lib/architecture/types";
import { LENSES, useArchitectureViewStore, type Lens } from "../../state/architectureViewStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { ActiveUnderline } from "../common/ActivePill";
import { AiSparkles } from "../common/AiGlyph";
import { iconButtonClass } from "../common/Button";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { fieldClass, inspectorClass, tabCountClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { ArchDocumentToolbar } from "./ArchDocumentToolbar";
import { ArchNavigator } from "./ArchNavigator";
import { ArchCanvasArea } from "./canvas/ArchFlowCanvas";
import { useThemePalette } from "./palette";
import { ArchModelContext, useArchModel } from "./useArchModel";
import { AskPanel } from "./panels/AskPanel";
import { DecisionsPanel } from "./panels/DecisionsPanel";
import { DiagramPanel } from "./panels/DiagramPanel";
import { PanelFrame } from "./panels/PanelFrame";
import { ReviewPanel } from "./panels/ReviewPanel";
import { SimulatePanel } from "./panels/SimulatePanel";

const LENS_ICON: Record<Lens, ReactNode> = {
  diagram: <Workflow size={14} />,
  review: <ShieldCheck size={14} />,
  simulate: <Gauge size={14} />,
  decisions: <Scale size={14} />,
  ask: <AiSparkles size={13} />,
};

export function ArchEditor({ documentsControl }: { documentsControl: ReactNode }) {
  const t = useT();
  const model = useArchModel();
  const palette = useThemePalette();
  const lens = useArchitectureViewStore((s) => s.lens);
  const setLens = useArchitectureViewStore((s) => s.setLens);
  const diagramTab = useArchitectureViewStore((s) => s.diagramTab);
  const panelOpen = useArchitectureViewStore((s) => s.panelOpen);
  const setPanelOpen = useArchitectureViewStore((s) => s.setPanelOpen);
  const panelWidth = useLayoutStore((s) => s.sizes.architecturePanelWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const detailsRef = useRef<HTMLElement>(null);

  if (!model) return null;
  const envs = Object.entries(model.doc.meta?.environments ?? {});
  const reviewCount = model.findings.filter((f) => f.severity === "critical" || f.severity === "warning").length;
  const hasCritical = model.findings.some((f) => f.severity === "critical");
  const counts = { diagram: 0, review: reviewCount, simulate: 0, decisions: model.doc.decisions?.length ?? 0, ask: 0 };
  const panelLabel = t(panelOpen ? "arch.panel.hide" : "arch.panel.show");

  return (
    <ArchModelContext.Provider value={model}>
      <div className="flex min-h-0 flex-1 flex-col" data-tour="arch-editor">
        <ArchDocumentToolbar model={model} documentsControl={documentsControl} />
        <div className="flex shrink-0 items-stretch border-b border-[var(--cf-border)] bg-[var(--cf-surface)]">
          <div className={`${underlineStripClass} min-w-0 flex-1 !border-b-0`} role="group" aria-label={t("arch.lenses")} data-tour="arch-lenses">
            {LENSES.map((view) => {
              const active = lens === view;
              const label = t(`arch.lens.${view}`);
              const count = counts[view];
              return (
                <button
                  key={view}
                  type="button"
                  aria-pressed={active}
                  aria-label={count ? `${label} (${count})` : label}
                  title={label}
                  onClick={() => setLens(view)}
                  className={underlineTabClass(active, "px-0.5 focus-visible:-outline-offset-2")}
                >
                  {active ? <ActiveUnderline layoutId="arch-lens" /> : null}
                  <span className={active ? "text-[var(--cf-accent)]" : ""}>{LENS_ICON[view]}</span>
                  <span className="@max-[580px]:hidden">{label}</span>
                  {count ? <span aria-hidden className={`${tabCountClass} ${view === "review" && hasCritical ? "!text-[var(--cf-danger)]" : ""}`}>{count}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1 border-l border-[var(--cf-border)] px-2">
            <ArchNavigator scene={model.scene} />
            {envs.length > 1 && variesByEnvironment(model.doc) ? (
              <Tooltip label={t("arch.meta.environment")} description={t("arch.meta.environmentHint")}>
                <select className={fieldClass({ size: "sm", className: "max-w-[120px] @max-[520px]:max-w-[85px]" })} value={model.env} aria-label={t("arch.meta.environment")} onChange={(event) => useArchitectureViewStore.getState().setEnv(event.target.value)}>
                  {envs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Tooltip>
            ) : null}
            <Tooltip label={panelLabel}>
              <button type="button" aria-pressed={panelOpen} className={iconButtonClass({ size: "sm", active: panelOpen })} onClick={() => useArchitectureViewStore.getState().togglePanel()} aria-label={panelLabel} data-tour="arch-panel-toggle">
                <PanelRight size={15} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="relative isolate flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <ArchCanvasArea model={model} palette={palette} lens={lens} documentKey={model.docId} detailsRef={detailsRef} />
            {model.error ? (
              <div role="alert" className="pointer-events-none absolute left-1/2 top-3 z-10 flex max-w-[70%] -translate-x-1/2 items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-danger)_35%,var(--cf-border))] bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] leading-[1.4] text-[var(--cf-text)] shadow-[var(--cf-shadow)]">
                <AlertTriangle size={14} className="mt-[1px] shrink-0 text-[var(--cf-danger)]" />
                {t("arch.parse.broken")}
              </div>
            ) : null}
          </div>
          {panelOpen ? (
            <>
              <div className="relative shrink-0 @max-[960px]:hidden">
                <ResizeHandle axis="x" invert value={panelWidth} min={280} max={560} onChange={(v) => setSize("architecturePanelWidth", v)} onCommit={(v) => commitSize("architecturePanelWidth", v)} />
              </div>
              <aside ref={detailsRef} style={{ width: panelWidth }} className={`${inspectorClass} overflow-hidden @max-[960px]:absolute @max-[960px]:bottom-14 @max-[960px]:right-2 @max-[960px]:top-2 @max-[960px]:z-20 @max-[960px]:max-w-[85%] @max-[960px]:rounded-xl @max-[960px]:border @max-[960px]:!bg-[var(--cf-surface-solid,var(--cf-surface))] @max-[960px]:shadow-[var(--cf-shadow)]`} aria-label={t("arch.panel.label")} data-tour="arch-panel">
                <PanelFrame lens={lens} onClose={() => setPanelOpen(false)}>
                  {lens === "diagram" ? <DiagramPanel doc={model.doc} comps={model.comps} tab={diagramTab} /> : null}
                  {lens === "review" ? <ReviewPanel model={model} /> : null}
                  {lens === "simulate" ? <SimulatePanel doc={model.doc} sim={model.sim} comps={model.comps} /> : null}
                  {lens === "decisions" ? <DecisionsPanel doc={model.doc} comps={model.comps} patterns={model.patterns} /> : null}
                  {lens === "ask" ? <AskPanel /> : null}
                </PanelFrame>
              </aside>
            </>
          ) : null}
        </div>
      </div>
    </ArchModelContext.Provider>
  );
}
