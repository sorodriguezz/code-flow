//! Edit fields, Filter, Sort, Split, Aggregate, Remove duplicates, Date and Text.
//!
//! Date and Text run in the JavaScript (Luxon's dates, JavaScript's regular expressions — what the
//! expressions around them use, so a pattern that works in `{{ }}` works in the node); the rest is
//! here, where ten thousand items cost nothing.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use rand::seq::SliceRandom;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{as_object, get_path, leaf_name, remove_path, set_path, to_number, to_text};

const JS_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "transform.set" => set(ctx).await,
        "transform.filter" => {
            let verdicts = super::logic::test_items(ctx).await?;
            let kept = ctx
                .items()
                .into_iter()
                .enumerate()
                .zip(verdicts)
                .filter(|(_, passed)| *passed)
                .map(|((index, item), _)| Item::paired(item.json.clone(), index))
                .collect();
            Ok(vec![kept])
        }
        "transform.sort" => sort(ctx).await,
        "transform.split" => split(ctx),
        "transform.aggregate" => aggregate(ctx),
        "transform.dedupe" => dedupe(ctx),
        "transform.date" | "transform.text" => {
            let kind = if ctx.node.type_id == "transform.date" { "date" } else { "text" };
            let mut params = ctx.params.clone();
            // Business days need the country's holidays, which the JavaScript cannot fetch: the years
            // around today are handed in with the job (`isBusinessDay` in the prelude).
            if kind == "date" && matches!(text(&params, "operation").as_str(), "addBusinessDays" | "isBusinessDay" | "businessDaysBetween" | "nextBusinessDay") {
                use chrono::Datelike;
                let year = chrono::Local::now().year();
                let country = crate::flows::holidays::country_code(&text(&params, "holidayCountry")).map_err(NodeError::failed)?;
                let holidays = crate::flows::holidays::for_years(&country, (year - 2)..=(year + 3)).await;
                let mut list: Vec<String> = holidays.iter().map(|d| d.format("%Y-%m-%d").to_string()).collect();
                list.sort();
                params["__holidays"] = json!(list);
            }
            let answer = ctx.js_job(json!({"kind": kind, "params": params}), JS_TIMEOUT).await?;
            let produced = answer.as_array().cloned().unwrap_or_default();
            Ok(vec![produced.into_iter().enumerate().map(|(index, json)| Item::paired(json, index)).collect()])
        }
        other => Err(NodeError::failed(format!("{other} is not a transform"))),
    }
}

// ------------------------------------------------------------------------------------- edit fields

/// One assignment's value converted to the type it declares.
fn convert(value: Value, kind: &str, name: &str) -> Result<Value, NodeError> {
    let fail = |what: &str| NodeError::failed(format!("\"{name}\" should be {what}, got {}", to_text(&value)));
    Ok(match kind {
        "string" => Value::String(to_text(&value)),
        "number" => match to_number(&value) {
            Some(n) => crate::flows::value::number(n),
            None if value.is_null() || value == "" => Value::Null,
            None => return Err(fail("a number")),
        },
        "boolean" => match &value {
            Value::Bool(_) => value,
            Value::String(text) => Value::Bool(matches!(text.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "sí" | "si")),
            Value::Number(n) => Value::Bool(n.as_f64().unwrap_or(0.0) != 0.0),
            Value::Null => Value::Bool(false),
            _ => return Err(fail("true or false")),
        },
        "array" | "object" => match &value {
            Value::String(text) if !text.trim().is_empty() => {
                let parsed: Value = serde_json::from_str(text).map_err(|_| fail(if kind == "array" { "a list" } else { "an object" }))?;
                if (kind == "array") != parsed.is_array() {
                    return Err(fail(if kind == "array" { "a list" } else { "an object" }));
                }
                parsed
            }
            Value::Array(_) if kind == "array" => value,
            Value::Object(_) if kind == "object" => value,
            Value::Null => Value::Null,
            _ => return Err(fail(if kind == "array" { "a list" } else { "an object" })),
        },
        _ => value,
    })
}

