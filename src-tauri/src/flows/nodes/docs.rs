//! Documents and media: audio and video by ffmpeg («Audio y video»), Word documents read, filled from
//! a template or written from Markdown («Documento Word»), calendars read and invitations written
//! («Calendario .ics»), and any document turned into Markdown («Convertir a Markdown», by anydoc).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use serde_json::{json, Map, Value};

use super::process::run_program;
use super::{flag, number, pairs, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "files.media" => media(ctx).await,
        "files.docx" => docx(ctx).await,
        "files.ics" => ics(ctx).await,
        "files.markdown" => to_markdown(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

async fn per_item<F, Fut>(ctx: &NodeCtx, f: F) -> Result<Ports, NodeError>
where
    F: Fn(Value, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<Value>, NodeError>>,
{
    let each = ctx.param_str("runFor") != "once" && !ctx.items().is_empty();
    let resolved = if each { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let items = ctx.items();
    let mut out = Vec::new();
    for (index, params) in resolved.into_iter().enumerate() {
        let json = items.get(index).map(|i| i.json.clone()).unwrap_or(json!({}));
        for produced in f(params, json).await? {
            out.push(if items.is_empty() { Item::new(produced) } else { Item::paired(produced, index) });
        }
    }
    Ok(vec![out])
}

fn need_path(params: &Value, name: &str, what: &str) -> Result<PathBuf, NodeError> {
    let raw = text(params, name);
    if raw.trim().is_empty() {
        return Err(NodeError::failed(format!("Say which {what}")));
    }
    Ok(super::expand_path(raw.trim()))
}

/// Where an output goes: the path asked for, or beside the input with `suffix` and `extension`.
fn output_path(params: &Value, input: &Path, suffix: &str, extension: &str) -> PathBuf {
    let asked = text(params, "savePath");
    if !asked.trim().is_empty() {
        return super::expand_path(asked.trim());
    }
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "salida".into());
    input.with_file_name(format!("{stem}{suffix}.{extension}"))
}

// ---------------------------------------------------------------------------------------- media

fn tool(name: &str) -> Result<String, NodeError> {
    crate::containers::cli::find(name)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| NodeError::failed(format!("{name} is not installed — on a Mac: brew install ffmpeg; on Windows: winget install ffmpeg")))
}

/// What ffprobe says about a file: duration, size, streams.
async fn probe(ctx: &NodeCtx, input: &Path) -> Result<Value, NodeError> {
    let ffprobe = tool("ffprobe")?;
    let output = run_program(
        ctx,
        &ffprobe,
        vec!["-v".into(), "error".into(), "-print_format".into(), "json".into(), "-show_format".into(), "-show_streams".into(), input.to_string_lossy().into_owned()],
        None,
        vec![],
        None,
    )
    .await?
    .ok_or_fail("ffprobe")?;
    let doc: Value = serde_json::from_str(&output.stdout).map_err(|e| NodeError::failed(format!("ffprobe: {e}")))?;
    let number_of = |v: Option<&Value>| v.and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64()));
    let streams: Vec<Value> = doc
        .get("streams")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|s| {
                    json!({
                        "type": s.get("codec_type"),
                        "codec": s.get("codec_name"),
                        "width": s.get("width"),
                        "height": s.get("height"),
                        "sampleRate": s.get("sample_rate"),
                        "channels": s.get("channels"),
                        "bitRate": number_of(s.get("bit_rate")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "path": input.to_string_lossy(),
        "duration": number_of(doc.pointer("/format/duration")),
        "size": number_of(doc.pointer("/format/size")),
        "bitRate": number_of(doc.pointer("/format/bit_rate")),
        "format": doc.pointer("/format/format_long_name"),
        "streams": streams,
    }))
}

async fn media(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    per_item(ctx, |params, _| async move {
        let input = need_path(&params, "mediaPath", "audio or video file")?;
        if !input.exists() {
            return Err(NodeError::failed(format!("{} does not exist", input.display())));
        }
        let op = text(&params, "mediaOp");
        if op == "mediaInfo" {
            return Ok(vec![probe(ctx, &input).await?]);
        }
        let ffmpeg = tool("ffmpeg")?;
        let src = input.to_string_lossy().into_owned();
        let run = |args: Vec<String>| {
            let ffmpeg = ffmpeg.clone();
            async move {
                let mut full = vec!["-y".to_string(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
                full.extend(args);
                run_program(ctx, &ffmpeg, full, None, vec![], None).await?.ok_or_fail("ffmpeg")
            }
        };
        let file_item = |path: &Path| {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            json!({"path": path.to_string_lossy(), "file": crate::flows::nodes::binary::reference_of(path), "size": size})
        };
        match op.as_str() {
            "extractAudio" => {
                let format = { let f = text(&params, "audioFormat"); if f.trim().is_empty() { "mp3".to_string() } else { f } };
                let out = output_path(&params, &input, "", &format);
                let codec: Vec<String> = match format.as_str() {
                    "m4a" => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "160k".into()],
                    "wav" => vec!["-c:a".into(), "pcm_s16le".into()],
                    "ogg" => vec!["-c:a".into(), "libvorbis".into(), "-q:a".into(), "5".into()],
                    "flac" => vec!["-c:a".into(), "flac".into()],
                    _ => vec!["-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()],
                };
                let mut args = vec!["-i".to_string(), src, "-vn".into()];
                args.extend(codec);
                args.push(out.to_string_lossy().into_owned());
                run(args).await?;
                Ok(vec![file_item(&out)])
            }
            "mediaConvert" => {
                let out = need_path(&params, "savePath", "file to write (its extension is the format)")?;
                run(vec!["-i".into(), src, out.to_string_lossy().into_owned()]).await?;
                Ok(vec![file_item(&out)])
            }
            "mediaTrim" => {
                let ext = input.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
                let out = output_path(&params, &input, "-recorte", &ext);
                let mut args = Vec::new();
                let start = text(&params, "trimStart");
                if !start.trim().is_empty() {
                    args.extend(["-ss".to_string(), start.trim().to_string()]);
                }
                args.extend(["-i".to_string(), src]);
                let duration = text(&params, "trimDuration");
                if !duration.trim().is_empty() {
                    args.extend(["-t".to_string(), duration.trim().to_string()]);
                }
                args.extend(["-c".into(), "copy".into(), out.to_string_lossy().into_owned()]);
                run(args).await?;
                Ok(vec![file_item(&out)])
            }
            "mediaSplit" => {
                let info = probe(ctx, &input).await?;
                let minutes = number(&params, "splitMinutes").unwrap_or(0.0).max(0.0);
                let max_mb = number(&params, "splitMaxMb").unwrap_or(0.0).max(0.0);
                let bit_rate = info["bitRate"].as_f64().unwrap_or(0.0);
                // Whichever is smaller: the minutes asked for, or the length a size limit allows.
                let by_size = if max_mb > 0.0 && bit_rate > 0.0 { max_mb * 1_000_000.0 * 8.0 / bit_rate * 0.95 } else { f64::INFINITY };
                let by_time = if minutes > 0.0 { minutes * 60.0 } else { f64::INFINITY };
                let seconds = by_size.min(by_time);
                if !seconds.is_finite() {
                    return Err(NodeError::failed("Say how long each piece is, or how big it may be"));
                }
                let ext = input.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp3".into());
                let pattern = output_path(&params, &input, "-%03d", &ext);
                let folder = pattern.parent().map(Path::to_path_buf).unwrap_or_default();
                std::fs::create_dir_all(&folder).map_err(|e| NodeError::failed(e.to_string()))?;
                run(vec![
                    "-i".into(),
                    src,
                    "-f".into(),
                    "segment".into(),
                    "-segment_time".into(),
                    format!("{:.0}", seconds.max(1.0)),
                    "-c".into(),
                    "copy".into(),
                    "-reset_timestamps".into(),
                    "1".into(),
                    pattern.to_string_lossy().into_owned(),
                ])
                .await?;
                // What goes before and after the piece number in the name ffmpeg writes: split at the number itself, so a name with
                // dots in it (`reunion.v2`) is found like any other.
                let written = pattern.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let (head, tail) = written.split_once("%03d").map(|(h, t)| (h.to_string(), t.to_string())).unwrap_or((written.clone(), String::new()));
                let mut pieces: Vec<PathBuf> = std::fs::read_dir(&folder)
                    .map_err(|e| NodeError::failed(e.to_string()))?
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name().map(|n| n.to_string_lossy().into_owned()).is_some_and(|n| {
                            n.len() == head.len() + 3
                                + tail.len()
                                && n.starts_with(&head)
                                && n.ends_with(&tail)
                                && n.as_bytes()[head.len()..head.len() + 3].iter().all(u8::is_ascii_digit)
                        })
                    })
                    .collect();
                pieces.sort();
                Ok(pieces.iter().enumerate().map(|(i, p)| { let mut item = file_item(p); item["part"] = json!(i + 1); item["parts"] = json!(pieces.len()); item }).collect())
            }
            "mediaThumbnail" => {
                let out = output_path(&params, &input, "-miniatura", "jpg");
                let at = { let t = text(&params, "thumbAt"); if t.trim().is_empty() { "00:00:01".to_string() } else { t.trim().to_string() } };
                run(vec!["-ss".into(), at, "-i".into(), src, "-frames:v".into(), "1".into(), "-q:v".into(), "3".into(), out.to_string_lossy().into_owned()]).await?;
                Ok(vec![file_item(&out)])
            }
            "mediaCompress" => {
                let out = output_path(&params, &input, "-comprimido", "mp4");
                let crf = number(&params, "crf").unwrap_or(28.0).clamp(18.0, 40.0) as u32;
                run(vec![
                    "-i".into(),
                    src,
                    "-c:v".into(),
                    "libx264".into(),
                    "-crf".into(),
                    crf.to_string(),
                    "-preset".into(),
                    "medium".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "128k".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    out.to_string_lossy().into_owned(),
                ])
                .await?;
                let before = std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0);
                let mut item = file_item(&out);
                item["originalSize"] = json!(before);
                Ok(vec![item])
            }
            other => Err(NodeError::failed(format!("Unknown operation {other}"))),
        }
    })
    .await
}

// ----------------------------------------------------------------------------------------- docx

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The most one part of a document may unpack to. A real part is kilobytes (the text) to a few
/// megabytes (a photo); a zip bomb is a few kilobytes that unpack to gigabytes — all of it held in
/// memory, in the app.
const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;

