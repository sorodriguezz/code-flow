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
//! `{prompt}` is the ask and `{model}` is the configured model. An argument that mentions a
//! placeholder with nothing behind it is **dropped whole** — with no model configured,
//! `--model {model}` disappears rather than being sent as an empty string, which is the shape most
//! CLIs reject. Quotes group words the way a shell does, so `--system "be brief"` is two arguments
//! and not three.

use tokio::process::Command;

use crate::ai::{AiEngine, AiInvocation, AiRun};

pub const PROVIDER_ID: &str = "custom";

/// What the template is when the user has not written one: the shape almost every headless agent
/// takes, and the one most likely to just work.
const DEFAULT_ARGS: &str = "-p {prompt}";

/// The engine, carrying the argument line read from settings — see [`AiEngine::configure`].
#[derive(Default)]
pub struct CustomEngine {
    args: String,
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
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let template = if self.args.trim().is_empty() { DEFAULT_ARGS } else { self.args.as_str() };
        let mut command = Command::new(binary);
        command.args(render_args(template, inv.prompt, inv.model));
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
            session_id: None,
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
pub fn render_args(template: &str, prompt: &str, model: &str) -> Vec<String> {
    split_words(template)
        .into_iter()
        .filter_map(|word| {
            // An argument that mentions a placeholder nothing was given for is dropped whole:
            // `--model {model}` with no model is two arguments most CLIs refuse, and one of them is
            // empty. The prompt is never empty in practice, but it is treated the same way for the
            // same reason.
            if word.contains("{model}") && model.trim().is_empty() {
                return None;
            }
            if word.contains("{prompt}") && prompt.is_empty() {
                return None;
            }
            Some(word.replace("{prompt}", prompt).replace("{model}", model))
        })
        .collect()
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
        assert_eq!(
            render_args("run --model {model} {prompt}", "hola", ""),
            vec!["run".to_string(), "--model".to_string(), "hola".to_string()]
        );
        assert_eq!(
            render_args("run --model {model} {prompt}", "hola", "fast-1"),
            vec!["run".to_string(), "--model".to_string(), "fast-1".to_string(), "hola".to_string()]
        );
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
