/**
 * XML: a small reader, a formatter, and the conversion to and from JSON.
 *
 * Our own reader rather than `DOMParser`, for two reasons: it has to say *where* a document is
 * broken (DOMParser hands back a `<parsererror>` page whose wording differs per engine), and the
 * pure logic has to run under vitest, which has no DOM here.
 *
 * The JSON shape is the common convention (xml2js / fast-xml-parser): attributes as `@name`, text
 * beside attributes or children as `#text`, repeated child elements as arrays.
 */

export type XmlNode =
  | { type: "element"; name: string; attrs: [string, string][]; children: XmlNode[] }
  | { type: "text"; value: string }
  | { type: "cdata"; value: string }
  | { type: "comment"; value: string }
  | { type: "pi"; value: string }
  | { type: "doctype"; value: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body[0] === "#") return String.fromCodePoint(body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string, attr = false): string {
  const out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return attr ? out.replace(/"/g, "&quot;") : out;
}

function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `line ${line}, column ${offset - before.lastIndexOf("\n")}`;
}

export function parseXml(text: string): XmlNode[] {
  let i = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} (${position(text, i)})`);
  };
  const root: XmlNode[] = [];
  const stack: { name: string; children: XmlNode[] }[] = [{ name: "", children: root }];
  const top = () => stack[stack.length - 1].children;
  while (i < text.length) {
    if (text[i] !== "<") {
      const end = text.indexOf("<", i);
      const raw = text.slice(i, end === -1 ? text.length : end);
      if (stack.length === 1 && raw.trim()) fail("Text outside the root element");
      if (raw) top().push({ type: "text", value: decodeEntities(raw) });
      i = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) fail("Unclosed comment");
      top().push({ type: "comment", value: text.slice(i + 4, end) });
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end === -1) fail("Unclosed CDATA section");
      top().push({ type: "cdata", value: text.slice(i + 9, end) });
      i = end + 3;
    } else if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end === -1) fail("Unclosed processing instruction");
      top().push({ type: "pi", value: text.slice(i + 2, end) });
      i = end + 2;
    } else if (text.startsWith("<!", i)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth === 0) break;
      }
      if (j >= text.length) fail("Unclosed declaration");
      top().push({ type: "doctype", value: text.slice(i + 2, j) });
      i = j + 1;
    } else if (text[i + 1] === "/") {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i));
      if (!m) fail("Malformed closing tag");
      const open = stack.pop();
      if (!open || !open.name) fail(`Closing tag </${m![1]}> with nothing open`);
      if (open!.name !== m![1]) fail(`Expected </${open!.name}> but found </${m![1]}>`);
      i += m![0].length;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i));
      if (!m) fail("Malformed tag");
      const name = m![1];
      i += m![0].length;
      const attrs: [string, string][] = [];
      for (;;) {
        const ws = /^\s*/.exec(text.slice(i))![0];
        i += ws.length;
        if (text.startsWith("/>", i)) {
          top().push({ type: "element", name, attrs, children: [] });
          i += 2;
          break;
        }
        if (text[i] === ">") {
          const el: XmlNode = { type: "element", name, attrs, children: [] };
          top().push(el);
          stack.push({ name, children: el.children });
          i++;
          break;
        }
        const a = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.slice(i));
        if (!a || !ws) fail(`Malformed attribute in <${name}>`);
        if (attrs.some(([k]) => k === a![1])) fail(`Duplicate attribute ${a![1]}`);
        attrs.push([a![1], decodeEntities(a![3] ?? a![4] ?? "")]);
        i += a![0].length;
      }
    }
  }
  if (stack.length > 1) fail(`Unclosed <${stack[stack.length - 1].name}>`);
  if (!root.some((n) => n.type === "element")) throw new Error("No root element");
  if (root.filter((n) => n.type === "element").length > 1) throw new Error("More than one root element");
  return root;
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

function serialize(nodes: XmlNode[], indent: string, depth: number, out: string[]): void {
  const pad = indent ? "\n" + indent.repeat(depth) : "";
  for (const n of nodes) {
    switch (n.type) {
      case "text": {
        const t = indent ? n.value.trim() : n.value;
        if (t) out.push(pad + escapeXml(t));
        break;
      }
      case "cdata":
        out.push(`${pad}<![CDATA[${n.value}]]>`);
        break;
      case "comment":
        out.push(`${pad}<!--${n.value}-->`);
        break;
      case "pi":
        out.push(`${pad}<?${n.value}?>`);
        break;
      case "doctype":
        out.push(`${pad}<!${n.value}>`);
        break;
      case "element": {
        const attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeXml(v, true)}"`).join("");
        const kids = indent ? n.children.filter((c) => c.type !== "text" || c.value.trim()) : n.children;
        if (!kids.length) out.push(`${pad}<${n.name}${attrs}/>`);
        else if (kids.length === 1 && kids[0].type === "text") {
          out.push(`${pad}<${n.name}${attrs}>${escapeXml(indent ? kids[0].value.trim() : kids[0].value)}</${n.name}>`);
        } else {
          out.push(`${pad}<${n.name}${attrs}>`);
          serialize(kids, indent, depth + 1, out);
          out.push(`${pad}</${n.name}>`);
        }
      }
    }
  }
}

