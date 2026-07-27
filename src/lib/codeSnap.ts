/** Turns a code selection into a shareable image, the way VS Code's CodeSnap does.
 *
 * Painted straight onto a `<canvas>` rather than the usual DOM-to-image trick (serialising styled
 * HTML into an SVG `foreignObject` and rasterising that). Two reasons: `foreignObject` rendering
 * inside an `<img>` is the least reliable corner of every engine — and this app ships on WebKit,
 * where it has historically been the *most* broken — and painting directly means the preview and
 * the exported file come from one code path, so what you see cannot drift from what you save.
 *
 * The colours come from the same rule list Monaco highlights with (`tokenRulesFor`), so a
 * snapshot matches the editor it was taken from.
 */

import * as monaco from "monaco-editor";
import { resolveTokenRule, tokenRulesFor, type CodeTheme } from "./codeThemes";

/** Backdrops the card sits on. Gradients are the reason a code screenshot reads as a graphic
 * rather than a cropped window; `theme` and `none` are the escape hatches for docs and for
 * pasting onto an existing background. */
export const SNAP_BACKGROUNDS = [
  { id: "sunset", colors: ["#ff7e5f", "#feb47b"] },
  { id: "ocean", colors: ["#2e3192", "#1bffff"] },
  { id: "violet", colors: ["#8360c3", "#2ebf91"] },
  { id: "candy", colors: ["#f093fb", "#f5576c"] },
  { id: "slate", colors: ["#485563", "#29323c"] },
  { id: "theme", colors: [] },
  { id: "none", colors: [] },
] as const;

export type SnapBackgroundId = (typeof SNAP_BACKGROUNDS)[number]["id"];

export interface CodeSnapOptions {
  code: string;
  /** Monaco language id — `plaintext` when the file's language isn't known. */
  language: string;
  theme: CodeTheme;
  /** Line number the first line of `code` had in its file, so a snippet's gutter matches the
   * source it came from instead of restarting at 1. */
  startLine: number;
  /** Path shown in the title bar. Empty hides the label but keeps the bar when controls are on. */
  title: string;
  showLineNumbers: boolean;
  showWindowControls: boolean;
  background: SnapBackgroundId;
  /** Space between the card and the image edge, in CSS pixels. */
  padding: number;
  fontSize: number;
  /** Device pixels per CSS pixel — 2 is what a retina screenshot looks like. */
  scale: number;
  /** Width of a tab stop, in spaces. Tabs are expanded before measuring: canvas has no tab stops
   * of its own, so leaving them in collapses every indented line to the same column. */
  tabSize: number;
}

const FONT_STACK = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
const LINE_HEIGHT_RATIO = 1.55;
/** Inner breathing room between the card's edge and the code. */
const CARD_PADDING = 18;
const TITLEBAR_HEIGHT = 34;
const GUTTER_GAP = 16;
const CARD_RADIUS = 12;
/** macOS traffic lights, in the order every screenshot tool draws them. */
const WINDOW_DOTS = ["#ff5f57", "#febc2e", "#28c840"];

/** Expands tabs to the next tab stop. Column-aware rather than a blanket replace, so a tab in the
 * middle of a line lands where the editor put it. */
function expandTabs(line: string, tabSize: number): string {
  let out = "";
  for (const char of line) {
    if (char !== "\t") {
      out += char;
      continue;
    }
    out += " ".repeat(tabSize - (out.length % tabSize));
  }
  return out;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Tokenises with Monaco itself, so a snapshot highlights exactly like the editor.
 *
 * A language whose tokenizer hasn't been loaded yet (nothing of that type has been opened this
 * session) yields one untyped token per line — plain text in the foreground colour, which is a
 * fair degradation rather than a failure. */
function tokenizeLines(code: string, language: string): monaco.Token[][] {
  try {
    return monaco.editor.tokenize(code, language);
  } catch {
    return [];
  }
}

export interface SnapMetrics {
  /** CSS pixels — the canvas backing store is this multiplied by `scale`. */
  width: number;
  height: number;
}

/**
 * Paints the snapshot into `canvas`, sizing it to fit, and reports the CSS-pixel dimensions so
 * the caller can lay the preview out.
 */
