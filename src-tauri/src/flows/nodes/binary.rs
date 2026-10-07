//! Binary data between nodes as **file references**, not base64.
//!
//! A downloaded PDF, an uploaded image or a binary answer is written once — to the run's work
//! folder, or, before a run exists (a webhook's upload), to the app's cache — and handed on as
//! `{ "$file": true, path, name, mimeType, size }`. The nodes after it read the file when they need
//! the bytes (`{{ $json.file.path }}` in any file field, or the reference itself), while the run's
//! stored data, the expressions and the inspector carry a few dozen bytes instead of a third more
//! than the file.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

/// The extension a type is saved under when nothing else names the file.
pub fn extension_for(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "application/pdf" => "pdf",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/zip" => "zip",
        "application/gzip" => "gz",
        "text/csv" => "csv",
        "text/plain" => "txt",
        "application/json" => "json",
        "application/xml" | "text/xml" => "xml",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        _ => "bin",
    }
}

/// A file name for bytes that came with `disposition` (a `Content-Disposition`), from `url`, of
/// type `mime` — the first of those that names one.
pub fn name_for(disposition: &str, url: &str, mime: &str) -> String {
    let named = disposition.split(';').map(str::trim).find_map(|part| {
        let (key, value) = part.split_once('=')?;
        matches!(key.trim().to_ascii_lowercase().as_str(), "filename" | "filename*")
            .then(|| value.trim().trim_start_matches("UTF-8''").trim_matches('"').to_string())
    });
    let from_url = url::Url::parse(url).ok().and_then(|u| u.path_segments().and_then(|mut s| s.next_back()).map(str::to_string)).filter(|s| s.contains('.'));
    // Percent-decoded (`factura%2042.pdf`), a literal `+` kept as one.
    let name = named.or(from_url).map(|n| url::form_urlencoded::parse(format!("x={}", n.replace('+', "%2B")).as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or(n));
    let name = name.map(|n| super::google::safe_name(&n)).filter(|n| !n.is_empty());
    name.unwrap_or_else(|| format!("archivo.{}", extension_for(mime)))
}

/// Writes `bytes` under `dir` (a fresh name each time) and answers the reference to them.
pub fn keep(dir: &Path, bytes: &[u8], name: &str, mime: &str) -> Result<Value, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not prepare {}: {e}", dir.display()))?;
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{}-{}", &unique[..8], super::google::safe_name(name)));
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(reference(&path, name, mime, bytes.len() as u64))
}

pub fn reference(path: &Path, name: &str, mime: &str, size: u64) -> Value {
    json!({"$file": true, "path": path.to_string_lossy(), "name": name, "mimeType": mime, "size": size})
}

/// The type a file's extension says it is — the other direction of [`extension_for`].
pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default().as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "xml" => "application/xml",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ics" => "text/calendar",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
}

/// The reference to a file already on disk: its name, its type by extension and its size.
pub fn reference_of(path: &Path) -> Value {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    reference(path, &name, mime_for(path), size)
}

/// The file a value points at: a reference, an object holding one in `file`, or a path as text.
pub fn path_of(value: &Value) -> Option<PathBuf> {
    match value {
        Value::Object(map) if map.get("$file").is_some_and(|v| v == &Value::Bool(true)) => map.get("path").and_then(Value::as_str).map(PathBuf::from),
        Value::Object(map) => map.get("file").and_then(path_of),
        Value::String(text) if !text.trim().is_empty() => Some(super::files::expand(text.trim())),
        _ => None,
    }
}

/// Whether a value is a file reference (or holds one in `file`).
pub fn is_reference(value: &Value) -> bool {
    matches!(value, Value::Object(_)) && path_of(value).is_some()
}

/// Files in `dir` older than `age`, removed — where uploads wait for the run that reads them.
pub fn prune(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let cutoff = SystemTime::now().checked_sub(age).unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|at| at < cutoff);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Where a webhook keeps what it received before a run reads it: the app's cache, a week at most.
pub fn incoming_dir() -> PathBuf {
    crate::paths::cache_dir().join("flows").join("incoming")
}

