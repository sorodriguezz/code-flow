//! Declarative connectors — Slack, Discord, Telegram, WhatsApp, Teams (a webhook, or a signed-in account
//! through Microsoft Graph), Google Chat, Mattermost, ntfy,
//! Pushover, Twilio, Notion, Jira, GitHub, GitLab, Azure DevOps, Bitbucket, Trello, Linear, Vercel,
//! Netlify, Cloudflare, Supabase and Sentry — as JSON, one node to call them.
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
//!
//! **Asking the service instead of the person.** A field may name a `lookup` — the request that
//! lists what it can be (Linear's teams, a Trello board's lists, the channels of a Teams team) — so
//! the form offers them by name rather than asking for an id; a connector's `test` is the request
//! that says who a credential signs in as. Both are built and signed exactly as a call is
//! (`nodes::connector::lookup`). `tokenUrl` is where a person gets the credential, and `oauth` names
//! the provider and scopes when the service takes a signed-in account rather than a pasted token.

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
    /// Percent-encoded where it lands in the URL's path — a GitLab project written `group/repo`, an
    /// Azure DevOps work item type with a space in it.
    #[serde(default)]
    pub encode: bool,
    /// What an empty field stands for — ntfy's public server, gitlab.com.
    #[serde(default)]
    pub default: String,
    /// The request that lists what it can be, offered by name in the form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookup: Option<Lookup>,
}

/// A request that lists what a field can be, or — a connector's `test` — says who a credential is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    #[serde(default = "get_method")]
    pub method: String,
    #[serde(default)]
    pub path: String,
    /// …or the whole URL (`{{secret}}`: a Discord webhook asked about itself).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub query: Map<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
    /// Where the list (or the account) is in the answer.
    #[serde(default)]
    pub result: String,
    /// A list inside each entry whose members are the choices (each board's `lists`); the entry it
    /// came from reads as `_parent` in the label.
    #[serde(default)]
    pub each: String,
    /// In each entry, the path of what the field takes.
    #[serde(default)]
    pub value: String,
    /// What a person reads: a template over the entry (`{{identifier}} {{title}}`); a path through a
    /// list joins what it finds (`{{members.displayName}}`), a number picks one (`{{title.0.plain_text}}`).
    pub label: String,
    /// The fields it needs filled first — a team's states need the team. The form asks again when
    /// they change.
    #[serde(default)]
    pub needs: Vec<String>,
    /// Other fields a choice fills too, by path in its entry — a GitHub repository brings its owner.
    #[serde(default)]
    pub fills: Map<String, Value>,
}

fn get_method() -> String {
    "GET".into()
}

/// One thing a field can be: what it takes, what a person reads, and what else it fills.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub fills: Map<String, Value>,
}

impl Lookup {
    /// The lookup as an operation, so it is built and signed exactly as a call is. `needs` are its
    /// required fields — a missing one fails as "Fill in Team", not as a broken URL.
    pub fn operation(&self, needs: Vec<Field>) -> Operation {
        Operation {
            id: "lookup".into(),
            name: Label { es: String::new(), en: String::new() },
            method: self.method.clone(),
            path: self.path.clone(),
            url: self.url.clone(),
            query: self.query.clone(),
            fields: needs,
            body: self.body.clone(),
            result: String::new(),
            headers: Map::new(),
            form: false,
        }
    }

    /// The choices an answer holds — entries without a value are left out, a value met twice is
    /// offered once, and an entry whose label came out empty reads as its value.
    pub fn choices(&self, answer: &Value) -> Vec<Choice> {
        let found = if self.result.is_empty() { Some(answer) } else { crate::flows::value::get_path(answer, &self.result) };
        let mut entries: Vec<Value> = match found {
            Some(Value::Array(list)) => list.clone(),
            Some(entry @ Value::Object(_)) => vec![entry.clone()],
            _ => Vec::new(),
        };
        if !self.each.is_empty() {
            entries = entries
                .iter()
                .flat_map(|parent| {
                    let children = crate::flows::value::get_path(parent, &self.each).and_then(Value::as_array).cloned().unwrap_or_default();
                    children.into_iter().map(move |child| {
                        let mut child = if child.is_object() { child } else { serde_json::json!({ "value": child }) };
                        child["_parent"] = parent.clone();
                        child
                    })
                })
                .collect();
        }
        let mut seen = std::collections::HashSet::new();
        entries
            .iter()
            .filter_map(|entry| {
                let value = if self.value.is_empty() { as_text(entry) } else { reach(entry, &self.value) };
                if value.is_empty() || !seen.insert(value.clone()) {
                    return None;
                }
                let label = label_of(entry, &self.label);
                let fills = self
                    .fills
                    .iter()
                    .filter_map(|(field, path)| {
                        let found = reach(entry, path.as_str().unwrap_or_default());
                        (!found.is_empty()).then(|| (field.clone(), Value::String(found)))
                    })
                    .collect();
                Some(Choice { label: if label.is_empty() { value.clone() } else { label }, value, fills })
            })
            .collect()
    }
}

