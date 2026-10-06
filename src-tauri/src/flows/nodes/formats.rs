//! Convert, Crypto, Compress and Compare — the nodes that reshape data without touching anything
//! outside the run.
//!
//! **Formats are read the way people write them.** CSV is RFC 4180 (quotes, doubled quotes, line
//! breaks inside a quoted field); XML maps attributes to `@name` keys and mixed text to `#text`, and
//! repeated elements to arrays, so a document round-trips through JSON without guessing; YAML goes
//! through `yaml-rust2`, Markdown through `pulldown-cmark` with tables, task lists and footnotes.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::files::{describe, expand};
use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{get_path, set_path, to_text};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "transform.convert" => convert(ctx).await,
        "transform.crypto" => crypto(ctx).await,
        "transform.compress" => compress(ctx).await,
        "transform.compare" => compare(ctx),
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn base(ctx: &NodeCtx, index: usize) -> Value {
    ctx.items().get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn paired(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

fn target_or(params: &Value, fallback: &str) -> String {
    let target = text(params, "target");
    if target.trim().is_empty() {
        fallback.to_string()
    } else {
        target.trim().to_string()
    }
}

// -------------------------------------------------------------------------------------------- CSV

/// RFC 4180: quoted fields, `""` for a quote inside one, line breaks inside quotes. A blank line
/// is no row.
pub fn parse_csv(input: &str, delimiter: char) -> Vec<Vec<String>> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = input.chars().peekable();
    let mut touched = false;
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => {
                quoted = true;
                touched = true;
            }
            c if c == delimiter => {
                row.push(std::mem::take(&mut field));
                touched = true;
            }
            '\r' => {}
            '\n' => {
                if touched || !field.is_empty() {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                touched = false;
            }
            c => {
                field.push(c);
                touched = true;
            }
        }
    }
    if touched || !field.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn csv_field(value: &str, delimiter: char) -> String {
    if value.contains(delimiter) || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub fn write_csv(rows: &[Vec<String>], delimiter: char) -> String {
    let mut out = String::new();
    for row in rows {
        let line: Vec<String> = row.iter().map(|cell| csv_field(cell, delimiter)).collect();
        out.push_str(&line.join(&delimiter.to_string()));
        out.push_str("\r\n");
    }
    out
}

/// A cell's text: strings as they are, everything else as JSON, nothing as empty.
pub fn cell_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Every key the objects have, in the order they first appear.
pub fn columns_of(objects: &[&Value]) -> Vec<String> {
    let mut columns: Vec<String> = Vec::new();
    for object in objects {
        if let Value::Object(map) = object {
            for key in map.keys() {
                if !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    columns
}

/// Rows as objects keyed by the header (or `column1…` without one).
pub fn rows_to_objects(rows: Vec<Vec<String>>, header: bool) -> Vec<Value> {
    let mut rows = rows.into_iter();
    let names: Vec<String> = if header {
        rows.next().unwrap_or_default()
    } else {
        Vec::new()
    };
    rows.map(|row| {
        let mut object = Map::new();
        for (index, cell) in row.into_iter().enumerate() {
            let name = names.get(index).filter(|name| !name.is_empty()).cloned().unwrap_or_else(|| format!("column{}", index + 1));
            object.insert(name, Value::String(cell));
        }
        Value::Object(object)
    })
    .collect()
}

fn delimiter_of(params: &Value) -> char {
    match text(params, "delimiter").as_str() {
        "\\t" | "tab" | "\t" => '\t',
        other => other.chars().next().unwrap_or(','),
    }
}

// -------------------------------------------------------------------------------------------- XML

/// XML as JSON: an element with only text is its text; attributes are `@name`; text beside
/// children is `#text`; an element that repeats is an array.
pub fn xml_to_json(input: &str) -> Result<Value, String> {
    use quick_xml::events::Event;
    // Text is trimmed once per element, not per event: an entity splits "Ana &amp; Co" into three
    // events, and trimming each would glue it back as "Ana&Co".
    let mut reader = quick_xml::Reader::from_str(input);
    // (name, object, text)
    let mut stack: Vec<(String, Map<String, Value>, String)> = vec![(String::new(), Map::new(), String::new())];
    fn attach(parent: &mut Map<String, Value>, name: String, value: Value) {
        match parent.get_mut(&name) {
            Some(Value::Array(list)) => list.push(value),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, value]);
            }
            None => {
                parent.insert(name, value);
            }
        }
    }
    fn finish(object: Map<String, Value>, text: String) -> Value {
        let text = text.trim().to_string();
        if object.is_empty() {
            Value::String(text)
        } else {
            let mut object = object;
            if !text.is_empty() {
                object.insert("#text".into(), Value::String(text));
            }
            Value::Object(object)
        }
    }
    let attrs = |start: &quick_xml::events::BytesStart| -> Result<Map<String, Value>, String> {
        let mut map = Map::new();
        for attribute in start.attributes() {
            let attribute = attribute.map_err(|e| e.to_string())?;
            let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
            let value = attribute.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| e.to_string())?.into_owned();
            map.insert(format!("@{key}"), Value::String(value));
        }
        Ok(map)
    };
    loop {
        match reader.read_event().map_err(|e| format!("Not valid XML: {e}"))? {
            Event::Start(start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                stack.push((name, attrs(&start)?, String::new()));
            }
            Event::Empty(start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                let object = attrs(&start)?;
                let value = finish(object, String::new());
                if let Some((_, parent, _)) = stack.last_mut() {
                    attach(parent, name, value);
                }
            }
            Event::Text(content) => {
                let decoded = content.decode().map_err(|e| e.to_string())?;
                let unescaped = quick_xml::escape::unescape(&decoded).map_err(|e| e.to_string())?;
                if let Some((_, _, text)) = stack.last_mut() {
                    text.push_str(&unescaped);
                }
            }
            Event::CData(content) => {
                if let Some((_, _, text)) = stack.last_mut() {
                    text.push_str(&String::from_utf8_lossy(&content));
                }
            }
            Event::GeneralRef(reference) => {
                let name = String::from_utf8_lossy(&reference).into_owned();
                let resolved = match name.as_str() {
                    "amp" => "&".to_string(),
                    "lt" => "<".to_string(),
                    "gt" => ">".to_string(),
                    "quot" => "\"".to_string(),
                    "apos" => "'".to_string(),
                    other => reference
                        .resolve_char_ref()
                        .ok()
                        .flatten()
                        .map(String::from)
                        .unwrap_or_else(|| format!("&{other};")),
                };
                if let Some((_, _, text)) = stack.last_mut() {
                    text.push_str(&resolved);
                }
            }
            Event::End(_) => {
                let Some((name, object, text)) = stack.pop() else { break };
                let value = finish(object, text);
                match stack.last_mut() {
                    Some((_, parent, _)) => attach(parent, name, value),
                    None => return Ok(value),
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let (_, root, _) = stack.pop().unwrap_or_default();
    Ok(Value::Object(root))
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn xml_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':') { c } else { '_' }).collect();
    if cleaned.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
        cleaned
    } else {
        format!("_{cleaned}")
    }
}

fn write_xml(out: &mut String, name: &str, value: &Value) {
    match value {
        Value::Array(list) => {
            for entry in list {
                write_xml(out, name, entry);
            }
        }
        Value::Object(map) => {
            let tag = xml_name(name);
            out.push('<');
            out.push_str(&tag);
            for (key, attribute) in map.iter().filter(|(key, _)| key.starts_with('@')) {
                out.push_str(&format!(" {}=\"{}\"", xml_name(&key[1..]), xml_escape(&cell_text(Some(attribute)))));
            }
            out.push('>');
            if let Some(text) = map.get("#text") {
                out.push_str(&xml_escape(&cell_text(Some(text))));
            }
            for (key, child) in map.iter().filter(|(key, _)| !key.starts_with('@') && key.as_str() != "#text") {
                write_xml(out, key, child);
            }
            out.push_str(&format!("</{tag}>"));
        }
        Value::Null => out.push_str(&format!("<{}/>", xml_name(name))),
        other => {
            let tag = xml_name(name);
            out.push_str(&format!("<{tag}>{}</{tag}>", xml_escape(&cell_text(Some(other)))));
        }
    }
}

pub fn json_to_xml(value: &Value, root: &str) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    match value {
        Value::Object(map) if map.len() == 1 && root.is_empty() => {
            let (name, child) = map.iter().next().expect("one key");
            write_xml(&mut out, name, child);
        }
        other => write_xml(&mut out, if root.is_empty() { "root" } else { root }, other),
    }
    out
}

// ------------------------------------------------------------------------------------------- YAML

fn yaml_to_json(yaml: &yaml_rust2::Yaml) -> Value {
    use yaml_rust2::Yaml;
    match yaml {
        Yaml::Real(text) => text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::String(text.clone()), Value::Number),
        Yaml::Integer(n) => json!(n),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Array(list) => Value::Array(list.iter().map(yaml_to_json).collect()),
        Yaml::Hash(hash) => Value::Object(
            hash.iter()
                .map(|(key, value)| {
                    let key = match key {
                        Yaml::String(text) => text.clone(),
                        Yaml::Integer(n) => n.to_string(),
                        Yaml::Real(text) => text.clone(),
                        Yaml::Boolean(b) => b.to_string(),
                        other => format!("{other:?}"),
                    };
                    (key, yaml_to_json(value))
                })
                .collect(),
        ),
        Yaml::Alias(_) | Yaml::Null | Yaml::BadValue => Value::Null,
    }
}

