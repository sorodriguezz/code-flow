import { useMemo, useState } from "react";
import { t } from "../i18n";
import type { DiffLine, FileDiffInfo } from "../../types/domain";

/**
 * Diff rendering, on a phone. Presentational only — nothing here fetches.
 *
 * It lives apart from `DiffSheet` because three screens now draw a diff and they get theirs from
 * three different places: one file from `get_file_diff`, a whole changeset from `get_commit_diff`,
 * and the pull request's raw unified text off a saved review run. One renderer for all three is
 * what keeps a `+` line the same colour in each of them.
 *
 * # Unified, never split
 *
 * The desktop offers a side-by-side mode and this deliberately does not. Two columns of code in a
 * 390-point-wide viewport is roughly nineteen characters each — narrow enough that every real line
 * wraps, which destroys the alignment that was the entire reason to put them side by side. A
 * unified diff with a colour and a sign per line reads correctly at any width.
 */

/**
 * How many lines are drawn before the rest goes behind a button.
 *
 * There was no cap at all, and each line is its own `<div>` with three spans: a 4,000-line file
 * meant 16,000 DOM nodes laid out in one pass on a phone, which is a visible freeze on the way in
 * and a scroll that stutters afterwards. The number is a screenful times a generous margin — enough
 * that the overwhelming majority of diffs never see the button, and small enough that the ones that
 * do stay interactive. Deliberately *not* a windowing library: this list only ever grows downward
 * and never needs to measure, so a slice and a button buy the same thing for none of the weight.
 */
const CHUNK = 400;

export function lineTone(origin: string): string {
  // libgit2's origin characters. `+`/`-` are the content changes; `>`/`<` are "no newline at end of
  // file" markers, which are noise here and are drawn as ordinary context.
  if (origin === "+") return "bg-[var(--cf-success)]/12 text-[var(--cf-success)]";
  if (origin === "-") return "bg-[var(--cf-danger)]/12 text-[var(--cf-danger)]";
  return "text-[var(--cf-text-muted)]";
}

export function Line({ line }: { line: DiffLine }) {
  const sign = line.origin === "+" || line.origin === "-" ? line.origin : " ";
  return (
    <div className={`cf-log flex gap-2 px-2 ${lineTone(line.origin)}`}>
      {/* One gutter, not two. The desktop shows old and new line numbers; at this width that is
          eight characters of chrome before any code, so only the line's own side is shown. */}
      <span className="w-9 shrink-0 select-none text-right opacity-50">
        {line.new_lineno ?? line.old_lineno ?? ""}
      </span>
      <span className="w-2 shrink-0 select-none">{sign}</span>
      <span className="min-w-0 flex-1">{line.content.replace(/\n$/, "")}</span>
    </div>
  );
}

/** The "show the rest" row. Counts what is still hidden, because "ver más" alone does not say
 *  whether one more tap finishes the file or whether there are nine thousand lines left. */
function MoreRow({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  return (
    <button
      type="button"
      onClick={onMore}
      className="cf-tap mt-1 w-full rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[12px] text-[var(--cf-text-muted)]"
    >
      {t("diff.more", { n: hidden })}
    </button>
  );
}

/** A hunk header, or one of its lines — the flat list the cap is applied to. */
type Row = { kind: "header"; text: string } | { kind: "line"; line: DiffLine };

function rowsOf(diff: FileDiffInfo): Row[] {
  const rows: Row[] = [];
  for (const hunk of diff.hunks) {
    rows.push({ kind: "header", text: hunk.header.replace(/\n$/, "") });
    for (const line of hunk.lines) rows.push({ kind: "line", line });
  }
  return rows;
}

/**
 * One file's diff: its hunks, capped.
 *
 * The empty cases are three different sentences and are kept that way. No hunks *and* the binary
 * flag is a binary file, which is a fact about the file. No hunks without it is "there is no text
 * to show" — true, and as much as is known. Neither is an error, and neither is "nothing here".
 */
export function FileDiff({ diff }: { diff: FileDiffInfo }) {
  const rows = useMemo(() => rowsOf(diff), [diff]);
  const [visible, setVisible] = useState(CHUNK);

  if (diff.hunks.length === 0) {
    return (
      <p className="mt-6 text-center text-[13px] text-[var(--cf-text-muted)]">
        {diff.binary ? t("diff.binary") : t("diff.noText")}
      </p>
    );
  }

  const shown = rows.slice(0, visible);
  return (
    <div>
      {shown.map((row, index) =>
        row.kind === "header" ? (
          <p
            key={index}
            className="cf-log mt-2 bg-[var(--cf-surface)] px-2 py-1 text-[var(--cf-text-muted)]"
          >
            {row.text}
          </p>
        ) : (
          <Line key={index} line={row.line} />
        ),
      )}
      {rows.length > visible && (
        <MoreRow hidden={rows.length - visible} onMore={() => setVisible((n) => n + CHUNK)} />
      )}
    </div>
  );
}

/** Which colour a line of raw unified-diff text gets, from the character git puts in front of it. */
function textTone(line: string): string {
  // `+++`/`---` are the file headers, not added and removed lines, so they are checked first —
  // colouring them green and red would paint every file boundary as a change to itself.
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-[var(--cf-text-muted)] opacity-70";
  }
  if (line.startsWith("@@")) return "bg-[var(--cf-surface)] text-[var(--cf-text-muted)]";
  if (line.startsWith("+")) return "bg-[var(--cf-success)]/12 text-[var(--cf-success)]";
  if (line.startsWith("-")) return "bg-[var(--cf-danger)]/12 text-[var(--cf-danger)]";
  return "text-[var(--cf-text-muted)]";
}

/**
 * A raw unified diff, as a string.
 *
 * For the pull request's own diff, which is stored on the review run as the text the engine was
 * given — there is no parsed structure to render, and re-parsing it here to build one would be a
 * second, weaker copy of what libgit2 already does everywhere else in this client.
 */
export function UnifiedDiffText({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [visible, setVisible] = useState(CHUNK);

  return (
    <div>
      {lines.slice(0, visible).map((line, index) => (
        <div key={index} className={`cf-log whitespace-pre-wrap break-words px-2 ${textTone(line)}`}>
          {line || " "}
        </div>
      ))}
      {lines.length > visible && (
        <MoreRow hidden={lines.length - visible} onMore={() => setVisible((n) => n + CHUNK)} />
      )}
    </div>
  );
}
