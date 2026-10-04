import { EMPTY_EXCALIDRAW_DOC } from "./doc";

/**
 * What the rest of the app needs to know about an Excalidraw document, without Excalidraw.
 *
 * The editor package is a few megabytes and is only loaded with the editor; the store and the AI
 * panel still have to read a whiteboard's labels and add a generation to one. A scene is plain JSON
 * — an envelope around a list of elements, each with a position and a size — so those two jobs
 * are done here on the JSON itself. What needs real Excalidraw (measuring text, binding arrows)
 * lives in `excalidrawGraph`, which is imported on demand.
 */

/** The parts of an element this module reads. Everything else is carried through untouched. */
interface SceneElement {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: [number, number][];
  isDeleted?: boolean;
  text?: string;
  index?: string | null;
  [key: string]: unknown;
}

interface Scene {
  type: "excalidraw";
  elements: SceneElement[];
  files?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A document as a scene — `null` for anything that is not one. The empty string is a blank. */
export function parseScene(doc: string): Scene | null {
  try {
    const data = JSON.parse(doc.trim() || EMPTY_EXCALIDRAW_DOC);
    if (data?.type !== "excalidraw" || !Array.isArray(data.elements)) return null;
    return data as Scene;
  } catch {
    return null;
  }
}

/**
 * The words on a whiteboard, as context for the next generation — the counterpart of
 * `documentOutline` for draw.io, and for the same reason: what the shapes *say* is what a model can
 * use, and a scene is mostly coordinates and seeds that would only spend its context.
 */
export function sceneOutline(doc: string, limit = 4000): string {
  const labels: string[] = [];
  for (const element of parseScene(doc)?.elements ?? []) {
    if (element.isDeleted || element.type !== "text" || typeof element.text !== "string") continue;
    const text = element.text.replace(/\s+/g, " ").trim();
    if (text) labels.push(text);
    if (labels.join(", ").length > limit) break;
  }
  return labels.join(", ").slice(0, limit);
}

/** Room left between what was drawn and what is added beside it. */
const GAP = 120;

/**
 * Adds a generated scene to a whiteboard, **beside** what is already drawn rather than on top of it.
 *
 * A generation is laid out from the origin, which is where the user's own drawing usually is too;
 * appended where it stands, it would land across it. So it is moved, as a whole, to the right of the
 * existing content and level with its top. Every element moves by the same amount — arrows keep
 * their points (they are relative to the element's own position) and labels stay in their boxes.
 *
 * The added elements lose their stacking `index`: theirs were counted from scratch and would
 * collide with the drawing's. Excalidraw gives an element without one a valid place above the rest
 * when it loads the scene.
 *
 * A base that cannot be read is returned untouched: replacing the user's drawing with the
 * generation would be the unrecoverable half of that failure.
 */
export function appendScene(base: string, addition: string): string {
  const target = parseScene(base);
  const source = parseScene(addition);
  if (!target || !source) return base;
  const added = source.elements.filter((element) => !element.isDeleted);
  if (added.length === 0) return base;

  const present = bounds(target.elements.filter((element) => !element.isDeleted));
  const incoming = bounds(added);
  const dx = present && incoming ? present.maxX + GAP - incoming.minX : 0;
  const dy = present && incoming ? present.minY - incoming.minY : 0;

  return JSON.stringify({
    ...target,
    elements: [
      ...target.elements,
      ...added.map((element) => ({
        ...element,
        x: (element.x ?? 0) + dx,
        y: (element.y ?? 0) + dy,
        index: null,
      })),
    ],
    files: { ...(target.files ?? {}), ...(source.files ?? {}) },
  });
}

/** The box around a set of elements, counting a line by its points rather than its anchor. */
function bounds(
  elements: readonly SceneElement[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const element of elements) {
    const x = element.x ?? 0;
    const y = element.y ?? 0;
    const corners: [number, number][] = element.points?.length
      ? element.points.map(([px, py]) => [x + px, y + py])
      : [
          [x, y],
          [x + (element.width ?? 0), y + (element.height ?? 0)],
        ];
    for (const [cx, cy] of corners) {
      box = box
        ? {
            minX: Math.min(box.minX, cx),
            minY: Math.min(box.minY, cy),
            maxX: Math.max(box.maxX, cx),
            maxY: Math.max(box.maxY, cy),
          }
        : { minX: cx, minY: cy, maxX: cx, maxY: cy };
    }
  }
  return box;
}
