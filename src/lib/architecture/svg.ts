/**
 * Scene → one self-contained SVG string: what the canvas shows and what an export writes.
 *
 * Every colour is concrete (the canvas resolves its theme to a palette before calling), so the
 * exported file looks the same in any viewer. The canvas's interactive layers — selection, a lens's
 * badges — are not baked in: elements carry `data-*` hooks and a few classes the stylesheet below
 * styles, and the canvas toggles those classes and draws its overlays on top.
 *
 * Icons are `<symbol>`s in `<defs>`, one per icon used. Provider icons keep their own viewBox and
 * colours (their terms forbid distorting them); generic glyphs are strokes in the category colour.
 */
import { roundedPath } from "../diagrams/archify/layout/route";
import { textWidth, wrapToWidth } from "../diagrams/archify/text";
import { archIconNow, symbolId } from "./icons";
import { CARD_W, FONT, LINE, TEXT_X, TILE, ZONE_METRICS, type Scene, type SceneCard, type SceneEdge, type SceneZone } from "./layout";
import type { ArchDoc, Category } from "./types";

export interface ArchPalette {
  canvas: string;
  cloud: string;
  cloudHead: string;
  group: string;
  groupHead: string;
  cluster: string;
  tier: string;
  line: string;
  lineStrong: string;
  dash: string;
  card: string;
  cardBorder: string;
  ink: string;
  ink2: string;
  ink3: string;
  desc: string;
  edge: string;
  edgeAsync: string;
  halo: string;
  step: string;
  pill: string;
  noteBg: string;
  noteLine: string;
  noteInk: string;
  hot: string;
  danger: string;
  shadow: number;
}

export const LIGHT_PALETTE: ArchPalette = {
  canvas: "#ffffff", cloud: "#f8fafc", cloudHead: "#f1f5f9", group: "#ffffff", groupHead: "#f8fafc", cluster: "#f8fafc", tier: "#eef2f6",
  line: "#e2e8f0", lineStrong: "#cbd5e1", dash: "#94a3b8", card: "#ffffff", cardBorder: "#c5cedb", ink: "#0f172a", ink2: "#64748b",
  ink3: "#94a3b8", desc: "#475569", edge: "#64748b", edgeAsync: "#94a3b8", halo: "#ffffff", step: "#2563eb", pill: "#ffffff",
  noteBg: "#fef3c7", noteLine: "#f59e0b", noteInk: "#92400e", hot: "#5457e0", danger: "#dc2626", shadow: 0.08,
};

export const DARK_PALETTE: ArchPalette = {
  canvas: "#0f1117", cloud: "#141720", cloudHead: "#191d28", group: "#10131a", groupHead: "#161a24", cluster: "#141821", tier: "#1a1f2b",
  line: "#262b38", lineStrong: "#333a4a", dash: "#4b5568", card: "#191d27", cardBorder: "#313849", ink: "#e6e9f2", ink2: "#9aa3b5",
  ink3: "#6b7489", desc: "#b0b8c8", edge: "#8a94a8", edgeAsync: "#5d667a", halo: "#0f1117", step: "#3b82f6", pill: "#191d27",
  noteBg: "#3a2e0b", noteLine: "#b7791f", noteInk: "#fcd34d", hot: "#818cf8", danger: "#f87171", shadow: 0.35,
};

/** Fixed hues: the legend has to mean the same thing in every theme and every exported file. */
export const CATEGORY_COLOR: Record<Category, string> = {
  actor: "#475569",
  compute: "#7c3aed",
  data: "#0d9488",
  messaging: "#ea580c",
  network: "#2563eb",
  identity: "#e11d48",
  security: "#b91c1c",
  observability: "#ca8a04",
  external: "#64748b",
};

export const SANS = "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** `a` mixed into `b` by `t` (0..1), both #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => { const s = h.replace("#", ""); const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
  try {
    const [x, y] = [p(a), p(b)];
    if ([...x, ...y].some((v) => Number.isNaN(v))) return b;
    return "#" + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
  } catch {
    return b;
  }
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

