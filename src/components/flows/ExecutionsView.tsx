import { useEffect, useMemo, useState } from "react";
import { CircleAlert, FileDiff, FlaskConical, RotateCcw, Square, StepForward, Trash2, Undo2, Waypoints } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { fieldClass, rowClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { DataModeSwitch, ItemsView, type DataMode } from "./DataView";
import { LogLines } from "./RunLog";
import { MODE_KEY, NODE_STATUS_KEY, RUN_STATUS_KEY, formatDuration, formatWhen, itemsLabel, statusColor } from "./runFormat";
import { WaitCard } from "./WaitCard";
import { testFromRun } from "./FlowTestsView";
import { promptAction } from "../../state/promptStore";
import { familyColor, nodeIcon } from "../../lib/flows/nodeIcons";
import {
  flowsMetrics,
  flowsRunEdits,
  flowsRunLog,
  flowsRunNodeData,
  flowsCancelRun,
  flowsListRuns,
  flowsRetryRun,
  flowsUndoEdits,
  type FlowLogLine,
  type FlowMetrics,
  type FlowRunEdits,
  type FlowNodeData,
  type FlowRunNodeRow,
  type FlowRunRow,
} from "../../lib/tauri/flowsCommands";
import { chooseAction } from "../../state/confirmStore";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

/**
 * A flow's executions: the list on the left, the selected one on the right as a waterfall — one row
 * per node, a bar from when it started to when it finished — and, under it, the selected node's
 * input, output and log, read from the run's own files.
 */

function StatusDot({ status }: { status: FlowRunRow["status"] | FlowRunNodeRow["status"] }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${status === "running" ? "cf-flow-pulse" : ""}`}
      style={{ background: statusColor(status) }}
    />
  );
}

export function ExecutionsView() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const flowId = useFlowsStore((s) => s.draft?.id ?? "");
  const history = useFlowRunsStore((s) => s.history[flowId]);
  const selected = useFlowRunsStore((s) => s.selectedRun);

  useEffect(() => {
    if (flowId) void useFlowRunsStore.getState().loadHistory(flowId);
  }, [flowId]);

  // «Buscar»: the runs whose filed data («Datos de la ejecución»), id or error hold the text.
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<FlowRunRow[] | null>(null);
  useEffect(() => {
    const text = search.trim();
    if (!text || !flowId) {
      setFound(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void flowsListRuns(flowId, 200, null, text)
        .then((list) => alive && setFound(list))
        .catch(() => alive && setFound([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [search, flowId]);
  const rows = found ?? history?.rows ?? [];
  useEffect(() => {
    if (!selected && rows.length > 0) useFlowRunsStore.getState().selectRun(rows[0].id);
  }, [selected, rows]);

  return (
    <div className="flex min-h-0 flex-1" data-tour="flows-executions">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_45%,var(--cf-surface))]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-2">
          <span className="text-[12px] font-semibold" title={t("flows.executions.retention")}>
            {t("flows.executions.title")}
          </span>
          <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{rows.length}</span>
          <span className="flex-1" />
          <button
            type="button"
            className={iconButtonClass({ size: "sm" })}
            title={t("flows.executions.clear")}
            aria-label={t("flows.executions.clear")}
            disabled={rows.every((row) => row.status === "running")}
            onClick={() =>
              void chooseAction({
                message: t("flows.executions.clearConfirm"),
                danger: true,
                choices: [{ id: "clear", label: t("flows.executions.clear"), variant: "danger" }],
              }).then((answer) => answer === "clear" && void useFlowRunsStore.getState().clearRuns(flowId))
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
        <MetricsStrip flowId={flowId} version={`${rows.length}:${rows[0]?.id ?? ""}:${rows[0]?.status ?? ""}`} />
        <div className="shrink-0 px-2 pt-1.5">
          <input
            className={fieldClass({ size: "sm", className: "w-full" })}
            value={search}
            placeholder={t("flows.executions.search")}
            aria-label={t("flows.executions.search")}
            title={t("flows.executions.searchHint")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && !history?.loading && <p className="px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.executions.none")}</p>}
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={rowClass(row.id === selected, "h-auto flex-col items-stretch gap-0.5 py-1.5")}
              onClick={() => useFlowRunsStore.getState().selectRun(row.id)}
            >
              <span className="flex items-center gap-2">
                <StatusDot status={row.status} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{formatWhen(row.startedAt, language)}</span>
                <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{formatDuration(row.durationMs)}</span>
              </span>
              <span className="flex items-center gap-2 pl-4 text-[11px] text-[var(--cf-text-faint)]">
                <span>{t(RUN_STATUS_KEY[row.status] ?? "flows.status.error")}</span>
                <span>·</span>
                <span>{t(MODE_KEY[row.mode] ?? "flows.mode.manual")}</span>
              </span>
              {row.customData && Object.keys(row.customData).length > 0 && (
                <span className="truncate pl-4 text-left font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                  {Object.entries(row.customData)
                    .slice(0, 3)
                    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
                    .join(" · ")}
                </span>
              )}
            </button>
          ))}
          {history?.more && rows.length > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded-md py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
              onClick={() => void useFlowRunsStore.getState().loadHistory(flowId, true)}
            >
              {t("flows.executions.more")}
            </button>
          )}
        </div>
      </aside>
      {selected ? <RunDetail key={selected} runId={selected} flowId={flowId} /> : <div className="flex-1" />}
    </div>
  );
}

/** The last 30 local days, `0` = today's key. */
function lastDays(count: number): string[] {
  const out: string[] = [];
  const day = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() - i);
    out.push(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/**
 * How the flow has been doing over its last 30 days of kept executions: a bar per day (green the
 * ones that went well, red the failed), the share without error and the typical time, and — when
 * there is one — the node it fails at most and the slowest. Nothing at all before a first run.
 */
function MetricsStrip({ flowId, version }: { flowId: string; version: string }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
  useEffect(() => {
    let alive = true;
    if (flowId) void flowsMetrics(flowId, 30).then((next) => alive && setMetrics(next)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [flowId, version]);
  const days = useMemo(() => {
    const byDate = new Map((metrics?.days ?? []).map((d) => [d.date, d]));
    return lastDays(30).map((date) => ({ date, success: byDate.get(date)?.success ?? 0, error: byDate.get(date)?.error ?? 0 }));
  }, [metrics]);
  if (!metrics || metrics.runs === 0) return null;
  const tallest = Math.max(1, ...days.map((d) => d.success + d.error));
  const rate = Math.round((metrics.success / Math.max(1, metrics.success + metrics.error)) * 100);
  const failing = metrics.failingNodes[0];
  const slowest = metrics.slowNodes[0];
  const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(language, { day: "numeric", month: "short" });
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-[var(--cf-border)] px-3 py-2" title={t("flows.metrics.window")}>
      <div className="flex h-[26px] items-end gap-[2px]" aria-hidden>
        {days.map((d) => (
          <span
            key={d.date}
            className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-[2px] bg-[color-mix(in_oklab,var(--cf-border)_45%,transparent)]"
            style={{ height: `${Math.max(8, ((d.success + d.error) / tallest) * 100)}%` }}
            title={t("flows.metrics.day", { date: dayLabel(d.date), ok: d.success, bad: d.error })}
          >
            <span style={{ height: `${((d.success) / Math.max(1, d.success + d.error)) * 100}%`, background: d.success + d.error ? "var(--cf-success)" : "transparent" }} />
            <span style={{ height: `${(d.error / Math.max(1, d.success + d.error)) * 100}%`, background: "var(--cf-danger)" }} />
          </span>
        ))}
      </div>
      <span className="truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">{t("flows.metrics.summary", { runs: metrics.runs, rate })}</span>
      {metrics.medianMs !== null && (
        <span className="truncate text-[11px] tabular-nums text-[var(--cf-text-faint)]">
          {t("flows.metrics.timing", { median: formatDuration(metrics.medianMs), p95: formatDuration(metrics.p95Ms) })}
        </span>
      )}
      {(failing || slowest) && (
        <span
          className="truncate text-[11px] text-[var(--cf-text-faint)]"
          title={slowest ? t("flows.metrics.slowest", { node: slowest.name, time: formatDuration(slowest.avgMs) }) : undefined}
        >
          {failing
            ? t("flows.metrics.failsAt", { node: failing.name, count: failing.count })
            : slowest && t("flows.metrics.slowest", { node: slowest.name, time: formatDuration(slowest.avgMs) })}
        </span>
      )}
    </div>
  );
}

function RunDetail({ runId, flowId }: { runId: string; flowId: string }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const detail = useFlowRunsStore((s) => s.details[runId]);
  const selectedNode = useFlowRunsStore((s) => s.selectedRunNode);
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void useFlowRunsStore.getState().loadRun(runId);
  }, [runId]);
  // A waiting run is still going: its clock runs and it can be stopped.
  const running = detail?.run.status === "running" || detail?.run.status === "waiting";
  const openWaits = useFlowRunsStore((s) => s.waits);
  const waits = useMemo(() => openWaits.filter((wait) => wait.runId === runId), [openWaits, runId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const nodes = useMemo(() => [...(detail?.nodes ?? [])].sort((a, b) => a.seq - b.seq || a.nodeName.localeCompare(b.nodeName)), [detail]);
  /** Starts this run again and moves the list onto the new one. An untrusted flow is refused by
   *  the backend with the same answer a manual run gets. */
  const retry = async (fromFailed: boolean) => {
    try {
      const next = await flowsRetryRun(runId, fromFailed);
      useFlowRunsStore.getState().selectRun(next.id);
    } catch (error) {
      pushErrorToast(String(error));
    }
  };
  if (!detail) return <div className="flex-1" />;
  const { run } = detail;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const span = Math.max(end - start, 1);
  const errorNode = nodes.find((node) => node.nodeId === run.errorNode);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-4">
        <StatusDot status={run.status} />
        <span className="text-[13.5px] font-semibold" style={{ color: statusColor(run.status) }}>
          {t(RUN_STATUS_KEY[run.status] ?? "flows.status.error")}
        </span>
        <span className="text-[12px] text-[var(--cf-text-muted)]">
          {new Date(run.startedAt).toLocaleString(language)} · {formatDuration(run.finishedAt ? run.durationMs : now - start)} ·{" "}
          {t(MODE_KEY[run.mode] ?? "flows.mode.manual")}
        </span>
        <span className="flex-1" />
        {running ? (
          <Button size="sm" variant="danger-ghost" onClick={() => void flowsCancelRun(run.id)}>
            <Square size={11} />
            {t("flows.run.stop")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => {
                useFlowRunsStore.setState((state) => ({
                  current: {
                    ...state.current,
                    [flowId]: { run, nodes: Object.fromEntries(detail.nodes.map((node) => [node.nodeId, node])), logs: [] },
                  },
                  pane: "editor",
                }));
                void flowsRunLog(run.id).then((logs) =>
                  useFlowRunsStore.setState((state) =>
                    state.current[flowId]?.run.id === run.id ? { current: { ...state.current, [flowId]: { ...state.current[flowId], logs } } } : {},
                  ),
                );
              }}
            >
              <Waypoints size={12} />
              {t("flows.executions.showOnCanvas")}
            </Button>
            {/* Again, with the input it had — a webhook's request cannot be sent twice by asking
                the sender. From the failure reuses what succeeded, so an expensive step that
                worked is not paid for again. The flow as it is *now*: fixing it is why you retry. */}
            {run.triggerNode && (
              <Button size="sm" title={t("flows.executions.retryHint")} onClick={() => void retry(false)}>
                <RotateCcw size={12} />
                {t("flows.executions.retry")}
              </Button>
            )}
            {run.triggerNode && run.status === "success" && (
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                title={t("flows.executions.saveAsTest")}
                aria-label={t("flows.executions.saveAsTest")}
                onClick={() =>
                  void promptAction(t("flows.tests.namePrompt"), { initial: t("flows.tests.defaultName", { when: new Date(run.startedAt).toLocaleString(language) }), confirmLabel: t("flows.tables.save") }).then(
                    (name) =>
                      name &&
                      void testFromRun(flowId, run, nodes, name, flowsRunNodeData)
                        .then(() => pushSuccessToast(t("flows.tests.saved", { name })))
                        .catch((error) => pushErrorToast(String(error))),
                  )
                }
              >
                <FlaskConical size={14} />
              </button>
            )}
            {run.triggerNode && run.status === "error" && (
              <Button size="sm" title={t("flows.executions.retryFailedHint")} onClick={() => void retry(true)}>
                <StepForward size={12} />
                {t("flows.executions.retryFailed")}
              </Button>
            )}
            <button
              type="button"
              className={iconButtonClass({ size: "sm" })}
              title={t("flows.executions.delete")}
              aria-label={t("flows.executions.delete")}
              onClick={() => void useFlowRunsStore.getState().deleteRun(flowId, run.id)}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {waits.length > 0 && (
        <div className="mx-4 mt-3 flex flex-col gap-2">
          {waits.map((wait) => (
            <WaitCard key={wait.id} wait={wait} showFlow={false} />
          ))}
        </div>
      )}
      {run.status === "error" && run.error && (
        <div className="mx-4 mt-3 flex gap-2 rounded-lg bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-danger)]">
          <CircleAlert size={14} className="mt-[1px] shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            {errorNode && <b className="font-semibold">{errorNode.nodeName}: </b>}
            <span className="font-mono text-[11.5px]">{run.error}</span>
          </span>
        </div>
      )}
      {!running && <RunEditsBar runId={run.id} />}
      <div className="min-h-0 shrink-0 overflow-y-auto px-2 py-2" style={{ maxHeight: "45%" }}>
        {nodes.map((node) => {
          const descriptor = catalogMap.get(node.nodeType);
          const Icon = nodeIcon(descriptor?.icon ?? "box");
          const from = node.startedAt ? (Date.parse(node.startedAt) - start) / span : 0;
          const to = node.finishedAt ? (Date.parse(node.finishedAt) - start) / span : node.status === "running" ? (now - start) / span : from;
          const bar = node.startedAt !== null;
          const out = node.itemsOut.reduce((a, b) => a + b, 0);
          return (
            <button
              key={node.nodeId}
              type="button"
              className={rowClass(selectedNode === node.nodeId, "h-8 gap-2")}
              onClick={() => useFlowRunsStore.getState().selectRunNode(node.nodeId)}
            >
              <span className="flex w-[200px] min-w-0 shrink-0 items-center gap-2">
                <span style={{ color: descriptor ? familyColor(descriptor.family) : undefined }} className="shrink-0">
                  <Icon size={14} />
                </span>
                <span className="min-w-0 truncate text-[12.5px]">{node.nodeName}</span>
              </span>
              <span className="relative h-[14px] min-w-0 flex-1 rounded-[4px] bg-[var(--cf-hover)]">
                {bar && (
                  <span
                    className={`absolute inset-y-0 rounded-[4px] ${node.status === "running" ? "cf-flow-pulse" : ""}`}
                    style={{
                      left: `${Math.min(Math.max(from, 0), 1) * 100}%`,
                      width: `max(3px, ${Math.max(0, Math.min(to, 1) - Math.max(from, 0)) * 100}%)`,
                      background: statusColor(node.status),
                      opacity: 0.85,
                    }}
                  />
                )}
              </span>
              <span className="w-[92px] shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                {bar ? formatDuration(node.durationMs ?? (node.status === "running" ? now - Date.parse(node.startedAt!) : null)) : t(NODE_STATUS_KEY[node.status])}
              </span>
              <span className="w-[70px] shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                {node.status === "skipped" ? "" : itemsLabel(t, out)}
              </span>
            </button>
          );
        })}
      </div>
      {selectedNode && <RunNodePanel runId={runId} node={nodes.find((n) => n.nodeId === selectedNode)} />}
    </div>
  );
}

/**
 * What the run's editing AI nodes changed, against the restore point they took before writing —
 * the diff, and a way to put it all back. Nothing when the run edited nothing (or it was undone).
 */
function RunEditsBar({ runId }: { runId: string }) {
  const t = useT();
  const [edits, setEdits] = useState<FlowRunEdits[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void flowsRunEdits(runId)
      .then((answer) => alive && setEdits(answer))
      .catch(() => alive && setEdits([]));
    return () => {
      alive = false;
    };
  }, [runId, tick]);
  const files = (edits ?? []).reduce((count, edit) => count + edit.files.length, 0);
  if (!edits || files === 0) return null;
  const undo = async () => {
    const answer = await chooseAction({
      message: t("flows.edits.undoConfirm"),
      danger: true,
      choices: [{ id: "undo", label: t("flows.edits.undo"), variant: "danger" }],
    });
    if (answer !== "undo") return;
    setBusy(true);
    try {
      const touched = await flowsUndoEdits(runId);
      pushSuccessToast(t("flows.edits.undone", { count: touched.length }));
      setTick((n) => n + 1);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-4 mt-3 rounded-lg border border-[var(--cf-border)] px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <FileDiff size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 truncate">{t("flows.edits.summary", { count: files })}</span>
        <Button size="sm" onClick={() => setOpen((on) => !on)}>
          {open ? t("flows.edits.hide") : t("flows.edits.show")}
        </Button>
        <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => void undo()}>
          <Undo2 size={12} />
          {t("flows.edits.undo")}
        </Button>
      </div>
      {open &&
        edits.map((edit) => (
          <div key={edit.path} className="mt-2 min-w-0">
            <div className="truncate font-mono text-[11px] text-[var(--cf-text-faint)]" title={edit.path}>
              {edit.path}
            </div>
            {edit.missing ? (
              <p className="mt-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("flows.edits.missing")}</p>
            ) : (
              <pre className="mt-1 max-h-[280px] overflow-auto rounded-md bg-[var(--cf-sunken)] p-2 font-mono text-[11px] leading-[1.45]">
                {(edit.diff || edit.files.join("\n")).split("\n").map((line, index) => (
                  <div
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "text-[var(--cf-success)]"
                        : line.startsWith("-")
                          ? "text-[var(--cf-danger)]"
                          : line.startsWith("diff ") || line.startsWith("@@")
                            ? "text-[var(--cf-text-muted)]"
                            : undefined
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            )}
          </div>
        ))}
    </div>
  );
}

function RunNodePanel({ runId, node }: { runId: string; node: FlowRunNodeRow | undefined }) {
  const t = useT();
  const [tab, setTab] = useState<"input" | "output" | "log">("output");
  const [mode, setMode] = useState<DataMode>("table");
  const [port, setPort] = useState(0);
  const [data, setData] = useState<FlowNodeData | null>(null);
  const [logs, setLogs] = useState<FlowLogLine[]>([]);
  const key = node ? `${node.nodeId}/${node.status}/${node.finishedAt ?? ""}` : "";
  useEffect(() => {
    if (!node || node.status === "running") return;
    let alive = true;
    void flowsRunNodeData(runId, node.nodeId, 200).then((answer) => alive && setData(answer));
    void flowsRunLog(runId).then((lines) => alive && setLogs(lines.filter((line) => line.nodeId === node.nodeId)));
    return () => {
      alive = false;
    };
    // `key` is the node's identity plus the state that changes its data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, key]);
  if (!node) return null;
  const ports = tab === "input" ? data?.inputs ?? [] : data?.outputs ?? [];
  const counts = tab === "input" ? data?.inputCounts ?? [] : data?.outputCounts ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--cf-border)]">
      <div className={`${underlineStripClass} h-9`}>
        {(["input", "output", "log"] as const).map((name) => (
          <button key={name} type="button" className={underlineTabClass(tab === name)} onClick={() => setTab(name)}>
            {t(name === "input" ? "flows.inspector.input" : name === "output" ? "flows.inspector.output" : "flows.log.title")}
            {tab === name && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded bg-[var(--cf-accent)]" />}
          </button>
        ))}
        <span className="flex-1" />
        {tab !== "log" && ports.length > 1 && (
          <span className="flex items-center gap-1">
            {ports.map((_, index) => (
              <button
                key={index}
                type="button"
                className={`rounded-md px-1.5 text-[11.5px] ${port === index ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"}`}
                onClick={() => setPort(index)}
              >
                {index + 1} · {counts[index] ?? 0}
              </button>
            ))}
          </span>
        )}
        {tab !== "log" && <DataModeSwitch mode={mode} onChange={setMode} />}
      </div>
      {node.error && tab === "output" && (
        <p className="mx-3 mt-2 whitespace-pre-wrap break-words rounded-md bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--cf-danger)]">
          {node.error}
        </p>
      )}
      {tab === "log" ? (
        <LogLines lines={logs} names={{}} onlyNode={node.nodeId} />
      ) : (
        <ItemsView items={ports[port] ?? []} total={counts[port] ?? 0} mode={mode} />
      )}
    </div>
  );
}

