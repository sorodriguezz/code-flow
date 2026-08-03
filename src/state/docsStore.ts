import { create } from "zustand";
import {
  createDocPage,
  deleteDocPage,
  generateDocPage,
  listDocPages,
  publishDocPage,
  setDocPageContent,
  setDocPageTarget,
  setDocPageTitle,
} from "../lib/tauri/commands";
import { parseClaudeError } from "../lib/claudeError";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { DocPage, DocScope } from "../types/domain";

/**
 * Technical documentation the workspace generates about itself.
 *
 * Two scopes, and they answer different questions rather than the same one at different zoom
 * levels. A **repository** document is grounded in one checkout and says how to run, configure and
 * deploy that one thing — environment variables, local setup, integrations, database. A
 * **workspace** document is a synthesis over several of them and says how they fit together and
 * what they solve as a system; it is written from the repository documents rather than from code,
 * because no single engine run can see two checkouts (see `synthesize_workspace_doc` in Rust).
 *
 * Documents are persisted from the moment they are created — before anything is generated — so a
 * generation that fails or is stopped leaves a row to retry from rather than making the user set
 * the whole thing up again.
 */

interface DocsState {
  pages: DocPage[];
  selectedId: string | null;
  loading: boolean;

  /** Which repositories the next generation reads. For `repo` scope the first one is the subject. */
  projectIds: string[];
  /** Free-text steer for the generation ("documenta solo el módulo de pagos"). */
  instructions: string;
  useContext: boolean;
  /** Run id while a generation is in flight — present is also what Stop acts on. */
  runId: string | null;
  publishing: boolean;

  setWorkspace: (workspaceId: string | null) => Promise<void>;
  select: (id: string | null) => void;
  toggleProject: (projectId: string) => void;
  setInstructions: (instructions: string) => void;
  setUseContext: (useContext: boolean) => void;

