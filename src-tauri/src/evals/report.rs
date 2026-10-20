//! What a bench run produced — one JSON document per (model, machine, settings), comparable with
//! any other: a run on this Mac against one on the 4090, or a model against its fine-tuned adapter.

use serde::{Deserialize, Serialize};

use super::conformance::Conformance;
use super::corpus::Suite;
use super::speed::SpeedSample;
use crate::hybrid::hardware::{GpuKind, Machine};

/// Bumped when a field changes meaning, so an old report is not compared as if it were new.
pub const FORMAT: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MachineSummary {
    pub os: String,
    pub arch: String,
    pub ram_gb: f64,
    pub gpu: String,
    pub gpu_name: Option<String>,
    pub gpu_gb: Option<f64>,
}

impl MachineSummary {
    pub fn of(machine: &Machine) -> Self {
        let gb = |bytes: u64| (bytes as f64 / (1u64 << 30) as f64 * 10.0).round() / 10.0;
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            ram_gb: gb(machine.ram_bytes),
            gpu: match machine.gpu {
                GpuKind::Unified => "unified",
                GpuKind::Discrete => "discrete",
                GpuKind::Integrated => "integrated",
                GpuKind::Unknown => "unknown",
            }
            .to_string(),
            gpu_name: machine.gpu_name.clone(),
            gpu_gb: machine.gpu_bytes.map(gb),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskResult {
    pub id: String,
    pub suite: Suite,
    pub runs: usize,
    pub passed: usize,
    /// Wall seconds of each run.
    pub seconds: Vec<f64>,
    /// Why each failed run failed, in order.
    pub failures: Vec<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Not run, and why (`node` missing, the suite was not selected…).
    pub skipped: Option<String>,
}

impl TaskResult {
    pub fn mean_seconds(&self) -> Option<f64> {
        (!self.seconds.is_empty()).then(|| self.seconds.iter().sum::<f64>() / self.seconds.len() as f64)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Report {
    pub format: u32,
    pub app_version: Option<String>,
    pub started_at: String,
    pub finished_at: String,
    pub backend: String,
    pub model: String,
    /// Content identity of the weights — the GGUF's SHA-256 or Ollama's digest — so two reports of
    /// "the same model" really are about the same bytes.
    pub model_digest: Option<String>,
    /// A fine-tuned adapter served on top of the model, when one was.
    pub adapter: Option<String>,
    pub ctx: u32,
    pub machine: MachineSummary,
    pub speed: Option<SpeedSample>,
    pub conformance: Option<Conformance>,
    pub tasks: Vec<TaskResult>,
    /// Highest resident memory of the model server during the run, when it could be read.
    pub peak_rss_bytes: Option<u64>,
    /// Passed runs over run runs, across every task that was not skipped.
    pub score: f64,
    /// Set when the run stopped early (Stop pressed, server gone).
    pub aborted: Option<String>,
}

impl Report {
    pub fn compute_score(tasks: &[TaskResult]) -> f64 {
        let (passed, runs) = tasks
            .iter()
            .filter(|t| t.skipped.is_none())
            .fold((0usize, 0usize), |(p, r), t| (p + t.passed, r + t.runs));
        if runs == 0 { 0.0 } else { passed as f64 / runs as f64 }
    }

    /// A plain-text table for a terminal or a log.
    pub fn summary(&self) -> String {
        let mut out = format!(
            "{} via {} · ctx {} · {} {} GB RAM{}\n",
            self.model,
            self.backend,
            self.ctx,
            self.machine.arch,
            self.machine.ram_gb,
            self.machine.gpu_name.as_ref().map(|g| format!(" · {g}")).unwrap_or_default()
        );
        if let Some(speed) = &self.speed {
            out.push_str(&format!(
                "speed: read {} tok/s · write {} tok/s · first token {} ms{}\n",
                speed.prompt_tps.map(|v| format!("{v:.0}")).unwrap_or("?".into()),
                speed.gen_tps.map(|v| format!("{v:.1}")).unwrap_or("?".into()),
                speed.first_token_ms.map(|v| v.to_string()).unwrap_or("?".into()),
                if speed.truncated { " · TRUNCATED" } else { "" }
            ));
        }
        if let Some(c) = &self.conformance {
            out.push_str(&format!(
                "tools: {}/{} · verified {} · parallel {}\n",
                c.passed,
                c.total,
                c.verified(),
                c.parallel
            ));
            for case in c.cases.iter().filter(|c| !c.passed) {
                out.push_str(&format!("  ✗ {}: {}\n", case.id, case.detail));
            }
        }
        for task in &self.tasks {
            match &task.skipped {
                Some(why) => out.push_str(&format!("{:<20} skipped: {why}\n", task.id)),
                None => out.push_str(&format!(
                    "{:<20} {}/{} · {}\n",
                    task.id,
                    task.passed,
                    task.runs,
                    task.mean_seconds().map(|s| format!("{s:.0} s")).unwrap_or_default()
                )),
            }
            for failure in &task.failures {
                out.push_str(&format!("  ✗ {failure}\n"));
            }
        }
        out.push_str(&format!("score {:.0}%", self.score * 100.0));
        if let Some(rss) = self.peak_rss_bytes {
            out.push_str(&format!(" · peak memory {:.1} GB", rss as f64 / (1u64 << 30) as f64));
        }
        out
    }
}

/// One line per task that both reports ran: the change in passes and in time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Delta {
    pub id: String,
    pub before: (usize, usize),
    pub after: (usize, usize),
    pub seconds_before: Option<f64>,
    pub seconds_after: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Comparison {
    pub score_before: f64,
    pub score_after: f64,
    pub tools_before: Option<usize>,
    pub tools_after: Option<usize>,
    pub tasks: Vec<Delta>,
    /// Tasks that passed every run before and lost a pass after — what a publication gate refuses.
    pub regressions: Vec<String>,
}

pub fn compare(before: &Report, after: &Report) -> Comparison {
    let mut tasks = Vec::new();
    let mut regressions = Vec::new();
    for a in after.tasks.iter().filter(|t| t.skipped.is_none()) {
        let Some(b) = before.tasks.iter().find(|t| t.id == a.id && t.skipped.is_none()) else { continue };
        let rate = |t: &TaskResult| if t.runs == 0 { 0.0 } else { t.passed as f64 / t.runs as f64 };
        if rate(a) < rate(b) {
            regressions.push(a.id.clone());
        }
        tasks.push(Delta {
            id: a.id.clone(),
            before: (b.passed, b.runs),
            after: (a.passed, a.runs),
            seconds_before: b.mean_seconds(),
            seconds_after: a.mean_seconds(),
        });
    }
    Comparison {
        score_before: before.score,
        score_after: after.score,
        tools_before: before.conformance.as_ref().map(|c| c.passed),
        tools_after: after.conformance.as_ref().map(|c| c.passed),
        tasks,
        regressions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, passed: usize, runs: usize) -> TaskResult {
        TaskResult {
            id: id.to_string(),
            suite: Suite::Agent,
            runs,
            passed,
            seconds: vec![10.0; runs],
            failures: Vec::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            skipped: None,
        }
    }

    fn report(tasks: Vec<TaskResult>) -> Report {
        Report {
            format: FORMAT,
            app_version: None,
            started_at: String::new(),
            finished_at: String::new(),
            backend: "bundled".into(),
            model: "m".into(),
            model_digest: None,
            adapter: None,
            ctx: 8192,
            machine: MachineSummary { os: "macos".into(), arch: "aarch64".into(), ram_gb: 16.0, gpu: "unified".into(), gpu_name: None, gpu_gb: None },
            speed: None,
            conformance: None,
            score: Report::compute_score(&tasks),
            tasks,
            peak_rss_bytes: None,
            aborted: None,
        }
    }

    #[test]
    fn score_ignores_skipped_tasks() {
        let mut skipped = task("b", 0, 3);
        skipped.skipped = Some("node missing".into());
        assert_eq!(Report::compute_score(&[task("a", 2, 4), skipped]), 0.5);
        assert_eq!(Report::compute_score(&[]), 0.0);
    }

    #[test]
    fn a_lost_pass_is_a_regression_and_a_gain_is_not() {
        let before = report(vec![task("fix", 3, 3), task("rename", 1, 3)]);
        let after = report(vec![task("fix", 2, 3), task("rename", 3, 3)]);
        let cmp = compare(&before, &after);
        assert_eq!(cmp.regressions, vec!["fix".to_string()]);
        assert_eq!(cmp.tasks.len(), 2);
    }

    #[test]
    fn the_summary_names_every_task() {
        let text = report(vec![task("fix-cross-file", 1, 2)]).summary();
        assert!(text.contains("fix-cross-file"));
        assert!(text.contains("score 50%"));
    }
}
