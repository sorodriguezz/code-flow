import { describe, expect, it, vi } from "vitest";
import type { CallSeat, PoolVoice } from "../../../lib/tauri/teamCallCommands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));

const { clock, engineTitle, enteredSeats, seatStatus, shortModel, transcriptText } = await import("./CallRoom");
const { nearestPitch, voiceGroups } = await import("../roster/VoiceField");
const en = (_es: string, text: string) => text;
const seat = (state: CallSeat["state"]): CallSeat => ({ memberId: "dba", agentId: "a", name: "DBA", role: "", icon: "", color: "", lead: false, state, note: "", hand: 0, voice: { id: "", pitch: 1, rate: 1 }, voiceLabel: "", provider: "claude", model: "claude-haiku-5-5", ownModel: "claude-opus-5-5", account: "Trabajo" });

describe("call room", () => {
  it("counts the call in minutes and seconds", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(192_400)).toBe("03:12");
    expect(clock(-5)).toBe("00:00");
  });

  it("says what each participant is doing, and that it is working only when it is not in the call's turn", () => {
    expect(seatStatus(seat("speaking"), true, en)).toEqual({ label: "Speaking", tone: "speaking" });
    expect(seatStatus(seat("looking"), false, en).label).toBe("Reading the code");
    expect(seatStatus(seat("hand"), false, en).label).toBe("Has something to say");
    expect(seatStatus(seat("listening"), true, en)).toEqual({ label: "Working", tone: "busy" });
    expect(seatStatus(seat("listening"), false, en)).toEqual({ label: "Listening", tone: "rest" });
  });

  it("says which model an agent talks with, which it works with, and as whom", () => {
    expect(engineTitle(seat("listening"), en)).toBe("On the call it answers with claude-haiku-5-5; to look at the code and to work it uses claude-opus-5-5 · Account: Trabajo");
    // One model for both, on the provider's own login.
    expect(engineTitle({ ...seat("listening"), model: "gpt-6-luna", ownModel: "gpt-6-luna", account: "" }, en)).toBe("Answers and works with gpt-6-luna · Account: the system's");
  });

  it("names a model without what its provider's mark already says", () => {
    expect(shortModel("claude-haiku-5-5")).toBe("haiku-5-5");
    expect(shortModel("gpt-6-luna")).toBe("gpt-6-luna");
    expect(shortModel("")).toBe("");
  });

  it("copies the transcript as who said what and when, without the call's own notes", () => {
    const line = (who: string, name: string, text: string, atMs: number, kind: "say" | "note" = "say") => ({ id: `${atMs}`, atMs, who, name, text, partial: false, kind });
    expect(transcriptText([line("user", "", "DBA, ¿cómo ves la base?", 5_000), line("call", "", "DBA consulta el código", 6_000, "note"), line("dba", "DBA", "Faltan dos índices.", 65_000)], en)).toBe(
      "[00:05] You: DBA, ¿cómo ves la base?\n[01:05] DBA: Faltan dos índices.",
    );
  });
});

describe("who the room shows", () => {
  const line = (who: string, text: string, kind: "say" | "note" = "say") => ({ id: `${who}-${text}`, atMs: 0, who, name: who, text, partial: false, kind });
  const at = (memberId: string, state: CallSeat["state"] = "listening", hand = 0): CallSeat => ({ ...seat(state), memberId, name: memberId, hand });

  it("is nobody of a team that has not been spoken to", () => {
    expect(enteredSeats([], [at("dba"), at("qa")], [line("user", "Hola"), line("lead", "Hola, aquí Arquitecto")])).toEqual([]);
  });

  it("is whoever said something or is doing something, in the order they came in", () => {
    const seats = [at("dba"), at("qa", "thinking"), at("ux"), at("devops", "hand", 1)];
    // QA is thinking and DevOps waits for the word; the DBA spoke before either.
    expect(enteredSeats([], seats, [line("user", "DBA, ¿y la base?"), line("dba", "Faltan dos índices.")])).toEqual(["dba", "qa", "devops"]);
    // A note of the call's own about someone is not that someone speaking.
    expect(enteredSeats([], [at("ux")], [line("ux", "UX consulta el código", "note")])).toEqual([]);
  });

  it("keeps whoever came in, where they were, and forgets whoever left the team", () => {
    const before = ["qa", "gone", "dba"];
    expect(enteredSeats(before, [at("dba"), at("qa"), at("ux", "looking")], [])).toEqual(["qa", "dba", "ux"]);
  });
});

describe("an agent's voice", () => {
  const voices: PoolVoice[] = [
    { id: "kokoro-af_heart", label: "Kokoro · Heart", kind: "local", lang: "en" },
    { id: "es_MX-claude-high", label: "Claude", kind: "local", lang: "es" },
    { id: "system:Paulina", label: "Paulina", kind: "system", lang: "es" },
    { id: "cloud:openai:alloy", label: "OpenAI · alloy", kind: "cloud", lang: "multi" },
  ];

  it("is listed by where it comes from, the app's language first, with «Automatic» on top", () => {
    const groups = voiceGroups(voices, "es", en);
    expect(groups[0]).toEqual({ value: "", label: "Automatic" });
    expect(groups.slice(1).map((group) => ("options" in group ? [group.label, group.options.map((o) => o.label)] : null))).toEqual([
      ["Downloaded voices", ["Claude", "Kokoro · Heart · English"]],
      ["System voices", ["Paulina"]],
      ["Service (the text leaves this computer)", ["OpenAI · alloy"]],
    ]);
  });

  it("shows the nearest pitch offered for one saved before", () => {
    expect(nearestPitch(1)).toBe(1);
    expect(nearestPitch(0.92)).toBe(0.95);
    expect(nearestPitch(1.03)).toBe(1.025);
    expect(nearestPitch(3)).toBe(1.05);
  });
});
