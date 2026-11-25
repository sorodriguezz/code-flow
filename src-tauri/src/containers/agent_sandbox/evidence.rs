//! A sandbox's evidence as one Markdown document — what a reviewer reads before trusting the agent's
//! work: where it ran and under which rules, every command and how it ended, the tests' output, and
//! what changed in the checkout. Written from the stored timeline alone, so an export of a sandbox
//! destroyed a week ago says exactly what the page said then.

use serde_json::Value;

use super::store::{Evidence, Sandbox};

fn text<'a>(data: &'a Value, key: &str) -> &'a str {
    data.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A fenced block whose fence outlasts any run of backticks inside.
fn fenced(body: &str, lang: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}{lang}\n{}\n{fence}\n", body.trim_end())
}

fn argv_line(data: &Value) -> String {
    data.get("argv")
        .and_then(Value::as_array)
        .map(|words| {
            words
                .iter()
                .filter_map(Value::as_str)
                .map(|w| if w.is_empty() || w.contains(|c: char| c.is_whitespace() || "'\"$`\\".contains(c)) { format!("'{}'", w.replace('\'', "'\\''")) } else { w.to_string() })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn violations(data: &Value) -> Vec<String> {
    data.get("violations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| {
            let rule = text(v, "rule");
            let detail = text(v, "detail");
            let blocking = v.get("blocking").and_then(Value::as_bool).unwrap_or(true);
            let tag = if blocking { "blocks" } else { "advisory" };
            if detail.is_empty() { format!("- `{rule}` ({tag})") } else { format!("- `{rule}` — {detail} ({tag})") }
        })
        .collect()
}

/// The whole report.
pub fn markdown(sandbox: &Sandbox, timeline: &[Evidence]) -> String {
    let mut out = String::new();
    let title = if sandbox.title.trim().is_empty() { sandbox.container_name.as_str() } else { sandbox.title.trim() };
    out.push_str(&format!("# Sandbox evidence — {title}\n\n"));
    out.push_str("| | |\n|---|---|\n");
    let rows: [(&str, String); 10] = [
        ("Sandbox", format!("`{}`", sandbox.id)),
        ("Status", sandbox.status.clone()),
        ("Engine", if sandbox.context.is_empty() { sandbox.runtime.clone() } else { format!("{} ({})", sandbox.runtime, sandbox.context) }),
        ("Image", format!("`{}`", sandbox.image)),
        ("Container", format!("`{}`", if sandbox.container_name.is_empty() { &sandbox.container_id } else { &sandbox.container_name })),
        ("Branch", format!("`{}`", sandbox.branch)),
        ("Base commit", format!("`{}`", sandbox.base_commit.chars().take(12).collect::<String>())),
        ("Network", sandbox.network.clone()),
        ("Limits", format!("{} MB · {} CPU · {} processes", sandbox.memory_mb, sandbox.cpus, sandbox.pids_limit)),
        ("Policy", if sandbox.policy_status.is_empty() { "—".into() } else { sandbox.policy_status.clone() }),
    ];
    for (label, value) in rows {
        out.push_str(&format!("| {label} | {} |\n", value.replace('|', "\\|")));
    }
    if !sandbox.story_id.is_empty() {
        out.push_str(&format!("| Story | `{}` |\n", sandbox.story_id));
    }
    if !sandbox.task_id.is_empty() {
        out.push_str(&format!("| Agent task | `{}` |\n", sandbox.task_id));
    }
    out.push('\n');

    let commands: Vec<&Evidence> = timeline.iter().filter(|e| e.kind == "exec" || e.kind == "test").collect();
    let failed = commands.iter().filter(|e| e.data.get("exitCode").and_then(Value::as_i64) != Some(0)).count();
    out.push_str(&format!(
        "{} commands run ({} tests), {} did not exit 0.\n\n",
        commands.len(),
        commands.iter().filter(|e| e.kind == "test").count(),
        failed
    ));

    out.push_str("## Timeline\n\n");
    for entry in timeline {
        out.push_str(&format!("### {} · {}\n\n", entry.at, entry.kind));
        if !entry.summary.is_empty() {
            out.push_str(&format!("{}\n\n", entry.summary));
        }
        match entry.kind.as_str() {
            "policy" | "hardening" => {
                let list = violations(&entry.data);
                if list.is_empty() {
                    out.push_str("No violations.\n\n");
                } else {
                    out.push_str(&list.join("\n"));
                    out.push_str("\n\n");
                }
                if let Some(findings) = entry.data.get("findings").and_then(Value::as_array).filter(|f| !f.is_empty()) {
                    out.push_str("Hardening findings:\n\n");
                    for f in findings {
                        let detail = text(f, "detail");
                        out.push_str(&format!("- `{}` ({}){}\n", text(f, "rule"), text(f, "severity"), if detail.is_empty() { String::new() } else { format!(" — {detail}") }));
                    }
                    out.push('\n');
                }
            }
            "scan" => {
                if let Some(scan) = entry.data.get("scan").filter(|s| !s.is_null()) {
                    let n = |k: &str| scan.get(k).and_then(Value::as_u64).unwrap_or(0);
                    out.push_str(&format!(
                        "{} on {}: {} critical, {} high, {} medium, {} low.\n\n",
                        text(scan, "scanner"),
                        text(scan, "scannedAt"),
                        n("critical"),
                        n("high"),
                        n("medium"),
                        n("low")
                    ));
                } else {
                    out.push_str("The image has no kept scan.\n\n");
                }
            }
            "exec" | "test" => {
                let code = entry.data.get("exitCode").and_then(Value::as_i64).map(|c| c.to_string()).unwrap_or_else(|| "—".into());
                let ms = entry.data.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                let timed_out = entry.data.get("timedOut").and_then(Value::as_bool).unwrap_or(false);
                out.push_str(&fenced(&format!("$ {}", argv_line(&entry.data)), "sh"));
                out.push_str(&format!("\nExit code {code} · {:.1} s{}\n\n", ms as f64 / 1000.0, if timed_out { " · timed out" } else { "" }));
                for (key, label) in [("stdout", "stdout"), ("stderr", "stderr")] {
                    let body = text(&entry.data, key);
                    if !body.trim().is_empty() {
                        let cut = entry.data.get(&format!("{key}Truncated")).and_then(Value::as_bool).unwrap_or(false);
                        out.push_str(&format!("{label}{}:\n\n", if cut { " (last part)" } else { "" }));
                        out.push_str(&fenced(body, ""));
                        out.push('\n');
                    }
                }
            }
            "diff" => {
                let stat = text(&entry.data, "stat");
                out.push_str(&fenced(if stat.trim().is_empty() { "(no changes to tracked files)" } else { stat }, ""));
                out.push('\n');
                if let Some(untracked) = entry.data.get("untracked").and_then(Value::as_array).filter(|u| !u.is_empty()) {
                    out.push_str("New files:\n\n");
                    for path in untracked.iter().filter_map(Value::as_str) {
                        out.push_str(&format!("- `{path}`\n"));
                    }
                    out.push('\n');
                }
                let diff = text(&entry.data, "diff");
                if !diff.trim().is_empty() {
                    let cut = entry.data.get("diffTruncated").and_then(Value::as_bool).unwrap_or(false);
                    out.push_str(&format!("Diff{}:\n\n", if cut { " (first part)" } else { "" }));
                    out.push_str(&fenced(diff, "diff"));
                    out.push('\n');
                }
            }
            _ => {
                let detail = text(&entry.data, "detail");
                if !detail.is_empty() {
                    out.push_str(&format!("{detail}\n\n"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: i64, kind: &str, summary: &str, data: Value) -> Evidence {
        Evidence { id, sandbox_id: "s".into(), kind: kind.into(), at: format!("2026-11-24T10:0{id}:00Z"), summary: summary.into(), data }
    }

    #[test]
    fn the_report_says_where_it_ran_what_ran_and_what_changed() {
        let sandbox = Sandbox {
            id: "s".into(),
            title: "Login con SSO".into(),
            runtime: "docker".into(),
            image: "node:22".into(),
            container_name: "codeflow-sbx-s".into(),
            branch: "story/login".into(),
            base_commit: "0123456789abcdef".into(),
            network: "none".into(),
            memory_mb: 2048.0,
            cpus: 2.0,
            pids_limit: 512.0,
            status: "destroyed".into(),
            policy_status: "warnings".into(),
            story_id: "st1".into(),
            ..Default::default()
        };
        let timeline = vec![
            entry(1, "policy", "Checked before creating", json!({"violations": [{"rule": "notScanned", "detail": "", "blocking": false}]})),
            entry(2, "scan", "", json!({"scan": null})),
            entry(3, "exec", "", json!({"argv": ["sh", "-c", "echo 'hi there'"], "exitCode": 0, "durationMs": 1200, "stdout": "hi there\n"})),
            entry(4, "test", "", json!({"argv": ["npm", "test"], "exitCode": 1, "durationMs": 4000, "stdout": "1 failed ```", "stdoutTruncated": true})),
            entry(5, "diff", "Final diff", json!({"stat": " src/a.ts | 2 +-\n", "diff": "-a\n+b\n", "untracked": ["src/new.ts"]})),
        ];
        let md = markdown(&sandbox, &timeline);
        assert!(md.starts_with("# Sandbox evidence — Login con SSO"));
        assert!(md.contains("| Branch | `story/login` |"));
        assert!(md.contains("| Base commit | `0123456789ab` |"));
        assert!(md.contains("| Story | `st1` |"));
        assert!(md.contains("2 commands run (1 tests), 1 did not exit 0."));
        assert!(md.contains("- `notScanned` (advisory)"));
        assert!(md.contains("The image has no kept scan."));
        assert!(md.contains("$ sh -c 'echo '\\''hi there'\\'''"), "{md}");
        assert!(md.contains("Exit code 1 · 4.0 s"));
        assert!(md.contains("stdout (last part):"));
        assert!(md.contains("````\n1 failed ```\n````"), "a longer fence than the output's backticks");
        assert!(md.contains("- `src/new.ts`"));
        assert!(md.contains("```diff\n-a\n+b\n```"));
    }
}
