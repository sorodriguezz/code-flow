/**
 * `.env` files ↔ JSON objects — the shape a Kubernetes secret, a CI variable group or a
 * docker-compose `environment:` block is copied between.
 *
 * Reads what dotenv reads: `KEY=value`, an optional `export`, `#` comments (also after an unquoted
 * value), single quotes taken literally, double quotes with `\n`, `\t`, `\"` and `\\` escapes and
 * spanning lines.
 */

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Line ${i + 1} is not KEY=value: ${line}`);
    const [, key, rest] = match;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // The value runs to the matching quote, across lines if it has to.
      let body = rest.slice(1);
      let end = closing(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closing(body, quote);
      }
      if (end < 0) throw new Error(`The value of ${key} has no closing ${quote}`);
      const value = body.slice(0, end);
      out[key] = quote === "'" ? value : value.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
    } else {
      out[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return out;
}

/** Index of the unescaped `quote` that ends `body`, or -1. */
function closing(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && quote === '"') i++;
    else if (body[i] === quote) return i;
  }
  return -1;
}

/**
 * A JSON object as `.env` lines. Values that are not strings are written as their JSON, and a value
 * is quoted only when it has to be — spaces, `#`, quotes or line breaks.
 */
export function toEnv(json: string, exportPrefix = false): string {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A .env file is one object: { \"KEY\": \"value\" }");
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, raw]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`«${key}» cannot be a variable name`);
      const value = typeof raw === "string" ? raw : JSON.stringify(raw);
      const quoted = /[\s#"'\\]/.test(value) || value === ""
        ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`
        : value;
      return `${exportPrefix ? "export " : ""}${key}=${quoted}`;
    })
    .join("\n");
}
