import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Pause, Play, RotateCw, Square, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Segmented } from "../common/Segmented";
import { RowAction, useInterval } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, EmptyLine, LiveMark, LoadingLine, NO_ROWS, PageHead, PageToolbar, PortChips, SearchField, StatePill, Td, Th, fmtBytes, fmtPercent, statusSince, trClass } from "./ui";
import { firstRead } from "./pageModel";
import { RunContainerDialog } from "./RunContainerDialog";
import { confirmAction } from "../../state/confirmStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { ContainerRow, ContainerStats, RuntimeInfo } from "../../types/containers";

/**
 * An engine's containers as lite-dock lists them: a table with what each one is doing right now —
 * state and for how long, ports a click opens, CPU and memory read live — its actions on the row,
 * the Compose projects as groups that start and stop together, and several picked at once.
 */

type Filter = "all" | "running" | "stopped";
type Menu = { x: number; y: number; items: MenuItem[] } | null;

const isUp = (row: ContainerRow) => row.state === "running" || row.state === "restarting";

/** The live sample for a row — the engine prints short ids, the list long ones. */
function statsFor(stats: ContainerStats[], row: ContainerRow): ContainerStats | undefined {
  return stats.find((s) => s.id && (row.id.startsWith(s.id) || s.id.startsWith(row.id) || s.name === row.name));
}

