//! RSS, Atom and RSS 1.0 (RDF) feeds as items — the «Leer feed» node and what the «Nuevo en un feed»
//! trigger reads.
//!
//! Parsed through `formats::xml_to_json`, the same reader the Convertir node uses, and normalised to
//! one shape whatever the dialect: `id`, `title`, `link`, `published`, `updated`, `summary`,
//! `author`, `categories`, `enclosure`. Dates come back as RFC 3339 when the feed's own (RFC 822 for
//! RSS, ISO 8601 for Atom) can be read, as written otherwise.

use std::time::Duration;

use serde_json::{json, Value};

use super::formats::xml_to_json;
use super::{text, NodeCtx, NodeError, Ports};
use crate::flows::run::Item;

/// The text of a value that may be a string, an object with `#text` (a title with `type="html"`), or
/// a list of those (the first wins).
fn string_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Object(map)) => map.get("#text").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        Some(Value::Array(list)) => string_of(list.first()),
        _ => String::new(),
    }
}

fn list_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(list)) => list.clone(),
        Some(other) => vec![other.clone()],
        None => vec![],
    }
}

/// RFC 822 (RSS) or RFC 3339 (Atom) to RFC 3339; anything else as written.
fn date_of(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc2822(raw) {
        return parsed.to_rfc3339();
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return parsed.to_rfc3339();
    }
    raw.to_string()
}

/// An Atom `<link>` list: the `alternate` one (or the first with no `rel`).
fn atom_link(value: Option<&Value>) -> String {
    let links = list_of(value);
    let href = |link: &Value| link.get("@href").and_then(Value::as_str).unwrap_or_default().to_string();
    links
        .iter()
        .find(|link| matches!(link.get("@rel").and_then(Value::as_str), None | Some("alternate")))
        .or_else(|| links.first())
        .map(href)
        .unwrap_or_else(|| string_of(value))
}

fn rss_entry(item: &Value) -> Value {
    let guid = string_of(item.get("guid"));
    let link = string_of(item.get("link"));
    let enclosure = item.get("enclosure").map(|e| {
        json!({
            "url": e.get("@url").and_then(Value::as_str).unwrap_or_default(),
            "type": e.get("@type").and_then(Value::as_str).unwrap_or_default(),
            "length": e.get("@length").and_then(Value::as_str).unwrap_or_default(),
        })
    });
    json!({
        "id": if guid.is_empty() { link.clone() } else { guid },
        "title": string_of(item.get("title")),
        "link": link,
        "published": date_of(&string_of(item.get("pubDate").or_else(|| item.get("dc:date")))),
        "updated": "",
        "summary": string_of(item.get("content:encoded").or_else(|| item.get("description"))),
        "author": string_of(item.get("dc:creator").or_else(|| item.get("author"))),
        "categories": list_of(item.get("category")).iter().map(|c| json!(string_of(Some(c)))).collect::<Vec<_>>(),
        "enclosure": enclosure,
    })
}

fn atom_entry(entry: &Value) -> Value {
    let link = atom_link(entry.get("link"));
    let id = string_of(entry.get("id"));
    let author = entry.get("author").map(|a| string_of(a.get("name")).to_string()).unwrap_or_default();
    json!({
        "id": if id.is_empty() { link.clone() } else { id },
        "title": string_of(entry.get("title")),
        "link": link,
        "published": date_of(&string_of(entry.get("published").or_else(|| entry.get("updated")))),
        "updated": date_of(&string_of(entry.get("updated"))),
        "summary": string_of(entry.get("content").or_else(|| entry.get("summary"))),
        "author": author,
        "categories": list_of(entry.get("category")).iter().map(|c| json!(c.get("@term").and_then(Value::as_str).unwrap_or_default())).collect::<Vec<_>>(),
        "enclosure": Value::Null,
    })
}

