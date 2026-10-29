import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { trackUsage } from "../../lib/usageTracker";
import { parseOsc133, parseOsc633, parseOsc7 } from "./shellMarks";

/**
 * What a pane does with the shell integration's marks (see `shellMarks`): a dot at each prompt in
 * the colour of how its command ended, ⌘↑/⌘↓ between them, the output of the last command, the
 * folder the shell is in, and a call when a command finishes.
 *
 * A shell without the integration prints none of these, and then nothing here does anything — the
 * pane is exactly what it was.
 */
interface CommandRecord {
  prompt: IMarker;
  start?: IMarker;
  end?: IMarker;
  command?: string;
  startedAt?: number;
  exit?: number | null;
  decoration?: IDecoration;
}

export interface FinishedCommand {
  command: string | null;
  exit: number | null;
  ms: number;
}

export interface ShellIntegration extends IDisposable {
  /** Scrolls to the prompt above (`-1`) or below (`1`) the top of the viewport. Answers whether there
   *  was one — no marks means the chord was not this pane's to take. */
  jump: (direction: -1 | 1) => boolean;
  /** What the last finished command printed, or `null` when the shell gives no marks. */
  lastOutput: () => string | null;
  /** Whether the shell has spoken the protocol at all. */
  active: () => boolean;
}

/** Records kept: the marks of older ones are released, so a session left running for days does not
 *  hold a marker per command it ever ran. */
const KEPT = 500;

export function installShellIntegration(
  term: Terminal,
  hooks: {
    onCwd: (cwd: string) => void;
    onFinished: (done: FinishedCommand) => void;
    /** Read at the moment a mark is drawn, so the colours follow the theme. */
    colors: () => { ok: string; failed: string };
  },
): ShellIntegration {
  const records: CommandRecord[] = [];
  let spoke = false;
  const current = () => records[records.length - 1];

  const drop = (record: CommandRecord) => {
    record.decoration?.dispose();
    record.prompt.dispose();
    record.start?.dispose();
    record.end?.dispose();
  };

  const decorate = (record: CommandRecord) => {
    if (record.prompt.isDisposed) return;
    const { ok, failed } = hooks.colors();
    const color = record.exit === 0 ? ok : failed;
    const decoration = term.registerDecoration({
      marker: record.prompt,
      x: 0,
      width: 1,
      layer: "top",
      overviewRulerOptions: { color, position: "left" },
    });
    if (!decoration) return;
    decoration.onRender((element) => {
      // A bar on the cell's left edge, not a filled cell: the prompt's first character stays legible.
      element.style.boxShadow = `inset 2px 0 0 ${color}`;
      element.style.pointerEvents = "none";
    });
    record.decoration = decoration;
  };

  const subscriptions: IDisposable[] = [
    term.parser.registerOscHandler(133, (data) => {
      const mark = parseOsc133(data);
      if (!mark) return false;
      spoke = true;
      if (mark.kind === "prompt") {
        const prompt = term.registerMarker(0);
        if (prompt) {
          records.push({ prompt });
          while (records.length > KEPT) drop(records.shift()!);
        }
      } else if (mark.kind === "start") {
        const record = current();
        if (record && !record.start) {
          record.start = term.registerMarker(0);
          record.startedAt = Date.now();
        }
      } else {
        const record = current();
        // A finish with no start is a prompt redrawn with no command run (a shell that sends D
        // anyway); there is nothing to colour or report.
        if (record && record.start && record.exit === undefined) {
          record.exit = mark.exit;
          // Settings › Estadísticas: that a command ran and whether it failed — never the command.
          trackUsage("action", "terminal.command");
          if (mark.exit !== null && mark.exit !== 0) trackUsage("error", "terminal.command");
          record.end = term.registerMarker(0);
          decorate(record);
          hooks.onFinished({ command: record.command ?? null, exit: mark.exit, ms: Date.now() - (record.startedAt ?? Date.now()) });
        }
      }
      return true;
    }),
    term.parser.registerOscHandler(633, (data) => {
      const command = parseOsc633(data);
      if (command === null) return false;
      const record = current();
      if (record) record.command = command;
      return true;
    }),
    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd) hooks.onCwd(cwd);
      // Not claimed: another handler (none today) may want it too, and returning false costs nothing.
      return false;
    }),
  ];

  const lineText = (line: number) => term.buffer.active.getLine(line)?.translateToString(true) ?? "";

  return {
    active: () => spoke,
    jump: (direction) => {
      const lines = records.map((record) => record.prompt.line).filter((line) => line >= 0);
      if (lines.length === 0) return false;
      const top = term.buffer.active.viewportY;
      const target = direction < 0 ? [...lines].reverse().find((line) => line < top) : lines.find((line) => line > top);
      if (target === undefined) {
        if (direction > 0) term.scrollToBottom();
        else term.scrollToTop();
      } else {
        term.scrollToLine(target);
      }
      return true;
    },
    lastOutput: () => {
      const record = [...records].reverse().find((entry) => entry.start && entry.end && entry.exit !== undefined);
      if (!record?.start || !record.end || record.start.line < 0) return null;
      const from = record.start.line;
      // D is printed on the line where the next prompt begins; the output ends on the line above,
      // unless the command printed nothing and the cursor never left the start line.
      const to = Math.max(from, record.end.line - 1);
      let text = "";
      for (let line = from; line <= to; line += 1) {
        const wrapped = term.buffer.active.getLine(line)?.isWrapped;
        text += (line > from && !wrapped ? "\n" : "") + lineText(line);
      }
      return text.replace(/\s+$/, "");
    },
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      for (const record of records) drop(record);
      records.length = 0;
    },
  };
}