  create: (scope: DocScope, title: string, projectId?: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  edit: (id: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setTarget: (input: {
    id: string;
    org: string;
    project: string;
    wikiId: string;
    wikiName: string;
    pagePath: string;
  }) => Promise<void>;

  generate: () => Promise<void>;
  stop: () => Promise<void>;
  publish: () => Promise<void>;
}

export const useDocsStore = create<DocsState>((set, get) => ({
  pages: [],
  selectedId: null,
  loading: false,
  projectIds: [],
  instructions: "",
  useContext: false,
  runId: null,
  publishing: false,

  setWorkspace: async (workspaceId) => {
    if (!workspaceId) {
      set({ pages: [], selectedId: null });
      return;
    }
    set({ loading: true });
    try {
      const pages = await listDocPages(workspaceId);
      set((s) => ({
        pages,
        // A selection that survived a workspace switch would point at a document the new one
        // cannot show. Keeping it only when it is still in the list is the cheap correct rule.
        selectedId: pages.some((p) => p.id === s.selectedId) ? s.selectedId : (pages[0]?.id ?? null),
      }));
    } catch (e: unknown) {
      pushErrorToast(String(e));
    } finally {
      set({ loading: false });
    }
  },

  select: (id) => set({ selectedId: id }),
  setInstructions: (instructions) => set({ instructions }),
  setUseContext: (useContext) => set({ useContext }),
  toggleProject: (projectId) =>
    set((s) => ({
      projectIds: s.projectIds.includes(projectId)
        ? s.projectIds.filter((id) => id !== projectId)
        : [...s.projectIds, projectId],
    })),

  create: async (scope, title, projectId) => {
    const workspaceId = activeWorkspaceId();
    if (!workspaceId) return;
    try {
      const page = await createDocPage({ workspaceId, projectId, scope, title });
      set((s) => ({ pages: [page, ...s.pages], selectedId: page.id }));
    } catch (e: unknown) {
      pushErrorToast(String(e));
    }
  },

  rename: async (id, title) => {
    set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, title } : p)) }));
    await setDocPageTitle(id, title).catch((e: unknown) => pushErrorToast(String(e)));
  },

  edit: async (id, content) => {
    set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, content, status: "ready" } : p)) }));
    await setDocPageContent(id, content).catch((e: unknown) => pushErrorToast(String(e)));
  },

  remove: async (id) => {
    await deleteDocPage(id).catch((e: unknown) => pushErrorToast(String(e)));
    set((s) => {
      const pages = s.pages.filter((p) => p.id !== id);
      return { pages, selectedId: s.selectedId === id ? (pages[0]?.id ?? null) : s.selectedId };
    });
  },

  setTarget: async (input) => {
    set((s) => ({
      pages: s.pages.map((p) =>
        p.id === input.id
          ? {
              ...p,
              ado_org: input.org,
              ado_project: input.project,
              wiki_id: input.wikiId,
              wiki_name: input.wikiName,
              page_path: input.pagePath,
            }
          : p,
      ),
    }));
    await setDocPageTarget(input).catch((e: unknown) => pushErrorToast(String(e)));
  },

  generate: async () => {
    const s = get();
    const page = s.pages.find((p) => p.id === s.selectedId);
    const workspaceId = activeWorkspaceId();
    if (!page || !workspaceId || s.runId) return;

    // A repository document is about the repository it was created for; the picker only steers the
    // workspace scope. Reading it from the row rather than from the picker is what stops a document
    // titled "Checkout API" from being regenerated against whatever happens to be ticked.
    const projectIds =
      page.scope === "repo" ? (page.project_id ? [page.project_id] : []) : s.projectIds;
    if (projectIds.length === 0) {
      pushErrorToast(translate("docs.pickReposFirst"));
      return;
    }

    const runId = newRunId("docs");
    useAiRunStore.getState().start(runId);
    set({ runId });
    set((state) => ({
      pages: state.pages.map((p) => (p.id === page.id ? { ...p, status: "generating" } : p)),
    }));

    try {
      const result = await generateDocPage({
        workspaceId,
        docId: page.id,
        scope: page.scope,
        projectIds,
        instructions: s.instructions,
        useContext: s.useContext,
        runId,
      });
      set((state) => ({
        pages: state.pages.map((p) =>
          p.id === page.id
            ? {
                ...p,
                content: result.content,
                status: "ready",
                last_error: "",
                engine: result.engine,
                model: result.model,
                version: result.version,
              }
            : p,
        ),
      }));
      useToastStore.getState().pushToast(translate("docs.generated"), "success");
    } catch (e: unknown) {
      if (!isCancellation(e)) pushErrorToast(parseClaudeError(String(e)).message);
      // The row's own status was already written by the backend; re-reading it is what keeps a
      // failed run's error message on screen instead of a stale "generating".
      await get().setWorkspace(workspaceId);
    } finally {
      useAiRunStore.getState().finish(runId);
      set({ runId: null });
    }
  },

  stop: async () => {
    const runId = get().runId;
    if (runId) await useAiRunStore.getState().cancel(runId);
  },

  publish: async () => {
    const s = get();
    const page = s.pages.find((p) => p.id === s.selectedId);
    if (!page || s.publishing) return;
    set({ publishing: true });
    try {
      const published = await publishDocPage(page.id);
      set((state) => ({
        pages: state.pages.map((p) =>
          p.id === page.id
            ? { ...p, published_at: new Date().toISOString(), published_url: published.url }
            : p,
        ),
      }));
      useToastStore
        .getState()
        .pushToast(translate(published.updated ? "docs.updatedOnWiki" : "docs.createdOnWiki"), "success");
    } catch (e: unknown) {
      pushErrorToast(String(e));
    } finally {
      set({ publishing: false });
    }
  },
}));

function activeWorkspaceId(): string | null {
  const id = useWorkspaceStore.getState().activeWorkspaceId;
  if (!id) pushErrorToast(translate("docs.noWorkspace"));
  return id;
}