fn json_to_yaml(value: &Value) -> yaml_rust2::Yaml {
    use yaml_rust2::Yaml;
    match value {
        Value::Null => Yaml::Null,
        Value::Bool(b) => Yaml::Boolean(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Yaml::Integer(i),
            None => Yaml::Real(n.to_string()),
        },
        Value::String(text) => Yaml::String(text.clone()),
        Value::Array(list) => Yaml::Array(list.iter().map(json_to_yaml).collect()),
        Value::Object(map) => {
            let mut hash = yaml_rust2::yaml::Hash::new();
            for (key, child) in map {
                hash.insert(Yaml::String(key.clone()), json_to_yaml(child));
            }
            Yaml::Hash(hash)
        }
    }
}

pub fn parse_yaml(input: &str) -> Result<Value, String> {
    let documents = yaml_rust2::YamlLoader::load_from_str(input).map_err(|e| format!("Not valid YAML: {e}"))?;
    Ok(match documents.len() {
        0 => Value::Null,
        1 => yaml_to_json(&documents[0]),
        _ => Value::Array(documents.iter().map(yaml_to_json).collect()),
    })
}

pub fn write_yaml(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    let mut emitter = yaml_rust2::YamlEmitter::new(&mut out);
    emitter.dump(&json_to_yaml(value)).map_err(|e| e.to_string())?;
    let body = out.strip_prefix("---\n").or_else(|| out.strip_prefix("---")).unwrap_or(&out).to_string();
    Ok(format!("{}\n", body.trim_end()))
}

