import type { Meeting, MeetingFacts, MeetingLine, MeetingSpeaker } from "../../../lib/tauri/meetingsCommands";
import { translate } from "../../../state/languageStore";

/**
 * How a meeting's speakers, times and facts read on screen and to the AI — one place, so the
 * transcript, the chips, the waveform's colours and the engine's prompt never disagree about who
 * "Persona 2" is.
 */

/** A hue per separated voice, picked to read on both themes. "Tú" takes the accent. */
const HUES = ["#0d9488", "#d97706", "#db2777", "#7c3aed", "#2563eb", "#65a30d", "#dc2626", "#0891b2"];

export function speakerColor(key: string, speakers: MeetingSpeaker[]): string {
  if (key === "me" || speakers.find((s) => s.key === key)?.isMe) return "var(--cf-accent)";
  if (key === "others") return "var(--cf-text-muted)";
  const index = Number.parseInt(key.replace(/^p/, ""), 10);
  return HUES[(Number.isFinite(index) ? index : 0) % HUES.length];
}

/** What a speaker is called: the name given, else "Tú", "Otros", "Persona 3". */
export function speakerName(key: string, speakers: MeetingSpeaker[], kind: Meeting["kind"]): string {
  const speaker = speakers.find((s) => s.key === key);
  if (speaker?.name.trim()) return speaker.name.trim();
  if (key === "me" || speaker?.isMe) return translate("meetings.speaker.me");
  if (key === "others") return translate(kind === "virtual" ? "meetings.speaker.others" : "meetings.speaker.room");
  const index = Number.parseInt(key.replace(/^p/, ""), 10);
  return translate("meetings.speaker.person", { n: (Number.isFinite(index) ? index : 0) + 1 });
}

/** `12:34`, `1:02:03` — the player's and the transcript's clock. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** "47 min", "1 h 12 min". */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return translate("meetings.minutes", { n: minutes });
  return translate("meetings.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function channelsOf(meeting: Meeting): string[] {
  try {
    const parsed = JSON.parse(meeting.channels);
    return Array.isArray(parsed) ? parsed : ["mic"];
  } catch {
    return ["mic"];
  }
}

/** Display names by key, for the AI. */
export function namesOf(speakers: MeetingSpeaker[], lines: MeetingLine[], kind: Meeting["kind"]): Record<string, string> {
  const keys = new Set([...speakers.map((s) => s.key), ...lines.map((l) => l.speaker)]);
  return Object.fromEntries([...keys].map((key) => [key, speakerName(key, speakers, kind)]));
}

export function factsOf(meeting: Meeting, title: string, speakers: MeetingSpeaker[], lines: MeetingLine[], language: string): MeetingFacts {
  const names = namesOf(speakers, lines, meeting.kind);
  const spoke = new Set(lines.map((l) => l.speaker));
  const date = new Date(meeting.startedAt);
  return {
    title: title || translate("notes.untitled"),
    date: Number.isNaN(date.getTime()) ? meeting.startedAt : date.toLocaleString(language, { dateStyle: "long", timeStyle: "short" }),
    duration: duration(meeting.durationMs),
    participants: [...spoke].map((key) => names[key] ?? key),
    language: language.startsWith("en") ? "English" : "español",
  };
}

/** The recipes every workspace has, by id — the instructions are in Rust (`meetings::ai::builtin`). */
export const BUILTIN_RECIPES = ["summary", "minutes", "decisions", "tasks", "plan", "agenda", "risks", "followup"] as const;
