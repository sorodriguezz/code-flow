/**
 * The note a review of an agent's work turns into: comments left on the lines of its diff, written
 * out as the next message of that task's conversation.
 *
 * **Why a module of its own.** The message is the whole feature — a comment that reaches the agent
 * as "line 42" without the file, or with its code fence broken by the code it quotes, is a turn
 * spent on a misunderstanding. That is worth testing without a diff viewer, a store or a repository
 * on disk, so none of it is in here: the input is plain data and the output is a string.
 *
 * **Nothing here is translated.** The headings arrive as `labels`, because the message is read by
 * the agent *and* by the user as their own bubble in the transcript, and both should see the
 * language the app is in.
 */

/** Which side of the diff a comment hangs off: the file as it stands (`new`) or as it was (`old`). */
export type ReviewSide = "new" | "old";

/** One comment, anchored to a line of one file — or to the file itself when `lineno` is `null`. */
export interface ReviewComment {
  id: string;
  /** Repo-relative, POSIX separators, exactly as the diff reported the path. */
  path: string;
  side: ReviewSide;
  /** The line number on `side`, or `null` for a comment about the whole file. */
  lineno: number | null;
  /** The line as the diff drew it, verbatim and including its `+`/`-`/` ` origin. Quoted back so
   *  the agent sees what was pointed at, and so a comment left on a line that has since moved can
   *  still be placed by its content. */
  code: string;
  /** What the user wrote. */
  body: string;
  createdAt: number;
}

export interface ReviewMessageLabels {
  /** The opening line, e.g. «Revisión de los cambios — 3 comentarios.» */
  intro: string;
  /** The heading above the comment that is about the change as a whole. */
  general: string;
}

/** `path:lineno`, or the bare path for a whole-file comment — what a row in the list shows. */
export function anchorOf(comment: Pick<ReviewComment, "path" | "lineno">): string {
  return comment.lineno === null ? comment.path : `${comment.path}:${comment.lineno}`;
}

/**
 * A fence long enough to hold `text`.
 *
 * Diffs of Markdown, of this very file, or of anything carrying a code sample contain ``` — and a
 * three-backtick fence around one closes early, so the rest of the note reads as prose and the
 * comment after it as code. Always at least three, one more than the longest run inside.
 */
export function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((most, run) => Math.max(most, run[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** A comment's text as a blockquote, so a multi-line one stays one quote rather than becoming a
 *  paragraph that reads as the next instruction. */
function quote(body: string): string {
  return body
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Comments in reading order: by file, then down the file, with whole-file comments first. A
 *  reviewer leaves them in the order they notice things; the agent should get them in the order
 *  they appear. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.lineno === b.lineno) return a.createdAt - b.createdAt;
    if (a.lineno === null) return -1;
    if (b.lineno === null) return 1;
    return a.lineno - b.lineno;
  });
}

/**
 * The message the task sends: every comment, under the file and line it was left on, with the code
 * it was left on quoted.
 *
 * Returns `""` when there is nothing to say — no comments and no general note — so the caller has
 * one condition to test rather than two, and an empty review cannot cost a turn.
 */
export function buildReviewMessage(
  comments: readonly ReviewComment[],
  general: string,
  labels: ReviewMessageLabels,
): string {
  const kept = comments.filter((comment) => comment.body.trim() !== "");
  const note = general.trim();
  if (kept.length === 0 && note === "") return "";

  const parts: string[] = [labels.intro];

  for (const comment of sortComments(kept)) {
    const code = comment.code.replace(/\s+$/, "");
    const fence = fenceFor(code);
    parts.push(
      code === ""
        ? `### ${anchorOf(comment)}\n\n${quote(comment.body)}`
        : `### ${anchorOf(comment)}\n\n${fence}\n${code}\n${fence}\n\n${quote(comment.body)}`,
    );
  }

  if (note !== "") parts.push(`### ${labels.general}\n\n${quote(note)}`);

  return parts.join("\n\n");
}

/** How many lines a file's diff adds and removes — the `+n −n` on a row of the file list. */
export function diffStats(hunks: readonly { lines: readonly { origin: string }[] }[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "+") added += 1;
      else if (line.origin === "-") removed += 1;
    }
  }
  return { added, removed };
}
