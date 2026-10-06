import { create } from "zustand";
import {
  flowsRepoImport,
  flowsRepoPull,
  flowsRepoSave,
  flowsRepoScan,
  flowsRepoUnlink,
  type RepoFlowEntry,
} from "../lib/tauri/flowsCommands";
import { chooseAction } from "./confirmStore";
import { useFlowsStore } from "./flowsStore";
import { translate } from "./languageStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";

/**
 * Flows kept in the workspace's repositories (`.codeflow/flows/*.json`, `flows::repo`): the files
 * found there, which flow each is linked to, and which side moved since they last agreed.
 *
 * Read when the explorer shows and when the window comes back into focus — a `git pull` happens
 * outside the app. Nothing moves on its own: saving a flow into its file and bringing a file into
 * its flow are the person's two buttons.
 */
interface FlowRepoState {
  workspaceId: string | null;
  entries: RepoFlowEntry[];
  scan: (workspaceId: string | null) => Promise<void>;
  /** The entry of the file a flow is linked to, if any. */
  linkOf: (flowId: string) => RepoFlowEntry | undefined;
  importFile: (entry: RepoFlowEntry, folderId: string | null) => Promise<void>;
  save: (flowId: string, projectId: string | null) => Promise<void>;
  pull: (flowId: string) => Promise<void>;
  unlink: (flowId: string) => Promise<void>;
}

export const useFlowRepoStore = create<FlowRepoState>((set, get) => ({
  workspaceId: null,
  entries: [],

  scan: async (workspaceId) => {
    if (!workspaceId) {
      set({ workspaceId: null, entries: [] });
      return;
    }
    try {
      const entries = await flowsRepoScan(workspaceId);
      if (useFlowsStore.getState().workspaceId === workspaceId) set({ workspaceId, entries });
    } catch {
      // A repository that cannot be read lists nothing; the flows themselves are unaffected.
    }
  },

  linkOf: (flowId) => get().entries.find((entry) => entry.flowId === flowId),

  importFile: async (entry, folderId) => {
    const workspaceId = useFlowsStore.getState().workspaceId;
    if (!workspaceId) return;
    try {
      const { meta, notes } = await flowsRepoImport(workspaceId, entry.projectId, entry.path, folderId);
      await useFlowsStore.getState().refresh();
      if (notes.unmatchedCredentials.length > 0) pushErrorToast(translate("flows.imported.unmatched", { names: notes.unmatchedCredentials.join(", ") }));
      if (notes.cleared.length > 0) pushErrorToast(translate("flows.imported.cleared", { names: notes.cleared.join(", ") }));
      await useFlowsStore.getState().openFlow(meta.id);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().scan(workspaceId);
  },

  save: async (flowId, projectId) => {
    const flows = useFlowsStore.getState();
    if (flows.activeId === flowId) await flows.flush();
    const write = (force: boolean) => flowsRepoSave(flowId, projectId, force);
    try {
      const link = await write(false).catch(async (error) => {
        if (String(error) !== "changed") throw error;
        // A teammate's change to the file is not overwritten without asking.
        const answer = await chooseAction({
          message: translate("flows.repo.changedOnDisk"),
          choices: [
            { id: "pull", label: translate("flows.repo.pull") },
            { id: "overwrite", label: translate("flows.repo.overwrite"), variant: "danger" },
          ],
        });
        if (answer === "pull") {
          await get().pull(flowId);
          return null;
        }
        return answer === "overwrite" ? write(true) : null;
      });
      if (link) pushSuccessToast(translate("flows.repo.saved", { path: link.path }));
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().scan(flows.workspaceId);
  },

  pull: async (flowId) => {
    const flows = useFlowsStore.getState();
    if (flows.activeId === flowId) {
      if (flows.draft?.dirty) {
        const answer = await chooseAction({
          message: translate("flows.repo.pullOverEdits"),
          choices: [{ id: "pull", label: translate("flows.repo.pull") }],
        });
        if (answer !== "pull") return;
      }
      // What is on the canvas is saved first — into the version history, where it stays once the
      // file's version replaces it — so no pending autosave can write it back over the pull.
      await flows.flush();
    }
    try {
      const saved = await flowsRepoPull(flowId);
      if (saved.trigger_error) pushErrorToast(translate("flows.repo.disarmed", { reason: saved.trigger_error }));
      // The open flow shows the file's version — its own undo stops there.
      await useFlowsStore.getState().reloadShared(flowId);
      pushSuccessToast(translate("flows.repo.pulled"));
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().scan(flows.workspaceId);
  },

  unlink: async (flowId) => {
    try {
      await flowsRepoUnlink(flowId);
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().scan(useFlowsStore.getState().workspaceId);
  },
}));
