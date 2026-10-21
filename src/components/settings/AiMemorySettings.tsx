import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, History, Lightbulb, Pencil, Plus, Search, Trash2, Undo2, X } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import {
  aiMemoryCreate,
  aiMemoryDelete,
  aiMemoryEdit,
  aiMemoryList,
  aiMemoryPropose,
  aiMemoryRevisions,
  aiMemorySetStatus,
  MEMORY_STALE_DAYS,
  type Memory,
  type MemoryFilter,
  type MemoryKind,
  type MemoryPatch,
  type MemoryRevision,
  type MemoryScope,
  type MemoryStatus,
} from "../../lib/tauri/memoryCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

const KIND_KEY: Record<MemoryKind, TranslationKey> = {
  preference: "memory.kindPreference",
  convention: "memory.kindConvention",
  decision: "memory.kindDecision",
  fact: "memory.kindFact",
};

const SCOPE_KEY: Record<MemoryScope, TranslationKey> = {
  global: "memory.scopeGlobal",
  workspace: "memory.scopeWorkspace",
  project: "memory.scopeProject",
  task: "memory.scopeTask",
};

/** Who proposed a memory. Anything else (a future writer) shows as it is stored. */
const SOURCE_KEY: Record<string, TranslationKey> = {
  user: "memory.sourceUser",
  agent: "memory.sourceAgent",
  flow: "memory.sourceFlow",
  experience: "memory.sourceExperience",
};

/** Rows per page — the pane pages in SQL instead of loading every memory of every workspace. */
const PAGE = 50;

/** Which memories the list shows: what applies here (the default), one repository, one workspace, or the global ones. */
type Where = "all" | "project" | "workspace" | "global";
/** A status, or «sin uso» — approved and unused for 90 days. */
type StatusFilter = "" | MemoryStatus | "stale";

/** What a memory is besides its text — shared by the add and the edit forms. */
interface Fields {
  kind: MemoryKind;
  localOnly: boolean;
  /** `yyyy-mm-dd`, or empty for no expiry. */
  expires: string;
  /** The id of the memory this one replaces, or empty. */
  supersedes: string;
}

