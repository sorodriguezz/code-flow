import { useEffect, useState, type ReactNode } from "react";
import { CircleStop, Download, FolderOpen, Gauge, HardDrive, Loader2, X } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import { Note, Status } from "../api/settingsChrome";
import { Bar, formatBytes, ModelDownloadRow } from "./localModelRow";
import { useT } from "../../state/languageStore";
import { pullId, useLocalExecStore } from "../../state/localExecStore";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";
import { useConfirmStore } from "../../state/confirmStore";
import { revealInFileManager } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import {
  LOCAL_EXEC_KEYS,
  modelKeyFor,
  type LocalBackend,
  type LocalDelegate,
  type LocalExecErrorCode,
  type LocalExecMachine,
  type LocalExecState,
  type LocalFit,
  type LocalPace,
} from "../../lib/tauri/localExecCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The hybrid task's local model: which server runs it, which model, how much context — and, the
 * part that makes this pane worth having, what that means on *this* machine.
 *
 * Nothing here assumes a machine. The memory line is the model's own size plus its KV cache at the
 * chosen context, measured against what this machine reports (the GPU share Metal gives on Apple
 * Silicon, a card's VRAM, RAM otherwise); the speeds are estimated from how fast that memory reads
 * — RAM's bandwidth is measured on this machine — and **Probar** replaces estimates with
 * measurements. The same numbers become the budget the planner cuts tasks to.
 */

/** 16384 → "16k", 11776 → "11.5k". The same "k" the context sizes are named with. */
export function tokensLabel(tokens: number): string {
  const k = tokens / 1024;
  return k >= 1 ? `${Number.isInteger(k) ? k : k.toFixed(1)}k` : String(tokens);
}

const ERROR_KEY: Partial<Record<LocalExecErrorCode, TranslationKey>> = {
  unreachable: "localexec.errUnreachable",
  refused: "localexec.errRefused",
  stalled: "localexec.errStalled",
  malformed: "localexec.errMalformed",
  "engine-missing": "localexec.errEngineMissing",
  "not-downloaded": "localexec.errNotDownloaded",
  "no-models": "localexec.errNoModels",
};

/**
 * Why the local model cannot run, in the reader's language. The backend's sentence is English — it
 * is also what lands in logs — so it is the fallback for a kind this build does not know, and what
 * a tooltip shows.
 */
export function localErrorText(
  error: { error: string | null; error_code: LocalExecErrorCode | null },
  t: ReturnType<typeof useT>,
  context: { url?: string; model?: string } = {},
): string | null {
  const key = error.error_code ? ERROR_KEY[error.error_code] : undefined;
  if (key) return t(key, { url: context.url ?? "", model: context.model ?? "" });
  return error.error;
}

/** The label of the model a state names, for {@link localErrorText}. */
export function modelLabelOf(state: LocalExecState): string {
  return state.models.find((m) => m.id === state.model)?.label ?? state.model ?? "";
}

const FIT_TONE: Record<LocalFit, "success" | "warning" | "muted"> = {
  comfortable: "success",
  tight: "warning",
  "spills-to-cpu": "warning",
  "does-not-fit": "warning",
  unknown: "muted",
};

/** A catalogue row's fit, at the default context — the short form of {@link FIT_KEY}. */
const ROW_FIT_KEY: Record<Exclude<LocalFit, "unknown">, TranslationKey> = {
  comfortable: "localexec.rowFitComfortable",
  tight: "localexec.rowFitTight",
  "spills-to-cpu": "localexec.rowFitSpills",
  "does-not-fit": "localexec.rowFitNo",
};

const FIT_KEY: Record<LocalFit, TranslationKey> = {
  comfortable: "localexec.fitComfortable",
  tight: "localexec.fitTight",
  "spills-to-cpu": "localexec.fitSpills",
  "does-not-fit": "localexec.fitNo",
  unknown: "localexec.fitUnknown",
};

/** 6.64 → "6.6", 12.3 → "12": a decimal only where it changes the reading. */
function tpsLabel(tps: number): string {
  return tps < 10 ? tps.toFixed(1) : String(Math.round(tps));
}

/** Bytes a second → "45 GB/s". */
function bandwidthLabel(bytesPerSecond: number): string {
  return `${Math.round(bytesPerSecond / 1e9)} GB/s`;
}

/** Said in words where it is slow: a colour alone would not say it. */
const PACE_WORD: Partial<Record<LocalPace, TranslationKey>> = {
  slow: "localexec.paceSlow",
  crawl: "localexec.paceCrawl",
};

const PACE_TONE: Record<LocalPace, "success" | "warning" | "muted"> = {
  fast: "success",
  usable: "success",
  slow: "warning",
  crawl: "warning",
  unknown: "muted",
};

/** What a speed estimate rests on, for its tooltip: the memory the model would live in, and how
 *  fast it reads. RAM's figure is measured here — the reason a PC with plenty of it can still be
 *  told a model will crawl. */
function estimateBasis(machine: LocalExecMachine, t: ReturnType<typeof useT>): string {
  const ram = machine.ram_bandwidth ? bandwidthLabel(machine.ram_bandwidth) : null;
  const gpu = machine.gpu_name ?? "GPU";
  if (machine.gpu === "unified" && machine.gpu_bandwidth) {
    return t("localexec.estimateUnified", { gpu, speed: bandwidthLabel(machine.gpu_bandwidth) });
  }
  if (machine.gpu === "discrete") {
    return ram ? t("localexec.estimateCard", { gpu, ram }) : t("localexec.estimateCardOnly", { gpu });
  }
  return t("localexec.estimateRam", { ram: ram ?? "?" });
}

/** "≈ 12 tok/s", plus the word for a slow pace. */
function speedText(tps: number, pace: LocalPace, t: ReturnType<typeof useT>): string {
  const word = PACE_WORD[pace];
  return `≈ ${tpsLabel(tps)} tok/s${word ? ` · ${t(word)}` : ""}`;
}

/**
 * A catalogue row's verdict on this machine: how it fits and how fast it would write, as one line.
 * The speed is what the fit alone never said — a model can fit in RAM and still write at two tokens
 * a second.
 */
function RowVerdict({
  fit,
  tps,
  pace,
  machine,
}: {
  fit: LocalFit | null;
  tps: number | null;
  pace: LocalPace;
  machine: LocalExecMachine;
}) {
  const t = useT();
  const fits = fit !== null && fit !== "unknown" ? fit : null;
  // A model that does not fit has no speed worth quoting.
  const speed = tps !== null && fits !== "does-not-fit" ? speedText(tps, pace, t) : null;
  if (!fits && !speed) return null;
  // The worse of the two: a fit that warns, else the pace.
  const tone =
    fits && FIT_TONE[fits] === "warning" ? "warning" : speed ? PACE_TONE[pace] : fits ? FIT_TONE[fits] : "muted";
  const line = (
    <Status tone={tone}>{[fits && t(ROW_FIT_KEY[fits]), speed].filter(Boolean).join(" · ")}</Status>
  );
  return speed ? (
    <Tooltip label={t("localexec.estimateLabel")} description={estimateBasis(machine, t)}>
      {line}
    </Tooltip>
  ) : (
    line
  );
}

const FIT_BAR: Record<LocalFit, string> = {
  comfortable: "bg-[var(--cf-success)]",
  tight: "bg-[var(--cf-warning)]",
  "spills-to-cpu": "bg-[var(--cf-danger)]",
  "does-not-fit": "bg-[var(--cf-danger)]",
  unknown: "bg-[var(--cf-text-muted)]",
};

/**
 * One setting: its name in a column on the left, the control beside it. `stacked` puts the name above
 * instead, for a control that needs the pane's whole width — the model list, whose rows carry a
 * verdict, five figures and a button (the user's ask, 2026-10-09).
 */
function Row({ label, hint, stacked = false, children }: { label: string; hint?: string; stacked?: boolean; children: ReactNode }) {
  const name = <span className="text-[12px] text-[var(--cf-text-muted)]">{label}</span>;
  if (stacked) {
    return (
      <div className="flex flex-col gap-2 border-t border-[var(--cf-border)] py-2.5 first:border-t-0 first:pt-0">
        <div>{hint ? <Tooltip label={hint}>{name}</Tooltip> : name}</div>
        <div className="min-w-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3 border-t border-[var(--cf-border)] py-2.5 first:border-t-0 first:pt-0">
      <div className="pt-[5px]">{hint ? <Tooltip label={hint}>{name}</Tooltip> : name}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Where the memory figure is measured against, as one phrase. */
function roomPhrase(state: LocalExecState, t: ReturnType<typeof useT>): string {
  const { machine } = state;
  if (machine.gpu === "unified" && machine.gpu_bytes) {
    return t("localexec.roomUnified", { gpu: formatBytes(machine.gpu_bytes), ram: formatBytes(machine.ram_bytes) });
  }
  if (machine.gpu === "discrete" && machine.gpu_bytes) {
    return t("localexec.roomDiscrete", { gpu: formatBytes(machine.gpu_bytes), name: machine.gpu_name ?? "GPU" });
  }
  // The model lives in RAM here, so how fast it reads is the other half of the answer.
  return machine.ram_bandwidth
    ? t("localexec.roomRamSpeed", { ram: formatBytes(machine.ram_bytes), speed: bandwidthLabel(machine.ram_bandwidth) })
    : t("localexec.roomRam", { ram: formatBytes(machine.ram_bytes) });
}

function MemoryLine({ state }: { state: LocalExecState }) {
  const t = useT();
  const room = state.machine.gpu_bytes ?? state.machine.ram_bytes;
  const need = state.need_bytes;
  if (need === null) {
    return <Status tone="muted" wrap>{t("localexec.fitUnknown")}</Status>;
  }
  const kv = state.details.kv_bytes_per_token ? state.details.kv_bytes_per_token * state.ctx : 0;
  const model = state.details.size_bytes ?? Math.max(0, need - kv);
  const total = need + state.also_resident_bytes;
  const modelShare = room > 0 ? Math.min(1, model / room) : 0;
  const restShare = room > 0 ? Math.min(1 - modelShare, (total - model) / room) : 0;
  return (
    <div className="flex flex-col gap-1.5 pt-[5px]">
      <div className="flex h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-[var(--cf-sunken)]">
        <div className={FIT_BAR[state.fit]} style={{ width: `${modelShare * 100}%` }} />
        <div className={`${FIT_BAR[state.fit]} opacity-50`} style={{ width: `${restShare * 100}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
        {formatBytes(total)} {roomPhrase(state, t)}
        {" · "}
        {t("localexec.breakdown", { model: formatBytes(model), kv: formatBytes(kv) })}
        {state.also_resident_bytes > 0 && ` ${t("localexec.breakdownCompletion", { size: formatBytes(state.also_resident_bytes) })}`}
      </span>
      <Status tone={FIT_TONE[state.fit]} wrap>
        {t(FIT_KEY[state.fit])}
      </Status>
    </div>
  );
}

function BudgetLine({ state }: { state: LocalExecState }) {
  const t = useT();
  const { budget } = state;
  const share = (n: number) => `${(n / budget.ctx) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5 pt-[5px]">
      <div className="flex h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-[var(--cf-sunken)]">
        <div className="bg-[var(--cf-border-strong)]" style={{ width: share(budget.ctx - budget.input - budget.output) }} />
        <div className="bg-[var(--cf-accent-fill)]" style={{ width: share(budget.input) }} />
        <div className="bg-[var(--cf-text-muted)] opacity-40" style={{ width: share(budget.output) }} />
      </div>
      <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
        {t("localexec.perTaskValue", { input: tokensLabel(budget.input), output: tokensLabel(budget.output) })}
      </span>
    </div>
  );
}

function ProbeLine({ state }: { state: LocalExecState }) {
  const t = useT();
  const probing = useLocalExecStore((s) => s.probing);
  const probeError = useLocalExecStore((s) => s.probeError);
  const probe = useLocalExecStore((s) => s.probe);
  const result = state.probe;
  const canProbe = state.reachable && state.model !== null;
  const paceWord = PACE_WORD[state.pace];
  return (
    <div className="flex flex-col gap-1 pt-[2px]">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canProbe || probing}
          onClick={() => void probe()}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          {probing ? <Loader2 size={13} className="animate-spin" /> : <Gauge size={13} />}
          {probing ? t("localexec.probing") : t("localexec.probe")}
        </button>
        {!probing && result?.ok && (
          <span className="text-[12px] tabular-nums text-[var(--cf-text)]">
            {t("localexec.probeResult", {
              read: result.prompt_tps ? String(Math.round(result.prompt_tps)) : "—",
              write: result.gen_tps ? result.gen_tps.toFixed(1) : "—",
            })}
            {result.gpu_share !== null &&
              ` · ${t("localexec.probeGpu", { percent: String(Math.round(result.gpu_share * 100)) })}`}
          </span>
        )}
        {!probing && !result && !probeError && state.write_tps !== null && (
          <Tooltip label={t("localexec.estimateLabel")} description={estimateBasis(state.machine, t)}>
            <Status tone={PACE_TONE[state.pace]}>
              {t("localexec.estimate", { tps: tpsLabel(state.write_tps) })}
              {paceWord && ` · ${t(paceWord)}`}
            </Status>
          </Tooltip>
        )}
        {!probing && !result && !probeError && state.write_tps === null && (
          <span className="text-[11px] text-[var(--cf-text-muted)]">{t("localexec.probeNone")}</span>
        )}
      </div>
      {!probing && result?.truncated && (
        <Note tone="warning">
          {t("localexec.probeTruncated", {
            kept: String(result.prompt_tokens ?? 0),
            sent: String(result.sent_tokens),
          })}
        </Note>
      )}
      {!probing && result && !result.ok && !result.truncated && result.error && (
        <Note tone="warning">{localErrorText(result, t, { url: state.url, model: result.model })}</Note>
      )}
      {!probing && probeError && <Note tone="warning">{probeError}</Note>}
    </div>
  );
}

/**
 * Ollama's library, from here: the coder models this app knows the memory of, each with how it would
 * sit on this machine, and a field for any other name. A pull is the server's own download — it
 * resumes where it stopped — and its progress is the same bar the bundled catalogue draws.
 */
function OllamaPulls({ state }: { state: LocalExecState }) {
  const t = useT();
  const progress = useLocalExecStore((s) => s.progress);
  const pull = useLocalExecStore((s) => s.pull);
  const cancelPull = useLocalExecStore((s) => s.cancelPull);
  const [other, setOther] = useState("");
  const otherBusy = other.trim() !== "" && isPulling(progress[pullId(other.trim())]);
  return (
    <div className="flex flex-col gap-1.5">
      {state.pullable.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {state.pullable.map((row) => {
            const live = progress[row.id];
            const busy = isPulling(live);
            return (
              <div key={row.id} className="border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-[13px] text-[var(--cf-text)]">
                        {row.label} <span className="font-mono text-[11px] text-[var(--cf-text-muted)]">{row.tag}</span>
                      </span>
                      {row.recommended && <span className={chipClass("ok")}>{t("localexec.forThisMachine")}</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--cf-text-muted)]">
                      <RowVerdict fit={row.fit} tps={row.write_tps} pace={row.pace} machine={state.machine} />
                      <span>{formatBytes(row.size_bytes)}</span>
                    </div>
                  </div>
                  {busy ? (
                    <button type="button" onClick={() => void cancelPull(row.tag)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <X size={13} /> {t("localai.cancel")}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void pull(row.tag)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                      <Download size={13} /> {t("localai.download")}
                    </button>
                  )}
                </div>
                <PullProgressLine live={live} fallbackTotal={row.size_bytes} />
              </div>
            );
          })}
        </div>
      )}
      <div className="flex max-w-[360px] items-center gap-2">
        <input
          value={other}
          spellCheck={false}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && other.trim() && !otherBusy) void pull(other.trim());
          }}
          placeholder={t("localexec.pullOther")}
          aria-label={t("localexec.pullOtherLabel")}
          title={t("localexec.pullOtherLabel")}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })}
        />
        {otherBusy ? (
          <button type="button" onClick={() => void cancelPull(other.trim())} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <X size={13} /> {t("localai.cancel")}
          </button>
        ) : (
          <button
            type="button"
            disabled={!other.trim()}
            onClick={() => void pull(other.trim())}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <Download size={13} /> {t("localai.download")}
          </button>
        )}
      </div>
      {other.trim() !== "" && <PullProgressLine live={progress[pullId(other.trim())]} fallbackTotal={0} />}
    </div>
  );
}

