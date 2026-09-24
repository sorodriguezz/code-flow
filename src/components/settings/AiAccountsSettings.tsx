import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, LogOut, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useAccountName, useAiAccountsStore, useProviderAccounts } from "../../state/aiAccountsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { getSetting } from "../../lib/tauri/commands";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { ACCOUNT_PROVIDERS, SYSTEM_ACCOUNT, accountKey, loginCommand, logoutCommand } from "../../lib/aiAccounts";
import type { AccountStatus, AiAccount } from "../../lib/tauri/accountCommands";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { AccountTerminalDialog } from "../ai/AccountTerminalDialog";
import { Checkbox } from "../common/Checkbox";
import { Select, type SelectOption } from "../common/Select";
import { Tooltip } from "../common/Tooltip";

/** A shell opened as an account, with what to type into it. */
interface LoginTarget {
  provider: string;
  accountId: string | null;
  title: string;
  command: string | null;
  hint?: string;
}

/** Opens that shell. `kind` picks the CLI's command: its sign-in, or — for the one CLI that asks
 *  which provider to sign out of — its sign-out. */
type OpenTerminal = (target: Omit<LoginTarget, "command">, kind?: "login" | "logout") => void;

/** Only these two have configuration worth copying — the other two move nothing but the login. */
const COPIES_CONFIG = new Set(["claude", "codex"]);

const ICON_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]";

/**
 * Settings › IA › Cuentas: several accounts per AI CLI.
 *
 * Each account is a folder the CLI signs in to by itself — this screen never sees a password or a
 * token, only what the CLI says when asked who it is. See `src-tauri/src/ai_accounts.rs`.
 */
export function AiAccountsSettings() {
  const t = useT();
  const ensure = useAiAccountsStore((s) => s.ensure);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const [login, setLogin] = useState<LoginTarget | null>(null);
  const check = useAiAccountsStore((s) => s.check);

  useEffect(() => {
    void ensure();
  }, [ensure]);

  const openLogin = async (target: Omit<LoginTarget, "command">, kind: "login" | "logout" = "login") => {
    const binary = await getSetting(`${target.provider}_binary_path`).catch(() => null);
    const command = kind === "logout" ? logoutCommand(target.provider, binary) : loginCommand(target.provider, binary);
    setLogin({ ...target, command });
  };

  const closeLogin = () => {
    // Gemini too: switching its one login is exactly when the address on its row changes.
    if (login) void check(login.provider, login.accountId);
    setLogin(null);
  };

  return (
    <section className="space-y-3">
      {ACCOUNT_PROVIDERS.map((provider) => (
        <ProviderAccounts key={provider} provider={provider} onLogin={(target, kind) => void openLogin(target, kind)} />
      ))}

      <GeminiRow
        onSwitch={() =>
          void openLogin({
            provider: "gemini",
            accountId: null,
            title: t("accounts.geminiSwitch"),
            hint: t("accounts.geminiSwitchHint"),
          })
        }
      />

      {accounts.length > 0 && <WorkspaceDefaults />}

      {login && (
        <AccountTerminalDialog
          title={login.title}
          provider={login.provider}
          accountId={login.accountId}
          command={login.command}
          hint={login.hint}
          onClose={closeLogin}
        />
      )}
    </section>
  );
}

