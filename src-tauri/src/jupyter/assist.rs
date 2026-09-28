//! The notebook's AI actions — generate a cell, explain one, fix its error, document it.
//!
//! **Text in, text out.** The engine is handed the cells around the one in question on stdin and
//! answers with a cell's worth of code, or with prose; it runs read-only with no working directory,
//! so it reads no file and writes none. What it proposes for a cell is shown to the user as a diff
//! to accept or discard — nothing here, and nothing in the notebook, applies it unseen.
//!
//! The instructions are the `notebook_template` setting (Settings → AI → tasks and prompts), with
//! [`DEFAULT_PROMPT`] behind a blank one, as every editable prompt in the app works; what changes
//! per action is the `TAREA` line in the payload, which is built here so it can be tested.

use serde::Deserialize;

/// How much of the notebook goes to the engine, in characters. Enough for a dozen ordinary cells
/// with their outputs; a notebook of fifty is represented by the ones nearest the target.
pub const MAX_CONTEXT_CHARS: usize = 24_000;
/// One cell's source, at most — a pasted dataset in a cell is not context worth its weight.
const MAX_CELL_CHARS: usize = 4_000;
/// One cell's output, at most. The tail end of an output is where a result or an error is.
const MAX_OUTPUT_CHARS: usize = 1_500;
const MAX_ERROR_CHARS: usize = 6_000;

pub const DEFAULT_PROMPT: &str = "Trabajas dentro del notebook de Jupyter de otra persona. Por stdin recibes el \
lenguaje del kernel, las celdas cercanas como contexto (código, Markdown y un recorte de sus salidas), \
la CELDA OBJETIVO cuando la hay, y la TAREA que tienes que hacer.\n\n\
Reglas:\n\
- Si la tarea pide código (generar, corregir, documentar), responde ÚNICAMENTE con el código completo \
de la celda: sin bloques de código Markdown (```), sin explicaciones antes ni después. Lo que escribas \
pasa a ser la celda tal cual.\n\
- Escribe en el lenguaje del kernel. Usa los nombres, los datos y los imports que el notebook ya \
tiene; no repitas un import que otra celda ya hizo salvo que haga falta.\n\
- Al corregir un error, cambia lo mínimo que lo arregla y deja el resto de la celda como estaba.\n\
- Al documentar, añade comentarios y docstrings sin cambiar lo que hace el código.\n\
- Si la tarea pide una explicación, responde en Markdown breve y concreto, en el idioma que se indica.\n\
- No inventes resultados de ejecución: si algo depende de datos que no ves, dilo.";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssistAction {
    /// A new code cell from a short description, inserted below the target.
    Generate,
    /// Prose about the target cell and its output.
    Explain,
    /// The target cell rewritten so its error goes away.
    Fix,
    /// The target cell with comments and docstrings.
    Document,
}

impl AssistAction {
    /// Whether the answer is a cell's code — and is shown as a diff — rather than prose.
    pub fn answers_with_code(self) -> bool {
        !matches!(self, AssistAction::Explain)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CellContext {
    /// Position in the notebook, 0-based — shown 1-based.
    pub index: usize,
    /// `code`, `markdown` or `raw`.
    pub cell_type: String,
    pub source: String,
    /// The cell's outputs as text (images named, not included), when it has any.
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub execution_count: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistRequest {
    pub action: AssistAction,
    /// The kernel's language — `python`, `r`, `julia`…
    pub kernel_language: String,
    /// The language the user reads — `es` or `en` — for anything written in prose.
    pub reply_language: String,
    /// What the user typed: the description for `generate`, an optional nudge for the others.
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub target: Option<CellContext>,
    /// The target's error — name, value and traceback — for `fix`.
    #[serde(default)]
    pub error: Option<String>,
    /// Cells before the target, nearest last.
    #[serde(default)]
    pub before: Vec<CellContext>,
    /// Cells after the target, nearest first.
    #[serde(default)]
    pub after: Vec<CellContext>,
    #[serde(default)]
    pub notebook_name: String,
}

/// The first `max` characters, marked when cut.
fn head(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}\n[… recortado]")
}

/// The last `max` characters, marked when cut — for outputs and tracebacks, whose end is the part
/// that says what happened.
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - max).collect();
    format!("[recortado …]\n{kept}")
}

fn describe(cell: &CellContext) -> String {
    let kind = match cell.cell_type.as_str() {
        "code" => "código",
        "markdown" => "markdown",
        other => other,
    };
    let count = cell.execution_count.map(|n| format!(" · [{n}]")).unwrap_or_default();
    format!("celda {} · {kind}{count}", cell.index + 1)
}

fn render_cell(cell: &CellContext) -> String {
    let mut out = format!("[{}]\n{}", describe(cell), head(&cell.source, MAX_CELL_CHARS));
    if let Some(output) = cell.output.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
        out.push_str("\n--- salida ---\n");
        out.push_str(&tail(output, MAX_OUTPUT_CHARS));
    }
    out
}