/// The most a whole document may unpack to.
const MAX_UNPACKED_BYTES: u64 = 200 * 1024 * 1024;

/// A document's parts by name — every one, or only the one named. Each is read through a cap rather
/// than trusted to be the size its header says, which a crafted archive is free to lie about.
fn read_zip(path: &Path, only: Option<&str>) -> Result<BTreeMap<String, Vec<u8>>, NodeError> {
    read_zip_within(path, only, MAX_PART_BYTES, MAX_UNPACKED_BYTES)
}

fn read_zip_within(path: &Path, only: Option<&str>, part_cap: u64, total_cap: u64) -> Result<BTreeMap<String, Vec<u8>>, NodeError> {
    let file = std::fs::File::open(path).map_err(|e| NodeError::failed(format!("{}: {e}", path.display())))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| NodeError::failed(format!("{} is not a Word document: {e}", path.display())))?;
    let mut out = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| NodeError::failed(e.to_string()))?;
        let name = entry.name().to_string();
        if only.is_some_and(|wanted| wanted != name) {
            continue;
        }
        // Whichever is nearer: this part's own limit, or what is left of the whole document's.
        let budget = part_cap.min(total_cap - total);
        let mut bytes = Vec::new();
        entry.by_ref().take(budget + 1).read_to_end(&mut bytes).map_err(|e| NodeError::failed(format!("{name}: {e}")))?;
        if bytes.len() as u64 > budget {
            let limit = if budget < part_cap { total_cap } else { part_cap };
            return Err(NodeError::failed(format!(
                "{} unpacks to more than {} MB (at {name}) — more than any document needs, so it is not opened",
                path.display(),
                limit >> 20
            )));
        }
        total += bytes.len() as u64;
        out.insert(name, bytes);
    }
    Ok(out)
}

fn write_zip(path: &Path, entries: &BTreeMap<String, Vec<u8>>) -> Result<(), NodeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(e.to_string()))?;
    }
    let file = std::fs::File::create(path).map_err(|e| NodeError::failed(format!("{}: {e}", path.display())))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // `[Content_Types].xml` first, the way Word writes it.
    let mut names: Vec<&String> = entries.keys().collect();
    names.sort_by_key(|n| (n.as_str() != "[Content_Types].xml", n.as_str().to_string()));
    for name in names {
        writer.start_file(name.as_str(), options).map_err(|e| NodeError::failed(e.to_string()))?;
        writer.write_all(&entries[name]).map_err(|e| NodeError::failed(e.to_string()))?;
    }
    writer.finish().map_err(|e| NodeError::failed(e.to_string()))?;
    Ok(())
}

/// A paragraph's text, its style, and whether it is a list item — read from `<w:p>`.
struct Paragraph {
    text: String,
    style: String,
    list_level: Option<usize>,
}

/// `word/document.xml` read into paragraphs and tables, in order.
enum Block {
    Para(Paragraph),
    Table(Vec<Vec<String>>),
}