export function ContainersPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const list = useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "containers")]);
  const stats = useContainersStore((s) => s.stats[listKey(runtime.id, context, null, "stats")]) ?? NO_ROWS;
  const loadStats = useContainersStore((s) => s.loadStats);
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const busy = useContainersStore((s) => s.busy);
  const rows = (list?.rows ?? NO_ROWS) as ContainerRow[];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<Menu>(null);
  const [running, setRunning] = useState(false);

  const anyUp = rows.some(isUp);
  // CPU and memory, while the page is on screen and something runs (a sample takes about two seconds):
  // the first at once, rather than four seconds of dashes.
  const sampling = runtime.running && anyUp;
  useEffect(() => {
    if (sampling) void loadStats(runtime.id);
  }, [sampling, runtime.id, loadStats]);
  useInterval(() => void loadStats(runtime.id), 4000, sampling);

  const upCount = rows.filter(isUp).length;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "running" && !isUp(row)) return false;
      if (filter === "stopped" && isUp(row)) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.image.toLowerCase().includes(needle) ||
        row.id.startsWith(needle) ||
        row.project.toLowerCase().includes(needle) ||
        row.ports.some((p) => String(p.hostPort ?? "").includes(needle))
      );
    });
  }, [rows, query, filter]);
  const groups = useMemo(() => {
    const byProject = new Map<string, ContainerRow[]>();
    const alone: ContainerRow[] = [];
    for (const row of shown) {
      if (row.project) byProject.set(row.project, [...(byProject.get(row.project) ?? []), row]);
      else alone.push(row);
    }
    return { projects: [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b)), alone };
  }, [shown]);
  const pickedRows = rows.filter((r) => picked.has(r.id));
  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

  const run = (action: string, label: string, ids: string[]) => void act({ runtime: runtime.id, context, object: "container", action, ids, label });
  const togglePick = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: event.type === "contextmenu" ? event.clientX : rect.left, y: event.type === "contextmenu" ? event.clientY : rect.bottom + 2, items });
  };
  const rowMenu = (row: ContainerRow) =>
    engineMenu({
      runtime: runtime.id,
      context,
      object: "container",
      row,
      t,
      act,
      select: () => select({ runtime: runtime.id, context, namespace: null, object: "container", id: row.id, name: row.name }),
    });
  const open = (row: ContainerRow) => select({ runtime: runtime.id, context, namespace: null, object: "container", id: row.id, name: row.name });

  const bulkStart = (list: ContainerRow[]) => {
    const down = list.filter((r) => !isUp(r));
    const paused = down.filter((r) => r.state === "paused");
    const stopped = down.filter((r) => r.state !== "paused");
    if (stopped.length) run("start", t("containers.m.done.started", { count: stopped.length }), stopped.map((r) => r.id));
    if (paused.length) run("unpause", t("containers.m.done.resumed", { count: paused.length }), paused.map((r) => r.id));
  };
  const bulkStop = async (list: ContainerRow[], title?: string) => {
    const targets = list.filter((r) => isUp(r) || r.state === "paused");
    if (!targets.length) return;
    if (targets.length > 1 && !(await confirmAction(title ?? t("containers.m.confirmStopMany", { count: targets.length, names: targets.map((r) => r.name).join(", ") }), false, t("containers.stop")))) return;
    run("stop", t("containers.m.done.stopped", { count: targets.length }), targets.map((r) => r.id));
  };
  const bulkRemove = async () => {
    if (!pickedRows.length) return;
    const place = context || runtimeLabel(runtime.id, t);
    if (!(await confirmAction(t("containers.m.confirmRemoveMany", { count: pickedRows.length, names: pickedRows.map((r) => r.name).join(", "), context: place }), true, t("containers.remove")))) return;
    run("remove", t("containers.m.done.removed", { count: pickedRows.length }), pickedRows.map((r) => r.id));
    setPicked(new Set());
  };

  const rowView = (row: ContainerRow, inGroup: boolean) => {
    const up = isUp(row);
    const sample = up ? statsFor(stats, row) : undefined;
    const working = busy[`container|${row.id}`];
    return (
      <tr key={row.id} className={trClass(picked.has(row.id))} onContextMenu={(e) => openMenu(e, rowMenu(row))} onDoubleClick={() => open(row)}>
        <Td align="center" className="w-8">
          <Checkbox checked={picked.has(row.id)} onChange={() => togglePick(row.id)} />
        </Td>
        <Td>
          <div className={`flex min-w-0 flex-col ${inGroup ? "pl-4" : ""}`}>
            <button onClick={() => open(row)} title={t("containers.m.openDetail")} className="min-w-0 truncate text-left font-medium text-[var(--cf-text)] hover:text-[var(--cf-accent)] hover:underline">
              {inGroup && row.service ? row.service : row.name}
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(row.id).catch(() => {});
                pushSuccessToast(t("containers.m.copiedId"));
              }}
              title={t("containers.copyId")}
              className="flex w-fit items-center gap-1 font-mono text-[10.5px] text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"
            >
              {row.id.slice(0, 12)}
              <Copy size={9} className="opacity-0 group-hover:opacity-100" />
            </button>
          </div>
        </Td>
        <Td>
          {(() => {
            const { since, failedCode } = statusSince(row.status, language);
            return (
              <span className="flex min-w-0 items-center gap-1.5">
                <StatePill state={row.state} health={row.health} since={since} title={row.status} />
                {failedCode !== null && <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--cf-danger)_14%,transparent)] px-1 text-[10.5px] text-[var(--cf-danger)]">{t("containers.m.exitCode", { code: failedCode })}</span>}
              </span>
            );
          })()}
        </Td>
        <Td className="max-w-[220px]">
          <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={row.image}>
            {row.image}
          </span>
        </Td>
        <Td>
          <PortChips ports={row.ports} running={up} />
        </Td>
        <Td align="right" className="w-16 text-[var(--cf-text-muted)]">
          {sample ? fmtPercent(sample.cpuPercent) : "—"}
        </Td>
        <Td align="right" className="w-20 text-[var(--cf-text-muted)]">
          {sample ? fmtBytes(sample.memUsage) : "—"}
        </Td>
        <Td className="w-[104px]">
          <div className="flex items-center justify-end gap-0.5">
            {up ? (
              <>
                <RowAction label={t("containers.stop")} disabled={working} onClick={() => run("stop", t("containers.done.stop", { name: row.name }), [row.id])}>
                  <Square size={12} />
                </RowAction>
                <RowAction label={t("containers.restart")} disabled={working} onClick={() => run("restart", t("containers.done.restart", { name: row.name }), [row.id])}>
                  <RotateCw size={12} />
                </RowAction>
                <RowAction label={t("containers.pause")} disabled={working} onClick={() => run("pause", t("containers.done.pause", { name: row.name }), [row.id])}>
                  <Pause size={12} />
                </RowAction>
              </>
            ) : row.state === "paused" ? (
              <>
                <RowAction label={t("containers.unpause")} disabled={working} onClick={() => run("unpause", t("containers.done.unpause", { name: row.name }), [row.id])}>
                  <Play size={12} className="text-[var(--cf-success)]" />
                </RowAction>
                <RowAction label={t("containers.stop")} disabled={working} onClick={() => run("stop", t("containers.done.stop", { name: row.name }), [row.id])}>
                  <Square size={12} />
                </RowAction>
              </>
            ) : (
              <>
                <RowAction label={t("containers.start")} disabled={working} onClick={() => run("start", t("containers.done.start", { name: row.name }), [row.id])}>
                  <Play size={12} className="text-[var(--cf-success)]" />
                </RowAction>
                <RowAction
                  label={t("containers.remove")}
                  danger
                  disabled={working}
                  onClick={async () => {
                    const place = context || runtimeLabel(runtime.id, t);
                    if (await confirmAction(t("containers.confirmRemoveContainer", { name: row.name, context: place }), true, t("containers.remove"))) {
                      run("remove", t("containers.done.remove", { name: row.name }), [row.id]);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </RowAction>
              </>
            )}
            <RowAction label={t("containers.m.moreActions")} onClick={(e) => openMenu(e, rowMenu(row))}>
              <MoreHorizontal size={13} />
            </RowAction>
          </div>
        </Td>
      </tr>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead
        title={t("containers.section.containers")}
        sub={rows.length ? t("containers.m.countRunning", { count: rows.length, running: upCount }) : undefined}
      >
        <Button
          size="sm"
          variant="ghost"
          title={t("containers.prune.containers")}
          onClick={async () => {
            const place = context || runtimeLabel(runtime.id, t);
            if (await confirmAction(t("containers.prune.confirmContainers", { context: place }), true, t("containers.prune.confirm"))) {
              void act({ runtime: runtime.id, context, object: "container", action: "prune", ids: [], label: t("containers.prune.doneContainers") });
            }
          }}
          disabled={!runtime.running || !rows.some((r) => !isUp(r) && r.state !== "paused")}
        >
          <Trash2 size={13} />
          {t("containers.m.cleanUp")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setRunning(true)} disabled={!runtime.running || runtime.id === "ctr"}>
          <Play size={13} />
          {t("containers.m.runContainer")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.searchContainers")} />
        <Segmented
          layoutId="containers-filter"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `${t("containers.m.filter.all")} ${rows.length}` },
            { value: "running", label: `${t("containers.m.filter.running")} ${upCount}` },
            { value: "stopped", label: `${t("containers.m.filter.stopped")} ${rows.length - upCount}` },
          ]}
        />
        <div className="flex-1" />
        {runtime.running && <LiveMark />}
      </PageToolbar>
      {pickedRows.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3 text-[12px]">
          <span className="font-medium text-[var(--cf-text)]">{t("containers.m.picked", { count: pickedRows.length })}</span>
          <Button size="sm" variant="secondary" onClick={() => bulkStart(pickedRows)}>
            <Play size={12} />
            {t("containers.start")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void bulkStop(pickedRows)}>
            <Square size={12} />
            {t("containers.stop")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void bulkRemove()}>
            <Trash2 size={12} />
            {t("containers.remove")}
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            {t("containers.m.clearPick")}
          </Button>
        </div>
      )}
      {!runtime.running ? (
        <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
      ) : list?.error ? (
        <EmptyLine>{list.error}</EmptyLine>
      ) : firstRead(list) ? (
        <LoadingLine />
      ) : shown.length === 0 ? (
        <EmptyLine>{rows.length ? t("containers.m.noMatch") : t("containers.m.noContainers")}</EmptyLine>
      ) : (
        <DataTable minWidth={760}>
          <thead>
            <tr>
              <Th align="center" width={32}>
                <Checkbox checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((r) => r.id)))} />
              </Th>
              <Th>{t("containers.m.col.name")}</Th>
              <Th width={150}>{t("containers.m.col.state")}</Th>
              <Th>{t("containers.m.col.image")}</Th>
              <Th>{t("containers.m.col.ports")}</Th>
              <Th align="right" width={64}>
                CPU
              </Th>
              <Th align="right" width={80}>
                {t("containers.stat.memory")}
              </Th>
              <Th align="right" width={104}>
                {t("containers.m.col.actions")}
              </Th>
            </tr>
          </thead>
          <tbody>
            {groups.projects.map(([project, members]) => {
              const up = members.filter(isUp).length;
              const isFolded = folded.has(project);
              return [
                <tr
                  key={`project:${project}`}
                  className="group bg-[color-mix(in_srgb,var(--cf-hover)_55%,transparent)]"
                  onContextMenu={(e) => openMenu(e, engineMenu({ runtime: runtime.id, context, object: "project", project: { name: project, rows: members }, t, act, select: () => undefined }))}
                >
                  <Td align="center">
                    <Checkbox
                      checked={members.every((m) => picked.has(m.id))}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current);
                          const all = members.every((m) => next.has(m.id));
                          for (const m of members) {
                            if (all) next.delete(m.id);
                            else next.add(m.id);
                          }
                          return next;
                        })
                      }
                    />
                  </Td>
                  <td colSpan={7} className="h-8 border-b border-[color-mix(in_srgb,var(--cf-border)_55%,transparent)] px-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          setFolded((current) => {
                            const next = new Set(current);
                            if (next.has(project)) next.delete(project);
                            else next.add(project);
                            return next;
                          })
                        }
                        className="flex min-w-0 items-center gap-1.5 text-left"
                      >
                        {isFolded ? <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" /> : <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />}
                        <span className="truncate font-semibold text-[var(--cf-text)]">{project}</span>
                        <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("containers.m.projectRow", { up, total: members.length })}</span>
                      </button>
                      <div className="flex-1" />
                      {up < members.length && (
                        <Button size="sm" variant="ghost" onClick={() => bulkStart(members)}>
                          <Play size={12} />
                          {t("containers.m.startAll")}
                        </Button>
                      )}
                      {up > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => void bulkStop(members, t("containers.m.confirmStopProject", { name: project }))}>
                          <Square size={12} />
                          {t("containers.m.stopAll")}
                        </Button>
                      )}
                      <RowAction
                        label={t("containers.m.moreActions")}
                        onClick={(e) => openMenu(e, engineMenu({ runtime: runtime.id, context, object: "project", project: { name: project, rows: members }, t, act, select: () => undefined }))}
                      >
                        <MoreHorizontal size={13} />
                      </RowAction>
                    </div>
                  </td>
                </tr>,
                ...(isFolded ? [] : members.map((row) => rowView(row, true))),
              ];
            })}
            {groups.alone.map((row) => rowView(row, false))}
          </tbody>
        </DataTable>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {running && <RunContainerDialog runtime={runtime} context={context} onClose={() => setRunning(false)} />}
    </div>
  );
}