/** A moment as a date input holds it: the local day, `yyyy-mm-dd`. */
function toDay(ms: number | null): string {
  if (ms == null) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The last moment of a local day — "expires on the 3rd" keeps the memory all of the 3rd. */
function fromDay(day: string): number | null {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString();

/** The fields' part of a patch: an empty expiry or replacement clears it. */
function fieldsPatch(fields: Fields): MemoryPatch {
  const expiresAt = fromDay(fields.expires);
  return {
    kind: fields.kind,
    localOnly: fields.localOnly,
    ...(expiresAt == null ? { clearExpiry: true } : { expiresAt }),
    ...(fields.supersedes ? { supersedes: fields.supersedes } : { clearSupersedes: true }),
  };
}

/** The server-side filter for what the pane shows. With no workspace open, only the global memories. */
function filterFor(where: Where, status: StatusFilter, query: string, workspaceId: string | null, projectId: string | null): MemoryFilter {
  const base: MemoryFilter = {
    query: query.trim() || null,
    status: status && status !== "stale" ? status : null,
    stale: status === "stale",
  };
  if (where === "global" || !workspaceId) return { ...base, scope: "global" };
  if (where === "project" && projectId) return { ...base, projectId };
  if (where === "workspace") return { ...base, scope: "workspace", workspaceId };
  return { ...base, workspaceId, includeGlobal: true };
}

/**
 * «Reemplaza a…»: an approved memory this one replaces — revoked when this one is approved (at once
 * when it already is). The options are the approved memories that apply in the memory's workspace.
 */
function ReplaceSelect({
  workspaceId,
  exclude,
  value,
  currentTitle,
  onChange,
}: {
  workspaceId: string | null;
  exclude?: string;
  value: string;
  /** The title of what it replaces now — revoked by then, so not among the approved options. */
  currentTitle?: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<Memory[]>([]);
  useEffect(() => {
    let live = true;
    const place: MemoryFilter = workspaceId ? { workspaceId, includeGlobal: true } : { scope: "global" };
    aiMemoryList({ ...place, status: "approved", limit: 200 })
      .then((page) => live && setOptions(page.rows))
      .catch(() => live && setOptions([]));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const items = options.filter((m) => m.id !== exclude).map((m) => ({ value: m.id, label: m.title }));
  if (value && !items.some((item) => item.value === value)) items.unshift({ value, label: currentTitle ?? value });
  return (
    <div className="w-[190px]">
      <Select
        size="sm"
        value={value}
        ariaLabel={t("memory.supersedes")}
        onChange={onChange}
        options={[{ value: "", label: t("memory.supersedesNone") }, ...items]}
      />
    </div>
  );
}

/** Kind, expiry, replacement and local-only — the same controls when adding and when editing. */
function FieldsRow({
  value,
  onChange,
  workspaceId,
  exclude,
  currentTitle,
}: {
  value: Fields;
  onChange: (next: Fields) => void;
  workspaceId: string | null;
  exclude?: string;
  currentTitle?: string | null;
}) {
  const t = useT();
  return (
    <>
      <div className="w-[150px]">
        <Select
          size="sm"
          value={value.kind}
          ariaLabel={t("memory.kind")}
          onChange={(kind) => onChange({ ...value, kind: kind as MemoryKind })}
          options={(Object.keys(KIND_KEY) as MemoryKind[]).map((k) => ({ value: k, label: t(KIND_KEY[k]) }))}
        />
      </div>
      <label className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
        {t("memory.expires")}
        <input
          type="date"
          value={value.expires}
          onChange={(e) => onChange({ ...value, expires: e.target.value })}
          aria-label={t("memory.expires")}
          className={fieldClass({ size: "sm", className: "w-[132px]" })}
        />
      </label>
      <ReplaceSelect workspaceId={workspaceId} exclude={exclude} value={value.supersedes} currentTitle={currentTitle} onChange={(supersedes) => onChange({ ...value, supersedes })} />
      <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
        <Checkbox checked={value.localOnly} onChange={(localOnly) => onChange({ ...value, localOnly })} />
        {t("memory.localOnly")}
      </label>
    </>
  );
}

/**
 * Settings › Memoria: what CodeFlow remembers between conversations (`crate::ai_memory`) — shared
 * by every engine, local or cloud. Candidates wait here for approval (and are approved as the kind
 * the user picks: an agent's proposal arrives as a fact); only approved memories are shown to a
 * model, and a local-only one never to a cloud engine. Filtered and paged by the backend; each row
 * says where it applies, who proposed it, when it expires or what it replaces, and whether it has
 * gone unused for 90 days («sin uso» — a prompt to review, never a deletion).
 */
export function AiMemorySettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const [where, setWhere] = useState<Where>("all");
  const [status, setStatus] = useState<StatusFilter>("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<Memory[]>([]);
  const [counts, setCounts] = useState({ total: 0, candidates: 0, stale: 0 });
  const [draft, setDraft] = useState<({ title: string; body: string; scope: MemoryScope } & Fields) | null>(null);
  const [editing, setEditing] = useState<({ id: string; title: string; body: string; workspaceId: string | null } & Fields) | null>(null);
  const [details, setDetails] = useState<{ id: string; revisions: MemoryRevision[] } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filter = useMemo(() => filterFor(where, status, debounced, workspaceId, projectId), [where, status, debounced, workspaceId, projectId]);

  /** Loads the first `size` rows again — after an action, as many as were showing, so the user keeps their place. */
  const reload = useCallback(
    async (size = PAGE) => {
      try {
        const page = await aiMemoryList({ ...filter, limit: Math.max(PAGE, size), offset: 0 });
        setRows(page.rows);
        setCounts({ total: page.total, candidates: page.candidates, stale: page.stale });
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [filter],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const more = async () => {
    try {
      const page = await aiMemoryList({ ...filter, limit: PAGE, offset: rows.length });
      setRows((current) => [...current, ...page.rows.filter((m) => !current.some((c) => c.id === m.id))]);
      setCounts({ total: page.total, candidates: page.candidates, stale: page.stale });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      pushErrorToast(String(e));
    }
    void reload(rows.length);
  };

  const save = async () => {
    if (!draft || (!draft.title.trim() && !draft.body.trim())) return;
    const current = draft;
    setDraft(null);
    await act(async () => {
      const { memory, outcome } = await aiMemoryCreate({
        scope: current.scope,
        workspaceId,
        projectId: current.scope === "project" ? projectId : null,
        kind: current.kind,
        title: current.title,
        body: current.body,
        approved: true,
        localOnly: current.localOnly,
        expiresAt: fromDay(current.expires),
        supersedes: current.supersedes || null,
      });
      // The same title was already there: say what became of it rather than pretend it is new.
      if (outcome === "approved") pushSuccessToast(t("memory.approvedExisting", { title: memory.title }));
      else if (outcome === "updated") pushSuccessToast(t("memory.updated", { title: memory.title }));
      else if (outcome === "already_known") pushSuccessToast(t("memory.alreadyKnown", { title: memory.title }));
    });
  };

  const propose = async () => {
    if (!workspaceId) return;
    try {
      const found = await aiMemoryPropose(workspaceId);
      pushSuccessToast(t("memory.proposed", { n: String(found.length) }));
    } catch (e) {
      pushErrorToast(String(e));
    }
    void reload(rows.length);
  };

  const startEditing = (memory: Memory) =>
    setEditing({
      id: memory.id,
      title: memory.title,
      body: memory.body,
      workspaceId: memory.workspaceId,
      kind: memory.kind,
      localOnly: memory.localOnly,
      expires: toDay(memory.expiresAt),
      supersedes: memory.supersedes ?? "",
    });

  /** Where a memory applies, by name: the repository's or workspace's own, not "this one". */
  const placeLabel = (memory: Memory) => {
    if (memory.scope === "project" && memory.workspaceId) {
      const name = projectsByWorkspace[memory.workspaceId]?.find((p) => p.id === memory.projectId)?.name;
      if (name) return name;
    }
    if (memory.scope === "workspace") {
      const name = workspaces.find((w) => w.id === memory.workspaceId)?.name;
      if (name) return name;
    }
    return t(SCOPE_KEY[memory.scope]);
  };

  const sourceLabel = (source: string) => (SOURCE_KEY[source] ? t(SOURCE_KEY[source]) : source);
  const kindOptions = (Object.keys(KIND_KEY) as MemoryKind[]).map((k) => ({ value: k, label: t(KIND_KEY[k]) }));
  const filtering = where !== "all" || status !== "" || debounced.trim() !== "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[190px]">
          <Select
            size="sm"
            value={where}
            ariaLabel={t("memory.where")}
            onChange={(value) => setWhere(value as Where)}
            options={[
              { value: "all", label: t("memory.whereAll") },
              ...(projectId ? [{ value: "project", label: t("memory.scopeProject") }] : []),
              { value: "workspace", label: t("memory.scopeWorkspace") },
              { value: "global", label: t("memory.scopeGlobal") },
            ]}
          />
        </div>
        <div className="w-[170px]">
          <Select
            size="sm"
            value={status}
            ariaLabel={t("memory.status")}
            onChange={(value) => setStatus(value as StatusFilter)}
            options={[
              { value: "", label: t("memory.allStatuses") },
              { value: "candidate", label: t("memory.candidates") },
              { value: "approved", label: t("memory.approved") },
              { value: "stale", label: t("memory.staleFilter", { n: String(MEMORY_STALE_DAYS) }) },
              { value: "revoked", label: t("memory.revoked") },
            ]}
          />
        </div>
        <label className="relative flex items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-[var(--cf-text-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("memory.search")}
            aria-label={t("memory.search")}
            className={fieldClass({ size: "sm", className: "w-[160px] pl-6" })}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            setDraft({ title: "", body: "", kind: "convention", scope: projectId ? "project" : "workspace", localOnly: false, expires: "", supersedes: "" })
          }
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          <Plus size={13} /> {t("memory.add")}
        </button>
        <button type="button" disabled={!workspaceId} onClick={() => void propose()} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Lightbulb size={13} /> {t("memory.propose")}
        </button>
        {counts.candidates > 0 && <span className={chipClass("info")}>{t("memory.pending", { n: String(counts.candidates) })}</span>}
        {counts.stale > 0 && (
          <button type="button" title={t("memory.staleHint", { n: String(MEMORY_STALE_DAYS) })} onClick={() => setStatus("stale")} className={chipClass("warn")}>
            {t("memory.staleCount", { n: String(counts.stale) })}
          </button>
        )}
      </div>

      {draft && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--cf-border)] p-3">
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={t("memory.titlePlaceholder")}
            aria-label={t("memory.title")}
            className={fieldClass({ size: "sm" })}
          />
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={t("memory.bodyPlaceholder")}
            aria-label={t("memory.body")}
            rows={3}
            className={`${fieldClass({ size: "sm" })} h-auto py-1.5`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[160px]">
              <Select
                size="sm"
                value={draft.scope}
                ariaLabel={t("memory.scope")}
                onChange={(value) => setDraft({ ...draft, scope: value as MemoryScope })}
                options={(["global", "workspace", ...(projectId ? ["project"] : [])] as MemoryScope[]).map((k) => ({ value: k, label: t(SCOPE_KEY[k]) }))}
              />
            </div>
            <FieldsRow value={draft} onChange={(fields) => setDraft({ ...draft, ...fields })} workspaceId={workspaceId} />
            <div className="ml-auto flex gap-1">
              <button type="button" onClick={() => setDraft(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                {t("memory.cancel")}
              </button>
              <button type="button" onClick={() => void save()} className={buttonClass({ variant: "primary", size: "sm" })}>
                {t("memory.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <span className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t(filtering ? "memory.noMatch" : "memory.empty")}</span>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {rows.map((memory) => (
            <div key={memory.id} className="border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={chipClass(memory.status === "candidate" ? "info" : memory.status === "approved" ? "ok" : "neutral")}>
                      {t(memory.status === "candidate" ? "memory.candidate" : memory.status === "approved" ? "memory.approvedOne" : "memory.revokedOne")}
                    </span>
                    {memory.status === "candidate" ? (
                      // A proposal is approved as whatever kind this says — the user's call, not the agent's.
                      <div className="w-[120px]">
                        <Select
                          size="sm"
                          value={memory.kind}
                          ariaLabel={t("memory.kind")}
                          onChange={(kind) => void act(() => aiMemoryEdit(memory.id, { kind: kind as MemoryKind }))}
                          options={kindOptions}
                        />
                      </div>
                    ) : (
                      <span className="text-[11px] text-[var(--cf-text-muted)]">{t(KIND_KEY[memory.kind])}</span>
                    )}
                    <span className="text-[11px] text-[var(--cf-text-muted)]">· {placeLabel(memory)}</span>
                    {memory.source !== "user" && <span className="text-[11px] text-[var(--cf-text-muted)]">· {t("memory.from", { source: sourceLabel(memory.source) })}</span>}
                    {memory.localOnly && <span className={chipClass("warn")}>{t("memory.localOnlyChip")}</span>}
                    {memory.stale && (
                      <span className={chipClass("warn")} title={t("memory.staleHint", { n: String(MEMORY_STALE_DAYS) })}>
                        {t("memory.stale")}
                      </span>
                    )}
                    {memory.expiresAt != null && <span className="text-[11px] text-[var(--cf-text-muted)]">· {t("memory.expiresOn", { date: shortDate(memory.expiresAt) })}</span>}
                    {memory.supersedesTitle && <span className="truncate text-[11px] text-[var(--cf-text-muted)]">· {t("memory.supersedesOne", { title: memory.supersedesTitle })}</span>}
                    {memory.useCount > 0 && <span className="text-[11px] text-[var(--cf-text-faint)]">· {t("memory.used", { n: String(memory.useCount) })}</span>}
                  </div>
                  {editing?.id === memory.id ? (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} aria-label={t("memory.title")} className={fieldClass({ size: "sm" })} />
                      <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={t("memory.body")} rows={3} className={`${fieldClass({ size: "sm" })} h-auto py-1.5`} />
                      <div className="flex flex-wrap items-center gap-2">
                        <FieldsRow
                          value={editing}
                          onChange={(fields) => setEditing({ ...editing, ...fields })}
                          workspaceId={editing.workspaceId}
                          exclude={editing.id}
                          currentTitle={memory.supersedesTitle}
                        />
                        <div className="ml-auto flex gap-1">
                          <button type="button" onClick={() => setEditing(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                            {t("memory.cancel")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const current = editing;
                              setEditing(null);
                              void act(() => aiMemoryEdit(current.id, { title: current.title, body: current.body, ...fieldsPatch(current) }));
                            }}
                            className={buttonClass({ variant: "primary", size: "sm" })}
                          >
                            {t("memory.save")}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-0.5 text-[12px] text-[var(--cf-text)]">{memory.title}</p>
                      {memory.body && memory.body !== memory.title && <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{memory.body}</p>}
                    </>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {memory.status !== "approved" && (
                    <button type="button" title={t("memory.approve")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "approved"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <Check size={13} />
                    </button>
                  )}
                  {memory.status === "approved" && (
                    <button type="button" title={t("memory.revoke")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "revoked"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <Undo2 size={13} />
                    </button>
                  )}
                  {memory.status === "candidate" && (
                    <button type="button" title={t("memory.discard")} onClick={() => void act(() => aiMemorySetStatus(memory.id, "revoked"))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <X size={13} />
                    </button>
                  )}
                  <button type="button" title={t("memory.edit")} onClick={() => startEditing(memory)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title={t("memory.history")}
                    onClick={() =>
                      details?.id === memory.id
                        ? setDetails(null)
                        : void aiMemoryRevisions(memory.id)
                            .then((revisions) => setDetails({ id: memory.id, revisions }))
                            .catch((e) => pushErrorToast(String(e)))
                    }
                    className={buttonClass({ variant: "ghost", size: "sm" })}
                  >
                    <History size={13} />
                  </button>
                  <button type="button" title={t("memory.delete")} onClick={() => void act(() => aiMemoryDelete(memory.id))} className={buttonClass({ variant: "ghost", size: "sm" })}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {details?.id === memory.id && (
                <div className="mt-1.5 flex flex-col gap-0.5 pl-1 text-[11px] text-[var(--cf-text-muted)]">
                  <span>
                    {[
                      t("memory.createdOn", { date: shortDate(memory.createdAt) }),
                      memory.approvedAt != null ? t("memory.approvedOn", { date: shortDate(memory.approvedAt) }) : null,
                      memory.usedAt != null ? t("memory.lastUsed", { date: shortDate(memory.usedAt) }) : t("memory.neverUsed"),
                      t("memory.origin", { source: sourceLabel(memory.source) }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {memory.evidence.length > 0 && (
                    <div className="flex flex-col">
                      <span>{t("memory.evidence")}</span>
                      {memory.evidence.map((entry) => (
                        <span key={entry} className="truncate pl-2 font-mono text-[10.5px] text-[var(--cf-text-faint)]" title={entry}>
                          {entry}
                        </span>
                      ))}
                    </div>
                  )}
                  {details.revisions.map((revision, index) => (
                    <span key={index} className="flex min-w-0 items-center gap-1">
                      <ChevronRight size={11} className="shrink-0" />
                      <span className="shrink-0">
                        {new Date(revision.at).toLocaleString()} · {revision.action} · {revision.actor}
                      </span>
                      {revision.body && (revision.action === "edited" || revision.action === "proposed") && <span className="truncate text-[var(--cf-text-faint)]">— {revision.body}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {rows.length < counts.total && (
            <button type="button" onClick={() => void more()} className={buttonClass({ variant: "ghost", size: "sm", className: "w-full justify-center rounded-none" })}>
              {t("memory.more", { n: String(counts.total - rows.length) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
