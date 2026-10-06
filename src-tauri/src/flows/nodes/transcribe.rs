//! «Transcribir audio» (`ai.transcribe`): speech to text.
//!
//! OpenAI's transcription endpoint or a server that speaks it (Groq, a self-hosted faster-whisper),
//! Gemini with the audio inline, or Whisper on this computer — whisper.cpp (`whisper-cli`, with its
//! ggml model file) or OpenAI's Python CLI (`whisper`, by model name). The text lands in the item's
//! `target`; with timestamps, the segments beside it as `segments: [{ start, end, text }]`, seconds.

use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::files::expand;
use super::{flag, llm, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::flows::value::set_path;

/// What OpenAI's endpoint takes in one upload.
const OPENAI_LIMIT: u64 = 25 * 1024 * 1024;
/// What Gemini takes inline, with the request around it.
const GEMINI_LIMIT: u64 = 19 * 1024 * 1024;
/// The formats whisper.cpp decodes itself; anything else goes through ffmpeg first.
const WHISPER_CPP_READS: &[&str] = &["wav", "mp3", "flac", "ogg"];

#[derive(Debug, Default)]
pub struct Transcript {
    pub text: String,
    pub segments: Vec<Value>,
    pub language: Option<String>,
    pub model: String,
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let engine = ctx.param_str("transcribeEngine");
    let target = match ctx.param_str("target") {
        written if written.trim().is_empty() => "transcript".to_string(),
        written => written.trim().to_string(),
    };
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let written = text(params, "audioPath");
        if written.trim().is_empty() {
            return Err(NodeError::failed("Name the audio file to transcribe"));
        }
        let path = super::vision::local_file(ctx, written.trim(), index).await?;
        if !path.is_file() {
            return Err(NodeError::failed(format!("{} is not a file", path.display())));
        }
        let started = Instant::now();
        let transcript = match engine.as_str() {
            "gemini" => gemini(ctx, params, &path).await?,
            "whisperLocal" => whisper_local(ctx, params, &path, index).await?,
            _ => openai_like(ctx, params, &path, engine == "compatible").await?,
        };
        let mut json = items.get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        set_path(&mut json, &target, json!(transcript.text.trim()));
        if flag(params, "timestamps") {
            set_path(&mut json, "segments", json!(transcript.segments));
        }
        if let Value::Object(map) = &mut json {
            let mut meta = Map::new();
            meta.insert("engine".into(), json!(if engine.is_empty() { "openaiApi" } else { engine.as_str() }));
            if !transcript.model.is_empty() {
                meta.insert("model".into(), json!(transcript.model));
            }
            if let Some(language) = &transcript.language {
                meta.insert("language".into(), json!(language));
            }
            meta.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
            map.entry("ai").or_insert(Value::Object(meta));
        }
        out.push(if items.is_empty() { Item::new(json) } else { Item::paired(json, index) });
    }
    Ok(vec![out])
}

fn audio_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp3" | "mpga" | "mpeg") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a" | "aac") => "audio/aac",
        Some("mp4") => "audio/mp4",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("webm") => "audio/webm",
        Some("aif" | "aiff") => "audio/aiff",
        _ => "application/octet-stream",
    }
}

fn size_of(path: &Path) -> Result<u64, NodeError> {
    Ok(std::fs::metadata(path).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?.len())
}

