/**
 * The related notes of the note that is open: read once, compared with the rest in the background
 * when something was written since, and re-read when the backend says a pair changed.
 *
 * One note at a time, like the editor. The lists are small and cheap to read again; what is kept
 * here is whether a model is reading them, so the panel and the strip over the note agree.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { notesAddRelation, notesListRelations, notesRelate, notesRemoveRelation } from "../lib/tauri/notesCommands";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { useLanguageStore, translate } from "./languageStore";
import { useNotesStore } from "./notesStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import type { NoteRelation } from "../types/notes";

const LOCAL_UNAVAILABLE = "MEETINGS_LOCAL_UNAVAILABLE";

interface NoteRelationsState {
  noteId: string | null;
  relations: NoteRelation[];
  /** The open note's list has been read at least once. */
  loaded: boolean;
  /** The notes a model is reading, by id. */
  judging: Record<string, boolean>;
  /** Makes `noteId` the note being looked at: reads its relations and compares it with the rest. */
  watch: (noteId: string | null) => void;
  /** Compares the open note again — after it was edited. */
  rescan: () => Promise<void>;
  /** Has a model read `noteId` and its look-alikes. `quiet`: started by the app, so nothing found
   *  and a missing engine are not announced. */
  analyze: (noteId: string, options?: { quiet?: boolean }) => Promise<void>;
  add: (otherId: string) => Promise<void>;
  remove: (otherId: string) => Promise<void>;
}

const workspace = () => useNotesStore.getState().workspaceId;

export const useNoteRelationsStore = create<NoteRelationsState>((set, get) => {
  const read = async (noteId: string) => {
    try {
      const relations = await notesListRelations(noteId, workspace());
      if (get().noteId === noteId) set({ relations, loaded: true });
    } catch {
      if (get().noteId === noteId) set({ relations: [], loaded: true });
    }
  };
  const compare = async (noteId: string, force: boolean) => {
    try {
      const result = await notesRelate({ noteId, ai: false, force, workspaceId: workspace() });
      if (get().noteId === noteId) set({ relations: result.relations, loaded: true });
    } catch {
      /* The note went away meanwhile, or the database is busy: the list read above stands. */
    }
  };

  return {
    noteId: null,
    relations: [],
    loaded: false,
    judging: {},

    watch: (noteId) => {
      if (get().noteId === noteId) return;
      set({ noteId, relations: [], loaded: false });
      if (!noteId) return;
      void read(noteId).then(() => compare(noteId, false));
    },

    rescan: async () => {
      const noteId = get().noteId;
      if (noteId) await compare(noteId, false);
    },

    analyze: async (noteId, options) => {
      if (get().judging[noteId]) return;
      const runId = newRunId("note-relations");
      const title = useNotesStore.getState().notes.find((note) => note.id === noteId)?.title || translate("notes.untitled");
      set((state) => ({ judging: { ...state.judging, [noteId]: true } }));
      useAiRunStore.getState().start(runId, {
        kindKey: "notes.relations.runKind",
        detail: title,
        target: { view: "notes", select: { kind: "note", id: noteId } },
        workspaceId: workspace(),
      });
      try {
        const language = useLanguageStore.getState().language.startsWith("en") ? "English" : "español";
        const result = await notesRelate({ noteId, ai: true, language, runId, workspaceId: workspace() });
        if (get().noteId === noteId) set({ relations: result.relations, loaded: true });
        if (result.nothing && !options?.quiet) useToastStore.getState().pushToast(translate("notes.relations.nothingAlike"), "info");
      } catch (error) {
        if (!isCancellation(error) && !options?.quiet) {
          const text = String(error);
          pushErrorToast(text.includes(LOCAL_UNAVAILABLE) ? translate("meetings.ai.localUnavailable") : text);
        }
      } finally {
        useAiRunStore.getState().finish(runId);
        set((state) => {
          const { [noteId]: _done, ...judging } = state.judging;
          return { judging };
        });
      }
    },

    add: async (otherId) => {
      const noteId = get().noteId;
      if (!noteId) return;
      try {
        await notesAddRelation(noteId, otherId);
        await read(noteId);
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    remove: async (otherId) => {
      const noteId = get().noteId;
      if (!noteId) return;
      // Gone from the list at once; the read after it is what says whether it held.
      set((state) => ({ relations: state.relations.filter((relation) => relation.id !== otherId) }));
      try {
        await notesRemoveRelation(noteId, otherId);
      } catch (error) {
        pushErrorToast(String(error));
      }
      await read(noteId);
    },
  };
});

// A pair changed somewhere — a model finished, an agent filed a note, the other side was edited:
// the open note's list is read again, whichever of the two it is.
if (typeof window !== "undefined") {
  void listen<{ noteId: string }>("notes:relations", () => {
    const noteId = useNoteRelationsStore.getState().noteId;
    if (!noteId) return;
    void notesListRelations(noteId, workspace())
      .then((relations) => {
        if (useNoteRelationsStore.getState().noteId === noteId) useNoteRelationsStore.setState({ relations, loaded: true });
      })
      .catch(() => {});
  }).catch(() => {});
}
