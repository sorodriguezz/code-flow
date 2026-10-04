//! Reading and writing inside an item's JSON by path — `customer.address.city`, `lines[0].sku` —
//! the way field names are typed into Edit fields, Sort, Split and the rest.

use serde_json::{Map, Value};

/// A path cut into object keys and array indices. `a.b[2].c` → `a`, `b`, `2`, `c`; a key that is
/// all digits indexes an array when it meets one and is a plain key otherwise.
fn segments(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in path.split('.') {
        let mut rest = part;
        while let Some(open) = rest.find('[') {
            if open > 0 {
                out.push(rest[..open].to_string());
            }
            let Some(close) = rest[open..].find(']') else {
                out.push(rest[open..].to_string());
                rest = "";
                break;
            };
            out.push(rest[open + 1..open + close].trim_matches(|c| c == '"' || c == '\'').to_string());
            rest = &rest[open + close + 1..];
        }
        if !rest.is_empty() {
            out.push(rest.to_string());
        }
    }
    out.retain(|segment| !segment.is_empty());
    out
}

pub fn get_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cursor = value;
    for segment in segments(path) {
        cursor = match cursor {
            Value::Object(map) => map.get(&segment)?,
            Value::Array(list) => list.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cursor)
}

/// Writes `new` at `path`, creating objects on the way. Indices into existing arrays write in
/// place; anything else that is in the way of the path is replaced by an object.
pub fn set_path(value: &mut Value, path: &str, new: Value) {
    let parts = segments(path);
    if !parts.is_empty() {
        set_in(value, &parts, new);
    }
}

fn set_in(cursor: &mut Value, parts: &[String], new: Value) {
    let Some((head, rest)) = parts.split_first() else { return };
    if let Value::Array(list) = cursor {
        if let Ok(index) = head.parse::<usize>() {
            if index < list.len() {
                if rest.is_empty() {
                    list[index] = new;
                } else {
                    set_in(&mut list[index], rest, new);
                }
                return;
            }
        }
    }
    if !cursor.is_object() {
        *cursor = Value::Object(Map::new());
    }
    let Some(map) = cursor.as_object_mut() else { return };
    if rest.is_empty() {
        map.insert(head.clone(), new);
    } else {
        set_in(map.entry(head.clone()).or_insert_with(|| Value::Object(Map::new())), rest, new);
    }
}

/// Removes what sits at `path`, if anything.
pub fn remove_path(value: &mut Value, path: &str) {
    let parts = segments(path);
    let Some((last, parents)) = parts.split_last() else { return };
    let mut cursor = value;
    for segment in parents {
        cursor = match cursor {
            Value::Object(map) => match map.get_mut(segment) {
                Some(next) => next,
                None => return,
            },
            Value::Array(list) => match segment.parse::<usize>().ok().and_then(|i| list.get_mut(i)) {
                Some(next) => next,
                None => return,
            },
            _ => return,
        };
    }
    match cursor {
        Value::Object(map) => {
            map.remove(last);
        }
        Value::Array(list) => {
            if let Ok(index) = last.parse::<usize>() {
                if index < list.len() {
                    list.remove(index);
                }
            }
        }
        _ => {}
    }
}

/// The last segment of a path — what a field is called once it is pulled out of its parents.
pub fn leaf_name(path: &str) -> String {
    segments(path).pop().unwrap_or_else(|| path.to_string())
}

/// A value as text: strings as they are, everything else as JSON.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A value as a number, if it is one or reads as one.
pub fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// A JSON number, an integer when it is one.
pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// An item's JSON as an object, whatever it was: a non-object is wrapped as `{ value }`.
pub fn as_object(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("value".into(), other.clone());
            map
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_read_through_objects_and_arrays() {
        let value = json!({"a": {"b": [{"c": 1}, {"c": 2}]}, "x.y": 3});
        assert_eq!(get_path(&value, "a.b[1].c"), Some(&json!(2)));
        assert_eq!(get_path(&value, "a.b.0.c"), Some(&json!(1)));
        assert_eq!(get_path(&value, "a.missing"), None);
        assert_eq!(get_path(&value, "[\"x.y\"]"), None, "dotted keys are not addressable by path");
    }

    #[test]
    fn paths_write_and_remove() {
        let mut value = json!({"a": [1, 2]});
        set_path(&mut value, "a[1]", json!(5));
        set_path(&mut value, "b.c.d", json!(true));
        set_path(&mut value, "a.x", json!("replaced"));
        assert_eq!(value, json!({"a": {"x": "replaced"}, "b": {"c": {"d": true}}}));
        remove_path(&mut value, "b.c");
        assert_eq!(value, json!({"a": {"x": "replaced"}, "b": {}}));
        assert_eq!(leaf_name("order.lines[0].sku"), "sku");
    }

    #[test]
    fn numbers_stay_integers_when_they_are() {
        assert_eq!(number(3.0), json!(3));
        assert_eq!(number(2.5), json!(2.5));
        assert_eq!(to_number(&json!(" 12 ")), Some(12.0));
    }
}
