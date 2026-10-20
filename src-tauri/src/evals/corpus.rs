//! The tasks. Each one is something CodeFlow really asks a model to do, with a check that decides
//! from the *result* — the project runs and gives the right number, the JSON validates, the answer
//! names the thing it was asked about — never from how the answer is worded.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::fixtures::{node_eval, Fixture};
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
}

impl Suite {
    pub const ALL: [Suite; 4] = [Suite::Speed, Suite::Tools, Suite::Text, Suite::Agent];
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
        check: |_, answer| {
            let title = answer.trim().trim_matches(|c| c == '"' || c == '*' || c == '#').trim();
            if title.is_empty() || title.contains('\n') {
                return Err(format!("not a one-line title: {}", clip(answer)));
            }
            let words = title.split_whitespace().count();
            if words > 8 { Err(format!("{words} words")) } else { Ok(()) }
        },
    },
];

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
                Suite::Agent => assert!(task.fixture.is_some(), "{}", task.id),
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
    fn the_docs_check_wants_the_decision() {
        let check = by_id("answer-from-docs").check;
        assert!(check(Path::new("."), "Usa SQLite porque corre en un solo proceso.").is_ok());
        assert!(check(Path::new("."), "Usa PostgreSQL.").is_err());
    }
}
