//! Hito 8's documents and pictures: a PDF read as text or written from Markdown, and an image
//! resized, converted, cropped, rotated or read — plus QR codes, made and read.
//!
//! **A PDF is written with the 14 fonts every reader has** (Helvetica and Courier), so nothing is
//! embedded and a report is a few kilobytes. The price is the alphabet: WinAnsi, which covers
//! Spanish and the rest of Western Europe; anything else is written as `?`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{expand_path, number, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "files.pdf" => pdf(ctx).await,
        "files.image" => image_node(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn need_path(params: &Value, name: &str, what: &str) -> Result<PathBuf, NodeError> {
    let raw = text(params, name);
    if raw.trim().is_empty() {
        return Err(NodeError::failed(format!("Say which {what}")));
    }
    Ok(expand_path(raw.trim()))
}

fn prepare_parent(path: &Path) -> Result<(), NodeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(format!("{}: {e}", parent.display())))?;
    }
    Ok(())
}

fn out_item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

// -------------------------------------------------------------------------------------------- PDF

async fn pdf(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let answer = if text(params, "operation") == "createPdf" {
            let output = need_path(params, "savePath", "file to write")?;
            prepare_parent(&output)?;
            let size = if text(params, "pageSize") == "letter" { LETTER } else { A4 };
            let bytes = markdown_pdf(&text(params, "markdown"), &text(params, "title"), size).map_err(NodeError::Failed)?;
            std::fs::write(&output, &bytes.0).map_err(|e| NodeError::failed(format!("{}: {e}", output.display())))?;
            json!({"path": output.to_string_lossy(), "pages": bytes.1, "bytes": bytes.0.len()})
        } else {
            let path = need_path(params, "path", "PDF to read")?;
            let read = path.clone();
            let (text_out, pages) = tokio::task::spawn_blocking(move || -> Result<(String, usize), String> {
                let bytes = std::fs::read(&read).map_err(|e| format!("{}: {e}", read.display()))?;
                let pages = lopdf::Document::load_mem(&bytes).map(|doc| doc.get_pages().len()).unwrap_or(0);
                let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|e| format!("The PDF could not be read: {e}"))?;
                Ok((text, pages))
            })
            .await
            .map_err(|e| NodeError::failed(e.to_string()))?
            .map_err(NodeError::Failed)?;
            json!({"path": path.to_string_lossy(), "pages": pages, "text": text_out.trim()})
        };
        out.push(out_item(ctx, index, answer));
    }
    Ok(vec![out])
}

/// Page sizes in points.
const A4: (f32, f32) = (595.0, 842.0);
const LETTER: (f32, f32) = (612.0, 792.0);
const MARGIN: f32 = 56.0;

/// Helvetica's advance widths (per 1000 em) for the printable ASCII range, from its AFM.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Helvetica-Bold's, the same range.
const HELVETICA_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

#[derive(Clone, Copy, PartialEq)]
enum Face {
    Regular,
    Bold,
    Mono,
}

impl Face {
    fn resource(self) -> &'static str {
        match self {
            Face::Regular => "F1",
            Face::Bold => "F2",
            Face::Mono => "F3",
        }
    }
}

/// A character as WinAnsi (what the standard fonts are set to): Latin-1 as is, the typographic
/// punctuation in its 0x80–0x9F slots, anything else `?`.
fn win_ansi(c: char) -> u8 {
    match c {
        ' '..='~' => c as u8,
        '\u{a0}'..='\u{ff}' => c as u32 as u8,
        '€' => 0x80,
        '‚' => 0x82,
        '„' => 0x84,
        '…' => 0x85,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        _ => b'?',
    }
}