pub fn markdown_to_html(markdown: &str) -> String {
    let options = pulldown_cmark::Options::ENABLE_TABLES
        | pulldown_cmark::Options::ENABLE_FOOTNOTES
        | pulldown_cmark::Options::ENABLE_STRIKETHROUGH
        | pulldown_cmark::Options::ENABLE_TASKLISTS;
    let parser = pulldown_cmark::Parser::new_ext(markdown, options);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

// ---------------------------------------------------------------------------------------- convert

async fn convert(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let operation = ctx.param_str("operation");
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    if operation == "toCsv" && flag(&ctx.params, "allItems") {
        let params = &resolved[0];
        let delimiter = delimiter_of(params);
        let objects: Vec<&Value> = items.iter().map(|item| &item.json).collect();
        let columns = columns_of(&objects);
        let mut rows = Vec::new();
        if flag(params, "header") {
            rows.push(columns.clone());
        }
        for object in &objects {
            rows.push(columns.iter().map(|column| cell_text(object.get(column))).collect());
        }
        let mut out = json!({});
        set_path(&mut out, &target_or(params, "csv"), Value::String(write_csv(&rows, delimiter)));
        if let Value::Object(map) = &mut out {
            map.insert("rows".into(), json!(objects.len()));
        }
        return Ok(vec![vec![Item::new(out)]]);
    }
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let item = base(ctx, index);
        let field = text(params, "inputField");
        let source: Value = if field.trim().is_empty() { item.clone() } else { get_path(&item, field.trim()).cloned().unwrap_or(Value::Null) };
        let source_text = || cell_text(Some(&source));
        let mut json = item.clone();
        match operation.as_str() {
            "fromCsv" => {
                let rows = parse_csv(&source_text(), delimiter_of(params));
                for row in rows_to_objects(rows, flag(params, "header")) {
                    out.push(paired(ctx, index, row));
                }
                continue;
            }
            "toCsv" => {
                let delimiter = delimiter_of(params);
                let objects: Vec<&Value> = match &source {
                    Value::Array(list) => list.iter().collect(),
                    other => vec![other],
                };
                let columns = columns_of(&objects);
                let mut rows = Vec::new();
                if flag(params, "header") {
                    rows.push(columns.clone());
                }
                for object in &objects {
                    rows.push(columns.iter().map(|column| cell_text(object.get(column))).collect());
                }
                set_path(&mut json, &target_or(params, "csv"), Value::String(write_csv(&rows, delimiter)));
            }
            "fromXml" => {
                let parsed = xml_to_json(&source_text()).map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "data"), parsed);
            }
            "toXml" => {
                let root = text(params, "xmlRoot");
                set_path(&mut json, &target_or(params, "xml"), Value::String(json_to_xml(&source, root.trim())));
            }
            "fromYaml" => {
                let parsed = parse_yaml(&source_text()).map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "data"), parsed);
            }
            "toYaml" => {
                let yaml = write_yaml(&source).map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "yaml"), Value::String(yaml));
            }
            "markdownToHtml" => {
                set_path(&mut json, &target_or(params, "html"), Value::String(markdown_to_html(&source_text())));
            }
            "fromJsonText" => {
                let parsed: Value = serde_json::from_str(source_text().trim()).map_err(|e| NodeError::failed(format!("Not valid JSON: {e}")))?;
                set_path(&mut json, &target_or(params, "data"), parsed);
            }
            _ => {
                let pretty = flag(params, "pretty");
                let rendered = if pretty { serde_json::to_string_pretty(&source) } else { serde_json::to_string(&source) }.unwrap_or_default();
                set_path(&mut json, &target_or(params, "json"), Value::String(rendered));
            }
        }
        out.push(paired(ctx, index, json));
    }
    Ok(vec![out])
}

