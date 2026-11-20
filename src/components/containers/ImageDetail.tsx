import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Eye, EyeOff, Play, Trash2 } from "lucide-react";
import { RowAction, StateDot, TextView, ago, stateTone } from "./containerBits";
import { engineMenu } from "./containerActions";
import { BackButton, DetailHeader } from "./ContainersDetail";
import { CopyText, useInspect } from "./pageBits";
import { ImageGlyph } from "./imageGlyph";
import { imageRunConfig, imageUseCount, imageUsers, shortReference, splitLayers, type LayerStep, type RunConfig } from "./pageModel";
import { RunContainerDialog } from "./RunContainerDialog";
import { SecurityTab } from "./SecurityTab";
import { CountBar, MutedNote, NO_ROWS, PageTabs, Panel, fmtBytes } from "./ui";
import { containersImageHistory } from "../../lib/tauri/containersCommands";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { ContainerRow, ContainerSelection, ImageLayer, ImageRow, RuntimeId } from "../../types/containers";

/**
 * An image's own page, over the images' list: what it is in the head (its mark, name, id, size, who
 * runs it) with Run / Pull / Remove, and four tabs — its layers split into what it added and what its
 * base brought, how it runs (entrypoint, user, ports, environment…), its known vulnerabilities, and
 * the inspect document. It used to be a drawer beside the table, too narrow for a layer's command.
 */

type Tab = "layers" | "run" | "security" | "inspect";

export function ImageDetail({ selection }: { selection: ContainerSelection }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const row = useContainersStore((s) => ((s.lists[listKey(selection.runtime, selection.context, null, "images")]?.rows ?? NO_ROWS) as ImageRow[]).find((r) => r.reference === selection.id));
  const containers = (useContainersStore((s) => s.lists[listKey(selection.runtime, selection.context, null, "containers")]?.rows) ?? NO_ROWS) as ContainerRow[];
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const startJob = useContainersJobsStore((s) => s.start);
  const runtimeInfo = useContainersStore((s) => s.runtimes.find((r) => r.id === selection.runtime));
  const [tab, setTab] = useState<Tab>("layers");
  const [running, setRunning] = useState(false);
  const seen = useRef(false);
  const ref = row ? (row.dangling ? row.id : row.reference) : selection.id;
  const inspect = useInspect(selection.runtime, selection.context, "image", selection.runtime === "ctr" ? null : ref);
  const config = useMemo(() => (inspect.text ? imageRunConfig(inspect.text) : null), [inspect.text]);
  const users = useMemo(() => (row ? imageUsers(row, containers) : []), [row, containers]);

  // Removed (here or anywhere): back to the list rather than a page about nothing.
  useEffect(() => {
    if (row) seen.current = true;
    else if (seen.current) select(null);
  }, [row, select]);
  if (!row) return <MutedNote>{t("containers.gone")}</MutedNote>;

  const ctr = selection.runtime === "ctr";
  const menu = engineMenu({ runtime: selection.runtime, context: selection.context, object: "image", id: selection.id, image: row, t, act, select: () => select(selection) });
  const removable = menu.find((i) => i.danger);
  const count = imageUseCount(row, users);
  const repository = row.dangling ? "<none>" : shortReference(row.repository);
  const pull = () =>
    void startJob(
      t("containers.m.images.pulling", { name: row.reference }),
      { kind: "pull", runtime: selection.runtime, context: selection.context, target: row.reference },
      { refresh: ["images"], done: t("containers.done.pull", { name: row.reference }), runImage: row.reference },
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DetailHeader
        leading={
          <>
            <BackButton label={t("containers.section.images")} />
            <ImageGlyph reference={row.dangling ? "" : row.reference} size={34} />
          </>
        }
        title={
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[14px] font-semibold">{repository}</span>
            {!row.dangling && row.tag !== "<none>" && <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text-muted)]">:{row.tag}</span>}
          </span>
        }
        subtitle={
          <span className="flex min-w-0 items-center gap-1.5">
            <CopyText text={row.id} shown={row.id.replace(/^sha256:/, "").slice(0, 12)} toast={t("containers.m.images.copiedId")} title={t("containers.copyId")} />
            <span>·</span>
            <span>{row.sizeBytes !== null ? fmtBytes(row.sizeBytes) : row.size}</span>
            {row.created && (
              <>
                <span>·</span>
                <span title={row.created}>{ago(row.created, language)}</span>
              </>
            )}
            {config?.platform && (
              <>
                <span>·</span>
                <span className="font-mono">{config.platform}</span>
              </>
            )}
          </span>
        }
        menu={menu}
      >
        {!ctr && !row.dangling && (
          <>
            <RowAction label={t("containers.image.run")} onClick={() => setRunning(true)}>
              <Play size={13} className="text-[var(--cf-success)]" />
            </RowAction>
            <RowAction label={t("containers.image.pull")} onClick={pull}>
              <Download size={13} />
            </RowAction>
          </>
        )}
        {removable && (
          <RowAction label={t("containers.remove")} danger onClick={() => removable.onClick?.()}>
            <Trash2 size={13} />
          </RowAction>
        )}
      </DetailHeader>
      {count > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--cf-border)] px-4 py-1.5 text-[12px]">
          <span className="text-[var(--cf-text-muted)]">{t("containers.fact.usedBy")}</span>
          {users.length
            ? users.map((c) => (
                <button
                  key={c.id}
                  onClick={() => select({ runtime: selection.runtime, context: selection.context, namespace: null, object: "container", id: c.id, name: c.name })}
                  className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline"
                >
                  <StateDot tone={stateTone(c.state, c.health)} />
                  {c.name}
                </button>
              ))
            : t("containers.m.images.usedByMany", { count })}
        </div>
      )}
      <PageTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "layers", label: t("containers.m.image.tab.layers") },
          { value: "run", label: t("containers.m.image.tab.run") },
          ...(ctr || row.dangling ? [] : [{ value: "security" as Tab, label: t("containers.m.image.tab.security") }]),
          { value: "inspect", label: t("containers.m.image.tab.inspect") },
        ]}
      />
      {ctr ? (
        <MutedNote>{t("containers.ctrLimited")}</MutedNote>
      ) : tab === "layers" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <LayersView runtime={selection.runtime} context={selection.context} reference={ref} total={row.sizeBytes} platform={config?.platform} />
        </div>
      ) : tab === "run" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {inspect.error ? <MutedNote>{inspect.error}</MutedNote> : !config ? <MutedNote>{t("containers.m.loading")}</MutedNote> : <RunConfigView config={config} />}
        </div>
      ) : tab === "security" ? (
        <SecurityTab runtime={selection.runtime} context={selection.context} reference={ref} />
      ) : inspect.error ? (
        <MutedNote>{inspect.error}</MutedNote>
      ) : inspect.text === null ? (
        <MutedNote>{t("containers.m.loading")}</MutedNote>
      ) : (
        <TextView value={inspect.text} language="json" />
      )}
      {running && runtimeInfo && <RunContainerDialog runtime={runtimeInfo} context={selection.context} initialImage={row.reference} onClose={() => setRunning(false)} />}
    </div>
  );
}