fn char_width(byte: u8, face: Face) -> f32 {
    if face == Face::Mono {
        return 600.0;
    }
    let table = if face == Face::Bold { &HELVETICA_BOLD } else { &HELVETICA };
    let width = match byte {
        32..=126 => table[(byte - 32) as usize],
        // Accented letters take their base letter's width — close enough to wrap on.
        0xC0..=0xC5 => table[(b'A' - 32) as usize],
        0xC7 => table[(b'C' - 32) as usize],
        0xC8..=0xCB => table[(b'E' - 32) as usize],
        0xCC..=0xCF => table[(b'I' - 32) as usize],
        0xD1 => table[(b'N' - 32) as usize],
        0xD2..=0xD6 | 0xD8 => table[(b'O' - 32) as usize],
        0xD9..=0xDC => table[(b'U' - 32) as usize],
        0xE0..=0xE5 => table[(b'a' - 32) as usize],
        0xE7 => table[(b'c' - 32) as usize],
        0xE8..=0xEB => table[(b'e' - 32) as usize],
        0xEC..=0xEF => table[(b'i' - 32) as usize],
        0xF1 => table[(b'n' - 32) as usize],
        0xF2..=0xF6 | 0xF8 => table[(b'o' - 32) as usize],
        0xF9..=0xFC => table[(b'u' - 32) as usize],
        0x97 | 0x85 => 1000,
        0x91 | 0x92 => 222,
        0x93 | 0x94 => 333,
        _ => 556,
    };
    width as f32
}

fn width_of(text: &[u8], face: Face, size: f32) -> f32 {
    text.iter().map(|b| char_width(*b, face)).sum::<f32>() * size / 1000.0
}

/// One line of a page: its face, size and text, already WinAnsi.
struct Line {
    face: Face,
    size: f32,
    text: Vec<u8>,
    indent: f32,
    /// Space above it.
    before: f32,
}

