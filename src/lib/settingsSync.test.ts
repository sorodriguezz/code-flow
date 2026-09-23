import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The listening half of `settings:changed`: what a window re-reads when another one writes a
 * setting — and, as much, what it leaves alone.
 *
 * Pinned because both failures are quiet. A watcher that never fires is a detached window still
 * wearing yesterday's accent; one that fires on its own echo re-reads over an optimistic write and
 * flickers two fast clicks back to the first.
 */

type Handler = (event: { payload: { key: string; origin: string } }) => void;

async function load(label: string) {
  vi.resetModules();
  let handler: Handler | null = null;
  const listen = vi.fn((_name: string, h: Handler) => {
    handler = h;
    return Promise.resolve(() => {});
  });
  vi.doMock("@tauri-apps/api/event", () => ({ listen }));
  vi.doMock("./windowIdentity", () => ({ WINDOW: { label } }));
  const { watchSettings } = await import("./settingsSync");
  const fire = (key: string, origin: string) => handler!({ payload: { key, origin } });
  return { watchSettings, fire, listen };
}

describe("watchSettings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-reads when another window writes a watched key", async () => {
    const { watchSettings, fire } = await load("sat-app-notes");
    const reload = vi.fn();
    watchSettings(["accent_color"], reload);

    fire("accent_color", "main");
    await vi.runAllTimersAsync();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("drops its own echo, and keys nobody watches", async () => {
    const { watchSettings, fire } = await load("main");
    const reload = vi.fn();
    watchSettings(["theme_preference"], reload);

    fire("theme_preference", "main");
    fire("layout_sidebar_width", "sat-app-notes");
    await vi.runAllTimersAsync();

    expect(reload).not.toHaveBeenCalled();
  });

  it("turns a burst of writes into one re-read, after the last of them", async () => {
    const { watchSettings, fire } = await load("sat-repo-p1");
    const reload = vi.fn();
    watchSettings((key) => key.startsWith("ai_provider") || key.endsWith("_model"), reload);

    fire("ai_provider_commit", "main");
    await vi.advanceTimersByTimeAsync(10);
    fire("claude_commit_model", "main");
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("listens once per window, however many stores register", async () => {
    const { watchSettings, fire, listen } = await load("sat-app-api_requests");
    const theme = vi.fn();
    const accent = vi.fn();
    watchSettings(["code_theme_dark"], theme);
    watchSettings(["accent_color"], accent);

    fire("accent_color", "main");
    await vi.runAllTimersAsync();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(accent).toHaveBeenCalledTimes(1);
    expect(theme).not.toHaveBeenCalled();
  });
});