function isPulling(live: LocalAiDownloadEvent | undefined): boolean {
  return live?.phase === "downloading" || live?.phase === "verifying";
}

function PullProgressLine({ live, fallbackTotal }: { live: LocalAiDownloadEvent | undefined; fallbackTotal: number }) {
  const t = useT();
  if (!live) return null;
  if (live.phase === "failed") {
    return <p className="mt-1 text-[11px] text-[var(--cf-danger)]">{live.error ?? t("localexec.pullFailed")}</p>;
  }
  if (!isPulling(live)) return null;
  const total = live.total || fallbackTotal;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <Bar done={live.done} total={total} />
      <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
        {live.phase === "verifying"
          ? t("localai.verifying")
          : total > 0
            ? `${formatBytes(live.done)} / ${formatBytes(total)}`
            : t("localexec.pullStarting")}
      </span>
    </div>
  );
}

/** The URL field for a server backend, saved on blur or Enter. */
function UrlField({ backend, url }: { backend: LocalBackend; url: string }) {
  const save = useLocalExecStore((s) => s.set);
  const [draft, setDraft] = useState(url);
  useEffect(() => setDraft(url), [url]);
  const key = backend === "ollama" ? LOCAL_EXEC_KEYS.urlOllama : LOCAL_EXEC_KEYS.urlOpenai;
  const commit = () => {
    if (draft.trim() !== url) void save(key, draft.trim());
  };
  return (
    <input
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className={fieldClass({ size: "sm", className: "w-full max-w-[320px] font-mono" })}
    />
  );
}

