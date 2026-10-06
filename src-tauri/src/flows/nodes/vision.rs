//! «Ver una imagen» (`ai.vision`): an image or a PDF read by a model or by the computer itself.
//!
//! Four ways to look, one node: an AI CLI (`nodes::ai` — the file is copied into its scratch folder
//! and the model opens it with its own read tool), a provider's API (the file goes inline: an image
//! part, or a PDF document where the provider takes one), a local model (Ollama's own API or an
//! OpenAI-compatible server — images only, so a scanned PDF hands over the JPEG pages it is made
//! of), and the system's OCR — Apple's Vision framework through JavaScript for Automation on macOS,
//! no model and nothing to install; Tesseract elsewhere, when it is on the PATH.
//!
//! The request builders and the PDF page reader are plain functions, tested without a provider.

use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::files::expand;
use super::llm;
use super::{text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;

/// What one request carries inline — past it, providers want an upload of their own.
const INLINE_LIMIT: u64 = 20 * 1024 * 1024;

/// A file as a model receives it.
#[derive(Debug, Clone)]
pub struct Media {
    pub mime: String,
    pub name: String,
    pub data: Vec<u8>,
}

impl Media {
    pub fn is_pdf(&self) -> bool {
        self.mime == "application/pdf"
    }

    fn base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(&self.data)
    }
}

/// The type of a file a model can look at, by its extension.
pub fn mime_of(path: &Path) -> Option<&'static str> {
    Some(match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref()? {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// The node's file: a path on this computer, or an http(s) address downloaded into the run's work
/// folder first.
pub async fn source(ctx: &NodeCtx, params: &Value, index: usize) -> Result<PathBuf, NodeError> {
    let written = text(params, "imagePath");
    if written.trim().is_empty() {
        return Err(NodeError::failed("Name the image or PDF to look at"));
    }
    local_file(ctx, written.trim(), index).await
}

/// A file a node reads, written as a path or an http(s) link — a link is downloaded into the run's
/// work folder, named after the link (or its Content-Type when the link has no extension).
pub async fn local_file(ctx: &NodeCtx, written: &str, index: usize) -> Result<PathBuf, NodeError> {
    if written.starts_with("http://") || written.starts_with("https://") {
        let url = url::Url::parse(written).map_err(|_| NodeError::failed(format!("{written} is not a URL")))?;
        let name = url.path_segments().and_then(|mut s| s.next_back()).filter(|n| !n.is_empty()).unwrap_or("image").to_string();
        let response = tokio::select! {
            response = reqwest::get(url.clone()) => response.map_err(|e| NodeError::failed(format!("{}: {e}", super::http::loggable(&url))))?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        if !response.status().is_success() {
            return Err(NodeError::failed(format!("{} answered {}", super::http::loggable(&url), response.status().as_u16())));
        }
        // A link with no extension says what it is in its Content-Type.
        let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let bytes = response.bytes().await.map_err(|e| NodeError::failed(e.to_string()))?;
        let mut name = super::google::safe_name(&name);
        if Path::new(&name).extension().is_none() {
            let extension = match kind.split(';').next().unwrap_or_default().trim() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                "application/pdf" => "pdf",
                "audio/mpeg" | "audio/mp3" => "mp3",
                "audio/wav" | "audio/x-wav" => "wav",
                "audio/ogg" => "ogg",
                "audio/mp4" | "audio/x-m4a" => "m4a",
                "audio/webm" | "video/webm" => "webm",
                "audio/flac" => "flac",
                _ => "bin",
            };
            name = format!("{name}.{extension}");
        }
        let dir = ctx.run.host.work_dir().join(&ctx.node.id).join(format!("{index}"));
        std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a work folder: {e}")))?;
        let path = dir.join(name);
        std::fs::write(&path, &bytes).map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))?;
        return Ok(path);
    }
    let path = expand(written);
    if !path.is_file() {
        return Err(NodeError::failed(format!("{} is not a file", path.display())));
    }
    Ok(path)
}

