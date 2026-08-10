import { useEffect, useMemo, useState } from "react";
import {
  BookText,
  Boxes,
  CircleAlert,
  CloudDownload,
  ExternalLink,
  FileCode2,
  FolderGit2,
  History,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Plug,
  Plus,
  Save,
  Square,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { TaskModelTag } from "../ai/ModelTag";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { MarkdownEditor } from "../common/MarkdownEditor";
import { ResizeHandle } from "../common/ResizeHandle";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import { useDocsStore } from "../../state/docsStore";
import { useLayoutStore } from "../../state/layoutStore";
import { translate, useT } from "../../state/languageStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { loadAdoConnections } from "../../lib/adoConnections";
import { riseDelay } from "../../lib/rise";
import {
  adoListProjects,
  adoListWikiPages,
  adoListWikis,
  adoWikiPageDetail,
  openExternalUrl,
} from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import type {
  AdoProject,
  AdoWiki,
  AdoWikiPage,
  AdoWikiPageDetail,
  DocPage,
  DocScope,
} from "../../types/domain";

const FIELD =
  "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]";

const store = useDocsStore.getState;

/** The two rails' travel. The document list only has to hold a title and a scope glyph, so it is
 * allowed to get narrow; the publish panel holds Azure paths, which are unreadable truncated, and
 * so is given a higher floor. */
const LIST_MIN = 200;
const LIST_MAX = 420;
const PUBLISH_MIN = 240;
const PUBLISH_MAX = 460;

/** The two kinds of document, as the sidebar and the composer both draw them. */
const SCOPE_ICON: Record<DocScope, typeof BookText> = { repo: FileCode2, workspace: Network };

/** The open document's body as the user sees it: the draft while there is one, the row otherwise. */
function bodyOf(page: DocPage, draft: string | null): string {
  return draft ?? page.content;
}

/**
 * Whether it is all right to leave the open document behind — closing it, opening another, deleting
 * it. Nothing unsaved, or the user was asked and said so.
 *
 * Read from the store rather than taken as arguments because every caller is a click handler on a
 * different component, and the one thing they all need to know is a fact about the whole screen.
 */
async function mayLeaveOpenDocument(): Promise<boolean> {
  const { draft, pages, selectedId } = useDocsStore.getState();
  const page = pages.find((p) => p.id === selectedId);
  if (draft === null || !page || draft === page.content) return true;
  return confirmAction(translate("docs.discardConfirm"));
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/**
 * A wiki page's path out of whatever the user had on the clipboard.
 *
 * People copy the address bar, not the path, and Azure writes that address two different ways:
 *
 * - `…/_wiki/wikis/My.wiki?pagePath=%2FGuías` — the query form, which carries the path outright.
 * - `…/_wiki/wikis/My.wiki/12345/Guías` — the friendly form, and the one that used to come out
 *   wrong. That `12345` is the page's **id**, not a folder: the path is `/Guías`, and sending
 *   `/12345/Guías` gets a 404 naming a page nobody was looking for.
 *
 * Anything that is not a wiki URL is passed through as typed — a path is what this field is for,
 * and silently reshaping one would be worse than refusing it.
 *
 * One thing is deliberately *not* undone: Azure spells a space in the friendly form as `-`, and a
 * page whose name really does contain a hyphen spells that `-` too. Turning them all back into
 * spaces would break the second case as surely as leaving them breaks the first, so the segments
 * come back as they were written and the field stays editable. Pages without spaces in their names
 * — the ordinary case — land exactly right.
 */
function wikiPathFrom(input: string): string {
  const raw = input.trim();
  if (!raw) return "";

  const query = raw.indexOf("pagePath=");
  if (query !== -1) return decode(raw.slice(query + "pagePath=".length).split("&")[0]);

  // `/_wiki/wikis/` is the marker, on dev.azure.com and on the older `{org}.visualstudio.com` alike.
  const wikis = raw.split(/\/_wiki\/wikis\//i)[1];
  if (wikis === undefined) return raw;

  const segments = wikis.split("?")[0].split("#")[0].split("/").filter(Boolean);
  // [0] is the wiki itself; a page id follows it when the URL names one page rather than the wiki.
  const rest = /^\d+$/.test(segments[1] ?? "") ? segments.slice(2) : segments.slice(1);
  return rest.length > 0 ? `/${rest.map(decode).join("/")}` : "";
}

/**
 * The key two wiki paths are *the same page* under.
 *
 * The paragraph above `wikiPathFrom` is why this exists: the address bar spells a space `-`, the
 * REST API wants the space, and neither spelling can be turned into the other without guessing. So
 * nothing is rewritten — this key only decides whether a page the wiki *itself just listed* is the
 * one that was asked for, and the real path is then taken from that listing rather than invented
 * here.
 *
 * Accents are composed because a path copied on macOS arrives decomposed (`e` + U+0301) where the
 * wiki holds it composed: the same word to everyone except a byte comparison, and a second way for
 * this field to 404 on a path that looks right on screen.
 */
function wikiPathKey(path: string): string {
  return path
    .normalize("NFC")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\/+$/, "")
    .toLocaleLowerCase();
}

/**
 * The three dependent lists a wiki target is chosen from, read from the host rather than typed.
 *
 * Shared by the publish panel and the import dialog because they are the same question asked in
 * opposite directions — where does this go / where did this come from — and a wiki that appears in
 * one and not the other would only ever be a bug.
 */
function useWikiTargets(org: string, project: string) {
  const [orgs, setOrgs] = useState<string[]>([]);
  const [projects, setProjects] = useState<AdoProject[]>([]);
  const [wikis, setWikis] = useState<AdoWiki[]>([]);

  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => setOrgs(connections.map((c) => c.org)))
      .catch(() => setOrgs([]));
  }, []);

  useEffect(() => {
    if (!org) {
      setProjects([]);
      return;
    }
    void adoListProjects(org)
      .then(setProjects)
      .catch((e: unknown) => {
        setProjects([]);
        pushErrorToast(String(e));
      });
  }, [org]);

  useEffect(() => {
    if (!org || !project) {
      setWikis([]);
      return;
    }
    void adoListWikis(org, project)
      .then(setWikis)
      .catch((e: unknown) => {
        setWikis([]);
        pushErrorToast(String(e));
      });
  }, [org, project]);

  return { orgs, projects, wikis };
}