/// A `multipart/form-data` body: its text fields as text, its files written to `dir` as references.
/// `None` when the body is not one (no boundary, nothing that parses).
pub fn multipart(body: &[u8], content_type: &str, dir: &Path) -> Option<serde_json::Map<String, Value>> {
    let boundary = content_type.split(';').map(str::trim).find_map(|part| part.strip_prefix("boundary="))?.trim_matches('"');
    let delimiter = format!("--{boundary}").into_bytes();
    let mut fields = serde_json::Map::new();
    let find = |haystack: &[u8], needle: &[u8], from: usize| haystack.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from);
    let mut at = find(body, &delimiter, 0)? + delimiter.len();
    loop {
        if body.get(at..at + 2) == Some(b"--") {
            break;
        }
        at += 2; // CRLF after the delimiter
        let headers_end = find(body, b"\r\n\r\n", at)?;
        let head = String::from_utf8_lossy(&body[at..headers_end]).into_owned();
        let content_start = headers_end + 4;
        let next = find(body, &delimiter, content_start)?;
        let content = &body[content_start..next.saturating_sub(2).max(content_start)];
        let mut name = String::new();
        let mut file_name = None;
        let mut kind = String::from("application/octet-stream");
        for line in head.lines() {
            let lower = line.to_ascii_lowercase();
            if lower.starts_with("content-disposition:") {
                for part in line.split(';').map(str::trim) {
                    if let Some(value) = part.strip_prefix("name=") {
                        name = value.trim_matches('"').to_string();
                    } else if let Some(value) = part.strip_prefix("filename=") {
                        file_name = Some(value.trim_matches('"').to_string());
                    }
                }
            } else if lower.starts_with("content-type:") {
                kind = line[13..].trim().to_string();
            }
        }
        let value = match file_name {
            Some(file) => keep(dir, content, if file.is_empty() { "archivo" } else { &file }, &kind).ok()?,
            None => Value::String(String::from_utf8_lossy(content).into_owned()),
        };
        // A field sent twice (`files[]`) becomes a list.
        match fields.get_mut(&name) {
            Some(Value::Array(list)) => list.push(value),
            Some(existing) => *existing = Value::Array(vec![existing.clone(), value]),
            None => {
                fields.insert(name, value);
            }
        }
        at = next + delimiter.len();
    }
    Some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_the_header_the_url_or_the_type() {
        assert_eq!(name_for("attachment; filename=\"factura 42.pdf\"", "https://example.com/x", "application/pdf"), "factura 42.pdf");
        assert_eq!(name_for("", "https://example.com/files/report.csv?x=1", "text/csv"), "report.csv");
        assert_eq!(name_for("", "https://example.com/download", "image/png"), "archivo.png");
    }

    #[test]
    fn bytes_become_references_and_multipart_uploads_are_split() {
        let dir = std::env::temp_dir().join(format!("cf-binary-{}", uuid::Uuid::new_v4()));
        let reference = keep(&dir, b"%PDF-1.7", "a.pdf", "application/pdf").unwrap();
        let path = path_of(&reference).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.7");
        assert_eq!(reference["size"], 8);
        assert!(is_reference(&json!({"binary": true, "file": reference})));
        assert!(!is_reference(&json!("a text")));

        let body = b"--XyZ\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhola\r\n--XyZ\r\nContent-Disposition: form-data; name=\"doc\"; filename=\"f.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\x01\x02\r\n--XyZ--\r\n";
        let fields = multipart(body, "multipart/form-data; boundary=XyZ", &dir).unwrap();
        assert_eq!(fields["note"], "hola");
        assert_eq!(fields["doc"]["name"], "f.bin");
        assert_eq!(std::fs::read(path_of(&fields["doc"]).unwrap()).unwrap(), vec![0, 1, 2]);
        assert!(multipart(b"plain", "multipart/form-data", &dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
