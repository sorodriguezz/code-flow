/**
 * Which value of a JSON text sits under a caret — «Guardar en variable…» on the response body.
 *
 * `JSON.parse` keeps no positions, so this is a small parser of its own that remembers, for every
 * value, where it starts and ends and the path that leads to it. A click on a key counts as a click
 * on its value: the key is what people point at when they mean "this field".
 */

export interface JsonHit {
  path: (string | number)[];
  value: unknown;
  /** Offsets of the value's text, end exclusive. */
  start: number;
  end: number;
}

interface Node {
  path: (string | number)[];
  start: number;
  end: number;
  /** For an object member: where its key starts and ends. */
  keyStart?: number;
  keyEnd?: number;
  value: unknown;
}

class Parser {
  at = 0;
  readonly nodes: Node[] = [];
  constructor(readonly text: string) {}

  space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at += 1;
  }

  fail(): never {
    throw new Error(`invalid JSON at ${this.at}`);
  }

  value(path: (string | number)[], key?: { start: number; end: number }): unknown {
    this.space();
    const start = this.at;
    const head = this.text[this.at];
    let value: unknown;
    if (head === "{") value = this.object(path);
    else if (head === "[") value = this.array(path);
    else if (head === '"') value = this.string();
    else value = this.literal();
    this.nodes.push({ path, start, end: this.at, value, keyStart: key?.start, keyEnd: key?.end });
    return value;
  }

  object(path: (string | number)[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.at += 1;
    this.space();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') this.fail();
      const keyStart = this.at;
      const key = this.string();
      const keyEnd = this.at;
      this.space();
      if (this.text[this.at] !== ":") this.fail();
      this.at += 1;
      out[key] = this.value([...path, key], { start: keyStart, end: keyEnd });
      this.space();
      if (this.text[this.at] === ",") {
        this.at += 1;
        continue;
      }
      if (this.text[this.at] === "}") {
        this.at += 1;
        return out;
      }
      this.fail();
    }
  }

  array(path: (string | number)[]): unknown[] {
    const out: unknown[] = [];
    this.at += 1;
    this.space();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return out;
    }
    for (;;) {
      out.push(this.value([...path, out.length]));
      this.space();
      if (this.text[this.at] === ",") {
        this.at += 1;
        continue;
      }
      if (this.text[this.at] === "]") {
        this.at += 1;
        return out;
      }
      this.fail();
    }
  }

  string(): string {
    const start = this.at;
    this.at += 1;
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      this.at += this.text[this.at] === "\\" ? 2 : 1;
    }
    if (this.at >= this.text.length) this.fail();
    this.at += 1;
    return JSON.parse(this.text.slice(start, this.at)) as string;
  }

  literal(): unknown {
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(this.text.slice(this.at, this.at + 64));
    if (!match) this.fail();
    this.at += match[0].length;
    return JSON.parse(match[0]);
  }
}

/** The innermost value at `offset` in `text`, or `null` when the text is not JSON or the offset
 *  falls between values (on a comma, in the margin). */
export function jsonValueAt(text: string, offset: number): JsonHit | null {
  const parser = new Parser(text);
  try {
    parser.value([]);
    parser.space();
    if (parser.at !== text.length) return null;
  } catch {
    return null;
  }
  let best: Node | null = null;
  for (const node of parser.nodes) {
    const onKey = node.keyStart !== undefined && offset >= node.keyStart && offset < (node.keyEnd ?? 0);
    const onValue = offset >= node.start && offset < node.end;
    if (!onKey && !onValue) continue;
    // Nodes are pushed children first, so the first one containing the offset is the innermost —
    // but a key belongs to the member, which wins over the object around it.
    if (best === null || node.path.length > best.path.length) best = node;
  }
  if (!best) return null;
  return { path: best.path, value: best.value, start: best.start, end: best.end };
}
