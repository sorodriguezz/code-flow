//! The invitation link: `codeflow://chat-join?d=<base64url(JSON)>`.
//!
//! It carries what a joiner needs before they can talk to the session at all: the project URL and
//! its anon key (public by design: it names the project and authorises nothing), the single-use
//! token, the session's name, and the repositories it needs. The joiner's CodeFlow can say "you are
//! missing sap-connector" *before* spending the token.

use base64::Engine;
use serde::{Deserialize, Serialize};

pub const PREFIX: &str = "codeflow://chat-join";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkRepo {
    /// `repo_identity::canonical_remote` of the repository.
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invitation {
    pub v: u32,
    pub url: String,
    pub key: String,
    pub token: String,
    pub name: String,
    pub host: String,
    pub repos: Vec<LinkRepo>,
    /// What is shared: `""` a workspace chat (and every link made before runs could be shared),
    /// `"run"` an «Equipo» run.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

impl Invitation {
    pub fn is_run(&self) -> bool {
        self.kind == "run"
    }
}

pub fn encode(invitation: &Invitation) -> String {
    let json = serde_json::to_vec(invitation).unwrap_or_default();
    format!("{PREFIX}?d={}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// Finds an invitation anywhere in `text` (a pasted chat message, a link with a trailing slash).
pub fn decode(text: &str) -> Result<Invitation, String> {
    let start = text.find(PREFIX).ok_or("no es un link de invitación de CodeFlow")?;
    let rest = &text[start + PREFIX.len()..];
    let data_at = rest.find("d=").ok_or("al link le falta su contenido")?;
    let data: String = rest[data_at + 2..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data.as_bytes())
        .map_err(|_| "el link está incompleto o dañado".to_string())?;
    let invitation: Invitation = serde_json::from_slice(&bytes).map_err(|_| "el link está incompleto o dañado".to_string())?;
    if invitation.v != 1 {
        return Err("el link es de una versión más nueva de CodeFlow".into());
    }
    if !invitation.url.starts_with("https://") && !invitation.url.starts_with("http://") {
        return Err("el link no apunta a un proyecto válido".into());
    }
    Ok(invitation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Invitation {
        Invitation {
            v: 1,
            url: "https://abc.supabase.co".into(),
            key: "anon".into(),
            token: "t0k3n".into(),
            name: "Reintentos SAP".into(),
            host: "Dev A".into(),
            repos: vec![LinkRepo { key: "github.com/acme/api".into(), name: "api".into() }],
            kind: String::new(),
        }
    }

    #[test]
    fn a_run_invitation_says_so_and_an_old_link_is_a_chat() {
        let run = Invitation { kind: "run".into(), ..sample() };
        assert!(decode(&encode(&run)).unwrap().is_run());
        // A link minted before runs could be shared has no `kind` at all.
        let old = serde_json::json!({ "v": 1, "url": "https://abc.supabase.co", "key": "k", "token": "t", "name": "n", "host": "h", "repos": [] });
        let link = format!("{PREFIX}?d={}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(old.to_string()));
        assert!(!decode(&link).unwrap().is_run());
    }

    #[test]
    fn a_link_survives_a_round_trip_and_surrounding_text() {
        let link = encode(&sample());
        assert!(link.starts_with("codeflow://chat-join?d="));
        assert_eq!(decode(&link).unwrap(), sample());
        assert_eq!(decode(&format!("Únete: {link}/ gracias")).unwrap(), sample());
    }

    #[test]
    fn broken_links_say_so() {
        assert!(decode("hola").is_err());
        assert!(decode("codeflow://chat-join?d=@@@").is_err());
        let mut bad = sample();
        bad.url = "file:///etc".into();
        assert!(decode(&encode(&bad)).is_err());
        bad = sample();
        bad.v = 2;
        assert!(decode(&encode(&bad)).is_err());
    }
}