fn task_line(request: &AssistRequest) -> String {
    let asked = request.instruction.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let task = match request.action {
        AssistAction::Generate => "Escribe una celda de código nueva que haga lo que pide la INSTRUCCIÓN. Irá justo debajo de la celda objetivo (o al final, si no la hay).",
        AssistAction::Explain => "Explica qué hace la celda objetivo y, si tiene salida o error, qué significa.",
        AssistAction::Fix => "Corrige la celda objetivo para que deje de producir el ERROR. Devuelve la celda completa corregida.",
        AssistAction::Document => "Documenta la celda objetivo con comentarios y docstrings. Devuelve la celda completa.",
    };
    match asked {
        Some(asked) => format!("TAREA: {task}\nINSTRUCCIÓN: {asked}"),
        None => format!("TAREA: {task}"),
    }
}

/// What the engine is handed on stdin: the task, then the notebook around the target.
///
/// Neighbours are added nearest first, alternating before and after, until the budget runs out —
/// so a long notebook is represented by the cells that matter most to this one, and the order they
/// are printed in is still the notebook's own.
pub fn payload(request: &AssistRequest) -> String {
    let reply_in = if request.reply_language.starts_with("en") { "inglés" } else { "español" };
    let mut header = format!(
        "NOTEBOOK: {}\nLENGUAJE DEL KERNEL: {}\nIDIOMA PARA TEXTO: {reply_in}\n{}",
        if request.notebook_name.is_empty() { "(sin nombre)" } else { &request.notebook_name },
        if request.kernel_language.is_empty() { "python" } else { &request.kernel_language },
        task_line(request),
    );

    let target = request.target.as_ref().map(|cell| {
        let mut block = format!("=== CELDA OBJETIVO ({}) ===\n{}", describe(cell), head(&cell.source, MAX_CELL_CHARS * 2));
        if let Some(output) = cell.output.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
            block.push_str("\n--- salida ---\n");
            block.push_str(&tail(output, MAX_OUTPUT_CHARS));
        }
        block
    });
    let error = request
        .error
        .as_deref()
        .map(|e| crate::ai::strip_ansi(e))
        .filter(|e| !e.trim().is_empty())
        .map(|e| format!("=== ERROR ===\n{}", tail(e.trim(), MAX_ERROR_CHARS)));

    let fixed = header.len() + target.as_ref().map_or(0, String::len) + error.as_ref().map_or(0, String::len);
    let mut budget = MAX_CONTEXT_CHARS.saturating_sub(fixed);
    let mut before: Vec<String> = Vec::new();
    let mut after: Vec<String> = Vec::new();
    let mut before_cells = request.before.iter().rev();
    let mut after_cells = request.after.iter();
    loop {
        let mut took = false;
        if let Some(cell) = before_cells.next() {
            let rendered = render_cell(cell);
            if rendered.len() <= budget {
                budget -= rendered.len();
                before.push(rendered);
                took = true;
            }
        }
        if let Some(cell) = after_cells.next() {
            let rendered = render_cell(cell);
            if rendered.len() <= budget {
                budget -= rendered.len();
                after.push(rendered);
                took = true;
            }
        }
        if !took {
            break;
        }
    }
    before.reverse();

    if !before.is_empty() {
        header.push_str("\n\n=== CELDAS ANTERIORES ===\n");
        header.push_str(&before.join("\n\n"));
    }
    if let Some(target) = target {
        header.push_str("\n\n");
        header.push_str(&target);
    }
    if let Some(error) = error {
        header.push_str("\n\n");
        header.push_str(&error);
    }
    if !after.is_empty() {
        header.push_str("\n\n=== CELDAS SIGUIENTES ===\n");
        header.push_str(&after.join("\n\n"));
    }
    header
}

