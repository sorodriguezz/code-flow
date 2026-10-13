import { describe, expect, it } from "vitest";
import { translations } from "../../../i18n/translations";
import { es } from "../../../i18n/translations.es";
import { ARCHIFY_MODES, parseArchify, type ArchifyDocument } from "../ir";
import { PRESET_IDS, presetNames, viewerLabels } from "../labels";
import { renderArchifyPage } from "../render";
import { compareArchitectures } from "../delta";
import { SAMPLES } from "../__fixtures__/samples";
import { VIEWER_CSS } from "./css";
import runtime from "./runtime.js?raw";

type Translate = (key: never, params?: Record<string, string | number>) => string;
const English = ((key: string) => (translations.en as Record<string, string>)[key] ?? `MISSING:${key}`) as unknown as Translate;
const Spanish = ((key: string) => (es as Record<string, string>)[key] ?? `MISSING:${key}`) as unknown as Translate;

function page(sample: unknown, extra: Partial<Parameters<typeof renderArchifyPage>[1]> = {}) {
  const result = renderArchifyPage(JSON.stringify(sample), {
    title: "Sample",
    language: "en",
    theme: "dark",
    labels: (mode) => viewerLabels(English as never, mode),
    presetNames: presetNames(English as never),
    linkSources: true,
    embed: false,
    ...extra,
  });
  if (result.kind !== "viewer") throw new Error(result.kind);
  return result;
}

