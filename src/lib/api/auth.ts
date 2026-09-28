/**
 * Turns an `AuthConfig` into the headers and query params that go on the wire.
 *
 * The split mirrors the one in `apiCommands.ts`: anything that is *just a header* is computed
 * here, so the cURL snippet, the console and the actual send all show the same bytes. The two
 * schemes that need the wire itself — Digest (a challenge/response round trip) and AWS SigV4 (a
 * canonical form over the final request) — contribute nothing to `headers` and instead travel as
 * `backend`, which the transport signs. A snippet generator can then say "signed by CodeFlow"
 * rather than silently emitting an unauthenticated command.
 */

import { defaultApiSettings, defaultAuth } from "../../types/api";
import type {
  ApiSettings,
  AuthConfig,
  BackendAuth,
  JwtAuth,
  NetworkOptions,
  OAuth2Auth,
  OAuth2GrantType,
} from "../../types/api";
import { apiSendHttp } from "../tauri/apiCommands";

export interface AuthApplyResult {
  headers: [string, string][];
  queryParams: [string, string][];
  /** Digest / AWS SigV4 — the transport signs these. */
  backend: BackendAuth | null;
}

/** A fresh object every time — the caller owns the arrays and is free to push into them. */
function nothing(): AuthApplyResult {
  return { headers: [], queryParams: [], backend: null };
}

/**
 * Request → folder(s) → collection: the first entry that isn't `inherit` wins. Falling off the
 * end means nothing in the chain ever configured auth, which is `none`, not "keep looking".
 */
export function resolveEffectiveAuth(chain: (AuthConfig | null)[]): AuthConfig {
  for (const auth of chain) {
    if (auth && auth.type !== "inherit") return auth;
  }
  return defaultAuth("none");
}

/**
 * Computes the auth contribution for one request.
 *
 * `_req` is unused today: every scheme that needs the method/URL/body to sign is handed to the
 * backend instead. It stays in the signature so adding one that signs in the webview (Hawk, HTTP
 * Message Signatures) doesn't churn every call site.
 */
export async function applyAuth(
  auth: AuthConfig,
  _req: { method: string; url: string; bodyText: string },
): Promise<AuthApplyResult> {
  switch (auth.type) {
    case "inherit":
    case "none":
      return nothing();

    case "basic": {
      const credentials = base64(utf8(`${auth.basic.username}:${auth.basic.password}`));
      return { headers: [["Authorization", `Basic ${credentials}`]], queryParams: [], backend: null };
    }

    case "bearer": {
      const token = auth.bearer.token.trim();
      if (token === "") return nothing();
      // `BearerAuth` carries no prefix field, so the scheme name is fixed — JWT and OAuth 2 are
      // the configs where a non-standard prefix is actually offered.
      return { headers: [["Authorization", `Bearer ${token}`]], queryParams: [], backend: null };
    }

    case "apikey": {
      const { key, value, addTo } = auth.apikey;
      if (key === "") return nothing();
      return addTo === "query"
        ? { headers: [], queryParams: [[key, value]], backend: null }
        : { headers: [[key, value]], queryParams: [], backend: null };
    }

    case "jwt": {
      const token = await signJwt(auth.jwt);
      return placeToken(token, auth.jwt.addTo, auth.jwt.headerPrefix, auth.jwt.queryParamName);
    }

    case "oauth2": {
      // Never fetch here. This function runs on every keystroke that rebuilds the snippet
      // preview; a silent token round trip from a formatting path would be a nasty surprise.
      const token = auth.oauth2.accessToken.trim();
      if (token === "") return nothing();
      return placeToken(token, auth.oauth2.addTo, auth.oauth2.headerPrefix, OAUTH2_QUERY_PARAM);
    }

    case "digest":
      return {
        headers: [],
        queryParams: [],
        backend: {
          kind: "digest",
          username: auth.digest.username,
          password: auth.digest.password,
        },
      };

    case "awsv4":
      return {
        headers: [],
        queryParams: [],
        backend: {
          kind: "awsv4",
          access_key: auth.awsv4.accessKey,
          secret_key: auth.awsv4.secretKey,
          session_token: auth.awsv4.sessionToken,
          region: auth.awsv4.region,
          service: auth.awsv4.service,
        },
      };
  }
}

/** RFC 6750 §2.3 names the query form `access_token`; `OAuth2Auth` has no field to override it. */
const OAUTH2_QUERY_PARAM = "access_token";

