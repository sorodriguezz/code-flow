import { describe, expect, it } from "vitest";
import { transcriptFile } from "./transcriptExport";
import type { MeetingLine, MeetingSpeaker } from "../../../lib/tauri/meetingsCommands";

const line = (seq: number, speaker: string, startMs: number, text: string): MeetingLine => ({
  seq, channel: "mic", speaker, startMs, endMs: startMs + 2000, text, pass: "final", edited: false,
});
const speakers: MeetingSpeaker[] = [
  { key: "p0", name: "Ana", color: 0, isMe: false, voiceId: "", talkMs: 0, hasVoice: false },
  { key: "p1", name: "Luis", color: 1, isMe: false, voiceId: "", talkMs: 0, hasVoice: false },
];
const lines = [line(2, "p0", 3000, "y luego."), line(1, "p0", 0, "Hola,"), line(3, "p1", 65_000, "De acuerdo.")];
const base = { title: "Revisión", when: "16 oct", lines, speakers, kind: "room" as const };

describe("transcriptFile", () => {
  it("writes Markdown with one block per turn, in time order", () => {
    expect(transcriptFile("md", base)).toBe("# Revisión\n\n_16 oct_\n\n**Ana** · 00:00\nHola, y luego.\n\n**Luis** · 01:05\nDe acuerdo.\n");
  });
  it("writes plain text", () => {
    expect(transcriptFile("txt", base)).toBe("Revisión — 16 oct\n\n[00:00] Ana: Hola, y luego.\n\n[01:05] Luis: De acuerdo.\n");
  });
  it("writes subtitles with each line's times", () => {
    expect(transcriptFile("srt", base).split("\n").slice(0, 3)).toEqual(["1", "00:00:00,000 --> 00:00:02,000", "Ana: Hola,"]);
    expect(transcriptFile("srt", base)).toContain("00:01:05,000 --> 00:01:07,000\nLuis: De acuerdo.");
  });
});