function ProviderAccounts({ provider, onLogin }: { provider: string; onLogin: OpenTerminal }) {
  const t = useT();
  const accounts = useProviderAccounts(provider);
  const create = useAiAccountsStore((s) => s.create);
  const defaultValue = useAiAccountsStore((s) => s.providerDefaults[provider] ?? "");
  const setProviderDefault = useAiAccountsStore((s) => s.setProviderDefault);
  const check = useAiAccountsStore((s) => s.check);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [copyConfig, setCopyConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const name = providerDisplayLabel(provider, t);
  const nameOf = useAccountName();

  // Each account asked once per visit — including ones that arrive after the first render, since
  // the list loads alongside. Opening this pane is the deliberate act, and every status command is
  // a local read that spends nothing.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const id of [null, ...accounts.map((account) => account.id)]) {
      const key = accountKey(provider, id);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      void check(provider, id);
    }
  }, [accounts, provider, check]);

  const submit = async () => {
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const account = await create(provider, trimmed, COPIES_CONFIG.has(provider) && copyConfig);
      setAdding(false);
      setLabel("");
      onLogin({ provider, accountId: account.id, title: t("accounts.loginTitle", { provider: name, account: account.label }) });
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const defaultOptions: SelectOption[] = [
    { value: "", label: nameOf(provider, null) },
    ...accounts.map((account) => ({ value: account.id, label: account.label })),
  ];

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <ProviderGlyph providerId={provider} size={14} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{name}</span>
        {accounts.length > 0 && (
          <Tooltip label={t("accounts.defaultLabel")} description={t("accounts.defaultHint")}>
            {/* Named on screen, not only in the tooltip: a bare select in a card's header read as
                the card's own title rather than as a choice. */}
            <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("accounts.defaultShort")}</span>
          </Tooltip>
        )}
        {accounts.length > 0 && (
          <Tooltip label={t("accounts.defaultLabel")} description={t("accounts.defaultHint")}>
            {/* Sized from outside: the trigger is `w-full` by design. */}
            <div className="w-[150px] shrink-0">
              <Select
                size="sm"
                ariaLabel={t("accounts.defaultLabel")}
                value={accounts.some((a) => a.id === defaultValue) ? defaultValue : ""}
                onChange={(value) => void setProviderDefault(provider, value)}
                options={defaultOptions}
              />
            </div>
          </Tooltip>
        )}
      </div>

      <div className="space-y-0.5">
        <AccountRow provider={provider} account={null} onLogin={onLogin} />
        {accounts.map((account) => (
          <AccountRow key={account.id} provider={provider} account={account} onLogin={onLogin} />
        ))}
      </div>

      {adding ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={label}
            spellCheck={false}
            placeholder={t("accounts.namePlaceholder")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setAdding(false);
            }}
            className="min-w-[140px] flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-[var(--cf-accent)]"
          />
          {COPIES_CONFIG.has(provider) && (
            <Tooltip label={t("accounts.copyConfig")} description={t("accounts.copyConfigHint")}>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                <Checkbox checked={copyConfig} onChange={setCopyConfig} />
                {t("accounts.copyConfig")}
              </label>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!label.trim() || busy}
            className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {t("accounts.addAndLogin")}
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
        >
          <Plus size={12} />
          {t("accounts.add")}
        </button>
      )}
    </div>
  );
}

