//! Every word the hybrid task says to a model, in one place — built here, in Rust, so no client
//! can drop "do not edit anything" out of the plan or "one fenced block" out of the executor.
//!
//! English, like the chain's other scaffolding: the models read it, not the user, and the user's
//! own words (the objective, a note at the gate) are passed through untouched.

use super::budget;
use super::plan::{RepoRef, Review};
use crate::db::hybrid_queries::{HybridItem, HybridRun};

/// How many rounds of local corrections a run in the `local` review mode gets. The review after the
/// last one finishes the work itself: a correction the local model got wrong twice is not one it
/// will get right the third time, and an endless loop spends the subscription it was meant to save.
pub const MAX_FIX_ROUNDS: i64 = 2;

/// Roughly how many tokens a line of code costs. Only used to turn a token budget into the line
/// counts the planner is told, which it reasons about far better than tokens.
const TOKENS_PER_LINE: u64 = 12;

fn delegation_phrase(delegate: &str) -> &'static str {
    match delegate {
        "easy" => "only the tasks you rate easy",
        "all" => "every task, whatever its difficulty",
        _ => "the tasks you rate easy or medium",
    }
}

/// Where the run works, said to the planner and the reviewer: one repository, or several with their
/// paths — every one of them readable from the working directory, because the CLI was given the
/// others as extra directories.
fn repositories_paragraph(repos: &[RepoRef]) -> String {
    match repos {
        [] => String::new(),
        [only] => format!(
            "This run works in one repository, `{}` (your working directory). Set every `repo` field to `{}`.\n\n",
            only.name, only.name
        ),
        many => {
            let mut out = format!(
                "This run spans {} repositories — plan across all of them, and keep what one exposes and the \
other calls consistent:\n",
                many.len()
            );
            for (at, repo) in many.iter().enumerate() {
                out.push_str(&format!(
                    "- `{}` → {}{}\n",
                    repo.name,
                    repo.path,
                    if at == 0 { " (your working directory)" } else { "" }
                ));
            }
            out.push_str(
                "You can read every one of them. Set each task's `repo` to the repository its `file` is in \
(paths are relative to that repository), each reference's `repo` the same way (null for the task's \
own), and each check's `repo` to where it runs.\n\n",
            );
            out
        }
    }
}

/// One task in the JSON shape, as both the plan and a review's fixes write it.
const TASK_SHAPE: &str = "{\"id\":\"t1\",\"title\":\"…\",\"repo\":\"…\",\"file\":\"src/…\",\"action\":\"create|modify|delete\",\
\"regions\":[{\"start_line\":1,\"end_line\":20,\"first_line\":\"…\"}],\"instruction\":\"…\",\
\"context\":[{\"repo\":null,\"file\":\"src/…\",\"start_line\":1,\"end_line\":10,\"first_line\":\"…\",\"why\":\"…\"}],\
\"acceptance\":[\"…\"],\"depends_on\":[],\"difficulty\":\"easy|medium|hard\"}";

