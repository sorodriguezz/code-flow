import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, statusOf, type CredentialCheck } from "../lib/integrationCredentialStatus";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  settingsListener: undefined as ((event: { payload: { key: string } }) => void) | undefined,
  notify: vi.fn(),
  check: vi.fn(),
}));
const healthKey = "integration_credential_health";
const account = { provider: "azure", account: "acme" } as const;
const now = Date.parse("2026-11-28T18:00:00Z");

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.check }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: typeof mocks.settingsListener) => {
    if (name === "settings:changed") mocks.settingsListener = callback;
    return () => {};
  },
}));
vi.mock("../lib/tauri/commands", () => ({
  getSetting: async (key: string) => mocks.settings.get(key) ?? null,
  setSetting: async (key: string, value: string) => {
    mocks.settings.set(key, value);
    mocks.settingsListener?.({ payload: { key } });
  },
}));
vi.mock("../lib/windowIdentity", () => ({ isMainWindow: () => true, WINDOW: { label: "main" } }));
vi.mock("./notificationStore", () => ({ notify: mocks.notify }));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ mutedNotificationSources: [] }) },
}));

function answer(status: CredentialCheck["status"], expiresAt: number | null = null): CredentialCheck {
  return { status, expiresAt, account: null };
}

async function start() {
  const monitor = await import("./integrationCredentialStore");
  monitor.startIntegrationCredentialMonitor();
  await vi.advanceTimersByTimeAsync(0);
  return monitor;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, setInterval }));
  mocks.settings.clear();
  mocks.settings.set("ado_default_org", account.account);
  mocks.settingsListener = undefined;
  mocks.notify.mockClear();
  mocks.check.mockReset().mockResolvedValue(answer("valid"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("integration credential monitoring", () => {
  it("warns at 72, 48 and 24 hours and stops at expiry, even offline", async () => {
    const monitor = await start();
    const expiry = now + 3 * DAY_MS + 60_000;
    await monitor.saveIntegrationExpiration(account, expiry);
    expect(mocks.notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      titleKey: "integrations.credential.warningDays",
      params: { provider: "Azure DevOps", account: "acme", days: 3 },
      target: { integration: "azure" },
    }));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ days: 2 }) }));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ titleKey: "integrations.credential.warningOneDay" }));

    mocks.check.mockResolvedValue(answer("unavailable"));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    const state = monitor.useIntegrationCredentialStore.getState();
    expect(statusOf(state.entries["azure:acme"], state.now)).toBe("expired");
    expect(mocks.notify).toHaveBeenCalledTimes(3);
  });

  it("keeps notice history across startup, handles remote rejection, and resets on replacement", async () => {
    mocks.settings.set(healthKey, JSON.stringify({
      "azure:acme": { revision: "", manualExpiry: now + 3 * DAY_MS, warnedDays: 3, status: "valid" },
    }));
    const monitor = await start();
    expect(mocks.notify).not.toHaveBeenCalled();

    mocks.check.mockResolvedValue(answer("rejected"));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(monitor.useIntegrationCredentialStore.getState().entries["azure:acme"].status).toBe("rejected");
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      titleKey: "integrations.credential.warningRejected",
    }));
    mocks.check.mockResolvedValue(answer("unavailable"));
    await monitor.recheckIntegrationCredential(account);
    expect(monitor.useIntegrationCredentialStore.getState().entries["azure:acme"].status).toBe("rejected");
    expect(mocks.notify).toHaveBeenCalledTimes(1);

    mocks.check.mockResolvedValue(answer("valid"));
    mocks.settings.set("ado_connections", JSON.stringify([{ org: "acme", credentialRevision: "replacement" }]));
    mocks.settingsListener?.({ payload: { key: "ado_connections" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.useIntegrationCredentialStore.getState().entries["azure:acme"]).toEqual({
      revision: "replacement", status: "valid",
    });
  });

  it("prefers the provider's expiration and distinguishes partial access and network failure", async () => {
    const expiry = now + 2 * DAY_MS;
    mocks.settings.delete("ado_default_org");
    mocks.settings.set("github_connections", JSON.stringify([{ host: "github.com", credentialRevision: "first" }]));
    mocks.settings.set(healthKey, JSON.stringify({
      "github:github.com": { revision: "first", manualExpiry: now + 10 * DAY_MS },
    }));
    mocks.check.mockResolvedValue(answer("valid", expiry));
    const monitor = await start();
    const read = () => monitor.useIntegrationCredentialStore.getState().entries["github:github.com"];
    expect(read()).toMatchObject({ providerExpiry: expiry, warnedDays: 2 });

    mocks.check.mockResolvedValue(answer("access_denied"));
    const github = { provider: "github", account: "github.com" } as const;
    await monitor.recheckIntegrationCredential(github);
    expect(statusOf(read(), now)).toBe("access_denied");
    mocks.check.mockResolvedValue(answer("unavailable"));
    await monitor.recheckIntegrationCredential(github);
    expect(read().status).toBe("unavailable");
    expect(read().providerExpiry).toBe(expiry);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight rejection when the credential is replaced", async () => {
    let finishOldCheck!: (result: CredentialCheck) => void;
    const monitor = await start();
    mocks.check.mockImplementationOnce(() => new Promise<CredentialCheck>((resolve) => {
      finishOldCheck = resolve;
    }));
    const check = monitor.recheckIntegrationCredential(account);
    await vi.advanceTimersByTimeAsync(0);

    mocks.settings.set("ado_connections", JSON.stringify([{ org: "acme", credentialRevision: "new" }]));
    mocks.settingsListener?.({ payload: { key: "ado_connections" } });
    await vi.advanceTimersByTimeAsync(0);
    finishOldCheck(answer("rejected"));
    await check;
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.useIntegrationCredentialStore.getState().entries["azure:acme"]).toEqual({
      revision: "new", status: "valid",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