/// Words wrapped to `width`, a long word broken where it must.
fn wrap(text: &str, face: Face, size: f32, width: f32) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    for word in text.split_whitespace() {
        let word: Vec<u8> = word.chars().map(win_ansi).collect();
        let candidate = if current.is_empty() { word.clone() } else { [current.clone(), vec![b' '], word.clone()].concat() };
        if width_of(&candidate, face, size) <= width {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        let mut piece = Vec::new();
        for byte in word {
            if width_of(&[piece.as_slice(), &[byte]].concat(), face, size) > width && !piece.is_empty() {
                lines.push(std::mem::take(&mut piece));
            }
            piece.push(byte);
        }
        current = piece;
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// Markdown as the lines of a document: headings, paragraphs, lists, quotes and code — the shapes
/// a report has. Emphasis inside a paragraph is read as plain text.
fn layout(markdown: &str, title: &str, width: f32) -> Vec<Line> {
    use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
    let mut lines = Vec::new();
    let push_block = |lines: &mut Vec<Line>, text: &str, face: Face, size: f32, indent: f32, before: f32| {
        for (i, wrapped) in wrap(text, face, size, width - indent).into_iter().enumerate() {
            lines.push(Line { face, size, text: wrapped, indent, before: if i == 0 { before } else { 0.0 } });
        }
    };
    if !title.trim().is_empty() {
        push_block(&mut lines, title.trim(), Face::Bold, 20.0, 0.0, 0.0);
    }
    let mut buffer = String::new();
    let mut heading: Option<HeadingLevel> = None;
    let mut list_depth: usize = 0;
    let mut numbered: Vec<Option<u64>> = Vec::new();
    let mut in_code = false;
    let mut quote = false;
    for event in Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                buffer.clear();
                heading = Some(level);
            }
            Event::End(TagEnd::Heading(_)) => {
                let size = match heading {
                    Some(HeadingLevel::H1) => 18.0,
                    Some(HeadingLevel::H2) => 15.0,
                    _ => 12.5,
                };
                push_block(&mut lines, &buffer, Face::Bold, size, 0.0, size * 0.9);
                buffer.clear();
                heading = None;
            }
            Event::Start(Tag::List(start)) => {
                list_depth += 1;
                numbered.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
                numbered.pop();
            }
            Event::Start(Tag::Item) => buffer.clear(),
            Event::End(TagEnd::Item) => {
                let marker = match numbered.last_mut() {
                    Some(Some(n)) => {
                        let mark = format!("{n}.");
                        *n += 1;
                        mark
                    }
                    _ => "•".to_string(),
                };
                let indent = 14.0 * list_depth as f32;
                push_block(&mut lines, &format!("{marker} {}", buffer.trim()), Face::Regular, 10.5, indent, 3.0);
                buffer.clear();
            }
            Event::Start(Tag::BlockQuote(_)) => quote = true,
            Event::End(TagEnd::BlockQuote(_)) => quote = false,
            Event::Start(Tag::Paragraph) => {
                if list_depth == 0 {
                    buffer.clear();
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if list_depth == 0 {
                    push_block(&mut lines, &buffer, Face::Regular, 10.5, if quote { 14.0 } else { 0.0 }, 8.0);
                    buffer.clear();
                } else {
                    buffer.push(' ');
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                in_code = true;
                buffer.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                for (i, code_line) in buffer.lines().enumerate() {
                    let bytes: Vec<u8> = code_line.chars().map(win_ansi).collect();
                    // Long code lines are cut, not wrapped: a wrapped line of code is a different line.
                    let fits = ((width - 12.0) / (600.0 * 9.0 / 1000.0)) as usize;
                    lines.push(Line { face: Face::Mono, size: 9.0, text: bytes.into_iter().take(fits).collect(), indent: 12.0, before: if i == 0 { 8.0 } else { 0.0 } });
                }
                buffer.clear();
                in_code = false;
            }
            Event::Rule => lines.push(Line { face: Face::Regular, size: 10.5, text: b"________________________________".to_vec(), indent: 0.0, before: 8.0 }),
            Event::Text(text) | Event::Code(text) => buffer.push_str(&text),
            Event::SoftBreak => buffer.push(if in_code { '\n' } else { ' ' }),
            Event::HardBreak => buffer.push(if in_code { '\n' } else { ' ' }),
            Event::End(TagEnd::TableCell) => buffer.push_str("  |  "),
            Event::End(TagEnd::TableRow) | Event::End(TagEnd::TableHead) => {
                push_block(&mut lines, buffer.trim_end_matches(['|', ' ']), Face::Regular, 9.5, 0.0, 2.0);
                buffer.clear();
            }
            _ => {}
        }
    }
    if !buffer.trim().is_empty() {
        push_block(&mut lines, &buffer, Face::Regular, 10.5, 0.0, 8.0);
    }
    lines
}

fn escape_pdf(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for &b in text {
        if matches!(b, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out
}

/// Markdown as a PDF — `(bytes, pages)`.
pub(crate) fn markdown_pdf(markdown: &str, title: &str, size: (f32, f32)) -> Result<(Vec<u8>, usize), String> {
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};
    let (page_w, page_h) = size;
    let lines = layout(markdown, title, page_w - 2.0 * MARGIN);
    // Paginate: each line takes its space above plus 1.35 × its size.
    let mut pages: Vec<Vec<(f32, &Line)>> = vec![Vec::new()];
    let mut y = page_h - MARGIN;
    for line in &lines {
        let step = line.before + line.size * 1.35;
        if y - step < MARGIN && !pages.last().map(Vec::is_empty).unwrap_or(true) {
            pages.push(Vec::new());
            y = page_h - MARGIN;
        }
        y -= step;
        pages.last_mut().expect("one page at least").push((y, line));
    }

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = |doc: &mut Document, base: &str| {
        doc.add_object(dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => base, "Encoding" => "WinAnsiEncoding"})
    };
    let (f1, f2, f3) = (font(&mut doc, "Helvetica"), font(&mut doc, "Helvetica-Bold"), font(&mut doc, "Courier"));
    let resources = doc.add_object(dictionary! {"Font" => dictionary! {"F1" => f1, "F2" => f2, "F3" => f3}});
    let mut kids = Vec::new();
    for page in &pages {
        let mut operations = Vec::new();
        for (y, line) in page {
            operations.push(Operation::new("BT", vec![]));
            operations.push(Operation::new("Tf", vec![line.face.resource().into(), line.size.into()]));
            operations.push(Operation::new("Td", vec![(MARGIN + line.indent).into(), (*y).into()]));
            operations.push(Operation::new("Tj", vec![Object::String(escape_pdf(&line.text), lopdf::StringFormat::Literal)]));
            operations.push(Operation::new("ET", vec![]));
        }
        let content = Content { operations };
        let stream = doc.add_object(Stream::new(dictionary! {}, content.encode().map_err(|e| e.to_string())?));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => stream,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), page_w.into(), page_h.into()],
        });
        kids.push(page_id.into());
    }
    let count = kids.len();
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! {"Type" => "Pages", "Kids" => kids, "Count" => count as i64}));
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", catalog);
    if !title.trim().is_empty() {
        let info = doc.add_object(dictionary! {"Title" => Object::string_literal(title.trim()), "Producer" => Object::string_literal("CodeFlow Flujos")});
        doc.trailer.set("Info", info);
    }
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| e.to_string())?;
    Ok((bytes, count))
}

