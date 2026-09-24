import { create } from "zustand";
import { useCallback, useMemo } from "react";
import {
  aiAccountCreate,
  aiAccountDelete,
  aiAccountLogout,
  aiAccountRename,
  aiAccountSetWorkspaceDefault,
  aiAccountStatus,
  aiAccountsList,
  type AccountStatus,
  type AiAccount,
  type WorkspaceAccount,
} from "../lib/tauri/accountCommands";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import { AI_TASKS } from "../lib/aiTasks";
import {
  ACCOUNT_PROVIDERS,
  accountKey,
  accountName,
  defaultAccountKey,
  isAccountSetting,
  systemLabelKey,
  taskAccountKey,
  type AccountNamer,
} from "../lib/aiAccounts";
import { useT } from "./languageStore";

/**
 * The accounts of each AI CLI, and every preference that picks one. See `lib/aiAccounts.ts`.
 *
 * Loaded on first use rather than at boot: most installs never add an account, and nothing on the
 * first screen needs to know. Every surface that offers an account calls `ensure` on mount.
 */
interface AiAccountsState {
  accounts: AiAccount[];
  workspaceDefaults: WorkspaceAccount[];
  /** provider → `""` (system) or an account id. */
  providerDefaults: Record<string, string>;
  /** task → `""` (automatic), `"system"` or an account id. */
  taskPins: Record<string, string>;
  /** provider → the name the user gave its system account; `""` reads "System". */
  systemLabels: Record<string, string>;
  loaded: boolean;
  /** What each account's CLI last said about its login, by `accountKey`. */
  statuses: Record<string, AccountStatus>;
  /** Accounts being asked right now, by `accountKey`. */
  checking: Record<string, boolean>;
  ensure: () => Promise<void>;
  load: () => Promise<void>;
  create: (provider: string, label: string, copyConfig: boolean) => Promise<AiAccount>;
  rename: (id: string, label: string) => Promise<void>;
  /** Names a CLI's system account. Blank goes back to "System". */
  renameSystem: (provider: string, label: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setProviderDefault: (provider: string, value: string) => Promise<void>;
  setTaskPin: (task: string, value: string) => Promise<void>;
  setWorkspaceDefault: (workspaceId: string, provider: string, value: string) => Promise<void>;
  /** Asks the account's CLI who it is signed in as. Spends nothing. */
  check: (provider: string, accountId: string | null) => Promise<AccountStatus | null>;
  /** Signs the account's CLI out, keeps the account, and re-reads who it is signed in as. */
  logout: (provider: string, accountId: string | null) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useAiAccountsStore = create<AiAccountsState>((set, get) => ({
  accounts: [],
  workspaceDefaults: [],
  providerDefaults: {},
  taskPins: {},
  systemLabels: {},
  loaded: false,
  statuses: {},
  checking: {},

  ensure: async () => {
    if (get().loaded) return;
    await get().load();
  },

  load: async () => {
    if (loading) return loading;
    loading = (async () => {
      const keys = [
        ...ACCOUNT_PROVIDERS.map(defaultAccountKey),
        ...ACCOUNT_PROVIDERS.map(systemLabelKey),
        ...AI_TASKS.map(({ key }) => taskAccountKey(key)),
      ];
      const [snapshot, stored] = await Promise.all([
        aiAccountsList().catch(() => null),
        getSettings(keys).catch(() => ({}) as Record<string, string>),
      ]);
      const providerDefaults: Record<string, string> = {};
      for (const provider of ACCOUNT_PROVIDERS) providerDefaults[provider] = stored[defaultAccountKey(provider)]?.trim() ?? "";
      const taskPins: Record<string, string> = {};
      for (const { key } of AI_TASKS) taskPins[key] = stored[taskAccountKey(key)]?.trim() ?? "";
      const systemLabels: Record<string, string> = {};
      for (const provider of ACCOUNT_PROVIDERS) systemLabels[provider] = stored[systemLabelKey(provider)]?.trim() ?? "";
      set({
        accounts: snapshot?.accounts ?? get().accounts,
        workspaceDefaults: snapshot?.workspaceDefaults ?? get().workspaceDefaults,
        providerDefaults,
        taskPins,
        systemLabels,
        loaded: true,
      });
    })().finally(() => {
      loading = null;
    });
    return loading;
  },

  create: async (provider, label, copyConfig) => {
    const account = await aiAccountCreate(provider, label, copyConfig);
    set((s) => ({ accounts: [...s.accounts, account] }));
    return account;
  },

  rename: async (id, label) => {
    await aiAccountRename(id, label);
    set((s) => ({ accounts: s.accounts.map((account) => (account.id === id ? { ...account, label } : account)) }));
  },

  renameSystem: async (provider, label) => {
    const trimmed = label.trim();
    set((s) => ({ systemLabels: { ...s.systemLabels, [provider]: trimmed } }));
    await setSetting(systemLabelKey(provider), trimmed);
  },

  remove: async (id) => {
    await aiAccountDelete(id);
    // Re-read rather than patched: the backend also cleared every preference that named it.
    await get().load();
  },

  setProviderDefault: async (provider, value) => {
    set((s) => ({ providerDefaults: { ...s.providerDefaults, [provider]: value } }));
    await setSetting(defaultAccountKey(provider), value);
  },

  setTaskPin: async (task, value) => {
    set((s) => ({ taskPins: { ...s.taskPins, [task]: value } }));
    await setSetting(taskAccountKey(task), value);
  },

  setWorkspaceDefault: async (workspaceId, provider, value) => {
    set((s) => {
      const rest = s.workspaceDefaults.filter((row) => !(row.workspaceId === workspaceId && row.provider === provider));
      return { workspaceDefaults: value ? [...rest, { workspaceId, provider, account: value }] : rest };
    });
    await aiAccountSetWorkspaceDefault(workspaceId, provider, value);
  },

  logout: async (provider, accountId) => {
    try {
      await aiAccountLogout(provider, accountId);
    } finally {
      // Whatever the CLI answered, the row shows what is true now rather than what was true before.
      await get().check(provider, accountId);
    }
  },

  check: async (provider, accountId) => {
    const key = accountKey(provider, accountId);
    set((s) => ({ checking: { ...s.checking, [key]: true } }));
    try {
      const status = await aiAccountStatus(provider, accountId);
      set((s) => ({ statuses: { ...s.statuses, [key]: status } }));
      return status;
    } catch {
      return null;
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.checking;
        return { checking: rest };
      });
    }
  },
}));

/** Names any account of any provider — the system one by the name the user gave it. */
export function useAccountName(): AccountNamer {
  const t = useT();
  const accounts = useAiAccountsStore((s) => s.accounts);
  const systemLabels = useAiAccountsStore((s) => s.systemLabels);
  return useCallback(
    (provider, accountId) => accountName(accounts, accountId, t, systemLabels[provider]),
    [accounts, systemLabels, t],
  );
}

/** One provider's added accounts, in the order they were added. */
export function useProviderAccounts(provider: string | null | undefined): AiAccount[] {
  const accounts = useAiAccountsStore((s) => s.accounts);
  return useMemo(() => (provider ? accounts.filter((account) => account.provider === provider) : []), [accounts, provider]);
}

// Accounts are added and routed in Settings (main window only), and a detached chat or Agents
// window picks among them. Re-read only once something has loaded them — a window that never
// showed an account has nothing to refresh.
watchSettings(isAccountSetting, () => {
  if (useAiAccountsStore.getState().loaded) return useAiAccountsStore.getState().load();
});