export interface PanelLabels {
  flow: string;
  notes: string;
  legend: string;
  sync: string;
  async: string;
  step: string;
  own: string;
  shared: string;
  note: string;
  categories: Record<Category, string>;
}

export interface RenderOptions {
  palette: ArchPalette;
  /** "Not in components" — the line under a placeholder card. */
  missingLabel: string;
  /** Flow, notes and legend to the right of the drawing, as in a printed architecture sheet. */
  panels?: { doc: ArchDoc; labels: PanelLabels } | null;
  /** Paint the background (an export does; the canvas has its own). */
  background?: boolean;
}

function iconUse(id: string | undefined, x: number, y: number, size: number, color: string): string {
  const icon = archIconNow(id) ?? archIconNow("external");
  if (!icon) return "";
  const [, , vw, vh] = icon.viewBox.split(/\s+/).map(Number);
  // Keep the icon's own aspect: a non-square provider icon is fitted, never stretched.
  const k = Math.min(size / (vw || size), size / (vh || size));
  const w = (vw || size) * k, h = (vh || size) * k;
  const real = archIconNow(id) ? id! : "external";
  return `<use href="#${symbolId(real)}" x="${f1(x + (size - w) / 2)}" y="${f1(y + (size - h) / 2)}" width="${f1(w)}" height="${f1(h)}"${icon.mono ? ` color="${color}"` : ""}/>`;
}

function symbols(ids: Set<string>): string {
  let out = "";
  for (const id of ids) {
    const icon = archIconNow(id);
    if (!icon) continue;
    out += icon.mono
      ? `<symbol id="${symbolId(id)}" viewBox="${icon.viewBox}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon.body}</symbol>`
      : `<symbol id="${symbolId(id)}" viewBox="${icon.viewBox}">${icon.body}</symbol>`;
  }
  return out;
}

export function zoneSvg(z: SceneZone, p: ArchPalette): string {
  const [x, y, w, h] = z.box;
  const m = ZONE_METRICS[z.style];
  const r = m.radius;
  const head = `M${x} ${y + m.head}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + m.head}Z`;
  let s = `<g class="zone" data-zone="${esc(z.id)}">`;
  const title = (tx: number, ty: number, size: number, color: string) =>
    `<text x="${tx}" y="${ty}" font-size="${size}" font-weight="700" fill="${color}">${esc(z.title)}</text>` +
    (z.subtitle ? `<text x="${f1(tx + textWidth(z.title, size, true) + 10)}" y="${ty}" font-size="10" fill="${p.ink2}">${esc(z.subtitle)}</text>` : "");
  if (z.style === "cloud" || z.style === "group" || z.style === "providers") {
    const fill = z.style === "cloud" ? p.cloud : z.style === "group" ? p.group : p.groupHead;
    const hfill = z.style === "cloud" ? p.cloudHead : z.style === "group" ? p.groupHead : p.cloudHead;
    const border = z.style === "group" ? p.lineStrong : p.line;
    const size = z.style === "cloud" ? 15 : 12.5, isz = z.style === "cloud" ? 24 : 20;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/><path d="${head}" fill="${hfill}"/>`;
    s += `<line x1="${x}" y1="${y + m.head}" x2="${x + w}" y2="${y + m.head}" stroke="${border}"/>`;
    s += `<rect class="zb" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${border}"/>`;
    const tx = z.icon ? x + 14 + isz + 10 : x + 16;
    if (z.icon) s += iconUse(z.icon, x + 14, y + (m.head - isz) / 2, isz, p.ink2);
    s += title(tx, y + m.head / 2 + size * 0.36, size, p.ink);
  } else if (z.style === "cluster") {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${p.cluster}"/>`;
    s += `<rect class="zb" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${p.dash}" stroke-dasharray="4 3"/>`;
    const tx = z.icon ? x + 40 : x + 14;
    if (z.icon) s += iconUse(z.icon, x + 14, y + 9, 18, p.ink2);
    s += title(tx, y + 22.5, 12.5, p.ink);
  } else if (z.style === "tier") {
    s += `<rect class="zb" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${p.tier}" stroke="none"/>`;
    s += `<text x="${x + 12}" y="${y + 18}" font-size="9.5" font-weight="700" letter-spacing="1" fill="${p.ink2}">${esc(z.title.toUpperCase())}</text>`;
  } else {
    s += `<rect class="zb" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${p.lineStrong}" stroke-dasharray="4 3"/>`;
    s += `<text x="${x + 12}" y="${y + 18.5}" font-size="10.5" fill="${p.ink2}">${esc(z.title)}</text>`;
  }
  return s + "</g>";
}

