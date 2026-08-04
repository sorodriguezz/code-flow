import { create } from "zustand";
import {
  createDocPage,
  deleteDocPage,
  generateDocPage,
  importWikiPage,
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
import { notify } from "./notificationStore";
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

  /**
   * The open document's body as it is being typed, before it is saved. `null` when there is
   * nothing unsaved, and the editor then shows what the row holds.
   *
   * Always about `selectedId` — closing a document or opening another drops it, so there is never
   * a draft floating about that belongs to a page nobody is looking at.
   */
  draft: string | null;
  saving: boolean;

  /** The workspace whose pages are loaded. Held so a switch can be told from a remount: the view
   *  calls `setWorkspace` every time it mounts, and only a real change should close what is open. */
  workspaceId: string | null;
  setWorkspace: (workspaceId: string | null) => Promise<void>;
  select: (id: string | null) => void;
  toggleProject: (projectId: string) => void;
  setInstructions: (instructions: string) => void;
  setUseContext: (useContext: boolean) => void;

  create: (scope: DocScope, title: string, projectId?: string) => Promise<void>;
  /** Brings a page that already exists in the wiki in as a document, target included. Throws on a
   *  path that does not resolve — the caller is a form and shows it in place. */
  importFromWiki: (input: {
    scope: DocScope;
    projectId?: string;
    org: string;
    project: string;
    wikiId: string;
    wikiName: string;
    path: string;
    title?: string;
  }) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  editDraft: (content: string) => void;
  /** `silent` for the save that publishing does on the user's behalf — one "saved" toast in front
   *  of the "published" one only reports plumbing. */
  save: (options?: { silent?: boolean }) => Promise<void>;
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
  workspaceId: null,
  selectedId: null,
  loading: false,
  projectIds: [],
  instructions: "",
  useContext: false,
  runId: null,
  publishing: false,
  draft: null,
  saving: false,

  setWorkspace: async (workspaceId) => {
    if (get().workspaceId === workspaceId) return;
    // Before anything is dropped, and while `selectedId` and `pages` still point at the workspace
    // the text was written in: the editor's buffer is the one thing on this screen that lives only
    // in memory, and a workspace switch used to throw it away without asking. Silent because the
    // user did not press save — they changed workspace, and a toast about a page they are no
    // longer looking at is noise.
    await get().save({ silent: true });
    if (!workspaceId) {
      set({ workspaceId, pages: [], selectedId: null, draft: null });
      return;
    }
    set({ workspaceId, loading: true });
    try {
      const pages = await listDocPages(workspaceId);
      set((s) => {
        // A selection that survived a workspace switch would point at a document the new one
        // cannot show. Keeping it only when it is still in the list is the cheap correct rule.
        //
        // Nothing is opened in its place: the screen with no document open is a real state — no
        // publish panel, no editor — and auto-opening the newest page would mean the user could
        // close a document and have it come back the next time this view was mounted.
        const kept = pages.some((p) => p.id === s.selectedId);
        return { pages, selectedId: kept ? s.selectedId : null, draft: kept ? s.draft : null };
      });
    } catch (e: unknown) {
      pushErrorToast(String(e));
    } finally {
      set({ loading: false });
    }
  },

  // Re-selecting the open document keeps its draft; anything else is leaving it behind, and the
  // caller has already asked the user about unsaved work by the time this runs.
  select: (id) => set((s) => (s.selectedId === id ? {} : { selectedId: id, draft: null })),
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
      set((s) => ({ pages: [page, ...s.pages], selectedId: page.id, draft: null }));
    } catch (e: unknown) {
      pushErrorToast(String(e));
    }
  },

  importFromWiki: async (input) => {
    const workspaceId = activeWorkspaceId();
    if (!workspaceId) throw new Error(translate("docs.noWorkspace"));
    // Not caught here on purpose: the failures worth reporting — a path that is not a page, a wiki
    // the PAT cannot read — are answers to what the user just typed, and belong in the form that
    // asked rather than in a toast that outlives it.
    const page = await importWikiPage({ workspaceId, ...input });
    set((s) => ({ pages: [page, ...s.pages], selectedId: page.id, draft: null }));
  },

  rename: async (id, title) => {
    set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, title } : p)) }));
    await setDocPageTitle(id, title).catch((e: unknown) => pushErrorToast(String(e)));
  },

  // Typing is not saving. The body is what gets published, and what gets published is what the
  // row holds — so an edit stays local until Save, and the screen can say which of the two the
  // user is looking at.
  editDraft: (content) => set({ draft: content }),

  save: async (options) => {
    const s = get();
    const page = s.pages.find((p) => p.id === s.selectedId);
    if (!page || s.draft === null || s.saving) return;
    const content = s.draft;
    if (content === page.content) {
      set({ draft: null });
      return;
    }
    set({ saving: true });
    try {
      await setDocPageContent(page.id, content);
      set((state) => ({
        pages: state.pages.map((p) => (p.id === page.id ? { ...p, content, status: "ready" } : p)),
        // Only when the draft is still what was written: a keystroke that landed while the write
        // was in flight is unsaved work, and clearing it here would show it as saved.
        draft: state.draft === content ? null : state.draft,
      }));
      if (!options?.silent) useToastStore.getState().pushToast(translate("docs.saved"), "success");
    } catch (e: unknown) {
      pushErrorToast(String(e));
    } finally {
      set({ saving: false });
    }
  },

  remove: async (id) => {
    await deleteDocPage(id).catch((e: unknown) => pushErrorToast(String(e)));
    set((s) => {
      const pages = s.pages.filter((p) => p.id !== id);
      const open = s.selectedId === id;
      return { pages, selectedId: open ? null : s.selectedId, draft: open ? null : s.draft };
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
    // The run replaces the body outright — the user was warned and said yes — so an unsaved draft
    // of the text being replaced goes with it rather than reappearing over the new document.
    set({ runId, draft: null });
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
      notify({
        source: "docs",
        titleKey: "notifications.docsGenerated",
        target: { view: "stories", storiesMode: "wiki", select: { kind: "docPage", id: page.id } },
        status: "success",
        detail: page.title,
      });
    } catch (e: unknown) {
      // A stopped run is not news — see the same guard in `storiesStore`.
      if (!isCancellation(e)) {
        pushErrorToast(parseClaudeError(String(e)).message);
        notify({
          source: "docs",
          titleKey: "notifications.docsGenerateFailed",
        target: { view: "stories", storiesMode: "wiki", select: { kind: "docPage", id: page.id } },
          status: "error",
          detail: page.title,
        });
      }
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
    // What travels to the wiki is the stored body, read back in Rust from the row — so an unsaved
    // draft has to land first, or the user watches their newest paragraph not arrive. A save that
    // failed already said so; publishing the older text over it would be the wrong repair.
    await get().save({ silent: true });
    const s = get();
    const page = s.pages.find((p) => p.id === s.selectedId);
    if (!page || s.publishing) return;
    if (s.draft !== null && s.draft !== page.content) return;
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

/**
 * A document belongs to the workspace it was written in, so switching workspace puts it down.
 *
 * At module scope rather than in the view's effect, for the reason `chainStore` does the same: the
 * wiki is one sub-tab of three and unmounts as soon as the user looks at another, so an effect
 * would not run for the case that matters — the page left open, the tab changed, the workspace
 * changed, and an editor buffer still only in memory. `setWorkspace` writes it before it lets go.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
    void useDocsStore.getState().setWorkspace(state.activeWorkspaceId);
  }
});
