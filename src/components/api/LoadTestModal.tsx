import { useEffect, useRef, useState } from "react";
import { Gauge, Loader2, Play, Square } from "lucide-react";
import { ApiModal } from "./ApiModal";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { statusColor } from "./methodStyle";
import { apiLoadStop, apiLoadTest, onLoadProgress, type LoadReport } from "../../lib/tauri/apiCommands";
import { resolveRequest, toHttpSendRequest } from "../../lib/api/send";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/** The plan last run, so the next test starts from it. */
let lastPlan = { users: 10, seconds: 30, ramp: 5 };

function clampInt(text: string, min: number, max: number, fallback: number): number {
  const value = Math.floor(Number(text));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * «Prueba de carga»: the request as resolved now, sent by N users for a while (`api_load_test`), with
 * throughput, latency percentiles, status codes and errors as it runs. Pre-request scripts do not run
 * per send — the same resolved request goes out every time — and the dialog says so.
 */
export function LoadTestModal({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const t = useT();
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId) ?? null);
  const [users, setUsers] = useState(String(lastPlan.users));
  const [seconds, setSeconds] = useState(String(lastPlan.seconds));
  const [ramp, setRamp] = useState(String(lastPlan.ramp));
  const [report, setReport] = useState<LoadReport | null>(null);
  const [running, setRunning] = useState(false);
  const runId = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let live = true;
    void onLoadProgress(({ id, report: next }) => {
      if (id === runId.current) setReport(next);
    }).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    return () => {
      live = false;
      unlisten?.();
      // Closing the dialog is the end of the test: nobody is left to read it.
      if (runId.current) void apiLoadStop(runId.current).catch(() => {});
    };
  }, []);

  const start = async () => {
    if (!tab || running) return;
    const plan = {
      users: clampInt(users, 1, 500, 10),
      seconds: clampInt(seconds, 1, 1800, 30),
      ramp: clampInt(ramp, 0, 1800, 0),
    };
    lastPlan = plan;
    const store = useApiStore.getState();
    const ctx = store.variableContext(tab.collectionId);
    let request;
    try {
      await store.refreshExpiredOAuth2({ tabId }, ctx);
      const resolved = await resolveRequest(tab.draft, ctx, useApiStore.getState().authChainForTab(tabId), store.settings, store.cookies);
      request = toHttpSendRequest(resolved);
    } catch (e) {
      pushErrorToast(String(e));
      return;
    }
    const id = `load-${Date.now().toString(36)}`;
    runId.current = id;
    setReport(null);
    setRunning(true);
    try {
      const final = await apiLoadTest(id, request, { users: plan.users, durationMs: plan.seconds * 1000, rampMs: plan.ramp * 1000 });
      if (runId.current === id) setReport(final);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      if (runId.current === id) {
        runId.current = null;
        setRunning(false);
      }
    }
  };

  const stop = () => {
    if (runId.current) void apiLoadStop(runId.current).catch(() => {});
  };

  const errorRate = report && report.requests > 0 ? (report.failures / report.requests) * 100 : 0;

  return (
    <ApiModal
      icon={Gauge}
      title={t("api.load.title")}
      subtitle={tab ? `${tab.draft.method} ${tab.draft.url}` : undefined}
      width="max-w-4xl"
      height="h-[80vh]"
      dismissOnBackdrop={!running}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">{t("api.load.note")}</span>
          {running ? (
            <button type="button" onClick={stop} className={buttonClass({ variant: "secondary", size: "sm" })}>
              <Square size={12} />
              {t("api.load.stop")}
            </button>
          ) : (
            <button type="button" onClick={() => void start()} disabled={!tab || tab.draft.url.trim() === ""} className={buttonClass({ variant: "primary", size: "sm" })}>
              <Play size={12} />
              {t("api.load.start")}
            </button>
          )}
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <NumberField label={t("api.load.users")} value={users} onChange={setUsers} disabled={running} hint={t("api.load.usersHint")} />
          <NumberField label={t("api.load.duration")} value={seconds} onChange={setSeconds} disabled={running} hint={t("api.load.durationHint")} />
          <NumberField label={t("api.load.ramp")} value={ramp} onChange={setRamp} disabled={running} hint={t("api.load.rampHint")} />
          {running && (
            <span className="flex items-center gap-1.5 pb-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("api.load.running", { users: report?.activeUsers ?? 0, elapsed: ((report?.elapsedMs ?? 0) / 1000).toFixed(0) })}
            </span>
          )}
          {report?.finished && (
            <span className="pb-1.5 text-[12px] text-[var(--cf-text-muted)]">
              {report.stopped ? t("api.load.stopped") : t("api.load.done")}
            </span>
          )}
        </div>

        {report ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t("api.load.requests")} value={report.requests.toLocaleString()} />
              <Stat label={t("api.load.rps")} value={report.rps.toFixed(1)} />
              <Stat label={t("api.load.errors")} value={`${errorRate.toFixed(1)} %`} tone={errorRate > 0 ? "danger" : "success"} />
              <Stat label={t("api.load.received")} value={formatBytes(report.bytes)} />
              <Stat label="p50" value={formatMs(report.latency.p50)} />
              <Stat label="p95" value={formatMs(report.latency.p95)} />
              <Stat label="p99" value={formatMs(report.latency.p99)} />
              <Stat label={t("api.load.minMax")} value={`${formatMs(report.latency.min)} – ${formatMs(report.latency.max)}`} />
            </div>
            <Chart report={report} />
            <div className="grid gap-3 sm:grid-cols-2">
              <section>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{t("api.load.statuses")}</h3>
                {report.statuses.length === 0 ? (
                  <p className="text-[12px] text-[var(--cf-text-muted)]">—</p>
                ) : (
                  report.statuses.map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between border-b border-[var(--cf-border)] py-1 text-[12px]">
                      <span className="font-semibold" style={{ color: statusColor(status) }}>
                        {status}
                      </span>
                      <span className="tabular-nums text-[var(--cf-text)]">{count.toLocaleString()}</span>
                    </div>
                  ))
                )}
              </section>
              <section>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{t("api.load.errorList")}</h3>
                {report.errors.length === 0 ? (
                  <p className="text-[12px] text-[var(--cf-text-muted)]">—</p>
                ) : (
                  report.errors.slice(0, 10).map(([message, count]) => (
                    <div key={message} className="flex items-start justify-between gap-2 border-b border-[var(--cf-border)] py-1 text-[12px]">
                      <span className="min-w-0 break-words text-[var(--cf-danger)]">{message}</span>
                      <span className="shrink-0 tabular-nums text-[var(--cf-text)]">{count.toLocaleString()}</span>
                    </div>
                  ))
                )}
              </section>
            </div>
          </>
        ) : (
          !running && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.load.intro")}</p>
        )}
      </div>
    </ApiModal>
  );
}

