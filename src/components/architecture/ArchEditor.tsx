/**
 * One open architecture document: its toolbar (name, save state, environment, sources, history,
 * export, the side panel's toggle), the lens strip, and the work area — the component library and
 * the canvas, with the lens's panel beside them. The document's JSON is never on screen: it is what
 * an import reads and an export writes.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Download,
  Gauge,
  GitBranch,
  History,
  PanelRight,
  Scale,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import { variesByEnvironment } from "../../lib/architecture/types";
import { repoMenuItems } from "../../lib/repoMenu";
import { diagramsClearVersions, diagramsDeleteVersion, diagramsListVersions, diagramsVersionContent } from "../../lib/tauri/diagramsCommands";
import { useArchitectureStore } from "../../state/architectureStore";
import { useArchitectureViewStore, type Lens } from "../../state/architectureViewStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { ActiveUnderline } from "../common/ActivePill";
import { AiSparkles } from "../common/AiGlyph";
import { buttonClass, iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ResizeHandle } from "../common/ResizeHandle";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { VersionHistoryModal } from "../common/VersionHistoryModal";
import { inspectorClass, tabCountClass, toolbarClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { ArchCanvasArea } from "./canvas/ArchFlowCanvas";
import { exportArchitecture, type ArchExport } from "./exportArch";
import { useThemePalette } from "./palette";
import { ArchModelContext, useArchModel } from "./useArchModel";
import { AskPanel } from "./panels/AskPanel";
import { DecisionsPanel } from "./panels/DecisionsPanel";
import { DiagramPanel } from "./panels/DiagramPanel";
import { PanelFrame } from "./panels/PanelFrame";
import { ReviewPanel } from "./panels/ReviewPanel";
import { SimulatePanel } from "./panels/SimulatePanel";
import { useArchSourceDialog } from "./sources/ArchSourceDialog";

const LENS_ICON: Record<Lens, React.ReactNode> = {
  diagram: <Workflow size={14} />,
  review: <ShieldCheck size={14} />,
  simulate: <Gauge size={14} />,
  decisions: <Scale size={14} />,
  ask: <AiSparkles size={13} />,
};
const LENS_ORDER: Lens[] = ["diagram", "review", "simulate", "decisions", "ask"];

type Anchor = { top: number; bottom: number; left: number; right: number; align?: "start" | "end" };

export function ArchEditor() {
  const t = useT();
  const model = useArchModel();
  const palette = useThemePalette();
  const draft = useArchitectureStore((s) => s.draft);
  const item = useArchitectureStore((s) => s.items.find((i) => i.id === s.draft?.id));
  const saving = useArchitectureStore((s) => s.saving);
  const lastSavedAt = useArchitectureStore((s) => s.lastSavedAt);
  const fileConflict = useArchitectureStore((s) => s.fileConflict);
  const workspaceId = useArchitectureStore((s) => s.workspaceId);
  const lens = useArchitectureViewStore((s) => s.lens);
  const setLens = useArchitectureViewStore((s) => s.setLens);
  const diagramTab = useArchitectureViewStore((s) => s.diagramTab);
  const panelOpen = useArchitectureViewStore((s) => s.panelOpen);
  const setPanelOpen = useArchitectureViewStore((s) => s.setPanelOpen);
  const setEnv = useArchitectureViewStore((s) => s.setEnv);
  const openSources = useArchSourceDialog((s) => s.openAs);
  const panelWidth = useLayoutStore((s) => s.sizes.architecturePanelWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: Anchor } | null>(null);
  const [history, setHistory] = useState(false);

  if (!draft || !model) return null;
  const title = item?.title ?? model.doc.meta?.title ?? t("arch.untitled");
  const envs = model.doc.meta?.environments ?? {};
  const sources = model.doc.sources ?? [];
  const crit = model.findings.filter((f) => f.severity === "critical").length;
  const warn = model.findings.filter((f) => f.severity === "warning").length;
  const anchorOf = (el: Element, align: "start" | "end" = "end"): Anchor => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, align };
  };

  const exportMenu = (event: React.MouseEvent) => {
    const go = (kind: ArchExport, dark = false) => () => void exportArchitecture(kind, { scene: model.scene, doc: model.doc, text: model.text, title, dark });
    setMenu({
      x: event.clientX, y: event.clientY, anchor: anchorOf(event.currentTarget),
      items: [
        { label: t("arch.export.svgSheet"), onClick: go("svgSheet") },
        { label: t("arch.export.svg"), onClick: go("svg") },
        { label: t("arch.export.svgDark"), onClick: go("svgSheet", true) },
        { label: t("arch.export.png"), onClick: go("png") },
        { label: t("arch.export.pdf"), onClick: go("pdf") },
        { label: t("arch.export.json"), onClick: go("json"), separated: true },
      ],
    });
  };
  const repoMenu = (event: React.MouseEvent) => {
    const items = repoMenuItems({
      workspaceId,
      originPath: item?.originPath ?? "",
      own: true,
      onSave: (projectId) => void useArchitectureStore.getState().saveToRepo(projectId),
      onUnlink: () => void useArchitectureStore.getState().unlink(draft.id),
    });
    if (items.length) setMenu({ x: event.clientX, y: event.clientY, anchor: anchorOf(event.currentTarget, "start"), items });
  };
  const rename = () =>
    void promptAction(t("arch.renamePrompt"), { initial: title, confirmLabel: t("arch.rename") }).then((value) => value && void useArchitectureStore.getState().rename(draft.id, value));

  const status = fileConflict ? t("arch.status.conflict") : saving ? t("arch.status.saving") : draft.dirty ? t("arch.status.unsaved") : lastSavedAt ? t("arch.status.saved") : "";
  const sourcesLabel = sources.length ? t("arch.src.update") : t("arch.src.generate");

  return (
    <ArchModelContext.Provider value={model}>
      <div className="flex h-full min-h-0 flex-col" data-tour="arch-editor">
        <header className={`${toolbarClass} @container gap-1.5 pl-3`}>
          <Tooltip label={t("arch.rename")}>
            <button type="button" className="min-w-[48px] max-w-[min(360px,40cqw)] truncate rounded-md px-1.5 py-0.5 text-left text-[14px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]" onClick={rename}>{title}</button>
          </Tooltip>
          {item?.originPath ? (
            <Tooltip label={item.originPath}>
              <button type="button" className="inline-flex h-[22px] min-w-0 max-w-[220px] items-center gap-1 rounded-md px-1.5 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] @max-[720px]:hidden" onClick={repoMenu}>
                <GitBranch size={12} className="shrink-0" /><span className="truncate font-mono">{item.originPath.split(/[\\/]/).pop()}</span>
              </button>
            </Tooltip>
          ) : (
            <Tooltip label={t("arch.saveToRepo")}>
              <button type="button" className={iconButtonClass({ size: "xs" })} onClick={repoMenu} aria-label={t("arch.saveToRepo")}><GitBranch size={13} /></button>
            </Tooltip>
          )}
          <span className={`truncate whitespace-nowrap text-[11.5px] ${fileConflict ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-faint)]"}`}>{status}</span>
          <span className="min-w-2 flex-1" />
          {/* Only where it changes something: the environment fills in resource names (`api-{env}`)
              on the cards and in what is exported, and a document with none has nothing to switch. */}
          {Object.keys(envs).length > 1 && variesByEnvironment(model.doc) ? (
            <Tooltip label={t("arch.meta.environment")} description={t("arch.meta.environmentHint")}>
              <Segmented
                layoutId="arch-env"
                size="sm"
                value={model.env}
                onChange={(v) => setEnv(v)}
                ariaLabel={t("arch.meta.environment")}
                options={Object.entries(envs).map(([key, label]) => ({ value: key, label }))}
              />
            </Tooltip>
          ) : null}
          <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-[var(--cf-border)]" />
          <Tooltip label={sourcesLabel} description={sources.length ? sources.map((x) => x.name).join(" · ") : t("arch.src.none")}>
            <button type="button" className={buttonClass({ size: "sm", className: "gap-1.5" })} onClick={() => openSources("update")} data-tour="arch-sources-button" aria-label={sourcesLabel}>
              <AiSparkles size={13} />
              <span className="@max-[860px]:hidden">{sourcesLabel}</span>
              {sources.length ? <span className={tabCountClass}>{sources.length}</span> : null}
            </button>
          </Tooltip>
          <Tooltip label={t("arch.export")}>
            <button type="button" className={buttonClass({ size: "sm", className: "gap-1.5" })} onClick={exportMenu} aria-label={t("arch.export")}>
              <Download size={13} /><span className="@max-[700px]:hidden">{t("arch.export")}</span>
            </button>
          </Tooltip>
          <Tooltip label={t("arch.history")}>
            <button type="button" className={iconButtonClass({ size: "sm" })} onClick={() => setHistory(true)} aria-label={t("arch.history")}><History size={15} /></button>
          </Tooltip>
          <Tooltip label={panelOpen ? t("arch.panel.hide") : t("arch.panel.show")}>
            <button type="button" aria-pressed={panelOpen} className={iconButtonClass({ size: "sm", active: panelOpen })} onClick={() => useArchitectureViewStore.getState().togglePanel()} aria-label={panelOpen ? t("arch.panel.hide") : t("arch.panel.show")} data-tour="arch-panel-toggle">
              <PanelRight size={15} />
            </button>
          </Tooltip>
        </header>
        <div className={`${underlineStripClass} gap-5 px-4`} role="tablist" aria-label={t("arch.lenses")} data-tour="arch-lenses">
          {LENS_ORDER.map((l) => {
            const active = lens === l;
            const count = l === "review" ? crit + warn : l === "decisions" ? (model.doc.decisions ?? []).length : 0;
            return (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setLens(l);
                  if (!panelOpen) setPanelOpen(true);
                }}
                className={underlineTabClass(active)}
              >
                {active ? <ActiveUnderline layoutId="arch-lens" /> : null}
                <span className={active ? "text-[var(--cf-accent)]" : ""}>{LENS_ICON[l]}</span>
                {t(`arch.lens.${l}` as TranslationKey)}
                {count ? (
                  <span className={tabCountClass} style={l === "review" && crit ? { color: "var(--cf-danger)", background: "color-mix(in oklab, var(--cf-danger) 13%, transparent)" } : undefined}>{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <ArchCanvasArea model={model} palette={palette} lens={lens} documentKey={model.docId} />
            {model.error ? (
              <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex max-w-[70%] -translate-x-1/2 items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-danger)_35%,var(--cf-border))] bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] leading-[1.4] text-[var(--cf-text)] shadow-[var(--cf-shadow)]">
                <AlertTriangle size={14} className="mt-[1px] shrink-0 text-[var(--cf-danger)]" />
                {t("arch.parse.broken")}
              </div>
            ) : null}
          </div>
          {panelOpen ? (
            <>
              <ResizeHandle axis="x" invert value={panelWidth} min={280} max={560} onChange={(v) => setSize("architecturePanelWidth", v)} onCommit={(v) => commitSize("architecturePanelWidth", v)} />
              <aside style={{ width: panelWidth }} className={`${inspectorClass} overflow-hidden`} data-tour="arch-panel">
                <PanelFrame lens={lens} onClose={() => setPanelOpen(false)}>
                  {lens === "diagram" ? <DiagramPanel doc={model.doc} comps={model.comps} tab={diagramTab} /> : null}
                  {lens === "review" ? <ReviewPanel findings={model.findings} comps={model.comps} /> : null}
                  {lens === "simulate" ? <SimulatePanel sim={model.sim} comps={model.comps} /> : null}
                  {lens === "decisions" ? <DecisionsPanel doc={model.doc} comps={model.comps} patterns={model.patterns} /> : null}
                  {lens === "ask" ? <AskPanel /> : null}
                </PanelFrame>
              </aside>
            </>
          ) : null}
        </div>
        {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} /> : null}
        {history ? (
          <VersionHistoryModal
            title={title}
            listVersions={() => diagramsListVersions(draft.id)}
            readVersion={(versionId) => diagramsVersionContent(versionId)}
            deleteVersion={(versionId) => diagramsDeleteVersion(versionId)}
            clearVersions={() => diagramsClearVersions(draft.id)}
            onRestore={async (content) => {
              useArchitectureStore.getState().editText(content);
              await useArchitectureStore.getState().flush();
            }}
            onClose={() => setHistory(false)}
          />
        ) : null}
      </div>
    </ArchModelContext.Provider>
  );
}
