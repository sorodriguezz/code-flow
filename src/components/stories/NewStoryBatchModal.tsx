import { useEffect, useMemo, useState } from "react";
import { BookText, ClipboardList, FileText, FolderGit2, ListChecks, Search, Sparkles } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { loadAdoConnections } from "../../lib/adoConnections";
import {
  adoListProjects,
  adoListWikiPages,
  adoListWikis,
  adoWikiPagesContent,
  listRepoFiles,
  readFileText,
} from "../../lib/tauri/commands";
import { useStoriesStore } from "../../state/storiesStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { AdoWiki, AdoWikiPage, StorySourceKind } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";

const SOURCES: { id: StorySourceKind; icon: typeof BookText; labelKey: TranslationKey }[] = [
  { id: "wiki", icon: BookText, labelKey: "stories.sourceWiki" },
  { id: "files", icon: FolderGit2, labelKey: "stories.sourceFiles" },
  { id: "text", icon: FileText, labelKey: "stories.sourceText" },
];

/** Markdown is what a specification is written in; everything else in a repo is code. */
const DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];

/** The heading each file is concatenated under, matching what the wiki reader does — the model is
 * told where each block came from either way, so a story can cite its source. */
function fileSection(path: string, content: string): string {
  return `\n\n# === ${path} ===\n\n${content}\n`;
}

/**
 * Choosing what to derive a backlog from, and starting the generation.
 *
 * Three sources rather than one because "the wiki" is not always in Azure DevOps: a team that keeps
 * its specifications as Markdown in the repo, or that is pasting a page out of Confluence, is doing
 * the same job and should not be locked out of the screen. Only the *source* differs — everything
 * downstream (the stories, the review, the publish to Azure Boards) is identical.
 *
 * The generation starts with the batch: a batch that exists and has proposed nothing is a row that
 * looks like work and isn't.
 */
