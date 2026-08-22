//! Turning a caret position into a few tokens of ghost text.
//!
//! # The client never writes a FIM prompt
//!
//! This is the fact the whole module rests on, and it is not what you would guess from the model
//! cards. `/infill` takes `input_prefix` and `input_suffix` as **plain text**; `llama-server`
//! looks up `FIM_PRE`, `FIM_SUF` and `FIM_MID` in the GGUF's own vocabulary and assembles the
//! prompt itself. Verified against llama.cpp b10587 by posting the request below and getting
//! `setCount(count + 1);` back from a 0.5B model that was never told a token string.
//!
//! Two things follow. There is no per-model prompt template here, so adding a model to
//! [`super::catalogue`] is data and not code. And a model whose GGUF lacks those tokens is
//! rejected *by the server* — "Infill is not supported by this model" — rather than quietly
//! producing prose, so a bad catalogue entry fails loudly on the first keystroke.
//!
//! # The numbers
//!
//! Taken from `llama.vscode`'s defaults, which is the reference implementation of this exact
//! feature by the people who wrote the server. Where this differs it says so.
//!
//! # Cancelling actually cancels
//!
//! Also measured rather than assumed. Dropping the HTTP request does stop generation — a task
//! abandoned this way logs `release … stop processing` with **no `print_timing` block**, while one
//! that ran to completion always has one — but the server notices on the order of a second rather
//! than immediately. [`T_MAX_PREDICT_MS`] is what bounds the waste in the meantime, and it is the
//! reason that field exists at all.

use std::time::Duration;

use super::engine::Engine;

/// Hard ceiling on either side of the caret.
///
/// The *line* budget — 256 before, 64 after — is not here, and deliberately: it is applied by
/// `useInlineCompletion` on the frontend, which holds the buffer. Slicing there is what keeps a
/// two-megabyte file from crossing the IPC bridge on every keystroke, and there is nothing this
/// side could add except a second opinion about text that has already been trimmed.
///
/// This is the backstop for the case a line budget cannot express — a minified bundle or a
/// generated file that is one line of two megabytes — and for the general principle that a limit
/// the other side is trusted to apply is not a limit.
const MAX_SIDE_CHARS: usize = 24 * 1024;

/// Tokens the model may produce. `llama.vscode`'s `n_predict`.
const N_PREDICT: u32 = 128;

/// The latency guarantee, in milliseconds of generation.
///
/// Measured exact: with 300 here and `n_predict` 600 the server returned 47 tokens after 310 ms
/// with `stop_type: "limit"`. 500 is `llama.vscode`'s value and leaves room for the ~120 ms of
/// prompt evaluation a real file costs.
const T_MAX_PREDICT_MS: u32 = 500;

/// The same bound on prompt evaluation, for the case where the cache cannot be reused — the user
/// jumped to a different file, or scrolled far enough that `--cache-reuse` finds no overlap.
const T_MAX_PROMPT_MS: u32 = 500;

/// Low, not zero.
///
/// Zero makes the model deterministic, which sounds right for completion and is not: at 0 a small
/// model falls into repeating whatever pattern it just saw, and in code — where the previous three
/// lines are usually near-identical to each other — that produces a fourth near-identical line
/// with confidence. 0.1 is enough to break the loop without inventing.
const TEMPERATURE: f32 = 0.1;

/// The whole-request ceiling, generously above the sum of the two server-side bounds.
///
/// If this fires, something is wrong with the process rather than with the request, and the engine
/// will be restarted on the next keystroke.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What the editor asks for. Sliced on the frontend rather than here — see [`Request::clamp`].
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Request {
    /// Everything before the caret that is being sent, already trimmed to the line budget.
    pub prefix: String,
    /// Everything after it, likewise.
    pub suffix: String,
}

impl Request {
    /// Enforces [`MAX_SIDE_CHARS`] from this side of the bridge.
    ///
    /// The frontend already applies the line budget, because it holds the buffer and slicing there
    /// keeps a two-megabyte file from crossing the IPC boundary on every keystroke. This is the
    /// backstop for the case the line budget cannot express — one enormous line — and for the
    /// general principle that a limit the other side is trusted to apply is not a limit.
    ///
    /// The prefix keeps its **tail** and the suffix keeps its **head**: the caret is the
    /// interesting end of both, and truncating from the wrong side would throw away precisely the
    /// context that matters.
    fn clamp(&self) -> (&str, &str) {
        let prefix = tail_chars(&self.prefix, MAX_SIDE_CHARS);
        let suffix = head_chars(&self.suffix, MAX_SIDE_CHARS);
        (prefix, suffix)
    }
}

