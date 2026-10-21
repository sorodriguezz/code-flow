//! The tasks. Each one is something CodeFlow really asks a model to do, with a check that decides
//! from the *result* — the project runs and gives the right number, the JSON validates, the answer
//! names the thing it was asked about — never from how the answer is worded.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::fixtures::{self, node_eval, Fixture};
use crate::ai::task;

/// Which part of the bench a task belongs to — and so which ones a run can select.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Suite {
    /// The agent loop with tools, in a project.
    Agent,
    /// One-shot answers: commit messages, titles, JSON.
    Text,
    /// Tool-call conformance against the server directly — see [`super::conformance`].
    Tools,
    /// Reading and writing speed — see [`super::speed`].
    Speed,
    /// The knowledge engine alone, no model: whether its search puts the passage that answers in the
    /// first results (recall@k), finds nothing when nothing answers, and reads a note. Measured with
    /// the bench because every layer has to win here, and left out of a model's score
    /// ([`super::report::Report::compute_score`]) because no model takes part.
    Retrieval,
}

impl Suite {
    pub const ALL: [Suite; 5] = [Suite::Speed, Suite::Tools, Suite::Retrieval, Suite::Text, Suite::Agent];
}

pub type Check = fn(&Path, &str) -> Result<(), String>;

pub struct EvalTask {
    pub id: &'static str,
    pub suite: Suite,
    /// `None`: no working folder, so the engine answers in text mode.
    pub fixture: Option<Fixture>,
    pub prompt: &'static str,
    pub task: &'static str,
    pub write: bool,
    pub stdin: &'static str,
    pub schema: Option<&'static str>,
    pub needs_node: bool,
    /// Built when the task runs and handed over as `stdin` instead: an input too long to write out
    /// (the needle's haystack).
    pub long_input: Option<fn() -> String>,
    pub check: Check,
}

