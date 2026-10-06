import { create } from "zustand";
import {
  flowsCreateCredential,
  flowsDeleteCredential,
  flowsDeleteVariable,
  flowsListCredentials,
  flowsListVariables,
  flowsOauthConnect,
  flowsPutVariable,
  flowsRenameVariable,
  flowsSetCredentialScope,
  flowsSetVariableScope,
  flowsUpdateCredential,
  type FlowCredential,
  type FlowCredentialKind,
  type FlowVariable,
} from "../lib/tauri/flowsCommands";
import { pushErrorToast } from "./toastStore";

/**
 * The workspace's `$vars` and the credentials Flujos nodes point at — what the Variables dialog
 * edits and the HTTP node's credential picker lists. A secret never reaches this store: it goes
 * from the field straight to the command, and the command straight to the keychain.
 */
interface FlowVaultState {
  workspaceId: string | null;
  variables: FlowVariable[];
  credentials: FlowCredential[];
  /** The dialog, and the tab it opens on. */
  dialog: "variables" | "credentials" | null;

  load: (workspaceId: string) => Promise<void>;
  openDialog: (tab: "variables" | "credentials" | null) => void;
  putVariable: (name: string, value: string) => Promise<boolean>;
  renameVariable: (id: string, name: string) => Promise<boolean>;
  deleteVariable: (id: string) => Promise<void>;
  setVariableScope: (id: string, global: boolean) => Promise<void>;
  createCredential: (name: string, kind: FlowCredentialKind, meta: Record<string, string>, secret: string) => Promise<FlowCredential | null>;
  updateCredential: (id: string, name: string, meta: Record<string, string>, secret: string | null) => Promise<boolean>;
  deleteCredential: (id: string) => Promise<void>;
  setCredentialScope: (id: string, global: boolean) => Promise<void>;
  /** The OAuth 2 credential whose sign-in is open in the browser. */
  connecting: string | null;
  connectCredential: (id: string) => Promise<boolean>;
}

export const useFlowVaultStore = create<FlowVaultState>((set, get) => {
  const reload = async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    const [variables, credentials] = await Promise.all([flowsListVariables(workspaceId), flowsListCredentials(workspaceId)]);
    if (get().workspaceId === workspaceId) set({ variables, credentials });
  };
  const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await reload();
      return true;
    } catch (error) {
      pushErrorToast(String(error));
      return false;
    }
  };
  return {
    workspaceId: null,
    variables: [],
    credentials: [],
    dialog: null,
    connecting: null,

    load: async (workspaceId) => {
      if (get().workspaceId !== workspaceId) set({ workspaceId, variables: [], credentials: [] });
      await reload().catch((error) => pushErrorToast(String(error)));
    },
    openDialog: (dialog) => set({ dialog }),
    putVariable: (name, value) => {
      const workspaceId = get().workspaceId;
      return workspaceId ? attempt(() => flowsPutVariable(workspaceId, name, value)) : Promise.resolve(false);
    },
    renameVariable: (id, name) => attempt(() => flowsRenameVariable(id, name)),
    deleteVariable: async (id) => void (await attempt(() => flowsDeleteVariable(id))),
    setVariableScope: async (id, global) => void (await attempt(() => flowsSetVariableScope(id, global))),
    createCredential: async (name, kind, meta, secret) => {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return null;
      try {
        const created = await flowsCreateCredential(workspaceId, name, kind, meta, secret);
        await reload();
        return created;
      } catch (error) {
        pushErrorToast(String(error));
        return null;
      }
    },
    updateCredential: (id, name, meta, secret) => attempt(() => flowsUpdateCredential(id, name, meta, secret)),
    deleteCredential: async (id) => void (await attempt(() => flowsDeleteCredential(id))),
    setCredentialScope: async (id, global) => void (await attempt(() => flowsSetCredentialScope(id, global))),
    connectCredential: async (id) => {
      set({ connecting: id });
      try {
        return await attempt(() => flowsOauthConnect(id));
      } finally {
        if (get().connecting === id) set({ connecting: null });
      }
    },
  };
});
