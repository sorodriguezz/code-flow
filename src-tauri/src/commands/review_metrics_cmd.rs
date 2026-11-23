//! The review metrics view's one command — see [`crate::review_metrics`] for what is counted and
//! why it is computed on demand rather than kept in counters.

use tauri::State;

use crate::db::Db;
use crate::review_metrics::{self, MetricsFilter, ReviewMetrics};

/// Aggregates a workspace's saved review runs into the numbers the metrics view draws: gate
/// verdicts and new findings per month, what is still open per repository, false-positive rates per
/// reviewer and category, cost, and runs per level. `filter` narrows by repository and date range.
///
/// Reads only the rows' meta and findings — never the review text or the diff — so it stays cheap
/// on a workspace with years of memory.
#[tauri::command]
pub fn review_metrics(db: State<Db>, workspace_id: String, filter: Option<MetricsFilter>) -> Result<ReviewMetrics, String> {
    let runs = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        review_metrics::load_runs(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    Ok(review_metrics::compute(&runs, &filter.unwrap_or_default()))
}
