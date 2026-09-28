/**
 * Kernel text with ANSI colour codes — a traceback, a coloured log line — as HTML.
 *
 * **Every character of the text is escaped before anything is added around it.** The text is
 * whatever a program printed, and a program can print `<img onerror=…>`; the only markup in the
 * result is the `<span>`s this function writes, and the only things inside their `class`/`style`
 * are values computed here from the escape's *numbers* — never a byte of the text itself.
 *
 * Colours: the sixteen basic ones as `nb-ansi-fg-N`/`nb-ansi-bg-N` classes, which the output area
 * maps onto the terminal palette of the scheme on screen (the same sixteen the terminal draws), and
 * the 256-colour and true-colour escapes IPython's tracebacks use as `rgb(...)`.
 */

const ESCAPE_HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_HTML[ch]);
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** The xterm 256-colour palette beyond the first sixteen, as `rgb(...)`. */
function color256(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return null;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const n = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(n / 36)]}, ${steps[Math.floor(n / 6) % 6]}, ${steps[n % 6]})`;
}

function channel(value: number | undefined): number {
  return Math.max(0, Math.min(255, Math.trunc(value ?? 0)));
}

/** Applies one SGR escape's parameters to the running style. */
function applySgr(style: Style, params: number[]): Style {
  let next: Style = { ...style };
  for (let k = 0; k < params.length; k++) {
    const p = params[k];
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p >= 30 && p <= 37) next.fg = `c${p - 30}`;
    else if (p >= 90 && p <= 97) next.fg = `c${p - 90 + 8}`;
    else if (p === 39) delete next.fg;
    else if (p >= 40 && p <= 47) next.bg = `c${p - 40}`;
    else if (p >= 100 && p <= 107) next.bg = `c${p - 100 + 8}`;
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      const target: "fg" | "bg" = p === 38 ? "fg" : "bg";
      if (params[k + 1] === 5) {
        const index = params[k + 2] ?? -1;
        const rgb = index >= 0 && index < 16 ? `c${index}` : color256(index);
        if (rgb) next[target] = rgb;
        k += 2;
      } else if (params[k + 1] === 2) {
        next[target] = `rgb(${channel(params[k + 2])}, ${channel(params[k + 3])}, ${channel(params[k + 4])})`;
        k += 4;
      }
    }
    // Blink, inverse, conceal, fonts: nothing a notebook output needs.
  }
  return next;
}

function open(style: Style): string {
  const classes: string[] = [];
  const css: string[] = [];
  if (style.fg) {
    if (style.fg.startsWith("c")) classes.push(`nb-ansi-fg-${style.fg.slice(1)}`);
    else css.push(`color: ${style.fg}`);
  }
  if (style.bg) {
    if (style.bg.startsWith("c")) classes.push(`nb-ansi-bg-${style.bg.slice(1)}`);
    else css.push(`background-color: ${style.bg}`);
  }
  if (style.bold) classes.push("nb-ansi-bold");
  if (style.dim) classes.push("nb-ansi-dim");
  if (style.italic) classes.push("nb-ansi-italic");
  if (style.underline) classes.push("nb-ansi-underline");
  if (classes.length === 0 && css.length === 0) return "";
  const attrs = [classes.length ? `class="${classes.join(" ")}"` : "", css.length ? `style="${css.join("; ")}"` : ""];
  return `<span ${attrs.filter(Boolean).join(" ")}>`;
}

/** SGR and every other CSI escape (cursor moves, erase-in-line), OSC ones (titles, links), and a
 *  stray ESC that starts nothing well-formed. */
const ESCAPES = /\x1b\[([0-9;?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;

/**
 * Text → HTML. SGR escapes become spans; every other escape is dropped (the text is a transcript,
 * not a screen); everything else is escaped.
 */
export function ansiToHtml(text: string): string {
  let html = "";
  let style: Style = {};
  let spanOpen = false;
  let last = 0;
  const emit = (chunk: string) => {
    if (!chunk) return;
    if (!spanOpen) {
      const tag = open(style);
      if (tag) {
        html += tag;
        spanOpen = true;
      }
    }
    html += escapeHtml(chunk);
  };
  ESCAPES.lastIndex = 0;
  for (const match of text.matchAll(ESCAPES)) {
    emit(text.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[2] === "m") {
      const params = (match[1] ?? "")
        .split(";")
        .filter((p) => p !== "" && /^\d+$/.test(p))
        .map(Number);
      const next = applySgr(style, params.length ? params : [0]);
      if (spanOpen) {
        html += "</span>";
        spanOpen = false;
      }
      style = next;
    }
  }
  emit(text.slice(last));
  if (spanOpen) html += "</span>";
  return html;
}

/** Text without its escapes — for copying, for the AI's context. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "");
}
