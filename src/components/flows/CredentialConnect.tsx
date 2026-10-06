import { useState } from "react";
import { CheckCircle2, CircleAlert, ExternalLink, LoaderCircle, PlugZap } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { OAUTH_SCOPES } from "../../lib/flows/oauthScopes";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * Connecting a service from the node that needs it (the user's ask, 2026-10-06: "cómo se conecta a
 * Teams… sin estar logueado, o a Linear, es rara esa parte").
 *
 * The credential model is unchanged — a token, a user and a secret, a webhook URL or an OAuth 2
 * account, kept in the keychain (`flowVaultStore`) — what changes is where it is made. A node with
 * no credential shows how this service signs in, in a sentence, where to get the token, and the one
 * or two fields that make one; "Conectar" saves it, selects it, and — when the service can say who a
 * credential is (`ConnectPlan.test`) — asks, keeping it only if the service accepts it. An account
 * (Google, Microsoft) signs in in the browser, as the credentials dialog does.
 */

export interface ConnectPlan {
  /** Who is being connected: the new credential's name, and the sign-in button's. */
  service: string;
  kind: "bearer" | "basic" | "webhook" | "oauth2";
  /** How this service signs in, in a sentence. */
  hint: string;
  /** Where a person gets the token, or registers the OAuth app. */
  tokenUrl?: string;
  userLabel?: string;
  secretLabel?: string;
  provider?: "google" | "microsoft";
  scopes?: string;
  /** Who the credential signs in as — absent when the service cannot say. */
  test?: (credentialId: string) => Promise<string>;
}

/** What a test or a connection left to show under the picker. */
export interface ConnectStatus {
  ok: boolean;
  text: string;
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** The box a node without a credential shows: how, where from, and the fields that make one. */
export function CredentialConnect({ plan, onConnected }: { plan: ConnectPlan; onConnected: (id: string, status: ConnectStatus | null) => void }) {
  const t = useT();
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** An OAuth credential already made whose sign-in did not finish — a retry signs it in again. */
  const [pending, setPending] = useState<string | null>(null);
  const oauth = plan.kind === "oauth2";
  const ready = oauth ? user.trim() !== "" || pending !== null : secret.trim() !== "" && (plan.kind !== "basic" || user.trim() !== "");

  const connect = async () => {
    setBusy(true);
    setError(null);
    const store = useFlowVaultStore.getState();
    try {
      if (oauth) {
        const provider = plan.provider ?? "microsoft";
        let id = pending;
        if (!id) {
          const meta = { provider, clientId: user.trim(), tenant: "", authUrl: "", tokenUrl: "", scopes: plan.scopes ?? OAUTH_SCOPES[provider], redirectUri: "" };
          const created = await store.createCredential(uniqueName(plan.service, store.credentials.map((c) => c.name)), "oauth2", meta, secret.trim());
          if (!created) return;
          id = created.id;
          setPending(id);
        }
        if (!(await store.connectCredential(id))) {
          setError(t("flows.connect.oauthUnfinished"));
          return;
        }
        let status: ConnectStatus | null = null;
        if (plan.test) status = await plan.test(id).then((who) => ({ ok: true, text: who }), (e: unknown) => ({ ok: false, text: String(e) }));
        onConnected(id, status ?? { ok: true, text: plan.service });
        return;
      }
      const meta: Record<string, string> = plan.kind === "basic" ? { user: user.trim() } : {};
      const created = await store.createCredential(uniqueName(plan.service, store.credentials.map((c) => c.name)), plan.kind, meta, secret.trim());
      if (!created) return;
      if (!plan.test) {
        onConnected(created.id, null);
        return;
      }
      try {
        const who = await plan.test(created.id);
        onConnected(created.id, { ok: true, text: who });
      } catch (refused) {
        // The service said no: nothing half-made stays behind, and the token is still in the field.
        await store.deleteCredential(created.id);
        setError(String(refused));
      }
    } finally {
      setBusy(false);
    }
  };

  const input = (value: string, set: (next: string) => void, placeholder: string, secretField: boolean) => (
    <input
      className={fieldClass({ size: "sm", className: `min-w-0 flex-1 ${secretField ? "font-mono text-[11.5px]" : ""}` })}
      type={secretField ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => set(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && ready && !busy) void connect();
      }}
    />
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-[var(--cf-sunken)] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.45] text-[var(--cf-text-muted)]">{plan.hint}</span>
        {plan.tokenUrl && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[var(--cf-accent)] hover:underline"
            title={plan.tokenUrl}
            onClick={() => void openExternalUrl(plan.tokenUrl ?? "").catch((e: unknown) => pushErrorToast(String(e)))}
          >
            {oauth ? t("flows.connect.registerApp") : t("flows.connect.get")}
            <ExternalLink size={11} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {oauth ? (
          <>
            {pending === null && input(user, setUser, t("flows.connect.clientId"), false)}
            {pending === null && plan.provider === "google" && input(secret, setSecret, t("flows.connect.clientSecret"), true)}
          </>
        ) : (
          <>
            {plan.kind === "basic" && input(user, setUser, plan.userLabel ?? t("flows.connect.user"), false)}
            {input(secret, setSecret, plan.kind === "webhook" ? t("flows.connect.webhook") : plan.secretLabel ?? t("flows.connect.token"), true)}
          </>
        )}
        <Button size="sm" variant="primary" disabled={!ready || busy} onClick={() => void connect()}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <PlugZap size={12} />}
          {oauth ? t("flows.connect.signIn", { service: plan.provider === "google" ? "Google" : "Microsoft" }) : t("flows.connect.connect")}
        </Button>
      </div>
      {busy && oauth && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("flows.connect.oauthPending")}</span>}
      {error && <span className="whitespace-pre-wrap break-words text-[11.5px] text-[var(--cf-danger)]">{error}</span>}
    </div>
  );
}

/** "Probar": asks the service who the chosen credential is. */
export function CredentialTestButton({ plan, credentialId, onStatus }: { plan: ConnectPlan; credentialId: string; onStatus: (status: ConnectStatus | null) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!plan.test) return null;
  const test = plan.test;
  return (
    <button
      type="button"
      className={iconButtonClass({ size: "sm" })}
      title={t("flows.connect.test")}
      aria-label={t("flows.connect.test")}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onStatus(null);
        void test(credentialId)
          .then((who) => onStatus({ ok: true, text: who }), (e: unknown) => onStatus({ ok: false, text: String(e) }))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <LoaderCircle size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
    </button>
  );
}

/** The line under the picker after a connection or a test: who it is, or what the service said. */
export function ConnectStatusLine({ status }: { status: ConnectStatus }) {
  const t = useT();
  return (
    <span className={`flex items-start gap-1.5 text-[11.5px] ${status.ok ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>
      {status.ok ? <CheckCircle2 size={12} className="mt-[2px] shrink-0" /> : <CircleAlert size={12} className="mt-[2px] shrink-0" />}
      <span className="min-w-0 whitespace-pre-wrap break-words">{status.ok ? t("flows.connect.connectedAs", { who: status.text }) : status.text}</span>
    </span>
  );
}