/// The answer as the notebook takes it: code without the fence a model wraps it in despite being
/// told not to, or prose without a fence around the whole of it.
pub fn clean_answer(action: AssistAction, text: &str) -> String {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else { return trimmed.to_string() };
    let Some(newline) = rest.find('\n') else { return trimmed.to_string() };
    let label = rest[..newline].trim().to_lowercase();
    let body = &rest[newline + 1..];
    let Some(body) = body.trim_end().strip_suffix("```") else { return trimmed.to_string() };
    // Only a fence around the *whole* answer comes off, and for prose only an unlabelled or
    // Markdown one — an explanation that is itself a shell snippet keeps its fence.
    if body.contains("\n```") && !action.answers_with_code() {
        return trimmed.to_string();
    }
    if !action.answers_with_code() && !(label.is_empty() || label == "markdown" || label == "md") {
        return trimmed.to_string();
    }
    body.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(index: usize, source: &str) -> CellContext {
        CellContext { index, cell_type: "code".into(), source: source.into(), output: None, execution_count: None }
    }

    fn request(action: AssistAction) -> AssistRequest {
        AssistRequest {
            action,
            kernel_language: "python".into(),
            reply_language: "es".into(),
            instruction: None,
            target: Some(CellContext { output: Some("3".into()), execution_count: Some(4), ..cell(3, "x = 1 + 2\nx") }),
            error: None,
            before: vec![cell(0, "import pandas as pd"), cell(1, "df = pd.read_csv('data.csv')"), cell(2, "df.head()")],
            after: vec![cell(4, "print(x)")],
            notebook_name: "analysis.ipynb".into(),
        }
    }

    #[test]
    fn the_payload_keeps_the_notebooks_order() {
        let text = payload(&request(AssistAction::Explain));
        let first = text.find("import pandas").unwrap();
        let second = text.find("pd.read_csv").unwrap();
        let target = text.find("=== CELDA OBJETIVO (celda 4 · código · [4]) ===").unwrap();
        let after = text.find("print(x)").unwrap();
        assert!(first < second && second < target && target < after);
        assert!(text.contains("LENGUAJE DEL KERNEL: python"));
        assert!(text.contains("IDIOMA PARA TEXTO: español"));
        assert!(text.contains("--- salida ---\n3"));
    }

    #[test]
    fn a_fix_carries_the_traceback_without_its_colours() {
        let mut asked = request(AssistAction::Fix);
        asked.error = Some("\x1b[0;31mNameError\x1b[0m: name 'y' is not defined".into());
        let text = payload(&asked);
        assert!(text.contains("=== ERROR ===\nNameError: name 'y' is not defined"));
        assert!(!text.contains('\x1b'));
    }

    #[test]
    fn generate_says_what_to_write() {
        let mut asked = request(AssistAction::Generate);
        asked.instruction = Some("  un gráfico de barras de df  ".into());
        asked.reply_language = "en".into();
        let text = payload(&asked);
        assert!(text.contains("INSTRUCCIÓN: un gráfico de barras de df"));
        assert!(text.contains("IDIOMA PARA TEXTO: inglés"));
    }

    #[test]
    fn a_long_notebook_keeps_the_nearest_cells() {
        let mut asked = request(AssistAction::Explain);
        let filler = "a".repeat(3_000);
        asked.before = (0..40).map(|i| cell(i, &format!("# far {i}\n{filler}"))).collect();
        asked.after = (41..60).map(|i| cell(i, &format!("# later {i}\n{filler}"))).collect();
        let text = payload(&asked);
        assert!(text.len() <= MAX_CONTEXT_CHARS + 200);
        assert!(text.contains("# far 39"), "the cell right above the target is kept");
        assert!(text.contains("# later 41"), "the cell right below the target is kept");
        assert!(!text.contains("# far 0\n"), "the farthest cells are what is dropped");
    }

    #[test]
    fn long_sources_and_outputs_are_cut_from_the_right_end() {
        let mut asked = request(AssistAction::Explain);
        asked.before = vec![CellContext {
            output: Some(format!("{}END-OF-OUTPUT", "o".repeat(5_000))),
            ..cell(0, &format!("START-OF-SOURCE{}", "s".repeat(10_000)))
        }];
        let text = payload(&asked);
        assert!(text.contains("START-OF-SOURCE"), "a source keeps its beginning");
        assert!(text.contains("END-OF-OUTPUT"), "an output keeps its end");
        assert!(text.contains("[… recortado]") && text.contains("[recortado …]"));
    }

    #[test]
    fn code_answers_lose_their_fence() {
        assert_eq!(clean_answer(AssistAction::Fix, "```python\nx = 1\n```"), "x = 1");
        assert_eq!(clean_answer(AssistAction::Generate, "\n```\nprint(1)\n```\n"), "print(1)");
        assert_eq!(clean_answer(AssistAction::Document, "x = 1  # uno"), "x = 1  # uno");
    }

    #[test]
    fn prose_keeps_fences_that_are_part_of_it() {
        let prose = "Suma dos números.\n\n```python\nx = 1 + 2\n```";
        assert_eq!(clean_answer(AssistAction::Explain, prose), prose);
        assert_eq!(clean_answer(AssistAction::Explain, "```markdown\n**Hola**\n```"), "**Hola**");
        let snippet = "```bash\npip install pandas\n```";
        assert_eq!(clean_answer(AssistAction::Explain, snippet), snippet);
    }

    #[test]
    fn the_request_reads_the_notebooks_json() {
        let json = serde_json::json!({
            "action": "fix",
            "kernelLanguage": "python",
            "replyLanguage": "es",
            "target": {"index": 2, "cellType": "code", "source": "1/0", "executionCount": 3},
            "error": "ZeroDivisionError: division by zero",
            "before": [],
            "after": [],
            "notebookName": "n.ipynb"
        });
        let parsed: AssistRequest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.action, AssistAction::Fix);
        assert!(parsed.action.answers_with_code());
        assert_eq!(parsed.target.unwrap().execution_count, Some(3));
    }
}