/**
 * An image's history as two groups — what its Dockerfile added, what its base brought — each step
 * with its size and a bar against the biggest; steps that add no bytes say «ajustes». Also the
 * «Capas» tab of a build whose image is here.
 */
export function LayersView({ runtime, context, reference, total, platform }: { runtime: RuntimeId; context: string | null; reference: string; total?: number | null; platform?: string }) {
  const t = useT();
  const [layers, setLayers] = useState<{ rows: ImageLayer[] | null; error: string | null }>({ rows: null, error: null });
  useEffect(() => {
    let alive = true;
    setLayers({ rows: null, error: null });
    containersImageHistory(runtime, context, reference)
      .then((rows) => alive && setLayers({ rows, error: null }))
      .catch((e: unknown) => alive && setLayers({ rows: null, error: String(e) }));
    return () => {
      alive = false;
    };
  }, [runtime, context, reference]);
  const split = useMemo(() => (layers.rows ? splitLayers(layers.rows) : null), [layers.rows]);
  if (layers.error) return <p className="text-[12px] text-[var(--cf-text-muted)]">{layers.error}</p>;
  if (!split) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.loading")}</p>;
  const all = [...split.base, ...split.own];
  if (all.length === 0) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.images.noLayers")}</p>;
  const biggest = Math.max(...all.map((s) => s.size), 1);
  const sum = (steps: LayerStep[]) => steps.reduce((n, s) => n + s.size, 0);
  const filled = (steps: LayerStep[]) => steps.filter((s) => s.size > 0).length;
  const added = sum(split.own);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px] text-[var(--cf-text-muted)]">
        <span>
          <b className="font-semibold text-[var(--cf-text)]">{fmtBytes(total ?? sum(all))}</b> {t("containers.m.image.total")}
        </span>
        <span>
          <b className="font-semibold text-[var(--cf-text)]">{filled(all)}</b> {t("containers.m.image.layerCount")}
        </span>
        {split.base.length > 0 && (
          <span title={t("containers.m.image.baseHint")}>
            <b className="font-semibold text-[var(--cf-text)]">{fmtBytes(added)}</b> {t("containers.m.image.added")}
          </span>
        )}
        <span className="flex-1" />
        {platform && <span className="font-mono text-[11.5px]">{platform}</span>}
      </div>
      <LayerGroup title={t("containers.m.image.own")} steps={split.own} biggest={biggest} aside={t("containers.m.image.groupAside", { count: filled(split.own), size: fmtBytes(added) })} />
      {split.base.length > 0 && (
        <LayerGroup title={t("containers.m.image.base")} steps={split.base} biggest={biggest} aside={t("containers.m.image.groupAside", { count: filled(split.base), size: fmtBytes(sum(split.base)) })} />
      )}
    </div>
  );
}

