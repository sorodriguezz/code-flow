//! Azure Queue storage.
//!
//! **Not files, and that is the whole reason this is its own module.** A queue has no tree: it has a
//! name, an approximate depth, and messages that are consumed rather than opened. Putting it in the
//! dual-pane browser would mean a pane with one row per queue and nothing to do with it.
//!
//! **Peeking is not receiving, and the difference is the point.** [`peek`] reads the front of the
//! queue and leaves it alone — no visibility timeout, no dequeue count, nothing consumed. That is
//! what an explorer should do by default: looking at a work queue must not take work out of it.
//! [`receive`] is the destructive read, and it is a separate verb that the UI puts behind its own
//! button, because a message received and then dropped on the floor is a message lost.

use serde::Serialize;

use super::super::RemoteHostSpec;
use super::azure::{self, Credential, Service};
use super::rfc1123_seconds;

/// How many messages a peek asks for. The service's maximum, and small enough to render at once.
const PEEK_MAX: usize = 32;

/// One queue in an account.
#[derive(Debug, Clone, Serialize)]
pub struct QueueSummary {
    pub name: String,
    /// What the service last said the depth was.
    ///
    /// Approximate is not a hedge in the name — it is the service's own word. The count is not
    /// transactional, and a queue being drained while this is read reports a number that was true
    /// a moment ago. Showing it as exact would invite arithmetic nobody should do on it.
    pub approximate_count: i64,
}

/// One message, as the panel draws it.
#[derive(Debug, Clone, Serialize)]
pub struct QueueMessage {
    pub id: String,
    /// The body. Azure holds bytes; whether they are text is the producer's business, so a body
    /// that isn't UTF-8 arrives base64 and `text` says which this is.
    pub body: String,
    pub is_text: bool,
    pub inserted_at: u64,
    pub expires_at: u64,
    /// How many times this message has been received and allowed to reappear. A number climbing
    /// here is the signature of a poison message, which is usually why somebody opened this panel.
    pub dequeue_count: i64,
    /// Present only on a received message — deleting one needs it, and a peeked message has none.
    pub pop_receipt: String,
}

/// The account's queues.
pub async fn queues(host_id: &str, spec: &RemoteHostSpec) -> Result<Vec<QueueSummary>, String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut found = Vec::new();
    let mut marker = String::new();

    loop {
        let mut url = azure::endpoint(spec, Service::Queue)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("comp", "list");
            if !marker.is_empty() {
                query.append_pair("marker", &marker);
            }
        }
        let response = azure::send(spec, &credential, "GET", &url, &[], None).await?;
        if !response.status().is_success() {
            return Err(super::explain("list queues", response).await);
        }
        let body = response.text().await.map_err(|e| format!("Couldn't read the queue list: {e}"))?;

        for queue in elements(&body, "Queue") {
            let Some(name) = super::xml_text(&queue, "Name") else { continue };
            found.push(QueueSummary { name, approximate_count: -1 });
        }
        match super::xml_text(&body, "NextMarker") {
            Some(next) if !next.is_empty() => marker = next,
            _ => break,
        }
    }

    // The depth is a separate request per queue — the listing doesn't carry it. Done here rather
    // than lazily in the UI so the panel opens with the one number anybody came for, and a queue
    // whose metadata read fails keeps its -1 rather than taking the whole listing down with it.
    for queue in &mut found {
        queue.approximate_count = depth(spec, &credential, &queue.name).await.unwrap_or(-1);
    }
    Ok(found)
}

async fn depth(spec: &RemoteHostSpec, credential: &Credential, name: &str) -> Result<i64, String> {
    let mut url = queue_url(spec, name)?;
    url.query_pairs_mut().append_pair("comp", "metadata");
    let response = azure::send(spec, credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("read {name}"), response).await);
    }
    Ok(response
        .headers()
        .get("x-ms-approximate-messages-count")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(-1))
}

/// Reads the front of a queue without consuming anything. See the module comment.
pub async fn peek(
    host_id: &str,
    spec: &RemoteHostSpec,
    name: &str,
    count: usize,
) -> Result<Vec<QueueMessage>, String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = messages_url(spec, name)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("peekonly", "true");
        query.append_pair("numofmessages", &count.clamp(1, PEEK_MAX).to_string());
    }
    let response = azure::send(spec, &credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("peek {name}"), response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read {name}: {e}"))?;
    Ok(parse_messages(&body))
}

/// The destructive read: takes messages off the queue for `visibility` seconds.
///
/// They come back when it lapses unless [`delete`] is called with the pop receipt — which is the
/// contract the panel makes visible rather than hiding, because a received message that is never
/// deleted and never handled is the bug this whole service is prone to.
pub async fn receive(
    host_id: &str,
    spec: &RemoteHostSpec,
    name: &str,
    count: usize,
    visibility: u32,
) -> Result<Vec<QueueMessage>, String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = messages_url(spec, name)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("numofmessages", &count.clamp(1, PEEK_MAX).to_string());
        query.append_pair("visibilitytimeout", &visibility.to_string());
    }
    let response = azure::send(spec, &credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("receive from {name}"), response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read {name}: {e}"))?;
    Ok(parse_messages(&body))
}

/// Adds a message to the back of a queue.
pub async fn put(
    host_id: &str,
    spec: &RemoteHostSpec,
    name: &str,
    text: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let url = messages_url(spec, name)?;
    // The envelope is the service's, not ours: a message body is XML-wrapped even though the
    // content is opaque, so `&` and `<` in a payload have to be escaped or the request is malformed.
    let payload = format!("<QueueMessage><MessageText>{}</MessageText></QueueMessage>", escape(text));
    let length = payload.len() as u64;
    let response = azure::send(
        spec,
        &credential,
        "POST",
        &url,
        &[],
        Some((reqwest::Body::from(payload), length)),
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("put a message on {name}"), response).await)
    }
}

