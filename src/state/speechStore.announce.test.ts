import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One voice at a time: while Codi's microphone is on, a notification the reading aloud would say is
 * handed to Codi (`codi_announce`) instead — said in Codi's voice and logged in its window — rather
 * than spoken a second time over it. Only the main window's notifications are said, and the quiet
 * rules (a meeting being recorded, a dictation under way) hold for either voice.
 */

const calls = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
  pushed: [] as ((item: unknown) => void)[],
  main: true,
  recording: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.invoked.push({ cmd, args });
    if (cmd === "codi_status") {
      return { phase: "off", mic: false, sound: true, mode: "wake", listenModel: "", missing: [], error: null, talking: false, pttKey: null };
    }
    if (cmd === "speech_say") return 1;
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../lib/windowIdentity", () => ({
  WINDOW: { label: "main", main: true, satellite: null, openedIn: null },
  MAIN_LABEL: "main",
  isMainWindow: () => calls.main,
}));
vi.mock("../lib/tauri/commands", () => ({ getSettings: async () => ({}), setSetting: async () => {} }));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => {} }));
vi.mock("../lib/notificationSound", () => ({ setNotificationOutput: () => {} }));
vi.mock("./notificationStore", () => ({
  NOTIFICATION_SOURCE_LABEL: { review: "source.review", git: "source.git" },
  onNotificationPushed: (listener: (item: unknown) => void) => {
    calls.pushed.push(listener);
    return () => {};
  },
}));
vi.mock("./preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ spokenNotificationSources: ["review"] }) } }));
vi.mock("./meetingsStore", () => ({ useMeetingsStore: { getState: () => ({ status: { recording: calls.recording } }) } }));
vi.mock("./dictationStore", () => ({ useDictationStore: { getState: () => ({ phase: "idle" }) }, reportMicError: () => {} }));
vi.mock("./languageStore", () => ({
  translate: (key: string) => key,
  useLanguageStore: { getState: () => ({ language: "es" }) },
}));
vi.mock("./toastStore", () => ({ pushErrorToast: () => {} }));

const { ensureSpeechEvents, useSpeechStore } = await import("./speechStore");
const { useCodiStore } = await import("./codiStore");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function notify(source: string) {
  for (const listener of calls.pushed) listener({ source, titleKey: "review.done", params: {}, detail: "2 hallazgos" });
}

function micOn(on: boolean) {
  const current = useCodiStore.getState().state;
  if (current) useCodiStore.setState({ state: { ...current, mic: on, phase: on ? "idle" : "off" } });
}

const said = () => calls.invoked.filter((call) => call.cmd === "speech_say").map((call) => call.args?.text);
const announced = () => calls.invoked.filter((call) => call.cmd === "codi_announce").map((call) => call.args);

beforeAll(async () => {
  ensureSpeechEvents();
  await flush();
  // Quiet rules on, as they are by default.
  useSpeechStore.setState({ quietMeeting: true, quietDictation: true });
});

beforeEach(() => {
  calls.invoked.length = 0;
  calls.main = true;
  calls.recording = false;
  micOn(false);
});

describe("a notification to be said", () => {
  it("is read aloud while Codi is not listening", async () => {
    notify("review");
    await flush();
    expect(said()).toEqual(["source.review: review.done. 2 hallazgos"]);
    expect(announced()).toEqual([]);
  });

  it("goes to Codi while its microphone is on — and is not read aloud too", async () => {
    micOn(true);
    notify("review");
    await flush();
    expect(announced()).toEqual([{ text: "source.review: review.done. 2 hallazgos", source: "review" }]);
    expect(said()).toEqual([]);
  });

  it("keeps the quiet rules when Codi says it", async () => {
    micOn(true);
    calls.recording = true;
    notify("review");
    await flush();
    expect(announced()).toEqual([]);
    expect(said()).toEqual([]);
  });

  it("is the main window's alone to hand over", async () => {
    micOn(true);
    calls.main = false;
    notify("review");
    await flush();
    expect(announced()).toEqual([]);
    expect(said()).toEqual(["source.review: review.done. 2 hallazgos"]);
  });

  it("still needs its source to be one that is said", async () => {
    micOn(true);
    notify("git");
    await flush();
    expect(announced()).toEqual([]);
    expect(said()).toEqual([]);
  });
});
