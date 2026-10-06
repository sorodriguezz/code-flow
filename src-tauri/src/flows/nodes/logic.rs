//! If, Switch, Merge, Wait, Stop and No-op.
//!
//! Conditions are evaluated in the run's JavaScript (`prelude.js`): their left and right sides are
//! expressions over the item, and the operators compare the way a person expects across types —
//! numbers as numbers, dates as instants — which is easier to keep consistent in one place than in
//! two languages.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{number, text, NodeCtx, NodeError};
use crate::flows::engine::{WaitAnswer, WaitRequest};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{as_object, get_path};

const CONDITION_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "logic.if" => branch_if(ctx).await,
        "logic.switch" => switch(ctx).await,
        "logic.merge" => merge(ctx),
        "logic.wait" => wait(ctx).await,
        "logic.approval" => approval(ctx).await,
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
    // `caseCount` outputs, then "other" — 3 + 1 for every flow saved before it was a setting.
    let cases = crate::flows::catalog::switch_cases(&ctx.params) as usize;
    let mut ports: Ports = vec![Vec::new(); cases + 1];
    for (index, item) in ctx.items().into_iter().enumerate() {
        let hits: Vec<usize> = routes
            .get(index)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_u64).map(|n| n as usize).filter(|n| *n < cases).collect())
            .unwrap_or_default();
        if hits.is_empty() {
            ports[cases].push(Item::paired(item.json.clone(), index));
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

/// Merge: as many inputs as `inputCount` (2 when unset). Appending and choosing take them in
/// order; by position and by field fold them left to right, input 1 with input 2, that with input 3…
/// `prefer` says who wins a field both sides have — `input1` the earlier input, `input2` the later.
fn merge(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let inputs: Vec<&[Item]> = ctx.inputs.iter().map(Vec::as_slice).collect();
    let empty: &[Item] = &[];
    let port = |n: usize| inputs.get(n).copied().unwrap_or(empty);
    // Where each input starts in the concatenation `paired` indexes into.
    let offsets: Vec<usize> = inputs
        .iter()
        .scan(0usize, |sum, list| {
            let at = *sum;
            *sum += list.len();
            Some(at)
        })
        .collect();
    let offset = |n: usize| offsets.get(n).copied().unwrap_or(0);
    let prefer_later = text(&ctx.params, "prefer") != "input1";
    let pair = |a: &Value, b: &Value| if prefer_later { combine(a, b) } else { combine(b, a) };
    let count = inputs.len().max(2);
    let out: Vec<Item> = match text(&ctx.params, "mode").as_str() {
        "position" => {
            let rows = (0..count).map(|n| port(n).len()).min().unwrap_or(0);
            (0..rows)
                .map(|index| {
                    let mut value = port(0)[index].json.clone();
                    for n in 1..count {
                        value = pair(&value, &port(n)[index].json);
                    }
                    Item::paired(value, index)
                })
                .collect()
        }
        "field" => {
            let left_key = text(&ctx.params, "field1");
            let right_key = text(&ctx.params, "field2");
            let right_key = if right_key.trim().is_empty() { left_key.clone() } else { right_key };
            if left_key.trim().is_empty() {
                return Err(NodeError::failed("Name the field to match on"));
            }
            let join = text(&ctx.params, "join");
            // (value, paired index) — the left side keeps pointing at input 1's items.
            let mut acc: Vec<(Value, usize)> = port(0).iter().enumerate().map(|(i, item)| (item.json.clone(), i)).collect();
            for n in 1..count {
                let right = port(n);
                let mut matched_right = vec![false; right.len()];
                let mut next = Vec::new();
                for (left, paired) in &acc {
                    let key = get_path(left, &left_key);
                    let mut found = false;
                    for (position, b) in right.iter().enumerate() {
                        if key.is_some() && get_path(&b.json, &right_key) == key {
                            found = true;
                            matched_right[position] = true;
                            next.push((pair(left, &b.json), *paired));
                        }
                    }
                    if !found && (join == "left" || join == "outer") {
                        next.push((left.clone(), *paired));
                    }
                }
                if join == "outer" {
                    for (position, b) in right.iter().enumerate() {
                        if !matched_right[position] {
                            next.push((b.json.clone(), offset(n) + position));
                        }
                    }
                }
                acc = next;
            }
            acc.into_iter().map(|(value, paired)| Item::paired(value, paired)).collect()
        }
        "choose" => {
            let chosen = text(&ctx.params, "choose");
            let n = chosen.strip_prefix("input").and_then(|d| d.parse::<usize>().ok()).unwrap_or(1).clamp(1, count) - 1;
            port(n).iter().enumerate().map(|(i, item)| Item::paired(item.json.clone(), offset(n) + i)).collect()
        }
        _ => (0..count)
            .flat_map(|n| port(n).iter())
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

/// Waits shorter than this stay in memory; longer ones are parked in the database, so the app
/// restarting in between does not lose them.
const PARK_AFTER: Duration = Duration::from_secs(60);

/// An optional time limit given in hours; 0 is none.
fn hours(params: &Value, name: &str) -> Option<Duration> {
    number(params, name).filter(|h| *h > 0.0).map(|h| Duration::from_secs_f64(h.min(24.0 * 365.0) * 3600.0))
}

/// Parks the run at this node until the wait is decided.
async fn park(ctx: &NodeCtx, kind: &str, message: String, timeout: Option<Duration>) -> Result<WaitAnswer, NodeError> {
    let request = WaitRequest {
        node_id: ctx.node.id.clone(),
        node_name: ctx.node.name.clone(),
        kind: kind.to_string(),
        message,
        timeout,
        inputs: ctx.inputs.clone(),
    };
    ctx.run.host.wait_for(request, ctx.cancel.clone()).await.map_err(|error| {
        if error.starts_with(crate::ai_runs::CANCELLED_MARKER) {
            NodeError::Cancelled
        } else {
            NodeError::Failed(error)
        }
    })
}

/// What a decided wait hands on. Shared with a run picking up after a restart, which has no node
/// running to ask: approved items leave by the first output and the rest by the second, each with
/// the decision on it; a wait for a call or a time passes its items on with the call's body.
pub fn decided_ports(type_id: &str, inputs: &Ports, answer: &WaitAnswer) -> Ports {
    let object = |json: &Value| if json.is_object() { json.clone() } else { json!({ "value": json }) };
    let items: Vec<&Item> = inputs.iter().flatten().collect();
    if type_id == "logic.approval" {
        let note = json!({
            "decision": answer.decision,
            "by": answer.by,
            "at": answer.at,
            "comment": answer.payload.as_str().unwrap_or_default(),
        });
        let out: Vec<Item> = items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let mut json = object(&item.json);
                json["approval"] = note.clone();
                Item::paired(json, index)
            })
            .collect();
        return if answer.decision == "approved" { vec![out, vec![]] } else { vec![vec![], out] };
    }
    let out = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut json = object(&item.json);
            if !answer.payload.is_null() {
                json["call"] = answer.payload.clone();
            }
            Item::paired(json, index)
        })
        .collect();
    vec![out]
}