export function cardSvg(c: SceneCard, p: ArchPalette, missingLabel: string): string {
  const [x, y, w, h] = c.box;
  const color = c.missing ? p.danger : CATEGORY_COLOR[c.category] ?? CATEGORY_COLOR.external;
  const tint = mix(color, p.card, 0.13);
  const ty = y + 11;
  let s = `<g class="card" data-card="${esc(c.id)}">`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${p.card}" filter="url(#arch-shadow)"/>`;
  s += `<rect x="${x}" y="${y + 10}" width="3" height="${Math.max(0, h - 20)}" rx="1.5" fill="${color}"/>`;
  s += `<rect x="${x + 14}" y="${ty}" width="${TILE}" height="${TILE}" rx="10" fill="${tint}"/>`;
  const provider = !!c.icon && !archIconNow(c.icon)?.mono;
  s += iconUse(c.icon || (c.missing ? "external" : "container"), x + 14 + (provider ? 7 : 9), ty + (provider ? 7 : 9), provider ? 30 : 26, color);
  if (c.badge) {
    const bx = x + 14 + TILE - 4, by = ty + TILE - 4;
    s += `<circle cx="${bx}" cy="${by}" r="10.5" fill="${p.card}" stroke="${p.line}" stroke-width=".75"/>`;
    s += iconUse(c.badge, bx - 6.5, by - 6.5, 13, color);
  }
  const tx = x + TEXT_X;
  let cy = ty;
  c.name.forEach((line, i) => { s += `<text x="${tx}" y="${f1(cy + 12 + i * LINE.name)}" font-size="${FONT.name}" font-weight="700" fill="${p.ink}">${esc(line)}</text>`; });
  cy += c.name.length * LINE.name;
  if (c.type) { c.type.forEach((line, i) => { s += `<text x="${tx}" y="${f1(cy + 10.5 + i * LINE.type)}" font-size="${FONT.type}" fill="${p.ink2}">${esc(line)}</text>`; }); cy += c.type.length * LINE.type; }
  if (c.resource) { s += `<text x="${tx}" y="${f1(cy + 9)}" font-size="${FONT.resource}" font-family="${MONO}" fill="${p.ink3}">${esc(c.resource)}</text>`; cy += LINE.resource; }
  if (c.description.length) {
    cy += 2;
    c.description.forEach((line, i) => { s += `<text x="${tx}" y="${f1(cy + 10 + i * LINE.description)}" font-size="${FONT.description}" fill="${p.desc}">${esc(line)}</text>`; });
    cy += c.description.length * LINE.description;
  }
  if (c.missing) s += `<text x="${tx}" y="${f1(cy + 10)}" font-size="${FONT.shared}" fill="${p.danger}">${esc(missingLabel)}</text>`;
  else if (c.sharedFrom) s += `<text x="${tx}" y="${f1(cy + 10)}" font-size="${FONT.shared}" fill="${p.ink3}">↗ ${esc(c.sharedFrom)}</text>`;
  s += `<rect class="cb" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="${c.missing ? p.danger : p.cardBorder}"${c.sharedFrom ? ' stroke-dasharray="5 3"' : ""}/>`;
  return s + "</g>";
}

export function edgeSvg(e: SceneEdge, p: ArchPalette): string {
  const d = roundedPath(e.points, 7);
  const async = e.kind === "async";
  return `<g class="edge${async ? " async" : ""}" data-edge="${e.index}"><path class="halo" d="${d}" fill="none" stroke="${p.halo}" stroke-width="6" stroke-linejoin="round"/><path class="ln" d="${d}" fill="none" stroke="${async ? p.edgeAsync : p.edge}" stroke-width="1.5" stroke-linejoin="round"${async ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#arch-arrow-${async ? "async" : "sync"})"/></g>`;
}

/** One label slot: the step circle, then the pill. `text` overrides what the edge says. */
export function labelSvg(e: Pick<SceneEdge, "index" | "step" | "label" | "at">, p: ArchPalette, text = e.label): string {
  if (!e.at) return "";
  const [x, y, w] = e.at;
  const stepW = e.step ? 18 : 0;
  const pillW = text ? Math.ceil(textWidth(text, FONT.pill)) + 12 : 0;
  // Centre the actual content in the slot the router kept, so a relabel (rps instead of a protocol) stays put.
  const total = stepW + (text && e.step ? 2 : 0) + pillW;
  const x0 = x + (w - total) / 2;
  let s = `<g class="lab" data-edge="${e.index}">`;
  if (e.step) s += `<circle cx="${f1(x0 + 7.5)}" cy="${f1(y + 7.5)}" r="7.5" fill="${p.step}"/><text x="${f1(x0 + 7.5)}" y="${f1(y + 10.6)}" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">${e.step}</text>`;
  if (text) {
    const px = x0 + stepW + (e.step ? 2 : 0);
    s += `<rect x="${f1(px)}" y="${y}" width="${pillW}" height="15" rx="7.5" fill="${p.pill}" stroke="${p.lineStrong}"/><text x="${f1(px + pillW / 2)}" y="${f1(y + 10.4)}" font-size="${FONT.pill}" fill="${p.ink2}" text-anchor="middle">${esc(text)}</text>`;
  }
  return s + "</g>";
}

export function headerSvg(scene: Scene, p: ArchPalette): string {
  const hd = scene.header;
  if (!hd) return "";
  const [x, y, w] = hd.box;
  let s = `<g class="head"><text x="${x}" y="${y + 26}" font-size="26" font-weight="700" fill="${p.ink}">${esc(hd.title)}</text><rect x="${x}" y="${y + 35}" width="40" height="3" rx="1.5" fill="${p.step}"/>`;
  hd.description.forEach((line, i) => { s += `<text x="${x}" y="${y + 62 + i * 18}" font-size="13" fill="${p.desc}">${esc(line)}</text>`; });
  if (hd.meta.length) {
    const keyW = Math.max(...hd.meta.map(([k]) => textWidth(k, 10.5, true)));
    const valW = Math.max(...hd.meta.map(([, v]) => textWidth(v, 10.5)));
    const bw = keyW + valW + 48, bh = hd.meta.length * 16.5 + 18;
    const bx = x + w - bw;
    s += `<rect x="${f1(bx)}" y="${y}" width="${f1(bw)}" height="${f1(bh)}" rx="8" fill="${p.cloud}" stroke="${p.line}"/>`;
    hd.meta.forEach(([k, v], i) => {
      const ry = y + 22 + i * 16.5;
      s += `<text x="${f1(bx + 16)}" y="${f1(ry)}" font-size="10.5" font-weight="700" fill="${p.desc}">${esc(k)}</text><text x="${f1(bx + 16 + keyW + 18)}" y="${f1(ry)}" font-size="10.5" fill="${p.ink}">${esc(v)}</text>`;
    });
  }
  const ruleY = y + hd.box[3] + 22;
  return s + `<line x1="${x}" y1="${ruleY}" x2="${x + w}" y2="${ruleY}" stroke="${p.line}"/></g>`;
}

const PANEL_W = 440;

function panelsSvg(scene: Scene, doc: ArchDoc, labels: PanelLabels, p: ArchPalette, x0: number): { svg: string; bottom: number } {
  let y = (scene.header ? scene.header.box[1] + scene.header.box[3] + 50 : 36) + 8;
  let s = `<g class="panels">`;
  const heading = (t: string) => { s += `<text x="${x0}" y="${y}" font-size="12.5" font-weight="700" fill="${p.ink}">${esc(t)}</text><line x1="${x0}" y1="${y + 10.5}" x2="${x0 + PANEL_W}" y2="${y + 10.5}" stroke="${p.line}"/>`; y += 30; };
  const flow = doc.flow ?? [];
  if (flow.length) {
    heading(labels.flow);
    flow.forEach((text, i) => {
      const lines = wrapToWidth(text, 10.5, PANEL_W - 26, 4);
      s += `<circle cx="${x0 + 8}" cy="${y - 3.5}" r="8" fill="${p.step}"/><text x="${x0 + 8}" y="${y - 0.5}" font-size="9.5" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>`;
      lines.forEach((l, j) => { s += `<text x="${x0 + 26}" y="${y - 1 + j * 15.5}" font-size="10.5" fill="${p.ink}">${esc(l)}</text>`; });
      y += lines.length * 15.5 + 10;
    });
    y += 20;
  }
  const notes = doc.notes ?? [];
  if (notes.length) {
    heading(labels.notes);
    for (const n of notes) {
      const cw = textWidth(n.id, 9.5, true) + 10;
      s += `<rect x="${x0}" y="${y - 11}" width="${f1(cw)}" height="15" rx="4" fill="${p.noteBg}" stroke="${p.noteLine}"/><text x="${f1(x0 + cw / 2)}" y="${y - 0.5}" font-size="9.5" font-weight="700" fill="${p.noteInk}" text-anchor="middle">${esc(n.id)}</text>`;
      if (n.title) s += `<text x="${f1(x0 + cw + 10)}" y="${y}" font-size="11" font-weight="700" fill="${p.ink}">${esc(n.title)}</text>`;
      const lines = n.text ? wrapToWidth(n.text, 10.5, PANEL_W - cw - 10, 6) : [];
      lines.forEach((l, j) => { s += `<text x="${f1(x0 + cw + 10)}" y="${y + 16 + j * 15}" font-size="10.5" fill="${p.desc}">${esc(l)}</text>`; });
      y += 16 + lines.length * 15 + 14;
    }
    y += 16;
  }
  heading(labels.legend);
  const row = (glyph: string, text: string) => { s += glyph + `<text x="${x0 + 44}" y="${y}" font-size="10.5" fill="${p.ink}">${esc(text)}</text>`; y += 22; };
  row(`<line x1="${x0}" y1="${y - 4}" x2="${x0 + 30}" y2="${y - 4}" stroke="${p.edge}" stroke-width="1.5" marker-end="url(#arch-arrow-sync)"/>`, labels.sync);
  row(`<line x1="${x0}" y1="${y - 4}" x2="${x0 + 30}" y2="${y - 4}" stroke="${p.edgeAsync}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#arch-arrow-async)"/>`, labels.async);
  row(`<circle cx="${x0 + 8}" cy="${y - 4}" r="8" fill="${p.step}"/><text x="${x0 + 8}" y="${y - 1}" font-size="9.5" font-weight="700" fill="#ffffff" text-anchor="middle">1</text>`, labels.step);
  const used = new Set(scene.cards.map((c) => c.category));
  for (const cat of Object.keys(CATEGORY_COLOR) as Category[]) {
    if (!used.has(cat)) continue;
    row(`<rect x="${x0}" y="${y - 12}" width="30" height="14" rx="3" fill="${mix(CATEGORY_COLOR[cat], p.card, 0.14)}"/><rect x="${x0}" y="${y - 12}" width="3" height="14" rx="1.5" fill="${CATEGORY_COLOR[cat]}"/>`, labels.categories[cat]);
  }
  row(`<rect x="${x0}" y="${y - 12}" width="30" height="14" rx="3" fill="${p.card}" stroke="${p.cardBorder}"/>`, labels.own);
  if (scene.cards.some((c) => c.sharedFrom)) row(`<rect x="${x0}" y="${y - 12}" width="30" height="14" rx="3" fill="${p.card}" stroke="${p.cardBorder}" stroke-dasharray="5 3"/>`, labels.shared);
  if (notes.length) row(`<rect x="${x0}" y="${y - 12}" width="24" height="15" rx="4" fill="${p.noteBg}" stroke="${p.noteLine}"/><text x="${x0 + 12}" y="${y - 1.5}" font-size="9.5" font-weight="700" fill="${p.noteInk}" text-anchor="middle">N1</text>`, labels.note);
  return { svg: s + "</g>", bottom: y };
}

/** The icons a scene draws — what `loadArchIcons` has to have landed before `renderSvg`. */
export function sceneIcons(scene: Scene): string[] {
  const ids = new Set<string>(["external", "container"]);
  for (const c of scene.cards) { if (c.icon) ids.add(c.icon); if (c.badge) ids.add(c.badge); }
  for (const z of scene.zones) if (z.icon) ids.add(z.icon);
  return [...ids];
}

/** The arrowheads, the card shadow and every icon the scene names, as the inside of a `<defs>`.
 *  The canvas puts it once in the page and draws each node with the same fragments an export does. */
export function sceneDefs(scene: Scene, p: ArchPalette, extraIcons: Iterable<string> = []): string {
  const ids = new Set([...sceneIcons(scene), ...extraIcons].filter((id) => archIconNow(id)));
  const marker = (name: string, color: string) =>
    `<marker id="arch-arrow-${name}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0.8L10,5L0,9.2L2.6,5z" fill="${color}"/></marker>`;
  return `${marker("sync", p.edge)}${marker("async", p.edgeAsync)}${marker("hot", p.hot)}${marker("down", p.danger)}<filter id="arch-shadow" x="-8%" y="-8%" width="116%" height="130%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#0f172a" flood-opacity="${p.shadow}"/></filter>${symbols(ids)}`;
}

export function chipSvg(chip: { id: string; x: number; y: number }, p: ArchPalette): string {
  const cw = textWidth(chip.id, 9.5, true) + 10;
  return `<g class="chip" data-note="${esc(chip.id)}"><rect x="${f1(chip.x)}" y="${f1(chip.y)}" width="${f1(cw)}" height="15" rx="4" fill="${p.noteBg}" stroke="${p.noteLine}"/><text x="${f1(chip.x + cw / 2)}" y="${f1(chip.y + 10.6)}" font-size="9.5" font-weight="700" fill="${p.noteInk}" text-anchor="middle">${esc(chip.id)}</text></g>`;
}

export function renderSvg(scene: Scene, opts: RenderOptions): string {
  const p = opts.palette;
  const panelX = scene.width + 16;
  const panels = opts.panels ? panelsSvg(scene, opts.panels.doc, opts.panels.labels, p, panelX) : null;
  const width = panels ? panelX + PANEL_W + 44 : scene.width;
  const height = panels ? Math.max(scene.height, panels.bottom + 48) : scene.height;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${f1(width)}" height="${f1(height)}" viewBox="0 0 ${f1(width)} ${f1(height)}" font-family="${SANS}">`;
  s += `<defs>${sceneDefs(scene, p)}</defs>`;
  s += `<style>.arch-focus .card:not(.sel):not(.hot){opacity:.38}.arch-focus .edge:not(.hot){opacity:.13}.arch-focus .lab:not(.hot){opacity:.22}.edge.hot .ln{stroke:${p.hot};stroke-width:2}.card.sel .cb{stroke:${p.hot};stroke-width:2}.zone.sel .zb{stroke:${p.hot};stroke-width:2}.card,.edge,.lab{transition:opacity .15s ease}.arch-hide-labels .labels{display:none}</style>`;
  if (opts.background) s += `<rect width="100%" height="100%" fill="${p.canvas}"/>`;
  s += headerSvg(scene, p);
  for (const z of scene.zones) s += zoneSvg(z, p);
  s += `<g class="edges">${scene.edges.map((e) => edgeSvg(e, p)).join("")}</g>`;
  for (const c of scene.cards) s += cardSvg(c, p, opts.missingLabel);
  s += `<g class="labels">${scene.edges.map((e) => labelSvg(e, p)).join("")}</g>`;
  for (const chip of scene.chips) s += chipSvg(chip, p);
  if (panels) s += panels.svg;
  return s + "</svg>";
}

export { CARD_W };
