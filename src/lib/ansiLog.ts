/**
 * A log viewer's parser: ANSI colours, carriage returns, and the scaffolding CI systems wrap
 * their output in.
 *
 * Written rather than borrowed because there was nothing to borrow. The only ANSI rendering in
 * this app is xterm.js inside `TerminalPane`, and that component is welded to a pty session in
 * the backend (`registerTerminalSink`, `writeTerminal`, `resizeTerminal`) — there is no way to
 * hand it a string that was downloaded rather than typed. And there is no virtualisation library
 * in this project by explicit decision (`DataGrid.tsx`), so the output here is a flat array of
 * lines the pane windows itself.
 *
 * What it deliberately does not do: cursor movement, scroll regions, alternate screens. A CI log
 * is a transcript, not a terminal — the only escape sequences that appear in one in practice are
 * SGR colour, the erase-in-line that follows a carriage return, and the fold markers below.
 */

/** A run of characters that share one appearance. */
export interface LogSpan {
  text: string;
  /** A CSS colour — a `--cf-*` token for the sixteen basic colours, `rgb(...)` for true colour. */
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface LogLine {
  /** 1-based, as the host numbered it — folding must not renumber the log. */
  n: number;
  spans: LogSpan[];
  /** The line without any styling, for search and for the error heuristic. */
  text: string;
  /**
   * Fold structure, when the host emitted any. `depth` is how many groups this line is inside,
   * so a collapsed group can hide its body without a second pass.
   */
  group: "open" | "close" | null;
  depth: number;
  /** What the host itself said about this line. Only ever set from an explicit marker. */
  severity: "error" | "warning" | null;
}

/**
 * The sixteen basic ANSI colours, mapped onto this app's tokens rather than onto literal hexes.
 *
 * A log renders on `--cf-log-bg`, which is near-white on the light theme and near-black on the
 * dark one. A hard-coded `#00ff00` for "green" is illegible on one of them, and CI output is
 * mostly green ticks and red crosses — so the four that carry meaning borrow the semantic tokens
 * the rest of the app already tunes per theme, and the rest fall back to the text colour.
 */
const BASIC: Record<number, string> = {
  30: "var(--cf-text-muted)", // black → muted, because true black on a dark log is invisible
  31: "var(--cf-danger)",
  32: "var(--cf-success)",
  33: "var(--cf-warning)",
  34: "var(--cf-blue)",
  35: "var(--cf-violet)",
  36: "var(--cf-blue)",
  37: "var(--cf-text)",
};

/** The bright pair of each basic colour. Same tokens: the themes already carry the contrast. */
const BRIGHT: Record<number, string> = {
  90: "var(--cf-text-muted)",
  91: "var(--cf-danger)",
  92: "var(--cf-success)",
  93: "var(--cf-warning)",
  94: "var(--cf-blue)",
  95: "var(--cf-violet)",
  96: "var(--cf-blue)",
  97: "var(--cf-text)",
};

/** The 256-colour cube, reduced to the basic sixteen. Approximate on purpose — see `sgr`. */
function from256(index: number): string | undefined {
  if (index < 16) return BASIC[30 + (index % 8)] ?? BRIGHT[90 + (index % 8)];
  if (index >= 232) return index > 243 ? "var(--cf-text)" : "var(--cf-text-muted)";
  // The 6×6×6 cube: pick whichever channel dominates.
  const c = index - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  if (r === g && g === b) return r > 2 ? "var(--cf-text)" : "var(--cf-text-muted)";
  if (r >= g && r >= b) return "var(--cf-danger)";
  if (g >= r && g >= b) return "var(--cf-success)";
  return "var(--cf-blue)";
}

interface Style {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Applies one SGR sequence's parameters to the running style. */
function sgr(style: Style, params: number[]): Style {
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      // A reset clears everything, including anything set earlier in this same sequence.
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 39) delete next.color;
    else if (p >= 30 && p <= 37) next.color = BASIC[p];
    else if (p >= 90 && p <= 97) next.color = BRIGHT[p];
    else if (p === 38 || p === 48) {
      // Extended colour. `38;5;n` is the 256 palette, `38;2;r;g;b` is true colour. Background
      // (48) is parsed only so its parameters are consumed rather than read as foreground codes.
      const mode = params[i + 1];
      if (mode === 5) {
        if (p === 38) next.color = from256(params[i + 2] ?? 7);
        i += 2;
      } else if (mode === 2) {
        if (p === 38) {
          const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
          next.color = `rgb(${r} ${g} ${b})`;
        }
        i += 4;
      }
    }
    // Everything else — backgrounds, blink, inverse — is dropped. A log that repaints its own
    // background fights the pane's, and nothing in CI output depends on it.
  }
  return next;
}

// eslint-disable-next-line no-control-regex -- the point of this module is control characters
const ANSI = /\u001b\[([0-9;]*)([A-Za-z])/g;

/**
 * Splits one line into styled spans, carrying `style` in and returning the style left at the end
 * so it continues onto the next line — which is how a tool that sets a colour and prints ten
 * lines before resetting expects to be read.
 */
function spansOf(line: string, style: Style): { spans: LogSpan[]; style: Style; text: string } {
  const spans: LogSpan[] = [];
  let plain = "";
  let current = style;
  let last = 0;
  ANSI.lastIndex = 0;
  let match: RegExpExecArray | null;

  const push = (text: string) => {
    if (!text) return;
    plain += text;
    // Merged with the previous span when the appearance is identical, so a line with a reset
    // between every word doesn't become forty DOM nodes.
    const prev = spans[spans.length - 1];
    if (prev && sameStyle(prev, current)) prev.text += text;
    else spans.push({ text, ...current });
  };

  while ((match = ANSI.exec(line)) !== null) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === "m") {
      const params = match[1].split(";").filter((p) => p !== "").map(Number);
      current = sgr(current, params.length ? params : [0]);
    }
    // Any other final byte (K = erase in line, the one that follows a `\r`) is consumed and
    // dropped: the carriage-return handling below already produced the visible text.
  }
  push(line.slice(last));

  return { spans, style: current, text: plain };
}

