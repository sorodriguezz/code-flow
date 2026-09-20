//! Caveman mode: answers compressed to their technical substance.
//!
//! # Where this comes from
//!
//! The style, the level names and the rules below are adapted from the **Caveman skill** by Julius
//! Brussee — <https://github.com/JuliusBrussee/caveman>, MIT — which is a rule file that tells an
//! agent to drop prose while keeping code, commands and error strings intact. CodeFlow is not
//! affiliated with that project and this is not a port of its proxy: the upstream tool has a second
//! half, a local process that compresses what an agent *reads* before it reaches the provider, and
//! nothing here does that. What this implements is the skill — the half that is a prompt.
//!
//! The text is rewritten rather than copied, for two reasons that both point the same way. It has
//! to be in Spanish, like every other prompt this app writes, and it has to fit *this* app: the
//! rules land beside a system prompt that already talks about working directories and file
//! generation, and a second document arguing with that one in a different register would be a
//! conversation between two prompts with the model in the middle.
//!
//! # Why it is sent on every turn instead of living in the system prompt
//!
//! Because `ai::chat_turn` only sends a system prompt when a session is *starting* — a resumed one
//! already carries it. Five of the six engines resume, so a mode written only into the system prompt
//! would do nothing at all when switched on mid-conversation, which is the moment anybody switches
//! it on. The user would type `/caveman`, ask a question, get the same verbose answer, and
//! reasonably conclude the command was decorative.
//!
//! The alternative — dropping the engine session so the next turn re-establishes the prompt — is
//! worse than it looks: that turn then replays the whole transcript, which on a long conversation
//! costs far more than the mode will ever save. Paying ~150 tokens a turn to carry the rules is the
//! cheap option, and it is the one the upstream skill implicitly asks for anyway: it warns about
//! "filler drift" on long sessions, which is what a rule stated once and never repeated produces.
//!
//! The instruction is appended to what the *engine* receives and is never stored: the transcript
//! keeps the user's own words, so the bubbles stay readable and a replay does not carry twelve
//! copies of the rules.

/// The levels, in the order the picker shows them — mildest first, and the classical-Chinese
/// variants last because they change the answer's *language* rather than its density.
///
/// Spelled exactly as the upstream skill spells them, which is what makes `/caveman ultra` mean the
/// same thing here as in a terminal. They are identifiers: never translated, never localised.
pub const LEVELS: [&str; 6] =
    ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"];

/// What `/caveman` with no level means. The upstream default, and the one worth having: `lite` is
/// too close to ordinary politeness to be worth a command, and `ultra` is a lot to be given by
/// surprise.
const DEFAULT_LEVEL: &str = "full";

/// The words that mean "stop".
///
/// Three, not one. "off", "stop" and "normal" are all what people actually type, and refusing two
/// of them would make the command look broken at the exact moment somebody wants out of the mode —
/// which is the worst possible moment for a command to argue about vocabulary.
const OFF_WORDS: [&str; 4] = ["off", "stop", "normal", "none"];

/// Turns whatever followed `/caveman` into a level to store.
///
/// - `""` (the bare command) → [`DEFAULT_LEVEL`].
/// - any of [`OFF_WORDS`] → `""`, which is how the column spells off.
/// - one of [`LEVELS`] → itself.
/// - anything else → `None`, and the caller says so rather than guessing.
///
/// # Why this is here and not in the frontend
///
/// Because it is three rules about one vocabulary, and the vocabulary already lives here. Split
/// across two languages, the half in TypeScript would be the half nobody updates when a level is
/// added: the picker would offer it, the command would refuse it, and the two would be describing
/// the same feature differently. The frontend asks and renders the answer — the same division the
/// context-window table uses.
///
/// Case-insensitive on the way in, because this is typed by a person. The stored value is always
/// canonical lowercase, because it is an identifier.
pub fn resolve(argument: &str) -> Option<String> {
    let asked = argument.trim().to_ascii_lowercase();
    if asked.is_empty() {
        return Some(DEFAULT_LEVEL.to_string());
    }
    if OFF_WORDS.contains(&asked.as_str()) {
        return Some(String::new());
    }
    valid(&asked).then_some(asked)
}

/// Whether a stored or typed level is one this app knows.
///
/// Empty is **not** valid here and is handled by the caller as "off" — the same shape `ai::effort`
/// uses, and for the same reason: a column that stores the off state as an empty string wants one
/// spelling of off, not two.
pub fn valid(level: &str) -> bool {
    LEVELS.contains(&level)
}

/// Whether this level answers in classical Chinese, which is the one thing about it that overrides
/// the ordinary "reply in the user's language" rule.
fn is_wenyan(level: &str) -> bool {
    level.starts_with("wenyan")
}