/// The feed's title and its entries, newest first as the feed lists them.
pub fn parse(xml: &str) -> Result<(Value, Vec<Value>), String> {
    let tree = xml_to_json(xml)?;
    if let Some(rss) = tree.get("rss") {
        let channel = rss.get("channel").cloned().unwrap_or(Value::Null);
        let meta = json!({"title": string_of(channel.get("title")), "link": string_of(channel.get("link")), "format": "rss"});
        return Ok((meta, list_of(channel.get("item")).iter().map(rss_entry).collect()));
    }
    if let Some(feed) = tree.get("feed") {
        let meta = json!({"title": string_of(feed.get("title")), "link": atom_link(feed.get("link")), "format": "atom"});
        return Ok((meta, list_of(feed.get("entry")).iter().map(atom_entry).collect()));
    }
    if let Some(rdf) = tree.get("rdf:RDF") {
        let channel = rdf.get("channel").cloned().unwrap_or(Value::Null);
        let meta = json!({"title": string_of(channel.get("title")), "link": string_of(channel.get("link")), "format": "rdf"});
        return Ok((meta, list_of(rdf.get("item")).iter().map(rss_entry).collect()));
    }
    Err("This is XML, but not an RSS, Atom or RDF feed".into())
}

/// Fetches and parses a feed.
pub async fn fetch(url: &str) -> Result<(Value, Vec<Value>), String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("CodeFlow/", env!("CARGO_PKG_VERSION"), " (+feeds)"))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status().as_u16()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    parse(&body)
}

/// «Leer feed»: the feed's entries, one item each, the feed's own title beside every one.
pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let url = text(params, "feedUrl");
        if url.trim().is_empty() {
            return Err(NodeError::failed("Write the feed's address"));
        }
        let limit = params.get("entryLimit").and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n as usize).unwrap_or(20);
        let (meta, entries) = fetch(url.trim()).await.map_err(NodeError::Failed)?;
        for mut entry in entries.into_iter().take(limit) {
            entry["feed"] = meta.clone();
            out.push(if ctx.items().is_empty() { Item::new(entry) } else { Item::paired(entry, index) });
        }
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_atom_and_rdf_read_the_same() {
        let rss = r#"<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Blog</title><link>https://example.com</link>
            <item><title>Uno &amp; dos</title><link>https://example.com/1</link><guid>id-1</guid><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate><description>Hola</description><dc:creator>Ana</dc:creator><category>rust</category><category>flows</category></item>
            <item><title>Tres</title><link>https://example.com/3</link></item></channel></rss>"#;
        let (meta, entries) = parse(rss).unwrap();
        assert_eq!(meta["title"], "Blog");
        assert_eq!(entries[0]["id"], "id-1");
        assert_eq!(entries[0]["title"], "Uno & dos");
        assert_eq!(entries[0]["author"], "Ana");
        assert_eq!(entries[0]["categories"], json!(["rust", "flows"]));
        assert!(entries[0]["published"].as_str().unwrap().starts_with("2026-10-06T10:00:00"));
        assert_eq!(entries[1]["id"], "https://example.com/3", "no guid: the link is the id");

        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Changelog</title><link rel="self" href="https://example.com/feed"/><link href="https://example.com"/>
            <entry><id>urn:1</id><title>v2</title><link rel="alternate" href="https://example.com/v2"/><updated>2026-10-05T08:00:00Z</updated><author><name>Bo</name></author><category term="release"/></entry></feed>"#;
        let (meta, entries) = parse(atom).unwrap();
        assert_eq!(meta["link"], "https://example.com");
        assert_eq!(entries[0]["link"], "https://example.com/v2");
        assert_eq!(entries[0]["author"], "Bo");
        assert_eq!(entries[0]["categories"], json!(["release"]));

        let rdf = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>Old</title></channel><item><title>A</title><link>https://example.com/a</link></item></rdf:RDF>"#;
        let (_, entries) = parse(rdf).unwrap();
        assert_eq!(entries[0]["title"], "A");
        assert!(parse("<html/>").is_err());
    }
}
