//! If, Switch, Merge, Wait, Stop and No-op.
//!
//! Conditions are evaluated in the run's JavaScript (`prelude.js`): their left and right sides are
//! expressions over the item, and the operators compare the way a person expects across types —
//! numbers as numbers, dates as instants — which is easier to keep consistent in one place than in
//! two languages.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{number, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{as_object, get_path};

const CONDITION_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "logic.if" => branch_if(ctx).await,
        "logic.switch" => switch(ctx).await,
        "logic.merge" => merge(ctx),
        "logic.wait" => wait(ctx).await,
        "logic.stop" => {
            let params = ctx.resolve_once().await?;
            let message = text(&params, "message");
            Err(NodeError::failed(if message.trim().is_empty() { "Stopped by the flow".to_string() } else { message }))
        }
        // Ends its branch: takes the items, passes nothing on.
        _ => Ok(vec![]),
    }
}

/// Which items pass `conditions`, one boolean per input item.
pub async fn test_items(ctx: &NodeCtx) -> Result<Vec<bool>, NodeError> {
    let spec = ctx.params.get("conditions").cloned().unwrap_or(Value::Null);
    let answer = ctx.js_job(json!({"kind": "conditions", "spec": spec}), CONDITION_TIMEOUT).await?;
    let verdicts: Vec<bool> = answer.as_array().map(|list| list.iter().map(|v| v.as_bool().unwrap_or(false)).collect()).unwrap_or_default();
    if verdicts.len() != ctx.items().len() {
        return Err(NodeError::failed("The conditions did not evaluate for every item"));
    }
    Ok(verdicts)
}

async fn branch_if(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let verdicts = test_items(ctx).await?;
    let mut yes = Vec::new();
    let mut no = Vec::new();
    for (index, (item, passed)) in ctx.items().into_iter().zip(verdicts).enumerate() {
        let routed = Item::paired(item.json.clone(), index);
        if passed {
            yes.push(routed);
        } else {
            no.push(routed);
        }
    }
    Ok(vec![yes, no])
}

async fn switch(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let spec = json!({
        "mode": ctx.params.get("mode").cloned().unwrap_or(json!("rules")),
        "rules": ctx.params.get("rules").cloned().unwrap_or(json!([])),
        "output": ctx.params.get("output").cloned().unwrap_or(Value::Null),
        "allMatching": ctx.params.get("allMatching").cloned().unwrap_or(json!(false)),
        "ignoreCase": ctx.params.get("ignoreCase").cloned().unwrap_or(json!(false)),
    });
    let answer = ctx.js_job(json!({"kind": "switch", "spec": spec}), CONDITION_TIMEOUT).await?;
    let routes = answer.as_array().cloned().unwrap_or_default();
    let mut ports: Ports = vec![Vec::new(); 4];
    for (index, item) in ctx.items().into_iter().enumerate() {
        let hits: Vec<usize> = routes
            .get(index)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_u64).map(|n| n as usize).filter(|n| *n < 4).collect())
            .unwrap_or_default();
        if hits.is_empty() {
            ports[3].push(Item::paired(item.json.clone(), index));
        }
        for hit in hits {
            ports[hit].push(Item::paired(item.json.clone(), index));
        }
    }
    Ok(ports)
}

/// Two objects as one: `winner`'s fields over `loser`'s.
fn combine(loser: &Value, winner: &Value) -> Value {
    let mut merged: Map<String, Value> = as_object(loser);
    for (key, value) in as_object(winner) {
        merged.insert(key, value);
    }
    Value::Object(merged)
}

