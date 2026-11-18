import type { Meeting, MeetingLine, MeetingSpeaker, Voice } from "../../../lib/tauri/meetingsCommands";

/**
 * Who was in a meeting, as the user tells it before the voices are separated — and the walk through
 * one person's turns that the speaker chips do. Pure, so the counting rules are tested apart from the
 * dialog that draws them.
 *
 * **The count is of people, and "Tú" is one of them.** The old menu asked for "N personas" and sent N
 * to the clustering of the call's side, where the user is not: told "8" for a call of eight, it made
 * eight groups out of the seven others. Here the user builds the list — Tú, the voices they saved,
 * and how many more they do not know — and the total is what they see, while the clustering gets
 * only the part of it the separated channel holds ([`separatedCount`]).
 */

/** The largest number of people the dialog accepts — a ceiling on typos, not on the clustering. */
export const MAX_PEOPLE = 99;

export interface RosterChoice {
  /** Saved voices ticked as present (`Voice.id`), in the order they were ticked. */
  voiceIds: string[];
  /** People present whose voice is not saved. */
  unknown: number;
}

/** In a call the microphone is the user's own channel: "Tú" is always there and never separated. */
export function meFixed(kind: Meeting["kind"]): boolean {
  return kind === "virtual";
}

/** The saved voices the dialog offers as chips: all of them, but the user's own in a call (it is the
 *  fixed "Tú" there). */
export function pickableVoices(voices: Voice[], kind: Meeting["kind"]): Voice[] {
  return meFixed(kind) ? voices.filter((v) => !v.isMe) : voices;
}

/** The ticked voices that still exist and can be ticked here. */
function ticked(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"]): Voice[] {
  const pickable = pickableVoices(voices, kind);
  return choice.voiceIds.map((id) => pickable.find((v) => v.id === id)).filter((v): v is Voice => v !== undefined);
}

/** How many people the clustering separates: the ticked voices and the unknown ones — "Tú" in a call
 *  is the microphone's, not one of them. What `meetings_reprocess` takes as `speakers`. */
export function separatedCount(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"]): number {
  return ticked(choice, voices, kind).length + Math.max(0, choice.unknown);
}

/** Everyone the user said was there, "Tú" in a call included. */
export function totalPeople(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"]): number {
  return separatedCount(choice, voices, kind) + (meFixed(kind) ? 1 : 0);
}

/** The ids sent as the roster: the ticked voices that exist, without the user's own in a call. */
export function rosterIds(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"]): string[] {
  return ticked(choice, voices, kind).map((v) => v.id);
}

/** Names for the summary line, in order — "Tú" first in a call — and how many more are unnamed. */
export function rosterSummary(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"], me: string): { total: number; names: string[]; more: number } {
  const names = [...(meFixed(kind) ? [me] : []), ...ticked(choice, voices, kind).map((v) => (v.isMe ? me : v.name))];
  const more = Math.max(0, choice.unknown);
  return { total: names.length + more, names, more };
}

/**
 * What the dialog opens on: the roster given last time, or else who the last separation recognised;
 * the unknown ones from the count given then, or from the people it could not name.
 */
export function initialRoster(meeting: Meeting, speakers: MeetingSpeaker[], voices: Voice[]): RosterChoice {
  const pickable = pickableVoices(voices, meeting.kind);
  const exists = (id: string) => pickable.some((v) => v.id === id);
  const roster = (meeting.roster ?? []).filter(exists);
  if (roster.length > 0) {
    return { voiceIds: roster, unknown: Math.max(0, meeting.speakersHint - roster.length) };
  }
  const separated = speakers.filter((s) => s.key.startsWith("p") || (!meFixed(meeting.kind) && s.key === "me"));
  const recognised = [...new Set(separated.map((s) => s.voiceId).filter((id) => id && exists(id)))];
  const unnamed = separated.filter((s) => !s.voiceId || !exists(s.voiceId)).length;
  const unknown = meeting.speakersHint > 0 ? Math.max(0, meeting.speakersHint - recognised.length) : unnamed;
  return { voiceIds: recognised, unknown };
}