// ------------------------------------------------------------------------------------------ image

async fn image_node(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let params = params.clone();
        let answer = tokio::task::spawn_blocking(move || image_op(&params)).await.map_err(|e| NodeError::failed(e.to_string()))?.map_err(NodeError::Failed)?;
        out.push(out_item(ctx, index, answer));
    }
    Ok(vec![out])
}

fn path_of(params: &Value, name: &str, what: &str) -> Result<PathBuf, String> {
    let raw = text(params, name);
    if raw.trim().is_empty() {
        return Err(format!("Say which {what}"));
    }
    Ok(expand_path(raw.trim()))
}

fn save(image: &image::DynamicImage, output: &Path, params: &Value) -> Result<Value, String> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let extension = output.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => {
            let quality = number(params, "quality").unwrap_or(85.0).clamp(1.0, 100.0) as u8;
            let file = std::fs::File::create(output).map_err(|e| format!("{}: {e}", output.display()))?;
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), quality);
            image.to_rgb8().write_with_encoder(encoder).map_err(|e| e.to_string())?;
        }
        _ => image.save(output).map_err(|e| format!("{}: {e}", output.display()))?,
    }
    let bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"path": output.to_string_lossy(), "width": image.width(), "height": image.height(), "bytes": bytes}))
}

pub(crate) fn image_op(params: &Value) -> Result<Value, String> {
    let operation = text(params, "operation");
    if operation == "qrCreate" {
        let content = text(params, "qrText");
        if content.is_empty() {
            return Err("Write what the QR code holds".into());
        }
        let size = number(params, "qrSize").unwrap_or(512.0).clamp(64.0, 4096.0) as u32;
        let code = qrcode::QrCode::new(content.as_bytes()).map_err(|e| format!("Too much for one QR code: {e}"))?;
        let rendered = code.render::<image::Luma<u8>>().min_dimensions(size, size).build();
        let output = path_of(params, "savePath", "file to write")?;
        return save(&image::DynamicImage::ImageLuma8(rendered), &output, params);
    }
    let input = path_of(params, "path", "image")?;
    let picture = image::ImageReader::open(&input)
        .map_err(|e| format!("{}: {e}", input.display()))?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| format!("{}: {e}", input.display()))?;
    match operation.as_str() {
        "qrRead" => {
            let mut prepared = rqrr::PreparedImage::prepare(picture.to_luma8());
            let texts: Vec<String> = prepared.detect_grids().into_iter().filter_map(|grid| grid.decode().ok().map(|(_, content)| content)).collect();
            Ok(json!({"path": input.to_string_lossy(), "found": texts.len(), "text": texts.first(), "texts": texts}))
        }
        "imageInfo" => {
            let format = image::ImageFormat::from_path(&input).ok().map(|f| format!("{f:?}").to_lowercase());
            let bytes = std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0);
            Ok(json!({"path": input.to_string_lossy(), "width": picture.width(), "height": picture.height(), "format": format, "bytes": bytes}))
        }
        "resize" => {
            let (w, h) = (number(params, "width").unwrap_or(0.0).max(0.0) as u32, number(params, "height").unwrap_or(0.0).max(0.0) as u32);
            if w == 0 && h == 0 {
                return Err("Give a width, a height or both".into());
            }
            // One side alone keeps the proportions.
            let (w, h) = match (w, h) {
                (0, h) => ((picture.width() as f64 * h as f64 / picture.height() as f64).round().max(1.0) as u32, h),
                (w, 0) => (w, (picture.height() as f64 * w as f64 / picture.width() as f64).round().max(1.0) as u32),
                both => both,
            };
            let resized = picture.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
            save(&resized, &path_of(params, "savePath", "file to write")?, params)
        }
        "crop" => {
            let (x, y) = (number(params, "x").unwrap_or(0.0).max(0.0) as u32, number(params, "y").unwrap_or(0.0).max(0.0) as u32);
            let (w, h) = (number(params, "width").unwrap_or(0.0) as u32, number(params, "height").unwrap_or(0.0) as u32);
            if w == 0 || h == 0 || x >= picture.width() || y >= picture.height() {
                return Err("The crop falls outside the image".into());
            }
            let cropped = picture.crop_imm(x, y, w.min(picture.width() - x), h.min(picture.height() - y));
            save(&cropped, &path_of(params, "savePath", "file to write")?, params)
        }
        "rotate" => {
            let turned = match text(params, "degrees").as_str() {
                "180" => picture.rotate180(),
                "270" => picture.rotate270(),
                _ => picture.rotate90(),
            };
            save(&turned, &path_of(params, "savePath", "file to write")?, params)
        }
        "stripMetadata" => strip_metadata(&input, &picture, &path_of(params, "savePath", "file to write")?, params),
        "watermark" => watermark(picture, params),
        "imageCompare" => compare_images(&input, &picture, params),
        _ => save(&picture, &path_of(params, "savePath", "file to write")?, params),
    }
}

