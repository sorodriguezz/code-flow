import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, FileDown, GitCompareArrows, Loader2, Play, ScrollText, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { fieldClass } from "../common/recipes";
import { Facts, HeaderAction, SectionTitle, StateDot, ago } from "./containerBits";
import { Dialog, PortChips } from "./ui";
import { PolicyBadge } from "./SandboxesPage";
import { actionsFor, argvLine, commandCounts, evidenceTone, fmtDuration, sandboxLabel, statusTone } from "./sandboxModel";
import {
  containersSandboxCancel,
  containersSandboxCaptureDiff,
  containersSandboxDestroy,
  containersSandboxEvidence,
  containersSandboxExec,
  containersSandboxExport,
  containersSandboxForget,
  containersSandboxLogs,
  containersSandboxPorts,
  containersSandboxStart,
  containersSandboxStop,
} from "../../lib/tauri/containersSandboxCommands";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useStoriesStore } from "../../state/storiesStore";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { PortMap } from "../../types/containers";
import type { EvidenceEntry, ExecResult, PublishedPort, SandboxView } from "../../types/containersSandbox";

/**
 * One sandbox: its facts (image, container, checkout, network, limits, what it is linked to), a box
 * to run a command in it, and its evidence — every command with its exit code and output, the
 * policy and hardening reports, the image's scan and the diffs — newest last, exportable as one
 * Markdown file.
 */