function AccountRow({
  provider,
  account,
  onLogin,
}: {
  provider: string;
  /** `null` is the system account. */
  account: AiAccount | null;
  onLogin: OpenTerminal;
}) {
  const t = useT();
  const key = accountKey(provider, account?.id);
  const status = useAiAccountsStore((s) => s.statuses[key]);
  const checking = useAiAccountsStore((s) => Boolean(s.checking[key]));
  const check = useAiAccountsStore((s) => s.check);
  const rename = useAiAccountsStore((s) => s.rename);
  const renameSystem = useAiAccountsStore((s) => s.renameSystem);
  const remove = useAiAccountsStore((s) => s.remove);
  const logout = useAiAccountsStore((s) => s.logout);
  const nameOf = useAccountName();
  const label = nameOf(provider, account?.id);
  const providerName = providerDisplayLabel(provider, t);

  // The system account can be named like any other — it is only a display name, since the account
  // itself is the CLI's own login and has no row here — but never removed: that would sign the
  // user's own terminal out.
  const onRename = async () => {
    const next = await promptAction(t("accounts.renamePrompt"), {
      initial: label,
      confirmLabel: t("accounts.rename"),
    });
    if (!next || next === label) return;
    const done = account ? rename(account.id, next) : renameSystem(provider, next);
    await done.catch((e) => pushErrorToast(String(e)));
  };

  // Signing out keeps the account — the key beside it signs in again. The system account's login is
  // the one the user's own terminal uses, so the question says so before it is signed out there too.
  const onLogout = async () => {
    const target = { provider, accountId: account?.id ?? null, title: t("accounts.loginTitle", { provider: providerName, account: label }) };
    if (logoutCommand(provider)) {
      onLogin(target, "logout");
      return;
    }
    const ok = await confirmAction(
      t(account ? "accounts.logoutConfirm" : "accounts.logoutSystemConfirm", { provider: providerName, account: label }),
      false,
      t("accounts.logout"),
    );
    if (ok) await logout(provider, account?.id ?? null).catch((e) => pushErrorToast(String(e)));
  };

  const onDelete = async () => {
    if (!account) return;
    const ok = await confirmAction(t("accounts.deleteConfirm", { account: account.label, provider: providerName }));
    if (ok) await remove(account.id).catch((e) => pushErrorToast(String(e)));
  };

  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-black/[0.025] dark:hover:bg-white/[0.03]">
      <StatusDot status={status} checking={checking} />
      <Tooltip label={label} description={account ? undefined : t("accounts.systemHint")}>
        <span className="w-[110px] shrink-0 truncate text-[12px] text-[var(--cf-text)]">{label}</span>
      </Tooltip>
      {/* The whole line on hover: an address and a plan, or opencode's list of logins with theirs,
          outgrow the row's width. */}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={statusLine(status, checking, t)}>
        {statusLine(status, checking, t)}
      </span>
      <Tooltip label={t("accounts.check")}>
        <button
          type="button"
          aria-label={t("accounts.check")}
          disabled={checking}
          onClick={() => void check(provider, account?.id ?? null)}
          className={ICON_BUTTON}
        >
          <RefreshCw size={12} className={checking ? "animate-spin" : undefined} />
        </button>
      </Tooltip>
      <Tooltip label={t("accounts.login")} description={t("accounts.loginHint")}>
        <button
          type="button"
          aria-label={t("accounts.login")}
          onClick={() =>
            onLogin({
              provider,
              accountId: account?.id ?? null,
              title: t("accounts.loginTitle", { provider: providerName, account: label }),
            })
          }
          className={ICON_BUTTON}
        >
          <KeyRound size={12} />
        </button>
      </Tooltip>
      {status?.signedIn ? (
        <Tooltip label={t("accounts.logout")} description={account ? undefined : t("accounts.logoutSystemHint")}>
          <button type="button" aria-label={t("accounts.logout")} onClick={() => void onLogout()} className={ICON_BUTTON}>
            <LogOut size={12} />
          </button>
        </Tooltip>
      ) : (
        // Only offered while signed in; the gap keeps every row's icons in the same columns.
        <span aria-hidden className="h-6 w-6 shrink-0" />
      )}
      <Tooltip label={t("accounts.rename")}>
        <button type="button" aria-label={t("accounts.rename")} onClick={() => void onRename()} className={ICON_BUTTON}>
          <Pencil size={12} />
        </button>
      </Tooltip>
      {account ? (
        <Tooltip label={t("accounts.delete")} description={t("accounts.deleteHint")}>
          <button type="button" aria-label={t("accounts.delete")} onClick={() => void onDelete()} className={ICON_BUTTON}>
            <Trash2 size={12} />
          </button>
        </Tooltip>
      ) : (
        // Holds the column so the icons of every row line up.
        <span aria-hidden className="h-6 w-6 shrink-0" />
      )}
    </div>
  );
}

function StatusDot({ status, checking }: { status: AccountStatus | undefined; checking: boolean }) {
  const colour =
    checking || !status
      ? "var(--cf-border)"
      : status.signedIn
        ? "var(--cf-success)"
        : status.signedIn === false
          ? "var(--cf-warning)"
          : "var(--cf-text-muted)";
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />;
}

function statusLine(status: AccountStatus | undefined, checking: boolean, t: ReturnType<typeof useT>): string {
  if (!status) return checking ? t("accounts.checking") : "";
  if (status.signedIn) {
    const who = [status.email, status.plan].filter(Boolean).join(" · ");
    return who || t("accounts.signedIn");
  }
  if (status.signedIn === false) return t("accounts.signedOut");
  if (status.error === "not_installed") return t("accounts.notInstalled");
  return t("accounts.unknown");
}

