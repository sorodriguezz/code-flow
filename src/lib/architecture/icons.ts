/**
 * Icons a card or zone can name: `azure:kubernetes-services`, `aws:lambda`, `gcp:cloud-run`,
 * `logos:nestjs`, or a bare name from the generic set below (`person`, `queue`, `database`…).
 *
 * The provider packs are the official downloads (see `scripts/build-arch-icons.mjs`), a few MB in
 * all, so each is a separate asset fetched the first time a document names one of its icons, never
 * on the app's boot path. `logos:` reads the same iconify asset the file-icon catalogue uses, but on
 * its own: that catalogue prunes to the ids the explorer declared, and a diagram's badges are not
 * among them.
 *
 * Provider icons are drawn as they come (their terms forbid recolouring, cropping or distorting
 * them, so the renderer keeps their viewBox); the generic glyphs are strokes in `currentColor`, tinted
 * by the card's category.
 */
import azureUrl from "./icons/packs/azure.json?url";
import awsUrl from "./icons/packs/aws.json?url";
import gcpUrl from "./icons/packs/gcp.json?url";
import logosUrl from "@iconify-json/logos/icons.json?url";

export interface ArchIcon {
  viewBox: string;
  body: string;
  /** Drawn in `currentColor` (a generic glyph) rather than its own colours. */
  mono: boolean;
  label: string;
}

interface PackIcon { n: string; c: string; v: string; b: string }
interface Pack { provider: string; label: string; notice: string; icons: Record<string, PackIcon> }
interface LogosSet { width?: number; height?: number; icons: Record<string, { body: string; width?: number; height?: number }>; aliases?: Record<string, { parent: string }> }

export const PROVIDERS = [
  { id: "azure", label: "Azure", url: azureUrl },
  { id: "aws", label: "AWS", url: awsUrl },
  { id: "gcp", label: "Google Cloud", url: gcpUrl },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]["id"];

