//! Any other CLI agent: the engine the user configures themselves.
//!
//! # Why this exists
//!
//! The engines beside this one are written against a *verified* binary — every flag in `claude.rs`,
//! `grok.rs` and the rest was read off the real CLI, and that is what makes them trustworthy. It is
//! also what stops this app from supporting the next agent that appears: a flag set written from a
//! blog post is a hard failure the first time somebody relies on it.
//!
//! So this is the honest version of "every CLI agent". The user names the binary and the argument
//! line; the app runs it, pipes the data in on stdin and reads the answer off stdout. Nothing is
//! guessed — and nothing is claimed either: there is no session to resume, no model list, no
//! permission mapping, because this engine knows nothing about the tool it is running.
//!
//! # The template
//!
//! One line, as it would be typed in a shell:
//!
//! ```text
//!   -p {prompt}
//!   run --model {model} --quiet {prompt}
//!   agent --message {prompt} --json
//! ```
//!
//! `{prompt}` is the ask, `{model}` is the configured model and `{session}` is the conversation (see
//! below). An argument that mentions a placeholder with nothing behind it is **dropped whole**, and
//! so is the flag right before it — with no model configured, `--model {model}` disappears rather
//! than being sent as an empty string, or as a bare `--model` that would swallow the next argument
//! as its value. Quotes group words the way a shell does, so `--system "be brief"` is two arguments
//! and not three.
//!
//! The placeholders are filled in **one pass**: a `{model}` or `{session}` that is part of the
//! *prompt* (code, a template, a question about this very syntax) is text, and stays text.
//!
//! # Resuming, when the CLI can
//!
//! `{session}` in the main line is how the CLI learns the conversation's name — `--session-id
//! {session}`, `--name {session}`, whatever it spells it. With it, the app **names the session
//! itself** on the first turn and passes the same name on every later one, which is how a CLI that
//! takes an arbitrary session name gets multi-turn memory here. Without it nothing can tell the CLI
//! which conversation a turn belongs to, so every turn is a fresh run and the chat replays its
//! prefix, which is what the other session-less engines do — a name minted and stored but never
//! given to the CLI would be resumed into a conversation that does not exist.
//!
//! An optional second line is for the CLIs that start and continue with **different** flags
//! (`--session-id {session}` to start, `--resume {session}` to continue): on a turn that continues,
//! it replaces whatever the main line said about the session.
//!
//! The name is minted here rather than read out of the CLI's output, because there is no output
//! format to read: this engine deliberately knows nothing about what it is running. So it reports
//! back the name it used, and the app stores that as the conversation's session.

use tokio::process::Command;

use crate::ai::{AiEngine, AiInvocation, AiRun};

pub const PROVIDER_ID: &str = "custom";

/// What the template is when the user has not written one: the shape almost every headless agent
/// takes, and the one most likely to just work.
const DEFAULT_ARGS: &str = "-p {prompt}";

/// The engine, carrying what the user configured — see [`AiEngine::configure`].
#[derive(Default)]
pub struct CustomEngine {
    args: String,
    /// How this CLI resumes, or empty when it cannot. See the module note.
    resume: String,
    /// The session this run used, set by [`AiEngine::build_command`] and reported by
    /// [`AiEngine::interpret`].
    ///
    /// A `OnceLock` because the trait hands `&self` to both and requires `Sync`: the id has to
    /// survive from building the command to reading the answer, and an engine is built per run, so
    /// "written once" is exactly its lifetime.
    session: std::sync::OnceLock<String>,
}

impl CustomEngine {
    fn template(&self) -> &str {
        if self.args.trim().is_empty() { DEFAULT_ARGS } else { self.args.as_str() }
    }

    /// Whether the CLI can be told which conversation a turn belongs to — see the module note.
    fn names_sessions(&self) -> bool {
        self.template().contains("{session}")
    }