export function renderCodeSnap(canvas: HTMLCanvasElement, options: CodeSnapOptions): SnapMetrics {
  const { theme, fontSize, scale, tabSize } = options;
  const rules = tokenRulesFor(theme);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { width: 0, height: 0 };

  const rawLines = options.code.replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline in a selection is an artefact of how it was made, not a line anyone meant
  // to include — it would otherwise add an empty row to every snapshot.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines = rawLines.map((line) => expandTabs(line, tabSize));
  const tokens = tokenizeLines(lines.join("\n"), options.language);

  const codeFont = `${fontSize}px ${FONT_STACK}`;
  ctx.font = codeFont;
  // Monospace by construction, so one measurement stands in for every character and the whole
  // layout becomes arithmetic instead of a per-token measure pass.
  const charWidth = ctx.measureText("M").width;
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);

  const lastLineNo = options.startLine + lines.length - 1;
  const gutterDigits = String(lastLineNo).length;
  const gutterWidth = options.showLineNumbers ? gutterDigits * charWidth + GUTTER_GAP : 0;

  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const titleWidth = options.title ? ctx.measureText(options.title).width + 120 : 0;
  const codeWidth = Math.max(longest * charWidth, 120);
  const cardWidth = Math.max(gutterWidth + codeWidth + CARD_PADDING * 2, titleWidth);
  const hasTitlebar = options.showWindowControls || options.title.length > 0;
  const cardHeight = (hasTitlebar ? TITLEBAR_HEIGHT : 0) + lines.length * lineHeight + CARD_PADDING * 2;

  const width = Math.ceil(cardWidth + options.padding * 2);
  const height = Math.ceil(cardHeight + options.padding * 2);

  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // --- backdrop ---
  const preset = SNAP_BACKGROUNDS.find((b) => b.id === options.background);
  if (preset && preset.colors.length === 2) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, preset.colors[0]);
    gradient.addColorStop(1, preset.colors[1]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else if (options.background === "theme") {
    ctx.fillStyle = theme.ui.surfaceRaised;
    ctx.fillRect(0, 0, width, height);
  }
  // `none` leaves the canvas transparent, which is what makes the PNG drop onto any background.

  // --- card ---
  const cardX = options.padding;
  const cardY = options.padding;
  ctx.save();
  // Only worth a shadow when there's a backdrop to cast it on; over transparency it would bake a
  // grey halo into the alpha channel.
  if (options.background !== "none") {
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 10;
  }
  ctx.fillStyle = theme.ui.bg;
  roundedRectPath(ctx, cardX, cardY, cardWidth, cardHeight, CARD_RADIUS);
  ctx.fill();
  ctx.restore();

  // Everything past here is clipped to the card, so a long line runs to the edge and stops
  // instead of spilling onto the backdrop.
  ctx.save();
  roundedRectPath(ctx, cardX, cardY, cardWidth, cardHeight, CARD_RADIUS);
  ctx.clip();

  // --- title bar ---
  if (hasTitlebar) {
    if (options.showWindowControls) {
      WINDOW_DOTS.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cardX + 20 + i * 18, cardY + TITLEBAR_HEIGHT / 2, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    if (options.title) {
      ctx.fillStyle = theme.ui.textMuted;
      ctx.font = `${Math.max(11, fontSize - 2)}px ${FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(options.title, cardX + cardWidth / 2, cardY + TITLEBAR_HEIGHT / 2);
      ctx.textAlign = "left";
    }
  }

  // --- code ---
  const codeTop = cardY + (hasTitlebar ? TITLEBAR_HEIGHT : 0) + CARD_PADDING;
  const codeLeft = cardX + CARD_PADDING + gutterWidth;
  ctx.textBaseline = "middle";

  lines.forEach((line, i) => {
    const y = codeTop + i * lineHeight + lineHeight / 2;

    if (options.showLineNumbers) {
      ctx.font = codeFont;
      ctx.fillStyle = theme.ui.textMuted;
      ctx.textAlign = "right";
      ctx.fillText(String(options.startLine + i), cardX + CARD_PADDING + gutterDigits * charWidth, y);
      ctx.textAlign = "left";
    }

    const lineTokens = tokens[i];
    if (!lineTokens || lineTokens.length === 0) {
      ctx.font = codeFont;
      ctx.fillStyle = theme.tokens.variable;
      ctx.fillText(line, codeLeft, y);
      return;
    }
    // Tokens carry a start offset only; each one runs until the next begins.
    for (let k = 0; k < lineTokens.length; k++) {
      const token = lineTokens[k];
      const end = k + 1 < lineTokens.length ? lineTokens[k + 1].offset : line.length;
      const text = line.slice(token.offset, end);
      if (!text) continue;
      const rule = resolveTokenRule(token.type, rules);
      ctx.font = rule.fontStyle === "italic" ? `italic ${codeFont}` : codeFont;
      ctx.fillStyle = rule.foreground;
      // Positioned by character count rather than by measuring the run — the same monospace
      // assumption the width calculation makes, and it keeps columns aligned across tokens.
      ctx.fillText(text, codeLeft + token.offset * charWidth, y);
    }
  });

  ctx.restore();
  return { width, height };
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas produced no image"))), "image/png");
  });
}

/** A default file name for the save dialog: the source file's own name, with the lines it came
 * from, so a folder of snapshots stays sortable and self-describing. */
export function suggestedSnapName(path: string, startLine: number, endLine: number): string {
  const base = (path.split("/").pop() ?? "snippet").replace(/\.[^.]+$/, "") || "snippet";
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return `${base}-L${range}.png`;
}