/// The last `max` characters of `text`, on a character boundary.
fn tail_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The first `max` characters of `text`, on a character boundary.
fn head_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The `/infill` body. Serialized straight to JSON; field names are the server's.
#[derive(serde::Serialize)]
struct Infill<'a> {
    input_prefix: &'a str,
    input_suffix: &'a str,
    n_predict: u32,
    temperature: f32,
    top_k: u32,
    top_p: f32,
    /// Non-streaming. A completion is 128 tokens at most and arrives in well under a second; the
    /// editor has nothing to do with a half-finished suggestion but re-render it, and ghost text
    /// that grows word by word is a distraction rather than a progress indicator.
    stream: bool,
    /// The other half of `--cache-reuse`. Without it the server keeps no KV cache between
    /// requests and every keystroke re-evaluates the whole prefix.
    cache_prompt: bool,
    t_max_prompt_ms: u32,
    t_max_predict_ms: u32,
    /// Named explicitly so the sampler chain is the three that matter and not the server's
    /// default nine — `penalties`, `dry` and `xtc` are shaped for prose and actively harm code,
    /// where repeating a token you have just seen is usually correct.
    samplers: [&'static str; 3],
    stop: &'a [&'a str],
}

/// Sequences that end a completion.
///
/// Mostly belt and braces: the model emits EOS on its own at the end of the middle span — that is
/// what FIM training is for, and the measured 0.5B request stopped with `stop_type: "eos"` after
/// eight tokens. These catch the case where it does not and starts emitting the *next* file
/// instead, which is the characteristic failure of a base model that has run past its span.
const STOP: &[&str] = &[
    "<|endoftext|>",
    "<|fim_prefix|>",
    "<|fim_middle|>",
    "<|fim_suffix|>",
    "<|file_sep|>",
    "<|repo_name|>",
];

/// What the server answers. Only the fields that are read.
#[derive(serde::Deserialize)]
struct InfillResponse {
    #[serde(default)]
    content: String,
}

/// What the server answers when it refuses.
#[derive(serde::Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    #[serde(default)]
    message: String,
}