function placeToken(
  token: string,
  addTo: "header" | "query",
  headerPrefix: string,
  queryParamName: string,
): AuthApplyResult {
  if (addTo === "query") {
    return { headers: [], queryParams: [[queryParamName || "token", token]], backend: null };
  }
  const prefix = headerPrefix.trim();
  return {
    headers: [["Authorization", prefix === "" ? token : `${prefix} ${token}`]],
    queryParams: [],
    backend: null,
  };
}

// ---------------------------------------------------------------------------
// JWT signing
// ---------------------------------------------------------------------------

type JwtAlgorithmSpec =
  | { family: "hmac"; hash: string }
  | { family: "rsa"; hash: string }
  | { family: "ecdsa"; hash: string; curve: string };

const JWT_ALGORITHMS: Record<JwtAuth["algorithm"], JwtAlgorithmSpec> = {
  HS256: { family: "hmac", hash: "SHA-256" },
  HS384: { family: "hmac", hash: "SHA-384" },
  HS512: { family: "hmac", hash: "SHA-512" },
  RS256: { family: "rsa", hash: "SHA-256" },
  RS384: { family: "rsa", hash: "SHA-384" },
  RS512: { family: "rsa", hash: "SHA-512" },
  ES256: { family: "ecdsa", hash: "SHA-256", curve: "P-256" },
  ES384: { family: "ecdsa", hash: "SHA-384", curve: "P-384" },
};