async fn set(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let include = text(&ctx.params, "include");
    let fields = strings(&ctx.params, "fields");
    let dotted = ctx.params.get("dotNotation").is_none() || flag(&ctx.params, "dotNotation");
    let json_mode = text(&ctx.params, "mode") == "json";
    let rename_mode = text(&ctx.params, "mode") == "rename";
    let items = ctx.items();
    let mut out = Vec::with_capacity(items.len());
    for index in 0..items.len().max(1) {
        let params = &resolved[index.min(resolved.len() - 1)];
        let source = items.get(index).map(|item| item.json.clone()).unwrap_or(json!({}));
        let mut result = match include.as_str() {
            "none" => json!({}),
            "selected" => {
                let mut picked = json!({});
                for field in &fields {
                    if let Some(value) = get_path(&source, field) {
                        set_path(&mut picked, field, value.clone());
                    }
                }
                picked
            }
            "except" => {
                let mut kept = Value::Object(as_object(&source));
                for field in &fields {
                    remove_path(&mut kept, field);
                }
                kept
            }
            _ => Value::Object(as_object(&source)),
        };
        if rename_mode {
            // Each `old → new`: the value moves (dotted paths both sides); a missing field is left alone.
            for (from, to) in super::pairs(params, "renames") {
                let to = to.trim();
                if to.is_empty() || to == from {
                    continue;
                }
                if let Some(value) = get_path(&result, &from).cloned() {
                    remove_path(&mut result, &from);
                    if dotted {
                        set_path(&mut result, to, value);
                    } else if let Value::Object(target) = &mut result {
                        target.insert(to.to_string(), value);
                    }
                }
            }
        } else if json_mode {
            let value = match params.get("json") {
                Some(Value::String(raw)) if !raw.trim().is_empty() => {
                    serde_json::from_str::<Value>(raw).map_err(|e| NodeError::failed(format!("The JSON is not valid: {e}")))?
                }
                Some(Value::String(_)) | None => json!({}),
                Some(other) => other.clone(),
            };
            let Value::Object(map) = value else {
                return Err(NodeError::failed("The JSON must be an object"));
            };
            for (key, value) in map {
                if let Value::Object(target) = &mut result {
                    target.insert(key, value);
                }
            }
        } else {
            for row in params.get("assignments").and_then(Value::as_array).into_iter().flatten() {
                let name = text(row, "name").trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let value = convert(row.get("value").cloned().unwrap_or(Value::Null), &text(row, "type"), &name)?;
                if dotted {
                    set_path(&mut result, &name, value);
                } else if let Value::Object(target) = &mut result {
                    target.insert(name, value);
                }
            }
        }
        out.push(if items.is_empty() { Item::new(result) } else { Item::paired(result, index) });
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------------- sort

/// How two field values order: numbers numerically, text case-insensitively, missing last.
fn compare_values(a: Option<&Value>, b: Option<&Value>) -> Ordering {
    match (a, b) {
        (None | Some(Value::Null), None | Some(Value::Null)) => Ordering::Equal,
        (None | Some(Value::Null), _) => Ordering::Greater,
        (_, None | Some(Value::Null)) => Ordering::Less,
        (Some(a), Some(b)) => match (a, b) {
            (Value::Number(_), Value::Number(_)) | (Value::Bool(_), Value::Bool(_)) => {
                to_number(a).unwrap_or(0.0).total_cmp(&to_number(b).unwrap_or(0.0))
            }
            _ => match (to_number(a), to_number(b)) {
                (Some(x), Some(y)) if !matches!(a, Value::String(s) if s.trim().is_empty()) => x.total_cmp(&y),
                _ => {
                    let (x, y) = (to_text(a), to_text(b));
                    x.to_lowercase().cmp(&y.to_lowercase()).then(x.cmp(&y))
                }
            },
        },
    }
}

async fn sort(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut indexed: Vec<(usize, &Item)> = ctx.items().into_iter().enumerate().collect();
    match text(&ctx.params, "mode").as_str() {
        "random" => indexed.shuffle(&mut rand::rng()),
        "reverse" => indexed.reverse(),
        _ => {
            let keys: Vec<(String, bool)> = ctx
                .params
                .get("keys")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(|row| (text(row, "field").trim().to_string(), text(row, "order") == "desc"))
                        .filter(|(field, _)| !field.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                return Err(NodeError::failed("Choose a field to sort by"));
            }
            indexed.sort_by(|(_, a), (_, b)| {
                for (field, descending) in &keys {
                    let order = compare_values(get_path(&a.json, field), get_path(&b.json, field));
                    let order = if *descending { order.reverse() } else { order };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                Ordering::Equal
            });
        }
    }
    let params = ctx.resolve_once().await?;
    let limit = number(&params, "limit").unwrap_or(0.0).max(0.0) as usize;
    if limit > 0 {
        indexed.truncate(limit);
    }
    Ok(vec![indexed.into_iter().map(|(index, item)| Item::paired(item.json.clone(), index)).collect()])
}

// ------------------------------------------------------------------------------------------ split

fn split(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let field = text(&ctx.params, "field").trim().to_string();
    if field.is_empty() {
        return Err(NodeError::failed("Name the field that holds the list"));
    }
    let keep_rest = text(&ctx.params, "include") == "all";
    let destination = text(&ctx.params, "destination").trim().to_string();
    let destination = if destination.is_empty() { leaf_name(&field) } else { destination };
    let mut out = Vec::new();
    for (index, item) in ctx.items().into_iter().enumerate() {
        let entries = match get_path(&item.json, &field) {
            Some(Value::Array(list)) => list.clone(),
            Some(Value::Null) | None => continue,
            Some(other) => vec![other.clone()],
        };
        for entry in entries {
            let json = if keep_rest {
                let mut base = Value::Object(as_object(&item.json));
                remove_path(&mut base, &field);
                set_path(&mut base, &destination, entry);
                base
            } else if entry.is_object() {
                entry
            } else {
                let mut map = Map::new();
                map.insert(destination.clone(), entry);
                Value::Object(map)
            };
            out.push(Item::paired(json, index));
        }
    }
    Ok(vec![out])
}

// -------------------------------------------------------------------------------------- aggregate

fn aggregate(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let items = ctx.items();
    match text(&ctx.params, "mode").as_str() {
        "all" => {
            let destination = text(&ctx.params, "destination").trim().to_string();
            let destination = if destination.is_empty() { "data".to_string() } else { destination };
            let mut out = json!({});
            set_path(&mut out, &destination, Value::Array(items.iter().map(|item| item.json.clone()).collect()));
            Ok(vec![vec![Item::new(out)]])
        }
        "chunks" => {
            // Lists of `groupSize` items each — a batch API's page, without a loop.
            let size = number(&ctx.params, "groupSize").unwrap_or(10.0).max(1.0) as usize;
            let destination = text(&ctx.params, "destination").trim().to_string();
            let destination = if destination.is_empty() { "data".to_string() } else { destination };
            let groups: Vec<Item> = items
                .chunks(size)
                .enumerate()
                .map(|(index, chunk)| {
                    let mut out = json!({"group": index + 1, "count": chunk.len()});
                    set_path(&mut out, &destination, Value::Array(chunk.iter().map(|item| item.json.clone()).collect()));
                    Item::new(out)
                })
                .collect();
            Ok(vec![groups])
        }
        "fields" => {
            let fields = strings(&ctx.params, "fields");
            if fields.is_empty() {
                return Err(NodeError::failed("Choose the fields to collect"));
            }
            let mut out = json!({});
            for field in &fields {
                let values: Vec<Value> = items.iter().filter_map(|item| get_path(&item.json, field).cloned()).collect();
                set_path(&mut out, &leaf_name(field), Value::Array(values));
            }
            Ok(vec![vec![Item::new(out)]])
        }
        _ => summarize(ctx, &items),
    }
}

fn summarize(ctx: &NodeCtx, items: &[&Item]) -> Result<Ports, NodeError> {
    let group_by = strings(&ctx.params, "groupBy");
    let aggregations: Vec<(String, String, String)> = ctx
        .params
        .get("aggregations")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let op = text(row, "op");
                    let field = text(row, "field").trim().to_string();
                    let label = text(row, "as").trim().to_string();
                    let label = if label.is_empty() {
                        if field.is_empty() { op.clone() } else { format!("{op}_{}", leaf_name(&field)) }
                    } else {
                        label
                    };
                    (op, field, label)
                })
                .collect()
        })
        .unwrap_or_default();
    if aggregations.is_empty() {
        return Err(NodeError::failed("Add at least one aggregation"));
    }

    // Groups in the order they first appear.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (Vec<Value>, Vec<&Item>)> = HashMap::new();
    for item in items {
        let values: Vec<Value> = group_by.iter().map(|field| get_path(&item.json, field).cloned().unwrap_or(Value::Null)).collect();
        let key = Value::Array(values.clone()).to_string();
        let entry = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (values, Vec::new())
        });
        entry.1.push(item);
    }
    if items.is_empty() && group_by.is_empty() {
        order.push("[]".into());
        groups.insert("[]".into(), (vec![], vec![]));
    }

    let mut out = Vec::new();
    for key in order {
        let (values, members) = &groups[&key];
        let mut row = json!({});
        for (field, value) in group_by.iter().zip(values) {
            set_path(&mut row, &leaf_name(field), value.clone());
        }
        for (op, field, label) in &aggregations {
            let picked: Vec<&Value> = if field.is_empty() {
                members.iter().map(|item| &item.json).collect()
            } else {
                members.iter().filter_map(|item| get_path(&item.json, field)).filter(|v| !v.is_null()).collect()
            };
            let numbers: Vec<f64> = picked.iter().filter_map(|v| to_number(v)).collect();
            let result = match op.as_str() {
                "count" => json!(if field.is_empty() { members.len() } else { picked.len() }),
                "countUnique" => {
                    let unique: HashSet<String> = picked.iter().map(|v| v.to_string()).collect();
                    json!(unique.len())
                }
                "sum" => crate::flows::value::number(numbers.iter().sum()),
                "avg" => {
                    if numbers.is_empty() {
                        Value::Null
                    } else {
                        crate::flows::value::number(numbers.iter().sum::<f64>() / numbers.len() as f64)
                    }
                }
                "min" => numbers.iter().copied().reduce(f64::min).map(crate::flows::value::number).unwrap_or(Value::Null),
                "max" => numbers.iter().copied().reduce(f64::max).map(crate::flows::value::number).unwrap_or(Value::Null),
                "first" => picked.first().map(|v| (*v).clone()).unwrap_or(Value::Null),
                "last" => picked.last().map(|v| (*v).clone()).unwrap_or(Value::Null),
                "concat" => Value::String(picked.iter().map(|v| to_text(v)).collect::<Vec<_>>().join(", ")),
                _ => Value::Array(picked.iter().map(|v| (*v).clone()).collect()),
            };
            set_path(&mut row, label, result);
        }
        out.push(Item::new(row));
    }
    Ok(vec![out])
}