function sameStyle(a: LogSpan, b: Style): boolean {
  return (
    a.color === b.color &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline
  );
}

/**
 * What a carriage return leaves visible.
 *
 * A progress bar writes `10%\r20%\r30%` and means "30%". Keeping the last segment is the standard
 * approximation and the one every log viewer makes; it is only wrong when a shorter write
 * partially overwrites a longer one, which produces a line no reader was meant to see anyway.
 * A trailing `\r` before the newline is CRLF, not an overwrite, and is dropped rather than
 * treated as one.
 */
function afterCarriageReturns(line: string): { dropped: string; visible: string } {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  const at = body.lastIndexOf("\r");
  return at === -1
    ? { dropped: "", visible: body }
    : { dropped: body.slice(0, at), visible: body.slice(at + 1) };
}

/** `2026-08-21T17:04:11.1234567Z ` at the head of a line, which Azure and Actions both prepend. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s/;

export interface ParseOptions {
  /** Drop the per-line ISO timestamp. On by default: it is 28 identical characters in front of
   *  every line, and the pane shows line numbers anyway. */
  stripTimestamps?: boolean;
}

/**
 * Turns a raw job log into lines the pane can render.
 *
 * The input is exactly what the host served — the backend does not rewrite logs, so that what the
 * pane shows is what the provider shows. All the interpretation is here.
 */
export function parseLog(raw: string, options: ParseOptions = {}): LogLine[] {
  const stripTimestamps = options.stripTimestamps !== false;
  const out: LogLine[] = [];
  let style: Style = {};
  let depth = 0;

  const source = raw.split("\n");
  // A trailing newline produces a final empty element that is not a line of the log.
  if (source.length > 0 && source[source.length - 1] === "") source.pop();

  for (let i = 0; i < source.length; i++) {
    const physical = stripTimestamps ? source[i].replace(TIMESTAMP, "") : source[i];
    const cr = afterCarriageReturns(physical);
    // The overwritten segments are gone from the text but their escape codes still happened. A
    // progress bar that sets a colour before its last `\r` and resets after it would otherwise
    // leave every following line tinted — and on this screen a red line means "here is the
    // failure", so a whole log stained red is the worst possible way to be wrong.
    if (cr.dropped) style = spansOf(cr.dropped, style).style;
    let line = cr.visible;

    // Read on the **physical** line: GitLab writes `section_start:…\r\u001b[0K<header>` as one
    // line, so looking after the carriage-return collapse would never see the marker at all — and
    // GitLab is the provider whose logs always carry them.
    const bare = physical.replace(ANSI, "").trim();
    let group: LogLine["group"] = null;
    let severity: LogLine["severity"] = null;

    if (bare.startsWith("##[group]")) {
      group = "open";
      line = line.replace("##[group]", "");
    } else if (bare.startsWith("##[endgroup]")) {
      group = "close";
      line = line.replace("##[endgroup]", "");
    } else if (bare.startsWith("section_start:")) {
      group = "open";
      // `section_start:1755795851:step_script` optionally followed by the human label.
      line = line.replace(/section_start:\d+:[^\s\r]*/, "").trim();
    } else if (bare.startsWith("section_end:")) {
      group = "close";
      line = line.replace(/section_end:\d+:[^\s\r]*/, "").trim();
    } else if (bare.startsWith("##[error]")) {
      severity = "error";
      line = line.replace("##[error]", "");
    } else if (bare.startsWith("##[warning]")) {
      severity = "warning";
      line = line.replace("##[warning]", "");
    } else if (bare.startsWith("##[command]") || bare.startsWith("##[section]")) {
      line = line.replace(/##\[(command|section)\]/, "");
    } else if (bare.startsWith("##[debug]") || bare.startsWith("##[notice]")) {
      line = line.replace(/##\[(debug|notice)\]/, "");
    }

    if (group === "close" && depth > 0) depth -= 1;

    const parsed = spansOf(line, style);
    style = parsed.style;

    out.push({
      n: i + 1,
      spans: parsed.spans,
      text: parsed.text,
      group,
      depth,
      severity,
    });

    if (group === "open") depth += 1;
  }

  return out;
}

/**
 * Whether a line looks like the failure, for the "jump to the first error" control.
 *
 * Deliberately conservative, and deliberately a heuristic rather than a promise: the host's own
 * `##[error]` marker is checked first and is the only authoritative signal. The rest are the
 * shapes that actually appear at the point a build dies — a Rust panic, a cargo/rustc error, an
 * npm failure, a test summary line — chosen because each one is a phrase that a *passing* build
 * does not print. Anything looser (a bare "error") matches half of every verbose log.
 */
const ERROR_SHAPES = [
  /^\s*error(\[[A-Z]\d+\])?:/i,
  /\bpanicked at\b/,
  /\bnpm ERR!/,
  /\bFAILED\b/,
  /^\s*✖/,
  /\bexit code [1-9]/i,
  /^\s*fatal:/i,
  /\bAssertionError\b/,
  /\bTraceback \(most recent call last\)/,
];

export function looksLikeError(line: LogLine): boolean {
  if (line.severity === "error") return true;
  return ERROR_SHAPES.some((shape) => shape.test(line.text));
}

/** The index of the first line worth jumping to, or -1. */
export function firstErrorIndex(lines: LogLine[]): number {
  return lines.findIndex(looksLikeError);
}
