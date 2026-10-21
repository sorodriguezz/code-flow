#!/usr/bin/env node
/**
 * Builds the provider icon packs the Arquitectura app draws with, from the official icon downloads.
 *
 *   node scripts/build-arch-icons.mjs --azure <dir> --aws <dir> --gcp <core-dir>,<category-dir> [--gcp-legacy <dir>]
 *
 * Each <dir> is an extracted official package — nothing is fetched here, on purpose: the packages
 * are downloaded by hand, once, from the pages below, and the result is committed. Run it again
 * when a provider publishes a new set.
 *   Azure  https://learn.microsoft.com/azure/architecture/icons/   (Azure_Public_Service_Icons_V*.zip)
 *   AWS    https://aws.amazon.com/architecture/icons/              (Icon-package_*.zip)
 *   Google https://cloud.google.com/icons                          (core-products, category, legacy zips)
 *
 * Every provider allows these icons in architecture diagrams only (see THIRD-PARTY-NOTICES.md), which
 * is the one thing this app draws with them. Their terms also forbid cropping, rotating or distorting
 * an icon, so the packs keep each icon's own viewBox and the renderer never stretches it.
 *
 * Why the rewrite below: hundreds of these end up inline in one document, and the files were never
 * written for that. Azure names every gradient with a GUID but AWS and Google reuse ids, and Google's
 * Illustrator exports style through `.st1` / `.cls-1` classes in a `<style>` block — which, inside an
 * inline SVG, applies to the whole page. Two icons with a different `.cls-1` would paint each other.
 * So every id and every class is prefixed with the icon's own key.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "src", "lib", "architecture", "icons", "packs");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "__MACOSX") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.toLowerCase().endsWith(".svg")) out.push(p);
  }
  return out;
}
const slug = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const title = (s) => s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** One SVG file → `{ v: viewBox, b: body }` with ids and classes made unique to `key`. */
function compact(svg, key) {
  let s = svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<desc>[\s\S]*?<\/desc>/g, "")
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, "");
  const open = s.match(/<svg\b[^>]*>/);
  if (!open) return null;
  const head = open[0];
  let viewBox = (head.match(/viewBox="([^"]+)"/) || [])[1];
  if (!viewBox) {
    const w = parseFloat((head.match(/\bwidth="([\d.]+)/) || [])[1]);
    const h = parseFloat((head.match(/\bheight="([\d.]+)/) || [])[1]);
    if (!w || !h) return null;
    viewBox = `0 0 ${w} ${h}`;
  }
  let body = s.slice(s.indexOf(head) + head.length, s.lastIndexOf("</svg>"));
  const p = `${key}-`;
  // Ids: only those something refers to survive; the rest (AWS names every <g>) are dropped.
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const id of new Set(ids)) {
    const used = new RegExp(`url\\(\\s*['"]?#${esc(id)}['"]?\\s*\\)|href="#${esc(id)}"`).test(body);
    if (!used) body = body.replace(new RegExp(`\\sid="${esc(id)}"`, "g"), "");
    else {
      const nid = p + slug(id);
      body = body
        .replace(new RegExp(`\\bid="${esc(id)}"`, "g"), `id="${nid}"`)
        .replace(new RegExp(`url\\(\\s*['"]?#${esc(id)}['"]?\\s*\\)`, "g"), `url(#${nid})`)
        .replace(new RegExp(`href="#${esc(id)}"`, "g"), `href="#${nid}"`);
    }
  }
  // Classes: rename in the stylesheet and on the elements, so no `.cls-1` leaks between icons.
  const classes = new Set();
  for (const m of body.matchAll(/\bclass="([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
  for (const st of body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const m of st[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(m[1]);
  for (const c of classes) {
    const nc = p + slug(c);
    body = body
      .replace(/\bclass="([^"]+)"/g, (_, v) => `class="${v.split(/\s+/).map((x) => (x === c ? nc : x)).join(" ")}"`)
      .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, css, z) => a + css.replace(new RegExp(`\\.${esc(c)}(?![\\w-])`, "g"), "." + nc) + z);
  }
  body = body
    .replace(/\s(xmlns:\w+|data-name|sketch:type|version)="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, css, z) => a + css.replace(/\s*([{};:,])\s*/g, "$1").trim() + z)
    .trim();
  return { v: viewBox.trim().replace(/\s+/g, " "), b: body };
}

function pack(provider, label, notice, entries) {
  const icons = {};
  let bytes = 0;
  for (const { key, name, cat, file } of entries) {
    if (icons[key]) continue;
    const c = compact(readFileSync(file, "utf8"), `${provider}-${key}`);
    if (!c) { console.warn(`skip (no viewBox): ${file}`); continue; }
    icons[key] = { n: name, c: cat, ...c };
    bytes += c.b.length;
  }
  mkdirSync(OUT, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(icons).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(OUT, `${provider}.json`), JSON.stringify({ provider, label, notice, icons: sorted }));
  console.log(`${provider}: ${Object.keys(icons).length} icons, ${(bytes / 1024).toFixed(0)} KB of markup`);
}

if (args.azure) {
  // Icons/<category>/<nnnnn>-icon-service-<Name>.svg; some icons sit in two categories — first wins.
  const files = walk(args.azure).filter((f) => /icon-service-/.test(f));
  pack("azure", "Azure", "Microsoft Azure architecture icons — use permitted in architectural diagrams.", files.map((f) => {
    const raw = basename(f, ".svg").replace(/^\d+-icon-service-/, "");
    return { key: slug(raw), name: title(raw), cat: slug(basename(dirname(f))), file: f };
  }).sort((a, b) => a.file.localeCompare(b.file)));
}

if (args.aws) {
  const all = walk(args.aws).filter((f) => !/_Dark/i.test(f));
  const strip = (s) => s.replace(/^(AWS|Amazon)-/, "");
  const service = all.filter((f) => /Architecture-Service-Icons/.test(f) && /\/48\/Arch_.*_48\.svg$/.test(f)).map((f) => {
    const raw = basename(f, ".svg").replace(/^Arch_/, "").replace(/_48$/, "");
    return { key: slug(strip(raw)), name: title(raw), cat: slug(basename(dirname(dirname(f))).replace(/^Arch_/, "")), file: f };
  });
  const resource = all.filter((f) => /Resource-Icons/.test(f) && /_48\.svg$/.test(f)).map((f) => {
    const raw = basename(f, ".svg").replace(/^Res_/, "").replace(/_48$/, "");
    return { key: "res-" + slug(strip(raw)), name: title(raw), cat: slug(basename(dirname(f)).replace(/^Res_/, "")), file: f };
  });
  const group = all.filter((f) => /Architecture-Group-Icons/.test(f) && /_32\.svg$/.test(f)).map((f) => {
    const raw = basename(f, ".svg").replace(/_32$/, "");
    return { key: "group-" + slug(raw), name: title(raw), cat: "groups", file: f };
  });
  const category = all.filter((f) => /Category-Icons/.test(f) && /_48\.svg$/.test(f)).map((f) => {
    const raw = basename(f, ".svg").replace(/^Arch-Category_/, "").replace(/_48$/, "");
    return { key: "category-" + slug(raw), name: title(raw), cat: "categories", file: f };
  });
  pack("aws", "AWS", "AWS Architecture Icons — permitted for creating architecture diagrams.", [...service, ...resource, ...group, ...category]);
}

if (args.gcp || args["gcp-legacy"]) {
  const entries = [];
  // --gcp takes the core-products and category packages, comma-separated.
  for (const root of (args.gcp || "").split(",").filter(Boolean)) {
    // core products: "Unique Icons/<Product>/SVG/<Name>-512-color(-rgb).svg"; categories: "Category Icons/<Cat>/SVG/…"
    for (const f of walk(root)) {
      const rel = relative(root, f);
      const parts = rel.split("/");
      const product = parts.length >= 3 ? parts[parts.length - 3] : basename(f, ".svg");
      const isCat = /Category Icons/.test(rel);
      if (!/SVG$/i.test(parts[parts.length - 2] || "")) continue;
      if (/-rgb\.svg$/i.test(f) === false && walk(dirname(f)).some((x) => /-rgb\.svg$/i.test(x))) continue;
      entries.push({ key: (isCat ? "category-" : "") + slug(product), name: product, cat: isCat ? "categories" : "products", file: f });
    }
  }
  if (args["gcp-legacy"]) {
    for (const f of walk(args["gcp-legacy"])) {
      const raw = basename(f, ".svg");
      entries.push({ key: slug(raw.replace(/_/g, "-")), name: title(raw).replace(/\b\w/g, (c) => c.toUpperCase()), cat: "products", file: f });
    }
  }
  pack("gcp", "Google Cloud", "Google Cloud icons — provided for architecture diagrams.", entries);
}
