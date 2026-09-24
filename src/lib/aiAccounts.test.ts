import { describe, expect, it } from "vitest";
import {
  accountKey,
  accountName,
  loginCommand,
  logoutCommand,
  resolveAccount,
  validPreference,
  type AccountPreferences,
} from "./aiAccounts";

const accounts = [
  { id: "c-work", provider: "claude", label: "Trabajo", createdAt: "" },
  { id: "c-home", provider: "claude", label: "Personal", createdAt: "" },
  { id: "x-client", provider: "codex", label: "Cliente", createdAt: "" },
];

const prefs = (over: Partial<AccountPreferences> = {}): AccountPreferences => ({
  accounts,
  taskPins: {},
  workspaceDefaults: [],
  providerDefaults: {},
  ...over,
});

const t = (key: string) => (key === "accounts.system" ? "System" : key === "accounts.deleted" ? "Deleted" : key);

describe("resolveAccount", () => {
  it("falls back to the system account when nothing is set", () => {
    expect(resolveAccount(prefs(), "claude", "chat", "w1")).toBeNull();
  });

  it("goes explicit, task, workspace, provider default — like the backend", () => {
    const all = prefs({
      providerDefaults: { claude: "c-home" },
      workspaceDefaults: [{ workspaceId: "w1", provider: "claude", account: "c-work" }],
      taskPins: { review: "system" },
    });
    expect(resolveAccount(all, "claude", "chat", "w2")).toBe("c-home");
    expect(resolveAccount(all, "claude", "chat", "w1")).toBe("c-work");
    expect(resolveAccount(all, "claude", "review", "w1")).toBeNull();
    expect(resolveAccount(all, "claude", "review", "w1", "c-home")).toBe("c-home");
  });

  it("skips a pin to a deleted account or another CLI's account", () => {
    const stale = prefs({ taskPins: { chat: "x-client" }, providerDefaults: { claude: "gone" } });
    expect(resolveAccount(stale, "claude", "chat", null)).toBeNull();
    expect(resolveAccount(stale, "codex", "chat", null)).toBe("x-client");
  });

  it("never gives Gemini or Cline an added account", () => {
    expect(resolveAccount(prefs({ providerDefaults: { gemini: "c-work" } }), "gemini", null, null, "c-work")).toBeNull();
  });
});

describe("account helpers", () => {
  it("keys the system account by provider alone", () => {
    expect(accountKey("claude", null)).toBe("claude");
    expect(accountKey("claude", "c-work")).toBe("claude|c-work");
  });

  it("names deleted and system accounts", () => {
    expect(accountName(accounts, null, t as never)).toBe("System");
    expect(accountName(accounts, "c-work", t as never)).toBe("Trabajo");
    expect(accountName(accounts, "gone", t as never)).toBe("Deleted");
  });

  it("calls the system account by the name the user gave it, and only that one", () => {
    expect(accountName(accounts, null, t as never, "Personal")).toBe("Personal");
    expect(accountName(accounts, "system", t as never, "Personal")).toBe("Personal");
    expect(accountName(accounts, null, t as never, "  ")).toBe("System");
    expect(accountName(accounts, "c-work", t as never, "Personal")).toBe("Trabajo");
  });

  it("keeps only preferences that still name one of this provider's accounts", () => {
    expect(validPreference(accounts, "claude", "c-work")).toBe("c-work");
    expect(validPreference(accounts, "claude", "x-client")).toBe("");
    expect(validPreference(accounts, "claude", "system")).toBe("system");
  });

  it("types each CLI's own sign-in, with a configured binary only when it needs no quoting", () => {
    expect(loginCommand("claude")).toBe("claude auth login");
    expect(loginCommand("codex", "/opt/bin/codex")).toBe("/opt/bin/codex login");
    expect(loginCommand("opencode", "/Applications/Open Code/opencode")).toBe("opencode auth login");
    expect(loginCommand("gemini")).toBe("agy");
    expect(loginCommand("cline")).toBeNull();
  });

  it("only types a sign-out for opencode, the CLI that asks which provider", () => {
    expect(logoutCommand("opencode")).toBe("opencode auth logout");
    expect(logoutCommand("opencode", "/opt/bin/opencode")).toBe("/opt/bin/opencode auth logout");
    expect(logoutCommand("claude")).toBeNull();
    expect(logoutCommand("codex")).toBeNull();
  });
});