function NumberField({ label, value, onChange, disabled, hint }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; hint: string }) {
  return (
    <label className="flex flex-col gap-1" title={hint}>
      <span className="text-[12px] text-[var(--cf-text-muted)]">{label}</span>
      <input
        type="number"
        min={0}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass({ size: "sm", className: "w-28 tabular-nums" })}
      />
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" }) {
  const color = tone === "danger" ? "var(--cf-danger)" : tone === "success" ? "var(--cf-success)" : "var(--cf-text)";
  return (
    <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2">
      <div className="text-[11px] text-[var(--cf-text-muted)]">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

/** Requests per second as bars (failures in red on top), p95 latency as a line on its own scale. */
function Chart({ report }: { report: LoadReport }) {
  const t = useT();
  const series = report.series;
  if (series.length === 0) return null;
  const width = 640;
  const height = 140;
  const barWidth = width / Math.max(series.length, 1);
  const maxRequests = Math.max(1, ...series.map((s) => s.requests));
  const maxLatency = Math.max(1, ...series.map((s) => s.p95Ms));
  const line = series
    .map((s, i) => `${(i + 0.5) * barWidth},${height - (s.p95Ms / maxLatency) * (height - 8)}`)
    .join(" ");
  return (
    <figure className="rounded-md border border-[var(--cf-border)] p-2">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[140px] w-full" role="img" aria-label={t("api.load.chart")}>
        {series.map((s, i) => {
          const total = (s.requests / maxRequests) * (height - 8);
          const failed = (s.failures / maxRequests) * (height - 8);
          return (
            <g key={s.second}>
              <rect x={i * barWidth + 1} y={height - total} width={Math.max(1, barWidth - 2)} height={total - failed} fill="color-mix(in oklab, var(--cf-accent) 55%, transparent)">
                <title>{`${s.second}s · ${s.requests} req · ${s.failures} err · p95 ${formatMs(s.p95Ms)} · ${s.users} users`}</title>
              </rect>
              {failed > 0 && <rect x={i * barWidth + 1} y={height - failed} width={Math.max(1, barWidth - 2)} height={failed} fill="var(--cf-danger)" />}
            </g>
          );
        })}
        <polyline points={line} fill="none" stroke="var(--cf-warning)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 text-[11px] text-[var(--cf-text-muted)]">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[color-mix(in_oklab,var(--cf-accent)_55%,transparent)]" />
          {t("api.load.legendRequests", { max: maxRequests })}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[var(--cf-danger)]" />
          {t("api.load.legendFailures")}
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-3 bg-[var(--cf-warning)] align-middle" />
          {t("api.load.legendLatency", { max: formatMs(maxLatency) })}
        </span>
      </figcaption>
    </figure>
  );
}