/**
 * What the wiki says about a page: who wrote it, when it last changed, how many times.
 *
 * The point of showing it is the publish that comes later. "Last changed by Marta on Tuesday" is
 * the fact that decides whether overwriting this page is fine or rude, and it is worth more on
 * screen while the document is being edited than in the confirmation dialog at the end.
 *
 * Every field is allowed to be missing — a token that can read pages cannot always read the
 * repository their history lives in — and a missing field says so rather than showing a blank.
 */
function WikiPageFacts({ detail, loading }: { detail: AdoWikiPageDetail | null; loading: boolean }) {
  const t = useT();
  if (loading) return <Skeleton className="h-16 w-full" />;
  if (!detail) return null;

  const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");
  const rows = [
    detail.modified_by || detail.modified_at
      ? t("docs.pageModified", { who: detail.modified_by || "—", when: when(detail.modified_at) || "—" })
      : null,
    detail.created_by || detail.created_at
      ? t("docs.pageCreated", { who: detail.created_by || "—", when: when(detail.created_at) || "—" })
      : null,
    detail.revisions > 0
      ? detail.history_truncated
        ? t("docs.pageRevisionsMany", { n: detail.revisions })
        : t("docs.pageRevisions", { n: detail.revisions })
      : t("docs.pageHistoryUnknown"),
  ].filter(Boolean);

  return (
    <div className="space-y-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--cf-text)]">
        <History size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        {t("docs.pageExists")}
      </p>
      {rows.map((row) => (
        <p key={row} className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
          {row}
        </p>
      ))}
      <button
        type="button"
        onClick={() => void openExternalUrl(detail.url).catch((e: unknown) => pushErrorToast(String(e)))}
        className="flex items-center gap-1 text-[10.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      >
        <ExternalLink size={10} className="shrink-0" />
        {t("docs.openInWiki")}
      </button>
    </div>
  );
}

/**
 * Reads one wiki page by path, a moment after the user stops typing it.
 *
 * Debounced because the path is a field somebody types into character by character, and each
 * keystroke would otherwise be three requests to Azure. `null` while nothing resolves — including
 * while a request is in flight for a path that has since changed, which is what stops the panel
 * describing the page you were halfway through typing.
 */
