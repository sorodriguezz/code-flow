/**
 * Colouring for the document text the Mongo driver sends up.
 *
 * **Why a tokenizer and not `JSON.parse`.** What arrives is not JSON. `bson_to_json_text` writes
 * the shell dialect on purpose — `ObjectId("…")`, `ISODate("…")`, `NumberDecimal("…")` — so a value
 * copied out of a document can be pasted straight back into a query. `JSON.parse` throws on the
 * first `_id`. Parsing it into a tree would also mean re-emitting it, and re-emitting is where key
 * order gets lost; the backend went to the trouble of sending text precisely so `_id` stays first.
 *
 * So the text is left exactly as it came and only *marked up*: the scanner walks it once and
 * returns runs with a kind attached. Nothing is reordered, nothing is reformatted, and a construct
 * this scanner has never heard of comes out as plain text rather than as a parse error.
 */

export type MongoTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "id"
  | "date"
  | "punct";

export interface MongoToken {
  text: string;
  kind: MongoTokenKind;
}

/** The shell constructors the writer emits, and the colour each one reads as. Anything else that
 *  looks like a call keeps the identifier's own colour rather than being guessed at. */
const CONSTRUCTORS: Record<string, MongoTokenKind> = {
  ObjectId: "id",
  UUID: "id",
  ISODate: "date",
  Timestamp: "date",
  NumberDecimal: "number",
  NumberLong: "number",
  NumberInt: "number",
  BinData: "string",
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/;

/**
 * Splits one document's text into coloured runs.
 *
 * A hand-written scanner rather than a regex sweep because of the one distinction that matters and
 * that a regex cannot make locally: `"name"` before a colon is a field and `"Ana"` after one is a
 * value, and they are the same three tokens apart from what follows. So strings are emitted only
 * once the scanner has looked past the closing quote for a `:`.
 */
export function tokenizeMongoDocument(text: string): MongoToken[] {
  const tokens: MongoToken[] = [];
  let index = 0;

  /** Appends to the previous run when the kind matches, so a document is a few hundred spans
   *  rather than a few thousand — whitespace and punctuation would otherwise be one each. */
  const push = (chunk: string, kind: MongoTokenKind) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += chunk;
    else tokens.push({ text: chunk, kind });
  };

  while (index < text.length) {
    const rest = text.slice(index);
    const char = rest[0];

    // A string, and whether it is a field name. `readString` returns the raw slice including its
    // quotes and escapes, so what is drawn is byte-for-byte what the server sent.
    if (char === '"' || char === "'") {
      const literal = readString(rest);
      if (literal === null) {
        // An unterminated quote — a truncated document. The rest is one string rather than a throw.
        push(rest, "string");
        break;
      }
      const after = rest.slice(literal.length);
      const isKey = /^\s*:/.test(after);
      push(literal, isKey ? "key" : "string");
      index += literal.length;
      continue;
    }

    if (NUMBER.test(rest) && !/[\w$]/.test(text[index - 1] ?? "")) {
      const [match] = NUMBER.exec(rest) as RegExpExecArray;
      push(match, "number");
      index += match.length;
      continue;
    }

    const identifier = IDENTIFIER.exec(rest);
    if (identifier) {
      const word = identifier[0];
      if (word === "true" || word === "false" || word === "null") {
        push(word, "literal");
      } else {
        // `ObjectId` and friends colour the *name*; the quoted argument that follows is picked up
        // on the next pass and coloured as the constructor's own kind, so `ObjectId("…")` reads as
        // one thing rather than as a word beside an unrelated green string.
        const kind = CONSTRUCTORS[word];
        if (kind && rest.slice(word.length).trimStart().startsWith("(")) {
          const call = readCall(rest, word.length);
          push(call ?? word, kind);
          index += (call ?? word).length;
          continue;
        }
        push(word, "punct");
      }
      index += word.length;
      continue;
    }

    push(char, "punct");
    index += 1;
  }

  return tokens;
}

/** The whole string literal starting at `text[0]`, quotes included, or `null` if it never closes. */
function readString(text: string): string | null {
  const quote = text[0];
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) return text.slice(0, i + 1);
  }
  return null;
}

/**
 * A constructor call from its name through the matching `)`, or `null` if it never closes.
 *
 * Quote-aware, because a `)` inside the argument is data — a regex would end `BinData("a)b")` in
 * the wrong place and the rest of the document would be coloured as fallout from it.
 */
function readCall(text: string, nameLength: number): string | null {
  let i = text.indexOf("(", nameLength);
  if (i < 0) return null;
  for (i += 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'") {
      const literal = readString(text.slice(i));
      if (literal === null) return null;
      i += literal.length - 1;
      continue;
    }
    if (char === ")") return text.slice(0, i + 1);
  }
  return null;
}

/**
 * The same document without its `_id`, for cloning.
 *
 * A clone that kept the id would be rejected as a duplicate key; dropping the field is how you ask
 * the server for a new one, and the server is the right thing to ask — an id invented here would be
 * an ObjectId generated by a webview, with a machine and process component that mean nothing.
 *
 * Textual, like everything else in this module, and for the same reason: parsing the document to
 * delete one key means re-emitting it, and re-emitting is where field order is lost. So the line the
 * field occupies is cut out of the text the server sent and the rest is left byte-for-byte alone.
 * Only a *top-level* `_id` is matched — a nested `{author: {_id: …}}` is somebody's data.
 */
export function documentWithoutId(text: string): string {
  const lines = text.split("\n");
  // Two spaces of indent is what `bson_to_json_text` gives a top-level field. Anything deeper is
  // nested, anything shallower is the braces.
  const index = lines.findIndex((line) => /^ {2}"_id"\s*:/.test(line));
  if (index < 0) return text;
  const removed = lines.filter((_, position) => position !== index);
  // The comma that separated it from its neighbour. If `_id` was last, the line before it is now
  // the last field and must lose the trailing comma it no longer needs.
  const previous = index - 1;
  if (index === lines.length - 2 && previous >= 0) {
    removed[previous] = removed[previous].replace(/,\s*$/, "");
  }
  return removed.join("\n");
}

/** The CSS custom property each kind is drawn in. Keys and punctuation ride the ordinary text
 *  colours so the *values* are what the eye picks out — which is the whole point of colouring. */
export const MONGO_TOKEN_COLOR: Record<MongoTokenKind, string> = {
  key: "var(--cf-text)",
  string: "var(--cf-bson-string)",
  number: "var(--cf-bson-number)",
  literal: "var(--cf-bson-literal)",
  id: "var(--cf-bson-id)",
  date: "var(--cf-bson-date)",
  punct: "var(--cf-text-muted)",
};
