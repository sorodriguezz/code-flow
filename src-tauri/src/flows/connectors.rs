//! Declarative connectors — Slack, Discord, Telegram, Notion, Jira, GitHub, Trello, Linear, Vercel, Netlify,
//! Cloudflare, Supabase, Sentry, Teams, Google Chat and Mattermost — as JSON, one node to call them.
//!
//! **A connector is data, not code.** Each file in `connectors/` names a service's base URL, how it
//! signs in, and its operations — method, path, the fields a person fills in, the JSON body with
//! `{{field}}` where those go, and where in the answer the useful part is. Adding a service is adding
//! a file; the "Conector" node (`net.connector`) and its form read whatever is here.
//!
//! **Secrets are credentials, never fields.** A field's value is saved in the flow document (and
//! exported with it); the token, the password or a webhook URL that is its own key comes from a
//! flow credential, which lives in the keychain. `{{secret}}` is how a definition places one.
//!
//! **Templates, not string concatenation.** A placeholder that is a whole JSON string takes the
//! field's value as it is (a number stays a number, a `json` field is parsed); inside a longer string
//! it is spliced as text. A key can be a placeholder too (Notion's title property). An optional field
//! left empty takes its key out of the body and the query rather than sending `""` — and an object
//! with `"$when": "field"` goes whole when that field is empty (a Jira description is a document,
//! not a string: half of one is an error), as does a list emptied that way.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Text in both of the app's languages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
    pub es: String,
    pub en: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    pub label: Label,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub multiline: bool,
    /// Parsed as JSON when it fills a whole value (a Notion filter).
    #[serde(default)]
    pub json: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub name: Label,
    pub method: String,
    /// Appended to the connector's base URL…
    #[serde(default)]
    pub path: String,
    /// …or the whole URL, from a field (a Discord webhook).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub query: Map<String, Value>,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub body: Option<Value>,
    /// Where in the answer the result is (`messages`, `issues`, `data.issues.nodes`); an array
    /// becomes one item each.
    #[serde(default)]
    pub result: String,
    /// Headers this operation adds to the connector's (Supabase's `Prefer`).
    #[serde(default)]
    pub headers: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// How it signs in, and so which credentials fit: `bearer` (a token in the header), `basic`
    /// (user and password), `path` (a token the URL carries as `{{secret}}`: Telegram), `url` (the
    /// whole URL is the secret: a Discord webhook), `headers` (a token placed by the connector's own
    /// headers as `{{secret}}`: Linear's bare key, Supabase's two headers) or `query` (a user and a
    /// secret placed in the query by `authQuery`: Trello's key and token). Never a field — what a
    /// node's fields hold is saved in the flow, and a secret does not belong there.
    pub auth: String,
    pub auth_hint: Label,
    /// A field every operation has, filled once (Jira's site).
    #[serde(default)]
    pub site_field: Option<Field>,
    #[serde(default)]
    pub headers: Map<String, Value>,
    /// With `auth: query`, the parameters that carry the credential: `{{user}}` and `{{secret}}`.
    #[serde(default)]
    pub auth_query: Map<String, Value>,
    /// A boolean the service answers with, `false` on failure (Slack's `ok`).
    #[serde(default)]
    pub ok_field: String,
    /// A field whose presence means failure even on a 200 — a GraphQL `errors`.
    #[serde(default)]
    pub fail_on: String,
    /// Where the service puts its error message.
    #[serde(default)]
    pub error_field: String,
    pub operations: Vec<Operation>,
}

impl Connector {
    /// The credential kinds that can sign this connector in; empty when it needs none.
    pub fn credential_kinds(&self) -> &'static [&'static str] {
        match self.auth.as_str() {
            "bearer" => &["bearer", "oauth2"],
            "path" | "headers" => &["bearer"],
            "basic" | "query" => &["basic"],
            "url" => &["webhook"],
            _ => &[],
        }
    }

    pub fn operation(&self, id: &str) -> Option<&Operation> {
        self.operations.iter().find(|op| op.id == id)
    }

    /// The fields an operation shows: the connector's own (the site) first.
    pub fn fields_of<'a>(&'a self, operation: &'a Operation) -> Vec<&'a Field> {
        self.site_field.iter().chain(operation.fields.iter()).collect()
    }
}

const SOURCES: &[&str] = &[
    include_str!("connectors/slack.json"),
    include_str!("connectors/discord.json"),
    include_str!("connectors/telegram.json"),
    include_str!("connectors/notion.json"),
    include_str!("connectors/jira.json"),
    include_str!("connectors/github.json"),
    include_str!("connectors/trello.json"),
    include_str!("connectors/linear.json"),
    include_str!("connectors/vercel.json"),
    include_str!("connectors/netlify.json"),
    include_str!("connectors/cloudflare.json"),
    include_str!("connectors/supabase.json"),
    include_str!("connectors/sentry.json"),
    include_str!("connectors/teams.json"),
    include_str!("connectors/googlechat.json"),
    include_str!("connectors/mattermost.json"),
];

pub static CONNECTORS: LazyLock<Vec<Connector>> =
    LazyLock::new(|| SOURCES.iter().map(|text| serde_json::from_str(text).expect("a shipped connector parses")).collect());

pub fn find(id: &str) -> Option<&'static Connector> {
    CONNECTORS.iter().find(|connector| connector.id == id)
}

