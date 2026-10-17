import type * as Monaco from "monaco-editor";

/**
 * Linked editing for tags outside HTML: renaming `<Card>` renames its `</Card>` as it is typed, in
 * JSX/TSX, XML, Vue and Svelte — what VS Code's `editor.linkedEditing` does there. Monaco's HTML
 * worker already answers for `html`; this answers for the rest, from the text alone.
 */

interface Tag {
  name: string;
  /** Offsets of the name itself. */
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

/** Past this a file is not scanned on every caret move. */
const MAX_TEXT = 400_000;

/** Every tag in `text`, in order. A `<` right after an identifier is a generic (`useState<T>`) or a
 *  comparison, not a tag (a `</` always is one); quotes and `{…}` inside a tag are stepped over to find its `>`. */
export function scanTags(text: string): Tag[] {
  const tags: Tag[] = [];
  const opener = /<(\/?)([A-Za-z][\w.:-]*)/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const closing = match[1] === "/";
    // Only an opening `<` can be a generic; `</` is a closing tag wherever it stands (`in</b>`).
    const before = text[match.index - 1] ?? "";
    if (!closing && /[\w$)\]]/.test(before)) continue;
    const start = match.index + 1 + match[1].length;
    const end = start + match[2].length;
    let i = end;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth <= 0) break;
    }
    if (i >= text.length) continue;
    tags.push({ name: match[2], start, end, closing, selfClosing: !closing && text[i - 1] === "/" });
    opener.lastIndex = i + 1;
  }
  return tags;
}

/** The two name ranges `[start, end)` to edit together for a caret at `offset`, or `null`. */
export function linkedTagRanges(text: string, offset: number): [number, number][] | null {
  if (text.length > MAX_TEXT) return null;
  const tags = scanTags(text);
  const stack: Tag[] = [];
  for (const tag of tags) {
    if (tag.selfClosing) continue;
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }
    // Pop to the nearest open tag of this name; an unmatched closing tag pairs with nothing.
    const at = stack.map((open) => open.name).lastIndexOf(tag.name);
    if (at < 0) continue;
    const open = stack[at];
    stack.length = at;
    for (const side of [open, tag]) {
      if (offset >= side.start && offset <= side.end) {
        return [
          [open.start, open.end],
          [tag.start, tag.end],
        ];
      }
    }
  }
  return null;
}

let installed = false;

export function installLinkedTags(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  const files = /\.(jsx|tsx|xml|svg|vue|svelte|xaml|csproj|plist)$/i;
  monaco.languages.registerLinkedEditingRangeProvider(["javascript", "typescript", "xml", "vue", "svelte"], {
    provideLinkedEditingRanges: (model, position) => {
      if (!files.test(model.uri.path)) return undefined;
      const ranges = linkedTagRanges(model.getValue(), model.getOffsetAt(position));
      if (!ranges) return undefined;
      return {
        ranges: ranges.map(([start, end]) => {
          const from = model.getPositionAt(start);
          const to = model.getPositionAt(end);
          return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
        }),
        wordPattern: /[A-Za-z][\w.:-]*/,
      };
    },
  });
}