/// Deletes one received message. Needs the pop receipt, which only [`receive`] hands out.
pub async fn delete(
    host_id: &str,
    spec: &RemoteHostSpec,
    name: &str,
    message_id: &str,
    pop_receipt: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = messages_url(spec, name)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the message URL".to_string())?
        .push(message_id);
    url.query_pairs_mut().append_pair("popreceipt", pop_receipt);
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain("delete that message", response).await)
    }
}

/// Empties a queue. Irreversible, and the caller is expected to have confirmed.
pub async fn clear(host_id: &str, spec: &RemoteHostSpec, name: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let url = messages_url(spec, name)?;
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("clear {name}"), response).await)
    }
}

/// Creates a queue.
pub async fn create(host_id: &str, spec: &RemoteHostSpec, name: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let url = queue_url(spec, name)?;
    let response = azure::send(spec, &credential, "PUT", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("create {name}"), response).await)
    }
}

/// Deletes a queue and everything in it.
pub async fn remove(host_id: &str, spec: &RemoteHostSpec, name: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let url = queue_url(spec, name)?;
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("delete {name}"), response).await)
    }
}

fn queue_url(spec: &RemoteHostSpec, name: &str) -> Result<url::Url, String> {
    let mut url = azure::endpoint(spec, Service::Queue)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the queue URL".to_string())?
        .pop_if_empty()
        .push(name);
    Ok(url)
}

fn messages_url(spec: &RemoteHostSpec, name: &str) -> Result<url::Url, String> {
    let mut url = queue_url(spec, name)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the messages URL".to_string())?
        .push("messages");
    Ok(url)
}

/// Reads a `<QueueMessagesList>` into rows.
fn parse_messages(document: &str) -> Vec<QueueMessage> {
    elements(document, "QueueMessage")
        .iter()
        .map(|block| {
            let raw = super::xml_text(block, "MessageText").unwrap_or_default();
            // Producers overwhelmingly base64 their payloads, because that is what the .NET client
            // does by default. Decoding when it decodes to text — and saying so — is the difference
            // between a readable message and a wall of base64 the user has to paste elsewhere.
            let (body, is_text) = match base64_text(&raw) {
                Some(text) => (text, true),
                None => (raw.clone(), raw.is_ascii() || std::str::from_utf8(raw.as_bytes()).is_ok()),
            };
            QueueMessage {
                id: super::xml_text(block, "MessageId").unwrap_or_default(),
                body,
                is_text,
                inserted_at: super::xml_text(block, "InsertionTime")
                    .map(|value| rfc1123_seconds(&value))
                    .unwrap_or(0),
                expires_at: super::xml_text(block, "ExpirationTime")
                    .map(|value| rfc1123_seconds(&value))
                    .unwrap_or(0),
                dequeue_count: super::xml_text(block, "DequeueCount")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                pop_receipt: super::xml_text(block, "PopReceipt").unwrap_or_default(),
            }
        })
        .collect()
}

/// The decoded text, if this really is base64 *and* what it decodes to is text.
///
/// Both halves matter. A short word like `dGVzdA` is valid base64 and also a plausible plain
/// message, so decoding on validity alone would mangle payloads that were never encoded; requiring
/// the result to be UTF-8 with no control characters is what keeps that from happening in practice.
fn base64_text(raw: &str) -> Option<String> {
    use base64::Engine as _;
    if raw.trim().is_empty() {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD.decode(raw.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let printable = !text.is_empty()
        && text.chars().all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t');
    printable.then_some(text)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn elements(document: &str, name: &str) -> Vec<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = document;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        found.push(after[..end].to_string());
        rest = &after[end + close.len()..];
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGES: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<QueueMessagesList>
  <QueueMessage>
    <MessageId>5974b586-0df3-4e2d-ad0c-18e3892bfca2</MessageId>
    <InsertionTime>Mon, 04 Mar 2024 10:11:12 GMT</InsertionTime>
    <ExpirationTime>Mon, 11 Mar 2024 10:11:12 GMT</ExpirationTime>
    <DequeueCount>7</DequeueCount>
    <MessageText>eyJqb2IiOiJyZXNpemUifQ==</MessageText>
  </QueueMessage>
</QueueMessagesList>"#;

    #[test]
    fn a_peeked_message_carries_its_dequeue_count_and_no_receipt() {
        let parsed = parse_messages(MESSAGES);
        assert_eq!(parsed.len(), 1);
        // The number that says "this one keeps failing", which is why anybody opens this panel.
        assert_eq!(parsed[0].dequeue_count, 7);
        // A peek consumes nothing, so there is nothing to delete it with.
        assert_eq!(parsed[0].pop_receipt, "");
        assert_eq!(parsed[0].inserted_at, 1709547072);
    }

    /// The .NET client base64s by default, so most real payloads arrive encoded.
    #[test]
    fn a_base64_payload_is_shown_as_the_text_it_is() {
        let parsed = parse_messages(MESSAGES);
        assert_eq!(parsed[0].body, r#"{"job":"resize"}"#);
        assert!(parsed[0].is_text);
    }

    /// …but a plain message that happens to be valid base64 must not be mangled into bytes.
    #[test]
    fn a_payload_that_is_not_really_encoded_is_left_alone() {
        assert_eq!(base64_text("hello world"), None);
        assert_eq!(base64_text(""), None);
        // Decodes cleanly, but to bytes that are not text — so it stays as it arrived.
        assert_eq!(base64_text("//7//g=="), None);
    }

    #[test]
    fn a_body_with_xml_in_it_is_escaped_on_the_way_out() {
        assert_eq!(escape("a & b <c>"), "a &amp; b &lt;c&gt;");
    }
}
