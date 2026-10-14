import { beforeEach, describe, expect, it, vi } from "vitest";

/** The settings table, as the routing store sees it. */
const settings = new Map<string, string>();

vi.mock("../lib/tauri/commands", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  getSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.filter((key) => settings.has(key)).map((key) => [key, settings.get(key)!])),
  ),
  setSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
}));
vi.mock("../lib/settingsSync", () => ({ watchSettings: vi.fn() }));

const { useAiProviderStore } = await import("./aiProviderStore");

const routeOf = (task: string) => {
  const s = useAiProviderStore.getState();
  return [s.effectiveProviders[task], s.taskModels[task]];
};

/**
 * The store mirrors Rust's `route_for`: a row that inherits its provider inherits the model too.
 * The bug: changing a provider's base model left "Heredar" rows on whatever model had once been
 * picked on them, and switching the default provider revived that provider's old pin for the row.
 */
describe("routing", () => {
  beforeEach(() => {
    settings.clear();
    settings.set("ai_provider", "claude");
    settings.set("claude_model", "opus");
  });

  it("runs an inheriting row on the base model, whatever pins it carries", async () => {
    settings.set("claude_review_model", "stale-claude-pin");
    settings.set("codex_review_model", "stale-codex-pin");
    await useAiProviderStore.getState().init();
    expect(routeOf("review")).toEqual(["claude", "opus"]);

    settings.set("claude_model", "sonnet");
    await useAiProviderStore.getState().refresh();
    expect(routeOf("review")).toEqual(["claude", "sonnet"]);

    settings.set("codex_model", "gpt-base");
    await useAiProviderStore.getState().setProvider("codex");
    expect(routeOf("review")).toEqual(["codex", "gpt-base"]);
  });

  it("honours a pin only on a row that names its provider", async () => {
    settings.set("ai_provider_review", "claude");
    settings.set("claude_review_model", "haiku");
    await useAiProviderStore.getState().init();
    expect(routeOf("review")).toEqual(["claude", "haiku"]);
    expect(useAiProviderStore.getState().taskDefaults.review).toBe("opus");
  });

  it("pins the provider along with a model picked for a task", async () => {
    await useAiProviderStore.getState().init();
    await useAiProviderStore.getState().setTaskRouting("review", "claude", "haiku");
    expect(settings.get("ai_provider_review")).toBe("claude");
    expect(routeOf("review")).toEqual(["claude", "haiku"]);
  });

  it("follows the notes row, model included, while the meetings row inherits", async () => {
    settings.set("ai_provider_notes", "codex");
    settings.set("codex_notes_model", "gpt-notes");
    settings.set("codex_meetings_model", "stale-pin");
    await useAiProviderStore.getState().init();
    expect(routeOf("meetings")).toEqual(["codex", "gpt-notes"]);

    settings.set("ai_provider_meetings", "codex");
    await useAiProviderStore.getState().refresh();
    expect(routeOf("meetings")).toEqual(["codex", "stale-pin"]);
  });

  it("keeps the fast model as an inheriting commit row's default", async () => {
    settings.set("claude_commit_model", "stale-pin");
    await useAiProviderStore.getState().init();
    const { taskModels, taskDefaults } = useAiProviderStore.getState();
    expect(taskModels.commit).not.toBe("stale-pin");
    expect(taskModels.commit).not.toBe("opus");
    expect(taskModels.commit).toBe(taskDefaults.commit);
  });
});