export function SandboxDetail({ sandbox, onBack, onChanged }: { sandbox: SandboxView; onBack: () => void; onChanged: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [timeline, setTimeline] = useState<EvidenceEntry[]>([]);
  const [ports, setPorts] = useState<PublishedPort[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const can = actionsFor(sandbox.status);

  const reload = useCallback(() => {
    void containersSandboxEvidence(sandbox.id).then(setTimeline).catch((e) => pushErrorToast(String(e)));
    if (sandbox.status === "running") void containersSandboxPorts(sandbox.id).then(setPorts).catch(() => setPorts([]));
  }, [sandbox.id, sandbox.status]);
  useEffect(() => reload(), [reload]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
      onChanged();
      reload();
    }
  };

  const exportMarkdown = async () => {
    const path = await saveDialog({ defaultPath: `${sandbox.containerName || "sandbox"}-evidence.md`, filters: [{ name: "Markdown", extensions: ["md"] }] }).catch(() => null);
    if (!path) return;
    await run("export", async () => {
      await containersSandboxExport(sandbox.id, path);
      pushSuccessToast(t("containers.sandbox.exported", { path }));
    });
  };

  const forget = async () => {
    if (!(await confirmAction(t("containers.sandbox.forgetConfirm", { name: sandboxLabel(sandbox) }), true, t("containers.sandbox.action.forget")))) return;
    await run("forget", async () => {
      await containersSandboxForget(sandbox.id);
      onBack();
    });
  };

  const openStory = () => {
    useUiStore.getState().openStories("batches");
    void useStoriesStore.getState().select(sandbox.storyBatchId);
  };

  const counts = commandCounts(timeline);
  const portMaps: PortMap[] = ports.map((p) => {
    const [port, protocol] = p.containerPort.split("/");
    const at = p.host.lastIndexOf(":");
    return { hostIp: p.host.slice(0, at), hostPort: Number(p.host.slice(at + 1)) || null, containerPort: Number(port) || 0, protocol: protocol || "tcp" };
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <button onClick={onBack} className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          <ArrowLeft size={13} />
          {t("containers.sandbox.back")}
        </button>
        <span className="text-[var(--cf-text-faint)]">/</span>
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-[var(--cf-text)]">{sandboxLabel(sandbox)}</h3>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px]">
          <StateDot tone={statusTone(sandbox.status)} pulse={sandbox.status === "creating"} />
          {t(`containers.sandbox.status.${sandbox.status}`)}
        </span>
        <PolicyBadge status={sandbox.policyStatus} />
        <div className="flex-1" />
        {busy && <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />}
        {can.cancel && <HeaderAction label={t("containers.sandbox.action.cancel")} icon={<X size={11} />} onClick={() => void run("cancel", () => containersSandboxCancel(sandbox.id))} />}
        {can.stop && <HeaderAction label={t("containers.sandbox.action.stop")} icon={<Square size={11} />} disabled={!!busy} onClick={() => void run("stop", () => containersSandboxStop(sandbox.id))} />}
        {can.start && <HeaderAction label={t("containers.sandbox.action.start")} icon={<Play size={11} />} disabled={!!busy} onClick={() => void run("start", () => containersSandboxStart(sandbox.id))} />}
        {sandbox.containerId && sandbox.status !== "destroyed" && (
          <HeaderAction
            label={t("containers.sandbox.action.logs")}
            icon={<ScrollText size={11} />}
            disabled={!!busy}
            onClick={() => void run("logs", async () => setLogs(await containersSandboxLogs(sandbox.id, 500)))}
          />
        )}
        {sandbox.worktreePath && <HeaderAction label={t("containers.sandbox.action.diff")} icon={<GitCompareArrows size={11} />} disabled={!!busy} onClick={() => void run("diff", () => containersSandboxCaptureDiff(sandbox.id))} />}
        <HeaderAction label={t("containers.sandbox.action.export")} icon={<FileDown size={11} />} disabled={!!busy} onClick={() => void exportMarkdown()} />
        {can.destroy && <HeaderAction danger label={t("containers.sandbox.action.destroy")} icon={<Trash2 size={11} />} disabled={!!busy} onClick={() => setDestroying(true)} />}
        {can.forget && <HeaderAction danger label={t("containers.sandbox.action.forget")} icon={<Trash2 size={11} />} disabled={!!busy} onClick={() => void forget()} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Facts
          rows={[
            [t("containers.sandbox.fact.story"), sandbox.storyTitle ? (
              <button onClick={openStory} className="text-[var(--cf-accent)] hover:underline" title={t("containers.sandbox.openStory")}>
                {sandbox.storyTitle}
              </button>
            ) : null],
            [t("containers.sandbox.fact.task"), sandbox.taskTitle || null],
            [t("containers.sandbox.fact.project"), sandbox.projectName || null],
            [t("containers.sandbox.fact.image"), <code key="i" className="font-mono text-[11.5px]">{sandbox.image}</code>],
            [t("containers.sandbox.fact.engine"), sandbox.context ? `${sandbox.runtime} · ${sandbox.context}` : sandbox.runtime],
            [t("containers.sandbox.fact.container"), sandbox.containerName ? <code key="c" className="font-mono text-[11.5px]">{sandbox.containerName}</code> : null],
            [t("containers.sandbox.fact.branch"), sandbox.branch ? <code key="b" className="font-mono text-[11.5px]">{sandbox.branch}</code> : null],
            [t("containers.sandbox.fact.base"), sandbox.baseCommit ? <code key="s" className="font-mono text-[11.5px]">{sandbox.baseCommit.slice(0, 12)}</code> : null],
            [t("containers.sandbox.fact.worktree"), sandbox.worktreePath ? <code key="w" className="break-all font-mono text-[11.5px]">{sandbox.worktreePath}</code> : null],
            [t("containers.sandbox.fact.network"), t(`containers.sandbox.network.${sandbox.network}`)],
            [t("containers.sandbox.fact.limits"), t("containers.sandbox.limits", { memory: sandbox.memoryMb, cpus: sandbox.cpus, pids: sandbox.pidsLimit })],
            [t("containers.sandbox.fact.ports"), portMaps.length ? <PortChips key="p" ports={portMaps} running={sandbox.status === "running"} /> : null],
            [t("containers.sandbox.fact.created"), ago(sandbox.createdAt, language)],
            [t("containers.sandbox.fact.error"), sandbox.error ? <span key="e" className="whitespace-pre-wrap text-[var(--cf-danger)]">{sandbox.error}</span> : null],
          ]}
        />
        {sandbox.status === "running" && <p className="mt-2 max-w-[760px] text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("containers.sandbox.agentTools")}</p>}

        <SectionTitle>{t("containers.sandbox.exec.title")}</SectionTitle>
        <ExecBox sandbox={sandbox} onRan={reload} />

        {logs !== null && (
          <>
            <SectionTitle>{t("containers.sandbox.action.logs")}</SectionTitle>
            <Output text={logs || t("containers.sandbox.logsEmpty")} />
          </>
        )}

        <SectionTitle>{t("containers.sandbox.evidence.title")}</SectionTitle>
        <p className="mb-2 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.sandbox.evidence.summary", counts)}</p>
        {timeline.length === 0 ? (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.sandbox.evidence.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {timeline.map((entry) => (
              <EvidenceRow key={entry.id} entry={entry} language={language} />
            ))}
          </ol>
        )}
      </div>
      {destroying && (
        <DestroyDialog
          sandbox={sandbox}
          onClose={() => setDestroying(false)}
          onDestroy={(removeWorktree) => {
            setDestroying(false);
            void run("destroy", async () => {
              await containersSandboxDestroy(sandbox.id, removeWorktree);
              pushSuccessToast(t("containers.sandbox.destroyed"));
            });
          }}
        />
      )}
    </div>
  );
}

function Output({ text, tone }: { text: string; tone?: "danger" }) {
  return (
    <pre
      className={`max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-sunken,var(--cf-hover))] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed ${
        tone === "danger" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"
      }`}
    >
      {text}
    </pre>
  );
}

/** The terminal of a sandbox: one command line at a time, run through the broker. */
function ExecBox({ sandbox, onRan }: { sandbox: SandboxView; onRan: () => void }) {
  const t = useT();
  const [line, setLine] = useState("");
  const [timeout, setTimeoutS] = useState("120");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(ExecResult & { line: string }) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const can = actionsFor(sandbox.status).exec;

  const exec = async () => {
    const command = line.trim();
    if (!command || running) return;
    setRunning(true);
    try {
      const seconds = Number(timeout);
      const out = await containersSandboxExec(sandbox.id, command, Number.isFinite(seconds) && seconds > 0 ? seconds : undefined);
      setResult({ ...out, line: command });
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setRunning(false);
      onRan();
      input.current?.focus();
    }
  };

  if (!can) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.sandbox.exec.notRunning")}</p>;
  return (
    <div className="flex max-w-[960px] flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SquareTerminal size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
          <input
            ref={input}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void exec()}
            placeholder={t("containers.sandbox.exec.placeholder")}
            aria-label={t("containers.sandbox.exec.title")}
            spellCheck={false}
            className={fieldClass({ size: "sm", className: "w-full pl-7 font-mono" })}
          />
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
          {t("containers.sandbox.exec.timeout")}
          <input value={timeout} onChange={(e) => setTimeoutS(e.target.value)} inputMode="numeric" className={fieldClass({ size: "sm", className: "w-16" })} />
        </label>
        {running ? (
          <Button size="sm" variant="secondary" onClick={() => void containersSandboxCancel(sandbox.id)}>
            <Loader2 size={12} className="animate-spin" />
            {t("containers.sandbox.exec.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void exec()} disabled={!line.trim()}>
            <Play size={11} />
            {t("containers.sandbox.exec.run")}
          </Button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("containers.sandbox.exec.hint")}</p>
      {result && (
        <div className="flex flex-col gap-1">
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">
            <code className="font-mono">$ {result.line}</code> ·{" "}
            {result.timedOut
              ? t("containers.sandbox.exec.timedOut")
              : result.cancelled
                ? t("containers.sandbox.exec.cancelled")
                : t("containers.sandbox.exec.result", { code: result.exitCode ?? "—", duration: fmtDuration(result.durationMs) })}
          </p>
          {result.stdout && <Output text={result.stdout} />}
          {result.stderr && <Output text={result.stderr} tone={result.exitCode === 0 ? undefined : "danger"} />}
        </div>
      )}
    </div>
  );
}

const TONE_COLOR = { ok: "var(--cf-success)", warn: "var(--cf-warning)", bad: "var(--cf-danger)", idle: "var(--cf-text-faint)" } as const;

/** One entry of the timeline, folded to its line until opened. */
function EvidenceRow({ entry, language }: { entry: EvidenceEntry; language: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tone = evidenceTone(entry);
  const data = entry.data;
  const line =
    entry.kind === "exec" || entry.kind === "test"
      ? `$ ${argvLine(data.argv)} · ${data.timedOut ? t("containers.sandbox.exec.timedOut") : data.cancelled ? t("containers.sandbox.exec.cancelled") : t("containers.sandbox.exec.result", { code: data.exitCode ?? "—", duration: fmtDuration(data.durationMs) })}`
      : entry.summary;
  let body: ReactNode = null;
  switch (entry.kind) {
    case "exec":
    case "test":
      body = (
        <>
          {data.stdout ? <Labelled label={`stdout${data.stdoutTruncated ? ` (${t("containers.sandbox.evidence.lastPart")})` : ""}`}><Output text={data.stdout} /></Labelled> : null}
          {data.stderr ? <Labelled label={`stderr${data.stderrTruncated ? ` (${t("containers.sandbox.evidence.lastPart")})` : ""}`}><Output text={data.stderr} /></Labelled> : null}
        </>
      );
      break;
    case "policy":
    case "hardening":
      body = (
        <>
          <Violations list={data.violations ?? []} />
          {data.signature && data.signature.state !== "notChecked" && (
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">
              {t("containers.sandbox.evidence.signature", { state: data.signature.state === "verified" ? "✓" : `${data.signature.state}: ${"reason" in data.signature ? data.signature.reason : ""}` })}
            </p>
          )}
          {(data.findings ?? []).length > 0 && (
            <Labelled label={t("containers.sandbox.evidence.findings")}>
              <ul className="text-[11.5px] text-[var(--cf-text-muted)]">
                {(data.findings ?? []).map((f, i) => (
                  <li key={i}>
                    <code className="font-mono">{f.rule}</code> · {f.severity}
                    {f.detail ? ` · ${f.detail}` : ""}
                  </li>
                ))}
              </ul>
            </Labelled>
          )}
        </>
      );
      break;
    case "scan":
      body = (
        <p className="text-[11.5px] text-[var(--cf-text-muted)]">
          {data.scan ? t("containers.sandbox.evidence.scan", { scanner: data.scan.scanner, critical: data.scan.critical, high: data.scan.high, medium: data.scan.medium, low: data.scan.low }) : t("containers.sandbox.evidence.noScan")}
        </p>
      );
      break;
    case "diff":
      body = (
        <>
          <Output text={data.stat?.trim() ? data.stat : t("containers.sandbox.evidence.noChanges")} />
          {(data.untracked ?? []).length > 0 && (
            <Labelled label={t("containers.sandbox.evidence.untracked")}>
              <ul className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">
                {(data.untracked ?? []).map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </Labelled>
          )}
          {data.diff ? <Labelled label={`diff${data.diffTruncated ? ` (${t("containers.sandbox.evidence.firstPart")})` : ""}`}><Output text={data.diff} /></Labelled> : null}
        </>
      );
      break;
    default:
      body = data.detail ? <p className="whitespace-pre-wrap text-[11.5px] text-[var(--cf-text-muted)]">{data.detail}</p> : null;
  }
  const scanLine = entry.kind === "scan" && !entry.summary ? (data.scan ? `${data.scan.scanner} · ${data.scan.critical}/${data.scan.high}/${data.scan.medium}/${data.scan.low}` : t("containers.sandbox.evidence.noScan")) : "";
  return (
    <li className="rounded-md border border-[var(--cf-border)]">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--cf-hover)]">
        <ChevronRight size={12} className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[tone] }} />
        <span className="w-[120px] shrink-0 truncate text-[11.5px] font-medium text-[var(--cf-text)]">{t(`containers.sandbox.evidence.kind.${entry.kind}`)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{line || scanLine}</span>
        <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{ago(entry.at, language)}</span>
      </button>
      {open && body && <div className="flex flex-col gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">{body}</div>}
    </li>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">{label}</p>
      {children}
    </div>
  );
}

export function Violations({ list }: { list: EvidenceEntry["data"]["violations"] & object }) {
  const t = useT();
  if (list.length === 0) return <p className="text-[11.5px] text-[var(--cf-success)]">{t("containers.sandbox.evidence.noViolations")}</p>;
  return (
    <ul className="flex flex-col gap-0.5 text-[11.5px]">
      {list.map((v, i) => (
        <li key={i} className={v.blocking ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}>
          {t(`containers.sandbox.rule.${v.rule}`)}
          {v.detail ? ` — ${v.detail}` : ""} · {v.blocking ? t("containers.sandbox.blocking") : t("containers.sandbox.advisory")}
        </li>
      ))}
    </ul>
  );
}

function DestroyDialog({ sandbox, onClose, onDestroy }: { sandbox: SandboxView; onClose: () => void; onDestroy: (removeWorktree: boolean) => void }) {
  const t = useT();
  const [removeWorktree, setRemoveWorktree] = useState(false);
  return (
    <Dialog
      title={t("containers.sandbox.destroyTitle")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="danger" onClick={() => onDestroy(removeWorktree)}>
            {t("containers.sandbox.action.destroy")}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-[var(--cf-text)]">{t("containers.sandbox.destroyBody", { name: sandbox.containerName, branch: sandbox.branch || "—" })}</p>
      {sandbox.worktreeOwned && (
        <label className="mt-3 flex items-start gap-2 text-[12px] text-[var(--cf-text)]">
          <span className="mt-[1px]">
            <Checkbox checked={removeWorktree} onChange={() => setRemoveWorktree((v) => !v)} />
          </span>
          {t("containers.sandbox.destroyWorktree")}
        </label>
      )}
    </Dialog>
  );
}
