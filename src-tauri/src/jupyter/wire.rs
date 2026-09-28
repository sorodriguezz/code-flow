//! The Jupyter messaging protocol as it travels over ZeroMQ: one message is a multipart frame list
//!
//! ```text
//! [identities…] "<IDS|MSG>" signature header parent_header metadata content [buffers…]
//! ```
//!
//! where the four JSON frames are signed with HMAC-SHA256 over the connection file's key, and the
//! signature is their MAC in lowercase hex. See
//! <https://jupyter-client.readthedocs.io/en/stable/messaging.html#the-wire-protocol>.
//!
//! **Everything JSON stays JSON.** The header, parent header, metadata and content are carried as
//! `serde_json::Value`s and never parsed into Rust types, because this app does not act on what a
//! kernel says — the notebook does, and what a display message holds is exactly what ends up saved
//! in the `.ipynb`. A typed model would be a filter between the two that drops whatever field it
//! does not know; this is a pipe.

use bytes::Bytes;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

/// The frame that separates the routing identities from the message proper.
pub const DELIMITER: &[u8] = b"<IDS|MSG>";

/// The protocol version this client speaks — what `jupyter_client` sends today.
pub const PROTOCOL_VERSION: &str = "5.3";

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WireError {
    #[error("the message has no <IDS|MSG> delimiter")]
    MissingDelimiter,
    #[error("the message ends before its four JSON frames")]
    TooFewFrames,
    #[error("the message signature does not match its contents")]
    BadSignature,
    #[error("a message frame is not valid JSON: {0}")]
    Json(String),
}

/// One message, either direction.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    /// Routing prefixes. Only a ROUTER on the kernel's side reads them; a client's DEALER sends
    /// none and receives none, so these are empty on everything this app sends and gets.
    pub identities: Vec<Bytes>,
    pub header: Value,
    pub parent_header: Value,
    pub metadata: Value,
    pub content: Value,
    /// Binary side-buffers (widgets use them). Carried, never signed — the spec leaves them out of
    /// the MAC.
    pub buffers: Vec<Bytes>,
}

impl Message {
    /// A fresh request: a new id, this client's session, no parent.
    pub fn request(msg_type: &str, session: &str, content: Value) -> Self {
        Self::with_id(msg_type, session, &uuid::Uuid::new_v4().to_string(), content)
    }

    /// A request whose id the caller chose — the notebook names its executions before sending them,
    /// so the replies can never arrive before it knows what they belong to.
    pub fn with_id(msg_type: &str, session: &str, msg_id: &str, content: Value) -> Self {
        Self {
            identities: Vec::new(),
            header: header(msg_type, session, msg_id),
            parent_header: json!({}),
            metadata: json!({}),
            content,
            buffers: Vec::new(),
        }
    }

    /// A message answering `parent` — an `input_reply` to the kernel's `input_request`.
    pub fn reply_to(parent: &Message, msg_type: &str, session: &str, content: Value) -> Self {
        Self {
            identities: parent.identities.clone(),
            header: header(msg_type, session, &uuid::Uuid::new_v4().to_string()),
            parent_header: parent.header.clone(),
            metadata: json!({}),
            content,
            buffers: Vec::new(),
        }
    }

    pub fn msg_type(&self) -> &str {
        self.header.get("msg_type").and_then(Value::as_str).unwrap_or("")
    }

    pub fn msg_id(&self) -> &str {
        self.header.get("msg_id").and_then(Value::as_str).unwrap_or("")
    }

    /// The id of the request this message answers — how an output finds its cell.
    pub fn parent_msg_id(&self) -> Option<&str> {
        self.parent_header.get("msg_id").and_then(Value::as_str).filter(|id| !id.is_empty())
    }
}

fn header(msg_type: &str, session: &str, msg_id: &str) -> Value {
    json!({
        "msg_id": msg_id,
        "session": session,
        "username": "codeflow",
        "date": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        "msg_type": msg_type,
        "version": PROTOCOL_VERSION,
    })
}

/// Signs and checks messages with the connection's key. An empty key is the protocol's "signing
/// disabled", and then every signature is the empty string.
#[derive(Clone)]
pub struct Signer {
    key: Vec<u8>,
}

impl Signer {
    pub fn new(key: &str) -> Self {
        Self { key: key.as_bytes().to_vec() }
    }

    fn mac(&self) -> Option<Hmac<Sha256>> {
        if self.key.is_empty() {
            return None;
        }
        // HMAC takes a key of any length; `new_from_slice` only refuses for MACs that cannot.
        Hmac::<Sha256>::new_from_slice(&self.key).ok()
    }

    /// The signature for these frames: the MAC over their concatenation, lowercase hex.
    pub fn sign(&self, parts: &[&[u8]]) -> String {
        let Some(mut mac) = self.mac() else { return String::new() };
        for part in parts {
            mac.update(part);
        }
        hex::encode(mac.finalize().into_bytes())
    }

    /// Whether `signature` is right for these frames — compared in constant time, since this is
    /// the check that keeps another local process from speaking for the kernel.
    pub fn verify(&self, parts: &[&[u8]], signature: &[u8]) -> bool {
        let Some(mut mac) = self.mac() else { return true };
        let Ok(expected) = hex::decode(signature) else { return false };
        for part in parts {
            mac.update(part);
        }
        mac.verify_slice(&expected).is_ok()
    }
}

