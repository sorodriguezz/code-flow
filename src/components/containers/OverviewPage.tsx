import { useEffect, useMemo, useState } from "react";
import { Eraser, Loader2, Power } from "lucide-react";
import { Button } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { Facts, RowAction, SectionTitle, useInterval } from "./containerBits";
import { runtimeLabel } from "./containerActions";
import { LiveMark, NO_ROWS, PageHead, Td, Th, fmtBytes, fmtPercent } from "./ui";
import { MutedLine, useEngineList } from "./pageBits";
import { rowOfStats, topByUsage } from "./pageModel";
import { containersDiskUsage } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { listKey, useContainersStore, type EngineSection } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, DiskUsageRow, ImageRow, NetworkRow, RuntimeInfo, VolumeRow } from "../../types/containers";

/**
 * An engine at a glance, lite-dock's dashboard without its engine settings: what it is and which
 * version answers, how much it holds (each count a way into its page), the disk it takes and what a
 * clean-up would give back, and the containers working hardest right now.
 */

type Busiest = "cpu" | "memory";

/** The prune behind a kind's «Limpiar» — none for the build cache, which `act` has no verb for. */
const PRUNE: Partial<Record<DiskUsageRow["kind"], { object: string; confirm: TranslationKey; done: TranslationKey; label: TranslationKey }>> = {
  images: { object: "image", confirm: "containers.prune.confirmImages", done: "containers.prune.doneImages", label: "containers.prune.images" },
  containers: { object: "container", confirm: "containers.prune.confirmContainers", done: "containers.prune.doneContainers", label: "containers.prune.containers" },
  volumes: { object: "volume", confirm: "containers.prune.confirmVolumes", done: "containers.prune.doneVolumes", label: "containers.prune.volumes" },
};

const KIND_LABEL: Record<DiskUsageRow["kind"], TranslationKey> = {
  images: "containers.section.images",
  containers: "containers.section.containers",
  volumes: "containers.section.volumes",
  buildCache: "containers.m.overview.buildCache",
};