fn read_blocks(xml: &str) -> Vec<Block> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut blocks = Vec::new();
    let mut paragraph: Option<Paragraph> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell: Option<String> = None;
    let mut in_text = false;
    let mut depth_table = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let local = name.as_ref();
                match local {
                    b"w:tbl" => {
                        depth_table += 1;
                        if depth_table == 1 {
                            table = Some(Vec::new());
                        }
                    }
                    b"w:tr" if depth_table == 1 => {
                        if let Some(t) = table.as_mut() {
                            t.push(Vec::new());
                        }
                    }
                    b"w:tc" if depth_table == 1 => cell = Some(String::new()),
                    b"w:p" => paragraph = Some(Paragraph { text: String::new(), style: String::new(), list_level: None }),
                    b"w:pStyle" => {
                        if let (Some(p), Some(v)) = (paragraph.as_mut(), e.try_get_attribute("w:val").ok().flatten()) {
                            p.style = String::from_utf8_lossy(&v.value).into_owned();
                        }
                    }
                    b"w:ilvl" => {
                        if let (Some(p), Some(v)) = (paragraph.as_mut(), e.try_get_attribute("w:val").ok().flatten()) {
                            p.list_level = String::from_utf8_lossy(&v.value).parse().ok();
                        }
                    }
                    b"w:numPr" => {
                        if let Some(p) = paragraph.as_mut() {
                            p.list_level.get_or_insert(0);
                        }
                    }
                    b"w:t" => in_text = true,
                    b"w:tab" => {
                        if let Some(p) = paragraph.as_mut() {
                            p.text.push('\t');
                        }
                    }
                    b"w:br" => {
                        if let Some(p) = paragraph.as_mut() {
                            p.text.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                if let Some(p) = paragraph.as_mut() {
                    p.text.push_str(&xml_unescape(&String::from_utf8_lossy(t.as_ref())));
                }
            }
            // An entity arrives as a reference of its own between the text around it — "R&amp;D" is
            // `R`, `amp`, `D` — and with text alone read, it went missing ("RD").
            Ok(Event::GeneralRef(reference)) if in_text => {
                if let Some(p) = paragraph.as_mut() {
                    p.text.push_str(&resolve_reference(&reference));
                }
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:p" => {
                    if let Some(p) = paragraph.take() {
                        if let Some(c) = cell.as_mut() {
                            if !c.is_empty() {
                                c.push(' ');
                            }
                            c.push_str(p.text.trim());
                        } else {
                            blocks.push(Block::Para(p));
                        }
                    }
                }
                b"w:tc" if depth_table == 1 => {
                    if let (Some(c), Some(t)) = (cell.take(), table.as_mut()) {
                        if let Some(row) = t.last_mut() {
                            row.push(c);
                        }
                    }
                }
                b"w:tbl" => {
                    depth_table = depth_table.saturating_sub(1);
                    if depth_table == 0 {
                        if let Some(t) = table.take() {
                            blocks.push(Block::Table(t));
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    blocks
}

/// What `&…;` stands for: one of XML's five entities, or a character by its number (`&#233;`,
/// `&#xE9;`). Anything else — an entity only a DTD could define — is kept as written.
fn resolve_reference(reference: &quick_xml::events::BytesRef<'_>) -> String {
    let name = String::from_utf8_lossy(reference).into_owned();
    match quick_xml::escape::resolve_xml_entity(&name) {
        Some(resolved) => resolved.to_string(),
        None => reference.resolve_char_ref().ok().flatten().map(String::from).unwrap_or_else(|| format!("&{name};")),
    }
}

/// The heading level a style names — `Heading1`, `Ttulo1` (Spanish Word), `Title`.
fn heading_level(style: &str) -> Option<usize> {
    let lower = style.to_lowercase();
    if lower == "title" || lower == "ttulo" || lower == "titulo" {
        return Some(1);
    }
    let digits: String = lower.chars().filter(char::is_ascii_digit).collect();
    let named = lower.starts_with("heading") || lower.starts_with("ttulo") || lower.starts_with("titulo");
    if named { digits.parse().ok().filter(|n: &usize| (1..=6).contains(n)) } else { None }
}

fn blocks_text(blocks: &[Block], markdown: bool) -> String {
    let mut out = String::new();
    for block in blocks {
        match block {
            Block::Para(p) => {
                let text = p.text.trim_end();
                if !markdown {
                    out.push_str(text);
                    out.push('\n');
                    continue;
                }
                if text.trim().is_empty() {
                    out.push('\n');
                } else if let Some(level) = heading_level(&p.style) {
                    out.push_str(&format!("{} {}\n\n", "#".repeat(level), text.trim()));
                } else if let Some(level) = p.list_level {
                    out.push_str(&format!("{}- {}\n", "  ".repeat(level), text.trim()));
                } else {
                    out.push_str(&format!("{}\n\n", text));
                }
            }
            Block::Table(rows) => {
                if rows.is_empty() {
                    continue;
                }
                if markdown {
                    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                    for (i, row) in rows.iter().enumerate() {
                        let cells: Vec<String> = (0..width).map(|c| row.get(c).cloned().unwrap_or_default().replace('|', "\\|")).collect();
                        out.push_str(&format!("| {} |\n", cells.join(" | ")));
                        if i == 0 {
                            out.push_str(&format!("|{}\n", " --- |".repeat(width)));
                        }
                    }
                    out.push('\n');
                } else {
                    for row in rows {
                        out.push_str(&row.join("\t"));
                        out.push('\n');
                    }
                }
            }
        }
    }
    let collapsed = regex::Regex::new(r"\n{3,}").map(|re| re.replace_all(&out, "\n\n").into_owned()).unwrap_or(out);
    collapsed.trim().to_string()
}

/// Every `{{name}}` in a part's paragraphs replaced. Word splits text into runs wherever formatting
/// (or a spell check) changed, so a placeholder can span several `<w:t>`: a paragraph holding `{{` has
/// its text joined into its first run and the others emptied — the first run's look wins there.
pub fn fill_xml(xml: &str, values: &Map<String, Value>) -> (String, usize) {
    let paragraph = regex::Regex::new(r"(?s)<w:p[ >].*?</w:p>").expect("a valid pattern");
    let text_run = regex::Regex::new(r#"(?s)(<w:t(?: [^>]*)?>)(.*?)(</w:t>)"#).expect("a valid pattern");
    let placeholder = regex::Regex::new(r"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}").expect("a valid pattern");
    let mut replaced = 0usize;
    let out = paragraph.replace_all(xml, |caps: &regex::Captures| {
        let para = &caps[0];
        let joined: String = text_run.captures_iter(para).map(|c| xml_unescape(&c[2])).collect();
        if !joined.contains("{{") {
            return para.to_string();
        }
        let filled = placeholder.replace_all(&joined, |p: &regex::Captures| {
            let key = &p[1];
            let found = values.get(key).or_else(|| key.split('.').try_fold(None::<&Value>, |acc, part| Some(match acc { None => values.get(part), Some(v) => v.get(part) })).flatten());
            match found {
                Some(v) => {
                    replaced += 1;
                    match v {
                        Value::String(s) => s.clone(),
                        Value::Null => String::new(),
                        other => other.to_string(),
                    }
                }
                None => p[0].to_string(),
            }
        });
        let mut first = true;
        text_run
            .replace_all(para, |c: &regex::Captures| {
                if first {
                    first = false;
                    // `xml:space="preserve"` so spaces at the ends of the value survive.
                    format!("<w:t xml:space=\"preserve\">{}{}", xml_escape(&filled), &c[3])
                } else {
                    format!("{}{}", &c[1], &c[3])
                }
            })
            .into_owned()
    });
    (out.into_owned(), replaced)
}

/// A Word document written from Markdown: headings, paragraphs with bold and italic, lists, code
/// and tables — with Word's own styles, so they can be restyled in Word.
pub fn markdown_docx(markdown: &str) -> BTreeMap<String, Vec<u8>> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let mut body = String::new();
    let mut runs = String::new();
    let (mut bold, mut italic, mut code) = (false, false, false);
    let mut style: Option<String> = None;
    let mut list_depth = 0usize;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell = String::new();
    let run = |text: &str, bold: bool, italic: bool, code: bool| {
        let mut props = String::new();
        if bold {
            props.push_str("<w:b/>");
        }
        if italic {
            props.push_str("<w:i/>");
        }
        if code {
            props.push_str("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/>");
        }
        let props = if props.is_empty() { String::new() } else { format!("<w:rPr>{props}</w:rPr>") };
        format!("<w:r>{props}<w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(text))
    };
    let close_paragraph = |body: &mut String, runs: &mut String, style: &Option<String>, indent: usize| {
        if runs.is_empty() && style.is_none() {
            return;
        }
        let mut props = String::new();
        if let Some(s) = style {
            props.push_str(&format!("<w:pStyle w:val=\"{s}\"/>"));
        }
        if indent > 0 {
            props.push_str(&format!("<w:ind w:left=\"{}\"/>", 360 * indent));
        }
        let props = if props.is_empty() { String::new() } else { format!("<w:pPr>{props}</w:pPr>") };
        body.push_str(&format!("<w:p>{props}{runs}</w:p>"));
        runs.clear();
    };
    for event in Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH) {
        if let Some(rows) = table.as_mut() {
            match event {
                Event::End(TagEnd::Table) => {
                    let rows = table.take().unwrap_or_default();
                    let mut xml = String::from("<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");
                    for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
                        xml.push_str(&format!("<w:{side} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"A0A0A0\"/>"));
                    }
                    xml.push_str("</w:tblBorders></w:tblPr>");
                    for (i, row) in rows.iter().enumerate() {
                        xml.push_str("<w:tr>");
                        for c in row {
                            xml.push_str(&format!("<w:tc><w:p>{}</w:p></w:tc>", run(c, i == 0, false, false)));
                        }
                        xml.push_str("</w:tr>");
                    }
                    xml.push_str("</w:tbl>");
                    body.push_str(&xml);
                }
                Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => rows.push(Vec::new()),
                Event::End(TagEnd::TableCell) => {
                    if let Some(row) = rows.last_mut() {
                        row.push(std::mem::take(&mut cell).trim().to_string());
                    }
                }
                Event::Text(t) | Event::Code(t) => cell.push_str(&t),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                close_paragraph(&mut body, &mut runs, &style, 0);
                style = Some(format!("Heading{}", level as usize));
            }
            Event::End(TagEnd::Heading(_)) | Event::End(TagEnd::Paragraph) => {
                let indent = list_depth;
                close_paragraph(&mut body, &mut runs, &style, indent);
                style = None;
            }
            Event::Start(Tag::List(_)) => list_depth += 1,
            Event::End(TagEnd::List(_)) => list_depth = list_depth.saturating_sub(1),
            Event::Start(Tag::Item) => runs.push_str(&run("• ", false, false, false)),
            Event::End(TagEnd::Item) => close_paragraph(&mut body, &mut runs, &style, list_depth),
            Event::Start(Tag::Strong) => bold = true,
            Event::End(TagEnd::Strong) => bold = false,
            Event::Start(Tag::Emphasis) => italic = true,
            Event::End(TagEnd::Emphasis) => italic = false,
            Event::Start(Tag::CodeBlock(_)) => {
                close_paragraph(&mut body, &mut runs, &style, 0);
                code = true;
            }
            Event::End(TagEnd::CodeBlock) => code = false,
            Event::Start(Tag::Table(_)) => {
                close_paragraph(&mut body, &mut runs, &style, 0);
                table = Some(Vec::new());
            }
            Event::Text(t) => {
                if code {
                    for line in t.lines() {
                        body.push_str(&format!("<w:p>{}</w:p>", run(line, false, false, true)));
                    }
                } else {
                    runs.push_str(&run(&t, bold, italic, false));
                }
            }
            Event::Code(t) => runs.push_str(&run(&t, bold, italic, true)),
            Event::SoftBreak => runs.push_str(&run(" ", bold, italic, false)),
            Event::HardBreak => runs.push_str("<w:r><w:br/></w:r>"),
            _ => {}
        }
    }
    close_paragraph(&mut body, &mut runs, &style, 0);
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let heading = |n: usize, size: usize| {
        format!(r#"<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="{}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr></w:style>"#, n - 1)
    };
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>{}{}{}{}{}{}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>"#,
        heading(1, 36),
        heading(2, 30),
        heading(3, 26),
        heading(4, 24),
        heading(5, 22),
        heading(6, 22)
    );
    let mut entries = BTreeMap::new();
    entries.insert(
        "[Content_Types].xml".to_string(),
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#.to_vec(),
    );
    entries.insert(
        "_rels/.rels".to_string(),
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_vec(),
    );
    entries.insert(
        "word/_rels/document.xml.rels".to_string(),
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.to_vec(),
    );
    entries.insert("word/document.xml".to_string(), document.into_bytes());
    entries.insert("word/styles.xml".to_string(), styles.into_bytes());
    entries
}

async fn docx(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    per_item(ctx, |params, json| async move {
        // Unzipping, filling and zipping again is disk and CPU work: on a blocking thread, not on the
        // async workers every other node of every run is waiting on.
        tokio::task::spawn_blocking(move || docx_item(&params, &json)).await.map_err(|e| NodeError::failed(e.to_string()))?
    })
    .await
}

fn docx_item(params: &Value, json: &Value) -> Result<Vec<Value>, NodeError> {
    match text(params, "docxOp").as_str() {
        "docxFill" => {
            let source = need_path(params, "path", "template (.docx)")?;
            let output = need_path(params, "savePath", "file to write")?;
            if source == output {
                return Err(NodeError::failed("Write the filled document somewhere else than its template"));
            }
            let mut entries = read_zip(&source, None)?;
            let values: Map<String, Value> = if text(params, "fillFrom") == "fillPairs" {
                pairs(params, "docxValues").into_iter().map(|(k, v)| (k, Value::String(v))).collect()
            } else {
                json.as_object().cloned().unwrap_or_default()
            };
            let mut total = 0usize;
            for (name, bytes) in entries.iter_mut() {
                let part = name.starts_with("word/") && name.ends_with(".xml") && (name.contains("document") || name.contains("header") || name.contains("footer"));
                if !part {
                    continue;
                }
                let xml = String::from_utf8_lossy(bytes).into_owned();
                let (filled, count) = fill_xml(&xml, &values);
                total += count;
                *bytes = filled.into_bytes();
            }
            write_zip(&output, &entries)?;
            Ok(vec![json!({"path": output.to_string_lossy(), "file": crate::flows::nodes::binary::reference_of(&output), "replaced": total})])
        }
        "docxCreate" => {
            let output = need_path(params, "savePath", "file to write")?;
            write_zip(&output, &markdown_docx(&text(params, "markdown")))?;
            Ok(vec![json!({"path": output.to_string_lossy(), "file": crate::flows::nodes::binary::reference_of(&output)})])
        }
        _ => {
            let source = need_path(params, "path", "Word document")?;
            // The text is all a read needs: the images and the rest stay packed.
            let entries = read_zip(&source, Some("word/document.xml"))?;
            let xml = entries.get("word/document.xml").map(|b| String::from_utf8_lossy(b).into_owned()).ok_or_else(|| NodeError::failed("The document has no word/document.xml"))?;
            let blocks = read_blocks(&xml);
            let markdown = text(params, "docxReadAs") != "asText";
            let content = blocks_text(&blocks, markdown);
            Ok(vec![json!({"path": source.to_string_lossy(), "text": content, "paragraphs": blocks.len()})])
        }
    }
}

// ------------------------------------------------------------------------------------ markdown

/// Files that already are text: handed over as written.
const AS_WRITTEN: &[&str] = &["md", "markdown", "txt", "text"];

/// A document as Markdown, and what read it.
struct Converted {
    markdown: String,
    format: String,
    via: &'static str,
}

async fn to_markdown(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    // A link is downloaded into a folder of its own per item.
    let next = std::sync::atomic::AtomicUsize::new(0);
    per_item(ctx, |params, _| {
        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        async move {
            let written = text(&params, "path");
            if written.trim().is_empty() {
                return Err(NodeError::failed("Say which file to convert"));
            }
            let source = super::vision::local_file(ctx, written.trim(), index).await?;
            let read = convert(ctx, &params, &source).await?;
            let mut out = json!({
                "path": source.to_string_lossy(),
                "format": read.format,
                "via": read.via,
                "characters": read.markdown.chars().count(),
            });
            let asked = text(&params, "savePath");
            if !asked.trim().is_empty() {
                let target = super::expand_path(asked.trim());
                if target == source {
                    return Err(NodeError::failed("Write the Markdown somewhere else than the file it comes from"));
                }
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| NodeError::failed(format!("Could not create {}: {e}", dir.display())))?;
                }
                std::fs::write(&target, &read.markdown).map_err(|e| NodeError::failed(format!("Could not write {}: {e}", target.display())))?;
                out["savedTo"] = json!(target.to_string_lossy());
                out["file"] = crate::flows::nodes::binary::reference_of(&target);
            }
            out["markdown"] = json!(read.markdown);
            Ok(vec![out])
        }
    })
    .await
}

/// One file read into Markdown: text as written, a page by the «Página web» reader, an image by the
/// system's OCR, and every office document, e-book and PDF with text by anydoc — a PDF of scanned
/// pages falling back to the OCR when the node allows it.
async fn convert(ctx: &NodeCtx, params: &Value, source: &Path) -> Result<Converted, NodeError> {
    let extension = source.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let read_text = || std::fs::read(source).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", source.display())));
    if AS_WRITTEN.contains(&extension.as_str()) {
        return Ok(Converted { markdown: read_text()?, format: extension, via: "text" });
    }
    if matches!(extension.as_str(), "html" | "htm" | "xhtml") {
        let page = super::utils::page_markdown(&read_text()?, None);
        let markdown = page["markdown"].as_str().unwrap_or_default().to_string();
        return Ok(Converted { markdown, format: "html".into(), via: "page" });
    }
    let ocr = text(params, "scanned") != "scanFail";
    if super::vision::mime_of(source).is_some_and(|m| m.starts_with("image/")) {
        if !ocr {
            return Err(NodeError::failed(format!("{} is an image: let the node read it with the system's OCR, or describe it with «Visión»", source.display())));
        }
        let seen = super::vision::system_ocr(ctx, params, source).await?;
        return Ok(Converted { markdown: seen.text, format: extension, via: "ocr" });
    }
    let path = source.to_path_buf();
    let outcome = tokio::task::spawn_blocking(move || anydoc_markdown(&path)).await.map_err(|e| NodeError::failed(e.to_string()))?;
    match outcome {
        Ok((markdown, format)) => Ok(Converted { markdown, format, via: "anydoc" }),
        Err(anydoc::ConvertError::NeedsOcr { pages, page_count }) if ocr => {
            ctx.log(LogStream::Info, &format!("{} of {page_count} pages are scanned: reading the document with the system's OCR", pages.len()));
            let seen = super::vision::system_ocr(ctx, params, source).await?;
            Ok(Converted { markdown: seen.text, format: "pdf".into(), via: "ocr" })
        }
        Err(error) => Err(NodeError::failed(convert_error(source, &error))),
    }
}

/// anydoc's reading: the format from the bytes (the extension for CSV, which has no signature).
fn anydoc_markdown(path: &Path) -> Result<(String, String), anydoc::ConvertError> {
    let bytes = std::fs::read(path)?;
    let Some(format) = anydoc::Format::from_bytes(&bytes).or_else(|| anydoc::Format::from_path(path)) else {
        return Err(anydoc::ConvertError::Unsupported(String::new()));
    };
    Ok((anydoc::to_markdown_bytes(&bytes, format)?, format!("{format:?}").to_ascii_lowercase()))
}

fn convert_error(source: &Path, error: &anydoc::ConvertError) -> String {
    let name = source.display();
    match error {
        anydoc::ConvertError::Unsupported(_) => format!(
            "{name} is not a format this node converts (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF, HTML, text or an image)"
        ),
        anydoc::ConvertError::Encrypted => format!("{name} is password-protected"),
        anydoc::ConvertError::NeedsOcr { pages, page_count } => {
            let listed = pages.iter().map(u32::to_string).collect::<Vec<_>>().join(", ");
            format!("{name}: pages {listed} of {page_count} are scanned — let the node read them with the system's OCR, or use «Visión»")
        }
        other => format!("{name}: {other}"),
    }
}

// ----------------------------------------------------------------------------------------- ics

/// The lines of an iCalendar, unfolded (a line starting with a space or a tab continues the last).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().expect("non-empty").push_str(&line[1..]);
        } else {
            out.push(line.to_string());
        }
    }
    out
}