    /// The arguments for one run, recording the session it used (see [`Self::session`]).
    fn argv(&self, prompt: &str, model: &str, resume_session_id: Option<&str>) -> Vec<String> {
        let template = self.template();
        // The session this run belongs to: the one the app is resuming, or a new name for a
        // conversation that does not have one yet — and only when the main line can hand that name
        // to the CLI. Otherwise there is no session, and `{session}` placeholders are dropped like
        // any other unfilled one.
        let session = if self.names_sessions() {
            let id = resume_session_id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let _ = self.session.set(id.clone());
            id
        } else {
            String::new()
        };

        if resume_session_id.is_some() && !session.is_empty() && !self.resume.trim().is_empty() {
            // A continuing turn with a resume line of its own: the main line minus what it says
            // about the session (that was how to *start* one), then the resume line.
            let mut args = render_args_with(template, prompt, model, "");
            args.extend(render_args_with(&self.resume, prompt, model, &session));
            args
        } else {
            render_args_with(template, prompt, model, &session)
        }
    }
}

impl AiEngine for CustomEngine {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn label(&self) -> &'static str {
        "Custom CLI"
    }

    /// Nothing: a custom engine has no default binary by definition, and guessing one would mean
    /// running *something* when the user has configured nothing.
    fn default_binary(&self) -> &'static str {
        ""
    }

    fn commit_message_model(&self) -> &'static str {
        ""
    }

    /// No write-tool vocabulary to map onto: this engine does not know what tools its binary has.
    /// "Fix with AI" therefore passes none, and whatever the CLI does by default is what happens —
    /// which is why the pane that configures it says so.
    fn fix_tools(&self) -> Vec<String> {
        Vec::new()
    }

    fn configure(&mut self, get: &dyn Fn(&str) -> Option<String>) {
        self.args = get("args").unwrap_or_default();
        self.resume = get("resume").unwrap_or_default();
    }

    /// Only when the main line can name the session — see the module note. Otherwise the chat must
    /// send its context on every turn, because the CLI starts from nothing each time.
    fn resumes_sessions(&self) -> bool {
        self.names_sessions()
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let args = self.argv(inv.prompt, inv.model, inv.resume_session_id);

        let mut command = Command::new(binary);
        command.args(args);
        if let Some(cwd) = inv.cwd {
            command.current_dir(cwd);
        }
        command
    }

    /// Stdout, as it came. There is no envelope to parse because there is no agreement about one:
    /// a CLI this app has never seen prints its answer, and that is the answer.
    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        let text = stdout.trim();
        if !success {
            let detail = stderr.trim();
            return Err(if detail.is_empty() {
                format!("the command failed ({status_label})")
            } else {
                format!("{status_label}: {detail}")
            });
        }
        if text.is_empty() {
            // A zero exit and nothing on stdout: the binary ran and said nothing, which for every
            // other engine means the output format is not what was expected. Here it means the
            // template is wrong, and that is what the message has to say.
            return Err("the command printed nothing — check the arguments in Settings › AI".to_string());
        }
        Ok(AiRun {
            text: text.to_string(),
            // The name this run used, so the next turn of this conversation can be given the same
            // one. `None` when the user declared no way to resume — see the module note.
            session_id: self.session.get().cloned(),
            model: None,
            usage: None,
            context_tokens: None,
        })
    }
}

/// The template, as argv.
///
/// Pure, and the whole of this engine's behaviour: splitting a line the way a shell does and
/// deciding what an unfilled placeholder means are the two things that decide whether a user's
/// configuration runs or fails confusingly.
#[cfg(test)]
pub fn render_args(template: &str, prompt: &str, model: &str) -> Vec<String> {
    render_args_with(template, prompt, model, "")
}

