//! What a service printed, kept by the supervisor rather than by whichever pane happened to be open.
//!
//! The console used to be the only record: a service's output went to the xterm that was mounted
//! for it, and a service nobody was looking at printed into nothing. Select another row and back,
//! and the console came back empty; let it crash while the panel was closed, and the reason it
//! crashed was gone. So the supervisor keeps the bytes itself, across restarts, and a pane replays
//! them when it mounts — see `TerminalPane`'s `backlog`.

/// How much of one service's output is kept. A few thousand lines of a dev server's log: more than
/// the pane's scrollback holds, which is the most anyone can scroll back through anyway.
const LIMIT: usize = 512 * 1024;

/// What a trim cuts back *to*. Same hysteresis as `terminal::Transcript`, for the same reason: a
/// trim to exactly the limit would drain the front of the buffer again on every chunk after it.
const TARGET: usize = LIMIT * 3 / 4;

#[derive(Default)]
pub struct LogBuffer {
    text: String,
}

impl LogBuffer {
    pub fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() <= LIMIT {
            return;
        }
        // Cut at a line boundary found by *byte*, never by slicing the string at `overflow` — that
        // index can land inside a multi-byte character, and slicing there panics. A `\n` is ASCII,
        // so the byte after it is always a character boundary.
        let overflow = self.text.len() - TARGET;
        match self.text.as_bytes()[overflow..].iter().position(|&b| b == b'\n') {
            Some(at) => {
                self.text.drain(..overflow + at + 1);
            }
            // One line longer than the whole allowance — a progress bar redrawing itself forever.
            // Nothing in it is worth a fragment.
            None => self.text.clear(),
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn clear(&mut self) {
        self.text.clear();
    }
}

/// `text` without terminal escape sequences, for matching a readiness line against.
///
/// A dev server colours its banner, and the colour codes sit *between* the words: vite's
/// `ready in 300 ms` arrives as `ready in \x1b[1m300\x1b[22m ms`. A plain substring search for what
/// the user can see on screen would therefore never match the bytes that drew it.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            // Carriage returns redraw a line in place; for matching, what matters is the text.
            if c != '\r' {
                out.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte in `@`..=`~`.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or the two-character string terminator.
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Character-set designations carry one more character (`ESC ( B`).
            Some('(' | ')' | '*' | '+' | '-' | '.' | '/') => {
                chars.next();
            }
            // Everything else is a two-character sequence (`ESC =`, `ESC 7`, …).
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buffer_keeps_what_was_printed() {
        let mut log = LogBuffer::default();
        log.push("one\r\n");
        log.push("two\r\n");
        assert_eq!(log.text(), "one\r\ntwo\r\n");
    }

    /// Past the cap the front goes, at a line boundary — and a multi-byte character straddling the
    /// cut point must not panic the trim.
    #[test]
    fn the_cap_is_enforced_at_a_line_boundary_without_splitting_a_character() {
        let mut log = LogBuffer::default();
        let line = format!("{}\n", "─".repeat(300));
        for _ in 0..2000 {
            log.push(&line);
        }
        assert!(log.text().len() <= LIMIT);
        assert!(log.text().starts_with('─'));
        assert!(log.text().ends_with('\n'));
    }

    #[test]
    fn one_line_longer_than_the_cap_is_dropped_rather_than_kept_forever() {
        let mut log = LogBuffer::default();
        log.push(&"y".repeat(LIMIT * 2));
        assert!(log.text().is_empty());
        log.push("back\n");
        assert_eq!(log.text(), "back\n");
    }

    /// The case the stripper exists for: colour codes between the words of a banner.
    #[test]
    fn colour_codes_between_words_are_removed() {
        let vite = "  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.0\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\r\n";
        assert_eq!(strip_ansi(vite), "  VITE v5.4.0  ready in 312 ms\n");
    }

    #[test]
    fn titles_and_short_sequences_are_removed_too() {
        assert_eq!(strip_ansi("\x1b]0;my title\x07hello\x1b=\x1b]2;x\x1b\\ world"), "hello world");
    }
}
