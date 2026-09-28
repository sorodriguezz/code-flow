//! Response bodies that arrive over time — server-sent events, and chunked bodies the user asked
//! to watch — delivered to the UI piece by piece instead of all at once at the end.
//!
//! A `text/event-stream` response may never end, so reading it whole meant showing nothing until
//! the 30-second request timeout killed it and took everything already received with it. What
//! arrives is now emitted as it arrives (`api:http-stream`), the body read is bounded by idleness
//! rather than by a total deadline, and whatever was read when the user presses Stop is kept.

use std::sync::Arc;

use serde::Serialize;

pub const EVENT_HTTP_STREAM: &str = "api:http-stream";

/// One piece of a streamed response, as the UI receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HttpStreamEvent {
    /// The head arrived; the body follows as chunks (and, for event streams, events).
    Open {
        status: u16,
        status_text: String,
        http_version: String,
        headers: Vec<(String, String)>,
        sse: bool,
        at: i64,
    },
    /// Body text, decoded as UTF-8 across read boundaries. `size` is the bytes it came from.
    Chunk { text: String, size: u64, at: i64 },
    /// One server-sent event, parsed.
    Event { event: String, data: String, last_event_id: String, at: i64 },
}

/// What is actually emitted: the event, and the send it belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct HttpStreamMessage {
    pub id: String,
    #[serde(flatten)]
    pub event: HttpStreamEvent,
}

/// Where a streamed response's pieces go. A closure rather than an `AppHandle`, so the transport
/// can be exercised without a Tauri runtime.
pub type StreamSink = Arc<dyn Fn(HttpStreamEvent) + Send + Sync>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn is_event_stream(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
}

/// UTF-8 across reads: a character split between two network reads is held back until its second
/// half arrives, rather than decoding as two replacement characters.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&self.pending[..valid]));
                    match error.error_len() {
                        // An incomplete sequence at the end: wait for the rest of it.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }
}

/// One dispatched server-sent event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub last_event_id: String,
}

/// The `text/event-stream` interpretation of the HTML Living Standard (§9.2.6), fed text as it
/// arrives: lines end in CR, LF or CRLF (even when the pair straddles two reads), `:` starts a
/// comment, `data` lines accumulate, and a blank line dispatches. An event still open when the
/// stream ends is discarded, as the standard says.
#[derive(Default)]
pub struct SseParser {
    line: String,
    after_cr: bool,
    started: bool,
    event: String,
    data: String,
    has_data: bool,
    last_event_id: String,
}

impl SseParser {
    pub fn push(&mut self, text: &str) -> Vec<SseEvent> {
        let mut out = Vec::new();
        let mut text = text;
        if !self.started && !text.is_empty() {
            self.started = true;
            text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
        }
        for ch in text.chars() {
            if self.after_cr {
                self.after_cr = false;
                if ch == '\n' {
                    continue;
                }
            }
            match ch {
                '\r' => {
                    self.after_cr = true;
                    self.end_line(&mut out);
                }
                '\n' => self.end_line(&mut out),
                other => self.line.push(other),
            }
        }
        out
    }

    fn end_line(&mut self, out: &mut Vec<SseEvent>) {
        let line = std::mem::take(&mut self.line);
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field.to_string(), value.strip_prefix(' ').unwrap_or(value).to_string()),
            None => (line, String::new()),
        };
        match field.as_str() {
            "event" => self.event = value,
            "data" => {
                self.data.push_str(&value);
                self.data.push('\n');
                self.has_data = true;
            }
            "id" if !value.contains('\0') => self.last_event_id = value,
            // `retry`, and fields the standard doesn't define, change nothing here.
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseEvent>) {
        let event = std::mem::take(&mut self.event);
        if !self.has_data {
            return;
        }
        self.has_data = false;
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
            data.pop();
        }
        out.push(SseEvent {
            event: if event.is_empty() { "message".to_string() } else { event },
            data,
            last_event_id: self.last_event_id.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_reads_is_decoded_whole() {
        let mut stream = Utf8Stream::default();
        let bytes = "ñandú".as_bytes();
        let first = stream.push(&bytes[..2]);
        let second = stream.push(&bytes[2..5]);
        let third = stream.push(&bytes[5..]);
        assert_eq!(format!("{first}{second}{third}"), "ñandú");
        // A byte that can never be UTF-8 becomes one replacement character, and decoding goes on.
        assert_eq!(Utf8Stream::default().push(b"a\xffb"), "a\u{FFFD}b");
    }

    #[test]
    fn events_are_dispatched_on_the_blank_line() {
        let mut parser = SseParser::default();
        let events = parser.push(
            ": a comment\n\
             data: first\n\n\
             event: update\n\
             id: 42\n\
             data: {\"a\":1}\n\
             data: second line\n\n\
             retry: 3000\n\
             data\n\n",
        );
        assert_eq!(
            events,
            vec![
                SseEvent { event: "message".into(), data: "first".into(), last_event_id: "".into() },
                SseEvent {
                    event: "update".into(),
                    data: "{\"a\":1}\nsecond line".into(),
                    last_event_id: "42".into(),
                },
                SseEvent { event: "message".into(), data: "".into(), last_event_id: "42".into() },
            ]
        );
    }

    #[test]
    fn lines_and_events_may_straddle_reads_and_crlf_counts_once() {
        let mut parser = SseParser::default();
        assert!(parser.push("\u{FEFF}data: hel").is_empty());
        assert!(parser.push("lo\r").is_empty());
        // The LF completing the CRLF arrives in the next read and must not end a second line.
        let events = parser.push("\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello");
        // An event never closed by a blank line is not dispatched.
        assert!(parser.push("data: unfinished\n").is_empty());
    }

    #[test]
    fn only_text_event_stream_is_an_event_stream() {
        assert!(is_event_stream("text/event-stream"));
        assert!(is_event_stream("Text/Event-Stream; charset=utf-8"));
        assert!(!is_event_stream("text/plain"));
        assert!(!is_event_stream(""));
    }
}
