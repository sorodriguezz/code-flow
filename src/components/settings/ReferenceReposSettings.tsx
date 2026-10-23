import { useCallback, useEffect, useState } from "react";
import { GitBranch, Loader2, Pencil, Plus, RefreshCw, ScanSearch, Trash2 } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { RailSection, PaneBlock } from "./settingsNav";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useConfirmStore } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { describeGitError } from "../../lib/gitErrors";
import { formatBytes } from "../../lib/tauri/backupCommands";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import {
  REFREPOS_KNOWLEDGE_KEY,
  REFREPOS_REVIEW_KEY,
  nameFromUrl,
  onReferenceReposChanged,
  referenceRepoAdd,
  referenceRepoPull,
  referenceRepoReindex,
  referenceRepoRemove,
  referenceRepoSetBranch,
  referenceRepoUpdate,
  referenceReposBranches,
  referenceReposList,
  type RefRepoPatch,
  type RefRepoView,
  type RemoteBranches,
} from "../../lib/tauri/refreposCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/** The update intervals offered, in hours (0 = only when asked). */
const INTERVALS: { hours: number; labelKey: TranslationKey }[] = [
  { hours: 0, labelKey: "refrepos.pullManual" },
  { hours: 1, labelKey: "refrepos.pullHourly" },
  { hours: 6, labelKey: "refrepos.pullSixHours" },
  { hours: 24, labelKey: "refrepos.pullDaily" },
  { hours: 168, labelKey: "refrepos.pullWeekly" },
];

const BUSY_LABEL: Record<NonNullable<RefRepoView["busy"]>, TranslationKey> = {
  cloning: "refrepos.busyCloning",
  pulling: "refrepos.busyPulling",
  switching: "refrepos.busySwitching",
  indexing: "refrepos.busyIndexing",
};

function ago(ms: number | null, t: ReturnType<typeof useT>): string {
  if (!ms) return t("refrepos.never");
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return t("knowledge.justNow");
  if (minutes < 60) return t("knowledge.minutesAgo", { n: String(minutes) });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("refrepos.hoursAgo", { n: String(hours) }) : new Date(ms).toLocaleDateString();
}

/**
 * Settings › Repositorios de referencia (`crate::refrepos`): other code bases cloned as memory for the
 * AI surfaces — searched by the chats, Codi and the agents, and looked into by the PR reviewer for
 * the contracts a pull request changes. Global, switched on per workspace.
 */
export function ReferenceReposSettings() {
  const t = useT();
  return (
    <RailSection section="references" title={t("refrepos.title")} hint={t("refrepos.hint")} fallback="repos">
      {(tab) => (
        <>
          {tab === "repos" && <ReposPane />}
          {tab === "use" && <UsePane />}
        </>
      )}
    </RailSection>
  );
}

