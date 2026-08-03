import { useEffect, useMemo, useState } from "react";
import {
  BookText,
  Boxes,
  CircleAlert,
  ExternalLink,
  FileCode2,
  FolderGit2,
  Network,
  Play,
  Plug,
  Plus,
  Square,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import { useDocsStore } from "../../state/docsStore";
import { useT } from "../../state/languageStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { loadAdoConnections } from "../../lib/adoConnections";
import { adoListProjects, adoListWikis, openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import type { AdoProject, AdoWiki, DocPage, DocScope } from "../../types/domain";

const FIELD =
  "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]";

const store = useDocsStore.getState;

/** The two kinds of document, as the sidebar and the composer both draw them. */
const SCOPE_ICON: Record<DocScope, typeof BookText> = { repo: FileCode2, workspace: Network };

/** A tinted square, the same shape the review screen uses for its section headings. */
function IconChip({ icon: Icon }: { icon: typeof BookText }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
      <Icon size={11} />
    </span>
  );
}

/**
 * Starting a document is choosing what it is *about*, and the two answers are different questions.
 *
 * A repository document is bound to one checkout at creation and stays bound: regenerating it later
 * must describe the same thing, not whatever happens to be ticked in a picker. A workspace document
 * has no single subject — it is about what happens between the repositories — so it takes its
 * repository set at generation time instead.
 */
function NewDocument({ onClose }: { onClose: () => void }) {
  const t = useT();
  const repos = useActiveProjects();
  const [scope, setScope] = useState<DocScope>("repo");
  const [projectId, setProjectId] = useState(repos[0]?.id ?? "");
  const [title, setTitle] = useState("");

  const repo = repos.find((r) => r.id === projectId);
  const suggested = scope === "repo" ? (repo?.name ?? "") : t("docs.workspaceDocTitle");

  const create = () => {
    const finalTitle = title.trim() || suggested;
    if (!finalTitle) return;
    void store().create(scope, finalTitle, scope === "repo" ? projectId : undefined);
    onClose();
  };

  return (
    <div className="cf-fade-in space-y-2.5 border-b border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-3">
      <div className="grid grid-cols-2 gap-1.5">
        {(["repo", "workspace"] as const).map((option) => {
          const Icon = SCOPE_ICON[option];
          const on = scope === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setScope(option)}
              aria-pressed={on}
              className={`flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition-colors ${
                on
                  ? "border-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)] bg-[var(--cf-accent-soft)]"
                  : "border-[var(--cf-border)] hover:border-[var(--cf-accent)]"
              }`}
            >
              <span
                className={`flex items-center gap-1.5 text-[12px] font-medium ${
                  on ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                }`}
              >
                <Icon size={12} />
                {t(option === "repo" ? "docs.scopeRepo" : "docs.scopeWorkspace")}
              </span>
              <span className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {t(option === "repo" ? "docs.scopeRepoHint" : "docs.scopeWorkspaceHint")}
              </span>
            </button>
          );
        })}
      </div>

      {scope === "repo" && (
        <Select
          size="field"
          value={projectId}
          ariaLabel={t("docs.whichRepo")}
          placeholder={t("docs.whichRepo")}
          onChange={setProjectId}
          options={repos.map((r) => ({ value: r.id, label: r.name }))}
        />
      )}

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
        placeholder={suggested || t("docs.titlePlaceholder")}
        aria-label={t("docs.titlePlaceholder")}
        className={FIELD}
      />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={create}
          disabled={scope === "repo" && !projectId}
          className="flex-1 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("docs.create")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The documents this workspace has, newest first. */
function DocumentList({ width }: { width: number }) {
  const t = useT();
  const pages = useDocsStore((s) => s.pages);
  const selectedId = useDocsStore((s) => s.selectedId);
  const [composing, setComposing] = useState(false);

  return (
    <div
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <IconChip icon={BookText} />
        <h2 className="text-[13px] font-semibold text-[var(--cf-text)]">{t("docs.documents")}</h2>
        <button
          type="button"
          onClick={() => setComposing((was) => !was)}
          title={t("docs.new")}
          aria-label={t("docs.new")}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
        >
          <Plus size={14} />
        </button>
      </div>

      {composing && <NewDocument onClose={() => setComposing(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {pages.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("docs.empty")}
          </p>
        ) : (
          <div className="space-y-1">
            {pages.map((page, at) => {
              const Icon = SCOPE_ICON[page.scope] ?? FileCode2;
              const active = page.id === selectedId;
              return (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => store().select(page.id)}
                  style={{ "--cf-rise-delay": `${Math.min(at, 8) * 45}ms` } as React.CSSProperties}
                  className={`cf-rise flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    active
                      ? "bg-[var(--cf-accent-soft)]"
                      : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <span className="mt-[2px] shrink-0 text-[var(--cf-text-muted)]">
                    {page.status === "generating" ? <ThinkingOrb size="sm" /> : <Icon size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[12.5px] font-medium ${
                        active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                      }`}
                    >
                      {page.title}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                      <span>{t(page.scope === "repo" ? "docs.scopeRepo" : "docs.scopeWorkspace")}</span>
                      {page.published_at && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-[var(--cf-success)]">{t("docs.publishedShort")}</span>
                        </>
                      )}
                      {page.status === "error" && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-[var(--cf-danger)]">{t("docs.statusError")}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the generation reads, and the button that starts it. */
function GenerationBar({ page }: { page: DocPage }) {
  const t = useT();
  const repos = useActiveProjects();
  const picked = useDocsStore((s) => s.projectIds);
  const instructions = useDocsStore((s) => s.instructions);
  const useContext = useDocsStore((s) => s.useContext);
  const runId = useDocsStore((s) => s.runId);
  const [open, setOpen] = useState(false);

  const running = Boolean(runId);
  const isRepo = page.scope === "repo";
  const subject = repos.find((r) => r.id === page.project_id);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
      {isRepo ? (
        <span
          title={t("docs.repoSubjectHint")}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)]"
        >
          <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 truncate">{subject?.name ?? t("docs.repoGone")}</span>
        </span>
      ) : (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            title={t("docs.whichReposHint")}
            className="flex max-w-[22rem] items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] transition-colors hover:border-[var(--cf-accent)]"
          >
            <Boxes size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className={`min-w-0 truncate ${picked.length ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
              {picked.length === 0
                ? t("docs.whichRepos")
                : repos
                    .filter((r) => picked.includes(r.id))
                    .map((r) => r.name)
                    .join(" · ")}
            </span>
            {picked.length > 1 && (
              <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
                {picked.length}
              </span>
            )}
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="cf-fade-in absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
                <p className="px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                  {t("docs.whichReposHint")}
                </p>
                {repos.map((repo) => (
                  <label
                    key={repo.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <Checkbox checked={picked.includes(repo.id)} onChange={() => store().toggleProject(repo.id)} />
                    <span className="min-w-0 truncate">{repo.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => store().setUseContext(!useContext)}
        aria-pressed={useContext}
        title={t("huReview.useContextHint")}
        className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] transition-colors ${
          useContext
            ? "border-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "border-[var(--cf-field-border)] bg-[var(--cf-field)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"
        }`}
      >
        <BookText size={12} />
        {t("huReview.useContext")}
      </button>

      <input
        value={instructions}
        onChange={(e) => store().setInstructions(e.target.value)}
        placeholder={t("docs.instructionsPlaceholder")}
        aria-label={t("docs.instructionsPlaceholder")}
        className={`${FIELD} min-w-[12rem] max-w-md flex-1`}
      />

      <button
        type="button"
        onClick={() => {
          if (running) {
            void store().stop();
            return;
          }
          // Regenerating replaces the body outright, and nothing keeps the previous version — so
          // a document that already says something has to ask first. An empty one does not.
          if (!page.content.trim()) {
            void store().generate();
            return;
          }
          void confirmAction(t("docs.regenerateConfirm")).then((ok) => {
            if (ok) void store().generate();
          });
        }}
        title={running ? t("docs.stopHint") : t("docs.generateHint")}
        className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-[filter] ${
          running
            ? "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            : "bg-[var(--cf-accent)] text-white hover:brightness-110"
        }`}
      >
        {running ? <Square size={11} /> : <Play size={11} />}
        {running ? t("docs.stop") : page.content.trim() ? t("docs.regenerate") : t("docs.generate")}
      </button>
    </div>
  );
}

/**
 * Where this document publishes: organisation, project, wiki, page path.
 *
 * Mirrors the Boards target panel deliberately — every list is read from the host rather than typed,
 * because a wiki that does not exist is a publish that fails at the last step. The three are
 * dependent, so changing one clears what was chosen below it.
 */
function PublishPanel({ page, width }: { page: DocPage; width: number }) {
  const t = useT();
  const openSettings = useUiStore((s) => s.openSettings);
  const publishing = useDocsStore((s) => s.publishing);

  const [orgs, setOrgs] = useState<string[]>([]);
  const [projects, setProjects] = useState<AdoProject[]>([]);
  const [wikis, setWikis] = useState<AdoWiki[]>([]);

  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => setOrgs(connections.map((c) => c.org)))
      .catch(() => setOrgs([]));
  }, []);

  useEffect(() => {
    if (!page.ado_org) {
      setProjects([]);
      return;
    }
    void adoListProjects(page.ado_org)
      .then(setProjects)
      .catch((e: unknown) => {
        setProjects([]);
        pushErrorToast(String(e));
      });
  }, [page.ado_org]);

  useEffect(() => {
    if (!page.ado_org || !page.ado_project) {
      setWikis([]);
      return;
    }
    void adoListWikis(page.ado_org, page.ado_project)
      .then(setWikis)
      .catch((e: unknown) => {
        setWikis([]);
        pushErrorToast(String(e));
      });
  }, [page.ado_org, page.ado_project]);

  const save = (patch: Partial<Record<"org" | "project" | "wikiId" | "wikiName" | "pagePath", string>>) => {
    void store().setTarget({
      id: page.id,
      org: patch.org ?? page.ado_org,
      project: patch.project ?? page.ado_project,
      wikiId: patch.wikiId ?? page.wiki_id,
      wikiName: patch.wikiName ?? page.wiki_name,
      pagePath: patch.pagePath ?? page.page_path,
    });
  };

  const ready = Boolean(page.ado_org && page.ado_project && page.wiki_id && page.page_path.startsWith("/"));

  return (
    <aside
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)] bg-[var(--cf-bg)]"
    >
      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <IconChip icon={UploadCloud} />
          <h3 className="text-[13px] font-semibold text-[var(--cf-text)]">{t("docs.target")}</h3>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("docs.targetHint")}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 px-3 py-3">
        {orgs.length === 0 ? (
          <button
            type="button"
            onClick={() => openSettings("azure", "azure")}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[11px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <Plug size={12} />
            {t("huReview.connectAzure")}
          </button>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.org")}</span>
              <Select
                size="field"
                value={page.ado_org}
                placeholder={t("huReview.orgPlaceholder")}
                ariaLabel={t("docs.org")}
                onChange={(org) => save({ org, project: "", wikiId: "", wikiName: "" })}
                options={orgs.map((o) => ({ value: o, label: o }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.project")}</span>
              <Select
                size="field"
                value={page.ado_project}
                placeholder={t("docs.project")}
                ariaLabel={t("docs.project")}
                onChange={(project) => save({ project, wikiId: "", wikiName: "" })}
                options={projects.map((p) => ({ value: p.name, label: p.name }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.wiki")}</span>
              <Select
                size="field"
                value={page.wiki_id}
                placeholder={t("docs.wiki")}
                ariaLabel={t("docs.wiki")}
                onChange={(wikiId) =>
                  save({ wikiId, wikiName: wikis.find((w) => w.id === wikiId)?.name ?? "" })
                }
                options={wikis.map((w) => ({ value: w.id, label: w.name }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.pagePath")}</span>
              <input
                value={page.page_path}
                onChange={(e) => save({ pagePath: e.target.value })}
                placeholder="/Servicios/Checkout API"
                aria-label={t("docs.pagePath")}
                className={`${FIELD} font-mono`}
              />
              <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {t("docs.pagePathHint")}
              </span>
            </label>
          </>
        )}

        {page.published_url && (
          <button
            type="button"
            onClick={() => void openExternalUrl(page.published_url).catch((e: unknown) => pushErrorToast(String(e)))}
            className="flex w-full items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-left text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <ExternalLink size={11} className="shrink-0" />
            <span className="min-w-0 truncate">
              {t("docs.publishedAt").replace("{at}", new Date(page.published_at).toLocaleString())}
            </span>
          </button>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-[var(--cf-border)] px-3 py-2.5">
        <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{t("docs.overwriteWarning")}</p>
        <button
          type="button"
          disabled={!ready || publishing || !page.content.trim()}
          onClick={() => {
            void confirmAction(
              t("docs.confirmPublish").replace("{path}", page.page_path).replace("{wiki}", page.wiki_name),
            ).then((ok) => {
              if (ok) void store().publish();
            });
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {publishing ? <ThinkingOrb size="sm" /> : <UploadCloud size={12} />}
          {publishing ? t("docs.publishing") : t("docs.publish")}
        </button>
      </div>
    </aside>
  );
}

/**
 * The workspace's technical documentation: written by reading the code, edited by hand, published
 * to a wiki.
 *
 * Three regions, the same shape as the rest of this section — the documents on the left, the one
 * open in the middle, and where it publishes on the right.
 */
export function WikiView() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pages = useDocsStore((s) => s.pages);
  const selectedId = useDocsStore((s) => s.selectedId);
  const runId = useDocsStore((s) => s.runId);

  useEffect(() => {
    void store().setWorkspace(workspaceId);
  }, [workspaceId]);

  const page = useMemo(() => pages.find((p) => p.id === selectedId) ?? null, [pages, selectedId]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--cf-surface)]">
      <DocumentList width={260} />

      {!page ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon={BookText} title={t("docs.selectTitle")} subtitle={t("docs.selectHint")} />
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
              <IconChip icon={SCOPE_ICON[page.scope] ?? FileCode2} />
              <input
                value={page.title}
                onChange={(e) => void store().rename(page.id, e.target.value)}
                aria-label={t("docs.titlePlaceholder")}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[14px] font-semibold leading-tight text-[var(--cf-text)] outline-none hover:border-[var(--cf-field-border)] focus:border-[var(--cf-accent)] focus:bg-[var(--cf-field)]"
              />
              {page.model && (
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">{page.model}</span>
              )}
              <button
                type="button"
                onClick={() => {
                  void confirmAction(t("docs.deleteConfirm")).then((ok) => {
                    if (ok) void store().remove(page.id);
                  });
                }}
                title={t("docs.delete")}
                aria-label={t("docs.delete")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={12} />
              </button>
            </div>

            <GenerationBar page={page} />

            {page.status === "error" && page.last_error && (
              <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-danger)_7%,transparent)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
                <CircleAlert size={11} className="mt-[2px] shrink-0" />
                <span className="min-w-0 break-words">{page.last_error}</span>
              </p>
            )}

            <div className="min-h-0 flex-1 overflow-hidden p-3">
              {runId && !page.content.trim() ? (
                <div className="flex h-full flex-col items-center justify-center gap-2">
                  <ThinkingOrb size="lg" />
                  <p className="text-[12px] text-[var(--cf-text-muted)]">
                    {t(page.scope === "repo" ? "docs.readingRepo" : "docs.readingRepos")}
                  </p>
                </div>
              ) : (
                <textarea
                  value={page.content}
                  onChange={(e) => void store().edit(page.id, e.target.value)}
                  placeholder={t("docs.contentPlaceholder")}
                  aria-label={t("docs.contentPlaceholder")}
                  spellCheck={false}
                  className="h-full w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] p-3 font-mono text-[12px] leading-relaxed text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
                />
              )}
            </div>
          </div>

          <PublishPanel page={page} width={280} />
        </>
      )}
    </div>
  );
}
