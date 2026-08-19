import { create } from "zustand";
import {
  REPO_BUSY_MARKER,
  createDocPage,
  deleteDocPage,
  generateDocPage,
  importWikiPage,
  isRepoBusy,
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

/** What the next generation of one document reads: the composer above the editor, per document. */
export interface DocComposer {
  /** Which repositories the generation reads. Only the workspace scope's picker fills this — a
   *  repository document takes its subject from the row, so that scope never consults it. */
  projectIds: string[];
  /** Free-text steer for the generation ("documenta solo el módulo de pagos"). */
  instructions: string;
  useContext: boolean;
}

/** A generation in flight: what Stop cancels, and where the work belongs. */
interface DocRun {
  runId: string;
  /**
   * The workspace the document was in when the run started.
   *
   * Stamped here rather than read back at completion time, because by then it may be the answer to
   * a different question: the user switches workspace while a document is being written, and
   * "which workspace is active" has stopped meaning "which workspace is this run writing into".
   * Every write the run makes afterwards is checked against this value.
   */
  workspaceId: string;
  startedAt: number;
}

/**
 * What a document whose composer has not been touched reads.
 *
 * One shared object rather than a fresh literal per call: components select this straight out of
 * the store, and a new object on every render is a new snapshot as far as `useSyncExternalStore` is
 * concerned — which is a render loop, not a default.
 */
export const NO_DOC_PARAMS: DocComposer = { projectIds: [], instructions: "", useContext: false };

interface DocsState {
  /**
   * Every document of the workspace, **body included**.
   *
   * `list_doc_pages` projects the whole row, so opening this view holds the full markdown of every
   * document at once when the list only ever renders titles, scope and status. Making it lazy is a
   * backend change and not a frontend one: it needs `list_doc_pages` to stop selecting `content`
   * *and* a `get_doc_page` command to fetch one body on `select`. Rust has the query
   * (`queries::get_doc_page`) but it is not registered in `lib.rs`, so there is nothing to invoke
   * yet — dropping `content` from the list today would blank the editor, `publish` and the
   * `save` short-circuit that compares the draft against it.
   *
   * And a hydrate-after-select would not be enough on its own, which is the part that is easy to
   * get wrong: `WikiView` renders `bodyOf(page, draft)` — i.e. `page.content` — straight into
   * `MarkdownEditor` with no loading state, and the editor keeps an undo history keyed by
   * `page.id`. A body that arrives as `""` and is replaced a tick later is an *edit* as far as that
   * history is concerned, so the user could undo back to an empty document and save it over their
   * page. Whoever makes this lazy has to give the editor a "loading" state for a page whose body is
   * not in yet — the store cannot do it alone.
   */
  pages: DocPage[];
  selectedId: string | null;
  loading: boolean;

  /**
   * What each document's composer holds, keyed by document id.
   *
   * Per document rather than one composer for the whole screen, and the repository list is the
   * reason it has to be. Ticking two repositories for an architecture document, switching to a
   * workspace where those ids mean nothing and pressing Generate used to send the *first*
   * workspace's checkouts into a run whose prompt templates, contexts and skills all came from the
   * *second* — and `sync_skills_into_project` then copies the second workspace's enabled skills
   * into the first one's working tree and deletes the ones it has disabled. Nothing on screen said
   * so: the picker draws a blank label for an id it cannot find, and the "at least one repository"
   * guard is a length check, which the foreign ids passed.
   *
   * A document whose composer nobody has touched has no entry; readers fall back to
   * `NO_DOC_PARAMS`.
   */
  paramsByDoc: Record<string, DocComposer>;
  /**
   * Generations in flight, keyed by the document each one is writing.
   *
   * Never one `runId` for the whole store, which is what it used to be: a single generation then
   * drew the thinking orb over every other document, locked every editor read-only — and
   * `MarkdownEditor` turns a read-only buffer into a preview, so the other documents lost their
   * edit pane outright — and redrew every Generate button as a Stop that cancelled somebody else's
   * run. Across workspaces too, because there is one store and it outlives the switch.
   */
  runByDoc: Record<string, DocRun>;
  publishing: boolean;

  /**
   * The open document's body as it is being typed, before it is saved. `null` when there is
   * nothing unsaved, and the editor then shows what the row holds.
   *
   * Always about `selectedId` — closing a document or opening another writes it first and then
   * drops it (see `select`), so there is never a draft floating about that belongs to a page
   * nobody is looking at.
   */
  draft: string | null;
  saving: boolean;

  /** The workspace whose pages are loaded. Held so a switch can be told from a remount: the view
   *  calls `setWorkspace` every time it mounts, and only a real change should close what is open. */
  workspaceId: string | null;
  setWorkspace: (workspaceId: string | null) => Promise<void>;
  /** Saves whatever is unsaved in the document being left, then opens the other one. */
  select: (id: string | null) => Promise<void>;
  toggleProject: (docId: string, projectId: string) => void;
  setInstructions: (docId: string, instructions: string) => void;
  setUseContext: (docId: string, useContext: boolean) => void;

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
  /**
   * Writes the open document's draft.
   *
   * `silent` for the save that publishing does on the user's behalf — one "saved" toast in front of
   * the "published" one only reports plumbing.
   *
   * Answers **whether the buffer is safe to leave behind**: `true` when there was nothing unsaved
   * or the write landed, `false` when the write failed and the text is still only in memory. That
   * is what lets `select` refuse to move off a document whose save did not go through — without it
   * a host error meant the draft was reported in a toast and then dropped anyway.
   */
  save: (options?: { silent?: boolean }) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  setTarget: (input: {
    id: string;
    org: string;
    project: string;
    wikiId: string;
    wikiName: string;
    pagePath: string;
  }) => Promise<void>;

  /** Writes one document, named by id rather than "the open one": the run outlives the selection
   *  and, more to the point, the workspace the selection lives in. */
  generate: (docId: string) => Promise<void>;
  stop: (docId: string) => Promise<void>;
  publish: () => Promise<void>;
}

export const useDocsStore = create<DocsState>((set, get) => ({
  pages: [],
  workspaceId: null,
  selectedId: null,
  loading: false,
  paramsByDoc: {},
  runByDoc: {},
  publishing: false,
  draft: null,
  saving: false,

  setWorkspace: async (workspaceId) => {
    if (get().workspaceId === workspaceId) return;

    // What is being left, read while the store still points at it. Both are needed after the swap
    // below, and neither can be looked up afterwards — that is the whole reason they are captured.
    const leaving = get();
    const openPage = leaving.pages.find((p) => p.id === leaving.selectedId);
    const openDraft = leaving.draft;

    // The swap is committed *synchronously*, before either await, and the ordering is the point.
    // The old shape wrote `workspaceId` only after the save, so between the two the store said
    // "workspace B" while `pages` still held A's documents — and `removeWorkspace` drives
    // `A → null → workspaces[0]` in one go, which raced through that window and could leave the
    // store parked on `workspaceId: null` with an empty list and nothing left to repair it.
    //
    // `runByDoc` is deliberately absent: run ids and document ids are UUIDs, nothing collides
    // across workspaces, and a generation must not stop being tracked because the user looked
    // somewhere else — that is exactly the run this whole design exists for. `paramsByDoc` is the
    // opposite case and is dropped, because it is keyed by documents that are going away and its
    // repository ids only mean anything inside the workspace they were ticked in.
    set({
      workspaceId,
      pages: [],
      selectedId: null,
      draft: null,
      paramsByDoc: {},
      loading: Boolean(workspaceId),
    });

    // The editor's buffer is the one thing on this screen that lives only in memory, and a
    // workspace switch used to throw it away without asking. Written against the page it was typed
    // into rather than through `save()`, which would look the page up through a `selectedId` that
    // no longer exists. Silent because the user did not press save — they changed workspace, and a
    // toast about a page they are no longer looking at is noise.
    await persistDraft(openPage, openDraft);

    if (!workspaceId) return;
    try {
      const pages = await listDocPages(workspaceId);
      // Only if this is still the load the store is waiting for — a second switch while this one
      // was in flight would otherwise list the workspace the user has already left.
      //
      // Nothing is opened: the screen with no document open is a real state — no publish panel, no
      // editor — and auto-opening the newest page would mean the user could close a document and
      // have it come back the next time this view was mounted.
      set((s) => (s.workspaceId === workspaceId ? { pages, loading: false } : {}));
    } catch (e: unknown) {
      pushErrorToast(String(e));
      // Guarded like the success arm: another switch may have overtaken this load, and clearing
      // its `loading` would draw an empty list as if it had finished.
      set((s) => (s.workspaceId === workspaceId ? { loading: false } : {}));
    }
  },

  // Re-selecting the open document keeps its draft; anything else is leaving it behind — and
  // leaving it behind now means writing it, not discarding it. The notification centre and the
  // status bar both land here without passing the view's confirm dialog, so a document opened from
  // a finished run used to take the unsaved paragraph of whatever was open with it.
  select: async (id) => {
    const { selectedId, workspaceId } = get();
    if (selectedId === id) return;
    // A save that did not land leaves the paragraph in memory and nowhere else, so this stays put
    // rather than opening the other document over it. Replacing the confirm dialog with an
    // automatic save only improves on it while the save actually happens — silently discarding the
    // text because the host refused the write is the one outcome the dialog could never produce.
    // The failure has already been said in a toast; the document simply does not change.
    if (!(await get().save({ silent: true }))) return;
    // Rule B, and the reason `select` had to grow an await to obey it: the save is a round trip to
    // the host, and a workspace switch landing inside it has already emptied `pages` and cleared
    // the selection. Writing this id on top of that would leave the store pointing at a document
    // the new workspace does not hold — no editor, no publish panel, and a `save` that silently
    // finds nothing the next time the user presses Mod+S.
    set((s) => (s.workspaceId === workspaceId ? { selectedId: id, draft: null } : {}));
  },
  setInstructions: (docId, instructions) => set((s) => patchParams(s, docId, { instructions })),
  setUseContext: (docId, useContext) => set((s) => patchParams(s, docId, { useContext })),
  toggleProject: (docId, projectId) =>
    set((s) => {
      const picked = (s.paramsByDoc[docId] ?? NO_DOC_PARAMS).projectIds;
      return patchParams(s, docId, {
        projectIds: picked.includes(projectId)
          ? picked.filter((id) => id !== projectId)
          : [...picked, projectId],
      });
    }),

  create: async (scope, title, projectId) => {
    // The store's own workspace, not the active one. The two are the same nearly always and
    // divergent exactly when it matters: `pages` and `workspaceId` are written together, while
    // `activeWorkspaceId` has already moved on by the time this store hears about the switch.
    const workspaceId = get().workspaceId;
    if (!workspaceId) {
      pushErrorToast(translate("docs.noWorkspace"));
      return;
    }
    try {
      const page = await createDocPage({ workspaceId, projectId, scope, title });
      // Only into the list it was created for. A row prepended after a switch would sit in another
      // workspace's list, be opened by the `selectedId` below, and publish from there.
      set((s) =>
        s.workspaceId !== workspaceId ? {} : { pages: [page, ...s.pages], selectedId: page.id, draft: null },
      );
    } catch (e: unknown) {
      pushErrorToast(String(e));
    }
  },

  importFromWiki: async (input) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) throw new Error(translate("docs.noWorkspace"));
    // Not caught here on purpose: the failures worth reporting — a path that is not a page, a wiki
    // the PAT cannot read — are answers to what the user just typed, and belong in the form that
    // asked rather than in a toast that outlives it.
    const page = await importWikiPage({ workspaceId, ...input });
    set((s) =>
      s.workspaceId !== workspaceId ? {} : { pages: [page, ...s.pages], selectedId: page.id, draft: null },
    );
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
    // Nothing to write is the same answer as "written" to every caller: there is no unsaved text
    // left behind either way. A save already in flight is the one honest `false` here — its own
    // caller is about to settle it, and reporting success for a write somebody else is doing would
    // let this one move off the document underneath it.
    if (!page || s.draft === null) return true;
    if (s.saving) return false;
    const content = s.draft;
    if (content === page.content) {
      set({ draft: null });
      return true;
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
      return true;
    } catch (e: unknown) {
      pushErrorToast(String(e));
      return false;
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

  generate: async (docId) => {
    const s = get();
    const page = s.pages.find((p) => p.id === docId);
    const workspaceId = s.workspaceId;
    // Per document, never store-wide: a second run for *this* document would fight the first one
    // over the same row, but a run on another document is exactly what is meant to be possible.
    if (!page || !workspaceId || s.runByDoc[docId]) return;
    // `pages` and `workspaceId` are written together so they cannot normally disagree — but the row
    // carries its own workspace and this is the one place where sending the wrong pair would have
    // the backend read one workspace's checkouts under another's prompts and skills.
    if (page.workspace_id !== workspaceId) return;

    // A repository document is about the repository it was created for; the picker only steers the
    // workspace scope. Reading it from the row rather than from the picker is what stops a document
    // titled "Checkout API" from being regenerated against whatever happens to be ticked.
    const params = s.paramsByDoc[docId] ?? NO_DOC_PARAMS;
    const picked = page.scope === "repo" ? (page.project_id ? [page.project_id] : []) : params.projectIds;
    // Defence in depth against a repository id that outlived the workspace it belongs to. The
    // composer is per document and cleared on every switch, so this should already be empty rather
    // than foreign — but the consequence of being wrong here is `sync_skills_into_project` writing
    // one workspace's skills into another workspace's working tree, which is worth two lines.
    // Only filtered when the list is actually known: an unloaded workspace would otherwise refuse
    // every generation instead of the one thing this is looking for.
    const owned = useWorkspaceStore.getState().projectsByWorkspace[workspaceId];
    const projectIds = owned ? picked.filter((id) => owned.some((p) => p.id === id)) : picked;
    if (projectIds.length === 0) {
      pushErrorToast(translate("docs.pickReposFirst"));
      return;
    }

    // Everything the completion handlers are allowed to know, captured before the first await. Not
    // `activeWorkspaceId` and not "the selected document" — both of those are questions about where
    // the user is standing, and this run has to keep working after they walk away.
    const runWorkspaceId = page.workspace_id;
    const title = page.title;
    const target = {
      view: "stories" as const,
      storiesMode: "wiki" as const,
      // Brings the document's repository to the front before the wiki opens, so a run followed
      // from another workspace lands on the right project as well as the right page.
      projectId: page.project_id ?? undefined,
      select: { kind: "docPage" as const, id: docId },
    };

    const runId = newRunId("docs");
    useAiRunStore.getState().start(runId, {
      kindKey: "agents.liveKindDocs",
      detail: title,
      target,
      workspaceId: runWorkspaceId,
    });
    set((state) => ({
      runByDoc: { ...state.runByDoc, [docId]: { runId, workspaceId: runWorkspaceId, startedAt: Date.now() } },
      // The run replaces the body outright — the user was warned and said yes — so an unsaved draft
      // of the text being replaced goes with it rather than reappearing over the new document. Only
      // when the draft is this document's: another document's unsaved work is not part of the deal.
      draft: state.selectedId === docId ? null : state.draft,
      pages: state.pages.map((p) => (p.id === docId ? { ...p, status: "generating" } : p)),
    }));

    try {
      const result = await generateDocPage({
        workspaceId: runWorkspaceId,
        docId,
        scope: page.scope,
        projectIds,
        instructions: params.instructions,
        useContext: params.useContext,
        runId,
      });
      // Proves it is still landing where it started before it writes. The store may be pointed at
      // another workspace by now, and `pages` would then be that workspace's documents; the row may
      // also have been deleted while the model was writing. Either way the generated text is not
      // written anywhere — the notification below is what carries it back.
      set((state) =>
        state.workspaceId !== runWorkspaceId || !state.pages.some((p) => p.id === docId)
          ? {}
          : {
              pages: state.pages.map((p) =>
                p.id === docId
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
            },
      );
      // A toast is about the workspace you are standing in. For a run the user has walked away
      // from, the correctly-stamped notification below is the channel — a toast there announces
      // something that happened somewhere they cannot see, over a screen about something else.
      // Reading the active workspace is fine here precisely because this decides nothing about
      // where the write lands; the guard above already did that.
      if (useWorkspaceStore.getState().activeWorkspaceId === runWorkspaceId) {
        useToastStore.getState().pushToast(translate("docs.generated"), "success");
      }
      notify({
        source: "docs",
        titleKey: "notifications.docsGenerated",
        target,
        status: "success",
        detail: title,
        workspaceId: runWorkspaceId,
      });
    } catch (e: unknown) {
      // Another run already holds one of these repositories' working copies — one engine per
      // checkout, enforced by a real lease in Rust, and the lease is taken before the row is
      // touched. The run never started, so this is retry-later rather than failure: the document is
      // not marked `error` and nothing is filed in the notification centre, the reload below takes
      // the optimistic "generating" back off, and the reason is said once — in the repository's own
      // name, where the user used to be shown the raw `REPO_BUSY::` marker instead.
      // Toasts follow the same rule as the success one above: they belong to the workspace the
      // reader is standing in. A red banner thrown over workspace B about a document in workspace A
      // interrupts work it says nothing useful about — the notification, filed under A and
      // clickable back into it, is the channel for a run the user has walked away from.
      const watching = useWorkspaceStore.getState().activeWorkspaceId === runWorkspaceId;
      if (isRepoBusy(e)) {
        if (watching) pushErrorToast(translate("agents.busyInRepo", { name: busyRepoName(String(e)) }));
      } else if (!isCancellation(e)) {
        // A stopped run is not news — see the same guard in `storiesStore`.
        if (watching) pushErrorToast(parseClaudeError(String(e)).message);
        notify({
          source: "docs",
          titleKey: "notifications.docsGenerateFailed",
          target,
          status: "error",
          detail: title,
          workspaceId: runWorkspaceId,
        });
      }
      // The row's own status was already written by the backend; re-reading it is what keeps a
      // failed run's error message on screen instead of a stale "generating".
      //
      // A plain reload rather than `setWorkspace(workspaceId)`, which is what used to be here: that
      // call re-pointed the *whole store* at the workspace the run had started in, so a failure
      // arriving after the user moved on repopulated the wiki with workspace A's documents while
      // every other pane in the app said B. Nothing here may steer the store — it only refreshes
      // the list it started from, and only while that is still the list on screen.
      if (get().workspaceId === runWorkspaceId) {
        const pages = await listDocPages(runWorkspaceId).catch(() => null);
        if (pages) set((state) => (state.workspaceId === runWorkspaceId ? { pages } : {}));
      }
    } finally {
      useAiRunStore.getState().finish(runId);
      set((state) => {
        // This document's entry, and only if it is still this run's. A second generation started
        // after a stop would otherwise be deregistered by the first one's `finally` — the button
        // would go back to Generate with a model still writing behind it.
        if (state.runByDoc[docId]?.runId !== runId) return {};
        const { [docId]: _done, ...runByDoc } = state.runByDoc;
        return { runByDoc };
      });
    }
  },

  stop: async (docId) => {
    const run = get().runByDoc[docId];
    if (run) await useAiRunStore.getState().cancel(run.runId);
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

/** One document's composer, changed a field at a time and defaulted on first touch. */
function patchParams(
  state: DocsState,
  docId: string,
  patch: Partial<DocComposer>,
): Pick<DocsState, "paramsByDoc"> {
  const current = state.paramsByDoc[docId] ?? NO_DOC_PARAMS;
  return { paramsByDoc: { ...state.paramsByDoc, [docId]: { ...current, ...patch } } };
}

/**
 * An unsaved draft written straight to the page it was typed into.
 *
 * `save()` finds its page through `selectedId`, which is precisely what a workspace switch has to
 * change before it can load anything — so the switch captures the page and the text first and
 * writes them through here instead. Failures are reported and swallowed: the switch is already
 * happening, and there is no screen left to retry on.
 */
async function persistDraft(page: DocPage | undefined, draft: string | null): Promise<void> {
  if (!page || draft === null || draft === page.content) return;
  await setDocPageContent(page.id, draft).catch((e: unknown) => pushErrorToast(String(e)));
}

/** The repository named in the backend's busy marker — `REPO_BUSY::api-gateway`, occasionally with
 *  the trailing quote of the JSON error it travelled in. Same shape as `agentsStore`'s. */
function busyRepoName(error: string): string {
  const at = error.indexOf(REPO_BUSY_MARKER);
  return at < 0 ? "" : error.slice(at + REPO_BUSY_MARKER.length).replace(/"$/, "").trim();
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