/// A field's value as text.
fn as_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `text` with every `{{name}}` replaced by its value, as text.
pub fn splice(text: &str, values: &Map<String, Value>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start + 2..].find("}}") else { break };
        out.push_str(&rest[..start]);
        let name = rest[start + 2..start + 2 + end].trim();
        out.push_str(&as_text(values.get(name).unwrap_or(&Value::Null)));
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    out
}

/// The placeholder a string is made of entirely, if it is one.
fn whole(text: &str) -> Option<&str> {
    let inner = text.strip_prefix("{{")?.strip_suffix("}}")?;
    (!inner.contains("{{")).then(|| inner.trim())
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

/// The key that makes an object conditional on a field.
const WHEN: &str = "$when";

/// A body or query template filled in. `None` for a value that came out empty — its key goes.
pub fn render(template: &Value, values: &Map<String, Value>, json_fields: &[&str]) -> Result<Option<Value>, String> {
    Ok(match template {
        Value::String(text) => match whole(text) {
            Some(name) => {
                let value = values.get(name).cloned().unwrap_or(Value::Null);
                if is_empty(&value) {
                    None
                } else if json_fields.contains(&name) {
                    match value {
                        Value::String(raw) => Some(serde_json::from_str(&raw).map_err(|e| format!("“{name}” is not valid JSON: {e}"))?),
                        other => Some(other),
                    }
                } else {
                    Some(value)
                }
            }
            None => Some(Value::String(splice(text, values))),
        },
        Value::Object(map) => {
            if let Some(Value::String(field)) = map.get(WHEN) {
                if is_empty(values.get(field.as_str()).unwrap_or(&Value::Null)) {
                    return Ok(None);
                }
            }
            let mut out = Map::new();
            for (key, entry) in map.iter().filter(|(key, _)| key.as_str() != WHEN) {
                if let Some(value) = render(entry, values, json_fields)? {
                    out.insert(splice(key, values), value);
                }
            }
            Some(Value::Object(out))
        }
        Value::Array(list) => {
            let mut out = Vec::new();
            for entry in list {
                if let Some(value) = render(entry, values, json_fields)? {
                    out.push(value);
                }
            }
            (out.len() == list.len() || !out.is_empty()).then_some(Value::Array(out))
        }
        other => Some(other.clone()),
    })
}

/// The connectors as the form needs them — every definition, unchanged.
pub fn all() -> &'static [Connector] {
    &CONNECTORS
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn every_shipped_connector_parses_and_its_placeholders_name_its_fields() {
        assert_eq!(all().len(), 16);
        for connector in all() {
            assert!(connector.auth == "none" || !connector.credential_kinds().is_empty(), "{} signs in with {}", connector.id, connector.auth);
            for operation in &connector.operations {
                let names: Vec<String> =
                    connector.fields_of(operation).iter().map(|f| f.name.clone()).chain(["secret".to_string(), "user".to_string()]).collect();
                let text = format!(
                    "{} {} {} {} {} {} {} {}",
                    connector.base_url,
                    operation.path,
                    operation.url,
                    Value::Object(operation.query.clone()),
                    operation.body.clone().unwrap_or(Value::Null),
                    Value::Object(connector.headers.clone()),
                    Value::Object(operation.headers.clone()),
                    Value::Object(connector.auth_query.clone()),
                );
                let mut rest = text.as_str();
                while let Some(start) = rest.find("{{") {
                    let end = rest[start..].find("}}").unwrap();
                    let name = rest[start + 2..start + end].trim();
                    assert!(names.iter().any(|n| n == name), "{}.{}: {{{{{name}}}}}", connector.id, operation.id);
                    rest = &rest[start + end + 2..];
                }
            }
        }
    }

    #[test]
    fn templates_keep_types_parse_json_fields_and_drop_empty_optionals() {
        let values: Map<String, Value> = serde_json::from_value(json!({
            "channel": "#ventas", "text": "Hola {{x}}", "limit": 20, "thread_ts": "", "titleProperty": "Name", "filter": "{\"property\":\"Done\"}"
        }))
        .unwrap();
        let body = json!({"channel": "{{channel}}", "text": "Pedido: {{text}}", "thread_ts": "{{thread_ts}}", "limit": "{{limit}}",
                          "properties": {"{{titleProperty}}": {"title": "x"}}, "filter": "{{filter}}"});
        let rendered = render(&body, &values, &["filter"]).unwrap().unwrap();
        assert_eq!(
            rendered,
            json!({"channel": "#ventas", "text": "Pedido: Hola {{x}}", "limit": 20, "properties": {"Name": {"title": "x"}}, "filter": {"property": "Done"}})
        );
        assert_eq!(splice("https://{{site}}.atlassian.net", &values), "https://.atlassian.net");

        let body = json!({"summary": "x", "description": {"$when": "thread_ts", "type": "doc"}, "children": [{"$when": "thread_ts", "a": 1}], "kept": []});
        assert_eq!(render(&body, &values, &[]).unwrap().unwrap(), json!({"summary": "x", "kept": []}));
        let body = json!({"description": {"$when": "channel", "type": "doc", "text": "{{channel}}"}});
        assert_eq!(render(&body, &values, &[]).unwrap().unwrap(), json!({"description": {"type": "doc", "text": "#ventas"}}));
    }
}