/** A name or a query as it is compared: no accents, no case — "jose" finds "José". */
export function foldName(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

/**
 * The saved voices as the dialog lists them — there may be dozens, so they are split and sorted
 * rather than laid out as they come:
 *
 * - `suggested`: the voices this meeting already points at — the roster given last time, and those
 *   the last separation recognised. Most of the time the answer is in here.
 * - `rest`: everyone else, alphabetically.
 *
 * With a `query`, both keep only the names that contain it, the ones where it starts a word first —
 * so "fer" puts "Fernando" before "Jennifer".
 */
export function rosterSections(
  voices: Voice[],
  meeting: Pick<Meeting, "kind" | "roster">,
  speakers: MeetingSpeaker[],
  query: string,
): { suggested: Voice[]; rest: Voice[] } {
  const near = new Set([...(meeting.roster ?? []), ...speakers.map((s) => s.voiceId).filter(Boolean)]);
  const q = foldName(query);
  const rank = (v: Voice): number => {
    if (!q) return 0;
    const name = foldName(v.name);
    if (name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    return name.includes(q) ? 2 : -1;
  };
  const sorted = pickableVoices(voices, meeting.kind)
    .map((v) => ({ v, r: rank(v) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.v.name.localeCompare(b.v.name, undefined, { sensitivity: "base" }))
    .map((x) => x.v);
  return { suggested: sorted.filter((v) => near.has(v.id)), rest: sorted.filter((v) => !near.has(v.id)) };
}

/** The ticked voices, in the order they were ticked — the chips at the top of the dialog. */
export function tickedVoices(choice: RosterChoice, voices: Voice[], kind: Meeting["kind"]): Voice[] {
  return ticked(choice, voices, kind);
}

/** The voices the user said were there that no speaker of the transcript carries. */
export function missingVoices(meeting: Meeting, speakers: MeetingSpeaker[], lines: MeetingLine[], voices: Voice[]): Voice[] {
  const heard = new Set(speakers.filter((s) => lines.some((l) => l.speaker === s.key)).map((s) => s.voiceId).filter(Boolean));
  return (meeting.roster ?? [])
    .map((id) => voices.find((v) => v.id === id))
    .filter((v): v is Voice => v !== undefined && !heard.has(v.id) && !(meFixed(meeting.kind) && v.isMe));
}

/** One person's turn: their consecutive lines with nobody else between. */
export interface Turn {
  speaker: string;
  startMs: number;
  endMs: number;
}

export function turnsOf(lines: MeetingLine[]): Turn[] {
  const out: Turn[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.speaker === line.speaker) last.endMs = Math.max(last.endMs, line.endMs);
    else out.push({ speaker: line.speaker, startMs: line.startMs, endMs: line.endMs });
  }
  return out;
}

/** How far past a turn's start the playhead may be and still be "on" it: a jump lands exactly on the
 *  start, and the next press must move on rather than land there again. */
const ON_START_MS = 400;

/**
 * Where a speaker chip takes the playhead: `speaker`'s next turn after `positionMs` (`direction` 1),
 * or the one before (-1) — wrapping around at either end. `index` is 1-based among that speaker's
 * turns. `null` when they never speak.
 */
export function speakerTurn(lines: MeetingLine[], speaker: string, positionMs: number, direction: 1 | -1): { startMs: number; index: number; total: number } | null {
  const turns = turnsOf(lines).filter((t) => t.speaker === speaker);
  if (turns.length === 0) return null;
  let at: number;
  if (direction === 1) {
    at = turns.findIndex((t) => t.startMs > positionMs + ON_START_MS);
    if (at === -1) at = 0;
  } else {
    at = -1;
    turns.forEach((t, i) => {
      if (t.startMs < positionMs - ON_START_MS) at = i;
    });
    if (at === -1) at = turns.length - 1;
  }
  return { startMs: turns[at].startMs, index: at + 1, total: turns.length };
}

/** Whose turn `positionMs` is in — the last turn started by then — and which of theirs it is, 1-based,
 *  with how many they have: the "3/14" on the chip of whoever is speaking. `null` before the first. */
export function currentTurn(lines: MeetingLine[], positionMs: number): { speaker: string; index: number; total: number } | null {
  const turns = turnsOf(lines);
  let at = -1;
  for (let i = 0; i < turns.length && turns[i].startMs <= positionMs; i += 1) at = i;
  if (at === -1) return null;
  const speaker = turns[at].speaker;
  const theirs = turns.filter((t) => t.speaker === speaker);
  return { speaker, index: theirs.indexOf(turns[at]) + 1, total: theirs.length };
}