/// Without what a photo says about where and with what it was taken (EXIF, XMP, IPTC, comments).
/// A JPEG or PNG loses only those segments, byte for byte — no re-encoding, no quality lost.
fn strip_metadata(input: &Path, picture: &image::DynamicImage, output: &Path, params: &Value) -> Result<Value, String> {
    let bytes = std::fs::read(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let stripped = if bytes.starts_with(&[0xFF, 0xD8]) {
        Some(strip_jpeg(&bytes)?)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(strip_png(&bytes)?)
    } else {
        None
    };
    let removed;
    match stripped {
        Some(clean) => {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            removed = bytes.len().saturating_sub(clean.len());
            std::fs::write(output, &clean).map_err(|e| format!("{}: {e}", output.display()))?;
        }
        // Any other format: decoded and written again, which keeps no metadata.
        None => {
            save(picture, output, params)?;
            removed = 0;
        }
    }
    Ok(json!({"path": output.to_string_lossy(), "width": picture.width(), "height": picture.height(), "bytesRemoved": removed}))
}

/// A JPEG without its APP1 (EXIF, XMP), APP12–APP15 (IPTC, vendor) and COM segments.
pub(crate) fn strip_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = vec![0xFF, 0xD8];
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return Err("The JPEG's structure could not be read".into());
        }
        let marker = bytes[i + 1];
        // Start of scan: everything after it is the picture itself.
        if marker == 0xDA {
            out.extend_from_slice(&bytes[i..]);
            return Ok(out);
        }
        let length = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        let end = (i + 2 + length).min(bytes.len());
        let drop = marker == 0xE1 || (0xEC..=0xEF).contains(&marker) || marker == 0xFE;
        if !drop {
            out.extend_from_slice(&bytes[i..end]);
        }
        i = end;
    }
    Ok(out)
}

/// A PNG without its text and EXIF chunks (`tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME`).
pub(crate) fn strip_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = bytes[..8].to_vec();
    let mut i = 8;
    while i + 12 <= bytes.len() {
        let length = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let kind = &bytes[i + 4..i + 8];
        let end = i + 12 + length;
        if end > bytes.len() {
            return Err("The PNG's structure could not be read".into());
        }
        if !matches!(kind, b"tEXt" | b"iTXt" | b"zTXt" | b"eXIf" | b"tIME") {
            out.extend_from_slice(&bytes[i..end]);
        }
        i = end;
    }
    Ok(out)
}