function useWikiPageDetail(org: string, project: string, wiki: string, path: string) {
  const [detail, setDetail] = useState<AdoWikiPageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!org || !project || !wiki || !path.startsWith("/") || path.length < 2) {
      setDetail(null);
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void adoWikiPageDetail(org, project, wiki, path)
        .then((found) => {
          if (cancelled) return;
          setDetail(found);
          setError("");
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setDetail(null);
          setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [org, project, wiki, path]);

  return { detail, loading, error };
}

/**
 * The pages of the chosen wiki that are plausibly the one asked for, once the exact path has
 * already failed.
 *
 * The commonest way to fill that field is to paste the address bar, and the address bar is not
 * quite a path: Azure writes a space as `-` there, so the page *Documentación técnica* is asked for
 * as `/Documentación-técnica` and comes back 404 — naming the path, which reads as "this page does
 * not exist" rather than "that dash is a space". Rather than guess which dashes were spaces, the
 * wiki is asked for its own page list and the typed path matched against it: everything offered is
 * a path the host spelled itself, so clicking one cannot miss.
 *
 * Only fetched after a failure and once per wiki — a wiki with hundreds of pages should not be
 * downloaded on the way to a path that was right the first time.
 */
function useWikiPathCandidates(
  org: string,
  project: string,
  wiki: string,
  path: string,
  enabled: boolean,
): string[] {
  const [listing, setListing] = useState<{ key: string; pages: AdoWikiPage[] }>({ key: "", pages: [] });
  const wikiKey = `${org}|${project}|${wiki}`;

  useEffect(() => {
    if (!enabled || !org || !project || !wiki || listing.key === wikiKey) return;
    let cancelled = false;
    // Best effort by contract: the 404 is already on screen and is the real answer. A listing that
    // cannot be read just means no suggestions, never a second error on top of the first.
    void adoListWikiPages(org, project, wiki)
      .then((pages) => {
        if (!cancelled) setListing({ key: wikiKey, pages });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, org, project, wiki, wikiKey, listing.key]);

  return useMemo(() => {
    if (!enabled || listing.key !== wikiKey) return [];
    const want = wikiPathKey(path);
    if (want.length < 2) return [];

    const matches = (candidate: string) => wikiPathKey(candidate) === want;
    const exact = listing.pages.filter((p) => matches(p.path) && p.path !== path);
    if (exact.length > 0) return exact.map((p) => p.path);

    // Nothing matched whole, so fall back to the last segment: somebody who typed the page's name
    // rather than pasting its URL has the leaf right and the folders missing, which is the other
    // half of the paths this field rejects.
    const leaf = want.slice(want.lastIndexOf("/") + 1);
    if (!leaf) return [];
    return listing.pages
      .filter((p) => p.path !== path && wikiPathKey(p.path).endsWith(`/${leaf}`))
      .map((p) => p.path)
      .slice(0, 5);
  }, [enabled, listing, wikiKey, path]);
}

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
 *
 * A dialog rather than a panel that unfolds inside the sidebar: the choice needs both descriptions
 * side by side to be a choice at all, and at the width of the rail they stack into a column of
 * eight lines that pushes the document list off the screen.
 */
function NewDocumentModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const repos = useActiveProjects();
  const [scope, setScope] = useState<DocScope>("repo");
  const [projectId, setProjectId] = useState(repos[0]?.id ?? "");
  const [title, setTitle] = useState("");

  const repo = repos.find((r) => r.id === projectId);
  const suggested = scope === "repo" ? (repo?.name ?? "") : t("docs.workspaceDocTitle");

  // Creating opens what it created, which is leaving the open document — so the same question the
  // list asks before switching gets asked here too, or an unsaved draft would vanish behind a
  // brand-new empty document.
  const create = () => {
    const finalTitle = title.trim() || suggested;
    if (!finalTitle) return;
    void mayLeaveOpenDocument().then((ok) => {
      if (!ok) return;
      void store().create(scope, finalTitle, scope === "repo" ? projectId : undefined);
      onClose();
    });
  };

  return (
    <ApiModal
      icon={BookText}
      title={t("docs.new")}
      subtitle={t("docs.newSubtitle")}
      width="max-w-lg"
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <span className="ml-auto flex items-center gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={create} disabled={scope === "repo" && !projectId}>
            {t("docs.create")}
          </PrimaryButton>
        </span>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
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
                  className={`flex items-center gap-1.5 text-[12.5px] font-medium ${
                    on ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                  }`}
                >
                  <Icon size={13} />
                  {t(option === "repo" ? "docs.scopeRepo" : "docs.scopeWorkspace")}
                </span>
                <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
                  {t(option === "repo" ? "docs.scopeRepoHint" : "docs.scopeWorkspaceHint")}
                </span>
              </button>
            );
          })}
        </div>

        {scope === "repo" && (
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.whichRepo")}</span>
            <Select
              size="field"
              value={projectId}
              ariaLabel={t("docs.whichRepo")}
              placeholder={t("docs.whichRepo")}
              onChange={setProjectId}
              options={repos.map((r) => ({ value: r.id, label: r.name }))}
            />
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.titlePlaceholder")}</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder={suggested || t("docs.titlePlaceholder")}
            aria-label={t("docs.titlePlaceholder")}
            className={FIELD}
          />
        </label>

        {scope === "repo" && (
          <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("docs.repoSubjectHint")}</p>
        )}
      </div>
    </ApiModal>
  );
}