/// The file read for a request: an image or a PDF, under the inline limit.
pub fn media(path: &Path) -> Result<Media, NodeError> {
    let mime = mime_of(path).ok_or_else(|| NodeError::failed(format!("{} is not an image or a PDF this node reads (png, jpg, webp, gif, bmp, tiff, heic, pdf)", path.display())))?;
    let size = std::fs::metadata(path).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?.len();
    if size > INLINE_LIMIT {
        return Err(NodeError::failed(format!("{} is over 20 MB, more than a model takes in one request", path.display())));
    }
    let data = std::fs::read(path).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    Ok(Media { mime: mime.to_string(), name, data })
}

/// What the model is asked, by the node's task. `extract` has its schema appended by the caller.
pub fn task_prompt(task: &str, question: &str, instructions: &str, what: &str) -> String {
    let base = match task {
        "visionDescribe" => format!(
            "Describe {what} con precisión: qué muestra, el texto importante que aparece y cualquier dato relevante (cifras, fechas, nombres). Responde en el idioma del contenido."
        ),
        "visionExtract" => format!(
            "Extrae de {what} los campos del esquema. Usa solo lo que se ve: si un dato no aparece, déjalo en null (o vacío si el campo no admite null); no lo inventes."
        ),
        "visionAsk" => format!("Mira {what} y responde: {}", question.trim()),
        _ => format!(
            "Transcribe todo el texto de {what}, tal como aparece y en su orden de lectura. Conserva los saltos de línea; las tablas, fila por fila con sus columnas separadas por « | ». Responde solo con el texto, sin comentarios."
        ),
    };
    let instructions = instructions.trim();
    if instructions.is_empty() {
        base
    } else {
        format!("{base}\n\nInstrucciones adicionales:\n{instructions}")
    }
}

// ------------------------------------------------------------------------------------ provider APIs

/// The user turn of a chat request with the file in it, per provider. `body` is what
/// [`llm::chat_body`] built for the prompt alone.
pub fn with_media(provider: &str, body: &mut Value, prompt: &str, media: &Media) {
    match provider {
        "anthropic" => {
            let part = if media.is_pdf() {
                json!({"type": "document", "source": {"type": "base64", "media_type": media.mime, "data": media.base64()}})
            } else {
                json!({"type": "image", "source": {"type": "base64", "media_type": media.mime, "data": media.base64()}})
            };
            body["messages"] = json!([{"role": "user", "content": [part, {"type": "text", "text": prompt}]}]);
        }
        "gemini" => {
            body["contents"] = json!([{"role": "user", "parts": [{"inlineData": {"mimeType": media.mime, "data": media.base64()}}, {"text": prompt}]}]);
        }
        _ => {
            let data_url = format!("data:{};base64,{}", media.mime, media.base64());
            let part = if media.is_pdf() {
                json!({"type": "file", "file": {"filename": media.name, "file_data": data_url}})
            } else {
                json!({"type": "image_url", "image_url": {"url": data_url}})
            };
            if let Some(messages) = body["messages"].as_array_mut() {
                if let Some(last) = messages.last_mut() {
                    *last = json!({"role": "user", "content": [{"type": "text", "text": prompt}, part]});
                }
            }
        }
    }
}

/// What a vision call hands back: the answer's text and what to stamp on the item.
pub struct Seen {
    pub text: String,
    pub meta: Map<String, Value>,
}

/// One question about the file to a provider's API (`ai.api`'s providers and key).
pub async fn api(ctx: &NodeCtx, params: &Value, media: &Media, prompt: &str, schema: Option<&Value>) -> Result<Seen, NodeError> {
    let provider = llm::provider_id(&text(params, "apiProvider"));
    let key = llm::api_key(ctx, &provider).await?;
    let base = llm::base_of(&provider, &text(params, "baseUrl")).map_err(NodeError::Failed)?;
    let model = text(params, "apiModel");
    if model.trim().is_empty() {
        return Err(NodeError::failed("Pick the model (one that sees images)"));
    }
    let started = Instant::now();
    let mut body = llm::chat_body(&provider, model.trim(), "", prompt, schema, Some(0.0), 4_096);
    with_media(&provider, &mut body, prompt, media);
    let url = llm::chat_url(&provider, &base, model.trim());
    let answer = llm::send(ctx, &provider, llm::signed(llm::client()?.post(&url).json(&body), &provider, key.as_deref())).await?;
    let answer = llm::read_answer(&provider, &answer);
    let mut meta = Map::new();
    meta.insert("engine".into(), json!(provider));
    meta.insert("model".into(), json!(if answer.model.is_empty() { model.trim().to_string() } else { answer.model.clone() }));
    meta.insert("usage".into(), json!({"inputTokens": answer.input_tokens, "outputTokens": answer.output_tokens}));
    meta.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
    Ok(Seen { text: answer.text, meta })
}