fn merge(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let first: &[Item] = ctx.inputs.first().map(Vec::as_slice).unwrap_or(&[]);
    let second: &[Item] = ctx.inputs.get(1).map(Vec::as_slice).unwrap_or(&[]);
    let offset = first.len();
    let prefer_second = text(&ctx.params, "prefer") != "input1";
    let pair = |a: &Value, b: &Value| if prefer_second { combine(a, b) } else { combine(b, a) };
    let out: Vec<Item> = match text(&ctx.params, "mode").as_str() {
        "position" => first
            .iter()
            .zip(second.iter())
            .enumerate()
            .map(|(index, (a, b))| Item::paired(pair(&a.json, &b.json), index))
            .collect(),
        "field" => {
            let left_key = text(&ctx.params, "field1");
            let right_key = text(&ctx.params, "field2");
            let right_key = if right_key.trim().is_empty() { left_key.clone() } else { right_key };
            if left_key.trim().is_empty() {
                return Err(NodeError::failed("Name the field to match on"));
            }
            let join = text(&ctx.params, "join");
            let mut matched_right = vec![false; second.len()];
            let mut out = Vec::new();
            for (index, a) in first.iter().enumerate() {
                let key = get_path(&a.json, &left_key);
                let mut found = false;
                for (position, b) in second.iter().enumerate() {
                    if key.is_some() && get_path(&b.json, &right_key) == key {
                        found = true;
                        matched_right[position] = true;
                        out.push(Item::paired(pair(&a.json, &b.json), index));
                    }
                }
                if !found && (join == "left" || join == "outer") {
                    out.push(Item::paired(a.json.clone(), index));
                }
            }
            if join == "outer" {
                for (position, b) in second.iter().enumerate() {
                    if !matched_right[position] {
                        out.push(Item::paired(b.json.clone(), offset + position));
                    }
                }
            }
            out
        }
        "choose" => {
            if text(&ctx.params, "choose") == "input2" {
                second.iter().enumerate().map(|(i, item)| Item::paired(item.json.clone(), offset + i)).collect()
            } else {
                first.iter().enumerate().map(|(i, item)| Item::paired(item.json.clone(), i)).collect()
            }
        }
        _ => first
            .iter()
            .chain(second.iter())
            .enumerate()
            .map(|(i, item)| Item::paired(item.json.clone(), i))
            .collect(),
    };
    Ok(vec![out])
}

/// Execute flow: hands the items to another flow's "called by another flow" trigger. Waiting, the
/// output is that flow's last node's; firing and forgetting, the items pass straight on.
pub async fn subflow(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let target = text(&ctx.params, "flow");
    if target.trim().is_empty() {
        return Err(NodeError::failed("Choose the flow to run"));
    }
    if target == ctx.run.flow_id && ctx.run.depth >= 3 {
        return Err(NodeError::failed("A flow that calls itself stops after three levels"));
    }
    let wait = text(&ctx.params, "mode") != "fire";
    let items: Vec<Item> = ctx.items().into_iter().map(|item| Item::new(item.json.clone())).collect();
    let work = ctx.run.host.subflow(target.trim(), items, wait);
    let produced = tokio::select! {
        result = work => result.map_err(NodeError::failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    if !wait {
        return Ok(vec![ctx.passthrough()]);
    }
    Ok(vec![produced.into_iter().map(|item| Item::new(item.json)).collect()])
}

/// When "until" means: an RFC 3339 instant, or a local date and time without an offset.
fn until_instant(raw: &str) -> Result<chrono::DateTime<chrono::Utc>, NodeError> {
    let raw = raw.trim();
    if let Ok(instant) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(instant.with_timezone(&chrono::Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(local) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            use chrono::TimeZone;
            if let Some(instant) = chrono::Local.from_local_datetime(&local).earliest() {
                return Ok(instant.with_timezone(&chrono::Utc));
            }
        }
    }
    Err(NodeError::failed(format!("\"{raw}\" is not a date and time")))
}

async fn wait(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let duration = if text(&params, "mode") == "until" {
        let target = until_instant(&text(&params, "until"))?;
        (target - chrono::Utc::now()).to_std().unwrap_or_default()
    } else {
        let amount = number(&params, "amount").unwrap_or(0.0).max(0.0);
        let unit = match text(&params, "unit").as_str() {
            "minutes" => 60.0,
            "hours" => 3600.0,
            "days" => 86_400.0,
            _ => 1.0,
        };
        Duration::from_secs_f64((amount * unit).min(30.0 * 86_400.0))
    };
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(vec![ctx.passthrough()]),
        _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_lets_the_winner_overwrite() {
        assert_eq!(combine(&json!({"a": 1, "b": 1}), &json!({"b": 2})), json!({"a": 1, "b": 2}));
    }

    #[test]
    fn until_reads_offsets_and_local_times() {
        assert!(until_instant("2026-12-31T09:00:00Z").is_ok());
        assert!(until_instant("2026-12-31T09:00").is_ok());
        assert!(until_instant("tomorrow").is_err());
    }
}
