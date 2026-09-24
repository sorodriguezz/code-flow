/**
 * Typed wrappers for Settings › IA › Cuentas — the accounts of each AI CLI.
 *
 * Nothing here carries a credential, in either direction: an account is a folder the CLI signs in
 * to by itself, and the most the backend ever reports about it is who the CLI says it is. See
 * `src-tauri/src/ai_accounts.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

/** One account the user added. The CLI's own login — the system account — is never one of these;
 * it is `null` wherever an account id is expected. */
export interface AiAccount {
  id: string;
  provider: string;
  /** What the user called it: "Personal", "Trabajo". */
  label: string;
  createdAt: string;
}

/** One workspace's default for one provider — an account id or `"system"`. */
export interface WorkspaceAccount {
  workspaceId: string;
  provider: string;
  account: string;
}

export interface AccountsSnapshot {
  accounts: AiAccount[];
  workspaceDefaults: WorkspaceAccount[];
}

/** What an account's CLI says about its login. Read with the CLI's own status command — nothing is
 * spent and no credential is opened. */
export interface AccountStatus {
  provider: string;
  accountId: string | null;
  /** `null` when the CLI could not be asked at all — not installed, timed out. */
  signedIn: boolean | null;
  email: string;
  /** The plan or login method the CLI named: `max`, `ChatGPT`, `grok.com`… */
  plan: string;
  error: string;
  checkedAt: string;
}

export const aiAccountsList = () => invoke<AccountsSnapshot>("ai_accounts_list");

/** Adds an account and prepares its folder. `copyConfig` gives it a copy of the user's settings,
 * instructions and MCP servers — never the login. */
export const aiAccountCreate = (provider: string, label: string, copyConfig: boolean) =>
  invoke<AiAccount>("ai_account_create", { provider, label, copyConfig });

export const aiAccountRename = (id: string, label: string) => invoke<void>("ai_account_rename", { id, label });

/** Signs the account's CLI out, forgets it and removes its folder. */
export const aiAccountDelete = (id: string) => invoke<void>("ai_account_delete", { id });

/** `accountId = null` asks about the system account. */
export const aiAccountStatus = (provider: string, accountId: string | null) =>
  invoke<AccountStatus>("ai_account_status", { provider, accountId });

/** Signs the account's CLI out and keeps the account. `accountId = null` is the system account —
 *  the same login the user's terminal uses, so it is signed out there too. Not for opencode, which
 *  asks which provider to sign out of: that one runs in a terminal (see `logoutCommand`). */
export const aiAccountLogout = (provider: string, accountId: string | null) =>
  invoke<void>("ai_account_logout", { provider, accountId });

/** `account` is an id, `"system"`, or `""` to go back to the provider's default. */
export const aiAccountSetWorkspaceDefault = (workspaceId: string, provider: string, account: string) =>
  invoke<void>("ai_account_set_workspace_default", { workspaceId, provider, account });

/** The account an automatic run would use right now — `null` is the system account. */
export const aiAccountResolve = (provider: string, task?: string | null, workspaceId?: string | null) =>
  invoke<string | null>("ai_account_resolve", { provider, task: task ?? null, workspaceId: workspaceId ?? null });