/// A message as the frames a socket sends.
pub fn encode(message: &Message, signer: &Signer) -> Vec<Bytes> {
    let header = Bytes::from(serde_json::to_vec(&message.header).unwrap_or_default());
    let parent = Bytes::from(serde_json::to_vec(&message.parent_header).unwrap_or_default());
    let metadata = Bytes::from(serde_json::to_vec(&message.metadata).unwrap_or_default());
    let content = Bytes::from(serde_json::to_vec(&message.content).unwrap_or_default());
    let signature = signer.sign(&[&header, &parent, &metadata, &content]);

    let mut frames = Vec::with_capacity(message.identities.len() + 6 + message.buffers.len());
    frames.extend(message.identities.iter().cloned());
    frames.push(Bytes::from_static(DELIMITER));
    frames.push(Bytes::from(signature));
    frames.extend([header, parent, metadata, content]);
    frames.extend(message.buffers.iter().cloned());
    frames
}

/// The frames a socket received, checked and read as a message.
pub fn decode(frames: Vec<Bytes>, signer: &Signer) -> Result<Message, WireError> {
    let at = frames.iter().position(|frame| &frame[..] == DELIMITER).ok_or(WireError::MissingDelimiter)?;
    if frames.len() < at + 6 {
        return Err(WireError::TooFewFrames);
    }
    let identities = frames[..at].to_vec();
    let signature = &frames[at + 1];
    let parts = &frames[at + 2..at + 6];
    if !signer.verify(&[&parts[0], &parts[1], &parts[2], &parts[3]], signature) {
        return Err(WireError::BadSignature);
    }
    let json = |frame: &Bytes| -> Result<Value, WireError> {
        // An empty frame is what some kernels send for an empty dict; read it as one.
        if frame.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_slice(frame).map_err(|e| WireError::Json(e.to_string()))
    };
    Ok(Message {
        identities,
        header: json(&parts[0])?,
        parent_header: json(&parts[1])?,
        metadata: json(&parts[2])?,
        content: json(&parts[3])?,
        buffers: frames[at + 6..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231, test case 2 — split across the four frames, because the MAC is over their
    /// concatenation and nothing else: no separators, no lengths.
    #[test]
    fn signs_the_concatenation_of_the_four_frames() {
        let signer = Signer::new("Jefe");
        let signature = signer.sign(&[b"what do ya ", b"want ", b"for ", b"nothing?"]);
        assert_eq!(signature, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    /// A vector computed with Python's own `hmac` module over realistic frames — the reference
    /// implementation `jupyter_client` uses.
    #[test]
    fn matches_pythons_hmac_on_message_frames() {
        let signer = Signer::new("secret-key");
        let signature =
            signer.sign(&[br#"{"msg_id":"a"}"#, b"{}", b"{}", br#"{"code":"1+1"}"#]);
        assert_eq!(signature, "712005a3ddfac00ddc4b5e88335391b3a6ee2873954746371defcd8f11725fad");
    }

    #[test]
    fn an_empty_key_disables_signing() {
        let signer = Signer::new("");
        assert_eq!(signer.sign(&[b"x"]), "");
        assert!(signer.verify(&[b"x"], b"anything"));
    }

    #[test]
    fn a_message_survives_encode_and_decode() {
        let signer = Signer::new("k");
        let mut message = Message::with_id("execute_request", "s1", "m1", json!({"code": "print(1)"}));
        message.buffers.push(Bytes::from_static(b"\x00\x01"));
        let decoded = decode(encode(&message, &signer), &signer).unwrap();
        assert_eq!(decoded, message);
        assert_eq!(decoded.msg_type(), "execute_request");
        assert_eq!(decoded.msg_id(), "m1");
        assert_eq!(decoded.parent_msg_id(), None);
    }

    #[test]
    fn identities_before_the_delimiter_are_kept() {
        let signer = Signer::new("k");
        let mut message = Message::request("status", "s", json!({"execution_state": "idle"}));
        message.identities = vec![Bytes::from_static(b"kernel.abc.status")];
        let decoded = decode(encode(&message, &signer), &signer).unwrap();
        assert_eq!(decoded.identities, message.identities);
    }

    #[test]
    fn a_tampered_frame_is_refused() {
        let signer = Signer::new("k");
        let message = Message::request("stream", "s", json!({"name": "stdout", "text": "hi"}));
        let mut frames = encode(&message, &signer);
        let content = frames.len() - 1;
        frames[content] = Bytes::from_static(br#"{"name":"stdout","text":"forged"}"#);
        assert_eq!(decode(frames, &signer), Err(WireError::BadSignature));
    }

    #[test]
    fn a_message_signed_with_another_key_is_refused() {
        let message = Message::request("stream", "s", json!({}));
        let frames = encode(&message, &Signer::new("theirs"));
        assert_eq!(decode(frames, &Signer::new("ours")), Err(WireError::BadSignature));
    }

    #[test]
    fn a_signature_that_is_not_hex_is_refused_rather_than_panicking() {
        let signer = Signer::new("k");
        let mut frames = encode(&Message::request("status", "s", json!({})), &signer);
        frames[1] = Bytes::from_static(b"not hex at all");
        assert_eq!(decode(frames, &signer), Err(WireError::BadSignature));
    }

    #[test]
    fn malformed_frame_lists_are_errors() {
        let signer = Signer::new("");
        assert_eq!(decode(vec![Bytes::from_static(b"{}")], &signer), Err(WireError::MissingDelimiter));
        let short = vec![Bytes::from_static(DELIMITER), Bytes::new(), Bytes::from_static(b"{}")];
        assert_eq!(decode(short, &signer), Err(WireError::TooFewFrames));
    }

    #[test]
    fn a_reply_carries_its_parent_header() {
        let request = Message::request("input_request", "kernel", json!({"prompt": "name?"}));
        let reply = Message::reply_to(&request, "input_reply", "client", json!({"value": "Ana"}));
        assert_eq!(reply.parent_msg_id(), Some(request.msg_id()));
        assert_eq!(reply.header["session"], "client");
    }
}