/// The first readable font among the system's usual ones — for a text watermark.
fn system_font() -> Option<Vec<u8>> {
    let candidates: &[&str] = &[
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ];
    candidates.iter().find_map(|path| std::fs::read(path).ok())
}

fn place(position: &str, canvas: (u32, u32), mark: (u32, u32)) -> (i64, i64) {
    let margin = (canvas.0.min(canvas.1) as f64 * 0.03).round() as i64;
    let (cw, ch, mw, mh) = (canvas.0 as i64, canvas.1 as i64, mark.0 as i64, mark.1 as i64);
    match position {
        "posTopLeft" => (margin, margin),
        "posTopRight" => (cw - mw - margin, margin),
        "posBottomLeft" => (margin, ch - mh - margin),
        "posCenter" => ((cw - mw) / 2, (ch - mh) / 2),
        _ => (cw - mw - margin, ch - mh - margin),
    }
}

/// A logo or a line of text laid over the picture, at a corner (or the centre), half see-through.
fn watermark(picture: image::DynamicImage, params: &Value) -> Result<Value, String> {
    use image::{GenericImageView, Pixel};
    let mut canvas = picture.to_rgba8();
    let opacity = (number(params, "watermarkOpacity").unwrap_or(50.0).clamp(0.0, 100.0) / 100.0) as f32;
    let position = text(params, "watermarkPosition");
    let logo_path = text(params, "watermarkImage");
    let line = text(params, "watermarkText");
    if logo_path.trim().is_empty() && line.trim().is_empty() {
        return Err("Choose a watermark image or write its text".into());
    }
    if !logo_path.trim().is_empty() {
        let logo_path = expand_path(logo_path.trim());
        let logo = image::open(&logo_path).map_err(|e| format!("{}: {e}", logo_path.display()))?;
        // A fifth of the picture's width, never larger than it was drawn.
        let target_w = ((canvas.width() as f64 * 0.2).round() as u32).clamp(1, logo.width().max(1));
        let target_h = ((logo.height() as f64 * target_w as f64 / logo.width().max(1) as f64).round() as u32).max(1);
        let logo = logo.resize(target_w, target_h, image::imageops::FilterType::Lanczos3).to_rgba8();
        let (x, y) = place(&position, (canvas.width(), canvas.height()), (logo.width(), logo.height()));
        for (lx, ly, pixel) in logo.enumerate_pixels() {
            let (cx, cy) = (x + lx as i64, y + ly as i64);
            if cx < 0 || cy < 0 || cx >= canvas.width() as i64 || cy >= canvas.height() as i64 {
                continue;
            }
            let mut faded = *pixel;
            faded.0[3] = (faded.0[3] as f32 * opacity) as u8;
            canvas.get_pixel_mut(cx as u32, cy as u32).blend(&faded);
        }
    }
    if !line.trim().is_empty() {
        use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
        let data = system_font().ok_or("No font was found on this computer for a text watermark: use an image")?;
        let font = FontRef::try_from_slice(&data).map_err(|e| format!("The system font could not be read: {e}"))?;
        let size = (canvas.height().min(canvas.width()) as f32 * 0.05).clamp(12.0, 200.0);
        let scaled = font.as_scaled(PxScale::from(size));
        let width: f32 = line.chars().map(|c| scaled.h_advance(font.glyph_id(c))).sum();
        let height = scaled.ascent() - scaled.descent();
        let (x, y) = place(&position, (canvas.width(), canvas.height()), (width.ceil() as u32, height.ceil() as u32));
        // A soft shadow first, so white text reads on a white sky too.
        for (dx, dy, colour) in [(size * 0.06, size * 0.06, [0u8, 0, 0]), (0.0, 0.0, [255u8, 255, 255])] {
            let mut caret = x as f32 + dx;
            for c in line.chars() {
                let glyph = scaled.scaled_glyph(c);
                let advance = scaled.h_advance(glyph.id);
                let mut glyph = glyph;
                glyph.position = ab_glyph::point(caret, y as f32 + dy + scaled.ascent());
                if let Some(outlined) = font.outline_glyph(glyph) {
                    let bounds = outlined.px_bounds();
                    outlined.draw(|gx, gy, coverage| {
                        let px = bounds.min.x as i64 + gx as i64;
                        let py = bounds.min.y as i64 + gy as i64;
                        if px < 0 || py < 0 || px >= canvas.width() as i64 || py >= canvas.height() as i64 {
                            return;
                        }
                        let alpha = (coverage * opacity * if colour == [0, 0, 0] { 0.6 } else { 1.0 } * 255.0) as u8;
                        canvas.get_pixel_mut(px as u32, py as u32).blend(&image::Rgba([colour[0], colour[1], colour[2], alpha]));
                    });
                }
                caret += advance;
            }
        }
    }
    let output = path_of(params, "savePath", "file to write")?;
    let _ = picture.dimensions();
    save(&image::DynamicImage::ImageRgba8(canvas), &output, params)
}

