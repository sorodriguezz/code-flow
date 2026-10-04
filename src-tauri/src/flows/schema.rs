//! The shape an AI node's answer must take: built from the fields the node lists, checked in Rust.
//!
//! **Strict on purpose.** Codex's `--output-schema` is OpenAI's structured-output mode, which only
//! takes a schema where every property is listed in `required` and nothing else may appear; Claude
//! Code's `--json-schema` takes that too. So an optional field is required-but-nullable here rather
//! than left out of `required`, and the one schema works for every engine that enforces one — and
//! for the ones that do not, it is what the instruction quotes.
//!
//! **Checked here, whatever the engine promised.** The CLIs that enforce a schema enforce it on the
//! model; the ones that do not only ask. Either way the answer is validated before it leaves the
//! node, and a node gets one retry with the validation errors read back to the model.
//!
//! The validator covers what the field builder writes and the common hand-written cases — types,
//! properties, required, `additionalProperties: false`, items, enum and the numeric/length bounds.
//! Anything else in a hand-written schema is accepted rather than guessed at.

use serde_json::{json, Map, Value};

/// A schema from the node's field rows: `[{ name, type, description, required, options }]`, `type`
/// one of `string`, `number`, `integer`, `boolean`, `list` (of strings) or `enum` (`options`, comma
/// separated).
pub fn from_fields(fields: &Value) -> Result<Value, String> {
    let rows = fields.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut properties = Map::new();
    let mut required = Vec::new();
    for row in rows {
        let name = row.get("name").and_then(Value::as_str).unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        if properties.contains_key(name) {
            return Err(format!("The field \"{name}\" is listed twice"));
        }
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("string");
        let mut property = match kind {
            "number" => json!({"type": "number"}),
            "integer" => json!({"type": "integer"}),
            "boolean" => json!({"type": "boolean"}),
            "list" => json!({"type": "array", "items": {"type": "string"}}),
            "enum" => {
                let options: Vec<String> = row
                    .get("options")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .split(',')
                    .map(|option| option.trim().to_string())
                    .filter(|option| !option.is_empty())
                    .collect();
                if options.is_empty() {
                    return Err(format!("The field \"{name}\" is a choice with no options"));
                }
                json!({"type": "string", "enum": options})
            }
            _ => json!({"type": "string"}),
        };
        let description = row.get("description").and_then(Value::as_str).unwrap_or_default().trim();
        if !description.is_empty() {
            property["description"] = json!(description);
        }
        let mandatory = row.get("required").and_then(Value::as_bool).unwrap_or(true);
        if !mandatory {
            nullable(&mut property);
        }
        required.push(json!(name));
        properties.insert(name.to_string(), property);
    }
    if properties.is_empty() {
        return Err("List at least one field for the answer".to_string());
    }
    Ok(json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    }))
}

/// Lets a property be `null` as well — how a strict schema says "optional".
fn nullable(property: &mut Value) {
    if let Some(kind) = property.get("type").and_then(Value::as_str).map(str::to_string) {
        property["type"] = json!([kind, "null"]);
    }
    if let Some(options) = property.get_mut("enum").and_then(Value::as_array_mut) {
        options.push(Value::Null);
    }
}

/// A hand-written schema, parsed and held to the one rule every engine shares: the answer is an
/// object.
pub fn from_text(text: &str) -> Result<Value, String> {
    let schema: Value = serde_json::from_str(text).map_err(|e| format!("The schema is not JSON: {e}"))?;
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err("The schema must describe an object (\"type\": \"object\")".to_string());
    }
    Ok(schema)
}

/// Drops the properties an object may not have (`additionalProperties: false`), at every depth.
///
/// An extra key is not worth a retry: the fields that were asked for are there, and some CLIs add
/// their own around a structured answer — agy 1.2.16 wraps it with `toolAction` and `toolSummary`
/// even under `--json-schema`. What the node hands on is exactly the declared shape.
pub fn prune(value: &mut Value, schema: &Value) {
    match value {
        Value::Object(map) => {
            let properties = schema.get("properties").and_then(Value::as_object);
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                if let Some(properties) = properties {
                    map.retain(|name, _| properties.contains_key(name));
                }
            }
            if let Some(properties) = properties {
                for (name, child) in map.iter_mut() {
                    if let Some(child_schema) = properties.get(name) {
                        prune(child, child_schema);
                    }
                }
            }
        }
        Value::Array(list) => {
            if let Some(items) = schema.get("items") {
                for child in list {
                    prune(child, items);
                }
            }
        }
        _ => {}
    }
}

/// What is wrong with `value` against `schema` — empty when it conforms. Paths are written
/// `$.field[2].name`, the way the retry reads them back to the model.
pub fn validate(value: &Value, schema: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    check(value, schema, "$", &mut errors);
    errors
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_type(value: &Value, wanted: &str) -> bool {
    match wanted {
        "number" => value.is_number(),
        "integer" => match value {
            Value::Number(n) => n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0),
            _ => false,
        },
        other => type_name(value) == other,
    }
}

