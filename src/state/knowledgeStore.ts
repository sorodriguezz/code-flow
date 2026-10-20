import { create } from "zustand";
import {
  knowledgeAddFolder,
  knowledgeCancelDownload,
  knowledgeDeleteModel,
  knowledgeDownloadModel,
  knowledgeOverview,
  knowledgeReindex,
  knowledgeRemoveFolder,
  knowledgeSetCloud,
  knowledgeSetEmbedModel,
  knowledgeUpdateFolder,
  type KnowledgeOverview,
} from "../lib/tauri/knowledgeCommands";
import { onLocalAiDownload, type LocalAiDownloadEvent } from "../lib/tauri/events";
import { localExecErrorText } from "./localExecStore";
import { pushErrorToast } from "./toastStore";

/**
 * Settings › Knowledge: one workspace's view of the knowledge index. Re-read after every action and
 * when the pane opens; downloads report on `localai:download` like every other model.
 *
 * The workspace a load was for is kept with its answer, so an answer for a workspace the user has
 * since left is dropped rather than drawn under the wrong one (the run-isolation rule).
 */
interface KnowledgeStore {
  workspaceId: string | null;
  overview: KnowledgeOverview | null;
  reindexing: boolean;
  progress: Record<string, LocalAiDownloadEvent>;
  load: (workspaceId: string) => Promise<void>;
  reindex: () => Promise<void>;
  setCloud: (allowed: boolean) => Promise<void>;
  addFolder: (path: string, localOnly: boolean) => Promise<void>;
  updateFolder: (id: string, patch: { localOnly?: boolean; enabled?: boolean }) => Promise<void>;
  removeFolder: (id: string) => Promise<void>;
  useModel: (id: string | null) => Promise<void>;
  download: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
}

let subscribed = false;

export const useKnowledgeStore = create<KnowledgeStore>((set, get) => {
  const again = async () => {
    const ws = get().workspaceId;
    if (ws) await get().load(ws);
  };
  const guard = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      pushErrorToast(localExecErrorText(e));
    }
    await again();
  };
  return {
    workspaceId: null,
    overview: null,
    reindexing: false,
    progress: {},

    load: async (workspaceId) => {
      if (!subscribed) {
        subscribed = true;
        void onLocalAiDownload((event) => {
          set((s) => ({ progress: { ...s.progress, [event.model_id]: event } }));
          if (event.phase === "done" || event.phase === "failed") void again();
        });
      }
      set((s) => (s.workspaceId === workspaceId ? {} : { workspaceId, overview: null }));
      try {
        const overview = await knowledgeOverview(workspaceId);
        if (get().workspaceId === workspaceId) set({ overview });
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    reindex: async () => {
      const ws = get().workspaceId;
      if (!ws) return;
      set({ reindexing: true });
      await guard(() => knowledgeReindex(ws));
      set({ reindexing: false });
    },

    setCloud: async (allowed) => {
      const ws = get().workspaceId;
      if (!ws) return;
      set((s) => (s.overview ? { overview: { ...s.overview, cloudAllowed: allowed } } : {}));
      await guard(() => knowledgeSetCloud(ws, allowed));
    },

    addFolder: async (path, localOnly) => {
      const ws = get().workspaceId;
      if (!ws) return;
      await guard(() => knowledgeAddFolder(ws, path, localOnly));
    },

    updateFolder: (id, patch) => guard(() => knowledgeUpdateFolder(id, patch)),
    removeFolder: (id) => guard(() => knowledgeRemoveFolder(id)),
    useModel: (id) => guard(() => knowledgeSetEmbedModel(id)),
    download: (id) => guard(() => knowledgeDownloadModel(id)),
    cancelDownload: (id) => guard(() => knowledgeCancelDownload(id)),
    removeModel: (id) => guard(() => knowledgeDeleteModel(id)),
  };
});