function LayerGroup({ title, aside, steps, biggest }: { title: string; aside: string; steps: LayerStep[]; biggest: number }) {
  const t = useT();
  return (
    <Panel title={title} aside={aside}>
      <ol className="divide-y divide-[color-mix(in_srgb,var(--cf-border)_60%,transparent)]">
        {steps.map((step) => (
          <li key={step.index} className="flex min-h-[34px] items-center gap-3 px-3 py-1.5 hover:bg-[var(--cf-hover)]">
            <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">{step.index}</span>
            <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${step.size > 0 ? "font-medium text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`} title={step.command}>
              {step.command || "—"}
            </span>
            {step.size > 0 ? (
              <span className="flex w-[140px] shrink-0 flex-col items-end gap-1">
                <span className="font-mono text-[11.5px] tabular-nums text-[var(--cf-text)]">{fmtBytes(step.size)}</span>
                <CountBar value={step.size} max={biggest} width={140} />
              </span>
            ) : (
              <span className="w-[140px] shrink-0 text-right text-[11px] text-[var(--cf-text-faint)]">{t("containers.m.image.metadata")}</span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** «Cómo se ejecuta»: what a container of this image runs unless told otherwise. */
function RunConfigView({ config }: { config: RunConfig }) {
  const t = useT();
  const [reveal, setReveal] = useState(false);
  const mono = (text: string) => <span className="break-all font-mono text-[12px] text-[var(--cf-text)]">{text}</span>;
  const rows: [string, ReactNode][] = [
    [t("containers.m.image.run.command"), mono([config.entrypoint, config.cmd].filter(Boolean).join(" ") || "—")],
    [t("containers.m.image.run.user"), config.user ? mono(config.user) : <span className="text-[var(--cf-text-muted)]">{t("containers.m.image.run.rootDefault")}</span>],
    [t("containers.m.image.run.workdir"), config.workdir ? mono(config.workdir) : null],
    [t("containers.m.image.run.ports"), config.ports.length ? mono(config.ports.join(", ")) : null],
    [t("containers.m.image.run.volumes"), config.volumes.length ? mono(config.volumes.join(", ")) : null],
    [t("containers.m.image.run.healthcheck"), config.healthcheck ? mono(config.healthcheck) : null],
    [t("containers.m.image.run.stopSignal"), config.stopSignal ? mono(config.stopSignal) : null],
    [t("containers.m.image.run.platform"), config.platform ? mono(config.platform) : null],
  ];
  return (
    <div className="flex flex-col gap-3">
      <Panel title={t("containers.m.image.tab.run")} aside={t("containers.m.image.runAside")}>
        <dl className="divide-y divide-[color-mix(in_srgb,var(--cf-border)_60%,transparent)]">
          {rows
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <div key={label} className="grid grid-cols-[160px_1fr] gap-3 px-3 py-2 text-[12px]">
                <dt className="text-[var(--cf-text-muted)]">{label}</dt>
                <dd className="min-w-0">{value}</dd>
              </div>
            ))}
        </dl>
      </Panel>
      {config.env.length > 0 && (
        <Panel
          title={t("containers.m.image.run.env")}
          aside={
            config.env.some((e) => e.secret) ? (
              <button onClick={() => setReveal((v) => !v)} className="inline-flex items-center gap-1 hover:text-[var(--cf-text)]">
                {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            ) : undefined
          }
        >
          <dl className="divide-y divide-[color-mix(in_srgb,var(--cf-border)_60%,transparent)]">
            {config.env.map((e) => (
              <div key={e.name} className="grid grid-cols-[minmax(160px,max-content)_1fr] gap-3 px-3 py-1.5 font-mono text-[11.5px]">
                <dt className="text-[var(--cf-text-muted)]">{e.name}</dt>
                <dd className="min-w-0 break-all text-[var(--cf-text)]">{e.secret && !reveal ? <span className="text-[var(--cf-text-faint)]">•••••• ({t("containers.m.image.run.hidden")})</span> : e.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
      {config.labels.length > 0 && (
        <Panel title={t("containers.m.image.run.labels")} aside={String(config.labels.length)}>
          <dl className="divide-y divide-[color-mix(in_srgb,var(--cf-border)_60%,transparent)]">
            {config.labels.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[minmax(160px,max-content)_1fr] gap-3 px-3 py-1.5 font-mono text-[11.5px]">
                <dt className="text-[var(--cf-text-muted)]">{k}</dt>
                <dd className="min-w-0 break-all text-[var(--cf-text)]">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
    </div>
  );
}