async function signJwt(cfg: JwtAuth): Promise<string> {
  const spec = JWT_ALGORITHMS[cfg.algorithm];
  const header = { alg: cfg.algorithm, typ: "JWT", ...parseJsonObject(cfg.headerJson, "header") };
  const payload = parseJsonObject(cfg.payloadJson, "payload");
  const segment = (value: unknown) => base64Url(utf8(JSON.stringify(value)));
  const signingInput = `${segment(header)}.${segment(payload)}`;

  const key = await importJwtKey(cfg, spec);
  // ECDSA is the one family whose hash isn't pinned by the key itself, so it has to be named at
  // signing time. WebCrypto emits the raw r‖s pair ECDSA-in-JWS wants, not a DER wrapper.
  const algorithm: EcdsaParams | string =
    spec.family === "ecdsa" ? { name: "ECDSA", hash: { name: spec.hash } } : key.algorithm.name;
  const signature = await subtle()
    .sign(algorithm, key, utf8(signingInput))
    .catch((error: unknown) => {
      throw new Error(`Could not sign the JWT: ${describe(error)}`);
    });

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function importJwtKey(cfg: JwtAuth, spec: JwtAlgorithmSpec): Promise<CryptoKey> {
  if (spec.family === "hmac") {
    const material = cfg.secretBase64 ? decodeBase64(cfg.secret, "JWT secret") : utf8(cfg.secret);
    return subtle().importKey("raw", material, { name: "HMAC", hash: { name: spec.hash } }, false, [
      "sign",
    ]);
  }

  const der = pemToDer(cfg.secret);
  const params =
    spec.family === "rsa"
      ? { name: "RSASSA-PKCS1-v1_5", hash: { name: spec.hash } }
      : { name: "ECDSA", namedCurve: spec.curve };
  return subtle()
    .importKey("pkcs8", der, params, false, ["sign"])
    .catch((error: unknown) => {
      throw new Error(
        `Could not read the ${cfg.algorithm} private key — it must be an unencrypted PKCS#8 PEM ` +
          `("BEGIN PRIVATE KEY"): ${describe(error)}`,
      );
    });
}

/** PKCS#8 only: WebCrypto cannot import PKCS#1 ("BEGIN RSA PRIVATE KEY") or an encrypted key, and
 * saying so beats the browser's opaque `DataError`. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("No private key provided for this JWT algorithm.");
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error(
      "This is a PKCS#1 key. Convert it first: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem",
    );
  }
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(pem)) {
    throw new Error("Encrypted private keys are not supported — decrypt the key first.");
  }
  return decodeBase64(body, "private key");
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`The JWT ${what} is not valid JSON: ${describe(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The JWT ${what} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OAuth 2.0
// ---------------------------------------------------------------------------

/** True only when the expiry is both known and in the past — `expiresAt: 0` means "unknown", and
 * an unknown token is not the same as a dead one. */
export function isOAuth2TokenExpired(cfg: OAuth2Auth): boolean {
  return cfg.expiresAt > 0 && cfg.expiresAt <= Math.floor(Date.now() / 1000);
}

/** What a token endpoint (or an implicit redirect) handed back. */
export interface OAuth2Token {
  accessToken: string;
  /** The stored one when the response carried none — see `postTokenForm`. */
  refreshToken: string;
  /** Unix seconds; 0 = unknown. */
  expiresAt: number;
  raw: unknown;
}

/**
 * The config with every `{{variable}}` resolved — what a token call has to send.
 *
 * The stored config keeps its templates: a client secret held in `{{clientSecret}}` must stay a
 * reference in the collection, and only the call gets the value.
 */
export function resolveOAuth2(cfg: OAuth2Auth, expand: (text: string) => string): OAuth2Auth {
  const out = { ...cfg };
  for (const key of Object.keys(out) as (keyof OAuth2Auth)[]) {
    const value = out[key];
    if (typeof value === "string") (out as Record<string, unknown>)[key] = expand(value);
  }
  return out;
}

/** The grants whose first leg happens in the user's browser. */
export function needsBrowser(grant: OAuth2GrantType): boolean {
  return grant === "authorization_code" || grant === "authorization_code_pkce" || grant === "implicit";
}

/**
 * Whether to refresh before sending: a refresh token is on hand and the access token is missing,
 * expired, or within `skewSeconds` of expiring — a token that dies in flight fails the same way as
 * one already dead. An unknown expiry (`0`) is never refreshed on a guess.
 */
export function shouldRefreshOAuth2(
  cfg: OAuth2Auth,
  nowSeconds = Math.floor(Date.now() / 1000),
  skewSeconds = 30,
): boolean {
  if (cfg.refreshToken.trim() === "") return false;
  if (cfg.accessToken.trim() === "") return true;
  return cfg.expiresAt > 0 && cfg.expiresAt <= nowSeconds + skewSeconds;
}

/**
 * The back-channel grants: `client_credentials` and `password` are one POST each. The redirect grants
 * start in the browser (`authorizeInBrowser`); asked here with a refresh token stored, one of those
 * is refreshed rather than refused, since that is the only token call it can make without a user.
 *
 * Goes through the Rust transport rather than `fetch` — the webview's fetch is subject to CORS
 * and would ignore the app's proxy, custom CA and TLS-verification settings.
 */
export async function fetchOAuth2Token(
  cfg: OAuth2Auth,
  options: NetworkOptions = tokenRequestOptions(),
): Promise<OAuth2Token> {
  switch (cfg.grantType) {
    case "client_credentials":
      return postTokenForm(cfg, [["grant_type", "client_credentials"], ...extras(cfg)], options);
    case "password":
      return postTokenForm(
        cfg,
        [["grant_type", "password"], ["username", cfg.username], ["password", cfg.password], ...extras(cfg)],
        options,
      );
    default:
      if (cfg.refreshToken.trim() !== "") return refreshOAuth2Token(cfg, options);
      throw new Error("This grant signs in through the browser — use Get New Access Token.");
  }
}

/** `grant_type=refresh_token` (RFC 6749 §6). */
export async function refreshOAuth2Token(
  cfg: OAuth2Auth,
  options: NetworkOptions = tokenRequestOptions(),
): Promise<OAuth2Token> {
  if (cfg.refreshToken.trim() === "") throw new Error("There is no refresh token to use.");
  return postTokenForm(
    cfg,
    [["grant_type", "refresh_token"], ["refresh_token", cfg.refreshToken], ...extras(cfg)],
    options,
  );
}

/**
 * Redeems an authorization code (RFC 6749 §4.1.3). `redirect_uri` must be byte-identical to the one
 * the authorization request carried, and `code_verifier` is what proves — with PKCE — that whoever
 * redeems the code is whoever started the flow.
 */
export async function exchangeAuthorizationCode(
  cfg: OAuth2Auth,
  code: string,
  verifier: string | null,
  options: NetworkOptions = tokenRequestOptions(),
): Promise<OAuth2Token> {
  const form: [string, string][] = [
    ["grant_type", "authorization_code"],
    ["code", code],
    ["redirect_uri", cfg.redirectUri.trim()],
  ];
  if (verifier !== null) form.push(["code_verifier", verifier]);
  return postTokenForm(cfg, form, options);
}

/** `scope`, `audience` and `resource`, when set — the extensions every token call may carry. */
function extras(cfg: OAuth2Auth): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of [
    ["scope", cfg.scope],
    ["audience", cfg.audience],
    ["resource", cfg.resource],
  ] as const) {
    if (value.trim() !== "") out.push([name, value.trim()]);
  }
  return out;
}