function ReposPane() {
  const t = useT();
  const [repos, setRepos] = useState<RefRepoView[] | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRepos(await referenceReposList());
    } catch (e) {
      pushErrorToast(String(e));
      setRepos([]);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = onReferenceReposChanged(() => void reload());
    return () => {
      void off.then((unlisten) => unlisten());
    };
  }, [reload]);

  if (!repos) return <Loader2 size={14} className="animate-spin text-[var(--cf-text-muted)]" />;

  return (
    <div className="flex flex-col gap-4">
      {repos.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {repos.map((repo) => (
            <RepoRow key={repo.id} repo={repo} />
          ))}
        </div>
      )}
      {adding ? (
        <AddForm onDone={() => setAdding(false)} />
      ) : (
        <div>
          <button type="button" onClick={() => setAdding(true)} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Plus size={13} /> {t("refrepos.add")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Which workspaces a repository applies to: every one, or the ones ticked. */
function WorkspacePicker({
  all,
  chosen,
  onChange,
}: {
  all: boolean;
  chosen: string[];
  onChange: (all: boolean, chosen: string[]) => void;
}) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
        <Checkbox checked={all} onChange={(value) => onChange(value, chosen)} />
        {t("refrepos.allWorkspaces")}
      </label>
      {!all && (
        <div className="flex flex-wrap gap-1.5 pl-6">
          {workspaces.map((workspace) => {
            const on = chosen.includes(workspace.id);
            return (
              <button
                key={workspace.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(false, on ? chosen.filter((id) => id !== workspace.id) : [...chosen, workspace.id])}
                className={chipClass(on ? "accent" : "neutral", "cursor-pointer")}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: workspace.color || "var(--cf-text-muted)" }} />
                {workspace.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IntervalSelect({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  const t = useT();
  const known = INTERVALS.some((i) => i.hours === hours);
  const options = INTERVALS.map((i) => ({ value: String(i.hours), label: t(i.labelKey) }));
  if (!known) options.push({ value: String(hours), label: t("refrepos.pullEvery", { n: String(hours) }) });
  return (
    <div className="w-[180px]">
      <Select value={String(hours)} onChange={(value) => onChange(Number(value))} options={options} size="sm" ariaLabel={t("refrepos.autoPull")} />
    </div>
  );
}

/** The branches of a remote, asked once the URL is known. */
function useBranches() {
  const [branches, setBranches] = useState<RemoteBranches | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const fetchFor = async (url: string) => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setBranches(await referenceReposBranches(url.trim()));
    } catch (e) {
      setBranches(null);
      setError(describeGitError(e, t));
    } finally {
      setLoading(false);
    }
  };
  return { branches, loading, error, fetchFor, reset: () => setBranches(null) };
}

function AddForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [branch, setBranch] = useState("");
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [localOnly, setLocalOnly] = useState(false);
  const [hours, setHours] = useState(24);
  const [saving, setSaving] = useState(false);
  const remote = useBranches();

  const submit = async () => {
    if (!url.trim()) return;
    setSaving(true);
    try {
      await referenceRepoAdd({
        url: url.trim(),
        name: name.trim() || undefined,
        branch: branch || undefined,
        purpose: purpose.trim() || undefined,
        allWorkspaces: all,
        workspaces: chosen,
        localOnly,
        autoPullHours: hours,
      });
      onDone();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const branchOptions = (remote.branches?.branches ?? []).map((b) => ({
    value: b,
    label: b === remote.branches?.defaultBranch ? t("refrepos.defaultBranch", { name: b }) : b,
  }));

  return (
    <div className="flex max-w-[620px] flex-col gap-3 rounded-lg border border-[var(--cf-border)] p-3">
      <label className="flex flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
        {t("refrepos.url")}
        <div className="flex items-center gap-2">
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              remote.reset();
              setBranch("");
            }}
            onBlur={() => void remote.fetchFor(url)}
            placeholder="https://github.com/org/repositorio.git"
            className={fieldClass({ size: "sm", className: "flex-1 font-mono" })}
            autoFocus
          />
          <button type="button" disabled={!url.trim() || remote.loading} onClick={() => void remote.fetchFor(url)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {remote.loading ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
            {t("refrepos.seeBranches")}
          </button>
        </div>
        {remote.error && <span className="text-[11px] text-[var(--cf-danger)]">{remote.error}</span>}
      </label>
      {remote.branches && (
        <label className="flex flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
          {t("refrepos.branch")}
          <div className="w-[260px]">
            <Select
              value={branch || remote.branches.defaultBranch || ""}
              onChange={setBranch}
              options={branchOptions}
              size="sm"
              ariaLabel={t("refrepos.branch")}
            />
          </div>
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
          {t("refrepos.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={nameFromUrl(url) || t("refrepos.namePlaceholder")} className={fieldClass({ size: "sm" })} />
        </label>
        <label className="flex min-w-[240px] flex-[2] flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
          {t("refrepos.purpose")}
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={t("refrepos.purposePlaceholder")} className={fieldClass({ size: "sm" })} />
        </label>
      </div>
      <WorkspacePicker
        all={all}
        chosen={chosen}
        onChange={(nextAll, nextChosen) => {
          setAll(nextAll);
          setChosen(nextChosen);
        }}
      />
      <label className="flex items-start gap-2 text-[12px] text-[var(--cf-text)]">
        <Checkbox checked={localOnly} onChange={setLocalOnly} className="mt-[1px]" />
        <span>
          {t("refrepos.localOnly")}
          <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("refrepos.localOnlyHint")}</span>
        </span>
      </label>
      <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
        {t("refrepos.autoPull")}
        <IntervalSelect hours={hours} onChange={setHours} />
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={!url.trim() || saving} onClick={() => void submit()} className={buttonClass({ variant: "primary", size: "sm" })}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          {t("refrepos.clone")}
        </button>
        <button type="button" onClick={onDone} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function RepoRow({ repo }: { repo: RefRepoView }) {
  const t = useT();
  const ask = useConfirmStore((s) => s.ask);
  const [editing, setEditing] = useState(false);
  const busy = repo.busy !== null;

  const run = (action: () => Promise<unknown>) => {
    void action().catch((e) => pushErrorToast(String(e)));
  };
  const patch = (changes: RefRepoPatch) => run(() => referenceRepoUpdate(repo.id, changes));

  const state = repo.busy
    ? { tone: "accent" as const, label: t(BUSY_LABEL[repo.busy]) }
    : repo.lastError
      ? { tone: "bad" as const, label: t("refrepos.failed") }
      : !repo.cloned
        ? { tone: "warn" as const, label: t("refrepos.notCloned") }
        : !repo.enabled
          ? { tone: "neutral" as const, label: t("refrepos.off") }
          : null;

  return (
    <div className="flex flex-col gap-1 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-[var(--cf-text)]" title={repo.url}>
          {repo.name}
        </span>
        {repo.branch && (
          <span className={chipClass("neutral")}>
            <GitBranch size={11} />
            {repo.branch}
          </span>
        )}
        {repo.localOnly && <span className={chipClass("warn")}>{t("knowledge.localOnly")}</span>}
        {state && (
          <span className={chipClass(state.tone)}>
            {repo.busy && <Loader2 size={11} className="animate-spin" />}
            {state.label}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy}
          title={repo.cloned ? t("refrepos.pull") : t("refrepos.cloneAgain")}
          onClick={() => run(() => referenceRepoPull(repo.id))}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          disabled={busy || !repo.cloned}
          title={t("refrepos.reindex")}
          onClick={() => run(() => referenceRepoReindex(repo.id))}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <ScanSearch size={13} />
        </button>
        <button type="button" aria-pressed={editing} title={t("refrepos.edit")} onClick={() => setEditing((v) => !v)} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Pencil size={13} />
        </button>
        <button
          type="button"
          disabled={busy}
          title={t("refrepos.remove")}
          onClick={() =>
            void ask({ message: t("refrepos.removeConfirm", { name: repo.name }), confirmLabel: t("refrepos.remove"), danger: true }).then((ok) => {
              if (ok) run(() => referenceRepoRemove(repo.id));
            })
          }
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
        {repo.head && `${repo.head.slice(0, 8)} · `}
        {t("refrepos.updated", { when: ago(repo.pulledAt, t) })}
        {repo.sizeBytes > 0 && ` · ${formatBytes(repo.sizeBytes)}`}
        {repo.index && ` · ${t("knowledge.counts", { files: String(repo.index.files), chunks: String(repo.index.chunks) })}`}
        {repo.index && repo.index.vectors > 0 && ` · ${t("knowledge.vectors", { n: String(repo.index.vectors) })}`}
        {repo.autoPullHours === 0 && ` · ${t("refrepos.pullManual")}`}
      </span>
      {repo.purpose && <span className="text-[11px] leading-snug text-[var(--cf-text)]">{repo.purpose}</span>}
      {repo.lastError && !busy && <span className="text-[11px] leading-snug text-[var(--cf-danger)]">{describeGitError(repo.lastError, t)}</span>}
      {editing && <EditPanel repo={repo} onPatch={patch} />}
    </div>
  );
}

function EditPanel({ repo, onPatch }: { repo: RefRepoView; onPatch: (changes: RefRepoPatch) => void }) {
  const t = useT();
  const [name, setName] = useState(repo.name);
  const [purpose, setPurpose] = useState(repo.purpose);
  const remote = useBranches();
  const branchOptions = (remote.branches?.branches ?? (repo.branch ? [repo.branch] : [])).map((b) => ({ value: b, label: b }));

  return (
    <div className="mt-1 flex flex-col gap-2.5 rounded-md bg-[var(--cf-surface-2)] p-2.5">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[11px] text-[var(--cf-text-muted)]">
          {t("refrepos.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== repo.name && onPatch({ name })} className={fieldClass({ size: "sm" })} />
        </label>
        <label className="flex min-w-[220px] flex-[2] flex-col gap-1 text-[11px] text-[var(--cf-text-muted)]">
          {t("refrepos.purpose")}
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            onBlur={() => purpose !== repo.purpose && onPatch({ purpose })}
            placeholder={t("refrepos.purposePlaceholder")}
            className={fieldClass({ size: "sm" })}
          />
        </label>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
        {t("refrepos.branch")}
        <div className="w-[240px]">
          <Select
            value={repo.branch}
            onChange={(branch) => branch !== repo.branch && void referenceRepoSetBranch(repo.id, branch).catch((e) => pushErrorToast(String(e)))}
            options={branchOptions}
            loading={remote.loading}
            disabled={repo.busy !== null}
            size="sm"
            ariaLabel={t("refrepos.branch")}
          />
        </div>
        {!remote.branches && (
          <button type="button" disabled={remote.loading} onClick={() => void remote.fetchFor(repo.url)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <GitBranch size={13} /> {t("refrepos.seeBranches")}
          </button>
        )}
      </div>
      {remote.error && <span className="text-[11px] text-[var(--cf-danger)]">{remote.error}</span>}
      <WorkspacePicker all={repo.allWorkspaces} chosen={repo.workspaces} onChange={(all, chosen) => onPatch({ allWorkspaces: all, workspaces: chosen })} />
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={repo.enabled} onChange={(enabled) => onPatch({ enabled })} />
          {t("refrepos.enabled")}
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={repo.localOnly} onChange={(localOnly) => onPatch({ localOnly })} />
          {t("refrepos.localOnly")}
        </label>
        <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          {t("refrepos.autoPull")}
          <IntervalSelect hours={repo.autoPullHours} onChange={(autoPullHours) => onPatch({ autoPullHours })} />
        </div>
      </div>
    </div>
  );
}

/** Where the reference repositories are used — two switches, both on unless turned off. */
function UsePane() {
  const t = useT();
  const [values, setValues] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    void Promise.all([getSetting(REFREPOS_KNOWLEDGE_KEY), getSetting(REFREPOS_REVIEW_KEY)]).then(([knowledge, review]) =>
      setValues({ [REFREPOS_KNOWLEDGE_KEY]: knowledge !== "false", [REFREPOS_REVIEW_KEY]: review !== "false" }),
    );
  }, []);

  if (!values) return null;
  const toggle = (key: string, on: boolean) => {
    setValues({ ...values, [key]: on });
    void setSetting(key, on ? "true" : "false").catch((e) => pushErrorToast(String(e)));
  };

  return (
    <div className="flex flex-col">
      <PaneBlock title={t("refrepos.useSearchTitle")} hint={t("refrepos.useSearchHint")}>
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={values[REFREPOS_KNOWLEDGE_KEY]} onChange={(on) => toggle(REFREPOS_KNOWLEDGE_KEY, on)} />
          {t("refrepos.useSearch")}
        </label>
      </PaneBlock>
      <PaneBlock title={t("refrepos.useReviewTitle")} hint={t("refrepos.useReviewHint")}>
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={values[REFREPOS_REVIEW_KEY]} onChange={(on) => toggle(REFREPOS_REVIEW_KEY, on)} />
          {t("refrepos.useReview")}
        </label>
      </PaneBlock>
      <PaneBlock title={t("refrepos.enginesTitle")}>
        <ul className="flex max-w-[62ch] list-disc flex-col gap-1 pl-4 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          <li>{t("refrepos.engineMcp")}</li>
          <li>{t("refrepos.engineLocal")}</li>
          <li>{t("refrepos.engineOthers")}</li>
        </ul>
      </PaneBlock>
    </div>
  );
}
