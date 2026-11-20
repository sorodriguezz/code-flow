import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Clock, FileSearch, FolderOpen, Hammer, Layers, Loader2, Maximize2, Minimize2, Play, RotateCw, Trash2, Undo2, XCircle, Zap } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { RowAction, SectionTitle, StateDot, ago, useInterval } from "./containerBits";
import { LayersView } from "./ImageDetail";
import { SecurityTab } from "./SecurityTab";
import { CopyText } from "./pageBits";
import { CountBar, Dialog, EmptyLine, Field, FilterChips, LoadingLine, MutedNote, NO_ROWS, PageHead, PageTabs, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { RunContainerDialog } from "./RunContainerDialog";
import { fmtDuration } from "./format";
import { buildSteps, relativeTo, shortReference, validImageTag, type BuildStep } from "./pageModel";
import { containersBuildDetail, containersBuildRemove, containersBuilds } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { BuildDetail, BuildRecord, ImageRow, RuntimeInfo } from "../../types/containers";

/**
 * «Builds»: BuildKit's own history of what this engine built — the builds started here and the ones
 * typed in a terminal alike (`containers::builds`) — newest first, with the one picked beside the
 * list: how long it took, its steps (run or cached, each against the slowest), the layers and
 * vulnerabilities of the image it made. «Construir imagen» starts a new one as one of the manager's
 * jobs, which lands in the same history when it ends.
 *
 * Engines without that history (Podman, nerdctl, a Docker without buildx' `history`) keep what this
 * page showed before: the last builds started from here, to build again or to fill the form with.
 */

interface BuildParams {
  folder: string;
  dockerfile: string;
  tag: string;
}

interface PastBuild extends BuildParams {
  at: number;
  code: number | null;
}

type Filter = "all" | "completed" | "failed";
type Tab = "steps" | "layers" | "security";
type StepFilter = "all" | "ran" | "cached" | "failed";

const RECENT = 5;
const sameParams = (a: BuildParams, b: BuildParams) => a.folder === b.folder && a.dockerfile === b.dockerfile && a.tag === b.tag;

/** Seconds a record took, from its two stamps — `null` while it runs. */
function secondsOf(record: BuildRecord): number | null {
  const start = Date.parse(record.createdAt);
  const end = Date.parse(record.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
}

function useBuildAction(runtime: RuntimeInfo, context: string | null) {
  const t = useT();
  const startJob = useContainersJobsStore((s) => s.start);
  return (params: BuildParams) => {
    void startJob(
      t("containers.m.build.building", { tag: params.tag }),
      { kind: "build", runtime: runtime.id, context, target: params.tag, buildContext: params.folder, dockerfile: params.dockerfile, tag: params.tag },
      { refresh: ["images"], done: t("containers.m.build.built", { tag: params.tag }), runImage: params.tag, meta: { folder: params.folder, dockerfile: params.dockerfile, tag: params.tag } },
    );
  };
}

export function BuildPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const jobsHistory = useContainersJobsStore((s) => s.history);
  const runningJobs = useContainersJobsStore((s) => s.jobs.some((j) => j.request.kind === "build" && !j.ended));
  const [builds, setBuilds] = useState<{ rows: BuildRecord[] | null; error: string | null }>({ rows: null, error: null });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<BuildParams | null>(null);
  const ctr = runtime.id === "ctr";
  const supported = runtime.id === "docker" && builds.error !== "unsupported";

  const load = () => {
    if (runtime.id !== "docker" || !runtime.running) return;
    containersBuilds(runtime.id, context)
      .then((rows) => setBuilds({ rows, error: null }))
      .catch((e: unknown) => setBuilds((current) => ({ rows: current.rows, error: String(e) })));
  };
  useEffect(() => {
    setBuilds({ rows: null, error: null });
    setPicked(null);
  }, [runtime.id, context]);
  // Faster while a build runs, so its record appears and finishes on screen.
  const anyRunning = runningJobs || (builds.rows ?? []).some((b) => b.status === "running");
  useInterval(load, anyRunning ? 2000 : 8000, runtime.id === "docker" && runtime.running);
  useEffect(load, [jobsHistory.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = builds.rows ?? NO_ROWS;
  const completed = rows.filter((b) => b.status === "completed").length;
  const failedRows = rows.filter((b) => b.status === "failed" || b.status === "canceled");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (b) =>
        (filter === "all" || (filter === "completed" ? b.status === "completed" : b.status === "failed" || b.status === "canceled")) && (!needle || b.name.toLowerCase().includes(needle) || b.id.startsWith(needle)),
    );
  }, [rows, query, filter]);
  const current = shown.find((b) => b.id === picked) ?? shown[0];

  const remove = async (ids: string[], message: string) => {
    if (!ids.length || !(await confirmAction(message, true, t("containers.m.builds.remove")))) return;
    try {
      await containersBuildRemove(runtime.id, context, ids);
      pushSuccessToast(t("containers.m.builds.removed"));
      if (picked && ids.includes(picked)) setPicked(null);
      load();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.m.section.build")} sub={supported && rows.length ? String(rows.length) : undefined}>
        {supported && failedRows.length > 0 && (
          <Button size="sm" variant="ghost" className="text-[var(--cf-danger)]" onClick={() => void remove(failedRows.map((b) => b.id), t("containers.m.builds.confirmClearFailed", { count: failedRows.length }))}>
            <Trash2 size={13} />
            {t("containers.m.builds.clearFailed", { count: failedRows.length })}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => setForm({ folder: "", dockerfile: "Dockerfile", tag: "" })} disabled={ctr || !runtime.running}>
          <Hammer size={13} />
          {t("containers.m.builds.new")}
        </Button>
      </PageHead>
      {ctr ? (
        <EmptyLine>{t("containers.m.build.unsupported")}</EmptyLine>
      ) : !runtime.running ? (
        <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
      ) : !supported ? (
        <RecentBuilds runtime={runtime} context={context} onFill={setForm} />
      ) : (
        <>
          <PageToolbar>
            <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.builds.search")} width={200} />
            <FilterChips
              label={t("containers.m.filters")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("containers.m.filter.all"), count: rows.length },
                { value: "completed", label: t("containers.m.builds.filter.completed"), count: completed, tone: "ok" },
                { value: "failed", label: t("containers.m.builds.filter.failed"), count: failedRows.length, tone: "bad" },
              ]}
            />
          </PageToolbar>
          {builds.error && !builds.rows ? (
            <EmptyLine>{builds.error}</EmptyLine>
          ) : !builds.rows ? (
            <LoadingLine />
          ) : rows.length === 0 ? (
            <EmptyLine>{t("containers.m.builds.none")}</EmptyLine>
          ) : (
            <div className="flex min-h-0 flex-1">
              <BuildList builds={shown} current={current?.id ?? null} onPick={setPicked} />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {current ? (
                  <BuildDetailPane
                    key={current.id}
                    runtime={runtime}
                    context={context}
                    record={current}
                    onRemove={() => void remove([current.id], t("containers.m.builds.confirmRemove", { name: current.name || current.id }))}
                  />
                ) : (
                  <MutedNote>{t("containers.m.builds.noMatch")}</MutedNote>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {form && <BuildDialog runtime={runtime} context={context} initial={form} onClose={() => setForm(null)} />}
    </div>
  );
}

function StatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  if (status === "completed") return <CheckCircle2 size={size} className="shrink-0 text-[var(--cf-success)]" />;
  if (status === "running") return <Loader2 size={size} className="shrink-0 animate-spin text-[var(--cf-accent)]" />;
  return <XCircle size={size} className="shrink-0 text-[var(--cf-danger)]" />;
}

/** The history's column: each build's state, name, how long it took and when. */
function BuildList({ builds, current, onPick }: { builds: BuildRecord[]; current: string | null; onPick: (id: string) => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  return (
    <div role="listbox" aria-label={t("containers.m.section.build")} className="flex w-[280px] min-w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--cf-border)] p-2">
      {builds.length === 0 && <p className="px-2 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.builds.noMatch")}</p>}
      {builds.map((b) => {
        const on = b.id === current;
        const seconds = secondsOf(b);
        return (
          <button
            key={b.id}
            role="option"
            aria-selected={on}
            onClick={() => onPick(b.id)}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${on ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"}`}
          >
            <StatusIcon status={b.status} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{b.name || b.id}</span>
              <span className="truncate text-[11px] text-[var(--cf-text-muted)]">
                {[seconds !== null ? fmtDuration(seconds) : t("containers.m.builds.status.running"), ago(b.createdAt, language)].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const STATUS_CHIP: Record<string, string> = {
  completed: "bg-[color-mix(in_srgb,var(--cf-success)_16%,transparent)] text-[var(--cf-success)]",
  failed: "bg-[color-mix(in_srgb,var(--cf-danger)_14%,transparent)] text-[var(--cf-danger)]",
  canceled: "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]",
  running: "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]",
};

function BuildDetailPane({ runtime, context, record, onRemove }: { runtime: RuntimeInfo; context: string | null; record: BuildRecord; onRemove: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const images = useContainersStore((s) => (s.lists[listKey(runtime.id, context, null, "images")]?.rows ?? NO_ROWS) as ImageRow[]);
  const refreshList = useContainersStore((s) => s.refreshList);
  const [detail, setDetail] = useState<{ value: BuildDetail | null; error: string | null }>({ value: null, error: null });
  const [tab, setTab] = useState<Tab>("steps");
  const running = record.status === "running";

  useEffect(() => {
    void refreshList(runtime.id, "images");
  }, [runtime.id, context, refreshList]);
  // Read again when its state moves (a running build ends), and every few seconds while it runs.
  const read = () => {
    containersBuildDetail(runtime.id, context, record.id)
      .then((value) => setDetail({ value, error: null }))
      .catch((e: unknown) => setDetail((current) => ({ value: current.value, error: String(e) })));
  };
  useEffect(read, [record.id, record.status, record.completedSteps]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(read, 2500, running);

  const steps = useMemo(() => (detail.value ? buildSteps(detail.value.logs) : []), [detail.value]);
  // The image it made, when the engine has it: by the build's name, which buildx takes from the tag.
  const image = useMemo(() => {
    const name = record.name.trim();
    if (!name) return null;
    return images.find((i) => !i.dangling && (i.reference === name || shortReference(i.reference) === name || shortReference(i.repository) === name || i.repository.endsWith(`/${name}`))) ?? null;
  }, [images, record.name]);
  const seconds = detail.value?.durationMs != null ? detail.value.durationMs / 1000 : secondsOf(record);
  const status = detail.value?.status ?? record.status;
  const started = Date.parse(record.createdAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--cf-border)] px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <h3 className="min-w-0 truncate text-[16px] font-semibold text-[var(--cf-text)]">{record.name || record.id}</h3>
          <span className={`shrink-0 rounded-full px-2 py-px text-[11px] font-medium ${STATUS_CHIP[status] ?? STATUS_CHIP.canceled}`}>{t(`containers.m.builds.status.${status}` as TranslationKey)}</span>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={onRemove} disabled={running}>
            {t("containers.m.builds.remove")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-[var(--cf-text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={12} />
            {fmtDuration(seconds)}
          </span>
          {Number.isFinite(started) && (
            <span className="inline-flex items-center gap-1.5" title={record.createdAt}>
              <CalendarDays size={12} />
              {new Date(started).toLocaleString(language === "es" ? "es" : "en", { dateStyle: "medium", timeStyle: "short" })}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Layers size={12} />
            {t("containers.m.builds.steps", { done: record.completedSteps, total: record.totalSteps, cached: record.cachedSteps })}
          </span>
          {detail.value?.platforms.length ? <span className="font-mono text-[11.5px]">{detail.value.platforms.join(", ")}</span> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--cf-text-faint)]">
          {detail.value?.context && (
            <span className="min-w-0 truncate font-mono" title={`${detail.value.context}\n${detail.value.dockerfile}`}>
              {detail.value.context}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            #<CopyText text={record.id} shown={record.id.slice(0, 12)} toast={t("containers.m.builds.copiedRef")} title={t("containers.copyId")} />
          </span>
        </div>
      </div>
      <PageTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "steps", label: t("containers.m.builds.tab.steps") },
          { value: "layers", label: t("containers.m.image.tab.layers") },
          { value: "security", label: t("containers.m.image.tab.security") },
        ]}
      />
      {tab === "steps" ? (
        detail.error && !detail.value ? (
          <MutedNote>{detail.error}</MutedNote>
        ) : !detail.value ? (
          <LoadingLine />
        ) : (
          <StepsView steps={steps} error={detail.value.error} />
        )
      ) : !image ? (
        <MutedNote>{t("containers.m.builds.noImage", { name: record.name || record.id })}</MutedNote>
      ) : tab === "layers" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <LayersView runtime={runtime.id} context={context} reference={image.reference} total={image.sizeBytes} />
        </div>
      ) : (
        <SecurityTab runtime={runtime.id} context={context} reference={image.reference} />
      )}
    </div>
  );
}

/** Each step with its state and length — a bar against the slowest — and its output a click away. */
function StepsView({ steps, error }: { steps: BuildStep[]; error: string }) {
  const t = useT();
  const [filter, setFilter] = useState<StepFilter>("all");
  const [internal, setInternal] = useState(false);
  const [open, setOpen] = useState<Set<number>>(() => new Set(steps.filter((s) => s.state === "error").map((s) => s.n)));
  const shown = steps.filter(
    (s) =>
      (internal || !s.internal) &&
      (filter === "all" || (filter === "ran" ? s.state === "done" : filter === "cached" ? s.state === "cached" : s.state === "error")),
  );
  const slowest = Math.max(0.1, ...steps.filter((s) => !s.internal).map((s) => s.seconds ?? 0));
  const allOpen = shown.length > 0 && shown.every((s) => open.has(s.n));
  const toggle = (n: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="w-[170px]">
          <Select
            size="sm"
            value={filter}
            onChange={(v) => setFilter(v as StepFilter)}
            ariaLabel={t("containers.m.builds.tab.steps")}
            options={(["all", "ran", "cached", "failed"] as StepFilter[]).map((v) => ({ value: v, label: t(`containers.m.builds.stepFilter.${v}` as TranslationKey) }))}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          <Checkbox checked={internal} onChange={() => setInternal((v) => !v)} />
          {t("containers.m.builds.internal")}
        </label>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((s) => s.n)))} disabled={shown.length === 0}>
          {allOpen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          {allOpen ? t("containers.m.builds.collapseAll") : t("containers.m.builds.expandAll")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {error && <p className="mb-2 whitespace-pre-wrap rounded-md bg-[color-mix(in_srgb,var(--cf-danger)_10%,transparent)] px-3 py-2 font-mono text-[11.5px] text-[var(--cf-danger)]">{error}</p>}
        {shown.length === 0 ? (
          <p className="py-2 text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.builds.noSteps")}</p>
        ) : (
          <ol className="overflow-hidden rounded-[10px] border border-[var(--cf-border)]">
            {shown.map((step) => {
              const expanded = open.has(step.n);
              return (
                <li key={step.n} className="border-b border-[color-mix(in_srgb,var(--cf-border)_60%,transparent)] last:border-b-0">
                  <button onClick={() => toggle(step.n)} className="flex min-h-[40px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)]">
                    {expanded ? <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" /> : <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />}
                    {step.state === "cached" ? (
                      <Zap size={15} className="shrink-0 text-[var(--cf-text-faint)]" />
                    ) : step.state === "error" ? (
                      <XCircle size={15} className="shrink-0 text-[var(--cf-danger)]" />
                    ) : step.state === "running" ? (
                      <Loader2 size={15} className="shrink-0 animate-spin text-[var(--cf-accent)]" />
                    ) : (
                      <CheckCircle2 size={15} className="shrink-0 text-[var(--cf-success)]" />
                    )}
                    {step.stage && <span className="shrink-0 font-mono text-[11.5px] text-[var(--cf-text-muted)]">[{step.stage}]</span>}
                    <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${step.state === "cached" || step.internal ? "text-[var(--cf-text-muted)]" : "font-medium text-[var(--cf-text)]"}`} title={step.command}>
                      {step.command}
                    </span>
                    {step.state === "cached" ? (
                      <span className="w-[150px] shrink-0 text-right text-[11.5px] font-medium text-[var(--cf-text-muted)]">{t("containers.m.builds.cached")}</span>
                    ) : (
                      <span className="flex w-[150px] shrink-0 flex-col items-end gap-1">
                        <span className="font-mono text-[11.5px] tabular-nums text-[var(--cf-text)]">{fmtDuration(step.seconds)}</span>
                        {step.seconds !== null && !step.internal && <CountBar value={step.seconds} max={slowest} width={150} tone={step.state === "error" ? "danger" : "accent"} />}
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-[color-mix(in_srgb,var(--cf-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--cf-hover)_50%,transparent)] px-4 py-2 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                      {step.output.length ? step.output.join("\n") : t("containers.m.builds.noOutput")}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

/** «Construir imagen»: a folder, its Dockerfile and a tag, built as one of the manager's jobs. */
function BuildDialog({ runtime, context, initial, onClose }: { runtime: RuntimeInfo; context: string | null; initial: BuildParams; onClose: () => void }) {
  const t = useT();
  const build = useBuildAction(runtime, context);
  const [folder, setFolder] = useState(initial.folder);
  const [dockerfile, setDockerfile] = useState(initial.dockerfile || "Dockerfile");
  const [tag, setTag] = useState(initial.tag);
  const tagOk = validImageTag(tag);
  const ready = !!folder.trim() && !!dockerfile.trim() && tagOk;
  const submit = () => {
    if (!ready) return;
    build({ folder: folder.trim(), dockerfile: dockerfile.trim(), tag: tag.trim() });
    onClose();
  };
  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, title: t("containers.m.build.pickContext"), defaultPath: folder || undefined });
    if (typeof dir === "string") setFolder(dir);
  };
  const pickDockerfile = async () => {
    const file = await openDialog({ title: t("containers.m.build.pickDockerfile"), defaultPath: folder || undefined });
    // Inside the folder it is written relative to it, the way `-f` is usually given.
    if (typeof file === "string") setDockerfile(folder ? relativeTo(folder, file) : file);
  };
  const mono = fieldClass({ size: "sm", className: "w-full min-w-0 font-mono" });
  return (
    <Dialog
      title={t("containers.m.builds.new")}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={submit} disabled={!ready} title={ready ? undefined : t("containers.m.build.needs")}>
            <Hammer size={13} />
            {t("containers.m.build.build")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("containers.m.build.context")}>
          <div className="flex gap-1">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("containers.m.build.contextPlaceholder")} spellCheck={false} className={mono} />
            <button type="button" onClick={() => void pickFolder()} title={t("containers.m.build.pickContext")} className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <FolderOpen size={13} />
            </button>
          </div>
        </Field>
        <Field label={t("containers.m.build.dockerfile")}>
          <div className="flex gap-1">
            <input value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} placeholder="Dockerfile" spellCheck={false} className={mono} />
            <button type="button" onClick={() => void pickDockerfile()} title={t("containers.m.build.pickDockerfile")} className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <FileSearch size={13} />
            </button>
          </div>
        </Field>
        <Field label={t("containers.m.run.tag")} hint={tag.trim() && !tagOk ? t("containers.m.build.tagInvalid") : undefined}>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t("containers.m.build.tagPlaceholder")} spellCheck={false} className={mono} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Where the engine keeps no history: the last builds started from CodeFlow, as before. */
function RecentBuilds({ runtime, context, onFill }: { runtime: RuntimeInfo; context: string | null; onFill: (params: BuildParams) => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const history = useContainersJobsStore((s) => s.history);
  const build = useBuildAction(runtime, context);
  const [runImage, setRunImage] = useState<string | null>(null);
  const recent = useMemo(() => {
    const list: PastBuild[] = [];
    for (const past of history) {
      if (past.kind !== "build" || past.runtime !== runtime.id) continue;
      const params: BuildParams = { folder: past.meta.folder ?? "", dockerfile: past.meta.dockerfile ?? "", tag: past.meta.tag ?? "" };
      if (!list.some((b) => sameParams(b, params))) list.push({ ...params, at: past.at, code: past.code });
      if (list.length === RECENT) break;
    }
    return list;
  }, [history, runtime.id]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-2 pt-2.5">
      <p className="mb-2 text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.builds.unsupported")}</p>
      {recent.length > 0 && (
        <>
          <SectionTitle>{t("containers.m.build.recent")}</SectionTitle>
          <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr>
                <Th>{t("containers.m.run.tag")}</Th>
                <Th>{t("containers.m.build.context")}</Th>
                <Th width={190}>{t("containers.m.col.state")}</Th>
                <Th align="right" width={80}>
                  {t("containers.m.col.actions")}
                </Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((past) => (
                <tr key={`${past.tag}|${past.folder}|${past.dockerfile}`} className={trClass(false)}>
                  <Td>
                    <span className="block truncate font-mono text-[var(--cf-text)]" title={past.tag}>
                      {past.tag}
                    </span>
                  </Td>
                  <Td>
                    <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={`${past.folder}\n${past.dockerfile}`}>
                      {past.folder}
                    </span>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <StateDot tone={past.code === 0 ? "ok" : "bad"} />
                      <span className={past.code === 0 ? "text-[var(--cf-text)]" : "text-[var(--cf-danger)]"}>
                        {past.code === 0 ? t("containers.m.build.ok") : past.code === null ? t("containers.m.job.cut") : t("containers.m.job.failed", { code: past.code })}
                      </span>
                      <span className="text-[11px] text-[var(--cf-text-faint)]">{ago(new Date(past.at).toISOString(), language)}</span>
                    </span>
                  </Td>
                  <Td className="w-[80px]">
                    <div className="flex items-center justify-end gap-0.5">
                      {past.code === 0 && (
                        <RowAction label={t("containers.m.run.run")} onClick={() => setRunImage(past.tag)}>
                          <Play size={12} className="text-[var(--cf-success)]" />
                        </RowAction>
                      )}
                      <RowAction label={t("containers.m.build.rebuild")} onClick={() => build(past)}>
                        <RotateCw size={12} />
                      </RowAction>
                      <RowAction label={t("containers.m.build.useParams")} onClick={() => onFill(past)}>
                        <Undo2 size={12} />
                      </RowAction>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {runImage !== null && <RunContainerDialog runtime={runtime} context={context} initialImage={runImage} onClose={() => setRunImage(null)} />}
    </div>
  );
}