pub const TASKS: &[EvalTask] = &[
    EvalTask {
        id: "fix-single-file",
        suite: Suite::Agent,
        fixture: Some(Fixture::Cart),
        prompt: "The cart total comes out negative. Find the bug in this project and fix it.",
        task: task::FIX_FINDING,
        write: true,
        stdin: "",
        schema: None,
        needs_node: true,
        long_input: None,
        check: |dir, _| match node_eval(dir, "console.log(require('./src/cart').cartTotal([{price: 2}, {price: 3}]))") {
            Some(total) if total == "5" => Ok(()),
            Some(total) => Err(format!("cartTotal gives {total}")),
            None => Err("the project no longer runs".to_string()),
        },
    },
    EvalTask {
        id: "fix-cross-file",
        suite: Suite::Agent,
        fixture: Some(Fixture::Shop),
        prompt: "Con un descuento del 10% sobre una compra de 100, el total del checkout sale 10 en vez de 90. Encuentra la causa en este proyecto y arréglala.",
        task: task::FIX_FINDING,
        write: true,
        stdin: "",
        schema: None,
        needs_node: true,
        long_input: None,
        check: |dir, _| match node_eval(dir, "console.log(require('./src/checkout/checkout').checkoutSummary([{price: 100, qty: 1}], 10).total)") {
            Some(total) if total == "90" => Ok(()),
            Some(total) => Err(format!("checkout total is {total}")),
            None => Err("the project no longer runs".to_string()),
        },
    },
    EvalTask {
        id: "rename-everywhere",
        suite: Suite::Agent,
        fixture: Some(Fixture::Shop),
        prompt: "Renombra la función cartTotal a computeCartTotal en todo el proyecto: la declaración y cada lugar donde se usa.",
        task: task::FIX_FINDING,
        write: true,
        stdin: "",
        schema: None,
        needs_node: true,
        long_input: None,
        check: |dir, _| {
            let leftovers: Vec<&str> = ["src/cart/cart.js", "src/checkout/checkout.js"]
                .into_iter()
                .filter(|rel| std::fs::read_to_string(dir.join(rel)).unwrap_or_default().contains("cartTotal"))
                .collect();
            if !leftovers.is_empty() {
                return Err(format!("cartTotal still in {leftovers:?}"));
            }
            match node_eval(dir, "console.log(require('./src/checkout/checkout').checkoutSummary([{price: 50, qty: 2}], 0).total)") {
                Some(total) if total == "100" => Ok(()),
                Some(total) => Err(format!("checkout total is {total}")),
                None => Err("the project no longer runs".to_string()),
            }
        },
    },
    EvalTask {
        id: "add-function",
        suite: Suite::Agent,
        fixture: Some(Fixture::Shop),
        prompt: "Add a function `taxIncluded(amount, rate)` to src/lib/tax.js that returns the amount with the tax added (amount * (1 + rate)), and export it next to taxFor.",
        task: task::FIX_FINDING,
        write: true,
        stdin: "",
        schema: None,
        needs_node: true,
        long_input: None,
        check: |dir, _| match node_eval(dir, "const t = require('./src/lib/tax'); console.log(Math.round(t.taxIncluded(100, 0.19) * 100) / 100, typeof t.taxFor)") {
            Some(out) if out == "119 function" => Ok(()),
            Some(out) => Err(format!("got {out}")),
            None => Err("taxIncluded is missing or the file no longer runs".to_string()),
        },
    },
    EvalTask {
        id: "explain-read-only",
        suite: Suite::Agent,
        fixture: Some(Fixture::Cart),
        prompt: "¿Qué exporta src/cart.js? Responde en una frase.",
        task: task::CHAT,
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |dir, answer| {
            let untouched = std::fs::read_to_string(dir.join("src/cart.js")).unwrap_or_default().contains("total -= item.price");
            if !untouched {
                return Err("a read-only question changed a file".to_string());
            }
            if answer.contains("cartTotal") { Ok(()) } else { Err(format!("the answer does not name cartTotal: {}", clip(answer))) }
        },
    },
    EvalTask {
        id: "answer-from-docs",
        suite: Suite::Agent,
        fixture: Some(Fixture::Docs),
        prompt: "¿Qué motor de base de datos usa este servicio y por qué? Responde en dos frases.",
        task: task::CHAT,
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |_, answer| {
            if answer.to_lowercase().contains("sqlite") { Ok(()) } else { Err(format!("the answer does not say SQLite: {}", clip(answer))) }
        },
    },
    EvalTask {
        id: "commit-message",
        suite: Suite::Text,
        fixture: None,
        prompt: "Write a one-line Conventional Commits message for this diff. Answer with the message only.",
        task: task::COMMIT,
        write: false,
        stdin: "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -3,7 +3,7 @@ function cartTotal(items) {\n   let total = 0;\n   for (const item of items) {\n-    total -= item.price;\n+    total += item.price;\n   }\n   return total;\n }\n",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |_, answer| {
            let line = answer.trim().trim_matches('`').lines().next().unwrap_or_default().trim();
            let conventional = regex::Regex::new(r"^(fix|feat|refactor|chore|docs|test|perf|style|build|ci)(\([^)]+\))?!?: \S").unwrap();
            if !conventional.is_match(line) {
                return Err(format!("not a conventional commit: {}", clip(line)));
            }
            if line.chars().count() > 72 {
                return Err(format!("{} characters, over 72", line.chars().count()));
            }
            Ok(())
        },
    },
    EvalTask {
        id: "json-extract",
        suite: Suite::Text,
        fixture: None,
        prompt: "Extract the incident below into the JSON the schema describes.",
        task: task::ANALYZE,
        write: false,
        stdin: "Incident: since this morning every POST to /checkout returns 500. The stack trace points at src/api/server.js and src/checkout/checkout.js. Customers cannot pay, so this blocks sales.",
        schema: Some(r#"{"type":"object","properties":{"title":{"type":"string"},"severity":{"type":"string","enum":["low","medium","high"]},"files":{"type":"array","items":{"type":"string"}}},"required":["title","severity","files"],"additionalProperties":false}"#),
        needs_node: false,
        long_input: None,
        check: |_, answer| {
            let value: serde_json::Value = serde_json::from_str(answer.trim()).map_err(|e| format!("not JSON ({e}): {}", clip(answer)))?;
            let schema: serde_json::Value = serde_json::from_str(TASKS.iter().find(|t| t.id == "json-extract").and_then(|t| t.schema).unwrap_or("{}")).unwrap();
            if !jsonschema::is_valid(&schema, &value) {
                return Err(format!("does not follow the schema: {}", clip(answer)));
            }
            if value["severity"] != "high" {
                return Err(format!("severity {} (blocks sales → high)", value["severity"]));
            }
            let files = value["files"].as_array().cloned().unwrap_or_default();
            if !files.iter().any(|f| f.as_str().is_some_and(|f| f.ends_with("src/api/server.js"))) {
                return Err("src/api/server.js missing from files".to_string());
            }
            Ok(())
        },
    },
    EvalTask {
        id: "chat-title",
        suite: Suite::Text,
        fixture: None,
        prompt: "Write a title of at most six words for a conversation that starts with this question. Answer with the title only.",
        task: task::CHAT_TITLE,
        write: false,
        stdin: "¿Cómo configuro el contexto del modelo local para que no se corte en archivos grandes?",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |_, answer| {
            let title = answer.trim().trim_matches(|c| c == '"' || c == '*' || c == '#').trim();
            if title.is_empty() || title.contains('\n') {
                return Err(format!("not a one-line title: {}", clip(answer)));
            }
            let words = title.split_whitespace().count();
            if words > 8 { Err(format!("{words} words")) } else { Ok(()) }
        },
    },
    EvalTask {
        id: "answer-not-in-docs",
        suite: Suite::Agent,
        fixture: Some(Fixture::Docs),
        prompt: "¿Qué broker de mensajes (Kafka, RabbitMQ, NATS…) usa este servicio para publicar sus eventos, según su documentación?",
        task: task::CHAT,
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        // Nothing in the project names one: the answer has to say so, not pick the likeliest.
        check: |_, answer| says_not_found(answer),
    },
    EvalTask {
        id: "answer-cross-language",
        suite: Suite::Agent,
        fixture: Some(Fixture::Docs),
        prompt: "¿Durante cuántos días se conservan los movimientos de stock?",
        task: task::CHAT,
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        // The decision is written in English; the question is not.
        check: |_, answer| if answer.contains("90") { Ok(()) } else { Err(format!("the answer does not say 90 days: {}", clip(answer))) },
    },
    EvalTask {
        id: "needle-long-context",
        suite: Suite::Text,
        fixture: None,
        prompt: "The text below is a log of warehouse operations. How often do the warehouse scanners flush their buffer? Answer with the number of seconds only.",
        task: task::CHAT,
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: Some(fixtures::haystack_text),
        check: |_, answer| if answer.contains("47") { Ok(()) } else { Err(format!("the needle is 47 seconds: {}", clip(answer))) },
    },
    EvalTask {
        id: "retrieval-docs",
        suite: Suite::Retrieval,
        fixture: Some(Fixture::Docs),
        prompt: "How long are stock movements kept before they are summarised?",
        task: "",
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |_, answer| recall_at(answer, "docs/adr/0003-retention.md", 3),
    },
    EvalTask {
        id: "retrieval-note",
        suite: Suite::Retrieval,
        fixture: Some(Fixture::Docs),
        prompt: "¿Qué hace la guardia cuando los escáneres pierden la conexión?",
        task: "",
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        // Only the team's note says it; the repository does not.
        check: |_, answer| recall_at(answer, "note:eval-oncall", 3),
    },
    EvalTask {
        id: "retrieval-needle",
        suite: Suite::Retrieval,
        fixture: Some(Fixture::Haystack),
        prompt: "How often do the warehouse scanners flush their buffer?",
        task: "",
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        check: |_, answer| recall_at(answer, fixtures::NEEDLE_PATH, 3),
    },
    EvalTask {
        id: "retrieval-cross-language",
        suite: Suite::Retrieval,
        fixture: Some(Fixture::Docs),
        prompt: "¿Durante cuántos días se conservan los movimientos de stock?",
        task: "",
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        // Shares one word with the English decision record: the vectors' job, and lexical search
        // alone is expected to miss it.
        check: |_, answer| recall_at(answer, "docs/adr/0003-retention.md", 3),
    },
    EvalTask {
        id: "retrieval-absent",
        suite: Suite::Retrieval,
        fixture: Some(Fixture::Docs),
        prompt: "Which message broker, Kafka or RabbitMQ, does the inventory service publish its events to?",
        task: "",
        write: false,
        stdin: "",
        schema: None,
        needs_node: false,
        long_input: None,
        // Two of its words are in the README; neither is an answer.
        check: |_, answer| {
            if answer.starts_with("Nothing in this workspace's knowledge") {
                Ok(())
            } else {
                Err(format!("passages for a question nothing answers: {:?}", cited_paths(answer)))
            }
        },
    },
];

/// The paths a knowledge search's answer cites, best first: the `N. path…` line of each result, its
/// lines cut off. Numbered from 1 without a gap, so a numbered list quoted inside a passage is not
/// taken for a result.
pub fn cited_paths(answer: &str) -> Vec<String> {
    let line = regex::Regex::new(r"^(\d+)\. (\S+)").unwrap();
    let lines = regex::Regex::new(r":\d+-\d+$").unwrap();
    let mut out = Vec::new();
    for text in answer.lines() {
        let Some(found) = line.captures(text) else { continue };
        if found[1].parse::<usize>().ok() != Some(out.len() + 1) {
            continue;
        }
        out.push(lines.replace(&found[2], "").to_string());
    }
    out
}

/// Recall at `k`: `path` is among the first `k` results.
pub fn recall_at(answer: &str, path: &str, k: usize) -> Result<(), String> {
    let cited = cited_paths(answer);
    match cited.iter().position(|p| p == path) {
        Some(rank) if rank < k => Ok(()),
        Some(rank) => Err(format!("{path} ranked {} (wanted the first {k})", rank + 1)),
        None => Err(format!("{path} not among {cited:?}")),
    }
}

/// The answer says the documentation does not name it — and does not name one anyway. "No usa
/// Kafka" is not a claim; "usa Kafka" is.
pub fn says_not_found(answer: &str) -> Result<(), String> {
    let absent = regex::Regex::new(
        r"(?i)\bno (se )?(menciona|encuentr|encontr|aparece|especifica|indica|documenta|dice|hay|figura|consta)|\bnot (mentioned|found|documented|specified|stated)|\b(doesn't|does not|don't|do not) (mention|say|specify|document|name)|\bno (information|mention)\b|\bsin (información|mención)|\bningún|\bninguna\b",
    )
    .unwrap();
    let claim = regex::Regex::new(r"(?i)\b(usa|utiliza|emplea|publica en|uses|publishes to|relies on)\s+\**(kafka|rabbitmq|nats|redis|sqs|pulsar|activemq)").unwrap();
    let negated = |at: usize| {
        let before: String = answer[..at].chars().rev().take(12).collect::<String>().chars().rev().collect::<String>().to_lowercase();
        before.trim_end().ends_with("no") || before.trim_end().ends_with("not") || before.contains("n't")
    };
    if let Some(found) = claim.find_iter(answer).find(|m| !negated(m.start())) {
        return Err(format!("it names a broker the docs never mention ({}): {}", found.as_str(), clip(answer)));
    }
    if absent.is_match(answer) { Ok(()) } else { Err(format!("it does not say the docs do not name one: {}", clip(answer))) }
}

pub fn clip(text: &str) -> String {
    let flat = text.trim().replace('\n', " ");
    if flat.chars().count() > 160 { format!("{}…", flat.chars().take(160).collect::<String>()) } else { flat }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_id(id: &str) -> &'static EvalTask {
        TASKS.iter().find(|t| t.id == id).expect(id)
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = TASKS.iter().map(|t| t.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), TASKS.len());
    }

    #[test]
    fn agent_tasks_have_a_project_and_text_tasks_do_not() {
        for task in TASKS {
            match task.suite {
                Suite::Agent | Suite::Retrieval => assert!(task.fixture.is_some(), "{}", task.id),
                Suite::Text => assert!(task.fixture.is_none(), "{}", task.id),
                _ => panic!("{} belongs to a suite that is not a task list", task.id),
            }
        }
    }

    #[test]
    fn the_commit_check_reads_the_first_line_only() {
        let check = by_id("commit-message").check;
        let dir = Path::new(".");
        assert!(check(dir, "fix(cart): add item prices instead of subtracting them").is_ok());
        assert!(check(dir, "`fix: sum prices`\n\nlonger body").is_ok());
        assert!(check(dir, "Fixed the cart").is_err());
        assert!(check(dir, &format!("fix: {}", "x".repeat(80))).is_err());
    }

    #[test]
    fn the_json_check_validates_schema_and_content() {
        let check = by_id("json-extract").check;
        let dir = Path::new(".");
        let good = r#"{"title":"Checkout returns 500","severity":"high","files":["src/api/server.js","src/checkout/checkout.js"]}"#;
        assert!(check(dir, good).is_ok());
        assert!(check(dir, r#"{"title":"x","severity":"urgent","files":[]}"#).is_err(), "enum enforced");
        assert!(check(dir, r#"{"title":"x","severity":"low","files":["src/api/server.js"]}"#).is_err(), "severity judged");
        assert!(check(dir, "not json").is_err());
    }

    #[test]
    fn the_title_check_counts_words() {
        let check = by_id("chat-title").check;
        let dir = Path::new(".");
        assert!(check(dir, "\"Contexto del modelo local\"").is_ok());
        assert!(check(dir, "uno dos tres cuatro cinco seis siete ocho nueve").is_err());
        assert!(check(dir, "").is_err());
    }

    #[test]
    fn recall_reads_the_ranked_citations_and_nothing_quoted_inside_them() {
        let answer = "<retrieved_content note=\"x\">\n1. docs/a.md:3-9 — A [inv]\n1. a numbered line quoted in a passage\n\n2. note:eval-oncall — Guardia [note]\nbody\n</retrieved_content>";
        assert_eq!(cited_paths(answer), vec!["docs/a.md", "note:eval-oncall"]);
        assert!(recall_at(answer, "note:eval-oncall", 3).is_ok());
        assert!(recall_at(answer, "note:eval-oncall", 1).is_err());
        assert!(recall_at(answer, "docs/b.md", 3).is_err());
    }

    #[test]
    fn not_found_means_saying_so_without_naming_one() {
        assert!(says_not_found("La documentación no menciona ningún broker de mensajes.").is_ok());
        assert!(says_not_found("The docs do not mention a message broker; it does not use Kafka as far as they say.").is_ok());
        assert!(says_not_found("Usa Kafka para publicar los eventos.").is_err(), "an invented answer");
        assert!(says_not_found("No se menciona, pero probablemente usa RabbitMQ.").is_err(), "a guess dressed as an answer");
        assert!(says_not_found("Publica eventos en una cola.").is_err(), "neither says it is absent");
    }

    #[test]
    fn the_needle_task_hands_over_the_whole_haystack() {
        let task = by_id("needle-long-context");
        let input = (task.long_input.expect("built at run time"))();
        assert!(input.contains(fixtures::NEEDLE) && input.len() > 20_000);
        assert!((task.check)(Path::new("."), "47").is_ok());
        assert!((task.check)(Path::new("."), "60").is_err());
    }

    #[test]
    fn the_docs_check_wants_the_decision() {
        let check = by_id("answer-from-docs").check;
        assert!(check(Path::new("."), "Usa SQLite porque corre en un solo proceso.").is_ok());
        assert!(check(Path::new("."), "Usa PostgreSQL.").is_err());
    }
}