/// `whisper-1`'s verbose answer (and Groq's) as segments in seconds.
pub fn read_verbose(answer: &Value) -> Transcript {
    Transcript {
        text: answer["text"].as_str().unwrap_or_default().trim().to_string(),
        segments: answer["segments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| json!({"start": s["start"], "end": s["end"], "text": s["text"].as_str().unwrap_or_default().trim()}))
            .collect(),
        language: answer["language"].as_str().map(str::to_string),
        model: String::new(),
    }
}

/// The model a transcription asks for when the node names none: timestamps need `whisper-1`, the
/// only one of OpenAI's that answers with segments.
pub fn default_model(compatible: bool, timestamps: bool, written: &str) -> Result<String, String> {
    let written = written.trim();
    if !written.is_empty() {
        if !compatible && timestamps && written.starts_with("gpt-") {
            return Err(format!("{written} gives no timestamps — use whisper-1, or turn timestamps off"));
        }
        return Ok(written.to_string());
    }
    match (compatible, timestamps) {
        (true, _) => Err("Name the model the server transcribes with (whisper-large-v3…)".into()),
        (false, true) => Ok("whisper-1".into()),
        (false, false) => Ok("gpt-4o-mini-transcribe".into()),
    }
}

async fn openai_like(ctx: &NodeCtx, params: &Value, path: &Path, compatible: bool) -> Result<Transcript, NodeError> {
    let provider = if compatible { "compatible" } else { "openai" };
    let key = llm::api_key(ctx, provider).await?;
    let base = llm::base_of(provider, &text(params, "baseUrl")).map_err(NodeError::Failed)?;
    let timestamps = flag(params, "timestamps");
    let model = default_model(compatible, timestamps, &text(params, "transcribeModel")).map_err(NodeError::Failed)?;
    if !compatible && size_of(path)? > OPENAI_LIMIT {
        return Err(NodeError::failed(format!("{} is over 25 MB, more than OpenAI takes in one upload — cut it first (Comando with ffmpeg)", path.display())));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "audio.mp3".into());
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name).mime_str(audio_mime(path)).map_err(|e| NodeError::failed(e.to_string()))?;
    let mut form = reqwest::multipart::Form::new().part("file", part).text("model", model.clone());
    let language = text(params, "audioLanguage");
    if !language.trim().is_empty() {
        // ISO 639-1: `es`, not `es-CL`.
        form = form.text("language", language.trim().split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase());
    }
    let prompt = text(params, "audioPrompt");
    if !prompt.trim().is_empty() {
        form = form.text("prompt", prompt.trim().to_string());
    }
    form = if timestamps {
        form.text("response_format", "verbose_json").text("timestamp_granularities[]", "segment")
    } else {
        form.text("response_format", "json")
    };
    let request = llm::signed(llm::client()?.post(format!("{base}/audio/transcriptions")).multipart(form), provider, key.as_deref());
    let answer = llm::send(ctx, if compatible { "The transcription server" } else { "OpenAI" }, request).await?;
    let mut transcript = read_verbose(&answer);
    transcript.model = model;
    Ok(transcript)
}

async fn gemini(ctx: &NodeCtx, params: &Value, path: &Path) -> Result<Transcript, NodeError> {
    let key = llm::api_key(ctx, "gemini").await?;
    let base = llm::base_of("gemini", "").map_err(NodeError::Failed)?;
    let model = match text(params, "transcribeModel") {
        written if written.trim().is_empty() || written.trim().starts_with("whisper") => "gemini-2.5-flash".to_string(),
        written => written.trim().to_string(),
    };
    if size_of(path)? > GEMINI_LIMIT {
        return Err(NodeError::failed(format!("{} is over 19 MB, more than Gemini takes inline — cut it first (Comando with ffmpeg)", path.display())));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
    let timestamps = flag(params, "timestamps");
    let request = gemini_body(audio_mime(path), &base64::engine::general_purpose::STANDARD.encode(bytes), &text(params, "audioLanguage"), &text(params, "audioPrompt"), timestamps);
    let url = llm::chat_url("gemini", &base, &model);
    let answer = llm::send(ctx, "Gemini", llm::signed(llm::client()?.post(&url).json(&request), "gemini", key.as_deref())).await?;
    let reply = llm::read_answer("gemini", &answer);
    let mut transcript = if timestamps {
        let object = crate::flows::schema::answer_object(&reply.text).ok_or_else(|| NodeError::failed("Gemini did not answer the segments as JSON"))?;
        Transcript {
            text: object["text"].as_str().unwrap_or_default().to_string(),
            segments: object["segments"].as_array().cloned().unwrap_or_default(),
            language: object["language"].as_str().map(str::to_string),
            model: String::new(),
        }
    } else {
        Transcript { text: reply.text, ..Default::default() }
    };
    transcript.model = if reply.model.is_empty() { model } else { reply.model };
    Ok(transcript)
}

/// Gemini's request: the audio inline and what to do with it — plain text, or the segments as JSON.
pub fn gemini_body(mime: &str, data: &str, language: &str, vocabulary: &str, timestamps: bool) -> Value {
    let mut ask = String::from("Transcribe este audio palabra por palabra, en el idioma en que se habla. No resumas, no traduzcas ni agregues comentarios.");
    if !language.trim().is_empty() {
        ask.push_str(&format!(" El idioma es «{}».", language.trim()));
    }
    if !vocabulary.trim().is_empty() {
        ask.push_str(&format!(" Palabras que pueden aparecer: {}.", vocabulary.trim()));
    }
    let mut config = json!({"temperature": 0});
    if timestamps {
        ask.push_str(
            " Responde SOLO con un objeto JSON: {\"text\": la transcripción completa, \"language\": el código ISO del idioma, \
             \"segments\": [{\"start\": segundo de inicio, \"end\": segundo de fin, \"text\": lo dicho}]}, un segmento por frase.",
        );
        config["responseMimeType"] = json!("application/json");
    } else {
        ask.push_str(" Responde solo con la transcripción.");
    }
    json!({"contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": mime, "data": data}}, {"text": ask}]}], "generationConfig": config})
}