/** One POST to `accessTokenUrl` with the client authenticated, and its answer read as a token. */
async function postTokenForm(
  cfg: OAuth2Auth,
  form: [string, string][],
  options: NetworkOptions,
): Promise<OAuth2Token> {
  const tokenUrl = cfg.accessTokenUrl.trim();
  if (tokenUrl === "") throw new Error("Access Token URL is required.");

  const headers: [string, string][] = [["Accept", "application/json"]];
  // A client with no secret is a public client (RFC 6749 §2.3.1): it identifies itself with
  // `client_id` in the body, and a `Basic id:` header would be read as a failed authentication.
  if (cfg.clientAuth === "header" && cfg.clientId !== "" && cfg.clientSecret !== "") {
    // Raw, not form-encoded, before base64: RFC 6749 §2.3.1 asks for the encoded form but
    // effectively every server compares against the raw credentials, and every other client
    // sends them that way.
    headers.push(["Authorization", `Basic ${base64(utf8(`${cfg.clientId}:${cfg.clientSecret}`))}`]);
  } else if (cfg.clientId !== "") {
    form.push(["client_id", cfg.clientId]);
    if (cfg.clientSecret !== "") form.push(["client_secret", cfg.clientSecret]);
  }

  const response = await apiSendHttp({
    method: "POST",
    url: tokenUrl,
    headers,
    body_text: null,
    body_base64: null,
    body_file: null,
    form_data: null,
    urlencoded: form,
    auth: null,
    options,
  });

  const payload = parseTokenResponse(response.body_text);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `The token endpoint answered ${response.status} ${response.status_text}: ${
        describeOAuthError(payload) ?? excerpt(response.body_text)
      }`,
    );
  }
  if (payload === null) {
    throw new Error(
      `The token endpoint answered with something that isn't a token response: ${excerpt(response.body_text)}`,
    );
  }
  return tokenFromPayload(payload, cfg.refreshToken, response.body_text);
}

function tokenFromPayload(payload: Record<string, unknown>, storedRefresh: string, body: string): OAuth2Token {
  const accessToken = stringField(payload, "access_token");
  if (accessToken === "") {
    throw new Error(`The token response has no access_token: ${excerpt(body)}`);
  }
  // `expires_in` is relative seconds and some providers send it as a string; storing an absolute
  // instant means the UI doesn't have to remember when the response arrived.
  const expiresIn = Number(payload["expires_in"]);
  const known = Number.isFinite(expiresIn) && expiresIn > 0;
  return {
    accessToken,
    // A refresh response is allowed to omit the refresh token, and dropping the stored one then
    // would cost the user the whole re-authorization.
    refreshToken: stringField(payload, "refresh_token") || storedRefresh,
    expiresAt: known ? Math.floor(Date.now() / 1000 + expiresIn) : 0,
    raw: payload,
  };
}

// ---------------------------------------------------------------------------
// The browser grants
// ---------------------------------------------------------------------------

/**
 * Whether the listener can receive this redirect: plain `http` on the loopback interface. The same
 * test `oauth::loopback_redirect` applies in Rust; this one exists so the form can say so before a
 * browser is ever opened.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** The authorization request (RFC 6749 §4.1.1 / §4.2.1), appended to whatever query `authUrl` has. */
export function buildAuthorizeUrl(
  cfg: OAuth2Auth,
  request: { state: string; codeChallenge?: string },
): string {
  const base = cfg.authUrl.trim();
  if (base === "") throw new Error("Auth URL is required.");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`'${base}' is not a valid Auth URL.`);
  }
  const params = url.searchParams;
  params.set("response_type", cfg.grantType === "implicit" ? "token" : "code");
  params.set("client_id", cfg.clientId);
  params.set("redirect_uri", cfg.redirectUri.trim());
  if (cfg.scope.trim() !== "") params.set("scope", cfg.scope.trim());
  params.set("state", request.state);
  if (request.codeChallenge !== undefined) {
    params.set("code_challenge", request.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  // Some providers (Auth0's `audience`, Azure's v1 `resource`) read these at authorization time.
  if (cfg.audience.trim() !== "") params.set("audience", cfg.audience.trim());
  if (cfg.resource.trim() !== "") params.set("resource", cfg.resource.trim());
  return url.toString();
}

/** An implicit grant's redirect parameters, read as a token. */
export function tokenFromRedirect(params: [string, string][]): OAuth2Token {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of params) payload[key] = value;
  return tokenFromPayload(payload, "", new URLSearchParams(params).toString());
}

