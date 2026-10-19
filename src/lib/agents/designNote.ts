/**
 * What an element picked in design mode becomes when it is handed to an agent.
 *
 * The shortest description of a UI bug is the element it is about, and the most useful form of that
 * element is not a screenshot: it is the selector that finds it, the markup it is made of and the
 * styles it computed to. An agent can act on all three — it can grep for the markup, it can read
 * the component that renders it, and it can tell from the styles whether the problem is in the class
 * or in the layout around it.
 *
 * Pure, and tested without a browser, because every part of the message is a thing a model reads.
 */

import { fenceFor } from "./reviewNote";
import type { DesignPick } from "../tauri/events";

export interface DesignNoteLabels {
  /** The opening line, e.g. «Elegí este elemento en la vista previa:» */
  intro: string;
  /** The heading above the markup. */
  markup: string;
  /** The heading above the computed styles. */
  styles: string;
  /** The line that places it: takes `{url}` and `{rect}`. */
  where: string;
}

/** `x,y,w,h` as prose — `340×48 at (12, 96)` — because four bare numbers are read in four orders. */
export function describeRect(rect: string): string {
  const parts = rect.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return "";
  const [x, y, width, height] = parts;
  return `${width}×${height} at (${x}, ${y})`;
}

/**
 * The message the agent is sent.
 *
 * Returns `""` when the pick carries nothing worth sending — no selector and no markup — so an
 * empty pick cannot cost a turn.
 */
export function buildDesignNote(pick: DesignPick, labels: DesignNoteLabels): string {
  const selector = pick.selector.trim();
  const html = pick.html.trim();
  const css = pick.css.trim();
  if (selector === "" && html === "") return "";

  const parts = [labels.intro];
  if (selector !== "") {
    const fence = fenceFor(selector);
    parts.push(`${fence}\n${selector}\n${fence}`);
  }
  const rect = describeRect(pick.rect);
  if (pick.url.trim() !== "" || rect !== "") {
    parts.push(labels.where.replace("{url}", pick.url.trim()).replace("{rect}", rect));
  }
  if (html !== "") {
    const fence = fenceFor(html);
    parts.push(`### ${labels.markup}\n\n${fence}html\n${html}\n${fence}`);
  }
  if (css !== "") {
    const fence = fenceFor(css);
    parts.push(`### ${labels.styles}\n\n${fence}css\n${css}\n${fence}`);
  }
  return parts.join("\n\n");
}

/** The element's tag and first class, for the card that offers to send it: `div.card`, `button`. */
export function shortLabel(selector: string): string {
  const last = selector.trim().split(">").pop()?.trim() ?? "";
  return last === "" ? selector.trim() : last;
}
