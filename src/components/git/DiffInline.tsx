import { useMemo } from "react";
import type { DiffLine } from "../../types/domain";
import { inlineSpans, pairHunkLines, worthHighlighting } from "../../lib/diffText";

/**
 * A line's text, with the part that actually changed picked out.
 *
 * The diff has always been line-level: a line where one character moved was painted end to end and
 * finding the change was the reader's job. This pairs each removed line with its added counterpart
 * inside the hunk and marks the differing run — see `inlineSpans`, and `worthHighlighting` for why
 * two lines that merely sit next to each other are left alone.
 *
 * The pairing is memoised per hunk rather than per line: it is one pass over the origins, and doing
 * it inside each of a thousand rows would make it a thousand passes.
 */
export function InlineContent({ line, lines, index }: { line: DiffLine; lines: DiffLine[]; index: number }) {
  const pairs = useMemo(() => pairHunkLines(lines.map((entry) => entry.origin)), [lines]);

  const partnerIndex = pairs.get(index);
  const partner = partnerIndex === undefined ? null : lines[partnerIndex];
  if (!partner || !worthHighlighting(line.content, partner.content)) return <>{line.content}</>;

  const spans =
    line.origin === "-"
      ? inlineSpans(line.content, partner.content).before
      : inlineSpans(partner.content, line.content).after;

  return (
    <>
      {spans.map((span, i) =>
        span.changed ? (
          // A stronger tint of the row's own colour rather than a new hue: the row already says
          // added or removed, and this says *where* — a second colour would be a second claim.
          <span
            key={i}
            className={
              line.origin === "+"
                ? "rounded-[2px] bg-[color-mix(in_oklab,var(--cf-success)_26%,transparent)]"
                : "rounded-[2px] bg-[color-mix(in_oklab,var(--cf-danger)_24%,transparent)]"
            }
          >
            {span.text}
          </span>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  );
}