fn which(program: &str) -> Option<PathBuf> {
    crate::scaffold::tools::which_in(&std::env::var("PATH").unwrap_or_default(), program)
}

/// whisper.cpp's `-oj` file: `transcription: [{ offsets: { from, to } (ms), text }]`.
pub fn read_whisper_cpp(answer: &Value) -> Transcript {
    let segments: Vec<Value> = answer["transcription"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let ms = |side: &str| s["offsets"][side].as_f64().map(|v| (v / 10.0).round() / 100.0).unwrap_or(0.0);
            json!({"start": ms("from"), "end": ms("to"), "text": s["text"].as_str().unwrap_or_default().trim()})
        })
        .collect();
    let text = segments.iter().filter_map(|s| s["text"].as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ");
    Transcript { text, segments, language: answer["result"]["language"].as_str().map(str::to_string), model: String::new() }
}

async fn whisper_local(ctx: &NodeCtx, params: &Value, path: &Path, index: usize) -> Result<Transcript, NodeError> {
    let dir = ctx.run.host.work_dir().join(&ctx.node.id).join(format!("whisper-{index}"));
    std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a work folder: {e}")))?;
    let language = text(params, "audioLanguage").trim().split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
    let prompt = text(params, "audioPrompt");
    let model = text(params, "whisperModel");
    let model = model.trim();
    if let Some(cli) = ["whisper-cli", "whisper-cpp"].iter().find_map(|name| which(name)) {
        let model_path = expand(model);
        if model.is_empty() || !model_path.is_file() {
            return Err(NodeError::failed(
                "whisper.cpp needs its model file: write the path to a ggml model (ggml-base.bin, ggml-large-v3-turbo.bin…) in «Modelo de Whisper»",
            ));
        }
        // whisper.cpp decodes WAV, MP3, FLAC and OGG; anything else is converted to 16 kHz mono first.
        let extension = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        let input = if WHISPER_CPP_READS.contains(&extension.as_str()) {
            path.to_path_buf()
        } else {
            if which("ffmpeg").is_none() {
                return Err(NodeError::failed(format!("whisper.cpp does not read .{extension} files: install ffmpeg, or convert the audio to WAV or MP3")));
            }
            let wav = dir.join("audio.wav");
            let args = ["-y", "-loglevel", "error", "-i"].iter().map(|s| s.to_string()).chain([path.to_string_lossy().into_owned()]).chain(
                ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"].iter().map(|s| s.to_string()),
            );
            let args: Vec<String> = args.chain([wav.to_string_lossy().into_owned()]).collect();
            super::process::run_program(ctx, "ffmpeg", args, None, Vec::new(), None).await?.ok_or_fail("ffmpeg")?;
            wav
        };
        let output = dir.join("transcript");
        let mut args = vec![
            "-m".to_string(),
            model_path.to_string_lossy().into_owned(),
            "-f".into(),
            input.to_string_lossy().into_owned(),
            "-oj".into(),
            "-of".into(),
            output.to_string_lossy().into_owned(),
            "-np".into(),
            "-l".into(),
            if language.is_empty() { "auto".into() } else { language.clone() },
        ];
        if !prompt.trim().is_empty() {
            args.extend(["--prompt".into(), prompt.trim().to_string()]);
        }
        super::process::run_program(ctx, &cli.to_string_lossy(), args, None, Vec::new(), None).await?.ok_or_fail("whisper.cpp")?;
        let written = std::fs::read_to_string(output.with_extension("json")).map_err(|e| NodeError::failed(format!("whisper.cpp wrote no transcript: {e}")))?;
        let answer: Value = serde_json::from_str(&written).map_err(|_| NodeError::failed("whisper.cpp's transcript is not JSON"))?;
        let mut transcript = read_whisper_cpp(&answer);
        transcript.model = model_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(transcript);
    }
    if which("whisper").is_some() {
        let name = if model.is_empty() { "base" } else { model };
        let mut args = vec![
            path.to_string_lossy().into_owned(),
            "--model".into(),
            name.to_string(),
            "--output_format".into(),
            "json".into(),
            "--output_dir".into(),
            dir.to_string_lossy().into_owned(),
            "--verbose".into(),
            "False".into(),
        ];
        if !language.is_empty() {
            args.extend(["--language".into(), language.clone()]);
        }
        if !prompt.trim().is_empty() {
            args.extend(["--initial_prompt".into(), prompt.trim().to_string()]);
        }
        ctx.log(LogStream::Info, &format!("Whisper ({name}) is transcribing — the first run downloads the model"));
        super::process::run_program(ctx, "whisper", args, None, Vec::new(), None).await?.ok_or_fail("whisper")?;
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "audio".into());
        let written = std::fs::read_to_string(dir.join(format!("{stem}.json"))).map_err(|e| NodeError::failed(format!("Whisper wrote no transcript: {e}")))?;
        let answer: Value = serde_json::from_str(&written).map_err(|_| NodeError::failed("Whisper's transcript is not JSON"))?;
        let mut transcript = read_verbose(&answer);
        transcript.model = name.to_string();
        return Ok(transcript);
    }
    Err(NodeError::failed("No Whisper on this computer: install whisper.cpp (whisper-cli) or OpenAI's whisper (pip install openai-whisper), or pick an API"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_of_every_engine_read_into_segments_in_seconds() {
        let verbose = json!({"text": " Hola mundo ", "language": "spanish", "segments": [{"id": 0, "start": 0.0, "end": 1.5, "text": " Hola mundo"}]});
        let transcript = read_verbose(&verbose);
        assert_eq!(transcript.text, "Hola mundo");
        assert_eq!(transcript.segments, vec![json!({"start": 0.0, "end": 1.5, "text": "Hola mundo"})]);

        let cpp = json!({"result": {"language": "es"}, "transcription": [
            {"offsets": {"from": 0, "to": 1520}, "text": " Hola"},
            {"offsets": {"from": 1520, "to": 3000}, "text": " mundo."}
        ]});
        let transcript = read_whisper_cpp(&cpp);
        assert_eq!(transcript.text, "Hola mundo.");
        assert_eq!(transcript.segments[0]["end"], json!(1.52));
        assert_eq!(transcript.language.as_deref(), Some("es"));
    }

    #[test]
    fn the_default_model_follows_the_timestamps() {
        assert_eq!(default_model(false, false, "").unwrap(), "gpt-4o-mini-transcribe");
        assert_eq!(default_model(false, true, "").unwrap(), "whisper-1");
        assert!(default_model(false, true, "gpt-4o-transcribe").is_err());
        assert!(default_model(true, false, "").is_err());
        assert_eq!(default_model(true, true, "whisper-large-v3").unwrap(), "whisper-large-v3");
    }

    #[test]
    fn gemini_is_asked_for_json_only_with_timestamps() {
        let body = gemini_body("audio/mpeg", "AAA", "es", "CodeFlow", true);
        assert_eq!(body["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(body["contents"][0]["parts"][0]["inlineData"]["mimeType"], "audio/mpeg");
        assert!(body["contents"][0]["parts"][1]["text"].as_str().unwrap().contains("CodeFlow"));
        let body = gemini_body("audio/wav", "AAA", "", "", false);
        assert!(body["generationConfig"].get("responseMimeType").is_none());
    }
}