fn ics_unescape(text: &str) -> String {
    text.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
}

/// An address as it goes after `mailto:` — without anything that would end the line and start another property (an attendee
/// written as `x@y.z\r\nATTACH:…` is one the invitation would otherwise carry), nor the characters a parameter value is
/// quoted by.
fn ics_address(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control() && !c.is_whitespace() && !matches!(c, '"' | ';' | ':' | '<' | '>' | ',')).collect()
}

fn ics_escape(text: &str) -> String {
    // A carriage return would end the line for some readers: the text's line breaks are the `\n` escape, only.
    text.replace('\r', "").replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace('\n', "\\n")
}

/// A property line: its name, parameters and value — `DTSTART;TZID=America/Santiago:20261001T090000`.
fn property(line: &str) -> Option<(String, BTreeMap<String, String>, String)> {
    let (head, value) = line.split_once(':')?;
    let mut parts = head.split(';');
    let name = parts.next()?.to_uppercase();
    let params = parts.filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_uppercase(), v.trim_matches('"').to_string()))).collect();
    Some((name, params, value.to_string()))
}

/// The zone a value's clock runs in: its TZID, UTC for a `…Z` time, and `fallback` — the reader's
/// own — for a floating time or a TZID this build does not know (Outlook's "Pacific Standard Time").
fn value_zone(value: &str, params: &BTreeMap<String, String>, fallback: chrono_tz::Tz) -> chrono_tz::Tz {
    match params.get("TZID").and_then(|z| z.parse::<chrono_tz::Tz>().ok()) {
        Some(zone) => zone,
        None if value.trim().ends_with('Z') => chrono_tz::UTC,
        None => fallback,
    }
}

/// A wall-clock time in `zone` as an instant. In the hour a spring-forward skips, RFC 5545 reads it
/// with the offset from before the jump — 02:30 on the night clocks go from 02:00 to 03:00 is 03:30 —
/// where `earliest()` had nothing to give and the event went missing (Chile moves its clocks at
/// midnight, so that was a whole day's all-day events); in the hour a fall-back repeats, the first.
fn local_instant(zone: chrono_tz::Tz, naive: NaiveDateTime) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::Offset as _;
    match zone.from_local_datetime(&naive) {
        chrono::LocalResult::Single(at) | chrono::LocalResult::Ambiguous(at, _) => Some(at.with_timezone(&chrono::Utc)),
        chrono::LocalResult::None => {
            let before = zone.from_local_datetime(&naive.checked_sub_signed(chrono::Duration::hours(3))?).earliest()?;
            let offset = chrono::Duration::seconds(i64::from(before.offset().fix().local_minus_utc()));
            Some(chrono::Utc.from_utc_datetime(&naive.checked_sub_signed(offset)?))
        }
    }
}

