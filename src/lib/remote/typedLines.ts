/**
 * Reconstructing the commands a user typed, from the bytes going *into* a pty.
 *
 * **What this is and isn't.** It watches keystrokes, not the shell. It cannot know what the shell
 * actually ran — tab completion happens on the far side, history recall replays a line this never
 * saw, and a heredoc or a `for` loop spans several submissions. So this is "what you typed", and the
 * UI says so. The honest alternative — reading the remote shell's own history file — needs a second
 * SSH round trip per host, only works for shells that write one, and only sees commands after the
 * shell has exited.
 *
 * What it *is* good at is the case that matters: you typed a command, it worked, and you want it as
 * a snippet without retyping it.
 *
 * The rules are deliberately conservative — anything ambiguous drops the buffer rather than
 * recording a mangled line, because a history full of half-commands is worse than a short one.
 */

/** Bytes that mean "this line is no longer something I can reconstruct". */
const CANCEL = new Set([
  "", // Ctrl-C
  "", // Ctrl-D
  "", // Ctrl-U, clears the line
  "", // Ctrl-Z
  "\t", // tab completion is resolved on the far side, so the buffer no longer matches the line
]);

/**
 * Accumulates keystrokes for one session and emits whole lines.
 *
 * One per session, because each has its own line being typed.
 */
export class TypedLineBuffer {
  private buffer = "";

  /**
   * Feeds one chunk of pty input. Returns the completed line, if this chunk finished one.
   *
   * A chunk is usually a single character, but a paste arrives whole — which is why this handles
   * embedded newlines rather than assuming `data.length === 1`.
   */
  push(data: string): string | null {
    let completed: string | null = null;

    for (const ch of data) {
      // Enter. A pty gets `\r`; `\n` shows up from some paste paths, so both end the line.
      if (ch === "\r" || ch === "\n") {
        const line = this.buffer.trim();
        this.buffer = "";
        if (isWorthKeeping(line)) completed = line;
        continue;
      }
      if (ch === "" || ch === "\b") {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }
      if (CANCEL.has(ch)) {
        this.buffer = "";
        continue;
      }
      // An escape sequence — arrow keys, history recall, a mouse report. Whatever the line becomes
      // after it, this no longer knows, so the buffer is abandoned rather than guessed at.
      if (ch === "") {
        this.buffer = "";
        continue;
      }
      // Any other control byte: not typing, and not something to record.
      if (ch < " ") continue;
      this.buffer += ch;
    }

    return completed;
  }
}

/**
 * Whether a reconstructed line is worth putting in a history list.
 *
 * The floor is low on purpose — `ls` is a legitimate thing to keep — but a bare `y`, a password
 * typed at a prompt that didn't echo, or a single stray character are not commands, and a list full
 * of them is a list nobody opens.
 */
function isWorthKeeping(line: string): boolean {
  if (line.length < 2) return false;
  // A line with no letters at all is punctuation, a paste artefact, or a response to a prompt.
  if (!/[a-z]/i.test(line)) return false;
  return true;
}

/**
 * Whether a line looks like it might be a secret, and so should never be recorded.
 *
 * Crude by necessity — this only sees the text, not the prompt that asked for it — but it catches
 * the shapes that actually appear: an export of a token, a `--password` flag, a `curl -u`. A false
 * positive costs one un-saved history entry; a false negative writes a credential into a list the
 * user will later hand around as a snippet.
 */
export function looksSecret(line: string): boolean {
  return /(?:password|passwd|secret|token|api[_-]?key|credential|bearer)\s*[=:]|--password|-u\s+\S+:\S/i.test(
    line,
  );
}
