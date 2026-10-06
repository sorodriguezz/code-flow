//! The form a manual run asks for — the manual trigger's `fields`.
//!
//! **Asked before the run, given to the trigger.** Ejecutar (and every other way a person starts a
//! run from the trigger: up to a node, a step, the explorer, the schedule list) shows the form when
//! the trigger the plan starts from has fields; the values become the trigger's one item. A run that
//! nobody filled a form for — started from somewhere that cannot ask — gets each field's default,
//! and fails, naming the field, when a required one has none.
//!
//! **Typed here, not trusted from the window.** The values come back from a webview as JSON, and
//! the form's widgets already give a number for a number; but a value is checked against its field
//! on this side anyway, so `{{ $json.cantidad + 1 }}` downstream adds instead of concatenating
//! whatever a hand-edited call sent.

use serde::Serialize;
use serde_json::{Map, Value};

/// One field: `name` is the key of the item; `type` is `text`, `longText`, `number`, `boolean`,
/// `select` (from `options`) or `date` (`YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub required: bool,
    pub default: Value,
    pub options: Vec<String>,
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// The fields of a manual trigger's `params`, those with a name, each name once.
pub fn fields_of(params: &Value) -> Vec<FormField> {
    let mut seen = std::collections::HashSet::new();
    params
        .get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let name = text_of(row.get("name")).trim().to_string();
            if name.is_empty() || !seen.insert(name.clone()) {
                return None;
            }
            let kind = match text_of(row.get("type")).as_str() {
                kind @ ("longText" | "number" | "boolean" | "select" | "date") => kind.to_string(),
                _ => "text".to_string(),
            };
            let options = text_of(row.get("options"))
                .split(',')
                .map(|option| option.trim().to_string())
                .filter(|option| !option.is_empty())
                .collect();
            let label = text_of(row.get("label")).trim().to_string();
            Some(FormField {
                label: if label.is_empty() { name.clone() } else { label },
                name,
                kind,
                required: row.get("required").and_then(Value::as_bool).unwrap_or(false),
                default: row.get("default").cloned().unwrap_or(Value::Null),
                options,
            })
        })
        .collect()
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        _ => false,
    }
}

/// One value as its field's type — `Ok(None)` for a blank one.
fn typed(field: &FormField, value: &Value) -> Result<Option<Value>, String> {
    if is_blank(value) {
        return Ok(None);
    }
    let text = text_of(Some(value));
    let fail = |what: &str| Err(format!("\"{}\" must be {what}", field.label));
    Ok(Some(match field.kind.as_str() {
        "number" => match value {
            Value::Number(_) => value.clone(),
            _ => match text.trim().replace(',', ".").parse::<f64>() {
                Ok(n) if n.is_finite() => serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null),
                _ => return fail("a number"),
            },
        },
        "boolean" => match value {
            Value::Bool(_) => value.clone(),
            _ => match text.trim().to_lowercase().as_str() {
                "true" | "sí" | "si" | "yes" | "1" => Value::Bool(true),
                "false" | "no" | "0" => Value::Bool(false),
                _ => return fail("yes or no"),
            },
        },
        "select" => {
            if !field.options.is_empty() && !field.options.iter().any(|option| *option == text) {
                return fail(&format!("one of {}", field.options.join(", ")));
            }
            Value::String(text)
        }
        "date" => {
            if chrono::NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").is_err() {
                return fail("a date (YYYY-MM-DD)");
            }
            Value::String(text.trim().to_string())
        }
        _ => Value::String(text),
    }))
}

/// The trigger's item from what the form gave — each field typed, a blank one taking its default, a
/// boolean left blank being `false`. Keys that are not fields are dropped.
pub fn coerce(fields: &[FormField], input: &Value) -> Result<Value, String> {
    let mut out = Map::new();
    for field in fields {
        let given = typed(field, input.get(&field.name).unwrap_or(&Value::Null))?;
        let value = match given {
            Some(value) => value,
            None => match typed(field, &field.default)? {
                Some(value) => value,
                None if field.kind == "boolean" => Value::Bool(false),
                None if field.required => return Err(format!("Fill in \"{}\" to run the flow", field.label)),
                None => Value::Null,
            },
        };
        out.insert(field.name.clone(), value);
    }
    Ok(Value::Object(out))
}

/// What a run nobody filled the form for gets: every default.
pub fn defaults(fields: &[FormField]) -> Result<Value, String> {
    coerce(fields, &Value::Object(Map::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields() -> Vec<FormField> {
        fields_of(&json!({"fields": [
            {"name": "cliente", "label": "Cliente", "type": "text", "required": true},
            {"name": "cantidad", "type": "number", "default": "3"},
            {"name": "urgente", "type": "boolean"},
            {"name": "region", "type": "select", "options": "norte, sur", "default": "sur"},
            {"name": "desde", "type": "date"},
            {"name": "", "type": "text"},
            {"name": "cliente", "type": "number"},
        ]}))
    }

    #[test]
    fn fields_are_read_once_each_with_a_label_and_a_type() {
        let fields = fields();
        assert_eq!(fields.len(), 5, "no name, and the second \"cliente\", are dropped");
        assert_eq!(fields[1].label, "cantidad");
        assert_eq!(fields[3].options, vec!["norte", "sur"]);
        assert_eq!(fields_of(&json!({"fields": [{"name": "x", "type": "weird"}]}))[0].kind, "text");
    }

    #[test]
    fn values_are_typed_and_blanks_take_their_defaults() {
        let item = coerce(&fields(), &json!({"cliente": "ACME", "cantidad": "12,5", "urgente": true, "desde": "2026-10-05", "extra": 1})).unwrap();
        assert_eq!(item, json!({"cliente": "ACME", "cantidad": 12.5, "urgente": true, "region": "sur", "desde": "2026-10-05"}));
        let item = coerce(&fields(), &json!({"cliente": "ACME"})).unwrap();
        assert_eq!((item["cantidad"].as_f64(), &item["urgente"], &item["desde"]), (Some(3.0), &json!(false), &Value::Null));
    }

    #[test]
    fn a_wrong_value_or_a_missing_required_one_says_which_field() {
        let error = |input: Value| coerce(&fields(), &input).unwrap_err();
        assert!(error(json!({})).contains("Cliente"));
        assert!(error(json!({"cliente": "A", "cantidad": "muchos"})).contains("number"));
        assert!(error(json!({"cliente": "A", "region": "este"})).contains("norte, sur"));
        assert!(error(json!({"cliente": "A", "desde": "05/10/2026"})).contains("date"));
        assert!(defaults(&fields()).unwrap_err().contains("Cliente"));
        assert_eq!(defaults(&[]).unwrap(), json!({}));
    }
}