describe("the runtime", () => {
  it("is a script that parses, and never contains the end of a script element", () => {
    expect(() => new Function(runtime)).not.toThrow();
    expect(runtime).not.toMatch(/<\/script/i);
  });

  it("only ever writes strings from the scene through textContent or attributes", () => {
    // The one innerHTML in it is the fixed set of icons; nothing from a diagram reaches markup.
    const uses = runtime.split("\n").filter((l) => /innerHTML/.test(l));
    for (const line of uses) expect(line).toMatch(/icon\(|ICONS\[|\+ "<span><\/span>"/);
    expect(runtime).not.toMatch(/document\.write|insertAdjacentHTML|eval\(/);
  });
});

describe("the page", () => {
  it.each(Object.entries(SAMPLES))("%s: one data block, one script, nothing fetched", (_name, sample) => {
    const { html } = page(sample);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(link|img|iframe)\b|src=|href="http/i);
    const data = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1];
    const payload = JSON.parse(data);
    expect(payload.scene.nodes.length).toBeGreaterThan(2);
    expect(payload.presets.map((p: { id: string }) => p.id)).toEqual([...PRESET_IDS]);
  });

  it("carries every authored string as data, so markup in a label stays text", () => {
    const hostile = JSON.parse(JSON.stringify(SAMPLES.ARCHITECTURE));
    hostile.components[0].label = "</script><img src=x onerror=alert(1)>";
    hostile.meta.subtitle = "<b onclick=alert(2)>subtitle</b>";
    const { html } = page(hostile, { title: "Shop <b>" });
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("<title>Shop &#60;b&#62;</title>");
    const data = JSON.parse(/id="data">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.scene.nodes[0].lines.join(" ")).toContain("</script>");
  });

  it("links sources only where asked, and only to a pinned GitHub commit", () => {
    const pinned = JSON.parse(JSON.stringify(SAMPLES.ARCHITECTURE));
    pinned.meta.repository = { url: "https://github.com/example/shop.git", revision: "b".repeat(40), provider: "github", link_mode: "web" };
    const hrefs = (linkSources: boolean) =>
      page(pinned, { linkSources }).scene.nodes.flatMap((n) => n.sources.map((s) => s.href));
    expect(hrefs(false).every((h) => h === "")).toBe(true);
    expect(hrefs(true)).toContain(`https://github.com/example/shop/blob/${"b".repeat(40)}/web/src/main.tsx#L1-L40`);
    const local = { ...pinned, meta: { ...pinned.meta, repository: { ...pinned.meta.repository, link_mode: "local-only", provider: undefined } } };
    expect(page(local, { linkSources: true }).scene.nodes.flatMap((n) => n.sources.map((s) => s.href)).every((h) => h === "")).toBe(true);
  });

  it("is titled with the row's name, not the document's", () => {
    const result = page(SAMPLES.SEQUENCE, { title: "My trace" });
    expect(result.scene.title).toBe("My trace");
    expect(result.html).toContain("<title>My trace</title>");
  });

  it("hands a page archify rendered back as it is", () => {
    const rendered = '<!doctype html><html><head><meta name="generator" content="archify 3.0.1"></head></html>';
    const result = renderArchifyPage(rendered, { title: "x", language: "en", theme: "dark", labels: (m) => viewerLabels(English as never, m), presetNames: {}, linkSources: false, embed: true });
    expect(result).toEqual({ kind: "html", html: rendered });
    expect(renderArchifyPage('{"diagram_type":"pie"}', { title: "x", language: "en", theme: "dark", labels: (m) => viewerLabels(English as never, m), presetNames: {}, linkSources: false, embed: true })).toEqual({ kind: "invalid", error: "mode", mode: "pie" });
  });
});

describe("the stylesheet", () => {
  it("keeps the canvas the row that stretches, with the title block gone or everything but it", () => {
    expect(VIEWER_CSS).toContain(".app.embed{grid-template-rows:auto minmax(0,1fr) auto}");
    expect(VIEWER_CSS).toContain(".app.present{grid-template-rows:minmax(0,1fr)}");
  });

  it("colours every kind the scenes use, in both schemes, and has no colour-mix to fall back from", () => {
    for (const kind of ["frontend", "backend", "database", "cloud", "security", "messagebus", "external", "start", "active", "waiting", "decision", "success", "failure", "neutral"]) {
      expect(VIEWER_CSS).toContain(`--ks-${kind}:`);
      expect(VIEWER_CSS).toContain(`.k-${kind}{`);
    }
    expect(VIEWER_CSS).toContain('.app[data-theme="light"]');
    expect(VIEWER_CSS).not.toContain("color-mix");
    for (const preset of PRESET_IDS.filter((p) => p !== "classic")) expect(VIEWER_CSS).toContain(`data-preset="${preset}"`);
  });
});

describe.each([["English", English], ["Spanish", Spanish]])("the viewer's words in %s", (_name, t) => {
  it.each([...ARCHIFY_MODES])("%s: every key exists, and the placeholders the runtime fills are there", (mode) => {
    const labels = viewerLabels(t as never, mode);
    const flat = [...Object.values(labels).filter((v): v is string => typeof v === "string"), ...Object.values(labels.types)];
    expect(flat.filter((v) => v.startsWith("MISSING:"))).toEqual([]);
    expect(labels.counts).toContain("{entities}");
    expect(labels.counts).toContain("{relations}");
    expect(labels.routePickTo).toContain("{name}");
    expect(labels.statusUp).toMatch(/\{name\}.*\{n\}.*\{total\}/);
    expect(Object.values(presetNames(t as never)).filter((v) => v.startsWith("MISSING:"))).toEqual([]);
  });

  it("names every key the runtime asks the page's labels for", () => {
    const asked = new Set([...runtime.matchAll(/label\("([A-Za-z_]+)"/g)].map((m) => m[1]));
    const labels = viewerLabels(t as never, "architecture") as Record<string, unknown>;
    // `status_*` are the one family built at runtime from a value.
    for (const key of asked) if (!key.startsWith("status_")) expect(Object.keys(labels), `label("${key}")`).toContain(key);
  });
});

describe("a comparison", () => {
  const base = JSON.parse(JSON.stringify(SAMPLES.ARCHITECTURE));
  const head = JSON.parse(JSON.stringify(SAMPLES.ARCHITECTURE));
  head.components = head.components.filter((c: { id: string }) => c.id !== "cdn");
  head.components.push({ id: "search", type: "database", label: "Search index" });
  head.components.find((c: { id: string }) => c.id === "api").sublabel = "Node · Fastify v5";
  head.connections = head.connections.filter((c: { to: string }) => c.to !== "cdn");
  head.connections.push({ from: "api", to: "search", label: "index" });
  const parse = (doc: unknown): ArchifyDocument => {
    const r = parseArchify(JSON.stringify(doc), "x");
    if ("error" in r) throw new Error(r.error);
    return r.ir;
  };

  it("marks what was added, removed and changed, on the nodes and on the lines", () => {
    const a = parse(base);
    const b = parse(head);
    if (a.diagram_type !== "architecture" || b.diagram_type !== "architecture") throw new Error();
    const scene = compareArchitectures(a, b);
    const status = (id: string) => scene.nodes.find((n) => n.id === id)?.status;
    expect(status("search")).toBe("added");
    expect(status("cdn")).toBe("removed");
    expect(status("api")).toBe("changed");
    expect(status("db")).toBeUndefined();
    expect(scene.delta).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(scene.edges.filter((e) => e.status === "added").map((e) => e.label)).toEqual(["index"]);
    expect(scene.edges.filter((e) => e.status === "removed").map((e) => e.label)).toEqual(["assets"]);
    // Everything is still placed, the removed ones too.
    expect(scene.nodes.find((n) => n.id === "cdn")!.box[2]).toBeGreaterThan(0);
  });
});
