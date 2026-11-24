//! The «Herramientas» tools that need more than the webview has: bcrypt (no WebCrypto
//! primitive), JSON Schema validation, a structural JSON diff, and reading a QR code out of an
//! image. Everything runs locally — the toolbox's promise is that nothing pasted into it leaves the
//! machine — and every input is bounded, since a tool is fed by pasting.

use serde::Serialize;
use serde_json::Value;

/// bcrypt's own ceiling: it reads only the first 72 bytes of a password.
const BCRYPT_MAX_BYTES: usize = 72;
/// Below 4 the crate refuses; above 15 a single hash takes seconds and reads as a hang.
const BCRYPT_COST: std::ops::RangeInclusive<u32> = 4..=15;
/// A QR code is read from a screenshot or a photo, not from a poster scan.
const QR_MAX_BYTES: usize = 25 * 1024 * 1024;

/// Hashes `password` with bcrypt at `cost`. Run off the async runtime: cost 12 is ~250ms of CPU.
#[tauri::command]
pub async fn toolbox_bcrypt_hash(password: String, cost: u32) -> Result<String, String> {
    if !BCRYPT_COST.contains(&cost) {
        return Err(format!("The cost must be between {} and {}", BCRYPT_COST.start(), BCRYPT_COST.end()));
    }
    if password.len() > BCRYPT_MAX_BYTES {
        return Err(format!("bcrypt reads at most {BCRYPT_MAX_BYTES} bytes of a password; this one has {}", password.len()));
    }
    tokio::task::spawn_blocking(move || bcrypt::hash(password, cost).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether `password` is the one `hash` was made from.
#[tauri::command]
pub async fn toolbox_bcrypt_verify(password: String, hash: String) -> Result<bool, String> {
    let hash = hash.trim().to_string();
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).map_err(|e| format!("Not a bcrypt hash: {e}")))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct SchemaError {
    /// JSON Pointer into the document, `""` for the root.
    pub path: String,
    pub message: String,
}

/// Every way `document` breaks `schema`; empty when it is valid.
#[tauri::command]
pub fn toolbox_json_schema_validate(schema: String, document: String) -> Result<Vec<SchemaError>, String> {
    let schema: Value = serde_json::from_str(&schema).map_err(|e| format!("The schema is not JSON: {e}"))?;
    let document: Value = serde_json::from_str(&document).map_err(|e| format!("The document is not JSON: {e}"))?;
    let validator = jsonschema::validator_for(&schema).map_err(|e| format!("The schema is not a valid JSON Schema: {e}"))?;
    Ok(validator
        .iter_errors(&document)
        .map(|error| SchemaError { path: error.instance_path().to_string(), message: error.to_string() })
        .collect())
}

/// What changed from `left` to `right`, by path — the flows' JSON diff, so a key that moved is not
/// a change and a reordered object is equal.
#[tauri::command]
pub fn toolbox_json_diff(left: String, right: String) -> Result<Vec<Value>, String> {
    let left: Value = serde_json::from_str(&left).map_err(|e| format!("The left side is not JSON: {e}"))?;
    let right: Value = serde_json::from_str(&right).map_err(|e| format!("The right side is not JSON: {e}"))?;
    Ok(crate::flows::nodes::utils::json_diff(&left, &right))
}

/// Every QR code in an image, as text. Empty when there is none to read. The image arrives as
/// Base64: a few megabytes of screenshot as a JSON array of numbers would be four times the size.
#[tauri::command]
pub async fn toolbox_qr_read(image: String) -> Result<Vec<String>, String> {
    use base64::Engine;
    if image.len() > QR_MAX_BYTES / 3 * 4 + 4 {
        return Err(format!("The image is larger than {} MB", QR_MAX_BYTES / (1024 * 1024)));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(image.trim()).map_err(|e| format!("Not Base64: {e}"))?;
    if bytes.len() > QR_MAX_BYTES {
        return Err(format!("The image is larger than {} MB", QR_MAX_BYTES / (1024 * 1024)));
    }
    tokio::task::spawn_blocking(move || {
        let picture = image::load_from_memory(&bytes).map_err(|e| format!("Not an image this can read: {e}"))?;
        let mut prepared = rqrr::PreparedImage::prepare(picture.to_luma8());
        Ok(prepared.detect_grids().into_iter().filter_map(|grid| grid.decode().ok().map(|(_, content)| content)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bcrypt_round_trips_and_refuses_the_wrong_password() {
        let hash = toolbox_bcrypt_hash("hunter2".into(), 4).await.unwrap();
        assert!(hash.starts_with("$2"));
        assert!(toolbox_bcrypt_verify("hunter2".into(), hash.clone()).await.unwrap());
        assert!(!toolbox_bcrypt_verify("hunter3".into(), hash).await.unwrap());
        assert!(toolbox_bcrypt_hash("x".into(), 3).await.is_err());
    }

    #[test]
    fn schema_errors_say_where() {
        let errors = toolbox_json_schema_validate(
            r#"{"type":"object","properties":{"age":{"type":"integer"}},"required":["name"]}"#.into(),
            r#"{"age":"old"}"#.into(),
        )
        .unwrap();
        assert_eq!(errors.len(), 2);
        assert!(errors.iter().any(|e| e.path == "/age"));
        assert!(toolbox_json_schema_validate(r#"{"type":"string"}"#.into(), r#""ok""#.into()).unwrap().is_empty());
    }

    #[test]
    fn json_diff_ignores_key_order() {
        assert!(toolbox_json_diff(r#"{"a":1,"b":2}"#.into(), r#"{"b":2,"a":1}"#.into()).unwrap().is_empty());
        assert_eq!(toolbox_json_diff(r#"{"a":1}"#.into(), r#"{"a":2}"#.into()).unwrap().len(), 1);
    }
}
