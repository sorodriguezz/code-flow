import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAuth, type HttpSendRequest, type OAuth2Auth } from "../../types/api";

/** Every token call goes through the Rust transport; here it is a recorder with a canned answer. */
const sent: HttpSendRequest[] = [];
let answer: { status: number; body: string } = { status: 200, body: "{}" };
vi.mock("../tauri/apiCommands", () => ({
  apiSendHttp: async (request: HttpSendRequest) => {
    sent.push(request);
    return { status: answer.status, status_text: "", body_text: answer.body };
  },
}));

const {
  authorizeInBrowser,
  buildAuthorizeUrl,
  buildPkceChallenge,
  exchangeAuthorizationCode,
  fetchOAuth2Token,
  isLoopbackRedirect,
  needsBrowser,
  pkceChallenge,
  refreshOAuth2Token,
  resolveOAuth2,
  shouldRefreshOAuth2,
  tokenNetworkOptions,
} = await import("./auth");
const { defaultApiSettings } = await import("../../types/api");

const OPTIONS = tokenNetworkOptions(defaultApiSettings());

function oauth(patch: Partial<OAuth2Auth> = {}): OAuth2Auth {
  return {
    ...defaultAuth("oauth2").oauth2,
    authUrl: "https://auth.example.test/authorize",
    accessTokenUrl: "https://auth.example.test/token",
    clientId: "client-1",
    ...patch,
  };
}

const form = (request: HttpSendRequest) => Object.fromEntries(request.urlencoded ?? []);
const header = (request: HttpSendRequest, name: string) =>
  request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

beforeEach(() => {
  sent.length = 0;
  answer = { status: 200, body: '{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600}' };
});

describe("PKCE", () => {
  // RFC 7636 Appendix B.
  it("derives the S256 challenge from the verifier exactly as the RFC's example does", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds a fresh 43-character base64url verifier every time", async () => {
    const first = await buildPkceChallenge();
    const second = await buildPkceChallenge();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toBe(await pkceChallenge(first.verifier));
    expect(first.method).toBe("S256");
  });
});

describe("shouldRefreshOAuth2", () => {
  const now = 1_800_000_000;
  it("refreshes an expired or nearly expired token when a refresh token is on hand", () => {
    expect(shouldRefreshOAuth2(oauth({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 }), now)).toBe(true);
    expect(shouldRefreshOAuth2(oauth({ accessToken: "a", refreshToken: "r", expiresAt: now + 10 }), now)).toBe(true);
    expect(shouldRefreshOAuth2(oauth({ accessToken: "", refreshToken: "r", expiresAt: 0 }), now)).toBe(true);
  });

  it("leaves a live token, an unknown expiry and a token with no refresh token alone", () => {
    expect(shouldRefreshOAuth2(oauth({ accessToken: "a", refreshToken: "r", expiresAt: now + 3600 }), now)).toBe(false);
    expect(shouldRefreshOAuth2(oauth({ accessToken: "a", refreshToken: "r", expiresAt: 0 }), now)).toBe(false);
    expect(shouldRefreshOAuth2(oauth({ accessToken: "a", refreshToken: "", expiresAt: now - 1 }), now)).toBe(false);
  });
});

describe("resolveOAuth2", () => {
  it("resolves every string field and leaves the rest", () => {
    const vars: Record<string, string> = { tokenUrl: "https://auth.example.test/token", secret: "s3cret" };
    const resolved = resolveOAuth2(
      oauth({ accessTokenUrl: "{{tokenUrl}}", clientSecret: "{{secret}}", expiresAt: 42 }),
      (text) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? ""),
    );
    expect(resolved.accessTokenUrl).toBe("https://auth.example.test/token");
    expect(resolved.clientSecret).toBe("s3cret");
    expect(resolved.expiresAt).toBe(42);
  });
});

describe("isLoopbackRedirect", () => {
  it("accepts plain http on the loopback interface only", () => {
    for (const ok of ["http://localhost:8976/callback", "http://127.0.0.1:5000", "http://[::1]:7000/cb", "http://127.1.2.3/x"]) {
      expect(isLoopbackRedirect(ok), ok).toBe(true);
    }
    for (const bad of ["https://localhost:8976/callback", "http://app.example.test/cb", "com.example.app:/cb", ""]) {
      expect(isLoopbackRedirect(bad), bad).toBe(false);
    }
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks for a code with the PKCE challenge, keeping the query the Auth URL already has", () => {
    const url = new URL(
      buildAuthorizeUrl(
        oauth({ authUrl: "https://auth.example.test/authorize?prompt=login", scope: "read write", grantType: "authorization_code_pkce" }),
        { state: "st-1", codeChallenge: "ch-1" },
      ),
    );
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8976/callback");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code_challenge")).toBe("ch-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("asks for a token in the implicit grant, with no challenge", () => {
    const url = new URL(buildAuthorizeUrl(oauth({ grantType: "implicit" }), { state: "s" }));
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });
});