export function formatXml(text: string, indent = "  "): string {
  const out: string[] = [];
  serialize(parseXml(text), indent, 0, out);
  return out.join("").replace(/^\n/, "");
}

export function minifyXml(text: string): string {
  const strip = (nodes: XmlNode[]): XmlNode[] =>
    nodes
      .filter((n) => n.type !== "comment" && (n.type !== "text" || n.value.trim()))
      .map((n) => (n.type === "element" ? { ...n, children: strip(n.children) } : n.type === "text" ? { ...n, value: n.value.trim() } : n));
  const out: string[] = [];
  serialize(strip(parseXml(text)), "", 0, out);
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// XML ↔ JSON
// ---------------------------------------------------------------------------------------------

function elementToJson(el: Extract<XmlNode, { type: "element" }>): unknown {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of el.attrs) obj[`@${k}`] = v;
  let text = "";
  for (const c of el.children) {
    if (c.type === "text" || c.type === "cdata") text += c.value;
    else if (c.type === "element") {
      const value = elementToJson(c);
      if (c.name in obj) {
        const prev = obj[c.name];
        obj[c.name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      } else obj[c.name] = value;
    }
  }
  const trimmed = text.trim();
  if (Object.keys(obj).length === 0) return trimmed;
  if (trimmed) obj["#text"] = trimmed;
  return obj;
}

export function xmlToJson(text: string): unknown {
  const root = parseXml(text).find((n) => n.type === "element") as Extract<XmlNode, { type: "element" }>;
  return { [root.name]: elementToJson(root) };
}

function jsonToNodes(name: string, value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.flatMap((v) => jsonToNodes(name, v));
  if (value && typeof value === "object") {
    const attrs: [string, string][] = [];
    const children: XmlNode[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("@")) attrs.push([k.slice(1), String(v)]);
      else if (k === "#text") children.push({ type: "text", value: String(v) });
      else children.push(...jsonToNodes(k, v));
    }
    return [{ type: "element", name, attrs, children }];
  }
  return [{ type: "element", name, attrs: [], children: value === null || value === undefined ? [] : [{ type: "text", value: String(value) }] }];
}

const xmlName = (k: string) => (/^[A-Za-z_][\w.:-]*$/.test(k) ? k : `_${k.replace(/[^\w.:-]/g, "_")}`);

export function jsonToXml(value: unknown, indent = "  ", rootName = "root"): string {
  let nodes: XmlNode[];
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1) {
    const [k, v] = Object.entries(value)[0];
    nodes = jsonToNodes(xmlName(k), v);
  } else nodes = jsonToNodes(rootName, value);
  // Element names have to be valid XML names; JSON keys can be anything.
  const fix = (ns: XmlNode[]): XmlNode[] =>
    ns.map((n) => (n.type === "element" ? { ...n, name: xmlName(n.name), children: fix(n.children) } : n));
  if (nodes.length > 1) nodes = [{ type: "element", name: rootName, attrs: [], children: nodes }];
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serialize(fix(nodes), indent, 0, out);
  return out.join("");
}
