/**
 * The frame every lens's side panel sits in: a head with the lens's name — or, in Diagram, the
 * switch between its pages — and the close button; the panel's own body; and, along the foot, the
 * sources the lens reads from. What a lens is for lives in the head's tooltip, not in a paragraph
 * above the panel's first control.
 */
import type { ReactNode } from "react";
import { Info, X } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { useArchitectureViewStore, type DiagramTab, type Lens } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { iconButtonClass } from "../../common/Button";
import { Segmented } from "../../common/Segmented";
import { Tooltip } from "../../common/Tooltip";
import { SourcesBar } from "../sources/SourcesBar";

const TABS: Array<{ tab: DiagramTab; key: TranslationKey }> = [
  { tab: "inspector", key: "arch.tab.inspector" },
  { tab: "flow", key: "arch.tab.flow" },
  { tab: "notes", key: "arch.tab.notes" },
  { tab: "legend", key: "arch.tab.legend" },
];

const INTRO: Record<Exclude<Lens, "diagram">, TranslationKey> = {
  review: "arch.review.intro",
  simulate: "arch.sim.intro",
  decisions: "arch.dec.intro",
  ask: "arch.ask.intro",
};

export function PanelFrame({ lens, onClose, children }: { lens: Lens; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const diagramTab = useArchitectureViewStore((s) => s.diagramTab);
  const setDiagramTab = useArchitectureViewStore((s) => s.setDiagramTab);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] pl-3 pr-1.5">
        {lens === "diagram" ? (
          <Segmented
            layoutId="arch-diagram-tab"
            size="sm"
            full
            className="min-w-0 flex-1"
            value={diagramTab}
            onChange={setDiagramTab}
            ariaLabel={t("arch.lens.diagram")}
            options={TABS.map(({ tab, key }) => ({ value: tab, label: t(key) }))}
          />
        ) : (
          <>
            <h2 className="m-0 truncate text-[13px] font-semibold text-[var(--cf-text)]">{t(`arch.lens.${lens}` as TranslationKey)}</h2>
            <Tooltip label={t(`arch.lens.${lens}` as TranslationKey)} description={t(INTRO[lens])}>
              <span className="grid h-5 w-5 shrink-0 cursor-help place-items-center text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"><Info size={13} /></span>
            </Tooltip>
            <span className="flex-1" />
          </>
        )}
        <Tooltip label={t("arch.panel.hide")}>
          <button type="button" className={iconButtonClass({ size: "xs" })} onClick={onClose} aria-label={t("arch.panel.hide")}><X size={14} /></button>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {lens !== "ask" ? <SourcesBar /> : null}
    </div>
  );
}