/// `template` over one entry: each `{{path}}` replaced by what is there. A label whose parts were
/// missing loses the separators around them — `{{name}} · {{email}}` without an email is the name.
pub fn label_of(entry: &Value, template: &str) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start + 2..].find("}}") else { break };
        out.push_str(&rest[..start]);
        out.push_str(&reach(entry, rest[start + 2..start + 2 + end].trim()));
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    let out = out.replace("()", "").replace("( )", "");
    // Not `-`: a label may well start with one (a Telegram group's id).
    out.trim_matches(|c: char| c.is_whitespace() || matches!(c, '·' | '–' | ',' | ':')).to_string()
}

/// What a dotted path reaches: through objects by key, through a list by index when the key is a
/// number, and through every entry of it otherwise — joined.
fn reach(value: &Value, path: &str) -> String {
    fn walk(value: &Value, keys: &[&str], out: &mut Vec<String>) {
        match (keys.split_first(), value) {
            (None, Value::Array(list)) => list.iter().for_each(|entry| walk(entry, &[], out)),
            (None, Value::Null) => {}
            (None, other) => {
                let text = as_text(other);
                if !text.is_empty() {
                    out.push(text);
                }
            }
            (Some((key, rest)), Value::Object(map)) => {
                if let Some(next) = map.get(*key) {
                    walk(next, rest, out);
                }
            }
            (Some((key, rest)), Value::Array(list)) => match key.parse::<usize>() {
                Ok(index) => {
                    if let Some(next) = list.get(index) {
                        walk(next, rest, out);
                    }
                }
                Err(_) => list.iter().for_each(|entry| walk(entry, keys, out)),
            },
            _ => {}
        }
    }
    let keys: Vec<&str> = path.split('.').filter(|key| !key.is_empty()).collect();
    let mut out = Vec::new();
    walk(value, &keys, &mut out);
    out.join(", ")
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
    /// The body goes as `application/x-www-form-urlencoded` (Twilio) rather than JSON: each of the
    /// rendered body's fields becomes one pair.
    #[serde(default)]
    pub form: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// The palette sub-heading its entry sits under in the Apps family (`flows.group.<group>`).
    #[serde(default)]
    pub group: String,
    /// How it signs in, and so which credentials fit: `bearer` (a token in the header), `basic`
    /// (user and password), `path` (a token the URL carries as `{{secret}}`: Telegram), `url` (the
    /// whole URL is the secret: a Discord webhook), `headers` (a token placed by the connector's own
    /// headers as `{{secret}}`: Linear's bare key, Supabase's two headers), `query` (a user and a
    /// secret placed in the query by `authQuery`: Trello's key and token) or `body` (a user and a
    /// secret the body template places: Pushover's user key and app token). Never a field — what a
    /// node's fields hold is saved in the flow, and a secret does not belong there. `basic` also
    /// lends its user to the templates as `{{user}}` (Twilio's account SID is part of its paths).
    pub auth: String,
    /// The credential may be left out: a public ntfy topic needs none, a protected one a token.
    #[serde(default)]
    pub auth_optional: bool,
    pub auth_hint: Label,
    /// Where a person gets the credential — the service's token page, or its guide.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token_url: String,
    /// What the two halves of a user-and-secret credential are here (an Atlassian email and API
    /// token, Twilio's account SID and auth token), for the form that creates one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_label: Option<Label>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_label: Option<Label>,
    /// A service signed into with an account rather than a pasted token: the OAuth 2 provider and
    /// the scopes a credential made for it asks for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthHint>,
    /// The request that says who a credential signs in as — the form's "Probar".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<Lookup>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthHint {
    pub provider: String,
    pub scopes: String,
}