// ----------------------------------------------------------------------------------------- crypto

fn digest(algorithm: &str, bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest;
    match algorithm {
        "md5" => md5::Md5::digest(bytes).to_vec(),
        "sha1" => sha1::Sha1::digest(bytes).to_vec(),
        "sha512" => sha2::Sha512::digest(bytes).to_vec(),
        _ => sha2::Sha256::digest(bytes).to_vec(),
    }
}

fn mac(algorithm: &str, key: &[u8], bytes: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    match algorithm {
        "sha1" => {
            let mut mac = Hmac::<sha1::Sha1>::new_from_slice(key).expect("any key length");
            mac.update(bytes);
            mac.finalize().into_bytes().to_vec()
        }
        "sha512" => {
            let mut mac = Hmac::<sha2::Sha512>::new_from_slice(key).expect("any key length");
            mac.update(bytes);
            mac.finalize().into_bytes().to_vec()
        }
        "sha384" => {
            let mut mac = Hmac::<sha2::Sha384>::new_from_slice(key).expect("any key length");
            mac.update(bytes);
            mac.finalize().into_bytes().to_vec()
        }
        _ => {
            let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key).expect("any key length");
            mac.update(bytes);
            mac.finalize().into_bytes().to_vec()
        }
    }
}

fn encode(bytes: &[u8], encoding: &str) -> String {
    if encoding == "base64" {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    } else {
        hex::encode(bytes)
    }
}

// ------------------------------------------------------------------------------------ JWT, AES

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn jwt_hash(algorithm: &str) -> &'static str {
    match algorithm {
        "HS384" => "sha384",
        "HS512" => "sha512",
        _ => "sha256",
    }
}

/// An HS-signed JWT of `claims`, with `iat` — and `exp` when `expires_in` is more than zero.
pub(crate) fn jwt_sign(claims: &Value, algorithm: &str, secret: &[u8], expires_in: u64, now: i64) -> Result<String, String> {
    let algorithm = match algorithm {
        "HS384" | "HS512" => algorithm,
        _ => "HS256",
    };
    let mut claims = match claims {
        Value::Object(map) => map.clone(),
        _ => return Err("The JWT payload must be a JSON object".into()),
    };
    claims.entry("iat").or_insert(json!(now));
    if expires_in > 0 {
        claims.entry("exp").or_insert(json!(now + expires_in as i64));
    }
    let header = B64URL.encode(json!({"alg": algorithm, "typ": "JWT"}).to_string());
    let body = B64URL.encode(Value::Object(claims).to_string());
    let signature = B64URL.encode(mac(jwt_hash(algorithm), secret, format!("{header}.{body}").as_bytes()));
    Ok(format!("{header}.{body}.{signature}"))
}

/// Whether `token` was signed with `secret` and has not expired — and what it says either way.
pub(crate) fn jwt_verify(token: &str, algorithm: &str, secret: &[u8], now: i64) -> Value {
    let parts: Vec<&str> = token.trim().split('.').collect();
    let fail = |error: &str, payload: Value| json!({"valid": false, "error": error, "payload": payload});
    if parts.len() != 3 {
        return fail("Not a JWT (three parts separated by dots)", Value::Null);
    }
    let payload: Value = B64URL
        .decode(parts[1])
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let header: Value = B64URL.decode(parts[0]).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let declared = header.get("alg").and_then(Value::as_str).unwrap_or_default();
    if declared != algorithm {
        // `alg` is the token's claim about itself — checking it against the node keeps a token from
        // choosing how it is verified ("none", or another hash).
        return fail(&format!("Signed with {declared}, not {algorithm}"), payload);
    }
    let expected = mac(jwt_hash(algorithm), secret, format!("{}.{}", parts[0], parts[1]).as_bytes());
    let given = B64URL.decode(parts[2]).unwrap_or_default();
    let same = expected.len() == given.len() && expected.iter().zip(&given).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if !same {
        return fail("The signature does not match", payload);
    }
    if let Some(exp) = payload.get("exp").and_then(Value::as_i64) {
        if now >= exp {
            return fail("Expired", payload);
        }
    }
    json!({"valid": true, "error": null, "payload": payload})
}