const poly = (n: number, r: number) =>
  Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`; }).join(" ");
const spokes = Array.from({ length: 7 }, (_, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 7;
  return `M${(12 + 2.7 * Math.cos(a)).toFixed(2)} ${(12 + 2.7 * Math.sin(a)).toFixed(2)}L${(12 + 6.3 * Math.cos(a)).toFixed(2)} ${(12 + 6.3 * Math.sin(a)).toFixed(2)}`;
}).join("");

/** The generic set: what a diagram uses before (or instead of) a provider's own icon. */
export const GLYPHS: Record<string, string> = {
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.4-3.9 3.3-6.2 7.2-6.2s6.8 2.3 7.2 6.2"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.3-3.3 2.6-5.3 5.5-5.3s5.2 2 5.5 5.3"/><circle cx="16.5" cy="7.5" r="2.5"/><path d="M15.5 12.6c2.7.1 4.6 2 4.9 5"/>',
  container: `<polygon points="${poly(7, 9.6)}"/><circle cx="12" cy="12" r="2.5"/><path d="${spokes}"/>`,
  server: '<rect x="4" y="4" width="16" height="7" rx="1.8"/><rect x="4" y="13" width="16" height="7" rx="1.8"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  function: '<path d="M13.2 2.8 4.8 13.6h6.4l-1 7.6 8.6-11h-6.6z"/>',
  gateway: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M8 12h7.5M12.8 9l3 3-3 3"/>',
  cdn: '<path d="M7.2 18.5h9.6a4.1 4.1 0 0 0 .6-8.15A5.9 5.9 0 0 0 6.2 9.6a4.45 4.45 0 0 0 1 8.9z"/><path d="M12 10.6v5.2M9.7 13.6 12 15.9l2.3-2.3"/>',
  balancer: '<circle cx="12" cy="5.5" r="2.3"/><circle cx="5.5" cy="18.5" r="2.3"/><circle cx="12" cy="18.5" r="2.3"/><circle cx="18.5" cy="18.5" r="2.3"/><path d="M12 7.8v8.4M12 10l-5.4 6.4M12 10l5.4 6.4"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.7"/><path d="M5 6v12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6"/><path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7"/>',
  pool: '<ellipse cx="12" cy="6.5" rx="6.5" ry="2.4"/><path d="M5.5 6.5v3.6c0 1.3 2.9 2.4 6.5 2.4s6.5-1.1 6.5-2.4V6.5M5.5 13.6v3.6c0 1.3 2.9 2.4 6.5 2.4s6.5-1.1 6.5-2.4v-3.6"/>',
  cache: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/><path d="M10 10h4v4h-4z"/>',
  storage: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  queue: '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="m3.5 9 8.5 5.2L20.5 9M6.5 4.5h11"/>',
  bus: '<path d="M3 8h18M3 16h18"/><path d="m17 5 3 3-3 3M7 13l-3 3 3 3"/>',
  stream: '<path d="M3 7c3 0 3 3 6 3s3-3 6-3 3 3 6 3M3 14c3 0 3 3 6 3s3-3 6-3 3 3 6 3"/>',
  identity: '<path d="M12 2.8 19 5.6v5.6c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V5.6z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  firewall: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.3h18M3 14.6h18M9 4v5.3M15 9.3v5.3M9 14.6V20"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="m6.5 13 3-3.5 3 2.5 4.5-5M8 20h8"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3.8" ry="9"/><path d="M3.5 9h17M3.5 15h17"/>',
  chat: '<path d="M4 5.5h16v10.5H10l-4.6 3.6V16H4z"/><path d="M8.5 10.8h.01M12 10.8h.01M15.5 10.8h.01"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  captcha: '<path d="M19.5 12A7.5 7.5 0 1 1 17.3 6.7"/><path d="M19.6 3.6v3.9h-3.9"/><path d="m9 12 2 2 4-4"/>',
  external: '<rect x="3.5" y="6.5" width="13" height="13" rx="2"/><path d="M13 3.5h7.5V11M20.5 3.5l-8.8 8.8"/>',
  web: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 8.5h18M6 6.5h.01M8.5 6.5h.01"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>',
  api: '<path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 5l-3 14"/>',
  group: '<path d="M7.5 4H4v16h3.5M16.5 4H20v16h-3.5"/><path d="M12 7.8 15.6 9.9v4.2L12 16.2l-3.6-2.1V9.9z"/>',
  cloud: '<path d="M6.8 19h10.4a4.3 4.3 0 0 0 .7-8.55A6.2 6.2 0 0 0 5.9 9.9 4.6 4.6 0 0 0 6.8 19z"/>',
  namespace: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 20 7.5M12 12v9M12 12 4 7.5"/>',
  network: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2V12M12 12l-5.4 5.4M12 12l5.4 5.4"/>',
  ai: '<path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z"/>',
  scheduler: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

const packs = new Map<ProviderId, Pack>();
const packPending = new Map<ProviderId, Promise<Pack | null>>();
let logos: LogosSet | null = null;
let logosPending: Promise<LogosSet | null> | null = null;

function loadPack(id: ProviderId): Promise<Pack | null> {
  const have = packs.get(id);
  if (have) return Promise.resolve(have);
  let p = packPending.get(id);
  if (!p) {
    const url = PROVIDERS.find((x) => x.id === id)!.url;
    p = fetch(url)
      .then((r) => r.json() as Promise<Pack>)
      .then((pack) => { packs.set(id, pack); return pack; })
      .catch(() => { packPending.delete(id); return null; });
    packPending.set(id, p);
  }
  return p;
}

function loadLogos(): Promise<LogosSet | null> {
  if (logos) return Promise.resolve(logos);
  if (!logosPending) {
    logosPending = fetch(logosUrl)
      .then((r) => r.json() as Promise<LogosSet>)
      .then((set) => { logos = set; return set; })
      .catch(() => { logosPending = null; return null; });
  }
  return logosPending;
}

const prefixOf = (id: string) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : "");

/** An icon that is available right now: a glyph, or one whose pack has already landed. */
export function archIconNow(id: string | undefined | null): ArchIcon | null {
  if (!id) return null;
  if (GLYPHS[id]) return { viewBox: "0 0 24 24", body: GLYPHS[id], mono: true, label: id };
  const prefix = prefixOf(id), name = id.slice(prefix.length + 1);
  if (prefix === "logos") {
    const e = logos?.icons[name] ?? logos?.icons[logos?.aliases?.[name]?.parent ?? ""];
    if (!e) return null;
    return { viewBox: `0 0 ${e.width ?? logos!.width ?? 16} ${e.height ?? logos!.height ?? 16}`, body: e.body, mono: false, label: name };
  }
  const pack = packs.get(prefix as ProviderId);
  const e = pack?.icons[name];
  return e ? { viewBox: e.v, body: e.b, mono: false, label: e.n } : null;
}

/** Loads whatever `ids` need and answers once every one is resolvable (or known to be missing). */
export async function loadArchIcons(ids: Iterable<string | undefined | null>): Promise<void> {
  const need = new Set<string>();
  for (const id of ids) if (id && !GLYPHS[id]) need.add(prefixOf(id));
  await Promise.all([...need].map((p) => (p === "logos" ? loadLogos() : PROVIDERS.some((x) => x.id === p) ? loadPack(p as ProviderId) : null)));
}

export interface IconHit { id: string; label: string; group: string }

/** For the inspector's icon field: glyphs, the provider packs and the brand logos, ranked by name. */
export async function searchArchIcons(query: string, limit = 60): Promise<IconHit[]> {
  const q = query.trim().toLowerCase();
  const hits: Array<IconHit & { score: number }> = [];
  const score = (key: string, label: string) => {
    if (!q) return 1;
    const k = key.toLowerCase(), l = label.toLowerCase();
    if (k === q || l === q) return 100;
    if (k.startsWith(q) || l.startsWith(q)) return 60;
    if (k.includes(q) || l.includes(q)) return 30;
    return 0;
  };
  for (const name of Object.keys(GLYPHS)) { const s = score(name, name); if (s) hits.push({ id: name, label: name, group: "generic", score: s + 5 }); }
  const [az, aw, gc, lg] = await Promise.all([loadPack("azure"), loadPack("aws"), loadPack("gcp"), loadLogos()]);
  for (const pack of [az, aw, gc]) {
    if (!pack) continue;
    for (const [key, e] of Object.entries(pack.icons)) { const s = score(key, e.n); if (s) hits.push({ id: `${pack.provider}:${key}`, label: e.n, group: pack.provider, score: s }); }
  }
  if (lg) for (const key of Object.keys(lg.icons)) { const s = score(key, key); if (s) hits.push({ id: `logos:${key}`, label: key, group: "logos", score: s - 2 }); }
  return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit).map(({ score: _s, ...h }) => h);
}

/** One icon of a provider pack, for the canvas's component library. */
export interface PackEntry { id: string; label: string; group: string }

/** Every icon of a provider's pack, by group then name — loads the pack on first use. */
export async function listPackIcons(provider: ProviderId): Promise<PackEntry[]> {
  const pack = await loadPack(provider);
  if (!pack) return [];
  return Object.entries(pack.icons)
    .map(([key, e]) => ({ id: `${provider}:${key}`, label: e.n, group: e.c }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/** A safe element id for an icon's `<symbol>`. */
export const symbolId = (id: string) => "ai-" + id.replace(/[^A-Za-z0-9_-]/g, "_");