function KeyField({ hasKey }: { hasKey: boolean }) {
  const t = useT();
  const setKey = useLocalExecStore((s) => s.setKey);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasKey ? (
        <>
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("localexec.apiKeySaved")}</span>
          <button type="button" onClick={() => void setKey(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("localexec.apiKeyRemove")}
          </button>
        </>
      ) : (
        <>
          <input
            type="password"
            value={draft}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            className={fieldClass({ size: "sm", className: "w-full max-w-[240px]" })}
          />
          <button
            type="button"
            disabled={draft.trim() === ""}
            onClick={() => {
              void setKey(draft.trim());
              setDraft("");
            }}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            {t("localexec.save")}
          </button>
        </>
      )}
    </div>
  );
}

export function LocalModelSettings() {
  const t = useT();
  const { state, loading, pendingBackend, progress, load, set, download, cancelDownload, remove, stopEngine } =
    useLocalExecStore();
  const ask = useConfirmStore((s) => s.ask);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !state) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const backendOptions: { value: LocalBackend; label: string; title?: string }[] = [
    { value: "bundled", label: t("localexec.backendBundled"), title: t("localexec.backendBundledHint") },
    { value: "ollama", label: "Ollama" },
    { value: "openai", label: t("localexec.backendOpenai"), title: t("localexec.backendOpenaiHint") },
  ];
  const detectedNames = [state.detected.ollama && "Ollama", state.detected.lmstudio && "LM Studio"].filter(Boolean);
  const engineRunning = state.engine.kind === "ready" || state.engine.kind === "starting";
  const host = (() => {
    try {
      return new URL(state.url).host;
    } catch {
      return state.url;
    }
  })();

  // Only a server switch dims the pane: what is below the switch is still the other server's until
  // its answer lands. Every other click is drawn at once and re-read underneath.
  const switching = pendingBackend !== null && pendingBackend !== state.backend;

  return (
    <div className={`flex flex-col transition-opacity ${switching ? "opacity-60" : ""}`}>
      <Row label={t("localexec.server")}>
        <div className="flex flex-col gap-2">
          {/* `self-start`: a column stretches its children, and the track drew an empty strip to the
              right of its three buttons (user report, 2026-10-02). Its own width, like the
              delegate control below, which sits in a row and never stretched. */}
          <Segmented
            options={backendOptions}
            value={pendingBackend ?? state.backend}
            onChange={(value) => void set(LOCAL_EXEC_KEYS.backend, value)}
            layoutId="cf-local-exec-backend"
            size="sm"
            ariaLabel={t("localexec.server")}
            className="self-start"
          />
          {state.backend !== "bundled" && <UrlField backend={state.backend} url={state.url} />}
          {state.backend !== "bundled" &&
            (state.reachable ? (
              <Status tone="success">
                {state.server_version
                  ? t("localexec.connectedVersion", { version: state.server_version })
                  : t("localexec.connected")}
              </Status>
            ) : (
              <span title={state.error ?? undefined}>
                <Status tone="warning" wrap>
                  {localErrorText(state, t, { url: state.url, model: modelLabelOf(state) }) ?? t("localexec.notAnswering")}
                </Status>
              </span>
            ))}
          {/* Under the error it answers, not at the foot of the pane where nobody scrolls to. */}
          {state.backend !== "bundled" && !state.reachable && detectedNames.length === 0 && (
            <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("localexec.noServer")}</span>
          )}
          {state.backend !== "bundled" && state.remote && <Note tone="warning">{t("localexec.remote", { host })}</Note>}
          {!state.backend_chosen && detectedNames.length > 0 && (
            <span className="text-[11px] text-[var(--cf-text-muted)]">
              {t("localexec.detected", { list: detectedNames.join(", ") })}
            </span>
          )}
          {state.backend === "bundled" && !state.engine_available && (
            <Note tone="warning">{t("localai.engineMissing")}</Note>
          )}
        </div>
      </Row>

      {state.backend === "openai" && (
        <Row label={t("localexec.apiKey")}>
          <KeyField hasKey={state.has_key} />
        </Row>
      )}

      <Row label={t("localexec.model")} stacked>
        {state.backend === "bundled" ? (
          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
              {state.models.map((model) => (
                <ModelDownloadRow
                  key={model.id}
                  model={{
                    id: model.id,
                    label: model.label,
                    tier: model.tier ?? "light",
                    params: model.params ?? "",
                    licence: model.licence ?? "",
                    size_bytes: model.size_bytes ?? 0,
                    min_ram_gb: model.min_ram_gb ?? 0,
                    installed: model.installed === true,
                    partial_bytes: model.partial_bytes,
                  }}
                  active={model.id === state.model && model.installed === true}
                  badge={
                    model.recommended ? (
                      <span className={chipClass("ok")}>{t("localexec.forThisMachine")}</span>
                    ) : undefined
                  }
                  note={
                    model.fit && model.fit !== "unknown" ? (
                      <RowVerdict fit={model.fit} tps={model.write_tps} pace={model.pace} machine={state.machine} />
                    ) : undefined
                  }
                  progress={progress[model.id]}
                  onDownload={() => void download(model.id)}
                  onCancel={() => void cancelDownload(model.id)}
                  onUse={() => void set(LOCAL_EXEC_KEYS.modelBundled, model.id)}
                  onDelete={() => {
                    void ask({
                      message: t("localai.deleteConfirm", {
                        model: model.label,
                        size: formatBytes(model.size_bytes ?? 0),
                      }),
                      confirmLabel: t("localai.delete"),
                      danger: true,
                    }).then((ok) => {
                      if (ok) void remove(model.id);
                    });
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
              <HardDrive size={12} />
              {t("localai.diskUsed", { size: formatBytes(state.disk_used) })}
              {state.disk_used > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    void revealInFileManager(state.models_dir).catch((error) => pushErrorToast(String(error)));
                  }}
                  title={state.models_dir}
                  className={buttonClass({ variant: "ghost", size: "sm" })}
                >
                  <FolderOpen size={13} />
                  {t("localai.showInFolder")}
                </button>
              )}
              {engineRunning && (
                <button type="button" onClick={() => void stopEngine()} className={buttonClass({ variant: "ghost", size: "sm" })}>
                  {state.engine.kind === "starting" ? <Loader2 size={13} className="animate-spin" /> : <CircleStop size={13} />}
                  {state.engine.kind === "starting" ? t("localai.warmingUp") : t("localexec.stopEngine")}
                </button>
              )}
            </div>
            {state.engine.kind === "failed" && <Note tone="warning">{state.engine.message}</Note>}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="max-w-[360px]">
              <Select
                size="sm"
                value={state.model ?? ""}
                placeholder={t("localexec.noModels")}
                ariaLabel={t("localexec.model")}
                disabled={state.models.length === 0}
                onChange={(value) => void set(modelKeyFor(state.backend), value)}
                options={state.models.map((model) => ({
                  value: model.id,
                  label: [model.id, model.params, model.size_bytes ? formatBytes(model.size_bytes) : null]
                    .filter(Boolean)
                    .join(" · "),
                }))}
              />
            </div>
            {state.backend === "ollama" && state.reachable && <OllamaPulls state={state} />}
          </div>
        )}
      </Row>

      <Row label={t("localexec.context")}>
        {state.details.ctx_fixed_by_server ? (
          <span className="block pt-[5px] text-[12px] text-[var(--cf-text)]">
            {t("localexec.contextFixed", { ctx: tokensLabel(state.ctx) })}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[110px]">
              <Select
                size="sm"
                value={String(state.ctx)}
                ariaLabel={t("localexec.context")}
                onChange={(value) => void set(LOCAL_EXEC_KEYS.ctx, value)}
                options={state.ctx_options.map((ctx) => ({ value: String(ctx), label: tokensLabel(ctx) }))}
              />
            </div>
            {state.details.max_ctx && (
              <span className="text-[11px] text-[var(--cf-text-muted)]">
                {t("localexec.contextMax", { ctx: tokensLabel(state.details.max_ctx) })}
              </span>
            )}
            {state.ctx_chosen && (
              <button
                type="button"
                onClick={() => void set(LOCAL_EXEC_KEYS.ctx, "")}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                {t("localexec.contextAuto")}
              </button>
            )}
          </div>
        )}
      </Row>

      <Row label={t("localexec.memory")}>
        <MemoryLine state={state} />
      </Row>

      <Row label={t("localexec.perTask")} hint={t("localexec.perTaskHint")}>
        <BudgetLine state={state} />
      </Row>

      <Row label={t("localexec.speed")}>
        <ProbeLine state={state} />
      </Row>

      <Row label={t("localexec.delegate")} hint={t("localexec.delegateHint")}>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            options={[
              { value: "easy" as LocalDelegate, label: t("localexec.delegateEasy") },
              { value: "medium" as LocalDelegate, label: t("localexec.delegateMedium") },
              { value: "all" as LocalDelegate, label: t("localexec.delegateAll") },
            ]}
            value={state.delegate}
            onChange={(value) => void set(LOCAL_EXEC_KEYS.delegate, value === state.delegate_suggested ? "" : value)}
            layoutId="cf-local-exec-delegate"
            size="sm"
            ariaLabel={t("localexec.delegate")}
          />
          {state.delegate === state.delegate_suggested && (
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("localexec.suggested")}</span>
          )}
        </div>
      </Row>

      <Row label={t("localexec.onFail")}>
        <div className="w-[240px]">
          <Select
            size="sm"
            value={state.on_fail}
            ariaLabel={t("localexec.onFail")}
            onChange={(value) => void set(LOCAL_EXEC_KEYS.onFail, value)}
            options={[
              { value: "review", label: t("localexec.onFailReview") },
              { value: "skip", label: t("localexec.onFailSkip") },
            ]}
          />
        </div>
      </Row>

      <Row label={t("localexec.review")}>
        <div className="w-[240px]">
          <Select
            size="sm"
            value={state.review_mode}
            ariaLabel={t("localexec.review")}
            onChange={(value) => void set(LOCAL_EXEC_KEYS.reviewMode, value)}
            options={[
              { value: "local", label: t("localexec.reviewLocal") },
              { value: "fix", label: t("localexec.reviewFix") },
              { value: "report", label: t("localexec.reviewReport") },
            ]}
          />
        </div>
      </Row>

      <Row label={t("localexec.memoryAfter")}>
        <label className="flex cursor-pointer items-center gap-2 pt-[3px]">
          <Checkbox checked={state.unload} onChange={(next) => void set(LOCAL_EXEC_KEYS.unload, next ? "1" : "0")} />
          <span className="text-[12px] text-[var(--cf-text)]">{t("localexec.unload")}</span>
        </label>
      </Row>

    </div>
  );
}