/// `cf1:` + base64(salt · nonce · AES-256-GCM ciphertext), the key Argon2id-derived from `passphrase`.
pub(crate) fn encrypt_text(plain: &str, passphrase: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let salt: [u8; 16] = rand::random();
    let nonce: [u8; 12] = rand::random();
    let mut key = [0u8; 32];
    argon2::Argon2::default().hash_password_into(passphrase, &salt, &mut key).map_err(|e| e.to_string())?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_bytes()).map_err(|_| "Could not encrypt".to_string())?;
    let mut blob = Vec::with_capacity(28 + sealed.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&sealed);
    Ok(format!("cf1:{}", base64::engine::general_purpose::STANDARD.encode(blob)))
}

pub(crate) fn decrypt_text(sealed: &str, passphrase: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let encoded = sealed.trim().strip_prefix("cf1:").ok_or("Not something this node encrypted (it starts with cf1:)")?;
    let blob = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| format!("Not base64: {e}"))?;
    if blob.len() < 28 {
        return Err("Too short to be encrypted text".into());
    }
    let mut key = [0u8; 32];
    argon2::Argon2::default().hash_password_into(passphrase, &blob[..16], &mut key).map_err(|e| e.to_string())?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&blob[16..28]), &blob[28..])
        .map_err(|_| "Wrong passphrase, or the text was changed".to_string())?;
    String::from_utf8(plain).map_err(|_| "The decrypted bytes are not text".to_string())
}

async fn crypto(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let operation = ctx.param_str("operation");
    let credential = ctx.param_str("credential");
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let mut json = base(ctx, index);
        let value = text(params, "value");
        let algorithm = text(params, "algorithm");
        let encoding = text(params, "encoding");
        let key = || -> Result<String, NodeError> {
            let secret = if credential.trim().is_empty() {
                text(params, "secret")
            } else {
                ctx.run.host.credential(&credential).map_err(NodeError::Failed)?.secret
            };
            if secret.is_empty() {
                return Err(NodeError::failed("This needs a secret: pick a credential or write one"));
            }
            ctx.run.host.secret_used(&secret);
            Ok(secret)
        };
        let now = chrono::Utc::now().timestamp();
        let (field, result) = match operation.as_str() {
            "jwtSign" => {
                let claims = match params.get("payload") {
                    Some(Value::String(raw)) if raw.trim().is_empty() => json!({}),
                    Some(Value::String(raw)) => {
                        serde_json::from_str(raw).map_err(|e| NodeError::failed(format!("The payload is not valid JSON: {e}")))?
                    }
                    Some(other) => other.clone(),
                    None => json!({}),
                };
                let expires = number(params, "expiresInSec").unwrap_or(3600.0).max(0.0) as u64;
                let token = jwt_sign(&claims, &text(params, "jwtAlgorithm"), key()?.as_bytes(), expires, now).map_err(NodeError::Failed)?;
                ("jwt", Value::String(token))
            }
            "jwtVerify" => {
                let algorithm = Some(text(params, "jwtAlgorithm")).filter(|a| !a.is_empty()).unwrap_or_else(|| "HS256".into());
                ("jwt", jwt_verify(&value, &algorithm, key()?.as_bytes(), now))
            }
            "encrypt" => ("encrypted", Value::String(encrypt_text(&value, key()?.as_bytes()).map_err(NodeError::Failed)?)),
            "decrypt" => ("text", Value::String(decrypt_text(&value, key()?.as_bytes()).map_err(NodeError::Failed)?)),
            "hmac" => {
                let secret = if credential.trim().is_empty() {
                    text(params, "secret")
                } else {
                    ctx.run.host.credential(&credential).map_err(NodeError::Failed)?.secret
                };
                if secret.is_empty() {
                    return Err(NodeError::failed("An HMAC needs a secret: pick a credential or write one"));
                }
                ("hmac", Value::String(encode(&mac(&algorithm, secret.as_bytes(), value.as_bytes()), &encoding)))
            }
            "uuid" => ("uuid", Value::String(uuid::Uuid::new_v4().to_string())),
            "random" => {
                let length = number(params, "length").unwrap_or(16.0).clamp(1.0, 4096.0) as usize;
                let bytes: Vec<u8> = (0..length).map(|_| rand::random::<u8>()).collect();
                ("random", Value::String(encode(&bytes, &encoding)))
            }
            "base64Encode" => ("base64", Value::String(base64::engine::general_purpose::STANDARD.encode(value.as_bytes()))),
            "base64Decode" => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(value.trim())
                    .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value.trim()))
                    .map_err(|e| NodeError::failed(format!("Not base64: {e}")))?;
                ("text", Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            }
            _ => ("hash", Value::String(encode(&digest(&algorithm, value.as_bytes()), &encoding))),
        };
        set_path(&mut json, &target_or(params, field), result);
        out.push(paired(ctx, index, json));
    }
    Ok(vec![out])
}