/// The plan step's instruction. The numbers are the run's — the executor's real window on the
/// user's machine — which is what makes the plan cut to fit a 7B on a laptop or a 32B on a GPU.
pub fn planner_instruction(run: &HybridRun, repos: &[RepoRef]) -> String {
    let input = run.budget_input.max(0) as u64;
    let output = run.budget_output.max(0) as u64;
    let lines_in = input / TOKENS_PER_LINE;
    let region_threshold = (output / TOKENS_PER_LINE).max(40) * 9 / 10;
    format!(
        "You are the ARCHITECT of a hybrid run. You plan; you do not write the code.\n\
\n\
A local model on the user's machine ({model}) will implement your plan one task at a time. For each \
task it sees ONLY what you write in that task: the instruction, the acceptance criteria, the code it \
must rewrite and the references you list — about {input} tokens in total (≈{lines_in} lines of code), \
and it can answer with about {output} tokens (≈{lines_out} lines). It cannot open files, search, or \
see the other tasks or this conversation. Afterwards you will review its work.\n\
\n\
{repositories}**Read whatever you need of the repository, but do not edit, create or delete any file.** \
Then answer with the plan as a single JSON object and nothing else.\n\
\n\
How to cut the work:\n\
- **One task per file.** Every change to a file goes in that file's single task. At most {max} tasks.\n\
- For a file longer than about {region_threshold} lines, do not ask for the whole file: list \
`regions` to rewrite — `start_line`/`end_line` as the file is numbered now, and `first_line` = the \
exact text of `start_line`, trimmed. Each region is rewritten on its own, so make each one a \
self-contained unit (a function, a block) and keep it well under {region_threshold} lines. For \
smaller files and new files, leave `regions` empty.\n\
- Write every `instruction` so that someone who has never seen this repository could carry it out: \
exact names, signatures, imports to add, string literals, error messages, and the existing helpers \
to call with their signatures. Never refer to \"the above\", \"as discussed\" or another task.\n\
- `context`: the fewest references the task needs — a type it implements, a function it calls, a \
sibling file to imitate — most important first, each with `file`, the `start_line`/`end_line` that \
matter (null for a whole short file), `first_line` (the trimmed text of `start_line`, or null) and \
`why`.\n\
- `acceptance`: short statements that can be checked by reading the result.\n\
- `depends_on`: ids of tasks that must be done first (a helper before the code that uses it).\n\
- `difficulty`: `easy` (mechanical, follows an existing pattern), `medium` (new logic with a clear \
specification) or `hard` (subtle logic, cross-cutting changes, needs judgement). The local model \
gets {delegation}; the rest you will implement yourself during the review, so rate honestly.\n\
- `checks`: commands that already exist in this repository and validate the change (type check, \
the relevant tests). They run only if the user approves them, so list real ones or none.\n\
- `summary`: one to three sentences on what changes. `risks`: what could go wrong.\n\
\n\
The JSON shape (every key present; use [] or null where empty):\n\
{{\"summary\":\"…\",\"tasks\":[{task}],\"checks\":[{{\"repo\":\"…\",\"command\":\"…\"}}],\"risks\":[\"…\"]}}",
        repositories = repositories_paragraph(repos),
        task = TASK_SHAPE,
        model = run.model,
        input = input,
        lines_in = lines_in,
        output = output,
        lines_out = output / TOKENS_PER_LINE,
        max = super::plan::MAX_TASKS,
        region_threshold = region_threshold,
        delegation = delegation_phrase(&run.delegate),
    )
}

/// What the review step's row says it does. The message it is actually sent is
/// [`review_instruction`], composed when it is claimed, because it depends on the round.
pub const REVIEW_STEP_LABEL: &str = "Review the local model's work, described in the report above.";

/// The review step's instruction for the round it is about to run. What it reviews arrives above
/// it, as the executor's report.
///
/// Three shapes. `report`: read-only, a list of problems. `local`, before the last round: review,
/// do the tasks that are the subscription's own, and hand every correction to the local model as a
/// task (JSON). `fix` — and `local` once its rounds are spent: correct and finish everything.
/// `for_you` is how many tasks the report lists for the review to implement; with none, a `local`
/// round writes nothing at all, and is run read-only.
pub fn review_instruction(run: &HybridRun, for_you: usize, repos: &[RepoRef]) -> String {
    let repositories = if repos.len() > 1 { repositories_paragraph(repos) } else { String::new() };
    if run.review_mode == "local" && run.fix_round < MAX_FIX_ROUNDS {
        return format!("{repositories}{}", local_review_instruction(run, for_you));
    }
    let mut out = repositories;
    if run.review_mode == "local" {
        out.push_str(&format!(
            "The local model has already had {} round(s) of corrections, so this is the last review: \
finish the work yourself.\n\n",
            run.fix_round
        ));
    }
    out.push_str(&static_review_instruction(&run.review_mode));
    out
}