/// [`render_args`], with the session name too.
pub fn render_args_with(template: &str, prompt: &str, model: &str, session: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Whether the last word pushed was a flag written as such in the template — the one an empty
    // placeholder right after it takes along.
    let mut last_was_flag = false;
    for word in split_words(template) {
        // An argument that mentions a placeholder nothing was given for is dropped whole:
        // `--model {model}` with no model is two arguments most CLIs refuse, and one of them is
        // empty. The prompt is never empty in practice, but it is treated the same way for the
        // same reason.
        let empty = (word.contains("{model}") && model.trim().is_empty())
            || (word.contains("{prompt}") && prompt.is_empty())
            || (word.contains("{session}") && session.trim().is_empty());
        if empty {
            // ...and so is the flag it was the value of. Left behind, `--model` would take the
            // *next* argument — usually the prompt — as the model.
            if last_was_flag {
                out.pop();
            }
            last_was_flag = false;
            continue;
        }
        last_was_flag = word.starts_with('-') && !word.contains('=') && !has_placeholder(&word);
        out.push(fill(&word, prompt, model, session));
    }
    out
}

const PLACEHOLDERS: [&str; 3] = ["{prompt}", "{model}", "{session}"];

fn has_placeholder(word: &str) -> bool {
    PLACEHOLDERS.iter().any(|placeholder| word.contains(placeholder))
}