// --------------------------------------------------------------------------------------- compress

fn scratch_dir(ctx: &NodeCtx) -> Result<PathBuf, NodeError> {
    let dir = ctx.run.host.work_dir().join(format!("files-{}", ctx.node.id));
    std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a folder: {e}")))?;
    Ok(dir)
}

fn add_to_zip(writer: &mut zip::ZipWriter<std::fs::File>, path: &Path, name: &str) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    if path.is_dir() {
        writer.add_directory(format!("{name}/"), options).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
            let child = entry.path();
            let child_name = format!("{name}/{}", entry.file_name().to_string_lossy());
            add_to_zip(writer, &child, &child_name)?;
        }
        Ok(())
    } else {
        writer.start_file(name, options).map_err(|e| e.to_string())?;
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, writer).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Extracts a zip into `into`, refusing an entry whose name would land outside it.
pub fn unzip(archive: &Path, into: &Path) -> Result<Vec<PathBuf>, String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a zip archive: {e}"))?;
    let mut written = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!("The archive holds an unsafe path: {}", entry.name()));
        };
        let target = into.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        written.push(target);
    }
    Ok(written)
}

async fn compress(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let operation = ctx.param_str("operation");
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let mut json = base(ctx, index);
        let mut sources: Vec<PathBuf> = strings(params, "sources").iter().map(|path| expand(path)).collect();
        let single = text(params, "source");
        if !single.trim().is_empty() {
            sources.push(expand(&single));
        }
        if sources.is_empty() {
            return Err(NodeError::failed("Name the file or folder to work on"));
        }
        for source in &sources {
            if !source.exists() {
                return Err(NodeError::failed(format!("{} does not exist", source.display())));
            }
        }
        let destination = text(params, "destPath");
        let first_name = sources[0].file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "archive".into());
        let into = |default_name: String| -> Result<PathBuf, NodeError> {
            Ok(if destination.trim().is_empty() { scratch_dir(ctx)?.join(default_name) } else { expand(&destination) })
        };
        match operation.as_str() {
            "unzip" | "untarGz" => {
                let folder = into(first_name.trim_end_matches(".zip").trim_end_matches(".tar.gz").trim_end_matches(".tgz").to_string())?;
                std::fs::create_dir_all(&folder).map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
                let archive = sources[0].clone();
                let folder_clone = folder.clone();
                let tar = operation == "untarGz";
                let files = tokio::task::spawn_blocking(move || -> Result<Vec<PathBuf>, String> {
                    if tar {
                        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
                        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
                        let mut written = Vec::new();
                        for entry in archive.entries().map_err(|e| e.to_string())? {
                            let mut entry = entry.map_err(|e| e.to_string())?;
                            // `unpack_in` refuses names that climb out of the folder.
                            if entry.unpack_in(&folder_clone).map_err(|e| e.to_string())? {
                                if let Ok(path) = entry.path() {
                                    written.push(folder_clone.join(path));
                                }
                            }
                        }
                        Ok(written)
                    } else {
                        unzip(&archive, &folder_clone)
                    }
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "folder"), describe(&folder));
                set_path(&mut json, "files", Value::Array(files.iter().map(|path| json!(path.to_string_lossy())).collect()));
            }
            "gunzip" => {
                let name = first_name.trim_end_matches(".gz").to_string();
                let target = into(name)?;
                let source = sources[0].clone();
                let destination_path = target.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let mut decoder = flate2::read::GzDecoder::new(std::fs::File::open(&source).map_err(|e| e.to_string())?);
                    let mut out = std::fs::File::create(&destination_path).map_err(|e| e.to_string())?;
                    std::io::copy(&mut decoder, &mut out).map_err(|e| format!("Not gzip: {e}"))?;
                    Ok(())
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "file"), describe(&target));
            }
            "gzip" => {
                let target = into(format!("{first_name}.gz"))?;
                let source = sources[0].clone();
                if source.is_dir() {
                    return Err(NodeError::failed("gzip compresses one file — use tar.gz for a folder"));
                }
                let destination_path = target.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let mut input = std::fs::File::open(&source).map_err(|e| e.to_string())?;
                    let mut encoder = flate2::write::GzEncoder::new(std::fs::File::create(&destination_path).map_err(|e| e.to_string())?, flate2::Compression::default());
                    std::io::copy(&mut input, &mut encoder).map_err(|e| e.to_string())?;
                    encoder.finish().map_err(|e| e.to_string())?;
                    Ok(())
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "file"), describe(&target));
            }
            "tarGz" => {
                let target = into(format!("{first_name}.tar.gz"))?;
                let all = sources.clone();
                let destination_path = target.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let file = std::fs::File::create(&destination_path).map_err(|e| e.to_string())?;
                    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()));
                    builder.follow_symlinks(false);
                    for source in &all {
                        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        if source.is_dir() {
                            builder.append_dir_all(&name, source).map_err(|e| e.to_string())?;
                        } else {
                            builder.append_path_with_name(source, &name).map_err(|e| e.to_string())?;
                        }
                    }
                    builder.into_inner().map_err(|e| e.to_string())?.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "file"), describe(&target));
            }
            _ => {
                let target = into(format!("{}.zip", first_name.trim_end_matches('/')))?;
                let all = sources.clone();
                let destination_path = target.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let file = std::fs::File::create(&destination_path).map_err(|e| e.to_string())?;
                    let mut writer = zip::ZipWriter::new(file);
                    for source in &all {
                        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        add_to_zip(&mut writer, source, &name)?;
                    }
                    writer.finish().map_err(|e| e.to_string())?;
                    Ok(())
                })
                .await
                .map_err(|e| NodeError::failed(e.to_string()))?
                .map_err(NodeError::Failed)?;
                set_path(&mut json, &target_or(params, "file"), describe(&target));
            }
        }
        out.push(paired(ctx, index, json));
    }
    Ok(vec![out])
}