/** Gemini keeps one login in a keychain item with a fixed name — no second account can exist
 * beside it, so the most this can do is say who it is signed in as and make switching it quick. The
 * address comes from the file agy writes beside that login (see `ai_accounts::probe`); agy publishes
 * no plan anywhere this can read, so none is shown. */
function GeminiRow({ onSwitch }: { onSwitch: () => void }) {
  const t = useT();
  const check = useAiAccountsStore((s) => s.check);
  const status = useAiAccountsStore((s) => s.statuses[accountKey("gemini", null)]);
  const checking = useAiAccountsStore((s) => Boolean(s.checking[accountKey("gemini", null)]));
  useEffect(() => {
    void check("gemini", null);
  }, [check]);
  const who = statusLine(status, checking, t);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
      <ProviderGlyph providerId="gemini" size={14} />
      <span className="text-[12.5px] font-medium text-[var(--cf-text)]">{providerDisplayLabel("gemini", t)}</span>
      <StatusDot status={status} checking={checking} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={who}>
        {who}
      </span>
      <Tooltip label={t("accounts.geminiSingle")} description={t("accounts.geminiSingleHint")}>
        <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{t("accounts.geminiSingle")}</span>
      </Tooltip>
      <button
        type="button"
        onClick={onSwitch}
        className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <KeyRound size={12} />
        {t("accounts.geminiSwitch")}
      </button>
    </div>
  );
}

/** Which account each workspace uses, per provider — the step between a task's pin and the
 * provider's default. Only providers that have an added account get a column: with one account
 * there is nothing to choose.
 *
 * Shown only once there is more than one workspace to tell apart. With a single one it duplicates
 * the default above it, and a second control saying the same thing read as a mystery rather than as
 * a choice. A default already stored keeps it on screen, so what is routing a run is never hidden. */
function WorkspaceDefaults() {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const defaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const setWorkspaceDefault = useAiAccountsStore((s) => s.setWorkspaceDefault);
  const nameOf = useAccountName();
  const providers = useMemo(
    () => ACCOUNT_PROVIDERS.filter((provider) => accounts.some((account) => account.provider === provider)),
    [accounts],
  );
  if (providers.length === 0) return null;
  if (workspaces.length < 2 && defaults.length === 0) return null;

  const optionsFor = (provider: string): SelectOption[] => {
    // "Inherit" says what it inherits — the provider's default, by name — so the row reads as an
    // answer instead of as a pointer to somewhere else on the screen.
    const fallback = providerDefaults[provider];
    const inherited = accounts.some((a) => a.id === fallback && a.provider === provider) ? fallback : null;
    return [
      { value: "", label: t("accounts.inheritNamed", { account: nameOf(provider, inherited) }) },
      { value: SYSTEM_ACCOUNT, label: nameOf(provider, null) },
      ...accounts.filter((a) => a.provider === provider).map((a) => ({ value: a.id, label: a.label })),
    ];
  };

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-2.5">
      <Tooltip label={t("accounts.byWorkspace")} description={t("accounts.byWorkspaceHint")}>
        <p className="mb-1.5 text-[12.5px] font-medium text-[var(--cf-text)]">{t("accounts.byWorkspace")}</p>
      </Tooltip>
      <div className="space-y-1">
        {workspaces.map((workspace) => (
          <div key={workspace.id} className="flex flex-wrap items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: workspace.color }} />
            <span className="w-[120px] shrink-0 truncate text-[12px] text-[var(--cf-text)]" title={workspace.name}>
              {workspace.name}
            </span>
            {providers.map((provider) => {
              const stored =
                defaults.find((row) => row.workspaceId === workspace.id && row.provider === provider)?.account ?? "";
              return (
                <div key={provider} className="flex w-[240px] items-center gap-1">
                  <ProviderGlyph providerId={provider} size={12} />
                  <div className="min-w-0 flex-1">
                    <Select
                      size="sm"
                      ariaLabel={`${workspace.name} · ${providerDisplayLabel(provider, t)}`}
                      value={optionsFor(provider).some((option) => option.value === stored) ? stored : ""}
                      onChange={(value) =>
                        void setWorkspaceDefault(workspace.id, provider, value).catch((e) => pushErrorToast(String(e)))
                      }
                      options={optionsFor(provider)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
