import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallLine, CallSeat, CallState } from "../lib/tauri/teamCallCommands";

const api = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(async () => {}), state: vi.fn(async () => null), mic: vi.fn(), notify: vi.fn(), follow: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: api.notify, followTarget: api.follow }));
vi.mock("../lib/tauri/teamCallCommands", async (original) => ({
  ...await original<typeof import("../lib/tauri/teamCallCommands")>(),
  teamCallStart: api.start, teamCallClose: api.close, teamCallState: api.state, teamCallMic: api.mic,
}));

const { acceptCallLine, acceptCallState, callOngoing, useTeamCallStore } = await import("./teamCallStore");
const { useToastStore } = await import("./toastStore");

const seat = (memberId: string, state: CallSeat["state"] = "listening"): CallSeat => ({
  memberId, agentId: `agent-${memberId}`, name: memberId.toUpperCase(), role: "", icon: "", color: "", lead: memberId === "lead", state, note: "", hand: 0, voice: { id: "", pitch: 1, rate: 1 }, voiceLabel: "", provider: "claude", model: "haiku", ownModel: "opus", account: "",
});
const call = (patch: Partial<CallState> = {}): CallState => ({
  id: "call", chatId: "chat", teamId: "team", teamName: "Equipo Agenda", workspaceId: "ws", lang: "es", phase: "live", startedAtMs: 0, seats: [seat("lead"), seat("dba")],
  mic: true, hearing: false, listening: "ready", missing: [], headphones: false, talk: "fast", wrap: null, countdownEndsMs: null, runId: null, error: "", lines: [], ...patch,
});
const line = (id: string, text: string, partial = false): CallLine => ({ id, atMs: 1000, who: "dba", name: "DBA", text, partial, kind: "say" });

beforeEach(() => {
  vi.clearAllMocks();
  useTeamCallStore.setState({ call: null, lines: [], minimized: false, starting: false });
  useToastStore.setState({ toasts: [] });
});

describe("team call", () => {
  it("starts a call and keeps what was already said apart from its state", async () => {
    api.start.mockResolvedValue(call({ lines: [line("1", "Hola")] }));
    await useTeamCallStore.getState().start("team", "repo");
    expect(api.start).toHaveBeenCalledWith("team", "repo");
    expect(useTeamCallStore.getState().call?.lines).toEqual([]);
    expect(useTeamCallStore.getState().lines.map((l) => l.text)).toEqual(["Hola"]);
  });

  it("is one at a time: calling again brings the call back, and another team is told to wait", async () => {
    useTeamCallStore.setState({ call: call(), minimized: true });
    await useTeamCallStore.getState().start("team", null);
    expect(api.start).not.toHaveBeenCalled();
    expect(useTeamCallStore.getState().minimized).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);

    await useTeamCallStore.getState().start("other", null);
    expect(api.start).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({ type: "error" });

    // One that ended and was left on screen gives way.
    useTeamCallStore.setState({ call: call({ phase: "ended" }) });
    api.start.mockResolvedValue(call({ id: "next" }));
    await useTeamCallStore.getState().start("other", null);
    expect(api.close).toHaveBeenCalled();
    expect(useTeamCallStore.getState().call?.id).toBe("next");
  });

  it("writes a line as it is said: the same id grows, a new one is added", () => {
    useTeamCallStore.setState({ call: call() });
    acceptCallLine(line("1", "El desarrollo", true));
    acceptCallLine(line("1", "El desarrollo está terminado.", false));
    acceptCallLine(line("2", "Falta un índice."));
    expect(useTeamCallStore.getState().lines.map((l) => [l.id, l.text, l.partial])).toEqual([["1", "El desarrollo está terminado.", false], ["2", "Falta un índice.", false]]);
    // With no call here — one begun in another window — nothing is written.
    useTeamCallStore.setState({ call: null, lines: [] });
    acceptCallLine(line("3", "x"));
    expect(useTeamCallStore.getState().lines).toEqual([]);
  });

  it("takes the state of its own call only, and says the team started when its window is folded away", () => {
    useTeamCallStore.setState({ call: call(), minimized: true });
    acceptCallState(call({ id: "somebody-else", phase: "ended" }));
    expect(useTeamCallStore.getState().call?.phase).toBe("live");

    acceptCallState(call({ phase: "started", runId: "run-1", wrap: { title: "Outbox", summary: "", decisions: [], tasks: [], open: [], closing: "" } }));
    expect(useTeamCallStore.getState().call?.phase).toBe("started");
    expect(api.notify).toHaveBeenCalledWith(expect.objectContaining({
      titleKey: "notifications.teamCallStarted", params: { team: "Equipo Agenda" }, workspaceId: "ws", detail: "Outbox",
      target: { view: "agents", select: { kind: "teamRun", id: "run-1" } },
    }));
    expect(useToastStore.getState().toasts).toHaveLength(1);
    // Said once: the same state again says nothing more.
    acceptCallState(call({ phase: "started", runId: "run-1" }));
    expect(api.notify).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a start that is being watched: the call's window is open", () => {
    useTeamCallStore.setState({ call: call(), minimized: false });
    acceptCallState(call({ phase: "started", runId: "run-1" }));
    expect(api.notify).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("folds its window to the chip and brings it back, and closing lets go of the call", async () => {
    useTeamCallStore.setState({ call: call() });
    useTeamCallStore.getState().minimize();
    expect(useTeamCallStore.getState().minimized).toBe(true);
    useTeamCallStore.getState().restore();
    expect(useTeamCallStore.getState().minimized).toBe(false);
    await useTeamCallStore.getState().close();
    expect(api.close).toHaveBeenCalled();
    expect(useTeamCallStore.getState().call).toBeNull();
  });

  it("counts a call as going on until it has handed over or ended", () => {
    expect(["live", "closing", "countdown", "starting"].every((phase) => callOngoing(call({ phase: phase as CallState["phase"] })))).toBe(true);
    expect(callOngoing(call({ phase: "started" }))).toBe(false);
    expect(callOngoing(call({ phase: "ended" }))).toBe(false);
    expect(callOngoing(null)).toBe(false);
  });
});
