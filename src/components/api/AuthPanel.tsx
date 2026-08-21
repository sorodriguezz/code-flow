import { useEffect, useMemo, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { Eye, EyeOff, KeyRound, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Select, type SelectItems } from "../common/Select";
import { Checkbox } from "../common/Checkbox";
import { VariableInput } from "./VariableInput";
import { useApiStore } from "../../state/apiStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { applyAuth, fetchOAuth2Token, isOAuth2TokenExpired, resolveEffectiveAuth } from "../../lib/api/auth";
import { resolve, type VariableContext } from "../../lib/api/variables";
import { defaultAuth } from "../../types/api";
import { confirmAction } from "../../state/confirmStore";
import { VaultPicker } from "../vault/VaultPicker";
import { authFillFrom, authFillSupported } from "../../lib/vault/fill";
import type { VaultItem, VaultSecret } from "../../types/vault";
import type { TranslationKey } from "../../lib/i18n/translations";
import type {
  ApiCollection,
  ApiFolder,
  ApiSettings,
  AuthConfig,
  AuthType,
  JwtAlgorithm,
  JwtAuth,
  NetworkOptions,
  OAuth2Auth,
  OAuth2GrantType,
} from "../../types/api";

// ---------------------------------------------------------------------------
// Secret-aware field
// ---------------------------------------------------------------------------

/**
 * One auth field.
 *
 * The `{{variable}}` highlighting is the shared `VariableInput`, not a second implementation of
 * it. What this adds is masking: a mirror layer can't colour text that renders as dots, so a
 * secret stays a plain password input until the eye is clicked and only then becomes the real
 * highlighted field. Starting masked is the point — these are credentials, and this is the panel
 * that ends up on a screen share.
 */
function AuthField({
  value,
  onChange,
  ctx,
  placeholder,
  secret = false,
  readOnly = false,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  /** `null` turns the highlighting off; the field stays an ordinary input. */
  ctx: VariableContext | null;
  placeholder?: string;
  secret?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;

  return (
    <div className="flex items-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] focus-within:border-[var(--cf-accent)]">
      {masked ? (
        <input
          type="password"
          value={value}
          disabled={readOnly}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[12px] leading-5 text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] disabled:cursor-not-allowed"
        />
      ) : (
        <VariableInput
          value={value}
          onChange={onChange}
          variableContext={ctx}
          disabled={readOnly}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          className="flex-1"
        />
      )}
      {secret && (
        <button
          type="button"
          onClick={() => setRevealed((on) => !on)}
          title={revealed ? t("api.auth.mask") : t("api.auth.reveal")}
          aria-label={revealed ? t("api.auth.mask") : t("api.auth.reveal")}
          className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <>
      <span className="pt-1.5 text-[12px] text-[var(--cf-text-muted)]">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{hint}</p>}
      </div>
    </>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(90px,150px)_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
      {children}
    </div>
  );
}

function Note({ tone = "muted", children }: { tone?: "muted" | "warning"; children: ReactNode }) {
  const color = tone === "warning" ? "var(--cf-warning)" : "var(--cf-text-muted)";
  return (
    <p className="flex items-start gap-1.5 text-[11px]" style={{ color }}>
      {tone === "warning" && <TriangleAlert size={12} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

const TYPE_ORDER: AuthType[] = [
  "inherit",
  "none",
  "basic",
  "bearer",
  "apikey",
  "digest",
  "oauth2",
  "jwt",
  "awsv4",
];

const TYPE_LABELS: Record<AuthType, TranslationKey> = {
  inherit: "api.auth.inherit",
  none: "api.auth.none",
  basic: "api.auth.basic",
  bearer: "api.auth.bearer",
  apikey: "api.auth.apikey",
  digest: "api.auth.digest",
  oauth2: "api.auth.oauth2",
  jwt: "api.auth.jwt",
  awsv4: "api.auth.awsv4",
};

const JWT_ALGORITHMS: JwtAlgorithm[] = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
];

/** Which OAuth 2 fields each grant actually uses — showing all of them for every grant is how
 * Postman's OAuth form ends up asking for a client secret in the implicit flow. */
type OAuth2Field =
  | "authUrl"
  | "accessTokenUrl"
  | "clientId"
  | "clientSecret"
  | "username"
  | "password"
  | "redirectUri"
  | "scope"
  | "state"
  | "audience"
  | "resource"
  | "clientAuth";

const GRANTS: {
  id: OAuth2GrantType;
  label: TranslationKey;
  /** `auth.ts` implements the back-channel grants only; the rest need a browser redirect. */
  supported: boolean;
  fields: OAuth2Field[];
}[] = [
  {
    id: "authorization_code",
    label: "api.auth.grant.authorizationCode",
    supported: false,
    fields: ["authUrl", "accessTokenUrl", "clientId", "clientSecret", "redirectUri", "scope", "state", "clientAuth"],
  },
  {
    id: "authorization_code_pkce",
    label: "api.auth.grant.pkce",
    supported: false,
    fields: ["authUrl", "accessTokenUrl", "clientId", "clientSecret", "redirectUri", "scope", "state", "clientAuth"],
  },
  {
    id: "client_credentials",
    label: "api.auth.grant.clientCredentials",
    supported: true,
    fields: ["accessTokenUrl", "clientId", "clientSecret", "scope", "audience", "resource", "clientAuth"],
  },
  {
    id: "password",
    label: "api.auth.grant.password",
    supported: true,
    fields: ["accessTokenUrl", "username", "password", "clientId", "clientSecret", "scope", "clientAuth"],
  },
  {
    id: "implicit",
    label: "api.auth.grant.implicit",
    supported: false,
    fields: ["authUrl", "clientId", "redirectUri", "scope", "state"],
  },
];

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AuthPanel({ tabId }: { tabId: string }) {
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId));
  const updateDraft = useApiStore((s) => s.updateDraft);
  const collections = useApiStore((s) => s.collections);
  const folders = useApiStore((s) => s.folders);

  const collectionId = tab?.collectionId ?? null;
  const folderId = tab?.folderId ?? null;

  /** The same walk `apiStore.authChainForTab` does, but keeping each level's name so the panel
   * can say *which* folder or collection the inherited config came from. */
  const ancestors = useMemo(
    () => authAncestors(folders, collections, collectionId, folderId),
    [folders, collections, collectionId, folderId],
  );

  if (!tab) return <div className="h-full" />;

  return (
    <AuthEditor
      auth={tab.draft.auth}
      onChange={(next) => updateDraft(tabId, { auth: next })}
      ancestors={ancestors}
      collectionId={collectionId}
      bufferKey={tabId}
    />
  );
}

/**
 * The auth form itself, over a plain value — a request tab's draft, or a collection's or folder's.
 *
 * `ancestors` is what everything above this level configures, innermost first; it is empty for a
 * collection, which is the top of the chain. `bufferKey` only has to be unique: it names the
 * Monaco models behind the JWT editors.
 */
export function AuthEditor({
  auth,
  onChange,
  ancestors,
  collectionId,
  bufferKey,
  types = TYPE_ORDER,
}: {
  auth: AuthConfig;
  onChange: (next: AuthConfig) => void;
  ancestors: { name: string; auth: AuthConfig | null }[];
  /** Scopes the `{{variable}}` highlighting; `null` for a request that isn't in a collection yet. */
  collectionId: string | null;
  bufferKey: string;
  /** Trimmed to drop `inherit` for a collection, which has nothing above it to inherit from. */
  types?: AuthType[];
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const variableContext = useApiStore((s) => s.variableContext);

  const ctx = useMemo(
    // `variableContext` reads the environment and collection lists out of the store itself, so
    // those belong in the dependency list even though they aren't arguments.
    () => variableContext(collectionId),
    [variableContext, collectionId, collections, environments, activeEnvironmentId],
  );

  const source = ancestors.find((entry) => entry.auth !== null && entry.auth.type !== "inherit") ?? null;
  const inherited = resolveEffectiveAuth(ancestors.map((entry) => entry.auth));

  /**
   * A keyring entry, applied to whichever auth type is on screen.
   *
   * The type itself is never changed — see `authFillFrom`. What the server expects is a fact about
   * the request, and an entry carrying both a username and an API key would otherwise get a vote
   * on it.
   */
  const applyVaultEntry = async (secret: VaultSecret, item: VaultItem) => {
    const fill = authFillFrom(auth, secret);
    const toast = useToastStore.getState().pushToast;
    if (fill.filled === 0) {
      toast(t("vault.pick.nothing", { name: item.title }), "info");
      return;
    }
    const slot = auth.type as keyof AuthConfig;
    const before = auth[slot] as unknown as Record<string, unknown>;
    const after = fill.auth[slot] as unknown as Record<string, unknown>;
    const clashes = Object.keys(after).some(
      (key) => typeof before[key] === "string" && before[key] !== "" && before[key] !== after[key],
    );
    if (clashes) {
      const replace = await confirmAction(t("vault.pick.overwrite"), false, t("vault.pick.replace"));
      if (!replace) return;
    }
    onChange(fill.auth);
    toast(
      fill.filled === 1
        ? t("vault.pick.filledOne", { name: item.title })
        : t("vault.pick.filled", { n: fill.filled, name: item.title }),
      "success",
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <Grid>
        <Row label={t("api.auth.type")}>
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              className="max-w-[240px]"
              ariaLabel={t("api.auth.type")}
              value={auth.type}
              onChange={(value) => onChange({ ...auth, type: value as AuthType })}
              options={types.map((type) => ({ value: type, label: t(TYPE_LABELS[type]) }))}
            />
            {/* Only for the types that have somewhere to put a credential. `oauth2` and `jwt` are
                left out on purpose: filling two boxes of a six-box flow looks like a finished form
                and is not one. A button that could only ever report "nothing to fill" is worse than
                no button. */}
            {authFillSupported(auth.type) && (
              <button
                type="button"
                onClick={() => setPicking(true)}
                title={t("vault.pick.action")}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                <KeyRound size={12} />
                {t("vault.pick.action")}
              </button>
            )}
          </div>
        </Row>
      </Grid>

      {picking && (
        <VaultPicker
          kinds={auth.type === "awsv4" ? ["storage", "key"] : ["login", "key"]}
          onPick={(secret, item) => void applyVaultEntry(secret, item)}
          onClose={() => setPicking(false)}
        />
      )}

      {auth.type === "inherit" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
          {source ? (
            <>
              <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
                <ShieldCheck size={13} className="text-[var(--cf-accent)]" />
                {t("api.auth.inheritedFrom", { name: source.name })}
                <span className="text-[var(--cf-text-muted)]">· {t(TYPE_LABELS[inherited.type])}</span>
              </p>
              <Note>{t("api.auth.inheritedReadOnly")}</Note>
              <AuthFields auth={inherited} onChange={() => {}} ctx={ctx} bufferKey={bufferKey} readOnly />
            </>
          ) : (
            <Note>{t("api.auth.inheritedNone")}</Note>
          )}
        </div>
      ) : (
        <AuthFields auth={auth} onChange={onChange} ctx={ctx} bufferKey={bufferKey} readOnly={false} />
      )}
    </div>
  );
}

/** Every auth type except `inherit` — for a collection, where there is nothing above to inherit. */
export const ROOT_AUTH_TYPES: AuthType[] = TYPE_ORDER.filter((type) => type !== "inherit");

/** Request → folders (innermost first) → collection, each with the name to blame it on. */
export function authAncestors(
  folders: ApiFolder[],
  collections: ApiCollection[],
  collectionId: string | null,
  folderId: string | null,
): { name: string; auth: AuthConfig | null }[] {
  const chain: { name: string; auth: AuthConfig | null }[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((entry) => entry.id === current);
    if (!folder) break;
    chain.push({ name: folder.name, auth: parseAuthBlob(folder.auth) });
    current = folder.parent_id;
  }
  const collection = collections.find((entry) => entry.id === collectionId);
  if (collection) chain.push({ name: collection.name, auth: parseAuthBlob(collection.auth) });
  return chain;
}

function parseAuthBlob(json: string): AuthConfig | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as AuthConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-type forms
// ---------------------------------------------------------------------------

function AuthFields({
  auth,
  onChange,
  ctx,
  bufferKey,
  readOnly,
}: {
  auth: AuthConfig;
  onChange: (next: AuthConfig) => void;
  ctx: VariableContext;
  bufferKey: string;
  readOnly: boolean;
}) {
  const t = useT();
  const field = (value: string, set: (next: string) => void, secret = false, placeholder?: string) => (
    <AuthField
      value={value}
      onChange={set}
      ctx={ctx}
      secret={secret}
      readOnly={readOnly}
      placeholder={placeholder}
    />
  );

  switch (auth.type) {
    case "inherit":
    case "none":
      return <Note>{t("api.auth.none")}</Note>;

    case "basic":
    case "digest": {
      const config = auth.type === "basic" ? auth.basic : auth.digest;
      const set = (patch: { username?: string; password?: string }) =>
        onChange(
          auth.type === "basic"
            ? { ...auth, basic: { ...auth.basic, ...patch } }
            : { ...auth, digest: { ...auth.digest, ...patch } },
        );
      return (
        <div className="flex flex-col gap-2">
          <Grid>
            <Row label={t("api.auth.username")}>{field(config.username, (username) => set({ username }))}</Row>
            <Row label={t("api.auth.password")}>{field(config.password, (password) => set({ password }), true)}</Row>
          </Grid>
          {auth.type === "digest" && <Note>{t("api.auth.digestAtSend")}</Note>}
        </div>
      );
    }

    case "bearer":
      return (
        <Grid>
          <Row label={t("api.auth.token")}>
            {field(auth.bearer.token, (token) => onChange({ ...auth, bearer: { token } }), true)}
          </Row>
        </Grid>
      );

    case "apikey":
      return (
        <Grid>
          <Row label={t("api.key")}>
            {field(auth.apikey.key, (key) => onChange({ ...auth, apikey: { ...auth.apikey, key } }))}
          </Row>
          <Row label={t("api.value")}>
            {field(auth.apikey.value, (value) => onChange({ ...auth, apikey: { ...auth.apikey, value } }), true)}
          </Row>
          <Row label={t("api.auth.addTo")}>
            <Select
              size="sm"
              className="max-w-[200px]"
              disabled={readOnly}
              ariaLabel={t("api.auth.addTo")}
              value={auth.apikey.addTo}
              onChange={(value) =>
                onChange({ ...auth, apikey: { ...auth.apikey, addTo: value as "header" | "query" } })
              }
              options={[
                { value: "header", label: t("api.auth.header") },
                { value: "query", label: t("api.auth.queryParams") },
              ]}
            />
          </Row>
        </Grid>
      );

    case "jwt":
      return (
        <JwtFields
          jwt={auth.jwt}
          onChange={(jwt) => onChange({ ...auth, jwt })}
          ctx={ctx}
          bufferKey={bufferKey}
          readOnly={readOnly}
        />
      );

    case "awsv4":
      return (
        <div className="flex flex-col gap-2">
          <Grid>
            <Row label={t("api.auth.accessKey")}>
              {field(auth.awsv4.accessKey, (accessKey) => onChange({ ...auth, awsv4: { ...auth.awsv4, accessKey } }))}
            </Row>
            <Row label={t("api.auth.secretKey")}>
              {field(
                auth.awsv4.secretKey,
                (secretKey) => onChange({ ...auth, awsv4: { ...auth.awsv4, secretKey } }),
                true,
              )}
            </Row>
            <Row label={t("api.auth.sessionToken")}>
              {field(
                auth.awsv4.sessionToken,
                (sessionToken) => onChange({ ...auth, awsv4: { ...auth.awsv4, sessionToken } }),
                true,
              )}
            </Row>
            <Row label={t("api.auth.region")}>
              {field(auth.awsv4.region, (region) => onChange({ ...auth, awsv4: { ...auth.awsv4, region } }), false, "us-east-1")}
            </Row>
            <Row label={t("api.auth.service")}>
              {field(auth.awsv4.service, (service) => onChange({ ...auth, awsv4: { ...auth.awsv4, service } }), false, "execute-api")}
            </Row>
          </Grid>
          <Note>{t("api.auth.awsSignedAtSend")}</Note>
        </div>
      );

    case "oauth2":
      return (
        <OAuth2Fields
          oauth2={auth.oauth2}
          onChange={(oauth2) => onChange({ ...auth, oauth2 })}
          ctx={ctx}
          readOnly={readOnly}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

function JwtFields({
  jwt,
  onChange,
  ctx,
  bufferKey,
  readOnly,
}: {
  jwt: JwtAuth;
  onChange: (next: JwtAuth) => void;
  ctx: VariableContext;
  bufferKey: string;
  readOnly: boolean;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);

  const jsonEditor = (kind: "header" | "payload", value: string, set: (next: string) => void) => (
    <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
      <Editor
        height={110}
        language="json"
        // Its own scheme, like `cf-editor:` for repo files, so an API-client buffer is never
        // confused with an open file by anything walking Monaco's models.
        path={`cf-api-auth:/${bufferKey}/jwt-${kind}.json`}
        value={value}
        theme={monacoTheme}
        onChange={(next) => set(next ?? "")}
        options={{
            ...OVERFLOW_SAFE_OPTIONS,
          readOnly,
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "off",
          folding: false,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
        }}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <Grid>
        <Row label={t("api.auth.algorithm")}>
          <Select
            size="sm"
            className="max-w-[160px]"
            disabled={readOnly}
            ariaLabel={t("api.auth.algorithm")}
            value={jwt.algorithm}
            onChange={(value) => onChange({ ...jwt, algorithm: value as JwtAlgorithm })}
            options={JWT_ALGORITHMS.map((algorithm) => ({ value: algorithm, label: algorithm }))}
          />
        </Row>
        <Row label={t("api.auth.secret")}>
          <div className="flex flex-col gap-1.5">
            <AuthField
              value={jwt.secret}
              onChange={(secret) => onChange({ ...jwt, secret })}
              ctx={ctx}
              secret
              readOnly={readOnly}
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <Checkbox
                checked={jwt.secretBase64}
                disabled={readOnly}
                onChange={(secretBase64) => onChange({ ...jwt, secretBase64 })}
              />
              {t("api.auth.secretBase64")}
            </label>
          </div>
        </Row>
        <Row label={t("api.auth.header")}>
          {jsonEditor("header", jwt.headerJson, (headerJson) => onChange({ ...jwt, headerJson }))}
        </Row>
        <Row label={t("api.auth.payload")}>
          {jsonEditor("payload", jwt.payloadJson, (payloadJson) => onChange({ ...jwt, payloadJson }))}
        </Row>
        <Row label={t("api.auth.addTo")}>
          <Select
            size="sm"
            className="max-w-[200px]"
            disabled={readOnly}
            ariaLabel={t("api.auth.addTo")}
            value={jwt.addTo}
            onChange={(value) => onChange({ ...jwt, addTo: value as "header" | "query" })}
            options={[
              { value: "header", label: t("api.auth.header") },
              { value: "query", label: t("api.auth.queryParams") },
            ]}
          />
        </Row>
        {jwt.addTo === "header" ? (
          <Row label={t("api.auth.headerPrefix")}>
            <AuthField
              value={jwt.headerPrefix}
              onChange={(headerPrefix) => onChange({ ...jwt, headerPrefix })}
              ctx={ctx}
              readOnly={readOnly}
              placeholder="Bearer"
            />
          </Row>
        ) : (
          <Row label={t("api.auth.queryParamName")}>
            <AuthField
              value={jwt.queryParamName}
              onChange={(queryParamName) => onChange({ ...jwt, queryParamName })}
              ctx={ctx}
              readOnly={readOnly}
              placeholder="token"
            />
          </Row>
        )}
      </Grid>
      <JwtPreview jwt={jwt} ctx={ctx} />
    </div>
  );
}

/** Signs the claims as they stand and shows the result.
 *
 * Without this the only way to find out that the payload has a typo, that the secret isn't really
 * base64 or that the PEM is PKCS#1 is to send the request and read the server's 401. */
function JwtPreview({ jwt, ctx }: { jwt: JwtAuth; ctx: VariableContext }) {
  const t = useT();
  const [result, setResult] = useState<{ token: string } | { error: string } | null>(null);
  const [revealed, setRevealed] = useState(false);

  const { algorithm, secret, secretBase64, headerJson, payloadJson } = jwt;

  useEffect(() => {
    let cancelled = false;
    // Signing is a WebCrypto round trip on every keystroke otherwise, and half-typed JSON would
    // flash an error for as long as it takes to finish the object.
    const timer = setTimeout(() => {
      const base = defaultAuth("jwt");
      const probe: AuthConfig = {
        ...base,
        jwt: {
          ...base.jwt,
          algorithm,
          secretBase64,
          // Variables are interpolated by `resolveRequest` at send time; doing it here too is what
          // makes the preview the token that will actually go out.
          secret: resolve(secret, ctx),
          headerJson: resolve(headerJson, ctx),
          payloadJson: resolve(payloadJson, ctx),
          // Asking for the query placement returns the bare token instead of one wrapped in
          // whatever header prefix is configured — `applyAuth` is the only exported way in.
          addTo: "query",
          queryParamName: "token",
        },
      };
      void applyAuth(probe, { method: "GET", url: "", bodyText: "" })
        .then((applied) => {
          if (!cancelled) setResult({ token: applied.queryParams[0]?.[1] ?? "" });
        })
        .catch((error: unknown) => {
          if (!cancelled) setResult({ error: error instanceof Error ? error.message : String(error) });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Built from the five fields rather than from `jwt` itself: those are the only ones that
    // change the signature, and the object's identity changes on every keystroke in the panel.
  }, [algorithm, secret, secretBase64, headerJson, payloadJson, ctx]);

  if (result === null) return null;

  return (
    <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("api.auth.jwtPreview")}</span>
        {"token" in result && result.token !== "" && (
          <button
            type="button"
            onClick={() => setRevealed((on) => !on)}
            title={revealed ? t("api.auth.mask") : t("api.auth.reveal")}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      {"error" in result ? (
        <Note tone="warning">{result.error}</Note>
      ) : (
        <p className="select-text break-all font-mono text-[11px] leading-[1.5] text-[var(--cf-text)]">
          {revealed ? result.token : maskToken(result.token)}
        </p>
      )}
    </div>
  );
}

/** Enough of the token to recognise it, not enough to leak it over a shoulder or a screen share. */
function maskToken(token: string): string {
  if (token.length <= 16) return "•".repeat(token.length);
  return `${token.slice(0, 8)}${"•".repeat(12)}${token.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// OAuth 2.0
// ---------------------------------------------------------------------------

function OAuth2Fields({
  oauth2,
  onChange,
  ctx,
  readOnly,
}: {
  oauth2: OAuth2Auth;
  onChange: (next: OAuth2Auth) => void;
  ctx: VariableContext;
  readOnly: boolean;
}) {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const [busy, setBusy] = useState(false);

  const grant = GRANTS.find((entry) => entry.id === oauth2.grantType) ?? GRANTS[2];
  const shows = (field: OAuth2Field) => grant.fields.includes(field);
  const hasRefreshToken = oauth2.refreshToken.trim() !== "";
  const expired = isOAuth2TokenExpired(oauth2);

  const requestToken = async (viaRefresh: boolean) => {
    setBusy(true);
    try {
      const config: OAuth2Auth = viaRefresh
        ? // `fetchOAuth2Token` only maps a stored refresh token onto the `refresh_token` grant for
          // the redirect flows; naming one here is how its public API is asked to exchange the
          // token we already hold instead of minting a brand new one.
          { ...oauth2, grantType: "authorization_code" }
        : oauth2;
      const token = await fetchOAuth2Token(config, tokenNetworkOptions(settings));
      onChange({
        ...oauth2,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      });
      useToastStore.getState().pushToast(t("api.auth.tokenObtained"), "success");
    } catch (error) {
      pushErrorToast(
        t("api.auth.tokenFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const text = (value: string, set: (next: string) => void, secret = false, placeholder?: string) => (
    <AuthField
      value={value}
      onChange={set}
      ctx={ctx}
      secret={secret}
      readOnly={readOnly}
      placeholder={placeholder}
    />
  );

  const grantOptions: SelectItems = GRANTS.map((entry) => ({
    value: entry.id,
    label: entry.supported ? t(entry.label) : `${t(entry.label)} — ${t("api.auth.grantUnsupported")}`,
    disabled: !entry.supported,
  }));

  return (
    <div className="flex flex-col gap-2">
      <Grid>
        <Row label={t("api.auth.grantType")}>
          <Select
            size="sm"
            className="max-w-[320px]"
            disabled={readOnly}
            ariaLabel={t("api.auth.grantType")}
            value={oauth2.grantType}
            onChange={(value) => onChange({ ...oauth2, grantType: value as OAuth2GrantType })}
            options={grantOptions}
          />
        </Row>

        {shows("authUrl") && (
          <Row label={t("api.auth.authUrl")}>{text(oauth2.authUrl, (authUrl) => onChange({ ...oauth2, authUrl }))}</Row>
        )}
        {shows("accessTokenUrl") && (
          <Row label={t("api.auth.accessTokenUrl")}>
            {text(oauth2.accessTokenUrl, (accessTokenUrl) => onChange({ ...oauth2, accessTokenUrl }))}
          </Row>
        )}
        {shows("clientId") && (
          <Row label={t("api.auth.clientId")}>{text(oauth2.clientId, (clientId) => onChange({ ...oauth2, clientId }))}</Row>
        )}
        {shows("clientSecret") && (
          <Row label={t("api.auth.clientSecret")}>
            {text(oauth2.clientSecret, (clientSecret) => onChange({ ...oauth2, clientSecret }), true)}
          </Row>
        )}
        {shows("username") && (
          <Row label={t("api.auth.username")}>{text(oauth2.username, (username) => onChange({ ...oauth2, username }))}</Row>
        )}
        {shows("password") && (
          <Row label={t("api.auth.password")}>
            {text(oauth2.password, (password) => onChange({ ...oauth2, password }), true)}
          </Row>
        )}
        {shows("redirectUri") && (
          <Row label={t("api.auth.redirectUri")}>
            {text(oauth2.redirectUri, (redirectUri) => onChange({ ...oauth2, redirectUri }))}
          </Row>
        )}
        {shows("scope") && (
          <Row label={t("api.auth.scope")}>{text(oauth2.scope, (scope) => onChange({ ...oauth2, scope }))}</Row>
        )}
        {shows("state") && (
          <Row label={t("api.auth.state")}>{text(oauth2.state, (state) => onChange({ ...oauth2, state }))}</Row>
        )}
        {shows("audience") && (
          <Row label={t("api.auth.audience")}>{text(oauth2.audience, (audience) => onChange({ ...oauth2, audience }))}</Row>
        )}
        {shows("resource") && (
          <Row label={t("api.auth.resource")}>{text(oauth2.resource, (resource) => onChange({ ...oauth2, resource }))}</Row>
        )}
        {shows("clientAuth") && (
          <Row label={t("api.auth.clientAuth")}>
            <Select
              size="sm"
              className="max-w-[280px]"
              disabled={readOnly}
              ariaLabel={t("api.auth.clientAuth")}
              value={oauth2.clientAuth}
              onChange={(value) => onChange({ ...oauth2, clientAuth: value as "header" | "body" })}
              options={[
                { value: "header", label: t("api.auth.sendAsBasicHeader") },
                { value: "body", label: t("api.auth.sendInBody") },
              ]}
            />
          </Row>
        )}

        <Row label={t("api.auth.accessToken")}>
          {text(oauth2.accessToken, (accessToken) => onChange({ ...oauth2, accessToken }), true)}
        </Row>
        <Row label={t("api.auth.refreshToken")}>
          {text(oauth2.refreshToken, (refreshToken) => onChange({ ...oauth2, refreshToken }), true)}
        </Row>
        <Row label={t("api.auth.addTo")}>
          <Select
            size="sm"
            className="max-w-[200px]"
            disabled={readOnly}
            ariaLabel={t("api.auth.addTo")}
            value={oauth2.addTo}
            onChange={(value) => onChange({ ...oauth2, addTo: value as "header" | "query" })}
            options={[
              { value: "header", label: t("api.auth.header") },
              { value: "query", label: t("api.auth.queryParams") },
            ]}
          />
        </Row>
        {oauth2.addTo === "header" && (
          <Row label={t("api.auth.headerPrefix")}>
            {text(oauth2.headerPrefix, (headerPrefix) => onChange({ ...oauth2, headerPrefix }), false, "Bearer")}
          </Row>
        )}
      </Grid>

      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || (!grant.supported && !hasRefreshToken)}
              onClick={() => void requestToken(!grant.supported)}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              {busy ? t("api.auth.gettingToken") : t("api.auth.getNewToken")}
            </button>
            {hasRefreshToken && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void requestToken(true)}
                title={t("api.auth.refresh")}
                className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.05]"
              >
                <RefreshCw size={12} />
                {t("api.auth.refresh")}
              </button>
            )}
            <span className="text-[11px] text-[var(--cf-text-muted)]">
              {oauth2.accessToken.trim() === ""
                ? t("api.auth.noToken")
                : expired
                  ? t("api.auth.tokenExpired")
                  : oauth2.expiresAt > 0
                    ? t("api.auth.tokenExpires", { when: new Date(oauth2.expiresAt * 1000).toLocaleString() })
                    : ""}
            </span>
          </div>
          {!grant.supported && <Note tone="warning">{t("api.auth.grantUnsupportedHint")}</Note>}
        </>
      )}
    </div>
  );
}

/** The token call is a back-channel POST to the identity provider, not to the request's own host:
 * the cookie jar and the per-host client certificate are matched against the *request* URL, so
 * neither applies here, while the proxy and the custom CA are network-wide and do. */
function tokenNetworkOptions(settings: ApiSettings): NetworkOptions {
  return {
    timeout_ms: settings.timeoutMs,
    follow_redirects: settings.followRedirects,
    max_redirects: settings.maxRedirects,
    verify_ssl: settings.verifySsl,
    keep_auth_on_redirect: false,
    proxy_url: settings.proxyEnabled ? settings.proxyUrl : "",
    client_cert_path: "",
    client_cert_password: "",
    ca_cert_path: settings.caCertPath,
    cookies: [],
    max_response_bytes: 1024 * 1024,
  };
}