/**
 * Bringing a page that already exists in the wiki in, by its exact path.
 *
 * The other direction of this screen, and the one a team with a wiki already written starts from:
 * paste the path, see who wrote it and when it last moved, and it opens here as a document — to
 * edit by hand, or to hand to the model and have rewritten. It keeps pointing at where it came
 * from, so publishing later goes back over the same page rather than making a second copy of it.
 *
 * The repository is optional and only decides what a later *regeneration* reads: a page about one
 * checkout can be rewritten from that checkout, and one about none of them stays a workspace
 * document. Getting it wrong costs nothing today — it is a question the Generate button asks again.
 */
function ImportWikiModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const repos = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [wikiId, setWikiId] = useState("");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(activeProjectId ?? "");
  const [importing, setImporting] = useState(false);
  const [failure, setFailure] = useState("");

  const { orgs, projects, wikis } = useWikiTargets(org, project);
  const wikiName = wikis.find((w) => w.id === wikiId)?.name ?? "";
  const { detail, loading, error } = useWikiPageDetail(org, project, wikiId, path);
  const candidates = useWikiPathCandidates(org, project, wikiId, path, Boolean(error));

  // One organisation is the common case, and making somebody choose from a list of one is a step
  // that only exists to be got through.
  useEffect(() => {
    if (!org && orgs.length === 1) setOrg(orgs[0]);
  }, [org, orgs]);

  const ready = Boolean(detail && detail.content.trim() && !importing);

  const run = async () => {
    if (!detail) return;
    // The imported page opens straight away, so whatever is open now is being left behind.
    if (!(await mayLeaveOpenDocument())) return;
    setImporting(true);
    setFailure("");
    try {
      await store().importFromWiki({
        scope: projectId ? "repo" : "workspace",
        projectId: projectId || undefined,
        org,
        project,
        wikiId,
        wikiName,
        path: detail.path,
        title: title.trim() || undefined,
      });
      onClose();
    } catch (e: unknown) {
      setFailure(String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ApiModal
      icon={CloudDownload}
      title={t("docs.import")}
      subtitle={t("docs.importSubtitle")}
      width="max-w-lg"
      busy={importing}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <span className="ml-auto flex items-center gap-2">
          <GhostButton onClick={onClose} disabled={importing}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void run()} disabled={!ready}>
            {importing ? t("docs.importing") : t("docs.importAction")}
          </PrimaryButton>
        </span>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {orgs.length === 0 ? (
          <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("huReview.connectAzure")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.org")}</span>
                <Select
                  size="field"
                  value={org}
                  placeholder={t("huReview.orgPlaceholder")}
                  ariaLabel={t("docs.org")}
                  onChange={(next) => {
                    setOrg(next);
                    setProject("");
                    setWikiId("");
                  }}
                  options={orgs.map((o) => ({ value: o, label: o }))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.project")}</span>
                <Select
                  size="field"
                  value={project}
                  placeholder={t("docs.project")}
                  ariaLabel={t("docs.project")}
                  onChange={(next) => {
                    setProject(next);
                    setWikiId("");
                  }}
                  options={projects.map((p) => ({ value: p.name, label: p.name }))}
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.wiki")}</span>
              <Select
                size="field"
                value={wikiId}
                placeholder={t("docs.wiki")}
                ariaLabel={t("docs.wiki")}
                onChange={setWikiId}
                options={wikis.map((w) => ({ value: w.id, label: w.name }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.pagePath")}</span>
              <input
                autoFocus
                value={path}
                onChange={(e) => setPath(wikiPathFrom(e.target.value))}
                placeholder="/Servicios/Checkout API"
                aria-label={t("docs.pagePath")}
                className={`${FIELD} font-mono`}
              />
              <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {t("docs.importPathHint")}
              </span>
            </label>

            {error ? (
              <div className="space-y-1.5">
                <p className="flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
                  <CircleAlert size={11} className="mt-[2px] shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </p>
                {/* The path the wiki itself spells, one click away — see `useWikiPathCandidates`
                    for why a 404 here is usually a dash that was meant to be a space. */}
                {candidates.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                      {t("docs.importDidYouMean")}
                    </p>
                    {candidates.map((candidate) => (
                      <button
                        key={candidate}
                        onClick={() => setPath(candidate)}
                        title={candidate}
                        className="block w-full truncate rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2 py-1 text-left font-mono text-[11px] text-[var(--cf-accent)] transition-colors hover:border-[var(--cf-accent)]"
                      >
                        {candidate}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <WikiPageFacts detail={detail} loading={loading} />
            )}

            {detail && (
              <>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">
                    {t("docs.titlePlaceholder")}
                  </span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={detail.title}
                    aria-label={t("docs.titlePlaceholder")}
                    className={FIELD}
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("docs.importAbout")}</span>
                  <Select
                    size="field"
                    value={projectId}
                    placeholder={t("docs.importAboutNone")}
                    ariaLabel={t("docs.importAbout")}
                    onChange={setProjectId}
                    options={[
                      { value: "", label: t("docs.importAboutNone") },
                      ...repos.map((r) => ({ value: r.id, label: r.name })),
                    ]}
                  />
                  <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                    {t("docs.importAboutHint")}
                  </span>
                </label>
              </>
            )}

            {failure && (
              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
                <CircleAlert size={11} className="mt-[2px] shrink-0" />
                <span className="min-w-0 break-words">{failure}</span>
              </p>
            )}
          </>
        )}
      </div>
    </ApiModal>
  );
}

/** Where a row's menu was asked for. Only the id is kept — a generation landing replaces the row
 * object, and a menu built from the copy captured on right-click would act on a stale one. */
type RowMenu = { x: number; y: number; id: string };

/** The documents this workspace has, newest first. */
function DocumentList({ width }: { width: number }) {
  const t = useT();
  const pages = useDocsStore((s) => s.pages);
  const selectedId = useDocsStore((s) => s.selectedId);
  const [composing, setComposing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const menuPage = menu ? (pages.find((p) => p.id === menu.id) ?? null) : null;

  const menuItems = (page: DocPage): MenuItem[] => [
    { label: t("docs.rename"), icon: Pencil, onClick: () => setRenamingId(page.id) },
    {
      label: t("docs.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => {
        void (async () => {
          // The open document's unsaved edits are about to go with it, and "delete" is not the
          // answer to "you have unsaved changes" — so that question comes first.
          if (page.id === selectedId && !(await mayLeaveOpenDocument())) return;
          if (await confirmAction(t("docs.deleteConfirm"))) void store().remove(page.id);
        })();
      },
    },
  ];

  const open = (id: string) => {
    if (id === selectedId) return;
    void mayLeaveOpenDocument().then((ok) => {
      if (ok) store().select(id);
    });
  };

  return (
    <div
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <IconChip icon={BookText} />
        <h2 className="text-[13px] font-semibold text-[var(--cf-text)]">{t("docs.documents")}</h2>
        {/* Both ways in, side by side: a document is either written here from the code, or it is
            already in the wiki and comes in whole. */}
        <button
          type="button"
          onClick={() => setImporting(true)}
          title={t("docs.importSubtitle")}
          aria-label={t("docs.import")}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
        >
          <CloudDownload size={14} />
        </button>
        <button
          type="button"
          onClick={() => setComposing(true)}
          title={t("docs.new")}
          aria-label={t("docs.new")}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {pages.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("docs.empty")}
          </p>
        ) : (
          <div className="space-y-1">
            {pages.map((page, at) =>
              renamingId === page.id ? (
                <RenameRow
                  key={page.id}
                  value={page.title}
                  onCancel={() => setRenamingId(null)}
                  onCommit={(name) => {
                    const next = name.trim();
                    if (next && next !== page.title) void store().rename(page.id, next);
                    setRenamingId(null);
                  }}
                />
              ) : (
                <DocumentRow
                  key={page.id}
                  page={page}
                  at={at}
                  active={page.id === selectedId}
                  onOpen={() => open(page.id)}
                  onMenu={(x, y) => setMenu({ x, y, id: page.id })}
                />
              ),
            )}
          </div>
        )}
      </div>

      {menu && menuPage && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menuPage)} onClose={() => setMenu(null)} />
      )}
      {composing && <NewDocumentModal onClose={() => setComposing(false)} />}
      {importing && <ImportWikiModal onClose={() => setImporting(false)} />}
    </div>
  );
}

/** One document in the rail. Right-click — or the «…» for a pointer that has no second button —
 * is where rename and delete live: they are actions on a document, not on the one that is open. */
function DocumentRow({
  page,
  at,
  active,
  onOpen,
  onMenu,
}: {
  page: DocPage;
  at: number;
  active: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const Icon = SCOPE_ICON[page.scope] ?? FileCode2;

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      style={riseDelay(at)}
      className={`cf-rise group relative flex w-full items-start rounded-md transition-colors ${
        active ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pl-2 text-left"
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
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={t("api.moreActions")}
        title={t("api.moreActions")}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.right - 4, rect.bottom + 2);
        }}
        className="flex w-6 shrink-0 items-center justify-center self-stretch rounded-r-md text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

function RenameRow({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Pencil size={12} className="text-[var(--cf-text-muted)]" />
      </span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(draft);
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1 py-0.5 text-[12px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}

/** What the generation reads, and the button that starts it. */
function GenerationBar({ page, body }: { page: DocPage; body: string }) {
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

      {/* Pushed to the right so it reads as part of the Generate control rather than as another
          field: this button rewrites the whole document, and which model does it is the one thing
          the toolbar could not say. `wiki` is the task `generate_doc_page` routes to in Rust. */}
      <span className="ml-auto flex min-w-0 items-center">
        <TaskModelTag task="wiki" title={t("docs.modelTagHint")} />
      </span>

      <button
        type="button"
        onClick={() => {
          if (running) {
            void store().stop();
            return;
          }
          // Regenerating replaces the body outright, and nothing keeps the previous version — so
          // a document that already says something has to ask first. An empty one does not.
          if (!body.trim()) {
            void store().generate();
            return;
          }
          void confirmAction(t("docs.regenerateConfirm")).then((ok) => {
            if (ok) void store().generate();
          });
        }}
        title={running ? t("docs.stopHint") : t("docs.generateHint")}
        // Icon only: the toolbar has four controls competing for one row, and this is the one whose
        // label can go without losing meaning — the glyph already carries the state the words did
        // (play against stop), and the name of the action stays in the tooltip and the aria-label.
        aria-label={running ? t("docs.stop") : body.trim() ? t("docs.regenerate") : t("docs.generate")}
        className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md transition-[filter] ${
          running
            ? "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            : "bg-[var(--cf-accent)] text-white hover:brightness-110"
        }`}
      >
        {running ? <Square size={12} /> : <Play size={12} />}
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
function PublishPanel({ page, body, width }: { page: DocPage; body: string; width: number }) {
  const t = useT();
  const openSettings = useUiStore((s) => s.openSettings);
  const publishing = useDocsStore((s) => s.publishing);

  const { orgs, projects, wikis } = useWikiTargets(page.ado_org, page.ado_project);
  // What is at the other end right now. Read while the document is being edited rather than only
  // in the confirmation dialog: knowing somebody else changed this page yesterday is worth more
  // before you write over it than half a second before.
  const { detail, loading } = useWikiPageDetail(page.ado_org, page.ado_project, page.wiki_id, page.page_path);

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
      // `--cf-surface`, the same tone as the document rail on the other side of the editor: the two
      // things flanking it are the same kind of thing, and the window background between them read
      // as a slab of a different colour rather than as a panel.
      className="flex min-h-0 shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
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
                onChange={(e) => save({ pagePath: wikiPathFrom(e.target.value) })}
                placeholder="/Servicios/Checkout API"
                aria-label={t("docs.pagePath")}
                className={`${FIELD} font-mono`}
              />
              <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {t("docs.pagePathHint")}
              </span>
            </label>

            <WikiPageFacts detail={detail} loading={loading} />
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
          // Enabled on what is on screen, not on what is stored: publishing saves the draft first,
          // so a document typed and published without pressing Save still goes up whole.
          disabled={!ready || publishing || !body.trim()}
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
 * open in the middle, and where it publishes on the right. The right one only exists while a
 * document is open: "publish to" with nothing to publish is a form about nothing.
 */
export function WikiView() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pages = useDocsStore((s) => s.pages);
  const selectedId = useDocsStore((s) => s.selectedId);
  const runId = useDocsStore((s) => s.runId);
  const draft = useDocsStore((s) => s.draft);
  const saving = useDocsStore((s) => s.saving);
  const listWidth = useLayoutStore((s) => s.sizes.wikiListWidth);
  const publishWidth = useLayoutStore((s) => s.sizes.wikiPublishWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  useEffect(() => {
    void store().setWorkspace(workspaceId);
  }, [workspaceId]);

  const page = useMemo(() => pages.find((p) => p.id === selectedId) ?? null, [pages, selectedId]);
  const body = page ? bodyOf(page, draft) : "";
  const dirty = Boolean(page && draft !== null && draft !== page.content);

  // Mod+S, because this is now a field you save rather than one that saves itself. Bound while
  // this view is mounted — it unmounts when the section switches tab, so nothing else on screen
  // has to be asked whether the chord was meant for it.
  useEffect(() => {
    if (!dirty) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void store().save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--cf-surface)]">
      <DocumentList width={listWidth} />
      {/* Outside the branch below on purpose: the list is there whether or not a page is open, so
          its seam has to be draggable in the empty state too — that is the state a workspace with
          one long-titled document spends most of its time in. */}
      <ResizeHandle
        axis="x"
        value={listWidth}
        min={LIST_MIN}
        max={LIST_MAX}
        onChange={(value) => setSize("wikiListWidth", value)}
        onCommit={(value) => commitSize("wikiListWidth", value)}
      />

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
                <span className="hidden shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)] lg:inline">
                  {page.model}
                </span>
              )}
              {dirty && (
                <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-accent)]">
                  {t("docs.unsaved")}
                </span>
              )}
              <button
                type="button"
                onClick={() => void store().save()}
                disabled={!dirty || saving}
                title={t("docs.saveHint")}
                className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
                  dirty
                    ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
                    : "border border-[var(--cf-border)] text-[var(--cf-text-muted)] opacity-60"
                }`}
              >
                {saving ? <ThinkingOrb size="sm" /> : <Save size={12} />}
                {t("common.save")}
              </button>
              <button
                type="button"
                onClick={() => {
                  void mayLeaveOpenDocument().then((ok) => {
                    if (ok) store().select(null);
                  });
                }}
                title={t("docs.closeHint")}
                aria-label={t("docs.close")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
              >
                <X size={14} />
              </button>
            </div>

            <GenerationBar page={page} body={body} />

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
                <MarkdownEditor
                  value={body}
                  onChange={(next) => store().editDraft(next)}
                  placeholder={t("docs.contentPlaceholder")}
                  ariaLabel={t("docs.contentPlaceholder")}
                  // A run about to replace this text is not a text to type into — and the editor
                  // reads its own lock as "show me what it says", which is what you want to watch.
                  readOnly={Boolean(runId)}
                  historyKey={page.id}
                />
              )}
            </div>
          </div>

          <ResizeHandle
            axis="x"
            value={publishWidth}
            min={PUBLISH_MIN}
            max={PUBLISH_MAX}
            invert
            onChange={(value) => setSize("wikiPublishWidth", value)}
            onCommit={(value) => commitSize("wikiPublishWidth", value)}
          />
          <PublishPanel page={page} body={body} width={publishWidth} />
        </>
      )}
    </div>
  );
}
