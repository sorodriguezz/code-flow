import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { isViewFind } from "../../lib/useFindShortcut";
import { isMac } from "../../lib/platform";
import { useT } from "../../state/languageStore";

/** The two highlight names `index.css` paints (`::highlight(...)`). One pair for the whole window:
 *  only the chat whose bar is open holds them. */
const ALL = "cf-chat-find";
const CURRENT = "cf-chat-find-current";
/** Matches counted at most — past it the count says `999+` and the rest are not painted. */
const MAX_MATCHES = 999;
/** A transcript growing under an open search (an answer streaming in) is searched again this long
 *  after it settles. */
const RESCAN_MS = 200;

type Registry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** The CSS Custom Highlight API where the webview has it (WKWebView 17.2+, WebView2); without it the
 *  search still counts and scrolls, it only paints nothing. */
function highlightApi(): { registry: Registry; Highlight: HighlightCtor } | null {
  const registry = (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/** Every case-insensitive occurrence of `needle` in the text under `root`, as ranges, in order. */
export function findRanges(root: HTMLElement, needle: string): Range[] {
  const query = needle.toLocaleLowerCase();
  if (!query) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLocaleLowerCase();
    // A code block's bar (its language and buttons) is chrome, not part of the answer.
    if (node.parentElement?.closest(".cf-chat-code-bar")) continue;
    for (let at = text.indexOf(query); at >= 0 && ranges.length < MAX_MATCHES; at = text.indexOf(query, at + query.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * ⌘F / Ctrl+F inside a chat of the assistant: a bar over the transcript that finds text in it —
 * every match painted, the current one brighter and scrolled to, Enter / ⇧Enter to walk them.
 *
 * Scoped to the chat it is in: the chord is taken only when the focus is inside `rootRef` (the
 * transcript or the composer) and the chat is on screen, so ⌘F anywhere else in the app is still
 * whatever it was. The ranges are painted with the Custom Highlight API rather than by wrapping the
 * text in marks — the transcript is React's and its code blocks are coloured in place, and neither
 * may be rewritten under them.
 */
export function useChatFind({
  rootRef,
  contentRef,
  scrollRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrentState] = useState(0);
  /** The same index, for the callbacks that must not wait for a render to read it. */
  const currentRef = useRef(0);
  const setCurrent = (index: number) => {
    currentRef.current = index;
    setCurrentState(index);
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  const show = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.offsetParent === null || !isViewFind(event, isMac())) return;
      if (!(event.target instanceof Node) || !root.contains(event.target)) return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef, show]);

  /** Paints the ranges, the current one apart, and scrolls it into the middle of the transcript. */
  const paint = useCallback(
    (index: number, scroll: boolean) => {
      const ranges = rangesRef.current;
      const api = highlightApi();
      if (api) {
        api.registry.set(ALL, new api.Highlight(...ranges));
        if (ranges[index]) api.registry.set(CURRENT, new api.Highlight(ranges[index]));
        else api.registry.delete(CURRENT);
      }
      const scroller = scrollRef.current;
      const range = ranges[index];
      if (!scroll || !scroller || !range) return;
      const box = range.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      if (box.top < frame.top + 24 || box.bottom > frame.bottom - 24) {
        scroller.scrollTop += box.top - frame.top - frame.height / 2;
      }
    },
    [scrollRef],
  );

  /** Searches again from scratch: on a new query, and when the transcript changes under the bar. */
  const scan = useCallback(
    (keep: boolean) => {
      const content = contentRef.current;
      rangesRef.current = content && open ? findRanges(content, query) : [];
      const total = rangesRef.current.length;
      setCount(total);
      const next = keep ? Math.min(currentRef.current, Math.max(0, total - 1)) : 0;
      setCurrent(next);
      paint(next, !keep);
    },
    [contentRef, open, query, paint],
  );

  useEffect(() => {
    scan(false);
  }, [scan]);

  useEffect(() => {
    const content = contentRef.current;
    if (!open || !content || !query) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => scan(true), RESCAN_MS);
    });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open, query, contentRef, scan]);

  // Closed or gone: nothing of this search stays painted.
  useEffect(() => {
    if (open) return;
    const api = highlightApi();
    api?.registry.delete(ALL);
    api?.registry.delete(CURRENT);
  }, [open]);
  useEffect(
    () => () => {
      const api = highlightApi();
      api?.registry.delete(ALL);
      api?.registry.delete(CURRENT);
    },
    [],
  );

  const step = (delta: number) => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    const next = (currentRef.current + delta + total) % total;
    setCurrent(next);
    paint(next, true);
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return { open, show, close, query, setQuery, count, current, step, inputRef };
}

/** The bar itself, drawn by the chat over its transcript while the search is open. */
export function ChatFindBar({ find }: { find: ReturnType<typeof useChatFind> }) {
  const t = useT();
  if (!find.open) return null;
  const { query, count, current } = find;
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2.5 py-1.5">
      <div className="flex h-[24px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 focus-within:border-[var(--cf-accent)]">
        <Search size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
        <input
          ref={find.inputRef}
          value={query}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              find.step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              find.close();
            }
          }}
          placeholder={t("chat.findPlaceholder")}
          aria-label={t("chat.findPlaceholder")}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--cf-text-faint)]"
        />
        {query && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
            {count === 0 ? t("chat.findNone") : `${current + 1}/${count >= MAX_MATCHES ? `${MAX_MATCHES}+` : count}`}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => find.step(-1)}
        disabled={count === 0}
        title={t("chat.findPrev")}
        aria-label={t("chat.findPrev")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        onClick={() => find.step(1)}
        disabled={count === 0}
        title={t("chat.findNext")}
        aria-label={t("chat.findNext")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        onClick={find.close}
        title={t("common.close")}
        aria-label={t("common.close")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <X size={13} />
      </button>
    </div>
  );
}