/** Starts the browser leg and waits for the redirect — `apiOAuthAuthorize` in the app. */
export type BrowserAuthorize = (request: {
  id: string;
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  implicit: boolean;
}) => Promise<[string, string][]>;

/**
 * The authorization-code (± PKCE, S256) and implicit grants, end to end: the authorization URL is
 * opened in the system browser, the registered loopback redirect is captured, `state` is checked,
 * and a code is redeemed at the token endpoint. `cfg` must already be resolved (`resolveOAuth2`).
 *
 * The state is the form's own when it has one, and otherwise 128 random bits.
 */
export async function authorizeInBrowser(
  cfg: OAuth2Auth,
  options: NetworkOptions,
  flowId: string,
  authorize: BrowserAuthorize,
  pkce: () => Promise<{ verifier: string; challenge: string }> = buildPkceChallenge,
): Promise<OAuth2Token> {
  if (!isLoopbackRedirect(cfg.redirectUri)) {
    throw new Error("The redirect URI must be a localhost address registered with the provider.");
  }
  const state = cfg.state.trim() || base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = cfg.grantType === "authorization_code_pkce" ? await pkce() : null;
  const params = await authorize({
    id: flowId,
    authorizeUrl: buildAuthorizeUrl(cfg, { state, codeChallenge: challenge?.challenge }),
    redirectUri: cfg.redirectUri.trim(),
    state,
    implicit: cfg.grantType === "implicit",
  });
  // The listener already refused a mismatch; checked again because the check is the whole point.
  if (params.find(([key]) => key === "state")?.[1] !== state) {
    throw new Error("The redirect's state did not match the request.");
  }
  if (cfg.grantType === "implicit") return tokenFromRedirect(params);
  const code = params.find(([key]) => key === "code")?.[1] ?? "";
  if (code === "") throw new Error("The redirect carried no authorization code.");
  return exchangeAuthorizationCode(cfg, code, challenge?.verifier ?? null, options);
}

/** JSON first; a handful of older providers still answer `application/x-www-form-urlencoded`. */
function parseTokenResponse(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (!trimmed.includes("=")) return null;
  const params = new URLSearchParams(trimmed);
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) out[key] = value;
  return "access_token" in out || "error" in out ? out : null;
}

/** OAuth errors are a documented shape (RFC 6749 §5.2); showing it beats a raw JSON dump. */
function describeOAuthError(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const code = stringField(payload, "error");
  if (code === "") return null;
  const detail = stringField(payload, "error_description");
  return detail === "" ? code : `${code} — ${detail}`;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function excerpt(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed || "(empty body)";
}

/**
 * Network options for a token call. It is a back-channel POST to the identity provider, not to the
 * request's own host: the cookie jar and the per-host client certificate are matched against the
 * *request* URL, so neither applies here, while the proxy and the custom CA are network-wide and do.
 */
export function tokenNetworkOptions(settings: ApiSettings): NetworkOptions {
  return {
    timeout_ms: settings.timeoutMs,
    follow_redirects: settings.followRedirects,
    max_redirects: settings.maxRedirects,
    verify_ssl: settings.verifySsl,
    keep_auth_on_redirect: false,
    proxy_url: settings.proxyEnabled ? settings.proxyUrl : "",
    client_cert_path: "",
    client_key_path: "",
    client_cert_password: "",
    ca_cert_path: settings.caCertPath,
    cookies: [],
    max_response_bytes: 1024 * 1024,
    stream: false,
  };
}

/** The shipped defaults, for a caller with no settings at hand. */
function tokenRequestOptions(): NetworkOptions {
  return tokenNetworkOptions(defaultApiSettings());
}

/** A PKCE verifier and its S256 challenge (RFC 7636 §4.1–4.2). */
export async function buildPkceChallenge(): Promise<{
  verifier: string;
  challenge: string;
  method: "S256";
}> {
  // 32 random bytes are 43 base64url characters — the minimum length §4.1 allows, at full entropy.
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))`, RFC 7636 §4.2. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", utf8(verifier));
  return base64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** `btoa` alone would throw on any non-latin-1 character, which is exactly what a password or a
 * JWT claim is allowed to contain. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(bytes: Uint8Array): string {
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit on a large key.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64(text: string, what: string): Uint8Array {
  const normalized = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    throw new Error(`The ${what} is not valid base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** WebCrypto is only exposed in a secure context; a packaged webview that lost it should say so
 * rather than fail with "cannot read properties of undefined". */
function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error("WebCrypto is unavailable in this window, so signing is not possible.");
  }
  return crypto.subtle;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