fn check(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(schema) = schema.as_object() else { return };
    if let Some(wanted) = schema.get("type") {
        let types: Vec<&str> = match wanted {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.is_empty() && !types.iter().any(|t| is_type(value, t)) {
            errors.push(format!("{path}: expected {}, got {}", types.join(" or "), type_name(value)));
            return;
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            let listed: Vec<String> = options.iter().map(|o| o.to_string()).collect();
            errors.push(format!("{path}: must be one of {}", listed.join(", ")));
        }
    }
    match value {
        Value::Object(map) => {
            let properties = schema.get("properties").and_then(Value::as_object);
            for name in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if !map.contains_key(name) {
                    errors.push(format!("{path}.{name}: missing"));
                }
            }
            for (name, child) in map {
                match properties.and_then(|props| props.get(name)) {
                    Some(child_schema) => check(child, child_schema, &format!("{path}.{name}"), errors),
                    None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => {
                        errors.push(format!("{path}.{name}: not allowed"));
                    }
                    None => {}
                }
            }
        }
        Value::Array(list) => {
            if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
                if (list.len() as u64) < min {
                    errors.push(format!("{path}: needs at least {min} items"));
                }
            }
            if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
                if (list.len() as u64) > max {
                    errors.push(format!("{path}: at most {max} items"));
                }
            }
            if let Some(items) = schema.get("items") {
                for (index, child) in list.iter().enumerate() {
                    check(child, items, &format!("{path}[{index}]"), errors);
                }
            }
        }
        Value::String(text) => {
            let length = text.chars().count() as u64;
            if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
                if length < min {
                    errors.push(format!("{path}: at least {min} characters"));
                }
            }
            if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
                if length > max {
                    errors.push(format!("{path}: at most {max} characters"));
                }
            }
        }
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or_default();
            if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
                if number < min {
                    errors.push(format!("{path}: at least {min}"));
                }
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
                if number > max {
                    errors.push(format!("{path}: at most {max}"));
                }
            }
        }
        _ => {}
    }
}

/// The JSON object in a model's answer: the whole answer when it is one, else the first object in
/// it (a fenced block, a sentence around it) — `ai::json_answer`'s reading, repairs included.
pub fn answer_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let candidate = crate::ai::json_answer(trimmed)?;
    match serde_json::from_str::<Value>(&candidate) {
        Ok(value @ Value::Object(_)) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_become_a_strict_schema() {
        let schema = from_fields(&json!([
            {"name": "amount", "type": "number", "description": "Total in CLP", "required": true},
            {"name": "customer", "type": "string", "required": false},
            {"name": "tags", "type": "list"},
            {"name": "priority", "type": "enum", "options": "alta, media,baja"},
            {"name": "", "type": "string"},
        ]))
        .unwrap();
        assert_eq!(schema["required"], json!(["amount", "customer", "tags", "priority"]));
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["customer"]["type"], json!(["string", "null"]));
        assert_eq!(schema["properties"]["priority"]["enum"], json!(["alta", "media", "baja"]));
        assert_eq!(schema["properties"]["amount"]["description"], "Total in CLP");
        assert!(from_fields(&json!([])).is_err());
        assert!(from_fields(&json!([{"name": "a"}, {"name": "a"}])).is_err());
        assert!(from_fields(&json!([{"name": "p", "type": "enum", "options": " , "}])).is_err());
    }

    #[test]
    fn validation_names_every_problem() {
        let schema = from_fields(&json!([
            {"name": "amount", "type": "integer"},
            {"name": "note", "type": "string", "required": false},
            {"name": "level", "type": "enum", "options": "low,high"},
            {"name": "tags", "type": "list"},
        ]))
        .unwrap();
        assert!(validate(&json!({"amount": 3, "note": null, "level": "low", "tags": ["a"]}), &schema).is_empty());
        assert!(validate(&json!({"amount": 3.0, "note": "x", "level": "high", "tags": []}), &schema).is_empty());
        let errors = validate(&json!({"amount": "3", "level": "mid", "tags": [1], "extra": true}), &schema);
        assert!(errors.contains(&"$.amount: expected integer, got string".to_string()), "{errors:?}");
        assert!(errors.contains(&"$.note: missing".to_string()), "{errors:?}");
        assert!(errors.iter().any(|e| e.starts_with("$.level: must be one of")), "{errors:?}");
        assert!(errors.contains(&"$.tags[0]: expected string, got integer".to_string()), "{errors:?}");
        assert!(errors.contains(&"$.extra: not allowed".to_string()), "{errors:?}");
        assert_eq!(validate(&json!([1]), &schema), vec!["$: expected object, got array".to_string()]);
    }

    #[test]
    fn undeclared_keys_are_dropped_not_retried() {
        let schema = from_fields(&json!([{"name": "n", "type": "integer"}])).unwrap();
        let mut answer = json!({"n": 7, "toolAction": "Finalizing response", "toolSummary": "Task completion"});
        prune(&mut answer, &schema);
        assert_eq!(answer, json!({"n": 7}));
        assert!(validate(&answer, &schema).is_empty());
        let open = json!({"type": "object", "properties": {"a": {"type": "object", "properties": {"b": {"type": "string"}}, "additionalProperties": false}}});
        let mut nested = json!({"a": {"b": "x", "c": 1}, "free": true});
        prune(&mut nested, &open);
        assert_eq!(nested, json!({"a": {"b": "x"}, "free": true}), "only where extras are forbidden");
    }

    #[test]
    fn hand_written_schemas_and_answers() {
        assert!(from_text("{\"type\": \"array\"}").is_err());
        assert!(from_text("not json").is_err());
        let schema = from_text(r#"{"type":"object","properties":{"n":{"type":"number","minimum":1,"maximum":5}},"required":["n"]}"#).unwrap();
        assert_eq!(validate(&json!({"n": 9}), &schema), vec!["$.n: at most 5".to_string()]);
        assert_eq!(answer_object("{\"a\": 1}"), Some(json!({"a": 1})));
        assert_eq!(answer_object("Here it is:\n```json\n{\"a\": [1, 2]}\n```"), Some(json!({"a": [1, 2]})));
        assert_eq!(answer_object("no object here"), None);
    }
}