// ------------------------------------------------------------------------------------ local models

/// The JPEG images a PDF is made of, in page order — what a scanner writes. A PDF of text and
/// vector drawings has none; the «PDF» node reads its text instead.
pub fn pdf_images(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let document = lopdf::Document::load_mem(bytes).map_err(|e| format!("Not a PDF this node can read: {e}"))?;
    let mut out = Vec::new();
    for (_, page_id) in document.get_pages() {
        let Ok(images) = document.get_page_images(page_id) else { continue };
        for image in images {
            let jpeg = image.filters.as_ref().is_some_and(|filters| filters.iter().any(|f| f == "DCTDecode"));
            if jpeg {
                out.push(image.content.to_vec());
            }
        }
    }
    Ok(out)
}

/// Ollama's own chat request with images, or an OpenAI-compatible one.
pub fn local_body(server: &str, model: &str, prompt: &str, images: &[String], schema: Option<&Value>) -> Value {
    if server == "openai" {
        let mut content = vec![json!({"type": "text", "text": prompt})];
        content.extend(images.iter().map(|data| json!({"type": "image_url", "image_url": {"url": format!("data:image/jpeg;base64,{data}")}})));
        return json!({"model": model, "messages": [{"role": "user", "content": content}], "temperature": 0, "max_tokens": 4096});
    }
    let mut body = json!({"model": model, "messages": [{"role": "user", "content": prompt, "images": images}], "stream": false, "options": {"temperature": 0, "num_ctx": 16384}});
    if let Some(schema) = schema {
        body["format"] = schema.clone();
    }
    body
}

pub async fn local(ctx: &NodeCtx, params: &Value, media: &Media, prompt: &str, schema: Option<&Value>) -> Result<Seen, NodeError> {
    let server = if text(params, "server") == "openai" { "openai" } else { "ollama" };
    let model = text(params, "model");
    if model.trim().is_empty() {
        return Err(NodeError::failed("Pick the local model (one that sees images: llava, qwen2.5vl, gemma3…)"));
    }
    let images: Vec<String> = if media.is_pdf() {
        let pages = pdf_images(&media.data).map_err(NodeError::Failed)?;
        if pages.is_empty() {
            return Err(NodeError::failed("This PDF has no scanned pages a local model can look at — read its text with the «PDF» node, or pick an API that takes PDFs"));
        }
        pages.iter().map(|page| base64::engine::general_purpose::STANDARD.encode(page)).collect()
    } else {
        vec![media.base64()]
    };
    let base = match text(params, "url").trim().trim_end_matches('/') {
        "" if server == "ollama" => "http://127.0.0.1:11434".to_string(),
        "" => return Err(NodeError::failed("Write the local server's address (…/v1)")),
        written => written.to_string(),
    };
    let url = if server == "ollama" { format!("{base}/api/chat") } else { format!("{base}/chat/completions") };
    let started = Instant::now();
    let body = local_body(server, model.trim(), prompt, &images, schema);
    let answer = llm::send(ctx, if server == "ollama" { "Ollama" } else { "The local server" }, llm::client()?.post(&url).json(&body)).await?;
    let text = if server == "ollama" { answer["message"]["content"].as_str() } else { answer["choices"][0]["message"]["content"].as_str() }.unwrap_or_default().to_string();
    let mut meta = Map::new();
    meta.insert("engine".into(), json!("local"));
    meta.insert("server".into(), json!(server));
    meta.insert("model".into(), json!(model.trim()));
    meta.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
    Ok(Seen { text, meta })
}

// -------------------------------------------------------------------------------------- system OCR

