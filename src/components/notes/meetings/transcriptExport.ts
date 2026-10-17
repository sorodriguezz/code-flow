import type { Meeting, MeetingLine, MeetingSpeaker } from "../../../lib/tauri/meetingsCommands";
import { clock, speakerName } from "./meetingLabels";

/** The formats a meeting's transcript is exported in. */
export type TranscriptFormat = "md" | "txt" | "srt";

/** The lines in reading order, next to each other when one person goes on speaking. */
function turns(lines: MeetingLine[], speakers: MeetingSpeaker[], kind: Meeting["kind"]) {
  const sorted = [...lines].filter((l) => l.text.trim()).sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  const out: { who: string; startMs: number; text: string[] }[] = [];
  for (const line of sorted) {
    const who = speakerName(line.speaker, speakers, kind);
    const last = out[out.length - 1];
    if (last && last.who === who) last.text.push(line.text.trim());
    else out.push({ who, startMs: line.startMs, text: [line.text.trim()] });
  }
  return out;
}

/** An SRT timestamp: `HH:MM:SS,mmm`. */
function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor((total % 3_600_000) / 60_000))}:${pad(Math.floor((total % 60_000) / 1000))},${pad(total % 1000, 3)}`;
}

/**
 * The transcript as a file: Markdown (a heading, then who said what with the time), plain text
 * (the same without marks) or subtitles (each line with its own times, named by its speaker).
 */
export function transcriptFile(
  format: TranscriptFormat,
  args: { title: string; when: string; lines: MeetingLine[]; speakers: MeetingSpeaker[]; kind: Meeting["kind"] },
): string {
  if (format === "srt") {
    return [...args.lines]
      .filter((l) => l.text.trim())
      .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq)
      .map((line, i) => `${i + 1}\n${srtTime(line.startMs)} --> ${srtTime(Math.max(line.endMs, line.startMs + 500))}\n${speakerName(line.speaker, args.speakers, args.kind)}: ${line.text.trim()}\n`)
      .join("\n");
  }
  const grouped = turns(args.lines, args.speakers, args.kind);
  if (format === "txt") {
    const head = [args.title, args.when].filter(Boolean).join(" — ");
    return `${head}\n\n${grouped.map((turn) => `[${clock(turn.startMs)}] ${turn.who}: ${turn.text.join(" ")}`).join("\n\n")}\n`;
  }
  const head = `# ${args.title}${args.when ? `\n\n_${args.when}_` : ""}`;
  return `${head}\n\n${grouped.map((turn) => `**${turn.who}** · ${clock(turn.startMs)}\n${turn.text.join(" ")}`).join("\n\n")}\n`;
}