export function OverviewPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const containers = useEngineList<ContainerRow>(runtime.id, context, "containers");
  const images = useEngineList<ImageRow>(runtime.id, context, "images");
  const volumes = useEngineList<VolumeRow>(runtime.id, context, "volumes");
  const networks = useEngineList<NetworkRow>(runtime.id, context, "networks");
  const stats = useContainersStore((s) => s.stats[listKey(runtime.id, context, null, "stats")]) ?? NO_ROWS;
  const loadStats = useContainersStore((s) => s.loadStats);
  const refreshList = useContainersStore((s) => s.refreshList);
  const startRuntime = useContainersStore((s) => s.startRuntime);
  const starting = useContainersStore((s) => s.starting[runtime.id]);
  const setNav = useContainersStore((s) => s.setNav);
  const select = useContainersStore((s) => s.select);
  const act = useContainersStore((s) => s.act);
  const [disk, setDisk] = useState<{ rows: DiskUsageRow[] | null; error: string | null }>({ rows: null, error: null });
  const [diskRead, setDiskRead] = useState(0);
  const [busiest, setBusiest] = useState<Busiest>("cpu");
  const ctr = runtime.id === "ctr";
  const place = context || runtimeLabel(runtime.id, t);

  useEffect(() => {
    if (!runtime.running) return;
    for (const what of ["containers", "images", "volumes", "networks"]) void refreshList(runtime.id, what);
  }, [runtime.id, runtime.running, context, refreshList]);

  useEffect(() => {
    if (!runtime.running) return;
    let alive = true;
    containersDiskUsage(runtime.id, context)
      .then((rows) => {
        if (alive) setDisk({ rows, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setDisk({ rows: null, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [runtime.id, runtime.running, context, diskRead]);

  const up = useMemo(() => containers.rows.filter((row) => row.state === "running"), [containers.rows]);
  // CPU and memory while the page is on screen and something runs; a sample takes about two seconds.
  useInterval(() => void loadStats(runtime.id), 5000, runtime.running && !ctr && up.length > 0);
  // The last sample can still name a container stopped since: only the running ones rank.
  const top = useMemo(() => topByUsage(stats.filter((sample) => up.some((row) => rowOfStats([row], sample))), busiest), [stats, up, busiest]);
  const memTop = Math.max(1, ...top.map((sample) => sample.memUsage));
  const diskTotal = (disk.rows ?? []).reduce((sum, row) => sum + row.size, 0);
  const diskReclaimable = (disk.rows ?? []).reduce((sum, row) => sum + row.reclaimable, 0);

  const prune = async (kind: DiskUsageRow["kind"]) => {
    const how = PRUNE[kind];
    if (!how || !(await confirmAction(t(how.confirm, { context: place }), true, t("containers.prune.confirm")))) return;
    await act({ runtime: runtime.id, context, object: how.object, action: "prune", ids: [], label: t(how.done) });
    setDiskRead((n) => n + 1);
  };
  const count = (list: { list: unknown; rows: unknown[] }) => (list.list ? list.rows.length : "—");
  const tiles: { section: EngineSection; label: TranslationKey; value: string | number; total?: number }[] = [
    { section: "containers", label: "containers.section.containers", value: containers.list ? up.length : "—", total: containers.list ? containers.rows.length : undefined },
    { section: "images", label: "containers.section.images", value: count(images) },
    { section: "volumes", label: "containers.section.volumes", value: count(volumes) },
    { section: "networks", label: "containers.section.networks", value: count(networks) },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.m.section.overview")} sub={[runtimeLabel(runtime.id, t), runtime.provider, runtime.serverVersion ?? runtime.version].filter(Boolean).join(" · ")}>
        {runtime.running && <LiveMark />}
      </PageHead>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!runtime.running && (
          <div className="flex items-center gap-3 px-3 pt-3 text-[12px] text-[var(--cf-text-muted)]">
            <span className="min-w-0">{runtime.problem ?? t("containers.notRunningHint")}</span>
            {runtime.start && (
              <Button size="sm" variant="secondary" onClick={() => void startRuntime(runtime)} disabled={starting}>
                {starting ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                {starting ? t("containers.startingRuntime") : t("containers.startRuntime")}
              </Button>
            )}
          </div>
        )}
        {/* Two rows that fold to one column on a narrow dock: what the engine is and holds, then where
            its disk goes and who is busy. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-x-8 gap-y-4 px-3 pt-3">
          <section className="min-w-0">
            <SectionTitle>{t("containers.m.overview.engine")}</SectionTitle>
            <Facts
              rows={[
                [t("containers.fact.provider"), runtime.provider],
                [t("containers.fact.client"), runtime.version],
                [t("containers.fact.server"), runtime.serverVersion],
                [t("containers.fact.context"), context],
                [t("containers.fact.binary"), <span className="break-all font-mono text-[11.5px]">{runtime.binary}</span>],
              ]}
            />
          </section>
          {runtime.running && (
            <section className="min-w-0">
              <SectionTitle>{t("containers.m.overview.holds")}</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {tiles.map((tile) => (
                  <button
                    key={tile.section}
                    onClick={() => setNav({ runtime: runtime.id, section: tile.section })}
                    className="flex min-w-0 flex-col items-start rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-left transition-colors duration-100 hover:border-[var(--cf-accent)]"
                  >
                    <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{t(tile.label)}</span>
                    <span className="text-[16px] font-semibold tabular-nums text-[var(--cf-text)]">
                      {tile.value}
                      {tile.total !== undefined && <span className="text-[12px] font-normal text-[var(--cf-text-muted)]"> / {tile.total}</span>}
                    </span>
                    {tile.total !== undefined && <span className="text-[10.5px] text-[var(--cf-text-faint)]">{t("containers.m.filter.running")}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(440px,1fr))] gap-x-8 gap-y-4 px-3 py-3">
          {runtime.running && (
            <section className="min-w-0">
              <div className="flex items-baseline gap-2">
                <SectionTitle>{t("containers.m.overview.disk")}</SectionTitle>
                {disk.rows && diskTotal > 0 && (
                  <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{t("containers.m.overview.diskSub", { size: fmtBytes(diskTotal), reclaimable: fmtBytes(diskReclaimable) })}</span>
                )}
              </div>
              {disk.error ? (
                <MutedLine>{disk.error}</MutedLine>
              ) : !disk.rows ? (
                <MutedLine>{t("containers.m.loading")}</MutedLine>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-separate border-spacing-0 text-[12px] [&_td]:whitespace-nowrap">
                    <thead>
                      <tr>
                        <Th>{t("containers.fact.type")}</Th>
                        <Th align="right">{t("containers.m.overview.count")}</Th>
                        <Th align="right">{t("containers.fact.active")}</Th>
                        <Th align="right">{t("containers.m.images.col.size")}</Th>
                        <Th align="right">{t("containers.m.overview.reclaimable")}</Th>
                        <Th width={28} />
                      </tr>
                    </thead>
                    <tbody>
                      {disk.rows.map((row) => {
                        const how = PRUNE[row.kind];
                        return (
                          <tr key={row.kind}>
                            <Td className="text-[var(--cf-text)]">{KIND_LABEL[row.kind] ? t(KIND_LABEL[row.kind]) : row.kind}</Td>
                            <Td align="right" className="text-[var(--cf-text-muted)]">
                              {row.count}
                            </Td>
                            <Td align="right" className="text-[var(--cf-text-muted)]">
                              {row.active}
                            </Td>
                            <Td align="right">{fmtBytes(row.size)}</Td>
                            <Td align="right" className={row.reclaimable > 0 ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"}>
                              {fmtBytes(row.reclaimable)}
                            </Td>
                            <Td align="center">
                              {how && row.reclaimable > 0 && (
                                <RowAction label={t(how.label)} onClick={() => void prune(row.kind)}>
                                  <Eraser size={12} />
                                </RowAction>
                              )}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {runtime.running && !ctr && (
            <section className="min-w-0">
              <div className="flex items-center gap-2">
                <SectionTitle>{t("containers.m.overview.busiest")}</SectionTitle>
                <div className="flex-1" />
                <Segmented
                  layoutId="overview-busiest"
                  size="sm"
                  value={busiest}
                  onChange={setBusiest}
                  options={[
                    { value: "cpu", label: "CPU" },
                    { value: "memory", label: t("containers.stat.memory") },
                  ]}
                />
              </div>
              {up.length === 0 ? (
                <MutedLine>{t("containers.m.overview.nothingRunning")}</MutedLine>
              ) : top.length === 0 ? (
                <MutedLine>{t("containers.m.overview.noStats")}</MutedLine>
              ) : (
                <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
                  <colgroup>
                    <col />
                    <col className="w-[132px]" />
                    <col className="w-[132px]" />
                  </colgroup>
                  <tbody>
                    {top.map((sample) => {
                      const row = rowOfStats(up, sample);
                      const memShare = sample.memLimit > 0 ? sample.memPercent : (sample.memUsage / memTop) * 100;
                      return (
                        <tr key={sample.id || sample.name}>
                          <Td>
                            {row ? (
                              <button
                                onClick={() => select({ runtime: runtime.id, context, namespace: null, object: "container", id: row.id, name: row.name })}
                                title={t("containers.m.openDetail")}
                                className="block max-w-full truncate text-left text-[var(--cf-text)] hover:text-[var(--cf-accent)] hover:underline"
                              >
                                {row.name}
                              </button>
                            ) : (
                              <span className="block truncate text-[var(--cf-text)]">{sample.name}</span>
                            )}
                          </Td>
                          <Td>
                            <Meter share={sample.cpuPercent} label={fmtPercent(sample.cpuPercent)} strong={busiest === "cpu"} />
                          </Td>
                          <Td>
                            <Meter share={memShare} label={fmtBytes(sample.memUsage)} strong={busiest === "memory"} />
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** A plain bar and its number — a sparkline says nothing over five samples of five containers. */
function Meter({ share, label, strong }: { share: number; label: string; strong: boolean }) {
  const width = Math.max(0, Math.min(100, Number.isFinite(share) ? share : 0));
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--cf-hover)]">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${width}%`, background: strong ? "var(--cf-accent)" : "var(--cf-text-faint)" }} />
      </span>
      <span className={`tabular-nums ${strong ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>{label}</span>
    </span>
  );
}
