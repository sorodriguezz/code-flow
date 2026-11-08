import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Crosshair, Gauge, GitFork } from "lucide-react";
import { traceDependencies, type DependencyDirection } from "../../../lib/architecture/dependencies";
import type { Connection, ResolvedComponents } from "../../../lib/architecture/types";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { buttonClass } from "../../common/Button";
import { Segmented } from "../../common/Segmented";

interface Props {
  id: string;
  connections: readonly Connection[];
  comps: ResolvedComponents;
}

export function ComponentImpact(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section className="min-w-0 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--cf-hover)]">
        <GitFork size={15} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 text-[12px] font-semibold text-[var(--cf-text)]">{t("arch.impact.title")}</span>
        <ChevronDown size={14} className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? <ImpactRoutes {...props} /> : null}
    </section>
  );
}

function ImpactRoutes({ id, connections, comps }: Props) {
  const t = useT();
  const [direction, setDirection] = useState<DependencyDirection>("callers");
  const [syncOnly, setSyncOnly] = useState(false);
  const path = useArchitectureViewStore((s) => s.dependencyPath);
  const setPath = useArchitectureViewStore((s) => s.setDependencyPath);
  const { routes, pathTo } = useMemo(() => traceDependencies(connections, comps, id, direction, syncOnly), [connections, comps, id, direction, syncOnly]);
  const name = (key: string) => comps[key]?.name ?? key;
  const list = [...routes].sort(([a, ra], [b, rb]) => ra.hops - rb.hops || name(a).localeCompare(name(b)));
  const direct = list.filter(([, route]) => route.hops === 1).length;
  const current = path?.ids[direction === "callers" ? 0 : path.ids.length - 1];

  // Edge indexes belong to a revision of the diagram. Release the highlight if it changes.
  useEffect(() => () => setPath(null), [connections, comps, setPath]);

  const reveal = (target: string) => {
    const view = useArchitectureViewStore.getState();
    const route = target === current ? null : pathTo(target);
    view.setDependencyPath(route);
    if (route) view.focusOn(route.ids);
  };
  const simulate = () => {
    const view = useArchitectureViewStore.getState();
    view.setDown([...new Set([...view.down, id])]);
    view.setLens("simulate");
    view.focusOn([id]);
  };

  return (
    <div className="grid gap-2 border-t border-[var(--cf-border)] p-2.5" data-tour="arch-component-impact">
      <Segmented
        size="sm"
        full
        layoutId="arch-impact-direction"
        ariaLabel={t("arch.impact.direction")}
        value={direction}
        onChange={(value) => { setPath(null); setDirection(value); }}
        options={[
          { value: "callers", label: t("arch.impact.callers") },
          { value: "dependencies", label: t("arch.impact.dependencies") },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--cf-text-muted)]">
        <span title={t("arch.impact.shortest")}>{t("arch.impact.counts", { direct, indirect: list.length - direct })}</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--cf-accent)]" checked={syncOnly} onChange={(event) => { setPath(null); setSyncOnly(event.target.checked); }} />
          {t("arch.impact.syncOnly")}
        </label>
      </div>
      {list.length ? (
        <ul className="m-0 grid max-h-44 gap-0.5 overflow-y-auto overscroll-contain p-0">
          {list.map(([key, route]) => (
            <li key={key} className="min-w-0 list-none">
              <button type="button" aria-pressed={current === key} onClick={() => reveal(key)} title={name(key)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--cf-hover)] aria-pressed:bg-[var(--cf-accent-soft)]">
                <Crosshair size={13} className="shrink-0 text-[var(--cf-accent)]" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{name(key)}</span>
                {route.asynchronous ? <span className="text-[10.5px] text-[var(--cf-text-muted)]">{t("arch.impact.async")}</span> : null}
                <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">{route.hops === 1 ? t("arch.impact.direct") : t("arch.impact.hops", { n: route.hops })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 py-1 text-[11.5px] text-[var(--cf-text-muted)]">{t(direction === "callers" ? "arch.impact.noCallers" : "arch.impact.noDependencies")}</p>}
      {path ? (
        <div className="grid gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-2">
          <span className="text-[11px] font-semibold text-[var(--cf-text)]">{t("arch.impact.path")}</span>
          <ol aria-label={t("arch.impact.path")} className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {path.ids.map((key, index) => (
              <li key={key} className="flex min-w-0 items-center gap-1">
                {index ? <ChevronRight aria-hidden size={12} className="shrink-0" /> : null}<span className="min-w-0 break-words">{name(key)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {comps[id]?.category !== "actor" ? (
        <button type="button" className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={simulate}>
          <Gauge size={13} />{t("arch.impact.simulate")}
        </button>
      ) : null}
    </div>
  );
}
