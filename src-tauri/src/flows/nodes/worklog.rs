//! «Resumen de trabajo»: the user's daily standup or weekly report (`crate::worklog`) as a node — so
//! a flow can be «every weekday at 9:00 → Resumen de trabajo → note + notification» (user,
//! 2026-10-23). The app side (`worklog.generate` in `flows::app_ops`) collects, writes and, when
//! asked, keeps the note; this decides only what to ask and what to hand on.
//!
//! **It never posts anything.** Its output is text and data; sending it somewhere is a node the
//! user adds and wires themselves.

use serde_json::json;

use super::{flag, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let format = match ctx.param_str("worklogFormat").as_str() {
        "standup" => json!("daily"),
        "weeklyReport" => json!("weekly"),
        _ => json!(null),
    };
    let args = json!({
        "period": ctx.param_str("worklogPeriod"),
        "format": format,
        "allWorkspaces": ctx.param_str("worklogScope") == "allWorkspaces",
        "plain": ctx.param_str("worklogWriter") == "plainList",
        "engine": ctx.params.get("engine").cloned().unwrap_or_else(|| json!({})),
        "saveNote": flag(&ctx.params, "worklogSaveNote"),
    });
    let answer = ctx
        .run
        .host
        .app_call("worklog.generate", args, ctx.cancel.clone())
        .await
        .map_err(|error| if error.starts_with(crate::ai_runs::CANCELLED_MARKER) { NodeError::Cancelled } else { NodeError::Failed(error) })?;
    Ok(vec![vec![Item::new(answer)]])
}