/// Apple's Vision text recognition over an image or every page of a PDF, as JSON on stdout:
/// `[{ text, lines: [{ text, confidence }] }]`, one entry per page.
const VISION_OCR_JXA: &str = r#"ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Vision');
ObjC.import('Quartz');
function recognize(handler, langs) {
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  if (langs.length) {
    request.recognitionLanguages = $(langs);
  } else {
    try { request.automaticallyDetectsLanguage = true; } catch (e) {}
  }
  const error = $();
  if (!handler.performRequestsError($([request]), error)) {
    throw new Error('Vision: ' + (error.localizedDescription ? error.localizedDescription.js : 'failed'));
  }
  const found = [];
  const results = request.results;
  for (let i = 0; i < results.count; i++) {
    const observation = results.objectAtIndex(i);
    const top = observation.topCandidates(1);
    if (top.count === 0) continue;
    const box = observation.boundingBox;
    found.push({ text: top.objectAtIndex(0).string.js, confidence: top.objectAtIndex(0).confidence, x: box.origin.x, y: box.origin.y });
  }
  found.sort((a, b) => (Math.abs(a.y - b.y) > 0.01 ? b.y - a.y : a.x - b.x));
  return found;
}
function run(argv) {
  const path = argv[0];
  const langs = (argv[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const url = $.NSURL.fileURLWithPath(path);
  const pages = [];
  if (path.toLowerCase().endsWith('.pdf')) {
    const doc = $.PDFDocument.alloc.initWithURL(url);
    if (!doc || doc.isNil()) throw new Error('Not a PDF this Mac can open');
    for (let i = 0; i < doc.pageCount; i++) {
      const page = doc.pageAtIndex(i);
      const bounds = page.boundsForBox($.kPDFDisplayBoxMediaBox);
      const image = page.thumbnailOfSizeForBox($.NSMakeSize(bounds.size.width * 2, bounds.size.height * 2), $.kPDFDisplayBoxMediaBox);
      pages.push(recognize($.VNImageRequestHandler.alloc.initWithDataOptions(image.TIFFRepresentation, $({})), langs));
    }
  } else {
    const image = $.NSImage.alloc.initWithContentsOfURL(url);
    if (!image || image.isNil()) throw new Error('Not an image this Mac can open');
    pages.push(recognize($.VNImageRequestHandler.alloc.initWithURLOptions(url, $({})), langs));
  }
  return JSON.stringify(pages.map((lines) => ({ text: lines.map((l) => l.text).join('\n'), lines: lines.map((l) => ({ text: l.text, confidence: Math.round(l.confidence * 100) / 100 })) })));
}
"#;

/// `es-ES, en` → Tesseract's `spa+eng`; codes it does not know pass as written.
pub fn tesseract_languages(written: &str) -> String {
    written
        .split([',', ' ', '+'])
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(|code| match code.split(['-', '_']).next().unwrap_or(code).to_ascii_lowercase().as_str() {
            "es" => "spa".to_string(),
            "en" => "eng".to_string(),
            "pt" => "por".to_string(),
            "fr" => "fra".to_string(),
            "de" => "deu".to_string(),
            "it" => "ita".to_string(),
            "nl" => "nld".to_string(),
            "ca" => "cat".to_string(),
            "ja" => "jpn".to_string(),
            "zh" => "chi_sim".to_string(),
            "ko" => "kor".to_string(),
            _ => code.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Text recognition with no model: Vision on macOS, Tesseract where it is installed.
pub async fn system_ocr(ctx: &NodeCtx, params: &Value, path: &Path) -> Result<Seen, NodeError> {
    let languages = text(params, "ocrLanguages");
    let started = Instant::now();
    let mut meta = Map::new();
    if cfg!(target_os = "macos") {
        let script = ctx.run.host.work_dir().join(&ctx.node.id).join("ocr.js");
        if let Some(dir) = script.parent() {
            std::fs::create_dir_all(dir).map_err(|e| NodeError::failed(format!("Could not prepare a work folder: {e}")))?;
        }
        std::fs::write(&script, VISION_OCR_JXA).map_err(|e| NodeError::failed(format!("Could not write the OCR script: {e}")))?;
        let args = vec![
            "-l".into(),
            "JavaScript".into(),
            script.to_string_lossy().into_owned(),
            path.to_string_lossy().into_owned(),
            languages.split(',').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(","),
        ];
        let output = super::process::run_program(ctx, "osascript", args, None, Vec::new(), None).await?.ok_or_fail("The system's OCR")?;
        let pages: Value = serde_json::from_str(output.stdout.trim()).map_err(|_| NodeError::failed(format!("The system's OCR answered: {}", output.stdout.trim())))?;
        let text = pages.as_array().into_iter().flatten().filter_map(|page| page["text"].as_str()).collect::<Vec<_>>().join("\n\n");
        meta.insert("engine".into(), json!("system"));
        meta.insert("pages".into(), pages);
        meta.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        return Ok(Seen { text, meta });
    }
    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        return Err(NodeError::failed("Tesseract reads images, not PDFs — read a PDF's text with the «PDF» node, or pick an AI engine"));
    }
    let mut args = vec![path.to_string_lossy().into_owned(), "stdout".into()];
    let languages = tesseract_languages(&languages);
    if !languages.is_empty() {
        args.extend(["-l".into(), languages]);
    }
    let output = super::process::run_program(ctx, "tesseract", args, None, Vec::new(), None)
        .await
        .map_err(|error| match error {
            NodeError::Failed(text) if text.contains("was not found") => {
                NodeError::failed("This computer has no OCR of its own: install Tesseract (tesseract-ocr), or pick an AI engine")
            }
            other => other,
        })?
        .ok_or_fail("Tesseract")?;
    ctx.log(LogStream::Info, &format!("Tesseract read {} characters", output.stdout.trim().chars().count()));
    meta.insert("engine".into(), json!("tesseract"));
    meta.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
    Ok(Seen { text: output.stdout.trim().to_string(), meta })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Media {
        Media { mime: "image/png".into(), name: "a.png".into(), data: vec![1, 2, 3] }
    }

    #[test]
    fn each_provider_gets_the_file_its_own_way() {
        let pdf = Media { mime: "application/pdf".into(), name: "f.pdf".into(), data: vec![4, 5] };
        let mut body = llm::chat_body("anthropic", "claude-sonnet-5-5", "", "Lee", None, Some(0.0), 100);
        with_media("anthropic", &mut body, "Lee", &pdf);
        assert_eq!(body["messages"][0]["content"][0]["type"], "document");
        assert_eq!(body["messages"][0]["content"][1]["text"], "Lee");

        let mut body = llm::chat_body("gemini", "gemini-2.5-flash", "", "Lee", None, Some(0.0), 100);
        with_media("gemini", &mut body, "Lee", &png());
        assert_eq!(body["contents"][0]["parts"][0]["inlineData"]["mimeType"], "image/png");
        assert_eq!(body["contents"][0]["parts"][0]["inlineData"]["data"], "AQID");

        let mut body = llm::chat_body("openai", "gpt-5", "Sé breve", "Lee", None, Some(0.0), 100);
        with_media("openai", &mut body, "Lee", &png());
        assert_eq!(body["messages"][0]["role"], "system", "the system message stays first");
        assert_eq!(body["messages"][1]["content"][1]["image_url"]["url"], "data:image/png;base64,AQID");
        with_media("openai", &mut body, "Lee", &pdf);
        assert_eq!(body["messages"][1]["content"][1]["file"]["filename"], "f.pdf");
    }

    #[test]
    fn local_servers_take_images_their_own_way() {
        let schema = json!({"type": "object"});
        let body = local_body("ollama", "qwen2.5vl", "Lee", &["AQID".into()], Some(&schema));
        assert_eq!(body["messages"][0]["images"], json!(["AQID"]));
        assert_eq!(body["format"], schema);
        assert_eq!(body["stream"], false);
        let body = local_body("openai", "llava", "Lee", &["AQID".into()], None);
        assert_eq!(body["messages"][0]["content"][1]["image_url"]["url"], "data:image/jpeg;base64,AQID");
    }

    #[test]
    fn prompts_files_and_languages() {
        assert!(task_prompt("visionOcr", "", "", "la imagen").starts_with("Transcribe todo el texto de la imagen"));
        assert!(task_prompt("visionAsk", "¿Cuánto suma?", "Responde en euros", "el PDF").contains("¿Cuánto suma?\n\nInstrucciones adicionales:\nResponde en euros"));
        assert_eq!(mime_of(Path::new("/x/Scan.JPG")), Some("image/jpeg"));
        assert_eq!(mime_of(Path::new("/x/a.pdf")), Some("application/pdf"));
        assert_eq!(mime_of(Path::new("/x/a.txt")), None);
        assert_eq!(tesseract_languages("es-ES, en-US"), "spa+eng");
        assert_eq!(tesseract_languages("spa+fra"), "spa+fra");
        assert!(pdf_images(b"not a pdf").is_err());
    }
}
