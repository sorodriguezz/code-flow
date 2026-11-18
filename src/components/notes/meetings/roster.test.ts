import { describe, expect, it } from "vitest";
import type { Meeting, MeetingLine, MeetingSpeaker, Voice } from "../../../lib/tauri/meetingsCommands";
import { currentTurn, foldName, initialRoster, rosterSections, missingVoices, rosterIds, rosterSummary, separatedCount, speakerTurn, totalPeople, turnsOf } from "./roster";

const voice = (id: string, name: string, isMe = false): Voice => ({ id, name, isMe, samples: 1, model: "m", createdAt: "", updatedAt: "" });
const VOICES = [voice("me", "Yo", true), voice("juan", "Juan"), voice("pedro", "Pedro"), voice("diego", "Diego")];
const meeting = (patch: Partial<Meeting> = {}): Meeting =>
  ({ id: "m1", kind: "virtual", speakersHint: 0, roster: [], ...patch }) as Meeting;
const speaker = (key: string, voiceId = ""): MeetingSpeaker => ({ key, name: "", color: 0, isMe: key === "me", voiceId, talkMs: 1000, hasVoice: true });
const line = (seq: number, speaker: string, startMs: number, endMs = startMs + 1000): MeetingLine =>
  ({ seq, channel: "system", speaker, startMs, endMs, text: "x", pass: "final", edited: false });

describe("the roster", () => {
  it("counts Tú in a call, and sends the clustering only the others", () => {
    const choice = { voiceIds: ["juan", "pedro", "diego"], unknown: 4 };
    expect(totalPeople(choice, VOICES, "virtual")).toBe(8);
    expect(separatedCount(choice, VOICES, "virtual")).toBe(7);
    expect(rosterSummary(choice, VOICES, "virtual", "Tú")).toEqual({ total: 8, names: ["Tú", "Juan", "Pedro", "Diego"], more: 4 });
  });

  it("in a room the user's own voice is one more chip, not a given", () => {
    const choice = { voiceIds: ["me", "juan"], unknown: 1 };
    expect(totalPeople(choice, VOICES, "room")).toBe(3);
    expect(separatedCount(choice, VOICES, "room")).toBe(3);
    expect(rosterIds(choice, VOICES, "room")).toEqual(["me", "juan"]);
    // In a call the user's saved voice is the fixed Tú: ticking it adds nobody.
    expect(rosterIds(choice, VOICES, "virtual")).toEqual(["juan"]);
  });

  it("drops voices deleted since they were ticked", () => {
    expect(rosterIds({ voiceIds: ["juan", "gone"], unknown: 0 }, VOICES, "virtual")).toEqual(["juan"]);
  });

  it("opens on last time's roster, or on who was recognised", () => {
    expect(initialRoster(meeting({ roster: ["juan", "diego"], speakersHint: 7 }), [], VOICES)).toEqual({ voiceIds: ["juan", "diego"], unknown: 5 });
    const speakers = [speaker("me", "me"), speaker("p0", "juan"), speaker("p1"), speaker("p2"), speaker("p3", "pedro")];
    expect(initialRoster(meeting(), speakers, VOICES)).toEqual({ voiceIds: ["juan", "pedro"], unknown: 2 });
    expect(initialRoster(meeting({ speakersHint: 6 }), speakers, VOICES)).toEqual({ voiceIds: ["juan", "pedro"], unknown: 4 });
  });

  it("says which named voices were not heard", () => {
    const lines = [line(1, "p0", 0)];
    const missing = missingVoices(meeting({ roster: ["juan", "diego"] }), [speaker("p0", "juan")], lines, VOICES);
    expect(missing.map((v) => v.name)).toEqual(["Diego"]);
  });
});

describe("walking a speaker's turns", () => {
  const lines = [line(1, "a", 0), line(2, "a", 1000), line(3, "b", 3000), line(4, "a", 6000), line(5, "b", 9000), line(6, "a", 12000)];

  it("groups consecutive lines into one turn", () => {
    expect(turnsOf(lines).map((t) => `${t.speaker}@${t.startMs}`)).toEqual(["a@0", "b@3000", "a@6000", "b@9000", "a@12000"]);
  });

  it("goes to the next turn ahead, past the one it just landed on, and wraps", () => {
    expect(speakerTurn(lines, "a", 3500, 1)).toEqual({ startMs: 6000, index: 2, total: 3 });
    expect(speakerTurn(lines, "a", 6000, 1)).toEqual({ startMs: 12000, index: 3, total: 3 });
    expect(speakerTurn(lines, "a", 12000, 1)).toEqual({ startMs: 0, index: 1, total: 3 });
    expect(speakerTurn(lines, "b", 0, 1)).toEqual({ startMs: 3000, index: 1, total: 2 });
  });

  it("goes back to the turn before, and wraps", () => {
    expect(speakerTurn(lines, "a", 6000, -1)).toEqual({ startMs: 0, index: 1, total: 3 });
    expect(speakerTurn(lines, "a", 0, -1)).toEqual({ startMs: 12000, index: 3, total: 3 });
  });

  it("is null for someone who never speaks", () => {
    expect(speakerTurn(lines, "z", 0, 1)).toBeNull();
  });

  it("knows whose turn the playhead is in", () => {
    expect(currentTurn(lines, 7000)).toEqual({ speaker: "a", index: 2, total: 3 });
    expect(currentTurn(lines, 9000)).toEqual({ speaker: "b", index: 2, total: 2 });
    expect(currentTurn([line(1, "a", 500)], 0)).toBeNull();
  });
});

describe("the voice list", () => {
  const MANY = [voice("me", "Yo", true), voice("a", "Fernando"), voice("b", "Jennifer"), voice("c", "Ana María"), voice("d", "José"), voice("e", "beto")];
  const names = (vs: Voice[]) => vs.map((v) => v.name);

  it("puts the voices this meeting points at first, the rest alphabetically", () => {
    const got = rosterSections(MANY, { kind: "virtual", roster: ["d"] }, [speaker("p0", "b")], "");
    expect(names(got.suggested)).toEqual(["Jennifer", "José"]);
    expect(names(got.rest)).toEqual(["Ana María", "beto", "Fernando"]);
  });

  it("offers the user's own voice only in a room", () => {
    expect(names(rosterSections(MANY, { kind: "room", roster: [] }, [], "yo").rest)).toEqual(["Yo"]);
    expect(names(rosterSections(MANY, { kind: "virtual", roster: [] }, [], "yo").rest)).toEqual([]);
  });

  it("searches without accents or case, word starts first", () => {
    expect(foldName("  José ")).toBe("jose");
    expect(names(rosterSections(MANY, { kind: "virtual", roster: [] }, [], "JOSE").rest)).toEqual(["José"]);
    expect(names(rosterSections(MANY, { kind: "virtual", roster: [] }, [], "mar").rest)).toEqual(["Ana María"]);
    expect(names(rosterSections(MANY, { kind: "virtual", roster: [] }, [], "fer").rest)).toEqual(["Fernando", "Jennifer"]);
  });
});
