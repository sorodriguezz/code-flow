import { useEffect, useState } from "react";
import { FlaskConical, Globe, KeyRound, Pencil, Plug, Plus, Trash2, Variable } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button, iconButtonClass } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { flowsTestCredential, type FlowCredential, type FlowCredentialKind } from "../../lib/tauri/flowsCommands";
import { keyvaultGetItem } from "../../lib/tauri/keyvaultCommands";
import { VaultItemPicker } from "./AppFields";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { VaultSecret } from "../../types/vault";
import { chooseAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * The workspace's `$vars` and its credentials, in one dialog with two tabs.
 *
 * A variable is plain text everybody may read — an API's base URL, a region. A credential is a
 * secret a node sends (a token, a password): it is typed here once, goes to the operating system's
 * keychain, and is never shown again — editing one means replacing it.
 */

const KINDS: FlowCredentialKind[] = ["bearer", "basic", "header", "query", "oauth2", "hmac", "smtp", "imap", "aws", "webhook"];

const OAUTH_PROVIDERS = ["google", "microsoft", "custom"] as const;

/** What a new credential asks for, per provider — everything the Google and Microsoft nodes and
 *  Graph calls need; a person narrows it before connecting. */
const OAUTH_SCOPES: Record<string, string> = {
  google:
    "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive",
  microsoft: "openid email offline_access User.Read Mail.Send Mail.Read Calendars.ReadWrite Files.ReadWrite",
  custom: "",
};

function VariablesTab() {
  const t = useT();
  const variables = useFlowVaultStore((s) => s.variables);
  const workspaceId = useFlowVaultStore((s) => s.workspaceId);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; value: string } | null>(null);
  const store = useFlowVaultStore.getState;

  const add = async () => {
    if (!name.trim()) return;
    if (await store().putVariable(name.trim(), value)) {
      setName("");
      setValue("");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-2">
        <input className={fieldClass({ size: "sm", className: "font-mono" })} placeholder="API_BASE" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className={fieldClass({ size: "sm" })}
          placeholder={t("flows.vault.value")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <Button size="sm" onClick={() => void add()} disabled={!name.trim()}>
          <Plus size={12} />
          {t("flows.vault.add")}
        </Button>
      </div>
      <div className="flex flex-col">
        {variables.length === 0 && <p className="py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.vault.noVariables")}</p>}
        {variables.map((variable) =>
          editing?.id === variable.id ? (
            <div key={variable.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-2 py-1">
              <input className={fieldClass({ size: "sm", className: "font-mono" })} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input className={fieldClass({ size: "sm" })} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
              <span className="flex gap-1">
                <Button size="sm" onClick={() => setEditing(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    if (editing.name.trim() !== variable.name && !(await store().renameVariable(variable.id, editing.name.trim()))) return;
                    if (await store().putVariable(editing.name.trim(), editing.value)) setEditing(null);
                  }}
                >
                  {t("common.save")}
                </Button>
              </span>
            </div>
          ) : (
            <div key={variable.id} className="group flex min-h-[30px] items-center gap-2 border-b border-[var(--cf-border)] py-1 last:border-b-0">
              <code className="w-[38%] min-w-0 truncate text-[12px] text-[var(--cf-text)]">$vars.{variable.name}</code>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--cf-text-muted)]">{variable.value}</span>
              {variable.scope === "global" && (
                <span title={variable.workspaceId === workspaceId ? t("flows.vault.globalHere") : t("flows.vault.globalElsewhere")}>
                  <Globe size={12} className="text-[var(--cf-text-faint)]" />
                </span>
              )}
              <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className={iconButtonClass({ size: "xs" })}
                  title={variable.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
                  aria-label={variable.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
                  onClick={() => void store().setVariableScope(variable.id, variable.scope !== "global")}
                >
                  <Globe size={12} />
                </button>
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.edit")} aria-label={t("common.edit")} onClick={() => setEditing({ id: variable.id, name: variable.name, value: variable.value })}>
                  <Pencil size={12} />
                </button>
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.delete")} aria-label={t("common.delete")} onClick={() => void store().deleteVariable(variable.id)}>
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface CredentialDraft {
  id: string | null;
  name: string;
  kind: FlowCredentialKind;
  user: string;
  field: string;
  secret: string;
  host: string;
  port: string;
  security: string;
  from: string;
  provider: string;
  clientId: string;
  tenant: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  redirectUri: string;
  region: string;
}

const blankCredential = (): CredentialDraft => ({
  id: null,
  name: "",
  kind: "bearer",
  user: "",
  field: "",
  secret: "",
  host: "",
  port: "",
  security: "starttls",
  from: "",
  provider: "google",
  clientId: "",
  tenant: "",
  authUrl: "",
  tokenUrl: "",
  scopes: OAUTH_SCOPES.google,
  redirectUri: "",
  region: "",
});

/** What a credential row keeps besides its secret, by kind — the backend drops anything else. */
function metaOf(draft: CredentialDraft): Record<string, string> {
  switch (draft.kind) {
    case "basic":
      return { user: draft.user };
    case "header":
    case "query":
      return { name: draft.field };
    case "smtp":
      return { host: draft.host, port: draft.port, user: draft.user, security: draft.security, from: draft.from };
    case "imap":
      return { host: draft.host, port: draft.port, user: draft.user, security: draft.security };
    case "aws":
      return { user: draft.user, region: draft.region };
    case "oauth2":
      return {
        provider: draft.provider,
        clientId: draft.clientId,
        tenant: draft.tenant,
        authUrl: draft.authUrl,
        tokenUrl: draft.tokenUrl,
        scopes: draft.scopes,
        redirectUri: draft.redirectUri,
      };
    default:
      return {};
  }
}

/** Tries a saved credential: an SMTP account signs in; an HTTP one is sent to a URL; a webhook is
 *  asked about itself. */
function CredentialTest({ credential }: { credential: FlowCredential }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const needsUrl = ["bearer", "basic", "header", "query"].includes(credential.kind);
  const run = async () => {
    setBusy(true);
    try {
      setAnswer({ ok: true, text: await flowsTestCredential(credential.id, needsUrl ? url : undefined) });
    } catch (error) {
      setAnswer({ ok: false, text: String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-[var(--cf-sunken)] p-2">
      <div className="flex items-center gap-1.5">
        {needsUrl && (
          <input
            className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
            placeholder="https://api.example.com/me"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
        )}
        <Button size="sm" onClick={() => void run()} disabled={busy || (needsUrl && !url.trim())}>
          <FlaskConical size={12} />
          {t("flows.vault.test")}
        </Button>
      </div>
      {answer && <span className={`text-[11.5px] ${answer.ok ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>{answer.text}</span>}
    </div>
  );
}

function CredentialsTab() {
  const t = useT();
  const credentials = useFlowVaultStore((s) => s.credentials);
  const connecting = useFlowVaultStore((s) => s.connecting);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const store = useFlowVaultStore.getState;

  const [testing, setTesting] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  const edit = (credential: FlowCredential) =>
    setDraft({
      ...blankCredential(),
      id: credential.id,
      name: credential.name,
      kind: credential.kind,
      user: credential.meta.user ?? "",
      field: credential.meta.name ?? "",
      host: credential.meta.host ?? "",
      port: credential.meta.port ?? "",
      security: credential.meta.security ?? "starttls",
      from: credential.meta.from ?? "",
      provider: credential.meta.provider ?? "google",
      clientId: credential.meta.clientId ?? "",
      tenant: credential.meta.tenant ?? "",
      authUrl: credential.meta.authUrl ?? "",
      tokenUrl: credential.meta.tokenUrl ?? "",
      scopes: credential.meta.scopes ?? "",
      redirectUri: credential.meta.redirectUri ?? "",
      region: credential.meta.region ?? "",
    });

  /** Takes the secret (and the user, where there is one) from a Llavero item. */
  const fillFrom = async (itemId: string) => {
    setFilling(false);
    if (!draft || !itemId) return;
    try {
      const item = await keyvaultGetItem(itemId);
      if (!item) return;
      const pick = (...names: (keyof Omit<VaultSecret, "custom">)[]) => names.map((name) => item.secret[name]).find((v) => !!v) ?? "";
      setDraft({
        ...draft,
        secret: (draft.kind === "aws" ? pick("secretAccessKey") : "") || pick("password", "apiKey", "token", "secretAccessKey", "privateKey") || draft.secret,
        user: (draft.kind === "aws" ? pick("accessKeyId") : pick("username")) || draft.user,
        host: draft.kind === "smtp" || draft.kind === "imap" ? pick("host") || draft.host : draft.host,
        port: draft.kind === "smtp" || draft.kind === "imap" ? pick("port") || draft.port : draft.port,
        region: draft.kind === "aws" ? pick("region") || draft.region : draft.region,
        name: draft.name || item.title,
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const save = async () => {
    if (!draft) return;
    const meta = metaOf(draft);
    if (draft.id) {
      if (await store().updateCredential(draft.id, draft.name, meta, draft.secret || null)) setDraft(null);
      return;
    }
    const created = await store().createCredential(draft.name, draft.kind, meta, draft.secret);
    if (!created) return;
    setDraft(null);
    // A new OAuth 2 credential is no use until it signs in, so it does straight away.
    if (created.kind === "oauth2") void store().connectCredential(created.id);
  };

  if (draft) {
    const secretLabel =
      draft.kind === "basic" || draft.kind === "smtp" || draft.kind === "imap"
        ? t("flows.vault.password")
        : draft.kind === "aws"
          ? t("flows.vault.awsSecret")
        : draft.kind === "bearer"
          ? t("flows.vault.token")
          : draft.kind === "hmac"
            ? t("flows.vault.signingSecret")
            : draft.kind === "webhook"
              ? t("flows.vault.webhookUrl")
              : draft.kind === "oauth2"
                ? t("flows.vault.clientSecret")
                : t("flows.vault.value");
    const setProvider = (provider: string) =>
      setDraft({ ...draft, provider, scopes: !draft.scopes.trim() || Object.values(OAUTH_SCOPES).includes(draft.scopes) ? OAUTH_SCOPES[provider] : draft.scopes });
    return (
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.name")}</span>
          <input autoFocus className={fieldClass({ size: "sm" })} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("flows.vault.namePlaceholder")} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.kind")}</span>
          <div className="max-w-[260px]">
            <Select
              value={draft.kind}
              disabled={draft.id !== null}
              onChange={(kind) => setDraft({ ...draft, kind: kind as FlowCredentialKind, security: kind === "imap" ? "tls" : kind === "smtp" ? "starttls" : draft.security })}
              options={KINDS.map((kind) => ({ value: kind, label: t(`flows.cred.${kind}` as TranslationKey) }))}
              size="sm"
            />
          </div>
        </div>
        {(draft.kind === "smtp" || draft.kind === "imap") && (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{draft.kind === "imap" ? t("flows.vault.imapHost") : t("flows.vault.smtpHost")}</span>
                <input
                  className={fieldClass({ size: "sm", className: "font-mono" })}
                  value={draft.host}
                  placeholder={draft.kind === "imap" ? "imap.example.com" : "smtp.example.com"}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.smtpPort")}</span>
                <input
                  className={fieldClass({ size: "sm", className: "font-mono" })}
                  value={draft.port}
                  placeholder={draft.kind === "imap" ? (draft.security === "tls" ? "993" : "143") : "587"}
                  onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                />
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.smtpSecurity")}</span>
              <div className="max-w-[260px]">
                <Select
                  value={draft.security}
                  onChange={(security) => setDraft({ ...draft, security })}
                  options={(draft.kind === "imap" ? ["tls", "starttls", "none"] : ["starttls", "tls", "none"]).map((value) => ({
                    value,
                    label: t(`flows.vault.security.${value}` as TranslationKey),
                  }))}
                  size="sm"
                />
              </div>
            </div>
            {draft.kind === "smtp" && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.smtpFrom")}</span>
                <input className={fieldClass({ size: "sm" })} value={draft.from} placeholder="Flujos <flujos@example.com>" onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </label>
            )}
          </>
        )}
        {draft.kind === "aws" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.awsKeyId")}</span>
              <input className={fieldClass({ size: "sm", className: "font-mono" })} value={draft.user} placeholder="AKIA…" onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.awsRegion")}</span>
              <input className={fieldClass({ size: "sm", className: "font-mono" })} value={draft.region} placeholder="us-east-1" onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
            </label>
          </>
        )}
        {draft.kind === "oauth2" && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.provider")}</span>
              <div className="max-w-[260px]" title={t(`flows.vault.oauthHint.${draft.provider === "microsoft" || draft.provider === "custom" ? draft.provider : "google"}` as TranslationKey)}>
                <Select
                  value={draft.provider}
                  onChange={setProvider}
                  options={OAUTH_PROVIDERS.map((value) => ({ value, label: t(`flows.vault.provider.${value}` as TranslationKey) }))}
                  size="sm"
                />
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.clientId")}</span>
              <input
                className={fieldClass({ size: "sm", className: "font-mono text-[11.5px]" })}
                value={draft.clientId}
                placeholder={draft.provider === "google" ? "1234-abc.apps.googleusercontent.com" : ""}
                onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              />
            </label>
            {draft.provider === "microsoft" && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.tenant")}</span>
                <input className={fieldClass({ size: "sm", className: "font-mono text-[11.5px]" })} value={draft.tenant} placeholder="common" onChange={(e) => setDraft({ ...draft, tenant: e.target.value })} />
              </label>
            )}
            {draft.provider === "custom" && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.authUrl")}</span>
                  <input className={fieldClass({ size: "sm", className: "font-mono text-[11.5px]" })} value={draft.authUrl} placeholder="https://auth.example.com/oauth/authorize" onChange={(e) => setDraft({ ...draft, authUrl: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.tokenUrl")}</span>
                  <input className={fieldClass({ size: "sm", className: "font-mono text-[11.5px]" })} value={draft.tokenUrl} placeholder="https://auth.example.com/oauth/token" onChange={(e) => setDraft({ ...draft, tokenUrl: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-[var(--cf-text-muted)]" title={t("flows.vault.redirectUriHint")}>{t("flows.vault.redirectUri")}</span>
                  <input className={fieldClass({ size: "sm", className: "font-mono text-[11.5px]" })} value={draft.redirectUri} placeholder="http://localhost:8976/callback" onChange={(e) => setDraft({ ...draft, redirectUri: e.target.value })} />
                </label>
              </>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.scopes")}</span>
              <textarea
                rows={3}
                className={fieldClass({ size: "sm", className: "h-auto resize-y py-1.5 font-mono text-[11px]" })}
                value={draft.scopes}
                onChange={(e) => setDraft({ ...draft, scopes: e.target.value })}
              />
            </label>
          </>
        )}
        {(draft.kind === "basic" || draft.kind === "smtp" || draft.kind === "imap") && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.user")}</span>
            <input className={fieldClass({ size: "sm" })} value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
          </label>
        )}
        {(draft.kind === "header" || draft.kind === "query") && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{draft.kind === "header" ? t("flows.vault.headerName") : t("flows.vault.queryName")}</span>
            <input className={fieldClass({ size: "sm", className: "font-mono" })} value={draft.field} placeholder={draft.kind === "header" ? "X-API-Key" : "api_key"} onChange={(e) => setDraft({ ...draft, field: e.target.value })} />
          </label>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{secretLabel}</span>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              autoComplete="new-password"
              aria-label={secretLabel}
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
              value={draft.secret}
              placeholder={draft.id ? t("flows.vault.keepSecret") : ""}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            />
            <Button size="sm" onClick={() => setFilling((on) => !on)} title={t("flows.vault.fromVaultHint")}>
              <KeyRound size={12} />
              {t("flows.vault.fromVault")}
            </Button>
          </div>
          {filling && <VaultItemPicker value="" onChange={(id) => void fillFrom(String(id))} />}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void save()}
            disabled={!draft.name.trim() || (draft.kind === "oauth2" ? !draft.clientId.trim() : !draft.id && !draft.secret)}
          >
            {draft.kind === "oauth2" && !draft.id ? t("flows.vault.saveAndConnect") : t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" onClick={() => setDraft(blankCredential())}>
          <Plus size={12} />
          {t("flows.vault.newCredential")}
        </Button>
      </div>
      {credentials.length === 0 && <p className="py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.vault.noCredentials")}</p>}
      {credentials.map((credential) => (
        <div key={credential.id} className="flex flex-col gap-1 border-b border-[var(--cf-border)] py-1 last:border-b-0">
        <div className="group flex min-h-[32px] items-center gap-2">
          <KeyRound size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{credential.name}</span>
          <span className="shrink-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {credential.kind === "oauth2" && credential.meta.provider !== "custom"
              ? t(`flows.vault.provider.${credential.meta.provider === "microsoft" ? "microsoft" : "google"}` as TranslationKey)
              : t(`flows.cred.${credential.kind}` as TranslationKey)}
            {credential.kind === "oauth2"
              ? credential.meta.connected
                ? credential.meta.account
                  ? ` · ${credential.meta.account}`
                  : ""
                : ` · ${t("flows.vault.notConnected")}`
              : credential.meta.name
                ? ` · ${credential.meta.name}`
                : credential.meta.user
                  ? ` · ${credential.meta.user}`
                  : ""}
          </span>
          {credential.kind === "oauth2" && (connecting === credential.id || !credential.meta.connected) && (
            <Button size="sm" onClick={() => void store().connectCredential(credential.id)} disabled={connecting !== null}>
              <Plug size={12} />
              {connecting === credential.id ? t("flows.vault.connecting") : t("flows.vault.connect")}
            </Button>
          )}
          {credential.scope === "global" && <Globe size={12} className="shrink-0 text-[var(--cf-text-faint)]" />}
          <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
            {credential.kind === "oauth2" && credential.meta.connected && connecting !== credential.id && (
              <button
                type="button"
                className={iconButtonClass({ size: "xs" })}
                title={t("flows.vault.reconnect")}
                aria-label={t("flows.vault.reconnect")}
                disabled={connecting !== null}
                onClick={() => void store().connectCredential(credential.id)}
              >
                <Plug size={12} />
              </button>
            )}
            {credential.kind !== "hmac" && (
              <button
                type="button"
                className={iconButtonClass({ size: "xs" })}
                title={t("flows.vault.test")}
                aria-label={t("flows.vault.test")}
                onClick={() => setTesting((current) => (current === credential.id ? null : credential.id))}
              >
                <FlaskConical size={12} />
              </button>
            )}
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={credential.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
              aria-label={credential.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
              onClick={() => void store().setCredentialScope(credential.id, credential.scope !== "global")}
            >
              <Globe size={12} />
            </button>
            <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.edit")} aria-label={t("common.edit")} onClick={() => edit(credential)}>
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={() =>
                void chooseAction({
                  message: t("flows.vault.deleteCredential", { name: credential.name }),
                  danger: true,
                  choices: [{ id: "delete", label: t("common.delete"), variant: "danger" }],
                }).then((answer) => answer === "delete" && void store().deleteCredential(credential.id))
              }
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {testing === credential.id && <CredentialTest credential={credential} />}
        </div>
      ))}
    </div>
  );
}

export function FlowVaultDialog() {
  const t = useT();
  const tab = useFlowVaultStore((s) => s.dialog);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  useEffect(() => {
    if (tab && workspaceId) void useFlowVaultStore.getState().load(workspaceId);
  }, [tab, workspaceId]);
  if (!tab) return null;
  const close = () => useFlowVaultStore.getState().openDialog(null);
  return (
    <ApiModal icon={tab === "variables" ? Variable : KeyRound} title={t("flows.vault.title")} width="max-w-2xl" height="h-[520px]" onClose={close} dismissOnBackdrop={false}>
      <div className={`${underlineStripClass} h-9 px-4`}>
        {(["variables", "credentials"] as const).map((name) => (
          <button key={name} type="button" className={underlineTabClass(tab === name)} onClick={() => useFlowVaultStore.getState().openDialog(name)}>
            {t(name === "variables" ? "flows.vault.variables" : "flows.vault.credentials")}
            {tab === name && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded bg-[var(--cf-accent)]" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{tab === "variables" ? <VariablesTab /> : <CredentialsTab />}</div>
    </ApiModal>
  );
}
