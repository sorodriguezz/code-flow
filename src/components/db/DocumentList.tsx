import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  MONGO_TOKEN_COLOR,
  tokenizeMongoDocument,
  type MongoToken,
} from "../../lib/db/mongoDocument";
import { useT } from "../../state/languageStore";

/**
 * A page of documents, one card each — the shape a collection is actually read in.
 *
 * The grid came first and is wrong as a default here. Flattening documents into columns invents a
 * schema the collection does not have: a field two documents in ten carry becomes a column that is
 * empty for the other eight, a nested object becomes a cell of JSON, and the order the fields were
 * written in — which is information, `_id` first and the timestamps last — is replaced by whatever
 * order the union of all keys happened to come out in. A document is a document; this draws it as
 * one, and the grid is still a click away for when columns *are* what you want.
 *
 * Colour comes from `tokenizeMongoDocument`, which marks the server's own text up rather than
 * reformatting it — see that module for why nothing here parses.
 */
export function DocumentList({
  documents,
  /** Absolute index of the first document, so the numbering keeps counting across pages instead of
   *  restarting at one on every page of the same collection. */
  offset = 0,
}: {
  documents: string[];
  offset?: number;
}) {
  // Windowed: a page of five hundred documents is tens of thousands of spans, and all of them
  // mounted at once is a visibly dropped frame every time a page lands.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(40);

  useEffect(() => {
    setVisible(40);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [documents]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining < 600) setVisible((current) => Math.min(current + 40, documents.length));
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-2">
      <div className="flex flex-col gap-1.5">
        {documents.slice(0, visible).map((document, index) => (
          <DocumentCard key={offset + index} text={document} number={offset + index + 1} />
        ))}
      </div>
    </div>
  );
}

/** How many lines a document shows before it is folded. Enough for the small ones to be whole, few
 *  enough that one fat document cannot push the next off the screen. */
const COLLAPSE_AFTER = 14;

function DocumentCard({ text, number }: { text: string; number: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tokenised per line, so folding can cut the document without the colouring drifting: a run that
  // spanned the cut would otherwise have to be split, and the split is where a string stops being
  // a string.
  const lines = useMemo(() => {
    // The outermost braces are the card itself — drawing them would be a `{` alone on the first
    // line and a `}` alone on the last, which is a frame around a frame. `[ \t]*` and not `\s*`
    // on the opening one: greedy whitespace eats past the newline into the first field's own
    // indent, and that field then sits two columns left of every field under it.
    const body = text
      .trim()
      .replace(/^\{[ \t]*\n?/, "")
      .replace(/\n[ \t]*\}$/, "");
    const rows = body.split("\n");
    // Dedent by what every line shares, so the top-level fields sit flush against the card and the
    // indentation that is left means nesting — which is the only thing it should mean.
    const common = rows
      .filter((line) => line.trim())
      .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity);
    const flush = Number.isFinite(common) && common > 0 ? rows.map((line) => line.slice(common)) : rows;
    return flush.map((line) => tokenizeMongoDocument(line));
  }, [text]);

  const foldable = lines.length > COLLAPSE_AFTER;
  const shown = foldable && !expanded ? lines.slice(0, COLLAPSE_AFTER) : lines;

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group/doc rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <span className="w-8 shrink-0 select-none pt-[1px] text-right text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {number}
        </span>
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-[17px]">
          {shown.map((tokens, index) => (
            <div key={index}>
              {tokens.map((token, position) => (
                <Token key={position} token={token} />
              ))}
            </div>
          ))}
        </pre>
        {/* Only on hover: a copy button per document is a lot of furniture on a page of forty, and
            the one you want is always the one the pointer is already over. */}
        <button
          type="button"
          onClick={copy}
          title={t("db.copyDocument")}
          aria-label={t("db.copyDocument")}
          className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:bg-black/[0.05] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover/doc:opacity-100 dark:hover:bg-white/[0.08]"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {foldable && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center gap-1 border-t border-[var(--cf-border)] px-2 py-1 text-[10.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded
            ? t("db.documentCollapse")
            : t("db.documentExpand", { n: lines.length - COLLAPSE_AFTER })}
        </button>
      )}
    </div>
  );
}

function Token({ token }: { token: MongoToken }) {
  // Punctuation and whitespace are the common case and carry the ordinary muted colour, so they
  // are emitted bare — a span each would double the node count for nothing.
  if (token.kind === "punct") return <>{token.text}</>;
  return <span style={{ color: MONGO_TOKEN_COLOR[token.kind] }}>{token.text}</span>;
}