describe("token calls", () => {
  it("client credentials: Basic header for a confidential client", async () => {
    const token = await fetchOAuth2Token(oauth({ clientSecret: "shh", scope: "api" }), OPTIONS);
    expect(token.accessToken).toBe("at-1");
    expect(form(sent[0])).toEqual({ grant_type: "client_credentials", scope: "api" });
    expect(header(sent[0], "Authorization")).toBe(`Basic ${btoa("client-1:shh")}`);
  });

  it("a public client (no secret) identifies itself in the body, not with an empty Basic header", async () => {
    await exchangeAuthorizationCode(oauth({ clientSecret: "" }), "code-1", "verifier-1", OPTIONS);
    expect(header(sent[0], "Authorization")).toBeUndefined();
    expect(form(sent[0])).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:8976/callback",
      code_verifier: "verifier-1",
      client_id: "client-1",
    });
  });

  it("a refresh keeps the stored refresh token when the response carries none", async () => {
    answer = { status: 200, body: '{"access_token":"at-2","expires_in":"60"}' };
    const token = await refreshOAuth2Token(oauth({ refreshToken: "rt-old" }), OPTIONS);
    expect(form(sent[0])).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-old" });
    expect(token.refreshToken).toBe("rt-old");
    expect(token.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("reports the provider's error sentence", async () => {
    answer = { status: 400, body: '{"error":"invalid_grant","error_description":"Code expired."}' };
    await expect(exchangeAuthorizationCode(oauth(), "c", null, OPTIONS)).rejects.toThrow(
      "invalid_grant — Code expired.",
    );
  });

  it("the redirect grants never mint a token without the browser", async () => {
    expect(needsBrowser("authorization_code")).toBe(true);
    expect(needsBrowser("client_credentials")).toBe(false);
    await expect(fetchOAuth2Token(oauth({ grantType: "authorization_code" }), OPTIONS)).rejects.toThrow(/browser/);
  });
});

describe("authorizeInBrowser", () => {
  it("PKCE: opens the authorization URL, checks state and redeems the code with the verifier", async () => {
    const authorize = vi.fn(async (request: { authorizeUrl: string; state: string }) => {
      const url = new URL(request.authorizeUrl);
      expect(url.searchParams.get("code_challenge")).toBe("challenge-x");
      return [
        ["code", "code-9"],
        ["state", request.state],
      ] as [string, string][];
    });
    const token = await authorizeInBrowser(
      oauth({ grantType: "authorization_code_pkce", clientSecret: "" }),
      OPTIONS,
      "flow-1",
      authorize,
      async () => ({ verifier: "verifier-x", challenge: "challenge-x" }),
    );
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toMatchObject({ id: "flow-1", redirectUri: "http://localhost:8976/callback", implicit: false });
    expect(form(sent[0])).toMatchObject({ code: "code-9", code_verifier: "verifier-x" });
    expect(token.accessToken).toBe("at-1");
  });

  it("uses the form's own state when it has one", async () => {
    const authorize = vi.fn(async (request: { state: string }) => [["code", "c"], ["state", request.state]] as [string, string][]);
    await authorizeInBrowser(oauth({ grantType: "authorization_code", state: "fixed-state" }), OPTIONS, "f", authorize);
    expect(authorize.mock.calls[0][0].state).toBe("fixed-state");
  });

  it("refuses a redirect whose state is not the one sent", async () => {
    await expect(
      authorizeInBrowser(oauth({ grantType: "authorization_code" }), OPTIONS, "f", async () => [
        ["code", "c"],
        ["state", "someone-else"],
      ]),
    ).rejects.toThrow(/state/);
    expect(sent).toEqual([]);
  });

  it("implicit: the token comes straight off the redirect, no token call", async () => {
    const token = await authorizeInBrowser(oauth({ grantType: "implicit" }), OPTIONS, "f", async (request) => [
      ["access_token", "implicit-token"],
      ["expires_in", "120"],
      ["state", request.state],
    ]);
    expect(token.accessToken).toBe("implicit-token");
    expect(token.expiresAt).toBeGreaterThan(0);
    expect(sent).toEqual([]);
  });

  it("a non-loopback redirect is refused before any browser opens", async () => {
    const authorize = vi.fn();
    await expect(
      authorizeInBrowser(oauth({ grantType: "authorization_code", redirectUri: "https://app.example.test/cb" }), OPTIONS, "f", authorize),
    ).rejects.toThrow(/localhost/);
    expect(authorize).not.toHaveBeenCalled();
  });
});