/// Pauses until somebody approves or rejects — in CodeFlow or on the phone.
async fn approval(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let answer = park(ctx, "approval", text(&params, "message"), hours(&params, "timeoutHours")).await?;
    if answer.decision == "expired" && text(&params, "onTimeout") == "fail" {
        return Err(NodeError::failed("Nobody decided before the time limit"));
    }
    Ok(decided_ports("logic.approval", &ctx.inputs, &answer))
}

async fn wait(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    if text(&params, "mode") == "webhook" {
        let answer = park(ctx, "webhook", String::new(), hours(&params, "timeoutHours")).await?;
        if answer.decision == "expired" {
            return Err(NodeError::failed("No call arrived before the time limit"));
        }
        return Ok(decided_ports("logic.wait", &ctx.inputs, &answer));
    }
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
    if duration >= PARK_AFTER {
        park(ctx, "time", String::new(), Some(duration)).await?;
        return Ok(vec![ctx.passthrough()]);
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(vec![ctx.passthrough()]),
        _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
    }
}

// ------------------------------------------------------------------------------------- rate limit

/// A bucket of tokens per node of a flow, shared by every run of it: two runs a webhook started a
/// second apart draw from the same bucket, which is what makes "N a minute" true of the flow and not
/// of each run.
struct Bucket {
    tokens: f64,
    capacity: f64,
    per_second: f64,
    refilled: std::time::Instant,
}

impl Bucket {
    fn refill(&mut self) {
        let now = std::time::Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.refilled).as_secs_f64() * self.per_second).min(self.capacity);
        self.refilled = now;
    }
}

static BUCKETS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Bucket>>> =
    std::sync::LazyLock::new(Default::default);

/// Takes a token now, or says how long until one is there.
fn take_token(key: &str, capacity: f64, per_second: f64) -> Result<(), Duration> {
    let mut buckets = BUCKETS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let bucket = buckets.entry(key.to_string()).or_insert(Bucket { tokens: capacity, capacity, per_second, refilled: std::time::Instant::now() });
    // A changed setting takes effect at once rather than after the old bucket drains.
    bucket.capacity = capacity;
    bucket.per_second = per_second;
    bucket.refill();
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        Ok(())
    } else {
        Err(Duration::from_secs_f64((1.0 - bucket.tokens) / per_second))
    }
}

/// Lets N items through per second, minute or hour; the rest wait their turn, or are dropped.
pub async fn ratelimit(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let amount = number(&ctx.params, "amount").unwrap_or(1.0).max(1.0);
    let window = match text(&ctx.params, "per").as_str() {
        "minute" => 60.0,
        "hour" => 3600.0,
        _ => 1.0,
    };
    let drop = text(&ctx.params, "overflow") == "drop";
    let key = format!("{}:{}", ctx.run.flow_id, ctx.node.id);
    let mut passed = Vec::new();
    for (index, item) in ctx.items().into_iter().enumerate() {
        loop {
            match take_token(&key, amount, amount / window) {
                Ok(()) => {
                    passed.push(Item::paired(item.json.clone(), index));
                    break;
                }
                Err(_) if drop => break,
                Err(wait) => {
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                    }
                }
            }
        }
    }
    Ok(vec![passed])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_gives_its_capacity_then_refills() {
        let key = format!("test:{}", uuid::Uuid::new_v4());
        assert!(take_token(&key, 2.0, 10.0).is_ok());
        assert!(take_token(&key, 2.0, 10.0).is_ok());
        let wait = take_token(&key, 2.0, 10.0).unwrap_err();
        assert!(wait <= Duration::from_millis(100), "{wait:?}");
        std::thread::sleep(Duration::from_millis(120));
        assert!(take_token(&key, 2.0, 10.0).is_ok());
    }

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