export function NewStoryBatchModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const [kind, setKind] = useState<StorySourceKind>("wiki");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- wiki source ---
  const [orgs, setOrgs] = useState<string[]>([]);
  const [org, setOrg] = useState("");
  const [adoProjects, setAdoProjects] = useState<string[]>([]);
  const [adoProject, setAdoProject] = useState("");
  const [wikis, setWikis] = useState<AdoWiki[]>([]);
  const [wikiId, setWikiId] = useState("");
  const [pages, setPages] = useState<AdoWikiPage[]>([]);
  const [pickedPages, setPickedPages] = useState<string[]>([]);
  const [loadingPages, setLoadingPages] = useState(false);

  // --- files source ---
  const [projectId, setProjectId] = useState(
    () => (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "",
  );
  const [files, setFiles] = useState<string[]>([]);
  const [pickedFiles, setPickedFiles] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState("");

  // --- text source ---
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => {
        const names = connections.map((c) => c.org);
        setOrgs(names);
        setOrg((current) => current || names[0] || "");
      })
      .catch(() => setOrgs([]));
  }, []);

  useEffect(() => {
    if (!org) return;
    setAdoProjects([]);
    setAdoProject("");
    void adoListProjects(org)
      .then((list) => setAdoProjects(list.map((p) => p.name)))
      .catch((e: unknown) => setError(String(e)));
  }, [org]);

  useEffect(() => {
    setWikis([]);
    setWikiId("");
    setPages([]);
    setPickedPages([]);
    if (!org || !adoProject) return;
    void adoListWikis(org, adoProject)
      .then((list) => {
        setWikis(list);
        setWikiId(list[0]?.id ?? "");
      })
      .catch((e: unknown) => setError(String(e)));
  }, [org, adoProject]);

  useEffect(() => {
    setPages([]);
    setPickedPages([]);
    if (!org || !adoProject || !wikiId) return;
    setLoadingPages(true);
    void adoListWikiPages(org, adoProject, wikiId)
      .then(setPages)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoadingPages(false));
  }, [org, adoProject, wikiId]);

  useEffect(() => {
    setFiles([]);
    setPickedFiles([]);
    const repo = projects.find((p) => p.id === projectId);
    if (!repo) return;
    void listRepoFiles(repo.local_path)
      .then((all) => setFiles(all.filter((path) => DOC_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext)))))
      .catch((e: unknown) => setError(String(e)));
  }, [projectId, projects]);

  const visibleFiles = useMemo(() => {
    const needle = fileQuery.trim().toLowerCase();
    const matching = needle ? files.filter((path) => path.toLowerCase().includes(needle)) : files;
    // Bounded: a monorepo can hold thousands of Markdown files, and a list that long is not a
    // picker. Narrowing it is what the search box is for, and the count below says so.
    return matching.slice(0, 300);
  }, [files, fileQuery]);

  const ready =
    workspaceId !== null &&
    !starting &&
    (kind === "wiki"
      ? pickedPages.length > 0
      : kind === "files"
        ? pickedFiles.length > 0
        : pasted.trim() !== "");

  /** Gathers the documentation for the chosen source. Kept here rather than in the store because
   * it is the *only* thing the three sources do differently. */
  const gather = async (): Promise<{ text: string; ref: string; projectId: string | null; name: string }> => {
    if (kind === "wiki") {
      const text = await adoWikiPagesContent(org, adoProject, wikiId, pickedPages);
      const wikiName = wikis.find((w) => w.id === wikiId)?.name ?? wikiId;
      return {
        text,
        ref: `${adoProject} · ${wikiName} · ${pickedPages.join(", ")}`,
        projectId: null,
        name: pages.find((p) => p.path === pickedPages[0])?.title ?? wikiName,
      };
    }
    if (kind === "files") {
      const repo = projects.find((p) => p.id === projectId);
      if (!repo) throw new Error(t("stories.noRepoPicked"));
      const contents = await Promise.all(
        pickedFiles.map(async (path) => fileSection(path, await readFileText(repo.local_path, path))),
      );
      return {
        text: contents.join("").trimStart(),
        ref: `${repo.name} · ${pickedFiles.join(", ")}`,
        projectId,
        name: pickedFiles[0].split("/").pop() ?? repo.name,
      };
    }
    return { text: pasted, ref: "", projectId: null, name: t("stories.sourceText") };
  };

  const start = async () => {
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      const source = await gather();
      const batch = await useStoriesStore.getState().create({
        projectId: source.projectId,
        title: title.trim() || source.name,
        sourceKind: kind,
        sourceRef: source.ref,
        sourceText: source.text,
        instructions,
      });
      // Fire-and-forget: the generation runs for a while and the dialog has nothing left to add.
      void useStoriesStore.getState().generate(batch.id);
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };

  const togglePage = (path: string) =>
    setPickedPages((current) =>
      current.includes(path) ? current.filter((p) => p !== path) : [...current, path],
    );

  const toggleFile = (path: string) =>
    setPickedFiles((current) =>
      current.includes(path) ? current.filter((p) => p !== path) : [...current, path],
    );

  return (
    <ApiModal
      icon={ClipboardList}
      title={t("stories.newBatchTitle")}
      subtitle={t("stories.newBatchSubtitle")}
      width="max-w-2xl"
      height="h-[80vh]"
      busy={starting}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <span className="ml-auto flex items-center gap-2">
          <GhostButton onClick={onClose} disabled={starting}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void start()} disabled={!ready}>
            {starting ? t("stories.preparing") : t("stories.createAndGenerate")}
          </PrimaryButton>
        </span>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="flex gap-1 rounded-md border border-[var(--cf-border)] p-0.5">
          {SOURCES.map((source) => {
            const Icon = source.icon;
            const active = kind === source.id;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => setKind(source.id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[12px] font-medium ${
                  active
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Icon size={13} />
                {t(source.labelKey)}
              </button>
            );
          })}
        </div>

        {kind === "wiki" &&
          (orgs.length === 0 ? (
            <Note tone="warning">{t("stories.noAdoConnection")}</Note>
          ) : (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <Field label={t("stories.organization")}>
                  <Select
                    size="field"
                    value={org}
                    ariaLabel={t("stories.organization")}
                    onChange={setOrg}
                    options={orgs.map((name) => ({ value: name, label: name }))}
                  />
                </Field>
                <Field label={t("stories.project")}>
                  <Select
                    size="field"
                    value={adoProject}
                    placeholder={t("stories.pickProject")}
                    ariaLabel={t("stories.project")}
                    onChange={setAdoProject}
                    options={adoProjects.map((name) => ({ value: name, label: name }))}
                  />
                </Field>
                <Field label={t("stories.wiki")}>
                  <Select
                    size="field"
                    value={wikiId}
                    disabled={wikis.length === 0}
                    placeholder={t("stories.pickWiki")}
                    ariaLabel={t("stories.wiki")}
                    onChange={setWikiId}
                    options={wikis.map((wiki) => ({ value: wiki.id, label: wiki.name }))}
                  />
                </Field>
              </div>

              <Field
                label={t("stories.pages")}
                hint={t("stories.pagesHint", { n: pickedPages.length })}
              >
                <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
                  {loadingPages ? (
                    <p className="px-2 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
                      {t("stories.loadingPages")}
                    </p>
                  ) : pages.length === 0 ? (
                    <p className="px-2 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
                      {t("stories.noPages")}
                    </p>
                  ) : (
                    pages.map((page) => (
                      <label
                        key={page.path}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                        style={{ paddingLeft: 6 + page.depth * 14 }}
                      >
                        <Checkbox
                          checked={pickedPages.includes(page.path)}
                          onChange={() => togglePage(page.path)}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                          {page.title}
                        </span>
                        {page.has_children && (
                          <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">
                            {t("stories.hasChildren")}
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </Field>
            </div>
          ))}

        {kind === "files" &&
          (projects.length === 0 ? (
            <Note tone="warning">{t("stories.noProjects")}</Note>
          ) : (
            <div className="space-y-2.5">
              <Field label={t("stories.repository")}>
                <Select
                  size="field"
                  value={projectId}
                  ariaLabel={t("stories.repository")}
                  onChange={setProjectId}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                />
              </Field>

              <Field label={t("stories.files")} hint={t("stories.filesHint", { n: pickedFiles.length })}>
                <div className="relative mb-1.5">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
                  />
                  <input
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    placeholder={t("stories.filesSearchPlaceholder")}
                    className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] py-1 pl-6 pr-2 text-[12px] outline-none focus:border-[var(--cf-accent)]"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
                  {visibleFiles.length === 0 ? (
                    <p className="px-2 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
                      {t("stories.noDocFiles")}
                    </p>
                  ) : (
                    visibleFiles.map((path) => (
                      <label
                        key={path}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                      >
                        <Checkbox checked={pickedFiles.includes(path)} onChange={() => toggleFile(path)} />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]" title={path}>
                          {path}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {files.length > visibleFiles.length && (
                  <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                    {t("stories.filesTruncated", { shown: visibleFiles.length, total: files.length })}
                  </p>
                )}
              </Field>
            </div>
          ))}

        {kind === "text" && (
          <Field label={t("stories.pastedText")} hint={t("stories.pastedTextHint")}>
            <textarea
              autoFocus
              value={pasted}
              rows={12}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t("stories.pastedTextPlaceholder")}
              className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </Field>
        )}

        <Field label={t("stories.batchName")} hint={t("stories.batchNameHint")}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("stories.batchNamePlaceholder")}
            className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <Field label={t("stories.instructions")} hint={t("stories.instructionsHint")}>
          <textarea
            value={instructions}
            rows={3}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={t("stories.instructionsPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        {error && <Note tone="warning">{error}</Note>}
        {/* Where the "how many stories" picker used to be, and saying what replaced it. A number
            here was a quota: documentation describing three capabilities came back padded to
            eight because eight was what somebody guessed. */}
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <ListChecks size={11} className="mt-[2px] shrink-0" />
          <span>{t("stories.howManyNote")}</span>
        </p>
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <Sparkles size={11} className="mt-[2px] shrink-0" />
          <span>{t("stories.newBatchNote")}</span>
        </p>
      </div>
    </ApiModal>
  );
}
