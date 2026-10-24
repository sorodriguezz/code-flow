/**
 * CSV ↔ JSON and query string ↔ JSON.
 *
 * The CSV reader follows RFC 4180 — quoted fields, doubled quotes, line breaks inside quotes —
 * and guesses the delimiter from the first line when asked to (`;` is what Excel writes in
 * Spanish locales, which is half the CSVs this tool will see).
 */

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const count = first.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // A BOM at the start is Excel's, not data.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unclosed quote");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Numbers, booleans and `null` back as themselves when `infer` is on. */
function inferValue(text: string): unknown {
  if (text === "") return "";
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) && !(text.length > 15 && !text.includes("."))) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return text;
}

export function csvToJson(text: string, delimiter = ",", header = true, infer = true): unknown[] {
  const rows = parseCsv(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
  const conv = (v: string) => (infer ? inferValue(v) : v);
  if (!header) return rows.map((r) => r.map(conv));
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h, i) => h || `column${i + 1}`);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, conv(r[i] ?? "")])));
}

function csvField(value: unknown, delimiter: string): string {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Nested objects become dotted columns (`address.city`); arrays stay as JSON in one cell. */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix || "value"] = value;
  return out;
}

export function jsonToCsv(value: unknown, delimiter = ",", flattenNested = true): string {
  const list = Array.isArray(value) ? value : [value];
  const rows: Record<string, unknown>[] = list.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? flattenNested
        ? flatten(item)
        : (item as Record<string, unknown>)
      : { value: item },
  );
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const lines = [keys.map((k) => csvField(k, delimiter)).join(delimiter)];
  for (const r of rows) lines.push(keys.map((k) => csvField(r[k], delimiter)).join(delimiter));
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------------------------

/**
 * `a=1&b=2&b=3&c[d]=4` → `{ a: "1", b: ["2", "3"], c: { d: "4" } }`. Repeated keys become arrays
 * and bracketed keys nest, which is how PHP, Rails and `qs` read them.
 */
export function queryToJson(query: string): Record<string, unknown> {
  const text = query.trim().replace(/^[^?]*\?/, "").replace(/^\?/, "").split("#")[0];
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const path = rawKey.split(/\[|\]\[|\]/).filter((p, i) => p !== "" || i === 0);
    const isPush = rawKey.endsWith("[]");
    let node: Record<string, unknown> = out;
    for (let i = 0; i < path.length - 1; i++) {
      const next = node[path[i]];
      if (!next || typeof next !== "object" || Array.isArray(next)) node[path[i]] = {};
      node = node[path[i]] as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    const existing = node[last];
    if (isPush) node[last] = Array.isArray(existing) ? [...existing, value] : existing === undefined ? [value] : [existing, value];
    else if (existing === undefined) node[last] = value;
    else node[last] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

export function jsonToQuery(value: unknown): string {
  const params = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (Array.isArray(v)) v.forEach((item) => (item && typeof item === "object" ? walk(item, `${key}[]`) : params.append(key, String(item))));
    else if (v && typeof v === "object") for (const [k, inner] of Object.entries(v)) walk(inner, key ? `${key}[${k}]` : k);
    else params.append(key, v === null || v === undefined ? "" : String(v));
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A query string is built from a JSON object");
  walk(value, "");
  return params.toString();
}