/// The instruction a turn carries for this level, or `None` when the mode is off or the level is
/// not one of [`LEVELS`].
///
/// `None` for an unrecognised level rather than a fallback to [`DEFAULT_LEVEL`]: the column can only
/// hold what this app wrote, so an unknown value means a database from a newer build or a hand-edit,
/// and silently answering in a style nobody asked for is worse than answering normally.
///
/// # What is in it and why each part is
///
/// The rules that are *not* about brevity are the ones that make the mode safe to leave on. A
/// compression rule with no floor eventually eats a negation, an exact number or the one line of an
/// error that identified it, and the answer stays confident while being wrong. So: negations,
/// figures, code and error strings are fixed points, and the whole style stands aside for security
/// warnings and irreversible actions.
///
/// The "never add words" rule is the one people are surprised by. Caveman-sounding phrasing —
/// dropped copulas, mangled verb forms, invented abbreviations, arrows — is usually the *same* token
/// count or worse, so it buys nothing and costs the reader. The mode is compression, not an accent.
pub fn instruction(level: &str) -> Option<String> {
    if !valid(level) {
        return None;
    }

    // Written terse, which is not a joke: this text rides on every turn the mode is on, and a
    // three-hundred-word essay about being concise would spend more than the style saves.
    let mut rules = String::from(
        "ESTILO CAVEMAN. Comprime: la sustancia técnica se queda, solo muere el relleno.\n\
         Quita: muletillas (en realidad, básicamente, simplemente), cortesías (claro, por supuesto), \
         rodeos, y la narración de lo que vas a hacer.\n\
         Nunca quites: negaciones (no, nunca, solo, salvo), cifras ni unidades. Código, nombres de \
         API, comandos y errores: literales.\n\
         No añadas palabras para sonar cavernícola: si la versión comprimida no es más corta, usa \
         la normal. Nada de abreviaturas inventadas (cfg, impl, req) ni flechas (→): no ahorran \
         tokens y se leen peor.\n\
         Una idea por frase. Voz activa. El mismo término para la misma cosa.\n",
    );

    rules.push_str(match level {
        "lite" => {
            "Nivel lite: conserva artículos y frases completas. Profesional y apretado, sin relleno.\n"
        }
        "full" => {
            "Nivel full: quita los artículos, los fragmentos valen, sinónimos cortos. Sin tablas \
             decorativas ni emoji. No vuelques logs largos: cita la línea que decide.\n"
        }
        "ultra" => {
            "Nivel ultra: quita también las conjunciones cuando causa y efecto queden claros. Una \
             palabra si basta una. Cada hecho, una sola vez.\n"
        }
        "wenyan-lite" => {
            "Nivel wenyan-lite: responde en chino clásico (文言文) de registro semiclásico, \
             conservando la estructura gramatical.\n"
        }
        "wenyan-full" => {
            "Nivel wenyan-full: responde en chino clásico (文言文) pleno — partículas clásicas \
             (之, 乃, 為, 其), sujeto omitido a menudo, concisión máxima.\n"
        }
        "wenyan-ultra" => {
            "Nivel wenyan-ultra: chino clásico llevado al extremo, abreviación máxima.\n"
        }
        // Unreachable: `valid` already refused everything else.
        _ => "",
    });

    rules.push_str(if is_wenyan(level) {
        // The one place the level overrides a rule rather than tightening it, said explicitly so
        // the two instructions do not read as a contradiction the model has to resolve.
        // The floor on code and error strings is already stated above and applies here too;
        // repeating it would spend tokens on every wenyan turn to say the same thing twice.
        "Esto sustituye a la regla de idioma: responde en 文言文 aunque el usuario escriba en \
         otro idioma.\n"
    } else {
        "Responde en el idioma del usuario.\n"
    });

    rules.push_str(
        "Deja el estilo cuando la claridad lo pida: avisos de seguridad, confirmaciones de acciones \
         irreversibles, pasos donde el orden se pueda malinterpretar, o cuando el usuario pida que \
         aclares. Luego vuelve a él.\n\
         Fuera del chat (commits, documentación, issues) escribe prosa normal: la leen otras \
         personas.\n\
         No anuncies el modo ni lo comentes. No des la respuesta dos veces.",
    );

    Some(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_and_nonsense_carry_no_instruction() {
        // The column's off state, and a value from a build that knew a level this one does not.
        // Both answer normally rather than guessing at a style nobody asked for.
        assert!(instruction("").is_none());
        assert!(instruction("neanderthal").is_none());
        assert!(instruction("FULL").is_none(), "levels are identifiers, not prose");
    }

    #[test]
    fn every_level_produces_an_instruction_naming_itself() {
        for level in LEVELS {
            let text = instruction(level).unwrap_or_else(|| panic!("{level} has no instruction"));
            assert!(text.contains(level), "{level} does not say which level it is");
        }
    }

    /// The floors, on every level.
    ///
    /// These are what make the mode safe to leave on for a week. A compression rule with no floor
    /// eventually eats a negation or the one line of an error that identified it, and the answer
    /// stays confident while being wrong — which is the failure that would be blamed on the model.
    #[test]
    fn no_level_is_allowed_to_compress_away_meaning() {
        for level in LEVELS {
            let text = instruction(level).unwrap();
            assert!(text.contains("Nunca quites"), "{level} lost the floor on negations");
            assert!(text.contains("literales"), "{level} lost the floor on code and errors");
            assert!(text.contains("irreversibles"), "{level} lost the clarity carve-out");
        }
    }

    /// The classical-Chinese levels override the language rule; the others state it.
    ///
    /// Both halves matter. Without the override, `wenyan-full` is two instructions contradicting
    /// each other — answer in 文言文, answer in the user's language — and which one wins is the
    /// model's guess. Without the plain rule, `ultra` on a Spanish conversation drifts into English,
    /// because the rules themselves are one long Spanish paragraph and the examples are not.
    #[test]
    fn the_language_rule_is_stated_once_and_the_right_way_round() {
        for level in ["lite", "full", "ultra"] {
            let text = instruction(level).unwrap();
            assert!(text.contains("idioma del usuario"));
            assert!(!text.contains("文言文"), "{level} is not a classical Chinese level");
        }
        for level in ["wenyan-lite", "wenyan-full", "wenyan-ultra"] {
            let text = instruction(level).unwrap();
            assert!(text.contains("文言文"), "{level} never says to write classical Chinese");
            assert!(
                text.contains("sustituye a la regla de idioma"),
                "{level} leaves two language rules arguing",
            );
        }
    }

    /// It rides on every turn, so its own size is part of the feature.
    ///
    /// Not a style rule — a budget. The mode exists to spend fewer tokens, and an instruction that
    /// grew into an essay about concision would spend more than the answers save. Measured in
    /// characters because that is what this side can count; roughly 150-200 tokens.
    #[test]
    fn the_instruction_stays_cheaper_than_what_it_saves() {
        for level in LEVELS {
            let text = instruction(level).unwrap();
            assert!(
                text.chars().count() < 1_400,
                "{level} costs {} characters on every single turn",
                text.chars().count(),
            );
        }
    }

    /// The three rules `/caveman` follows, in one place.
    ///
    /// They used to be split — validity here, the default and the off-words in `ChatView.tsx` —
    /// which is how the picker and the command end up disagreeing about the same feature the first
    /// time a level is added.
    #[test]
    fn the_bare_command_means_full_and_three_words_mean_stop() {
        assert_eq!(resolve("").as_deref(), Some(DEFAULT_LEVEL));
        assert_eq!(resolve("   ").as_deref(), Some("full"));

        for word in ["off", "stop", "normal", "none", "OFF", " Stop "] {
            assert_eq!(resolve(word).as_deref(), Some(""), "{word} must turn the mode off");
        }

        for level in LEVELS {
            assert_eq!(resolve(level).as_deref(), Some(level));
        }
        // Typed by a person, stored as an identifier.
        assert_eq!(resolve("ULTRA").as_deref(), Some("ultra"));
        assert_eq!(resolve(" wenyan-full ").as_deref(), Some("wenyan-full"));
    }

    /// Anything else is refused rather than rounded to the nearest level.
    ///
    /// A user who typed `/caveman ultra-max` believing they had changed something is the failure
    /// here, and it is silent: they would go on reading `full` answers and blaming the model.
    #[test]
    fn a_word_that_is_not_a_level_is_not_a_level() {
        assert!(resolve("ultra-max").is_none());
        assert!(resolve("wenyan").is_none(), "wenyan alone names no level");
        assert!(resolve("neanderthal").is_none());
    }

    #[test]
    fn the_level_names_are_the_ones_the_upstream_skill_uses() {
        // `/caveman ultra` has to mean the same thing here as in a terminal, or the command is a
        // different command wearing the same name.
        assert!(valid("lite") && valid("full") && valid("ultra"));
        assert!(valid("wenyan-lite") && valid("wenyan-full") && valid("wenyan-ultra"));
        assert!(!valid("off"), "off is the empty column, not a level");
        assert_eq!(resolve("").as_deref(), Some("full"));
    }
}