/// Every placeholder in `word` replaced, in one pass over the *template's* text: what goes in is
/// never searched again, so a prompt that contains `{model}` keeps it.
fn fill(word: &str, prompt: &str, model: &str, session: &str) -> String {
    let mut out = String::with_capacity(word.len() + prompt.len());
    let mut rest = word;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let hit = [("{prompt}", prompt), ("{model}", model), ("{session}", session)]
            .into_iter()
            .find(|(placeholder, _)| tail.starts_with(placeholder));
        match hit {
            Some((placeholder, value)) => {
                out.push_str(value);
                rest = &tail[placeholder.len()..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Splits on whitespace, with single and double quotes grouping — the shell's rule, as far as a
/// configuration field needs it. No escapes and no variable expansion: this is an argument line,
/// not a script, and anything cleverer would be a shell nobody asked for.
fn split_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in line.chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                // A quote is what *starts* an empty argument: `--system ""` is two words, the
                // second of them empty, and dropping it would change the command.
                started = true;
            }
            None if ch.is_whitespace() => {
                if started || !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => current.push(ch),
        }
    }
    if started || !current.is_empty() {
        words.push(current);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_the_placeholders() {
        assert_eq!(
            render_args("-p {prompt}", "arregla el login", ""),
            vec!["-p".to_string(), "arregla el login".to_string()]
        );
    }

    /// The point of the whole module: an argument naming a placeholder with nothing behind it would
    /// otherwise be sent empty, which is the shape most CLIs reject.
    #[test]
    fn drops_an_argument_whose_placeholder_is_empty() {
        // The flag goes with its value: a bare `--model` would take "hola" as the model.
        assert_eq!(render_args("run --model {model} {prompt}", "hola", ""), vec!["run".to_string(), "hola".to_string()]);
        // A placeholder glued to its flag is one argument, dropped alone.
        assert_eq!(render_args("run --model={model} {prompt}", "hola", ""), vec!["run".to_string(), "hola".to_string()]);
        assert_eq!(
            render_args("run --model {model} {prompt}", "hola", "fast-1"),
            vec!["run".to_string(), "--model".to_string(), "fast-1".to_string(), "hola".to_string()]
        );
    }

    /// What is filled in is never searched again: a prompt about this very syntax arrives intact.
    #[test]
    fn a_placeholder_inside_the_prompt_is_text() {
        assert_eq!(
            render_args_with("-m {model} -p {prompt}", "usa `${model}` y {session}", "fast-1", "abc"),
            vec!["-m".to_string(), "fast-1".to_string(), "-p".to_string(), "usa `${model}` y {session}".to_string()]
        );
        assert_eq!(fill("{prompt}", "{x} {", "", ""), "{x} {");
    }

    #[test]
    fn groups_quoted_words_the_way_a_shell_does() {
        assert_eq!(
            render_args("--system \"be brief\" -p {prompt}", "hola", ""),
            vec!["--system".to_string(), "be brief".to_string(), "-p".to_string(), "hola".to_string()]
        );
        assert_eq!(
            render_args("--system 'be brief'", "hola", ""),
            vec!["--system".to_string(), "be brief".to_string()]
        );
    }

    #[test]
    fn keeps_an_argument_that_was_quoted_empty_on_purpose() {
        assert_eq!(render_args("--system \"\"", "hola", ""), vec!["--system".to_string(), String::new()]);
    }

    #[test]
    fn collapses_the_spacing_a_person_typed() {
        assert_eq!(render_args("  -p    {prompt}  ", "hola", ""), vec!["-p".to_string(), "hola".to_string()]);
    }

    #[test]
    fn a_prompt_with_spaces_stays_one_argument() {
        let args = render_args("-p {prompt}", "dos palabras y más", "");
        assert_eq!(args.len(), 2);
        assert_eq!(args[1], "dos palabras y más");
    }

    #[test]
    fn reads_stdout_as_the_answer() {
        let engine = CustomEngine::default();
        let run = engine.interpret(true, "exit: 0", "  la respuesta\n", "").expect("a reply");
        assert_eq!(run.text, "la respuesta");
        assert!(run.session_id.is_none(), "this engine claims no session it cannot resume");
    }

    #[test]
    fn says_what_failed_and_what_said_nothing() {
        let engine = CustomEngine::default();
        let failed = engine.interpret(false, "exit: 2", "", "command not found").unwrap_err();
        assert!(failed.contains("command not found"));
        let silent = engine.interpret(true, "exit: 0", "   ", "").unwrap_err();
        assert!(silent.contains("printed nothing"));
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;

    #[test]
    fn drops_the_session_placeholder_when_there_is_no_session() {
        assert_eq!(render_args_with("run --session {session} {prompt}", "hola", "", ""), vec!["run".to_string(), "hola".to_string()]);
    }

    fn engine(args: &str, resume: &str) -> CustomEngine {
        CustomEngine { args: args.into(), resume: resume.into(), ..Default::default() }
    }

    fn argv(engine: &CustomEngine, resume_session_id: Option<&str>) -> Vec<String> {
        engine.argv("hola", "", resume_session_id)
    }

    /// The first turn hands the CLI the name it will be resumed under — or there is no session at
    /// all. A name stored but never given to the CLI is a conversation that does not exist.
    #[test]
    fn the_first_turn_names_the_session_or_claims_none() {
        let named = engine("--session-id {session} -p {prompt}", "");
        let first = argv(&named, None);
        let minted = named.session.get().cloned().expect("a name was minted");
        assert_eq!(first, vec!["--session-id".to_string(), minted.clone(), "-p".to_string(), "hola".to_string()]);
        assert!(named.resumes_sessions());

        let unnamed = engine("-p {prompt}", "--resume {session}");
        assert_eq!(argv(&unnamed, None), vec!["-p".to_string(), "hola".to_string()]);
        assert!(unnamed.session.get().is_none(), "the CLI was never told a name, so none is claimed");
        assert!(!unnamed.resumes_sessions());
    }

    /// A resume line replaces the main line's session flag on a continuing turn.
    #[test]
    fn a_resume_line_replaces_how_the_session_was_started() {
        let both = engine("--session-id {session} -p {prompt}", "--resume {session}");
        assert_eq!(
            argv(&both, Some("abc")),
            vec!["-p".to_string(), "hola".to_string(), "--resume".to_string(), "abc".to_string()]
        );
        let one_line = engine("--session {session} -p {prompt}", "");
        assert_eq!(
            argv(&one_line, Some("abc")),
            vec!["--session".to_string(), "abc".to_string(), "-p".to_string(), "hola".to_string()]
        );
    }

    #[test]
    fn fills_the_session_when_there_is_one() {
        assert_eq!(
            render_args_with("run --session {session}", "hola", "", "abc-123"),
            vec!["run".to_string(), "--session".to_string(), "abc-123".to_string()]
        );
    }

    /// A CLI that declares no way to resume claims no session: the chat then replays its prefix,
    /// which is what the other session-less engines do.
    #[test]
    fn claims_no_session_without_a_resume_line() {
        let engine = CustomEngine::default();
        let run = engine.interpret(true, "exit: 0", "respuesta", "").expect("a reply");
        assert!(run.session_id.is_none());
    }
}
