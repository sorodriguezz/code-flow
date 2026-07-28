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
import type { AuthConfig, BackendAuth, JwtAuth, NetworkOptions, OAuth2Auth } from "../../types/api";
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

/**
 * Runs a token request against `accessTokenUrl` and returns what came back.
 *
 * Handles the two grants that are pure back-channel calls (`client_credentials`, `password`) plus
 * `refresh_token` whenever one is stored. The browser-redirect grants are *not* implemented: they
 * need a real user agent and a loopback listener for the callback, and a half-built version that
 * silently drops the `state` check would be worse than an honest error.
 *
 * Goes through the Rust transport rather than `fetch` — the webview's fetch is subject to CORS
 * and would ignore the app's proxy, custom CA and TLS-verification settings.
 */
export async function fetchOAuth2Token(
  cfg: OAuth2Auth,
  options: NetworkOptions = tokenRequestOptions(),
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; raw: unknown }> {
  const tokenUrl = cfg.accessTokenUrl.trim();
  if (tokenUrl === "") throw new Error("Access Token URL is required.");

  const grant = grantForTokenCall(cfg);
  const form: [string, string][] = [["grant_type", grant]];
  if (grant === "password") form.push(["username", cfg.username], ["password", cfg.password]);
  if (grant === "refresh_token") form.push(["refresh_token", cfg.refreshToken]);
  for (const [name, value] of [
    ["scope", cfg.scope],
    ["audience", cfg.audience],
    ["resource", cfg.resource],
  ] as const) {
    if (value.trim() !== "") form.push([name, value.trim()]);
  }

  const headers: [string, string][] = [["Accept", "application/json"]];
  if (cfg.clientAuth === "header" && cfg.clientId !== "") {
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

  const accessToken = stringField(payload, "access_token");
  if (accessToken === "") {
    throw new Error(`The token response has no access_token: ${excerpt(response.body_text)}`);
  }
  // `expires_in` is relative seconds and some providers send it as a string; storing an absolute
  // instant means the UI doesn't have to remember when the response arrived.
  const expiresIn = Number(payload["expires_in"]);
  const known = Number.isFinite(expiresIn) && expiresIn > 0;

  return {
    accessToken,
    // A refresh response is allowed to omit the refresh token, and dropping the stored one then
    // would cost the user the whole re-authorization.
    refreshToken: stringField(payload, "refresh_token") || cfg.refreshToken,
    expiresAt: known ? Math.floor(Date.now() / 1000 + expiresIn) : 0,
    raw: payload,
  };
}

function grantForTokenCall(cfg: OAuth2Auth): "client_credentials" | "password" | "refresh_token" {
  switch (cfg.grantType) {
    case "client_credentials":
    case "password":
      return cfg.grantType;
    case "authorization_code":
    case "authorization_code_pkce":
    case "implicit":
      if (cfg.refreshToken !== "") return "refresh_token";
      throw new Error(
        `The ${cfg.grantType} grant is not supported yet — it needs a browser redirect and a ` +
          "loopback listener for the callback. Obtain the token elsewhere and paste it into " +
          "Access Token, or use a refresh token.",
      );
  }
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

/** The token call can't reach the settings store from here, so it uses the shipped defaults; the
 * caller passes real `NetworkOptions` when the user has configured a proxy or a custom CA. */
function tokenRequestOptions(): NetworkOptions {
  const settings = defaultApiSettings();
  return {
    timeout_ms: settings.timeoutMs,
    follow_redirects: settings.followRedirects,
    max_redirects: settings.maxRedirects,
    verify_ssl: settings.verifySsl,
    keep_auth_on_redirect: false,
    proxy_url: "",
    client_cert_path: "",
    client_cert_password: "",
    ca_cert_path: "",
    cookies: [],
    max_response_bytes: 1024 * 1024,
  };
}

/**
 * A PKCE verifier and its S256 challenge (RFC 7636). Nothing calls this yet — it's here so
 * finishing `authorization_code_pkce` is a matter of adding the redirect plumbing, not of
 * reworking this module.
 */
export async function buildPkceChallenge(): Promise<{
  verifier: string;
  challenge: string;
  method: "S256";
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await subtle().digest("SHA-256", utf8(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)), method: "S256" };
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