/// A DTSTART/DTEND value as an instant (and whether it is a whole day).
fn ics_time(value: &str, params: &BTreeMap<String, String>, fallback: chrono_tz::Tz) -> Option<(chrono::DateTime<chrono::Utc>, bool)> {
    let v = value.trim();
    if params.get("VALUE").map(String::as_str) == Some("DATE") || (v.len() == 8 && v.chars().all(|c| c.is_ascii_digit())) {
        let date = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return local_instant(value_zone(v, params, fallback), date.and_hms_opt(0, 0, 0)?).map(|at| (at, true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((chrono::Utc.from_utc_datetime(&naive), false));
    }
    let naive = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    local_instant(value_zone(v, params, fallback), naive).map(|at| (at, false))
}

/// How often a rule repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freq {
    Minutely,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// An RRULE read: RFC 5545's parts but BYSECOND and SECONDLY (a calendar's events do not repeat by the second).
#[derive(Debug, Clone)]
struct Recurrence {
    freq: Freq,
    interval: i64,
    count: Option<usize>,
    until: Option<chrono::DateTime<chrono::Utc>>,
    by_month: Vec<u32>,
    by_month_day: Vec<i32>,
    by_year_day: Vec<i32>,
    by_week_no: Vec<i32>,
    /// `(n, day)`: every such day of the period with `n` 0, its n-th from the start (or the end, negative) otherwise.
    by_day: Vec<(i32, chrono::Weekday)>,
    by_hour: Vec<u32>,
    by_minute: Vec<u32>,
    by_set_pos: Vec<i32>,
    week_start: chrono::Weekday,
}

fn weekday_code(code: &str) -> Option<chrono::Weekday> {
    Some(match code.trim().to_ascii_uppercase().as_str() {
        "MO" => chrono::Weekday::Mon,
        "TU" => chrono::Weekday::Tue,
        "WE" => chrono::Weekday::Wed,
        "TH" => chrono::Weekday::Thu,
        "FR" => chrono::Weekday::Fri,
        "SA" => chrono::Weekday::Sat,
        "SU" => chrono::Weekday::Sun,
        _ => return None,
    })
}

/// A comma list of whole numbers within `range` (signs allowed where the range has them), the rest left out.
fn numbers(value: Option<&String>, range: std::ops::RangeInclusive<i32>) -> Vec<i32> {
    value
        .map(|v| v.split(',').filter_map(|n| n.trim().parse::<i32>().ok()).filter(|n| *n != 0 && range.contains(n)).collect())
        .unwrap_or_default()
}

impl Recurrence {
    fn parse(rule: &str, zone: chrono_tz::Tz) -> Recurrence {
        let parts: BTreeMap<String, String> = rule.split(';').filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim().to_uppercase(), v.trim().to_string()))).collect();
        let freq = match parts.get("FREQ").map(|f| f.to_uppercase()).as_deref() {
            Some("MINUTELY") => Freq::Minutely,
            Some("HOURLY") => Freq::Hourly,
            Some("WEEKLY") => Freq::Weekly,
            Some("MONTHLY") => Freq::Monthly,
            Some("YEARLY") => Freq::Yearly,
            _ => Freq::Daily,
        };
        // All digits but too big for a number is still "not again for a very long time", never "every time".
        let interval: i64 = match parts.get("INTERVAL").map(|v| v.trim()) {
            Some(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => v.parse::<i64>().unwrap_or(i64::MAX).max(1),
            _ => 1,
        };
        let by_day = parts
            .get("BYDAY")
            .map(|v| {
                v.split(',')
                    .filter_map(|entry| {
                        let entry = entry.trim();
                        let split = entry.len().checked_sub(2)?;
                        let (ordinal, code) = entry.split_at(split);
                        let n = if ordinal.is_empty() { 0 } else { ordinal.trim_start_matches('+').parse::<i32>().ok()? };
                        Some((n, weekday_code(code)?))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Recurrence {
            freq,
            interval,
            count: parts.get("COUNT").and_then(|v| v.parse().ok()),
            until: parts.get("UNTIL").and_then(|v| ics_time(v, &BTreeMap::new(), zone)).map(|t| t.0),
            by_month: numbers(parts.get("BYMONTH"), 1..=12).into_iter().map(|m| m as u32).collect(),
            by_month_day: numbers(parts.get("BYMONTHDAY"), -31..=31),
            by_year_day: numbers(parts.get("BYYEARDAY"), -366..=366),
            by_week_no: numbers(parts.get("BYWEEKNO"), -53..=53),
            by_day,
            // An hour or a minute can be 0: read without the "not zero" rule of the day numbers.
            by_hour: parts.get("BYHOUR").map(|v| v.split(',').filter_map(|n| n.trim().parse::<u32>().ok()).filter(|n| *n < 24).collect()).unwrap_or_default(),
            by_minute: parts.get("BYMINUTE").map(|v| v.split(',').filter_map(|n| n.trim().parse::<u32>().ok()).filter(|n| *n < 60).collect()).unwrap_or_default(),
            by_set_pos: numbers(parts.get("BYSETPOS"), -366..=366),
            week_start: parts.get("WKST").and_then(|w| weekday_code(w)).unwrap_or(chrono::Weekday::Mon),
        }
    }

    fn month_ok(&self, date: NaiveDate) -> bool {
        self.by_month.is_empty() || self.by_month.contains(&date.month())
    }

    fn month_day_ok(&self, date: NaiveDate) -> bool {
        let length = days_in_month(date.year(), date.month()) as i32;
        let day = date.day() as i32;
        self.by_month_day.is_empty() || self.by_month_day.iter().any(|n| *n == day || *n == day - length - 1)
    }

    fn weekday_ok(&self, date: NaiveDate) -> bool {
        self.by_day.is_empty() || self.by_day.iter().any(|(_, day)| *day == date.weekday())
    }

    /// The dates of a period that the BY parts keep (or add), before the times of day.
    fn dates(&self, period: Period, first: NaiveDate) -> Vec<NaiveDate> {
        let mut dates: Vec<NaiveDate> = match period {
            Period::Year(year) => {
                let months: Vec<u32> = if self.by_month.is_empty() { (1..=12).collect() } else { self.by_month.clone() };
                if !self.by_year_day.is_empty() {
                    let length = if NaiveDate::from_ymd_opt(year, 12, 31).is_some_and(|d| d.ordinal() == 366) { 366 } else { 365 };
                    self.by_year_day
                        .iter()
                        .filter_map(|n| {
                            let ordinal = if *n > 0 { *n } else { length + n + 1 };
                            NaiveDate::from_yo_opt(year, u32::try_from(ordinal).ok()?)
                        })
                        .filter(|d| self.month_ok(*d) && self.month_day_ok(*d) && self.weekday_ok(*d))
                        .collect()
                } else if !self.by_week_no.is_empty() {
                    week_dates(year, &self.by_week_no, self.week_start)
                        .into_iter()
                        .filter(|d| self.month_ok(*d))
                        .filter(|d| if self.by_day.is_empty() { d.weekday() == first.weekday() } else { self.weekday_ok(*d) })
                        .collect()
                } else if !self.by_month_day.is_empty() {
                    months.iter().flat_map(|month| month_days(year, *month, &self.by_month_day)).filter(|d| self.weekday_ok(*d)).collect()
                } else if !self.by_day.is_empty() {
                    if self.by_month.is_empty() {
                        nth_days(&period_dates(year, None), &self.by_day)
                    } else {
                        months.iter().flat_map(|month| nth_days(&period_dates(year, Some(*month)), &self.by_day)).collect()
                    }
                } else if !self.by_month.is_empty() {
                    months.iter().filter_map(|month| NaiveDate::from_ymd_opt(year, *month, first.day())).collect()
                } else {
                    NaiveDate::from_ymd_opt(year, first.month(), first.day()).into_iter().collect()
                }
            }
            Period::Month(year, month) => {
                if !self.by_month.is_empty() && !self.by_month.contains(&month) {
                    Vec::new()
                } else if !self.by_month_day.is_empty() {
                    month_days(year, month, &self.by_month_day).into_iter().filter(|d| self.weekday_ok(*d)).collect()
                } else if !self.by_day.is_empty() {
                    nth_days(&period_dates(year, Some(month)), &self.by_day)
                } else {
                    // The 31st of a month with 30 days is no occurrence (RFC 5545 skips it), not the end of the series.
                    NaiveDate::from_ymd_opt(year, month, first.day()).into_iter().collect()
                }
            }
            Period::Week(start) => {
                let days: Vec<chrono::Weekday> = if self.by_day.is_empty() { vec![first.weekday()] } else { self.by_day.iter().map(|(_, day)| *day).collect() };
                days.iter()
                    .filter_map(|day| start.checked_add_signed(chrono::Duration::days(days_from(self.week_start, *day))))
                    .filter(|d| self.month_ok(*d))
                    .collect()
            }
            Period::Day(date) => {
                if self.month_ok(date) && self.month_day_ok(date) && self.weekday_ok(date) {
                    vec![date]
                } else {
                    Vec::new()
                }
            }
        };
        dates.sort();
        dates.dedup();
        dates
    }

    /// The times of day a date of a daily or coarser period gets: BYHOUR × BYMINUTE, else the first occurrence's own.
    fn times(&self, first: chrono::NaiveTime) -> Vec<chrono::NaiveTime> {
        let hours = if self.by_hour.is_empty() { vec![first.hour()] } else { self.by_hour.clone() };
        let minutes = if self.by_minute.is_empty() { vec![first.minute()] } else { self.by_minute.clone() };
        let mut out: Vec<chrono::NaiveTime> = hours.iter().flat_map(|h| minutes.iter().filter_map(move |m| chrono::NaiveTime::from_hms_opt(*h, *m, first.second()))).collect();
        out.sort();
        out.dedup();
        out
    }

    /// The occurrences of one period (the `step`-th since the first), in order, BYSETPOS applied; `None` past the calendar.
    fn period(&self, first: NaiveDateTime, step: i64) -> Option<Vec<NaiveDateTime>> {
        let offset = step.checked_mul(self.interval)?;
        let mut found: Vec<NaiveDateTime> = match self.freq {
            Freq::Yearly => {
                let year = i32::try_from(offset).ok().and_then(|years| first.year().checked_add(years))?;
                NaiveDate::from_ymd_opt(year, 1, 1)?;
                self.at_times(self.dates(Period::Year(year), first.date()), first.time())
            }
            Freq::Monthly => {
                let months = i64::from(first.month0()).checked_add(offset)?;
                let year = i32::try_from(months / 12).ok().and_then(|years| first.year().checked_add(years))?;
                // Past the calendar's last year no month of the series is left.
                NaiveDate::from_ymd_opt(year, 1, 1)?;
                self.at_times(self.dates(Period::Month(year, (months % 12) as u32 + 1), first.date()), first.time())
            }
            Freq::Weekly => {
                let start = first.date().checked_sub_signed(chrono::Duration::days(days_from(self.week_start, first.weekday())))?;
                let start = chrono::Duration::try_weeks(offset).and_then(|weeks| start.checked_add_signed(weeks))?;
                self.at_times(self.dates(Period::Week(start), first.date()), first.time())
            }
            Freq::Daily => {
                let date = chrono::Duration::try_days(offset).and_then(|days| first.date().checked_add_signed(days))?;
                self.at_times(self.dates(Period::Day(date), first.date()), first.time())
            }
            Freq::Hourly | Freq::Minutely => {
                let step = if self.freq == Freq::Hourly { chrono::Duration::try_hours(offset)? } else { chrono::Duration::try_minutes(offset)? };
                let base = first.checked_add_signed(step)?;
                let instants: Vec<NaiveDateTime> = if self.freq == Freq::Hourly && !self.by_minute.is_empty() {
                    self.by_minute.iter().filter_map(|m| base.with_minute(*m)).collect()
                } else {
                    vec![base]
                };
                instants
                    .into_iter()
                    .filter(|at| self.dates(Period::Day(at.date()), first.date()).contains(&at.date()))
                    .filter(|at| self.by_hour.is_empty() || self.by_hour.contains(&at.hour()))
                    .filter(|at| self.freq == Freq::Hourly || self.by_minute.is_empty() || self.by_minute.contains(&at.minute()))
                    .collect()
            }
        };
        found.sort();
        found.dedup();
        if !self.by_set_pos.is_empty() {
            let length = found.len() as i32;
            let mut picked: Vec<NaiveDateTime> = self
                .by_set_pos
                .iter()
                .filter_map(|n| {
                    let index = if *n > 0 { n - 1 } else { length + n };
                    usize::try_from(index).ok().and_then(|i| found.get(i).copied())
                })
                .collect();
            picked.sort();
            picked.dedup();
            found = picked;
        }
        Some(found)
    }

    fn at_times(&self, dates: Vec<NaiveDate>, first: chrono::NaiveTime) -> Vec<NaiveDateTime> {
        let times = self.times(first);
        dates.iter().flat_map(|date| times.iter().map(move |time| date.and_time(*time))).collect()
    }

    /// The length of one period, for skipping the ones wholly before what is asked for (a daily meeting since 2015).
    fn period_length(&self) -> Option<chrono::Duration> {
        match self.freq {
            Freq::Minutely => chrono::Duration::try_minutes(self.interval),
            Freq::Hourly => chrono::Duration::try_hours(self.interval),
            Freq::Daily => chrono::Duration::try_days(self.interval),
            Freq::Weekly => chrono::Duration::try_weeks(self.interval),
            Freq::Monthly | Freq::Yearly => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Period {
    Year(i32),
    Month(i32, u32),
    /// The week that starts on this date (on WKST).
    Week(NaiveDate),
    Day(NaiveDate),
}

/// Days from `start` forward to `day` within a week (0–6).
fn days_from(start: chrono::Weekday, day: chrono::Weekday) -> i64 {
    (i64::from(day.num_days_from_monday()) - i64::from(start.num_days_from_monday())).rem_euclid(7)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(next_year, next_month, 1).and_then(|d| d.pred_opt()).map_or(31, |d| d.day())
}

/// Every date of a month, or of the whole year.
fn period_dates(year: i32, month: Option<u32>) -> Vec<NaiveDate> {
    let (from, to) = match month {
        Some(month) => (NaiveDate::from_ymd_opt(year, month, 1), NaiveDate::from_ymd_opt(year, month, days_in_month(year, month))),
        None => (NaiveDate::from_ymd_opt(year, 1, 1), NaiveDate::from_ymd_opt(year, 12, 31)),
    };
    let (Some(from), Some(to)) = (from, to) else { return Vec::new() };
    from.iter_days().take_while(|d| *d <= to).collect()
}

/// The month's days a BYMONTHDAY list names — `-1` its last.
fn month_days(year: i32, month: u32, days: &[i32]) -> Vec<NaiveDate> {
    let length = days_in_month(year, month) as i32;
    days.iter()
        .filter_map(|n| {
            let day = if *n > 0 { *n } else { length + n + 1 };
            (1..=length).contains(&day).then(|| NaiveDate::from_ymd_opt(year, month, day as u32)).flatten()
        })
        .collect()
}

/// The days of `dates` a BYDAY list names: every such weekday, or its n-th (from the end when negative).
fn nth_days(dates: &[NaiveDate], by_day: &[(i32, chrono::Weekday)]) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    for (n, day) in by_day {
        let matching: Vec<NaiveDate> = dates.iter().filter(|d| d.weekday() == *day).copied().collect();
        match *n {
            0 => out.extend(matching),
            n if n > 0 => out.extend(matching.get(n as usize - 1).copied()),
            n => out.extend(usize::try_from(matching.len() as i32 + n).ok().and_then(|i| matching.get(i)).copied()),
        }
    }
    out
}

/// The dates of the year's weeks a BYWEEKNO list names. Week 1 is the first with at least four of its days in the year,
/// weeks starting on `week_start`; only days of the year itself are kept.
fn week_dates(year: i32, weeks: &[i32], week_start: chrono::Weekday) -> Vec<NaiveDate> {
    let first_week = |year: i32| -> Option<NaiveDate> {
        let jan1 = NaiveDate::from_ymd_opt(year, 1, 1)?;
        let back = days_from(week_start, jan1.weekday());
        let start = jan1.checked_sub_signed(chrono::Duration::days(back))?;
        // That week has 7 - back days in the year: week 1 when four or more.
        if 7 - back >= 4 { Some(start) } else { start.checked_add_signed(chrono::Duration::days(7)) }
    };
    let (Some(this), Some(next)) = (first_week(year), first_week(year + 1)) else { return Vec::new() };
    let count = ((next - this).num_days() / 7) as i32;
    let mut out = Vec::new();
    for n in weeks {
        let number = if *n > 0 { *n } else { count + n + 1 };
        if !(1..=count).contains(&number) {
            continue;
        }
        let Some(start) = this.checked_add_signed(chrono::Duration::days(i64::from(number - 1) * 7)) else { continue };
        out.extend(start.iter_days().take(7).filter(|d| d.year() == year));
    }
    out
}

/// The starts an RRULE gives from `first`, inside `[from, to]`, at most a thousand. `first` (DTSTART) is always the first
/// occurrence (RFC 5545 counts it whether or not the rule would have made it).
///
/// Stepped on the wall clock of `zone`, the event's own: a meeting at 09:00 stays at 09:00 on both sides of a DST change,
/// where adding days of absolute time moved it to 08:00 or 10:00. Every step is checked arithmetic, so an INTERVAL past
/// any calendar ends the series instead of overflowing.
fn expand(first: chrono::DateTime<chrono::Utc>, rule: &str, from: chrono::DateTime<chrono::Utc>, to: chrono::DateTime<chrono::Utc>, zone: chrono_tz::Tz) -> Vec<chrono::DateTime<chrono::Utc>> {
    let recurrence = Recurrence::parse(rule, zone);
    let local_first = first.with_timezone(&zone).naive_local();
    let mut out = Vec::new();
    let mut produced = 0usize;
    let mut keep = |at: chrono::DateTime<chrono::Utc>, out: &mut Vec<chrono::DateTime<chrono::Utc>>| -> bool {
        if recurrence.until.is_some_and(|u| at > u) || at > to {
            return false;
        }
        produced += 1;
        if recurrence.count.is_some_and(|c| produced > c) {
            return false;
        }
        if at >= from {
            out.push(at);
        }
        out.len() < 1000
    };
    if !keep(first, &mut out) {
        return out;
    }
    // Without a COUNT, the periods wholly before `from` need no looking at: a daily meeting since 2015 starts where asked.
    let mut step: i64 = 0;
    if recurrence.count.is_none() {
        if let Some(length) = recurrence.period_length() {
            let behind = (from - first).num_seconds();
            let each = length.num_seconds().max(1);
            if behind > each {
                step = (behind / each - 1).max(0);
            }
        }
    }
    let mut periods = 0;
    while periods < 50_000 {
        periods += 1;
        let Some(found) = recurrence.period(local_first, step) else { break };
        step += 1;
        for candidate in found {
            if candidate <= local_first {
                continue;
            }
            let Some(at) = local_instant(zone, candidate) else { continue };
            if at <= first {
                continue;
            }
            if !keep(at, &mut out) {
                return out;
            }
        }
        // A period that starts after `to` and the UNTIL ends the search, however sparse the rule.
        let reached = match recurrence.freq {
            Freq::Yearly => local_first.year().checked_add(i32::try_from(step.saturating_mul(recurrence.interval)).unwrap_or(i32::MAX)).is_none_or(|year| year > to.with_timezone(&zone).year() + 1),
            _ => {
                // A month is never shorter than 28 days: an estimate that can only fall short never ends the search early.
                let length = recurrence.period_length().unwrap_or_else(|| chrono::Duration::days(28));
                let ahead = length.num_seconds().checked_mul(step).and_then(chrono::Duration::try_seconds);
                ahead.and_then(|ahead| local_first.checked_add_signed(ahead)).and_then(|at| local_instant(zone, at)).is_none_or(|at| at > to + chrono::Duration::days(1))
            }
        };
        if reached {
            break;
        }
    }
    out
}

type Props = Vec<(String, BTreeMap<String, String>, String)>;

pub fn parse_ics(text: &str, from: chrono::DateTime<chrono::Utc>, to: chrono::DateTime<chrono::Utc>, zone: chrono_tz::Tz) -> Vec<Value> {
    let mut all: Vec<Props> = Vec::new();
    let mut current: Option<Props> = None;
    for line in unfold(text) {
        match line.trim() {
            "BEGIN:VEVENT" => current = Some(Vec::new()),
            "END:VEVENT" => all.extend(current.take()),
            _ => {
                if let (Some(props), Some(prop)) = (current.as_mut(), property(&line)) {
                    props.push(prop);
                }
            }
        }
    }
    let get = |props: &'_ Props, name: &str| props.iter().find(|p| p.0 == name).cloned();
    let instants = |props: &Props, name: &str| -> Vec<chrono::DateTime<chrono::Utc>> {
        props
            .iter()
            .filter(|p| p.0 == name && p.1.get("VALUE").map(String::as_str) != Some("PERIOD"))
            .flat_map(|p| p.2.split(',').filter_map(|v| ics_time(v, &p.1, zone).map(|t| t.0)).collect::<Vec<_>>())
            .collect()
    };
    // One occurrence of a series moved or changed on its own (RECURRENCE-ID): it replaces the one the rule made at that
    // moment, and a cancelled one leaves nothing.
    let uid_of = |props: &Props| get(props, "UID").map(|p| p.2).unwrap_or_default();
    let replaced: Vec<(String, chrono::DateTime<chrono::Utc>)> = all
        .iter()
        .filter_map(|props| {
            let id = get(props, "RECURRENCE-ID")?;
            Some((uid_of(props), ics_time(&id.2, &id.1, zone)?.0))
        })
        .collect();
    let mut events = Vec::new();
    for props in &all {
        let Some((start, all_day)) = get(props, "DTSTART").and_then(|p| ics_time(&p.2, &p.1, zone)) else { continue };
        let override_of = get(props, "RECURRENCE-ID").is_some();
        if override_of && get(props, "STATUS").is_some_and(|p| p.2.trim().eq_ignore_ascii_case("CANCELLED")) {
            continue;
        }
        // The event's own clock: its repetitions keep its wall-clock time, and its days are dates there.
        let event_zone = get(props, "DTSTART").map(|p| value_zone(&p.2, &p.1, zone)).unwrap_or(zone);
        let end = get(props, "DTEND").and_then(|p| ics_time(&p.2, &p.1, zone)).map(|t| t.0);
        let length = end.map(|e| e - start).unwrap_or_else(|| if all_day { chrono::Duration::days(1) } else { chrono::Duration::zero() });
        // A whole-day event lasts whole days, however many hours the days it falls on have.
        let days = end.map(|e| (e.with_timezone(&event_zone).date_naive() - start.with_timezone(&event_zone).date_naive()).num_days()).unwrap_or(1).max(0);
        let excluded = instants(props, "EXDATE");
        let uid = uid_of(props);
        let mut starts = match get(props, "RRULE") {
            Some(rule) if !override_of => expand(start, &rule.2, from, to, event_zone),
            _ => {
                let finishes = start + length;
                if finishes >= from && start <= to { vec![start] } else { vec![] }
            }
        };
        // RDATE: occurrences the rule does not make, added by hand.
        if !override_of {
            starts.extend(instants(props, "RDATE").into_iter().filter(|at| *at + length >= from && *at <= to));
            starts.sort();
            starts.dedup();
        }
        let recurring = override_of || get(props, "RRULE").is_some() || get(props, "RDATE").is_some();
        for at in starts.into_iter().filter(|s| !excluded.contains(s)) {
            if !override_of && replaced.iter().any(|(id, moment)| *id == uid && *moment == at) {
                continue;
            }
            let day = at.with_timezone(&event_zone).date_naive();
            events.push(json!({
                "uid": get(props, "UID").map(|p| p.2),
                "summary": get(props, "SUMMARY").map(|p| ics_unescape(&p.2)),
                "description": get(props, "DESCRIPTION").map(|p| ics_unescape(&p.2)),
                "location": get(props, "LOCATION").map(|p| ics_unescape(&p.2)),
                "start": if all_day { day.to_string() } else { at.to_rfc3339() },
                "end": if all_day { day.checked_add_days(chrono::Days::new(days as u64)).unwrap_or(day).to_string() } else { (at + length).to_rfc3339() },
                "allDay": all_day,
                "recurring": recurring,
                "status": get(props, "STATUS").map(|p| p.2),
                "url": get(props, "URL").map(|p| p.2),
                "organizer": get(props, "ORGANIZER").map(|p| p.2.trim_start_matches("mailto:").to_string()),
            }));
        }
    }
    events.sort_by(|a, b| a["start"].as_str().unwrap_or("").cmp(b["start"].as_str().unwrap_or("")));
    events
}

/// One line of iCalendar, folded at 75 octets the way RFC 5545 asks.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut length = 0;
    for c in line.chars() {
        let size = c.len_utf8();
        if length + size > 75 {
            out.push_str("\r\n ");
            length = 1;
        }
        out.push(c);
        length += size;
    }
    out.push_str("\r\n");
    out
}

fn parse_when(text: &str, zone: chrono_tz::Tz) -> Option<(chrono::DateTime<chrono::Utc>, bool)> {
    let t = text.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some((d.with_timezone(&chrono::Utc), false));
    }
    for format in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(t, format) {
            return zone.from_local_datetime(&naive).earliest().map(|d| (d.with_timezone(&chrono::Utc), false));
        }
    }
    for format in ["%Y-%m-%d", "%d/%m/%Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(t, format) {
            return zone.from_local_datetime(&date.and_hms_opt(0, 0, 0)?).earliest().map(|d| (d.with_timezone(&chrono::Utc), true));
        }
    }
    None
}

pub fn build_invite(params: &Value, zone: chrono_tz::Tz) -> Result<String, String> {
    let title = text(params, "eventTitle");
    let (start, date_only) = parse_when(&text(params, "startTime"), zone).ok_or("Write when it starts (2026-10-05 09:30)")?;
    let all_day = flag(params, "allDay") || date_only;
    let end = parse_when(&text(params, "endTime"), zone).map(|t| t.0).unwrap_or_else(|| start + if all_day { chrono::Duration::days(1) } else { chrono::Duration::hours(1) });
    let stamp = |t: chrono::DateTime<chrono::Utc>| t.format("%Y%m%dT%H%M%SZ").to_string();
    let date = |t: chrono::DateTime<chrono::Utc>| t.with_timezone(&zone).format("%Y%m%d").to_string();
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        "PRODID:-//CodeFlow//Flujos//ES".into(),
        "CALSCALE:GREGORIAN".into(),
        "METHOD:REQUEST".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}@codeflow", uuid::Uuid::new_v4()),
        format!("DTSTAMP:{}", stamp(chrono::Utc::now())),
    ];
    if all_day {
        lines.push(format!("DTSTART;VALUE=DATE:{}", date(start)));
        lines.push(format!("DTEND;VALUE=DATE:{}", date(end)));
    } else {
        lines.push(format!("DTSTART:{}", stamp(start)));
        lines.push(format!("DTEND:{}", stamp(end)));
    }
    lines.push(format!("SUMMARY:{}", ics_escape(&title)));
    let description = text(params, "description");
    if !description.trim().is_empty() {
        lines.push(format!("DESCRIPTION:{}", ics_escape(&description)));
    }
    let location = text(params, "eventLocation");
    if !location.trim().is_empty() {
        lines.push(format!("LOCATION:{}", ics_escape(&location)));
    }
    let organizer = text(params, "organizer");
    if !organizer.trim().is_empty() {
        lines.push(format!("ORGANIZER:mailto:{}", ics_address(&organizer)));
    }
    for attendee in strings(params, "attendees") {
        lines.push(format!("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{}", ics_address(&attendee)));
    }
    lines.push("STATUS:CONFIRMED".into());
    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    Ok(lines.iter().map(|l| fold(l)).collect())
}

