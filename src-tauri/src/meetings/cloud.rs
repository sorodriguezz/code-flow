//! Whisper in the cloud: any OpenAI-compatible `/audio/transcriptions` — OpenAI's own, Groq's, or a
//! server the user runs (faster-whisper behind an OpenAI-shaped API on another machine).
//!
//! Pieces go up as 16 kHz mono WAV, the shape the local engine reads, cut where the voice detector
//! found speech — so the cloud and the local path line up on the same timeline and the same speaker
//! separation applies to both. `verbose_json` with word timestamps is asked for; a server that
//! will not give it (some models answer only `json`) is asked again for plain text, and the piece's
//! own span stands in for word times.

use std::time::Duration;

use serde::Deserialize;

use super::transcript::Word;
use super::CloudSettings;

/// The presets Settings offers. The URL is the API base, up to and including its version.
pub const OPENAI_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Deserialize)]
struct Verbose {
    #[serde(default)]
    text: String,
    #[serde(default)]
    words: Vec<VerboseWord>,
    #[serde(default)]
    segments: Vec<VerboseSegment>,
}

#[derive(Debug, Deserialize)]
struct VerboseWord {
    word: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
struct VerboseSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    no_speech_prob: f32,
}

fn endpoint(settings: &CloudSettings) -> String {
    let base = if settings.url.trim().is_empty() { OPENAI_URL } else { settings.url.trim() };
    format!("{}/audio/transcriptions", base.trim_end_matches('/'))
}

fn model(settings: &CloudSettings) -> &str {
    if settings.model.trim().is_empty() {
        "whisper-1"
    } else {
        settings.model.trim()
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())
}

async fn send(settings: &CloudSettings, key: &str, wav: Vec<u8>, language: &str, prompt: &str, verbose: bool) -> Result<reqwest::Response, String> {
    let part = reqwest::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new().part("file", part).text("model", model(settings).to_string());
    if verbose {
        form = form
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "word")
            .text("timestamp_granularities[]", "segment");
    } else {
        form = form.text("response_format", "json");
    }
    let language = language.trim();
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    if !prompt.trim().is_empty() {
        form = form.text("prompt", prompt.chars().take(800).collect::<String>());
    }
    let mut request = client()?.post(endpoint(settings)).multipart(form);
    if !key.trim().is_empty() {
        request = request.bearer_auth(key.trim());
    }
    request.send().await.map_err(|e| format!("The transcription service did not answer: {e}"))
}

/// Words of one piece (16 kHz mono samples), on the piece's own timeline. `Err` carries the
/// service's own message.
pub async fn transcribe(settings: &CloudSettings, key: &str, samples: &[f32], language: &str, prompt: &str) -> Result<Vec<Word>, String> {
    let duration_ms = super::audio::samples_to_ms(samples.len());
    let wav = super::audio::wav_bytes(samples);
    let response = send(settings, key, wav.clone(), language, prompt, true).await?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        let verbose: Verbose = serde_json::from_str(&body).map_err(|e| format!("The transcription service answered something unexpected: {e}"))?;
        return Ok(words_of(verbose, duration_ms));
    }
    // A model that cannot do `verbose_json` says so with a 400: ask again for plain text.
    if status.as_u16() == 400 && (body.contains("response_format") || body.contains("timestamp")) {
        let retry = send(settings, key, wav, language, prompt, false).await?;
        let status = retry.status();
        let body = retry.text().await.unwrap_or_default();
        if status.is_success() {
            let plain: Verbose = serde_json::from_str(&body).map_err(|e| format!("The transcription service answered something unexpected: {e}"))?;
            return Ok(spread(&plain.text, 0, duration_ms));
        }
        return Err(service_error(status.as_u16(), &body));
    }
    Err(service_error(status.as_u16(), &body))
}

fn service_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 | 403 => format!("The transcription service refused the key ({status}): {message}"),
        429 => format!("The transcription service is rate-limiting ({status}): {message}"),
        _ => format!("The transcription service failed ({status}): {message}"),
    }
}

/// Words from a verbose answer: its words when it gave them, else its segments' text spread over
/// each segment, else the whole text over the piece.
fn words_of(verbose: Verbose, duration_ms: i64) -> Vec<Word> {
    if !verbose.words.is_empty() {
        return verbose
            .words
            .into_iter()
            .filter(|w| !w.word.trim().is_empty())
            .map(|w| Word { start_ms: (w.start * 1000.0) as i64, end_ms: (w.end * 1000.0) as i64, text: format!(" {}", w.word.trim()) })
            .collect();
    }
    if !verbose.segments.is_empty() {
        return verbose
            .segments
            .into_iter()
            .filter(|s| !super::transcript::invented(&s.text, s.no_speech_prob))
            .flat_map(|s| spread(&s.text, (s.start * 1000.0) as i64, (s.end * 1000.0) as i64))
            .collect();
    }
    spread(&verbose.text, 0, duration_ms)
}

/// A text's words spread evenly over a span — when the service gave no times of its own.
pub fn spread(text: &str, start_ms: i64, end_ms: i64) -> Vec<Word> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let span = (end_ms - start_ms).max(words.len() as i64) as f64 / words.len() as f64;
    words
        .iter()
        .enumerate()
        .map(|(index, word)| Word {
            start_ms: start_ms + (index as f64 * span) as i64,
            end_ms: start_ms + ((index + 1) as f64 * span) as i64,
            text: format!(" {word}"),
        })
        .collect()
}

/// Sends a second of silence — enough to learn whether the URL, model and key work.
pub async fn check(settings: &CloudSettings, key: &str) -> Result<(), String> {
    let response = send(settings, key, super::audio::wav_bytes(&vec![0.0; super::audio::RATE as usize]), "", "", false).await?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(service_error(status.as_u16(), &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbose_words_are_read_in_milliseconds() {
        let verbose: Verbose = serde_json::from_str(r#"{"text":"Hola a todos","words":[{"word":"Hola","start":0.5,"end":0.9},{"word":"todos","start":1.0,"end":1.4}]}"#).unwrap();
        let words = words_of(verbose, 2_000);
        assert_eq!(words[0], Word { start_ms: 500, end_ms: 900, text: " Hola".into() });
        assert_eq!(words.len(), 2);
    }

    #[test]
    fn segments_without_words_are_spread_and_inventions_dropped() {
        let verbose: Verbose = serde_json::from_str(
            r#"{"text":"x","segments":[{"start":0,"end":2,"text":"uno dos"},{"start":5,"end":6,"text":"Subtítulos realizados por la comunidad de Amara.org"}]}"#,
        )
        .unwrap();
        let words = words_of(verbose, 6_000);
        assert_eq!(words.len(), 2);
        assert_eq!((words[1].start_ms, words[1].end_ms), (1_000, 2_000));
    }

    #[test]
    fn the_endpoint_defaults_to_openai_and_keeps_a_custom_base() {
        assert_eq!(endpoint(&CloudSettings::default()), "https://api.openai.com/v1/audio/transcriptions");
        let groq = CloudSettings { url: "https://api.groq.com/openai/v1/".into(), model: "whisper-large-v3-turbo".into() };
        assert_eq!(endpoint(&groq), "https://api.groq.com/openai/v1/audio/transcriptions");
        assert_eq!(model(&groq), "whisper-large-v3-turbo");
    }

    #[test]
    fn errors_quote_the_services_message() {
        let error = service_error(401, r#"{"error":{"message":"Incorrect API key provided"}}"#);
        assert!(error.contains("refused the key") && error.contains("Incorrect API key"));
    }
}