/// Asks `engine` to fill the gap between prefix and suffix.
///
/// `cancel` is the receiver half of this app's standard cancellation channel — the same shape
/// `crate::api::ApiRegistry::register_cancel` hands out, and the same `tokio::select!` that
/// `api::http` uses to consume it. Firing it drops the HTTP request, which is a real cancellation
/// on the server side as well as this one.
pub async fn infill(
    engine: &Engine,
    request: &Request,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<String, String> {
    engine.touch();
    let (prefix, suffix) = request.clamp();

    let body = Infill {
        input_prefix: prefix,
        input_suffix: suffix,
        n_predict: N_PREDICT,
        temperature: TEMPERATURE,
        top_k: 40,
        top_p: 0.95,
        stream: false,
        cache_prompt: true,
        t_max_prompt_ms: T_MAX_PROMPT_MS,
        t_max_predict_ms: T_MAX_PREDICT_MS,
        samplers: ["top_k", "top_p", "temperature"],
        stop: STOP,
    };

    let send = engine
        .client()
        .post(format!("{}/infill", engine.base_url()))
        .timeout(REQUEST_TIMEOUT)
        .json(&body)
        .send();

    let response = tokio::select! {
        // Biased, so a cancel that lands in the same tick as the response wins. The editor has
        // already moved on by then and rendering the answer would flash ghost text for one frame
        // at a caret position that no longer exists.
        biased;
        // Returning here drops `send`, and dropping the request is what closes the connection —
        // which is what tells the server to abandon the generation. See the module comment: that
        // was measured, not assumed. `super::cancelled` is what keeps a *dropped* sender from
        // being mistaken for a fired one.
        () = super::cancelled(cancel) => return Err(CANCELLED.to_string()),
        sent = send => sent,
    };

    let response = response.map_err(|e| {
        if e.is_timeout() {
            "The local completion engine didn't answer in time.".to_string()
        } else {
            format!("The local completion engine didn't answer: {e}")
        }
    })?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Couldn't read the completion response: {e}"))?;

    if !status.is_success() {
        // The server's own message is far better than anything that could be written here — most
        // usefully "Infill is not supported by this model", which names the one way a catalogue
        // entry can be wrong.
        let detail = serde_json::from_str::<ErrorEnvelope>(&text)
            .map(|envelope| envelope.error.message)
            .unwrap_or_else(|_| text.chars().take(200).collect());
        return Err(format!("Completion failed ({status}): {detail}"));
    }

    let parsed: InfillResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Couldn't parse the completion response: {e}"))?;

    Ok(tidy(&parsed.content, suffix))
}

/// The marker a cancelled request returns, so the command layer can drop it silently instead of
/// turning a keystroke into an error toast.
pub const CANCELLED: &str = "__codeflow_completion_cancelled__";

/// Cleans up a raw completion into something that can be inserted.
///
/// Three problems, all of them things a base model does routinely:
///
/// 1. **A stop token that leaked.** `stop` sequences are matched by the server and removed, but a
///    partial one at the very end of the budget is not.
/// 2. **Trailing blank lines.** The model finishes the block and then starts a new one; the ghost
///    text should end where the code does.
/// 3. **Re-writing the suffix.** The most visible failure of all: the model completes the gap and
///    then continues with lines the user already has below the caret, so accepting duplicates
///    them. Caught by trimming the longest tail of the completion that the suffix already begins
///    with.
fn tidy(raw: &str, suffix: &str) -> String {
    let mut text = raw.to_string();

    for marker in STOP {
        if let Some(at) = text.find(marker) {
            text.truncate(at);
        }
    }

    text = text.trim_end_matches(['\n', '\r', ' ', '\t']).to_string();

    // The overlap check works on the trimmed forms so that indentation differences do not hide it.
    let head = suffix.trim_start();
    if !head.is_empty() {
        // Walk back from the whole completion: the longest suffix of `text` that `head` starts
        // with is the duplicated part. Bounded by the completion's own length, which is at most
        // `N_PREDICT` tokens, so this is cheap.
        let bytes = text.as_bytes();
        let mut cut = None;
        for start in 0..bytes.len() {
            if !text.is_char_boundary(start) {
                continue;
            }
            let tail = text[start..].trim();
            // Two lines is the threshold. A single duplicated token — a closing brace, a
            // semicolon — is usually correct rather than a repeat, and trimming those would eat
            // the end of every legitimate block completion.
            if tail.len() > 3 && head.starts_with(tail) {
                cut = Some(start);
                break;
            }
        }
        if let Some(at) = cut {
            text.truncate(at);
        }
    }

    text.trim_end_matches(['\n', '\r', ' ', '\t']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_keeps_the_end_of_the_prefix_and_the_start_of_the_suffix() {
        let request = Request {
            prefix: "a".repeat(MAX_SIDE_CHARS) + "TAIL",
            suffix: "HEAD".to_string() + &"b".repeat(MAX_SIDE_CHARS),
        };
        let (prefix, suffix) = request.clamp();
        assert!(prefix.ends_with("TAIL"), "the prefix must keep the text nearest the caret");
        assert!(suffix.starts_with("HEAD"), "the suffix must keep the text nearest the caret");
        assert!(prefix.len() <= MAX_SIDE_CHARS);
        assert!(suffix.len() <= MAX_SIDE_CHARS);
    }

    /// Truncating a UTF-8 string by byte offset is how you get a panic in production from a file
    /// with an accented identifier or an emoji in a comment.
    #[test]
    fn clamp_never_splits_a_character() {
        let request = Request {
            // "é" is two bytes, so a naive cut at MAX_SIDE_CHARS lands mid-character for one of
            // the two offsets this produces.
            prefix: "é".repeat(MAX_SIDE_CHARS),
            suffix: "ñ".repeat(MAX_SIDE_CHARS),
        };
        let (prefix, suffix) = request.clamp();
        assert!(prefix.chars().all(|c| c == 'é'));
        assert!(suffix.chars().all(|c| c == 'ñ'));
    }

    #[test]
    fn short_sides_are_untouched() {
        let request = Request { prefix: "let x = ".into(), suffix: ";\n".into() };
        assert_eq!(request.clamp(), ("let x = ", ";\n"));
    }

    #[test]
    fn tidy_strips_a_leaked_stop_token() {
        assert_eq!(tidy("doThing();<|endoftext|>", ""), "doThing();");
        assert_eq!(tidy("a();<|file_sep|>b();", ""), "a();");
    }

    #[test]
    fn tidy_drops_trailing_blank_lines() {
        assert_eq!(tidy("doThing();\n\n\n", ""), "doThing();");
    }

    /// The duplicated-suffix case: the model completes the gap and then rewrites what is already
    /// below the caret, so accepting the suggestion would produce the closing lines twice.
    #[test]
    fn tidy_removes_text_the_suffix_already_has() {
        let suffix = "\n  return total;\n}\n";
        let raw = "total += item.price;\n  return total;\n}";
        assert_eq!(tidy(raw, suffix), "total += item.price;");
    }

    /// The other side of that threshold. A closing brace at the end of a completion is normal
    /// output, not a repeat, and trimming it would break every block completion.
    #[test]
    fn tidy_keeps_a_short_incidental_overlap() {
        assert_eq!(tidy("if (a) {\n  b();\n}", "\n}\n"), "if (a) {\n  b();\n}");
    }

    #[test]
    fn tidy_leaves_ordinary_completions_alone() {
        assert_eq!(tidy("setCount(count + 1);", "\n  };\n"), "setCount(count + 1);");
    }

    /// The request body is a contract with a process this repo does not build. If a field name
    /// drifts, llama-server ignores it silently and the completion quietly loses its latency
    /// bound — which is exactly the kind of regression nobody notices until it is shipped.
    #[test]
    fn the_request_body_uses_the_server_field_names() {
        let body = Infill {
            input_prefix: "p",
            input_suffix: "s",
            n_predict: N_PREDICT,
            temperature: TEMPERATURE,
            top_k: 40,
            top_p: 0.95,
            stream: false,
            cache_prompt: true,
            t_max_prompt_ms: T_MAX_PROMPT_MS,
            t_max_predict_ms: T_MAX_PREDICT_MS,
            samplers: ["top_k", "top_p", "temperature"],
            stop: STOP,
        };
        let json = serde_json::to_value(&body).expect("serializes");
        for field in [
            "input_prefix",
            "input_suffix",
            "n_predict",
            "temperature",
            "stream",
            "cache_prompt",
            "t_max_prompt_ms",
            "t_max_predict_ms",
            "samplers",
            "stop",
        ] {
            assert!(json.get(field).is_some(), "missing `{field}` from the /infill body");
        }
        assert_eq!(json["input_prefix"], "p");
        assert_eq!(json["stream"], false);
        assert_eq!(json["cache_prompt"], true);
    }
}

/// The whole path, against the real engine and a real model.
///
/// Everything above this point tests text handling; none of it would notice if `/infill` stopped
/// accepting the body, if llama.cpp renamed a launch flag, or if a new build stopped deriving FIM
/// tokens from the GGUF. Those are the failures that matter and the only honest way to check them
/// is to run the thing — the same argument `debugger::live_tests` makes for spawning a real Node
/// inspector rather than mocking one.
///
/// **Skipped rather than failed when the pieces are absent.** CI has neither the engine (it is a
/// build output) nor a model (gigabytes, downloaded by the user), and a suite that goes red there
/// is a suite people learn to ignore. On a developer machine that has run `pnpm llama:runtime` and
/// downloaded a model, it runs.
///
/// One test and not four, deliberately: the engine is a process behind a global, so two tests
/// touching it in parallel would fight over who owns it.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::localai::{catalogue, engine, models};

    #[tokio::test]
    async fn a_real_model_completes_and_cancels() {
        // Taken before anything else: this test drives the real engine and therefore writes the
        // process-wide status and pidfile that `engine`'s own unit tests assert on. See
        // `engine::test_guard`.
        let _guard = engine::test_guard();
        if !engine::is_available() {
            eprintln!("localai live: no engine — run `pnpm llama:runtime`. Skipping.");
            return;
        }
        // The smallest catalogue entry, so a developer who wants this to run pays 531 MB and not
        // eight gigabytes.
        let spec = catalogue::find("qwen2.5-coder-0.5b").expect("catalogue entry");
        if !models::is_installed(spec) {
            eprintln!("localai live: {} is not downloaded. Skipping.", spec.id);
            return;
        }

        let started = std::time::Instant::now();
        let engine = engine::ensure(spec, models::path_of(spec))
            .await
            .expect("the engine should start")
            .expect("the first call owns the start, so it must not answer `not yet`");
        eprintln!("localai live: ready in {} ms", started.elapsed().as_millis());

        // A completion whose answer the surrounding code fully determines. Asserting on an exact
        // string would be asserting on the model's weights, which change with every catalogue
        // bump; asserting that it closes the call it was obviously in the middle of is the
        // strongest claim that is actually about *this* code.
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let request = Request {
            prefix: "const total = items.reduce((sum, item) => sum + item.price, 0);\nconsole.log("
                .to_string(),
            suffix: ");\n".to_string(),
        };
        let answered = std::time::Instant::now();
        let text = infill(&engine, &request, rx).await.expect("infill should answer");
        eprintln!("localai live: {} ms → {text:?}", answered.elapsed().as_millis());

        assert!(!text.trim().is_empty(), "the model returned nothing at all");
        assert!(
            !text.contains("<|fim_"),
            "a FIM token reached the caller, so `tidy` is not stripping what the server leaks: \
             {text:?}",
        );
        assert!(
            !text.contains("```"),
            "the completion contains a markdown fence, which means the catalogue is pointing at \
             an instruction-tuned model rather than a base one: {text:?}",
        );

        // Cancellation, fired before the request is even issued. The `biased` select must take the
        // cancel arm and never reach the network.
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(()).expect("receiver is alive");
        let cancelled = infill(&engine, &request, rx).await;
        assert_eq!(
            cancelled.unwrap_err(),
            CANCELLED,
            "a pre-fired cancel must short-circuit rather than complete",
        );

        // And the engine must actually go away, because a test that leaves a gigabyte of
        // llama-server behind is a test that makes the next one flaky.
        engine::shutdown().await;
        assert_eq!(engine::status(), engine::Status::Off);
    }
}
