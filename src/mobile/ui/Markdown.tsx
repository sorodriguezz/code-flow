import { Fragment, useMemo, type ReactNode } from "react";

/**
 * Markdown, as much of it as a note or an agent's answer uses, drawn for a phone.
 *
 * # Why not the desktop's renderer
 *
 * The desktop renders Markdown with `marked`, sanitises the HTML it produces and injects it. That is
 * three things this client should not carry: two libraries on a bundle a phone downloads over
 * somebody's wifi, and `dangerouslySetInnerHTML` on text that arrives from a model. This builds React
 * elements directly from the text, so there is no HTML string at any point and nothing to sanitise —
 * a `<script>` in a note is the eight characters `<script>`.
 *
 * # What it knows
 *
 * Headings, paragraphs, bullet / numbered / task lists (one level of nesting is drawn as indent),
 * quotes, fenced code, rules, and inline code, bold, italic, links and `[[wiki links]]`. Tables are
 * drawn as the monospace text they already are, which on a phone-width column is the only way a
 * table of any size reads at all. Anything else falls through as the text it is — the failure mode
 * of an unknown construct is seeing its source, never losing it.
 */

type Block =
  | { k: "heading"; level: number; text: string }
  | { k: "para"; text: string }
  | { k: "code"; text: string }
  | { k: "quote"; text: string }
  | { k: "rule" }
  | { k: "list"; ordered: boolean; items: { text: string; depth: number; task: boolean | null; n: string }[] };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ k: "para", text: para.join("\n") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      blocks.push({ k: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ k: "heading", level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, "") });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ k: "rule" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      blocks.push({ k: "quote", text: body.join("\n") });
      continue;
    }
    // A table: kept as its own source, in monospace. See the note above.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(lines[i++]);
      i--;
      blocks.push({ k: "code", text: body.join("\n") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items: Extract<Block, { k: "list" }>["items"] = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next) {
          const task = /^\[([ xX])\]\s+/.exec(next[3]);
          items.push({
            text: task ? next[3].slice(task[0].length) : next[3],
            depth: Math.min(3, Math.floor(next[1].replace(/\t/g, "  ").length / 2)),
            task: task ? task[1] !== " " : null,
            n: next[2],
          });
        } else if (lines[i].trim() !== "" && /^\s+/.test(lines[i]) && items.length > 0) {
          // A continuation line of the item above.
          items[items.length - 1].text += ` ${lines[i].trim()}`;
        } else {
          break;
        }
        i++;
      }
      i--;
      blocks.push({ k: "list", ordered, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/**
 * The inline marks, in one pass.
 *
 * One alternation rather than a pass per mark, so a mark inside a code span is never re-read as
 * something else: the code span matches first and its contents are emitted as they are.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[\[[^\]\n]+\]\])|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    if (match[1]) {
      out.push(
        <code key={key++} className="rounded bg-[var(--cf-sunken)] px-1 py-px font-mono text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      out.push(<strong key={key++}>{inline(token.slice(2, -2))}</strong>);
    } else if (match[3]) {
      out.push(<em key={key++}>{inline(token.slice(1, -1))}</em>);
    } else if (match[4]) {
      // A link to another note. Drawn as one, not followed: opening a note by title is the desk's.
      out.push(
        <span key={key++} className="text-[var(--cf-accent-text)]">
          {token.slice(2, -2).split("|").pop()}
        </span>,
      );
    } else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      // Only a web address becomes a link. Anything else — `javascript:`, a file path, a relative
      // link into a repository this phone does not have — is shown as its label.
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={key++} href={href} target="_blank" rel="noreferrer noopener" className="text-[var(--cf-accent-text)] underline">
            {label}
          </a>
        ) : (
          <Fragment key={key++}>{label}</Fragment>
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING = ["text-lg font-semibold", "text-md font-semibold", "text-base font-semibold", "text-base font-semibold"];

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parse(text), [text]);
  return (
    <div className={`cf-selectable space-y-2 break-words text-base leading-relaxed ${className}`}>
      {blocks.map((block, index) => {
        switch (block.k) {
          case "heading":
            return (
              <p key={index} role="heading" aria-level={block.level} className={`pt-1 ${HEADING[Math.min(block.level, 4) - 1]}`}>
                {inline(block.text)}
              </p>
            );
          case "code":
            return (
              <pre key={index} className="cf-scroll-x rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] p-2.5 font-mono text-xs leading-snug">
                {block.text}
              </pre>
            );
          case "quote":
            return (
              <p key={index} className="whitespace-pre-wrap border-l-2 border-[var(--cf-border)] pl-2.5 text-[var(--cf-text-muted)]">
                {inline(block.text)}
              </p>
            );
          case "rule":
            return <hr key={index} className="border-[var(--cf-border)]" />;
          case "list":
            return (
              <ul key={index} className="space-y-1">
                {block.items.map((item, at) => (
                  <li key={at} className="flex gap-2" style={{ paddingLeft: `${item.depth * 1}rem` }}>
                    <span className="w-4 shrink-0 text-right tabular-nums text-[var(--cf-text-muted)]" aria-hidden={item.task === null}>
                      {item.task === null ? (block.ordered ? item.n : "•") : item.task ? "☑" : "☐"}
                    </span>
                    <span className={`min-w-0 flex-1 ${item.task ? "text-[var(--cf-text-muted)] line-through" : ""}`}>{inline(item.text)}</span>
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={index} className="whitespace-pre-wrap">
                {inline(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
