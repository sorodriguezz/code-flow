import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  MONGO_TOKEN_COLOR,
  tokenizeMongoDocument,
  type MongoToken,
} from "../../lib/db/mongoDocument";
import { useT } from "../../state/languageStore";

/**
 * What Apply would do to a document, which is what its card is tinted by.
 *
 * The same vocabulary the grid marks its rows with, for the same reason: staged is not saved, and a
 * card that looked identical before and after being edited would make Apply a leap of faith.
 */
export type DocumentState = "clean" | "edited" | "deleted" | "new";

/**
 * What a card offers besides Copy, which it always offers. Absent altogether in the console, where
 * an arbitrary query's documents have no one collection to write back to — see the note on
 * `DocumentList`.
 *
 * The two that write a *whole* document are optional on their own: under a projection what is on
 * screen is only part of a document, and writing that back would delete the rest. The panel decides;
 * the card just doesn't draw the button it wasn't given.
 */
export interface DocumentActions {
  onEdit?: (index: number) => void;
  onClone?: (index: number) => void;
  /** Toggles: a document already staged for deletion is put back by the same button. */
  onDelete?: (index: number) => void;
}

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
 * **Two modes, one component.** `fields` strips the outer braces and dedents, so the card *is* the
 * document and what indentation remains means nesting. `json` leaves the text exactly as the server
 * wrote it, braces and all — the difference between reading a record and reading its wire form, and
 * the reason both are offered. Sharing the component is what keeps the two views from drifting into
 * different foldings, different numbering and different actions.
 *
 * Colour comes from `tokenizeMongoDocument`, which marks the server's own text up rather than
 * reformatting it — see that module for why nothing here parses.
 */
export function DocumentList({
  documents,
  /** Absolute index of the first document, so the numbering keeps counting across pages instead of
   *  restarting at one on every page of the same collection. */
  offset = 0,
  mode = "fields",
  actions,
  /** What Apply would do to each document. Everything is `clean` when it isn't given. */
  stateOf,
}: {
  documents: string[];
  offset?: number;
  mode?: "fields" | "json";
  actions?: DocumentActions;
  stateOf?: (index: number) => DocumentState;
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
        {documents.slice(0, visible).map((document, index) => {
          const state = stateOf?.(index) ?? "clean";
          return (
            <DocumentCard
              key={index}
              text={document}
              mode={mode}
              state={state}
              // A staged document exists nowhere yet, so it has no place in the page's numbering —
              // the grid marks its own new rows the same way.
              number={state === "new" ? null : offset + index + 1}
              actions={actions}
              index={index}
            />
          );
        })}
      </div>
    </div>
  );
}

/** How many lines a document shows before it is folded. Enough for the small ones to be whole, few
 *  enough that one fat document cannot push the next off the screen. */
const COLLAPSE_AFTER = 14;

/** Border and background per staged state — the grid's own tints, so a document staged for deletion
 *  looks the same whichever of the three views is up. */
const STATE_STYLE: Record<DocumentState, string> = {
  clean: "border-[var(--cf-border)] bg-[var(--cf-surface)]",
  edited: "border-[var(--cf-warning)]/50 bg-[var(--cf-warning)]/[0.08]",
  deleted: "border-[var(--cf-danger)]/50 bg-[var(--cf-danger)]/[0.07]",
  new: "border-[var(--cf-success)]/50 bg-[var(--cf-success)]/[0.07]",
};

function DocumentCard({
  text,
  number,
  mode,
  state,
  actions,
  index,
}: {
  text: string;
  number: number | null;
  mode: "fields" | "json";
  state: DocumentState;
  actions?: DocumentActions;
  index: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tokenised per line, so folding can cut the document without the colouring drifting: a run that
  // spanned the cut would otherwise have to be split, and the split is where a string stops being
  // a string.
  const lines = useMemo(() => {
    if (mode === "json") return text.split("\n").map((line) => tokenizeMongoDocument(line));
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
  }, [text, mode]);

  const foldable = lines.length > COLLAPSE_AFTER;
  const shown = foldable && !expanded ? lines.slice(0, COLLAPSE_AFTER) : lines;

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`group/doc rounded-md border ${STATE_STYLE[state]}`}>
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <span className="w-8 shrink-0 select-none pt-[1px] text-right text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {number ?? "+"}
        </span>
        <pre
          className={`min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-[17px] ${
            state === "deleted" ? "line-through opacity-60" : ""
          }`}
        >
          {shown.map((tokens, position) => (
            <div key={position}>
              {tokens.map((token, tokenIndex) => (
                <Token key={tokenIndex} token={token} />
              ))}
            </div>
          ))}
        </pre>
        {/* Only on hover: four buttons per document is a lot of furniture on a page of forty, and
            the document you want to act on is always the one the pointer is already over. Focus
            brings them back for the keyboard, which has no pointer to be over anything with. */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/doc:opacity-100">
          {actions?.onEdit && (
            <CardButton
              onClick={() => actions.onEdit?.(index)}
              title={t("db.editDocument")}
              disabled={state === "deleted"}
            >
              <Pencil size={11} />
            </CardButton>
          )}
          <CardButton onClick={copy} title={t("db.copyDocument")}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </CardButton>
          {actions?.onClone && (
            <CardButton onClick={() => actions.onClone?.(index)} title={t("db.cloneDocument")}>
              <CopyPlus size={11} />
            </CardButton>
          )}
          {actions?.onDelete && (
            <CardButton
              onClick={() => actions.onDelete?.(index)}
              title={
                state === "deleted"
                  ? t("db.undoDelete")
                  : state === "new"
                    ? t("db.discardDocument")
                    : t("db.deleteDocument")
              }
              danger={state !== "deleted"}
            >
              {state === "deleted" ? (
                <RotateCcw size={11} />
              ) : state === "new" ? (
                <X size={11} />
              ) : (
                <Trash2 size={11} />
              )}
            </CardButton>
          )}
        </div>
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

/** One of the icon buttons in a card's corner. Its own component because there are four of them per
 *  card and they must be the same size, or the row of them reads as a ranking. */
function CardButton({
  onClick,
  title,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`rounded p-1 transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08] ${
        danger
          ? "text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Token({ token }: { token: MongoToken }) {
  // Punctuation and whitespace are the common case and carry the ordinary muted colour, so they
  // are emitted bare — a span each would double the node count for nothing.
  if (token.kind === "punct") return <>{token.text}</>;
  return <span style={{ color: MONGO_TOKEN_COLOR[token.kind] }}>{token.text}</span>;
}