/// Two pictures compared pixel by pixel — a screenshot against its baseline. Pixels that differ by
/// more than the tolerance in any channel count, and are painted red over a faded copy when a
/// `savePath` is given.
fn compare_images(input: &Path, picture: &image::DynamicImage, params: &Value) -> Result<Value, String> {
    let other_path = path_of(params, "comparePath", "image to compare with")?;
    let other = image::open(&other_path).map_err(|e| format!("{}: {e}", other_path.display()))?;
    let a = picture.to_rgba8();
    let size_mismatch = other.width() != a.width() || other.height() != a.height();
    let b = if size_mismatch { other.resize_exact(a.width(), a.height(), image::imageops::FilterType::Triangle).to_rgba8() } else { other.to_rgba8() };
    let threshold = number(params, "diffThreshold").unwrap_or(16.0).clamp(0.0, 255.0) as i32;
    let mut diff = image::RgbaImage::new(a.width(), a.height());
    let mut different = 0u64;
    for (x, y, pa) in a.enumerate_pixels() {
        let pb = b.get_pixel(x, y);
        let delta = (0..4).map(|c| (pa.0[c] as i32 - pb.0[c] as i32).abs()).max().unwrap_or(0);
        if delta > threshold {
            different += 1;
            diff.put_pixel(x, y, image::Rgba([230, 30, 30, 255]));
        } else {
            let grey = ((pa.0[0] as u32 + pa.0[1] as u32 + pa.0[2] as u32) / 3) as u8;
            let faded = 255 - (255 - grey) / 3;
            diff.put_pixel(x, y, image::Rgba([faded, faded, faded, 255]));
        }
    }
    let total = (a.width() as u64 * a.height() as u64).max(1);
    let percent = (different as f64 / total as f64 * 10000.0).round() / 100.0;
    let mut out = json!({
        "path": input.to_string_lossy(),
        "comparedWith": other_path.to_string_lossy(),
        "same": different == 0,
        "differentPixels": different,
        "totalPixels": total,
        "differencePercent": percent,
        "sizeMismatch": size_mismatch,
    });
    let output = text(params, "savePath");
    if !output.trim().is_empty() {
        let saved = save(&image::DynamicImage::ImageRgba8(diff), &expand_path(output.trim()), params)?;
        out["diffPath"] = saved["path"].clone();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_becomes_a_readable_pdf_and_reads_back() {
        let markdown = "# Informe\n\nUn párrafo con **negrita**, eñes y tildes: canción, acción.\n\n- uno\n- dos\n\n1. primero\n2. segundo\n\n```\nlet x = 1;\n```\n";
        let long = format!("{markdown}\n{}", "Línea larga de relleno para paginar. ".repeat(400));
        let (bytes, pages) = markdown_pdf(&long, "Ventas", A4).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.5"));
        assert!(pages >= 2, "{pages} page(s) for a long text");
        let text = pdf_extract::extract_text_from_mem(&bytes).unwrap();
        assert!(text.contains("Informe") && text.contains("Ventas"), "{}", &text[..text.len().min(300)]);
        assert!(text.contains("canción") && text.contains("eñes"), "WinAnsi keeps Spanish");
        assert!(text.contains("primero") && text.contains("let x = 1;"));
    }

    #[test]
    fn words_wrap_within_the_width_and_long_ones_break() {
        let lines = wrap("una frase con varias palabras para cortar", Face::Regular, 10.0, 80.0);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| width_of(line, Face::Regular, 10.0) <= 80.0));
        let lines = wrap(&"x".repeat(200), Face::Mono, 10.0, 60.0);
        assert!(lines.len() > 1 && lines.iter().all(|line| line.len() <= 10));
    }

    #[test]
    fn images_resize_keep_proportions_and_qr_codes_round_trip() {
        let dir = std::env::temp_dir().join(format!("cf-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let qr = dir.join("qr.png");
        let made = image_op(&json!({"operation": "qrCreate", "qrText": "https://example.com/pago/42", "qrSize": 300, "savePath": qr.to_string_lossy()})).unwrap();
        assert!(made["width"].as_u64().unwrap() >= 300);
        let read = image_op(&json!({"operation": "qrRead", "path": qr.to_string_lossy()})).unwrap();
        assert_eq!(read["text"], "https://example.com/pago/42");

        let small = dir.join("small.jpg");
        let resized = image_op(&json!({"operation": "resize", "path": qr.to_string_lossy(), "width": 100, "savePath": small.to_string_lossy()})).unwrap();
        assert_eq!((resized["width"].as_u64(), resized["height"].as_u64()), (Some(100), Some(100)), "one side keeps the square");
        let info = image_op(&json!({"operation": "imageInfo", "path": small.to_string_lossy()})).unwrap();
        assert_eq!(info["format"], "jpeg");
        let crop = image_op(&json!({"operation": "crop", "path": qr.to_string_lossy(), "x": 10, "y": 10, "width": 50, "height": 40, "savePath": dir.join("c.webp").to_string_lossy()})).unwrap();
        assert_eq!((crop["width"].as_u64(), crop["height"].as_u64()), (Some(50), Some(40)));
        assert!(image_op(&json!({"operation": "crop", "path": qr.to_string_lossy(), "x": 5000, "width": 5, "height": 5, "savePath": "x.png"})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadata_is_stripped_and_pictures_compare() {
        let dir = std::env::temp_dir().join(format!("cf-image-meta-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A real JPEG, then an EXIF segment spliced in after its SOI.
        let plain = dir.join("a.jpg");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(40, 30, image::Rgb([200, 30, 30]))).save(&plain).unwrap();
        let mut bytes = std::fs::read(&plain).unwrap();
        let exif = [0xFF, 0xE1, 0x00, 0x08, b'E', b'x', b'i', b'f', 0x00, 0x00];
        bytes.splice(2..2, exif.iter().cloned());
        let tagged = dir.join("tagged.jpg");
        std::fs::write(&tagged, &bytes).unwrap();
        let clean = strip_jpeg(&bytes).unwrap();
        assert_eq!(clean.len(), bytes.len() - exif.len());
        assert!(image::load_from_memory(&clean).is_ok(), "still a JPEG");

        let other = dir.join("b.png");
        let mut changed = image::RgbaImage::from_pixel(40, 30, image::Rgba([200, 30, 30, 255]));
        for x in 0..10 {
            changed.put_pixel(x, 0, image::Rgba([0, 0, 255, 255]));
        }
        image::DynamicImage::ImageRgba8(changed).save(&other).unwrap();
        let base = dir.join("base.png");
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(40, 30, image::Rgba([200, 30, 30, 255]))).save(&base).unwrap();
        let params = json!({"operation": "imageCompare", "path": base.to_string_lossy(), "comparePath": other.to_string_lossy(), "diffThreshold": 16, "savePath": dir.join("diff.png").to_string_lossy()});
        let answer = image_op(&params).unwrap();
        assert_eq!(answer["differentPixels"], 10);
        assert_eq!(answer["same"], false);
        assert!(dir.join("diff.png").exists());

        let stamped = image_op(&json!({"operation": "watermark", "path": base.to_string_lossy(), "watermarkImage": other.to_string_lossy(), "watermarkOpacity": 80, "savePath": dir.join("stamped.png").to_string_lossy()})).unwrap();
        assert_eq!(stamped["width"], 40);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