// --------------------------------------------------------------------------------------- dedupe

/// The text that makes two items "the same" under the node's settings.
fn identity(item: &Value, compare: &str, fields: &[String]) -> String {
    match compare {
        "fields" => Value::Array(fields.iter().map(|f| get_path(item, f).cloned().unwrap_or(Value::Null)).collect()).to_string(),
        "except" => {
            let mut rest = Value::Object(as_object(item));
            for field in fields {
                remove_path(&mut rest, field);
            }
            canonical(&rest)
        }
        _ => canonical(item),
    }
}

/// JSON with object keys sorted, so `{a, b}` and `{b, a}` read the same.
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys.into_iter().map(|key| format!("{}:{}", Value::String(key.clone()), canonical(&map[key]))).collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(list) => format!("[{}]", list.iter().map(canonical).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

fn fingerprint(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(10).map(|byte| format!("{byte:02x}")).collect()
}

fn dedupe(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let compare = text(&ctx.params, "compare");
    let fields = strings(&ctx.params, "fields");
    if compare != "all" && fields.is_empty() {
        return Err(NodeError::failed("Choose the fields to compare"));
    }
    let across_runs = text(&ctx.params, "scope") == "history";
    let state_key = format!("__dedupe:{}", ctx.node.id);
    let mut history: Vec<String> = if across_runs {
        ctx.run
            .host
            .state_get(&state_key)
            .map_err(NodeError::failed)?
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut seen: HashSet<String> = history.iter().cloned().collect();
    let mut out = Vec::new();
    for (index, item) in ctx.items().into_iter().enumerate() {
        let print = fingerprint(&identity(&item.json, &compare, &fields));
        if seen.insert(print.clone()) {
            history.push(print);
            out.push(Item::paired(item.json.clone(), index));
        }
    }
    if across_runs {
        let keep = number(&ctx.params, "historySize").unwrap_or(10_000.0).clamp(1.0, 1_000_000.0) as usize;
        if history.len() > keep {
            history.drain(..history.len() - keep);
        }
        ctx.run.host.state_set(&state_key, Some(&json!(history))).map_err(NodeError::failed)?;
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_order_numbers_then_text_and_missing_last() {
        assert_eq!(compare_values(Some(&json!(2)), Some(&json!(10))), Ordering::Less);
        assert_eq!(compare_values(Some(&json!("10")), Some(&json!("9"))), Ordering::Greater, "numeric text sorts as numbers");
        assert_eq!(compare_values(Some(&json!("b")), Some(&json!("A"))), Ordering::Greater);
        assert_eq!(compare_values(None, Some(&json!(1))), Ordering::Greater);
    }

    #[test]
    fn identity_ignores_key_order() {
        assert_eq!(identity(&json!({"a": 1, "b": 2}), "all", &[]), identity(&json!({"b": 2, "a": 1}), "all", &[]));
        assert_ne!(
            identity(&json!({"a": 1, "b": 2}), "fields", &["a".into()]),
            identity(&json!({"a": 2, "b": 2}), "fields", &["a".into()])
        );
    }

    #[test]
    fn conversions_follow_the_declared_type() {
        assert_eq!(convert(json!("42"), "number", "n").unwrap(), json!(42));
        assert_eq!(convert(json!("sí"), "boolean", "b").unwrap(), json!(true));
        assert_eq!(convert(json!("[1,2]"), "array", "l").unwrap(), json!([1, 2]));
        assert!(convert(json!("abc"), "number", "n").is_err());
        assert!(convert(json!("{}"), "array", "l").is_err());
    }
}
