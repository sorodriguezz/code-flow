//! The pages the flows' server shows to a person in a browser: a «Formulario web» trigger's form, a
//! waiting run's form («Esperar → un formulario»), and an approval's two buttons — each answered by
//! a POST of the same page.
//!
//! **Never decided by a GET.** Chat apps and mail clients open links to show a preview (Slack's
//! unfurling, Telegram's previews, a corporate mail scanner); an approval decided by opening its link
//! would be approved by a robot. A GET only ever shows the page; the decision is the button's POST.

use serde_json::{Map, Value};

use super::form::FormField;

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// A complete page: the app's look, light or dark as the reader's system is, readable on a phone.
pub fn page(title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>{title}</title>
<style>
:root{{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#667085;--border:#d9dde3;--accent:#4f46e5;--danger:#d92d20;--ok:#079455}}
@media (prefers-color-scheme:dark){{:root{{--bg:#121417;--card:#1b1e23;--text:#e6e8eb;--muted:#9aa3ae;--border:#2c3038;--accent:#8b85ff;--danger:#f97066;--ok:#47cd89}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:32px 16px}}
main{{width:100%;max-width:520px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}}
h1{{font-size:20px;margin:0 0 6px}}p.lead{{color:var(--muted);margin:0 0 20px;white-space:pre-wrap}}
label{{display:block;font-weight:600;font-size:13px;margin:16px 0 6px}}label .req{{color:var(--danger)}}
input,textarea,select{{width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:8px;padding:9px 11px}}
input:focus,textarea:focus,select:focus{{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}}
textarea{{min-height:96px;resize:vertical}}.check{{display:flex;gap:8px;align-items:center;font-weight:400}}.check input{{width:auto}}
.actions{{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}}
button{{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 18px;cursor:pointer;background:var(--accent);color:#fff}}
button.secondary{{background:transparent;color:var(--danger);border:1px solid var(--border)}}button.ok{{background:var(--ok)}}
.error{{color:var(--danger);margin:12px 0 0}}.done{{text-align:center;padding:12px 0}}.done .mark{{font-size:40px}}
footer{{color:var(--muted);font-size:12px;margin-top:22px;text-align:center}}
</style></head><body><main>{body}<footer>CodeFlow · Flujos</footer></main></body></html>"#,
        title = escape(title),
        body = body
    )
}

fn field_html(field: &FormField, value: Option<&str>) -> String {
    let required = if field.required { " required" } else { "" };
    let mark = if field.required { " <span class=\"req\">*</span>" } else { "" };
    let label = if field.label.trim().is_empty() { &field.name } else { &field.label };
    let default = value.map(str::to_string).unwrap_or_else(|| match &field.default {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    });
    let name = escape(&field.name);
    match field.kind.as_str() {
        "longText" => format!("<label for=\"{name}\">{}{mark}</label><textarea id=\"{name}\" name=\"{name}\"{required}>{}</textarea>", escape(label), escape(&default)),
        "boolean" => format!(
            "<label class=\"check\"><input type=\"checkbox\" name=\"{name}\" value=\"true\"{}> {}</label>",
            if matches!(default.as_str(), "true" | "1") { " checked" } else { "" },
            escape(label)
        ),
        "select" => {
            let options: String = field
                .options
                .iter()
                .map(|o| format!("<option{}>{}</option>", if *o == default { " selected" } else { "" }, escape(o)))
                .collect();
            format!("<label for=\"{name}\">{}{mark}</label><select id=\"{name}\" name=\"{name}\"{required}><option value=\"\"></option>{options}</select>", escape(label))
        }
        kind => {
            let input = match kind {
                "number" => "number\" step=\"any",
                "date" => "date",
                _ => "text",
            };
            format!("<label for=\"{name}\">{}{mark}</label><input id=\"{name}\" type=\"{input}\" name=\"{name}\" value=\"{}\"{required}>", escape(label), escape(&default))
        }
    }
}

/// A form page: title, description, the fields, a button — with a message over it when the last
/// submission did not pass (`error`) and the values it carried kept.
pub fn form(title: &str, description: &str, fields: &[FormField], submit: &str, error: Option<&str>, values: &Map<String, Value>) -> String {
    let rows: String = fields
        .iter()
        .map(|f| {
            let value = values.get(&f.name).map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
            field_html(f, value.as_deref())
        })
        .collect();
    let error = error.map(|e| format!("<p class=\"error\">{}</p>", escape(e))).unwrap_or_default();
    let lead = if description.trim().is_empty() { String::new() } else { format!("<p class=\"lead\">{}</p>", escape(description)) };
    page(
        title,
        &format!(
            "<h1>{}</h1>{lead}<form method=\"post\">{rows}{error}<div class=\"actions\"><button type=\"submit\">{}</button></div></form>",
            escape(title),
            escape(if submit.trim().is_empty() { "Enviar" } else { submit })
        ),
    )
}

/// What a submitted form gives: its fields as text (a checkbox not sent is `false`), then typed and
/// checked by [`super::form::coerce`].
pub fn submitted(fields: &[FormField], body: &[u8]) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in url::form_urlencoded::parse(body) {
        out.insert(key.into_owned(), Value::String(value.into_owned()));
    }
    for field in fields.iter().filter(|f| f.kind == "boolean") {
        let on = out.get(&field.name).and_then(Value::as_str).is_some_and(|v| v == "true" || v == "on");
        out.insert(field.name.clone(), Value::Bool(on));
    }
    // Empty optional fields read as absent, so their defaults apply.
    out.retain(|_, v| !matches!(v, Value::String(s) if s.trim().is_empty()));
    out
}

/// An approval's page: the question and two buttons — or, when it was decided, the decision.
pub fn approval(flow: &str, message: &str, preselect: Option<&str>) -> String {
    let approve_first = preselect != Some("reject");
    let approve = "<button class=\"ok\" type=\"submit\" name=\"decision\" value=\"approve\">✓ Aprobar</button>";
    let reject = "<button class=\"secondary\" type=\"submit\" name=\"decision\" value=\"reject\">✕ Rechazar</button>";
    let (first, second) = if approve_first { (approve, reject) } else { (reject, approve) };
    page(
        &format!("Aprobación · {flow}"),
        &format!(
            "<h1>{}</h1><p class=\"lead\">{}</p><form method=\"post\"><label for=\"comment\">Comentario (opcional)</label><textarea id=\"comment\" name=\"comment\"></textarea><div class=\"actions\">{first}{second}</div></form>",
            escape(flow),
            escape(if message.trim().is_empty() { "¿Aprobar para continuar?" } else { message })
        ),
    )
}

/// The page after a submission or a decision.
pub fn done(title: &str, message: &str) -> String {
    page(title, &format!("<div class=\"done\"><div class=\"mark\">✓</div><h1>{}</h1><p class=\"lead\">{}</p></div>", escape(title), escape(message)))
}

/// The page for a link that leads nowhere any more.
pub fn gone(message: &str) -> String {
    page("Flujos", &format!("<div class=\"done\"><div class=\"mark\">·</div><h1>{}</h1></div>", escape(message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields() -> Vec<FormField> {
        super::super::form::fields_of(&json!({"fields": [
            {"name": "nombre", "label": "Nombre", "type": "text", "required": true},
            {"name": "acepta", "label": "Acepto", "type": "boolean"},
            {"name": "plan", "label": "Plan", "type": "select", "options": "básico, pro"},
        ]}))
    }

    #[test]
    fn a_form_escapes_what_it_shows() {
        let html = form("Alta <script>", "", &fields(), "Enviar", Some("falta <b>"), &Map::new());
        assert!(html.contains("Alta &lt;script&gt;"));
        assert!(html.contains("falta &lt;b&gt;"));
        assert!(html.contains("name=\"nombre\""));
        assert!(html.contains("<option>pro</option>"));
    }

    #[test]
    fn submissions_read_checkboxes_and_drop_blanks() {
        let values = submitted(&fields(), b"nombre=Ana+P%C3%A9rez&plan=");
        assert_eq!(values.get("nombre"), Some(&json!("Ana Pérez")));
        assert_eq!(values.get("acepta"), Some(&json!(false)));
        assert!(!values.contains_key("plan"));
    }

    #[test]
    fn an_approval_page_never_decides_on_its_own() {
        let html = approval("Publicar", "¿Publicar el reporte?", Some("reject"));
        assert!(html.contains("method=\"post\""));
        assert!(html.find("value=\"reject\"").unwrap() < html.find("value=\"approve\"").unwrap());
    }
}