async fn ics(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let zone: chrono_tz::Tz = ctx
        .run
        .timezone
        .as_deref()
        .and_then(|z| z.parse().ok())
        .or_else(|| iana_time_zone::get_timezone().ok().and_then(|z| z.parse().ok()))
        .unwrap_or(chrono_tz::UTC);
    per_item(ctx, |params, _| async move {
        if text(&params, "icsOp") == "icsCreate" {
            let ics = build_invite(&params, zone).map_err(NodeError::Failed)?;
            let save = text(&params, "savePath");
            let mut out = json!({"ics": ics});
            if !save.trim().is_empty() {
                let path = super::expand_path(save.trim());
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(e.to_string()))?;
                }
                std::fs::write(&path, out["ics"].as_str().unwrap_or_default()).map_err(|e| NodeError::failed(format!("{}: {e}", path.display())))?;
                out["path"] = json!(path.to_string_lossy());
                out["file"] = crate::flows::nodes::binary::reference_of(&path);
            }
            return Ok(vec![out]);
        }
        let source = text(&params, "icsSource");
        if source.trim().is_empty() {
            return Err(NodeError::failed("Write the calendar's address or file"));
        }
        let content = if source.trim().starts_with("http") || source.trim().starts_with("webcal") {
            let url = source.trim().replacen("webcal://", "https://", 1);
            let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| NodeError::failed(e.to_string()))?;
            let response = tokio::select! {
                r = client.get(&url).send() => r.map_err(|e| NodeError::failed(e.to_string()))?,
                _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            };
            if !response.status().is_success() {
                return Err(NodeError::failed(format!("The calendar answered {}", response.status())));
            }
            response.text().await.map_err(|e| NodeError::failed(e.to_string()))?
        } else {
            std::fs::read_to_string(super::expand_path(source.trim())).map_err(|e| NodeError::failed(e.to_string()))?
        };
        let from = parse_when(&text(&params, "rangeStart"), zone).map(|t| t.0).unwrap_or_else(|| chrono::Utc::now() - chrono::Duration::hours(1));
        let to = parse_when(&text(&params, "rangeEnd"), zone).map(|t| t.0).unwrap_or_else(|| from + chrono::Duration::days(30));
        Ok(parse_ics(&content, from, to, zone))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_cannot_start_another_line_of_the_invitation() {
        assert_eq!(ics_address("ana@example.com\r\nATTACH:http://x.example/"), "ana@example.comATTACHhttp//x.example/");
        assert!(!ics_address(" ana@example.com ;ROLE=CHAIR").contains(';'));
        assert_eq!(ics_escape("a\r\nb"), "a\\nb");
    }

    #[test]
    fn placeholders_fill_across_runs() {
        let xml = r#"<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hola {{</w:t></w:r><w:r><w:t>nombre}}</w:t></w:r><w:r><w:t>, total {{ total }}</w:t></w:r></w:p><w:p><w:r><w:t>sin cambios</w:t></w:r></w:p></w:body>"#;
        let mut values = Map::new();
        values.insert("nombre".into(), json!("Ana & Co"));
        values.insert("total".into(), json!(1200));
        let (filled, count) = fill_xml(xml, &values);
        assert_eq!(count, 2);
        assert!(filled.contains("<w:t xml:space=\"preserve\">Hola Ana &amp; Co, total 1200</w:t>"), "{filled}");
        assert!(filled.contains("<w:t>sin cambios</w:t>"));
    }

    #[test]
    fn markdown_makes_a_document_that_reads_back() {
        let entries = markdown_docx("# Informe\n\nTexto **fuerte**.\n\n- uno\n- dos\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        let xml = String::from_utf8(entries["word/document.xml"].clone()).unwrap();
        let blocks = read_blocks(&xml);
        let md = blocks_text(&blocks, true);
        assert!(md.starts_with("# Informe"), "{md}");
        assert!(md.contains("Texto fuerte."), "{md}");
        assert!(md.contains("| a | b |"), "{md}");
        assert!(entries.contains_key("[Content_Types].xml"));
    }

    #[test]
    fn anydoc_reads_a_document_by_its_bytes_and_a_csv_by_its_name() {
        let dir = std::env::temp_dir().join(format!("cf-anydoc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Named .bin: the format comes from the content, not the extension.
        let docx = dir.join("informe.bin");
        write_zip(&docx, &markdown_docx("# Informe\n\nTexto **fuerte**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")).unwrap();
        let (md, format) = anydoc_markdown(&docx).unwrap();
        assert_eq!(format, "docx");
        assert!(md.contains("Informe") && md.contains("**fuerte**") && md.contains("| 1"), "{md}");

        let csv = dir.join("datos.csv");
        std::fs::write(&csv, "nombre,total\nAna,3\n").unwrap();
        let (md, format) = anydoc_markdown(&csv).unwrap();
        assert_eq!(format, "csv");
        assert!(md.contains("| nombre") && md.contains("Ana"), "{md}");

        let unknown = dir.join("x.bin");
        std::fs::write(&unknown, b"no es un documento").unwrap();
        let error = anydoc_markdown(&unknown).unwrap_err();
        assert!(convert_error(&unknown, &error).contains("not a format this node converts"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `.docx` written from `parts`, compressed the way Word compresses.
    fn zipped(dir: &Path, parts: &[(&str, &[u8])]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("doc.docx");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in parts {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn a_zip_bomb_is_refused_and_a_read_unpacks_only_the_text() {
        const MB: u64 = 1 << 20;
        assert_eq!((MAX_PART_BYTES, MAX_UNPACKED_BYTES), (64 * MB, 200 * MB));
        let dir = std::env::temp_dir().join(format!("cf-docx-{}", uuid::Uuid::new_v4()));
        // 2 MB of zeros deflate to a few kilobytes: one part over a 1 MB part limit.
        let zeros = vec![0u8; 2 * MB as usize];
        let bomb = zipped(&dir.join("bomb"), &[("word/document.xml", b"<w:document/>"), ("word/media/x.bin", &zeros)]);
        assert!(std::fs::metadata(&bomb).unwrap().len() < 64 * 1024, "the archive itself is small");
        let refused = read_zip_within(&bomb, None, MB, 3 * MB).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("more than 1 MB (at word/media/x.bin)")), "{refused:?}");
        // Reading the text never unpacks the rest.
        let text_only = read_zip_within(&bomb, Some("word/document.xml"), MB, 3 * MB).unwrap();
        assert_eq!(text_only.keys().collect::<Vec<_>>(), ["word/document.xml"]);
        // Parts under the part limit that together pass the document's.
        let part = vec![0u8; 900 * 1024];
        let many = zipped(&dir.join("many"), &[("a", &part), ("b", &part), ("c", &part), ("d", &part)]);
        let refused = read_zip_within(&many, None, MB, 3 * MB).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("more than 3 MB (at d)")), "{refused:?}");
        assert_eq!(read_zip_within(&many, None, MB, 4 * MB).unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entities_in_a_document_read_as_their_characters() {
        let xml = r#"<w:body><w:p><w:r><w:t>R&amp;D &lt;equipo&gt; &quot;caf&#233;&quot; &#x41;&apos;s</w:t></w:r></w:p></w:body>"#;
        let blocks = read_blocks(xml);
        assert_eq!(blocks_text(&blocks, false), "R&D <equipo> \"café\" A's");
    }

    #[test]
    fn repeats_keep_their_wall_clock_across_dst_and_a_huge_interval_ends_the_series() {
        let santiago: chrono_tz::Tz = "America/Santiago".parse().unwrap();
        let from = chrono::Utc.with_ymd_and_hms(2026, 10, 20, 0, 0, 0).unwrap();
        let to = chrono::Utc.with_ymd_and_hms(2026, 11, 30, 0, 0, 0).unwrap();
        let starts = |ics: &str| -> Vec<String> { parse_ics(ics, from, to, santiago).iter().map(|e| e["start"].as_str().unwrap().to_string()).collect() };
        // New York leaves DST on 1 November: 09:00 there is 13:00 UTC before and 14:00 after — read in
        // the event's own zone, though the calendar is read from Santiago.
        let weekly = "BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=America/New_York:20261026T090000\r\nDTEND;TZID=America/New_York:20261026T093000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n";
        assert_eq!(starts(weekly), ["2026-10-26T13:00:00+00:00", "2026-11-02T14:00:00+00:00", "2026-11-09T14:00:00+00:00"]);
        let daily = "BEGIN:VEVENT\r\nUID:d\r\nDTSTART;TZID=America/New_York:20261030T090000\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEND:VEVENT\r\n";
        assert_eq!(starts(daily), ["2026-10-30T13:00:00+00:00", "2026-10-31T13:00:00+00:00", "2026-11-01T14:00:00+00:00", "2026-11-02T14:00:00+00:00"]);
        // Santiago moves its clocks at midnight (6 September 2026): the day starts at 01:00 and is
        // still that day, not one with no events.
        let gap = "BEGIN:VEVENT\r\nUID:g\r\nDTSTART;VALUE=DATE:20260906\r\nEND:VEVENT\r\n";
        let september = parse_ics(gap, chrono::Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap(), chrono::Utc.with_ymd_and_hms(2026, 9, 30, 0, 0, 0).unwrap(), santiago);
        assert_eq!(september.len(), 1, "{september:?}");
        assert_eq!((&september[0]["start"], &september[0]["end"]), (&json!("2026-09-06"), &json!("2026-09-07")));
        // An interval past any calendar: the first occurrence, then the end — never an overflow.
        for (rule, expected) in [
            ("FREQ=DAILY;INTERVAL=99999999999999999999", 1),
            ("FREQ=DAILY;INTERVAL=9223372036854775807", 1),
            ("FREQ=WEEKLY;INTERVAL=9223372036854775807", 1),
            ("FREQ=WEEKLY;BYDAY=MO,TU;INTERVAL=9223372036854775807", 2),
            ("FREQ=MONTHLY;INTERVAL=9223372036854775807", 1),
            ("FREQ=MONTHLY;INTERVAL=4000000000", 1),
            ("FREQ=YEARLY;INTERVAL=4000000000", 1),
            ("FREQ=YEARLY;INTERVAL=300000", 1),
        ] {
            let ics = format!("BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261026T120000Z\r\nRRULE:{rule}\r\nEND:VEVENT\r\n");
            assert_eq!(parse_ics(&ics, from, to, santiago).len(), expected, "{rule}");
        }
    }

    /// The starts a rule gives from `dtstart` (UTC) within `[from, to]` (whole days), as `YYYY-MM-DD HH:MM`.
    fn occurrences(dtstart: &str, rule: &str, from: &str, to: &str) -> Vec<String> {
        let zone = chrono_tz::UTC;
        let first = ics_time(dtstart, &BTreeMap::new(), zone).unwrap().0;
        let day = |d: &str| chrono::Utc.from_utc_datetime(&NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap().and_hms_opt(0, 0, 0).unwrap());
        expand(first, rule, day(from), day(to), zone).iter().map(|at| at.format("%Y-%m-%d %H:%M").to_string()).collect()
    }

    fn days(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| if d.len() == 10 { format!("{d} 09:00") } else { d.to_string() }).collect()
    }

    #[test]
    fn a_monthly_rule_reads_its_weekdays_with_their_place_in_the_month() {
        // The second Tuesday, the last Friday, the last day, the last weekday.
        assert_eq!(occurrences("20260113T090000Z", "FREQ=MONTHLY;BYDAY=2TU;COUNT=4", "2026-01-01", "2026-12-31"), days(&["2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14"]));
        assert_eq!(occurrences("20260130T090000Z", "FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "2026-01-01", "2026-12-31"), days(&["2026-01-30", "2026-02-27", "2026-03-27"]));
        assert_eq!(occurrences("20260131T090000Z", "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "2026-01-01", "2026-12-31"), days(&["2026-01-31", "2026-02-28", "2026-03-31"]));
        assert_eq!(
            occurrences("20260130T090000Z", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "2026-01-01", "2026-12-31"),
            days(&["2026-01-30", "2026-02-27", "2026-03-31"])
        );
        assert_eq!(occurrences("20260115T090000Z", "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=3", "2026-01-01", "2026-12-31"), days(&["2026-01-15", "2026-02-01", "2026-02-15"]));
    }

    #[test]
    fn days_hours_and_weeks_follow_their_by_parts() {
        // Weekdays only, from a Friday.
        assert_eq!(
            occurrences("20261009T090000Z", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=6", "2026-10-01", "2026-12-31"),
            days(&["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"])
        );
        assert_eq!(
            occurrences("20261012T090000Z", "FREQ=DAILY;BYHOUR=9,17;COUNT=4", "2026-10-01", "2026-12-31"),
            days(&["2026-10-12 09:00", "2026-10-12 17:00", "2026-10-13 09:00", "2026-10-13 17:00"])
        );
        assert_eq!(occurrences("20261012T090000Z", "FREQ=HOURLY;INTERVAL=3;COUNT=3", "2026-10-01", "2026-12-31"), days(&["2026-10-12 09:00", "2026-10-12 12:00", "2026-10-12 15:00"]));
        // RFC 5545's own example: which day starts the week decides which Sunday belongs to a fortnight.
        assert_eq!(occurrences("19970805T090000Z", "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", "1997-01-01", "1997-12-31"), days(&["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"]));
        assert_eq!(occurrences("19970805T090000Z", "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", "1997-01-01", "1997-12-31"), days(&["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"]));
    }

    #[test]
    fn a_yearly_rule_reads_months_weeks_and_days_of_the_year() {
        assert_eq!(
            occurrences("20260315T090000Z", "FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=15;COUNT=4", "2026-01-01", "2028-12-31"),
            days(&["2026-03-15", "2026-09-15", "2027-03-15", "2027-09-15"])
        );
        // The fourth Thursday of November.
        assert_eq!(occurrences("20261126T090000Z", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3", "2026-01-01", "2030-12-31"), days(&["2026-11-26", "2027-11-25", "2028-11-23"]));
        // RFC 5545: Monday of week 20; days 1, 100 and 200 of every third year.
        assert_eq!(occurrences("19970512T090000Z", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=3", "1997-01-01", "2000-12-31"), days(&["1997-05-12", "1998-05-11", "1999-05-17"]));
        assert_eq!(
            occurrences("19970101T090000Z", "FREQ=YEARLY;INTERVAL=3;COUNT=6;BYYEARDAY=1,100,200", "1997-01-01", "2001-12-31"),
            days(&["1997-01-01", "1997-04-10", "1997-07-19", "2000-01-01", "2000-04-09", "2000-07-18"])
        );
    }

    #[test]
    fn a_long_running_series_is_read_where_it_is_asked_for() {
        // Hourly since 2020: a day of 2026 has its 24 hours, however many came before.
        let found = occurrences("20200101T000000Z", "FREQ=HOURLY", "2026-10-12", "2026-10-13");
        assert_eq!(found.len(), 25, "00:00 to 00:00 the next day, both ends in: {found:?}");
        assert_eq!(found[0], "2026-10-12 00:00");
        // UNTIL ends it.
        assert_eq!(occurrences("20261012T090000Z", "FREQ=DAILY;UNTIL=20261014T090000Z", "2026-10-01", "2026-12-31").len(), 3);
    }

    #[test]
    fn added_dates_moved_occurrences_and_cancelled_ones_are_read() {
        let zone = chrono_tz::UTC;
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Daily\r\nDTSTART:20261012T090000Z\r\nDTEND:20261012T091500Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nRDATE:20261020T090000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:20261013T090000Z\r\nSUMMARY:Daily (moved)\r\nDTSTART:20261013T110000Z\r\nDTEND:20261013T111500Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:20261014T090000Z\r\nSTATUS:CANCELLED\r\nDTSTART:20261014T090000Z\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";
        let from = chrono::Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap();
        let to = chrono::Utc.with_ymd_and_hms(2026, 10, 31, 0, 0, 0).unwrap();
        let events = parse_ics(ics, from, to, zone);
        let seen: Vec<(String, String)> = events.iter().map(|e| (e["start"].as_str().unwrap()[..16].to_string(), e["summary"].as_str().unwrap().to_string())).collect();
        assert_eq!(
            seen,
            vec![
                ("2026-10-12T09:00".to_string(), "Daily".to_string()),
                ("2026-10-13T11:00".to_string(), "Daily (moved)".to_string()),
                ("2026-10-15T09:00".to_string(), "Daily".to_string()),
                ("2026-10-20T09:00".to_string(), "Daily".to_string()),
            ],
            "the 13th moved to 11:00, the 14th cancelled, the 20th added"
        );
    }

    #[test]
    fn calendars_expand_and_invites_fold() {
        let zone: chrono_tz::Tz = "America/Santiago".parse().unwrap();
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Daily\\, corto\r\nDTSTART;TZID=America/Santiago:20261005T090000\r\nDTEND;TZID=America/Santiago:20261005T091500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5\r\nEXDATE;TZID=America/Santiago:20261007T090000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Feriado\r\nDTSTART;VALUE=DATE:20261012\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let from = chrono::Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap();
        let to = chrono::Utc.with_ymd_and_hms(2026, 10, 31, 0, 0, 0).unwrap();
        let events = parse_ics(ics, from, to, zone);
        let daily: Vec<&Value> = events.iter().filter(|e| e["uid"] == "1").collect();
        assert_eq!(daily.len(), 4, "five occurrences, one excluded: {events:?}");
        assert_eq!(daily[0]["summary"], "Daily, corto");
        assert!(events.iter().any(|e| e["uid"] == "2" && e["allDay"] == true && e["start"] == "2026-10-12"));
        let invite = build_invite(&json!({"eventTitle": "Revisión, final", "startTime": "2026-10-05 09:30", "attendees": ["a@example.com"], "description": "x".repeat(120)}), zone).unwrap();
        assert!(invite.contains("SUMMARY:Revisión\\, final\r\n"));
        assert!(invite.contains("DTSTART:20261005T123000Z"), "{invite}");
        assert!(invite.lines().all(|l| l.len() <= 76), "folded");
    }
}
