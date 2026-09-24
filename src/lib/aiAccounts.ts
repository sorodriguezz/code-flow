/**
 * Several accounts per AI CLI — the frontend's half of `src-tauri/src/ai_accounts.rs`.
 *
 * An account is a folder the official CLI signs in to by itself; this app only ever says which
 * folder a run uses. The CLI's own login — `~/.claude`, `~/.codex`… — is the **system account**:
 * it has no row and no id, and is `null` wherever an account id is expected.
 *
 * A preference (a task's pin, a workspace default, an agent) is spelled three ways: `""` is
 * automatic, `"system"` is the system account on purpose, anything else is an account id.
 */

import type { TranslationKey } from "./i18n/translations";
import type { AiAccount, WorkspaceAccount } from "./tauri/accountCommands";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** The stored spelling of "the system account" where a preference has to say it explicitly. */
export const SYSTEM_ACCOUNT = "system";

/** The CLIs whose state can be pointed at another folder. Gemini's `agy` keeps one login in a
 * keychain item with a fixed name, and Cline hardcodes its path, so both are one account only. */
export const ACCOUNT_PROVIDERS = ["claude", "codex", "grok", "opencode"] as const;

export function supportsAccounts(provider: string): boolean {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(provider);
}

/** `provider` for the system account, `provider|id` for an added one — the backend's
 * `AccountEnv::key`, and the spelling the usage filter and the quota rows use. */
export function accountKey(provider: string, accountId: string | null | undefined): string {
  return accountId ? `${provider}|${accountId}` : provider;
}

/** Where a provider's default account is stored. Blank is the system account. */
export const defaultAccountKey = (provider: string) => `ai_account_default_${provider}`;

/** Where a task's own account pin is stored. Blank is automatic. */
export const taskAccountKey = (task: string) => `ai_account_${task}`;

/** Where the name the user gave a CLI's system account is stored. Blank reads "System".
 *
 * A display name and nothing more: the system account has no row to put it on (it is the CLI's
 * own login, not one this app created), and nothing resolves or stamps by it. */
export const systemLabelKey = (provider: string) => `ai_account_system_label_${provider}`;

/** Whether a settings row is one of this feature's — the family `watchSettings` listens for. The
 * backend announces account rows themselves under `ai_accounts`. */
export const isAccountSetting = (key: string) => key === "ai_accounts" || key.startsWith("ai_account_");

/** What to call an account: its label; for the CLI's own login the name the user gave it, else
 * "System"; and a marker for one that was deleted after something stamped it. */
export function accountName(
  accounts: readonly AiAccount[],
  accountId: string | null | undefined,
  t: Translate,
  systemLabel?: string | null,
): string {
  if (!accountId || accountId === SYSTEM_ACCOUNT) return systemLabel?.trim() || t("accounts.system");
  return accounts.find((account) => account.id === accountId)?.label ?? t("accounts.deleted");
}

/** `accountName` with everything but the account already bound — what `useAccountName` hands out. */
export type AccountNamer = (provider: string, accountId: string | null | undefined) => string;

/** The account a stored preference names, when it is still one of `provider`'s — otherwise `""`
 * (automatic). Mirrors the backend skipping a pin that names something gone or foreign. */
export function validPreference(accounts: readonly AiAccount[], provider: string, value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed === SYSTEM_ACCOUNT) return SYSTEM_ACCOUNT;
  return accounts.some((account) => account.id === trimmed && account.provider === provider) ? trimmed : "";
}

/**
 * The CLI's own sign-in, typed into a terminal opened *as* the account.
 *
 * The official flow on purpose — a browser page from the provider, or its device code — because the
 * login is the one thing this app must never do for the user: it would mean handling the token.
 * `binary` is the configured path from Settings › Providers when it is a plain one; a path with
 * spaces would need shell-specific quoting to run, so it falls back to the name on `PATH`.
 */
export function loginCommand(provider: string, binary?: string | null): string | null {
  const configured = binary?.trim();
  const name = (bin: string) => (configured && !/\s/.test(configured) ? configured : bin);
  switch (provider) {
    case "claude":
      return `${name("claude")} auth login`;
    case "codex":
      return `${name("codex")} login`;
    case "grok":
      return `${name("grok")} login`;
    case "opencode":
      return `${name("opencode")} auth login`;
    // Gemini has one login and switches it from inside its own TUI (`/logout`, then `/login`), so
    // what gets typed is just the program.
    case "gemini":
      return name("agy");
    default:
      return null;
  }
}

/**
 * The CLI's own sign-out, for the one CLI that has to be asked in a terminal: opencode signs out one
 * provider at a time and prompts for which. `null` for the rest, which the backend signs out
 * directly (`ai_account_logout`).
 */
export function logoutCommand(provider: string, binary?: string | null): string | null {
  if (provider !== "opencode") return null;
  const configured = binary?.trim();
  return `${configured && !/\s/.test(configured) ? configured : "opencode"} auth logout`;
}

/** Everything a resolution reads — what `aiAccountsStore` holds. */
export interface AccountPreferences {
  accounts: readonly AiAccount[];
  taskPins: Readonly<Record<string, string>>;
  workspaceDefaults: readonly WorkspaceAccount[];
  providerDefaults: Readonly<Record<string, string>>;
}

/**
 * The account an automatic run of `provider` would use — the backend's `ai_accounts::resolve`,
 * read off the store so a chip can name it without a round trip. `null` is the system account.
 *
 * Most specific first: an explicit choice, the task's pin, the workspace's default, the provider's
 * default. A step that names an account that is gone, or one of another CLI, is skipped rather than
 * obeyed — the same rule, so the chip and the run cannot disagree.
 */
export function resolveAccount(
  prefs: AccountPreferences,
  provider: string,
  task: string | null,
  workspaceId: string | null,
  explicit?: string | null,
): string | null {
  if (!supportsAccounts(provider)) return null;
  const candidates = [
    explicit,
    task ? prefs.taskPins[task] : undefined,
    workspaceId
      ? prefs.workspaceDefaults.find((row) => row.workspaceId === workspaceId && row.provider === provider)?.account
      : undefined,
    prefs.providerDefaults[provider],
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    if (value === SYSTEM_ACCOUNT) return null;
    if (prefs.accounts.some((account) => account.id === value && account.provider === provider)) return value;
  }
  return null;
}