// ---------------------------------------------------------------------------------------- compare

fn canonical(value: Option<&Value>) -> String {
    match value {
        None => "∅".to_string(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn compare(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let a: Vec<&Item> = ctx.inputs.first().map(|port| port.iter().collect()).unwrap_or_default();
    let b: Vec<&Item> = ctx.inputs.get(1).map(|port| port.iter().collect()).unwrap_or_default();
    let key_a = ctx.param_str("keyA");
    let key_b = {
        let key = ctx.param_str("keyB");
        if key.trim().is_empty() { key_a.clone() } else { key }
    };
    if key_a.trim().is_empty() {
        return Err(NodeError::failed("Name the field that matches items between A and B"));
    }
    let fields = strings(&ctx.params, "fields");
    let key_of = |item: &Item, key: &str| get_path(&item.json, key.trim()).filter(|v| !v.is_null()).map(to_text);
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (index, item) in b.iter().enumerate() {
        if let Some(key) = key_of(item, &key_b) {
            by_key.entry(key).or_insert(index);
        }
    }
    let mut matched_b = vec![false; b.len()];
    let (mut only_a, mut same, mut changed) = (Vec::new(), Vec::new(), Vec::new());
    for (index, item) in a.iter().enumerate() {
        let Some(found) = key_of(item, &key_a).and_then(|key| by_key.get(&key).copied()) else {
            only_a.push(Item::paired(item.json.clone(), index));
            continue;
        };
        matched_b[found] = true;
        let other = &b[found].json;
        let names: Vec<String> = if fields.is_empty() {
            let mut names: Vec<String> = item.json.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            for key in other.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                if !names.contains(&key) {
                    names.push(key);
                }
            }
            names
        } else {
            fields.clone()
        };
        let mut different = Map::new();
        for name in &names {
            let left = get_path(&item.json, name);
            let right = get_path(other, name);
            if canonical(left) != canonical(right) {
                different.insert(name.clone(), json!({"a": left.cloned().unwrap_or(Value::Null), "b": right.cloned().unwrap_or(Value::Null)}));
            }
        }
        if different.is_empty() {
            same.push(Item::paired(item.json.clone(), index));
        } else {
            changed.push(Item::paired(json!({"a": item.json, "b": other, "different": different}), index));
        }
    }
    let only_b = b
        .iter()
        .enumerate()
        .filter(|(index, _)| !matched_b[*index])
        .map(|(index, item)| Item::paired(item.json.clone(), a.len() + index))
        .collect();
    Ok(vec![only_a, same, changed, only_b])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_reads_quotes_and_writes_them_back() {
        let text = "id,name,note\r\n1,\"Pérez, Ana\",\"dice \"\"hola\"\"\"\n2,Bruno,\"dos\nlíneas\"\n\n";
        let rows = parse_csv(text, ',');
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1], vec!["1", "Pérez, Ana", "dice \"hola\""]);
        assert_eq!(rows[2][2], "dos\nlíneas");
        let objects = rows_to_objects(rows.clone(), true);
        assert_eq!(objects[0], json!({"id": "1", "name": "Pérez, Ana", "note": "dice \"hola\""}));
        assert_eq!(parse_csv(&write_csv(&rows, ','), ','), rows);
        assert_eq!(parse_csv("a;b\n1;2", ';'), vec![vec!["a", "b"], vec!["1", "2"]]);
        assert_eq!(parse_csv("\u{feff}x\n", ','), vec![vec!["x"]]);
    }

    #[test]
    fn xml_round_trips_through_json() {
        let xml = r#"<?xml version="1.0"?><pedido id="7"><cliente>Ana &amp; Co</cliente><item sku="a">1</item><item sku="b">2</item><vacío/></pedido>"#;
        let json = xml_to_json(xml).unwrap();
        assert_eq!(json["pedido"]["@id"], "7");
        assert_eq!(json["pedido"]["cliente"], "Ana & Co");
        assert_eq!(json["pedido"]["item"][1], json!({"@sku": "b", "#text": "2"}));
        let back = json_to_xml(&json, "");
        assert!(back.contains("<pedido id=\"7\">"), "{back}");
        assert!(back.contains("<cliente>Ana &amp; Co</cliente>"), "{back}");
        assert_eq!(xml_to_json(&back).unwrap(), json);
        assert!(xml_to_json("<a><b></a>").is_err());
    }

    #[test]
    fn yaml_and_markdown() {
        let parsed = parse_yaml("nombre: api\npuerto: 8080\ntags: [a, b]\nactivo: true\nratio: 0.5\n").unwrap();
        assert_eq!(parsed, json!({"nombre": "api", "puerto": 8080, "tags": ["a", "b"], "activo": true, "ratio": 0.5}));
        let yaml = write_yaml(&parsed).unwrap();
        assert_eq!(parse_yaml(&yaml).unwrap(), parsed);
        let html = markdown_to_html("# Hola\n\n- [x] hecho\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert!(html.contains("<h1>Hola</h1>") && html.contains("<table>") && html.contains("checkbox"), "{html}");
    }

    #[test]
    fn digests_and_macs_match_known_vectors() {
        assert_eq!(encode(&digest("sha256", b"abc"), "hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(encode(&digest("md5", b"abc"), "hex"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(encode(&digest("sha1", b"abc"), "hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            encode(&mac("sha256", b"key", b"The quick brown fox jumps over the lazy dog"), "hex"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn zip_refuses_names_that_climb_out() {
        let dir = std::env::temp_dir().join(format!("cf-zip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("evil.zip");
        {
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            writer.start_file("../escape.txt", zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        assert!(unzip(&archive, &dir.join("out")).is_err());
        assert!(!dir.join("escape.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod crypto_tests {
    use super::*;

    #[test]
    fn a_jwt_round_trips_and_a_wrong_secret_an_alg_swap_or_an_expiry_fail() {
        let token = jwt_sign(&json!({"sub": "ana"}), "HS256", b"s3cret", 60, 1_000).unwrap();
        let ok = jwt_verify(&token, "HS256", b"s3cret", 1_010);
        assert_eq!((ok["valid"].as_bool(), ok["payload"]["sub"].as_str(), ok["payload"]["exp"].as_i64()), (Some(true), Some("ana"), Some(1_060)));
        assert_eq!(jwt_verify(&token, "HS256", b"other", 1_010)["valid"], false);
        assert_eq!(jwt_verify(&token, "HS512", b"s3cret", 1_010)["error"], "Signed with HS256, not HS512");
        assert_eq!(jwt_verify(&token, "HS256", b"s3cret", 1_060)["error"], "Expired");
        assert_eq!(jwt_verify("nope", "HS256", b"s3cret", 0)["valid"], false);
        // A well-known HS256 vector (jwt.io's example): same signature.
        let known = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        assert_eq!(jwt_verify(known, "HS256", b"your-256-bit-secret", 1_600_000_000)["valid"], true);
    }

    #[test]
    fn encrypted_text_opens_only_with_its_passphrase() {
        let sealed = encrypt_text("número secreto", b"clave larga").unwrap();
        assert!(sealed.starts_with("cf1:"));
        assert_ne!(encrypt_text("número secreto", b"clave larga").unwrap(), sealed, "a fresh salt and nonce each time");
        assert_eq!(decrypt_text(&sealed, b"clave larga").unwrap(), "número secreto");
        assert!(decrypt_text(&sealed, b"otra").unwrap_err().contains("Wrong passphrase"));
        assert!(decrypt_text("hola", b"x").is_err());
    }
}