fn local_review_instruction(run: &HybridRun, for_you: usize) -> String {
    let input = run.budget_input.max(0) as u64;
    let own_tasks = if for_you > 0 {
        "2. Implement yourself every task listed under \"For you\" — the local model cannot do those.\n"
    } else {
        "2. **Do not edit, create or delete any file** — this round only reviews.\n"
    };
    format!(
        "Review the work described in the report above, against the objective and the plan.\n\
\n\
1. Open the files the report names (its diff may be partial) and check every task's acceptance \
criteria against what is actually there.\n\
{own_tasks}\
3. Do NOT correct the local model's mistakes yourself. Describe each correction as a task for it in \
`fixes` — one task per file, with an instruction it can carry out without seeing anything else \
(exact names, the lines or region, what to change and to what), `regions` for long files and the \
references it needs. It sees only what you write in the task, about {input} tokens in all, and the \
file as it is now.\n\
4. If the report lists checks that failed, the fixes must make them pass.\n\
\n\
Answer with a single JSON object and nothing else:\n\
- `verdict`: `ok` if everything is right and `fixes` is empty; `fix` if you are handing corrections \
to the local model; `pending` if something is wrong that the local model cannot fix — say what in \
`summary`.\n\
- `summary`: what you checked, what you did and what you found, in a few sentences.\n\
- `fixes`: the corrections, each in the plan's task shape: {task}\n\
\n\
The JSON shape: {{\"verdict\":\"ok|fix|pending\",\"summary\":\"…\",\"fixes\":[…]}}",
        task = TASK_SHAPE,
    )
}

/// A review round's JSON, as the step keeps it: readable, and ending in the `VERDICT:` line both
/// [`parse_verdict`] and the panel read. `did_work` is whether the review implemented tasks of its
/// own, which turns an `ok` into `FIXED`.
pub fn review_text(review: &Review, did_work: bool, fixes_file_list: &[String]) -> String {
    let mut out = review.summary.trim().to_string();
    if !fixes_file_list.is_empty() {
        out.push_str("\n\nCorrections for the local model:");
        for line in fixes_file_list {
            out.push_str(&format!("\n- {line}"));
        }
    }
    let verdict = match (review.verdict.as_str(), did_work) {
        ("fix", _) => "FIX",
        ("pending", _) => "PENDING",
        (_, true) => "FIXED",
        _ => "OK",
    };
    out.push_str(&format!("\n\nVERDICT: {verdict}"));
    out.trim().to_string()
}

fn static_review_instruction(review_mode: &str) -> String {
    if review_mode == "report" {
        return "Review the work described in the report above against the objective and the plan.\n\
\n\
**Do not edit, create or delete any file.** Open the files the report names (the diff in it may be \
partial), check every task's acceptance criteria, and list each problem precisely: file, line, what \
is wrong, what it should be. Include the tasks under \"For you\": say what each still needs.\n\
\n\
End with one line on its own: `VERDICT: OK` if everything is correct, or `VERDICT: PENDING` if \
anything is wrong or undone."
            .to_string();
    }
    "Review and finish the work described in the report above, against the objective and the plan.\n\
\n\
1. Open the files the report names (its diff may be partial) and check every task's acceptance \
criteria against what is actually there.\n\
2. Fix what is wrong, directly, with the smallest change that makes it right. Do not redo work \
that is correct, and do not touch files the plan did not involve.\n\
3. Implement yourself every task listed under \"For you\".\n\
4. If the report lists checks, make them pass.\n\
\n\
Finish with a short summary of what you changed and why, and then one line on its own: \
`VERDICT: OK` if nothing needed changing, `VERDICT: FIXED` if you fixed or completed anything, or \
`VERDICT: PENDING` if something is still wrong or undone — and say what."
        .to_string()
}

/// How a review ended, read from its last `VERDICT:` line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Fixed,
    Pending,
}