impl Connector {
    /// The credential kinds that can sign this connector in; empty when it needs none.
    pub fn credential_kinds(&self) -> &'static [&'static str] {
        match self.auth.as_str() {
            "bearer" => &["bearer", "oauth2"],
            "path" | "headers" => &["bearer"],
            "basic" | "query" | "body" => &["basic"],
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
    include_str!("connectors/discordbot.json"),
    include_str!("connectors/telegram.json"),
    include_str!("connectors/whatsapp.json"),
    include_str!("connectors/ntfy.json"),
    include_str!("connectors/pushover.json"),
    include_str!("connectors/twilio.json"),
    include_str!("connectors/notion.json"),
    include_str!("connectors/jira.json"),
    include_str!("connectors/github.json"),
    include_str!("connectors/gitlab.json"),
    include_str!("connectors/azuredevops.json"),
    include_str!("connectors/bitbucket.json"),
    include_str!("connectors/trello.json"),
    include_str!("connectors/linear.json"),
    include_str!("connectors/vercel.json"),
    include_str!("connectors/netlify.json"),
    include_str!("connectors/cloudflare.json"),
    include_str!("connectors/supabase.json"),
    include_str!("connectors/sentry.json"),
    include_str!("connectors/teams.json"),
    include_str!("connectors/teamsgraph.json"),
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

    /// The `{{name}}`s in `text` that are none of `names`.
    fn strangers(text: &str, names: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("{{") {
            let end = rest[start..].find("}}").unwrap();
            let name = rest[start + 2..start + end].trim();
            if !names.iter().any(|n| n == name) {
                out.push(name.to_string());
            }
            rest = &rest[start + end + 2..];
        }
        out
    }

    #[test]
    fn every_lookup_and_test_reads_fields_the_connector_has() {
        for connector in all() {
            let mut names: Vec<String> = connector.operations.iter().flat_map(|op| op.fields.iter().map(|f| f.name.clone())).collect();
            names.extend(connector.site_field.iter().map(|f| f.name.clone()));
            names.extend(["secret".to_string(), "user".to_string()]);
            let lookups = connector
                .operations
                .iter()
                .flat_map(|op| connector.fields_of(op))
                .filter_map(|field| field.lookup.as_ref().map(|lookup| (field.name.clone(), lookup)))
                .chain(connector.test.iter().map(|test| ("test".to_string(), test)));
            for (field, lookup) in lookups {
                let text = format!(
                    "{} {} {} {}",
                    lookup.path,
                    lookup.url,
                    Value::Object(lookup.query.clone()),
                    lookup.body.clone().unwrap_or(Value::Null)
                );
                assert!(strangers(&text, &names).is_empty(), "{}.{field}: {:?}", connector.id, strangers(&text, &names));
                for need in &lookup.needs {
                    assert!(names.contains(need), "{}.{field} needs {need}", connector.id);
                }
                for target in lookup.fills.keys() {
                    assert!(names.contains(target), "{}.{field} fills {target}", connector.id);
                }
                assert!(!lookup.label.is_empty() && (field == "test" || !lookup.value.is_empty()), "{}.{field}", connector.id);
            }
            if let Some(oauth) = &connector.oauth {
                assert!(connector.credential_kinds().contains(&"oauth2"), "{} signs in with an account but takes no OAuth credential", connector.id);
                assert!(["google", "microsoft"].contains(&oauth.provider.as_str()));
            }
        }
    }

    #[test]
    fn choices_read_lists_nested_lists_labels_and_what_they_fill() {
        let lookup = |value: Value| -> Lookup { serde_json::from_value(value).unwrap() };
        // Trello: a board's lists, labelled with the board.
        let lists = lookup(json!({"each": "lists", "value": "id", "label": "{{_parent.name}} › {{name}}"}));
        let boards = json!([{"name": "Ventas", "lists": [{"id": "l1", "name": "Por hacer"}, {"id": "l2", "name": "Hecho"}]}, {"name": "Vacío"}]);
        assert_eq!(
            lists.choices(&boards),
            vec![
                Choice { value: "l1".into(), label: "Ventas › Por hacer".into(), fills: Map::new() },
                Choice { value: "l2".into(), label: "Ventas › Hecho".into(), fills: Map::new() },
            ]
        );
        // GitHub: a repository fills its owner; a value met twice is offered once.
        let repos = lookup(json!({"value": "name", "label": "{{full_name}}", "fills": {"owner": "owner.login"}}));
        let found = repos.choices(&json!([{"name": "web", "full_name": "acme/web", "owner": {"login": "acme"}}, {"name": "web", "full_name": "other/web"}]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].fills, serde_json::from_value::<Map<String, Value>>(json!({"owner": "acme"})).unwrap());
        // Teams chats: no topic reads as its members; Notion's title is the first of its parts.
        let chats = lookup(json!({"result": "value", "value": "id", "label": "{{topic}} · {{members.displayName}}"}));
        let answer = json!({"value": [{"id": "c1", "topic": null, "members": [{"displayName": "Ana"}, {"displayName": "Luis"}]}, {"id": "c2", "topic": "Ventas", "members": []}]});
        let labels: Vec<String> = chats.choices(&answer).into_iter().map(|c| c.label).collect();
        assert_eq!(labels, vec!["Ana, Luis", "Ventas"]);
        assert_eq!(label_of(&json!({"title": [{"plain_text": "Tareas"}, {"plain_text": "x"}]}), "{{title.0.plain_text}}"), "Tareas");
        assert_eq!(label_of(&json!({"name": "Ana"}), "{{name}} ({{email}})"), "Ana");
        assert_eq!(label_of(&json!({"id": -100123}), "{{id}}"), "-100123");
        // A test answers with the account itself.
        let me = lookup(json!({"result": "data.viewer", "label": "{{name}} · {{email}}"}));
        assert_eq!(me.choices(&json!({"data": {"viewer": {"name": "Ana", "email": "ana@example.com"}}}))[0].label, "Ana · ana@example.com");
    }

    #[test]
    fn every_shipped_connector_parses_and_its_placeholders_name_its_fields() {
        assert_eq!(all().len(), 25);
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