/// The verdict on the review's last `VERDICT:` line that names one.
///
/// The prefix in any case and the first run of letters after it, so `verdict: ok`, `VERDICT: PENDING.`
/// and `VERDICT: **FIXED**` all read — and exactly as the panel's `verdictOf` reads them, or the chip
/// would say one thing and the chain's reason another.
pub fn parse_verdict(answer: &str) -> Option<Verdict> {
    answer.lines().rev().find_map(|line| {
        let line = line.trim().trim_matches(|c| c == '*' || c == '`').trim();
        let (head, rest) = line.split_at_checked("VERDICT:".len())?;
        if !head.eq_ignore_ascii_case("VERDICT:") {
            return None;
        }
        let word: String = rest
            .trim_start_matches(|c: char| c.is_whitespace() || c == '*' || c == '`')
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect::<String>()
            .to_ascii_uppercase();
        match word.as_str() {
            "OK" => Some(Verdict::Ok),
            "FIXED" | "CORREGIDO" => Some(Verdict::Fixed),
            "PENDING" | "PENDIENTE" => Some(Verdict::Pending),
            _ => None,
        }
    })
}

/// The executor's standing rules. Short: every token here is one the task cannot spend.
pub const EXECUTOR_SYSTEM: &str = "You are a careful code editor working on ONE task. You see only the task, \
the code you must write or rewrite, and a few references.\n\
Rules:\n\
- Answer with exactly one fenced code block holding the COMPLETE new version of what you were asked \
to write — nothing before it, nothing after it.\n\
- Never use placeholders such as \"...\", \"// rest of the code\", \"existing code here\" or \
\"unchanged\": write every line.\n\
- Keep the existing style: indentation, quotes, naming, comments.\n\
- Never copy the references into your answer; they are for reading only.";

/// The language tag a fence gets, from the file's extension. Only a hint to the model.
pub fn fence_language(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "ts" | "tsx" | "mts" | "cts" => "ts",
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" | "hh" => "cpp",
        "swift" => "swift",
        "json" => "json",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "md" => "markdown",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        _ => "",
    }
}

/// What the task writes.
pub enum Target<'a> {
    /// A new file.
    Create,
    /// The whole of an existing file.
    Whole { text: &'a str },
    /// One region of an existing file, `index` of `count`.
    Region { text: &'a str, start: usize, end: usize, index: usize, count: usize },
}

/// A piece of the repository shown for reference.
pub struct Reference {
    pub label: String,
    pub file: String,
    pub text: String,
}

/// One request, ready to send.
pub struct ExecPrompt {
    pub user: String,
    /// What it is estimated to cost, safety margin included — what the budget was checked against.
    pub estimate: u64,
    /// How many of the offered references fitted.
    pub references_used: usize,
}

/// Estimated tokens of `text`, padded by 15%. The estimate runs low on digit-heavy code (measured:
/// 6,033 estimated against 6,628 counted for a file of numbered constants), and a budget that
/// overruns by a few percent is a prompt the server cuts.
pub fn padded_estimate(text: &str) -> u64 {
    budget::estimate_tokens(text) * 115 / 100
}

/// Builds the request for one target of one task, inside the budget.
///
/// The order is the priority: the instruction and the target must fit (otherwise the task is too
/// big for the local model and `Err` says so — never a silently trimmed prompt); then references
/// are added, most important first, while they fit. A gate note and a retry note ride along when
/// there are any.
pub fn executor_prompt(
    item: &HybridItem,
    target: &Target,
    references: &[Reference],
    gate_note: &str,
    retry_note: &str,
    budget_input: u64,
    budget_output: u64,
) -> Result<ExecPrompt, String> {
    let language = fence_language(&item.file);
    let mut head = format!("TASK: {}\nFILE: {}\n\nINSTRUCTION:\n{}\n", item.title, item.file, item.instruction.trim());
    if !item.acceptance.is_empty() {
        head.push_str("\nACCEPTANCE:\n");
        for line in &item.acceptance {
            head.push_str(&format!("- {}\n", line.trim()));
        }
    }
    if !gate_note.trim().is_empty() {
        head.push_str(&format!("\nNOTE FROM THE USER:\n{}\n", gate_note.trim()));
    }
    let (tail, expected_output) = match target {
        Target::Create => (
            format!("\nCREATE {}. Write its complete content as one ```{language} block.\n", item.file),
            0,
        ),
        Target::Whole { text } => (
            format!(
                "\nCURRENT CONTENT OF {file}:\n```{language}\n{text}\n```\n\nWrite the complete new content of {file} as one ```{language} block.\n",
                file = item.file
            ),
            padded_estimate(text),
        ),
        Target::Region { text, start, end, index, count } => {
            let mut tail = format!(
                "\nREGION TO REWRITE ({file}, lines {from}-{to}):\n```{language}\n{text}\n```\n\nWrite the complete new version of THIS REGION ONLY, as one ```{language} block. The code around it stays as it is.\n",
                file = item.file,
                from = start + 1,
                to = end + 1,
            );
            if *count > 1 {
                tail.push_str(&format!(
                    "This is region {} of {count} of this task; the others are handled separately, so change only what this region needs.\n",
                    index + 1
                ));
            }
            (tail, padded_estimate(text))
        }
    };
    let retry = if retry_note.trim().is_empty() {
        String::new()
    } else {
        format!("\nYOUR PREVIOUS ANSWER WAS REJECTED: {}\nAnswer again, fixing that.\n", retry_note.trim())
    };

    // The answer has to fit too: rewriting a file means writing all of it back.
    if expected_output > budget_output * 9 / 10 {
        return Err(format!(
            "{} is too long for one local answer (~{expected_output} tokens to write back, {budget_output} available).",
            match target {
                Target::Region { .. } => "The region",
                _ => "The file",
            }
        ));
    }

    let fixed = padded_estimate(EXECUTOR_SYSTEM) + padded_estimate(&head) + padded_estimate(&tail) + padded_estimate(&retry);
    if fixed > budget_input {
        return Err(format!(
            "The task alone needs ~{fixed} tokens and the local model's budget is {budget_input}."
        ));
    }

    let mut references_block = String::new();
    let mut used = 0;
    let mut spent = fixed;
    for reference in references {
        let block = format!(
            "\n### {}\n```{}\n{}\n```\n",
            reference.label,
            fence_language(&reference.file),
            reference.text
        );
        let cost = padded_estimate(&block);
        if spent + cost > budget_input {
            break;
        }
        spent += cost;
        used += 1;
        references_block.push_str(&block);
    }
    let mut user = head;
    if !references_block.is_empty() {
        user.push_str("\nREFERENCES (read-only; do not copy them into your answer):");
        user.push_str(&references_block);
        spent += padded_estimate("\nREFERENCES (read-only; do not copy them into your answer):");
    }
    user.push_str(&tail);
    user.push_str(&retry);
    Ok(ExecPrompt { user, estimate: spent, references_used: used })
}

/// One line of the report's task table.
pub fn status_word(item: &HybridItem) -> String {
    match item.status.as_str() {
        "done" => format!("done (+{} −{})", item.lines_added, item.lines_removed),
        "failed" => format!("failed: {}", item.error),
        "escalated" => format!("not done locally: {}", item.error),
        "skipped" if !item.enabled => "left out at approval".to_string(),
        "skipped" => format!("skipped: {}", item.error),
        "reviewed" => "done by the review".to_string(),
        _ if item.assignee == "sub" => "for you (not delegated)".to_string(),
        other => other.to_string(),
    }
}

/// The tasks the review must do itself: the ones never delegated, and — when the run's policy says
/// so — the ones the local model could not do.
pub fn for_review<'a>(run: &HybridRun, items: &'a [HybridItem]) -> Vec<&'a HybridItem> {
    items
        .iter()
        .filter(|item| item.enabled && item.status != "reviewed" && item.status != "done")
        .filter(|item| {
            item.assignee == "sub"
                || item.status == "escalated"
                || (run.on_fail != "skip" && matches!(item.status.as_str(), "failed" | "skipped"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> HybridRun {
        HybridRun {
            chain_id: "c".into(),
            backend: "ollama".into(),
            base_url: String::new(),
            model: "qwen2.5-coder:7b".into(),
            ctx: 16_384,
            budget_input: 11_776,
            budget_output: 4_096,
            delegate: "medium".into(),
            on_fail: "review".into(),
            review_mode: "fix".into(),
            unload: true,
            thinking: false,
            plan_summary: String::new(),
            plan_risks: vec![],
            checks: vec![],
            approved_checks: vec![],
            gate_note: String::new(),
            baseline_commit: String::new(),
            plan_input_tokens: 0,
            plan_output_tokens: 0,
            review_input_tokens: 0,
            review_output_tokens: 0,
            direct: false,
            fix_round: 0,
            review_skip: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn repos(names: &[&str]) -> Vec<RepoRef> {
        names
            .iter()
            .map(|name| RepoRef { project_id: format!("p-{name}"), name: name.to_string(), path: format!("/work/{name}") })
            .collect()
    }

    fn item(file: &str) -> HybridItem {
        HybridItem {
            id: "i".into(),
            chain_id: "c".into(),
            ord: 0,
            task_key: "t1".into(),
            title: "Add toCsv".into(),
            file: file.into(),
            action: "create".into(),
            regions: vec![],
            instruction: "Create toCsv(rows, columns).".into(),
            context: vec![],
            acceptance: vec!["exports toCsv".into()],
            depends_on: vec![],
            difficulty: "easy".into(),
            assignee: "local".into(),
            enabled: true,
            status: "pending".into(),
            attempts: 0,
            error: String::new(),
            error_code: String::new(),
            tokens_in: 0,
            tokens_out: 0,
            ms: 0,
            lines_added: 0,
            lines_removed: 0,
            hash_before: String::new(),
            hash_after: String::new(),
            updated_at: String::new(),
            project_id: String::new(),
            round: 0,
        }
    }

    #[test]
    fn the_planner_is_told_the_executors_real_budget() {
        let text = planner_instruction(&run(), &repos(&["shop"]));
        assert!(text.contains("qwen2.5-coder:7b"));
        assert!(text.contains("11776 tokens"), "{text}");
        assert!(text.contains("do not edit, create or delete any file"));
        assert!(text.contains("easy or medium"));
        let big = HybridRun { budget_input: 23_552, budget_output: 8_192, delegate: "all".into(), ..run() };
        let big_text = planner_instruction(&big, &repos(&["shop"]));
        assert!(big_text.contains("23552 tokens") && big_text.contains("every task"));
        assert!(text.contains("Set every `repo` field to `shop`"), "{text}");
    }

    #[test]
    fn a_plan_across_repositories_names_them_with_their_paths() {
        let text = planner_instruction(&run(), &repos(&["api", "web"]));
        assert!(text.contains("This run spans 2 repositories"));
        assert!(text.contains("- `api` → /work/api (your working directory)"), "{text}");
        assert!(text.contains("- `web` → /work/web\n"), "{text}");
    }

    #[test]
    fn the_review_is_told_what_this_round_is() {
        let one = repos(&["shop"]);
        let local = HybridRun { review_mode: "local".into(), ..run() };
        let first = review_instruction(&local, 0, &one);
        assert!(first.contains("Do NOT correct the local model's mistakes yourself"));
        assert!(first.contains("**Do not edit, create or delete any file**"), "with nothing of its own to do, a round writes nothing");
        let with_tasks = review_instruction(&local, 2, &one);
        assert!(with_tasks.contains("Implement yourself every task listed under \"For you\""));
        let last = review_instruction(&HybridRun { fix_round: MAX_FIX_ROUNDS, ..local.clone() }, 0, &one);
        assert!(last.contains("this is the last review") && last.contains("VERDICT: FIXED"), "{last}");
        assert!(review_instruction(&HybridRun { review_mode: "report".into(), ..run() }, 1, &one).contains("**Do not edit, create or delete any file.**"));
        assert!(review_instruction(&run(), 0, &repos(&["api", "web"])).contains("This run spans 2 repositories"));
    }

    #[test]
    fn a_review_round_is_kept_readable_with_its_verdict_last() {
        let review = Review { verdict: "fix".into(), summary: "total() is off by one.".into(), fixes: vec![] };
        let text = review_text(&review, false, &["src/api.ts — fix total".into()]);
        assert_eq!(text, "total() is off by one.\n\nCorrections for the local model:\n- src/api.ts — fix total\n\nVERDICT: FIX");
        let ok = Review { verdict: "ok".into(), summary: "Fine.".into(), fixes: vec![] };
        assert!(review_text(&ok, false, &[]).ends_with("VERDICT: OK"));
        assert!(review_text(&ok, true, &[]).ends_with("VERDICT: FIXED"), "it did tasks of its own");
        assert_eq!(parse_verdict(&review_text(&ok, true, &[])), Some(Verdict::Fixed));
    }

    #[test]
    fn verdicts_are_read_from_the_last_matching_line() {
        assert_eq!(parse_verdict("Fixed the import.\n\nVERDICT: FIXED"), Some(Verdict::Fixed));
        assert_eq!(parse_verdict("**VERDICT: OK**"), Some(Verdict::Ok));
        assert_eq!(parse_verdict("VERDICT: PENDING — the test still fails"), Some(Verdict::Pending));
        assert_eq!(parse_verdict("VERDICT: CORREGIDO"), Some(Verdict::Fixed));
        assert_eq!(parse_verdict("no verdict here"), None);
        assert_eq!(parse_verdict("VERDICT: maybe"), None);
        // The same tolerance as the panel's `verdictOf`.
        assert_eq!(parse_verdict("VERDICT: PENDING."), Some(Verdict::Pending));
        assert_eq!(parse_verdict("verdict: ok"), Some(Verdict::Ok));
        assert_eq!(parse_verdict("`VERDICT:` **FIXED**"), Some(Verdict::Fixed));
        assert_eq!(parse_verdict("VERDICT: OK\nVERDICT: maybe"), Some(Verdict::Ok));
        assert_eq!(parse_verdict("Verdicto: OK"), None);
    }

    #[test]
    fn references_are_added_in_order_until_the_budget_is_spent() {
        let refs: Vec<Reference> = (0..5)
            .map(|i| Reference { label: format!("ref {i}"), file: "a.ts".into(), text: "x".repeat(3_000) })
            .collect();
        let prompt = executor_prompt(&item("src/csv.ts"), &Target::Create, &refs, "", "", 3_000, 2_048).expect("fits");
        assert!(prompt.references_used >= 1 && prompt.references_used < 5, "{}", prompt.references_used);
        assert!(prompt.estimate <= 3_000);
        assert!(prompt.user.contains("ref 0") && !prompt.user.contains("ref 4"));
        assert!(prompt.user.contains("CREATE src/csv.ts"));
    }

    #[test]
    fn a_target_that_cannot_be_written_back_is_refused_not_trimmed() {
        let big = "let a = 1;\n".repeat(2_000);
        let error = executor_prompt(&item("src/big.ts"), &Target::Whole { text: &big }, &[], "", "", 50_000, 4_096)
            .err()
            .expect("too long to answer");
        assert!(error.contains("too long for one local answer"), "{error}");
        let error = executor_prompt(&item("src/x.ts"), &Target::Create, &[], "", "", 50, 4_096).err().expect("over budget");
        assert!(error.contains("budget"), "{error}");
    }

    #[test]
    fn the_review_is_handed_what_the_local_model_did_not_do() {
        let mut items = vec![item("a.ts"), item("b.ts"), item("c.ts"), item("d.ts")];
        items[0].status = "done".into();
        items[1].status = "failed".into();
        items[2].assignee = "sub".into();
        items[3].enabled = false;
        let names: Vec<&str> = for_review(&run(), &items).iter().map(|i| i.file.as_str()).collect();
        assert_eq!(names, ["b.ts", "c.ts"]);
        let skip = HybridRun { on_fail: "skip".into(), ..run() };
        let names: Vec<&str> = for_review(&skip, &items).iter().map(|i| i.file.as_str()).collect();
        assert_eq!(names, ["c.ts"], "a skip policy leaves failures as failures");
    }
}
