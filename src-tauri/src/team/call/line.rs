//! What one agent says in a call: who it is told it is, how what it writes is cut into sentences
//! for its voice as it is written, and the two things it may ask the call for at the end of its
//! words — a look at the code, or a colleague's turn.

use super::Line;
use crate::team::MemberSnap;

/// What an agent's words ask of the call, written on lines of their own and never said.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Asks {
    /// `[[revisar: …]]`: it has to look at the repository before it can answer.
    pub look: Option<String>,
    /// `[[palabra: …]]`: who it hands the word to, as it wrote it — an id or a name.
    pub hand: Option<String>,
}

/// `written` as it is said, and what it asks for.
pub fn read(written: &str) -> (String, Asks) {
    let mut asks = Asks::default();
    let mut said = String::new();
    let mut rest = written;
    while let Some(open) = rest.find("[[") {
        said.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            // Opened and never closed: the rest was meant for the call, not for the room.
            rest = "";
            break;
        };
        let inside = after[..close].trim();
        let (key, value) = inside.split_once(':').map_or((inside, ""), |(k, v)| (k.trim(), v.trim()));
        match crate::codi::router::normalize(key).as_str() {
            "revisar" | "review" | "look" | "mirar" | "consultar" if !value.is_empty() => asks.look = Some(value.to_string()),
            "palabra" | "word" | "turno" | "floor" | "pass" if !value.is_empty() => asks.hand = Some(value.to_string()),
            _ => {}
        }
        rest = &after[close + 2..];
    }
    said.push_str(rest);
    (tidy(&said), asks)
}

/// Spoken text with what a model adds out of habit taken out: emphasis marks, a heading's hashes,
/// a list's dashes. What is left is read as it stands.
fn tidy(text: &str) -> String {
    text.lines()
        .map(|line| line.trim().trim_start_matches(['#', '>', '-', '*', '•']).trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .replace("**", "")
        .replace("__", "")
        .replace('`', "")
}

/// Cuts words into sentences as they are written, for a voice that starts before the answer is
/// whole. Hands over each sentence once, and nothing from an ask (`[[…`) on.
#[derive(Default)]
pub struct Cutter {
    /// Everything written so far.
    written: String,
    /// How much of `written` has been handed over, in bytes.
    given: usize,
}

impl Cutter {
    /// More words arrived: the sentences they complete.
    pub fn push(&mut self, more: &str) -> Vec<String> {
        // What comes before the first word is not part of the answer: the whole one comes trimmed.
        self.written.push_str(if self.written.is_empty() { more.trim_start() } else { more });
        self.cut(false)
    }

    /// The answer is whole (`whole`, as the engine returned it): what is left to say. An engine that
    /// rewrote its answer — the whole does not begin with what was already said — adds nothing:
    /// what was said stays said, and nothing is said twice.
    pub fn finish(&mut self, whole: &str) -> Vec<String> {
        let whole = whole.trim_start();
        if !whole.starts_with(&self.written[..self.given]) {
            return Vec::new();
        }
        self.written = whole.to_string();
        self.cut(true)
    }

    /// Everything written so far, as it reads — for the line on screen.
    pub fn so_far(&self) -> String {
        read(&self.written).0
    }

    fn cut(&mut self, last: bool) -> Vec<String> {
        // Nothing from an ask on is said.
        let end = self.written[self.given..].find("[[").map_or(self.written.len(), |at| self.given + at);
        let pending = &self.written[self.given..end];
        let mut out = Vec::new();
        let mut start = 0usize;
        let bytes: Vec<(usize, char)> = pending.char_indices().collect();
        for (i, (at, c)) in bytes.iter().enumerate() {
            let closes = matches!(c, '.' | '!' | '?' | '…' | '\n');
            if !closes {
                continue;
            }
            // A full stop ends a sentence when a space follows it: «2.9.11» and «v1.2» go on.
            let next = bytes.get(i + 1).map(|(_, n)| *n);
            let ends = *c == '\n' || next.is_some_and(char::is_whitespace);
            if !ends {
                continue;
            }
            let stop = at + c.len_utf8();
            let sentence = tidy(&pending[start..stop]);
            // A sentence too short to be one («1.», «Ok.») goes with the next.
            if sentence.chars().count() >= 12 || *c == '\n' {
                if !sentence.is_empty() {
                    out.push(sentence);
                }
                start = stop;
            }
        }
        if last {
            let tail = tidy(&pending[start..]);
            if !tail.is_empty() {
                out.push(tail);
            }
            start = pending.len();
        }
        self.given += start;
        out
    }
}

/// The conversation as an agent is handed it: the last of it, oldest first.
pub fn talk(lines: &[Line], lang: &str) -> String {
    const KEEP: usize = 40;
    const CHARS: usize = 9_000;
    let mut out: Vec<String> = Vec::new();
    let mut size = 0usize;
    for line in lines.iter().rev().filter(|line| line.kind == "say" && !line.text.trim().is_empty()).take(KEEP) {
        let name = if line.who == "user" { if lang == "es" { "Usuario" } else { "User" } } else { line.name.as_str() };
        let row = format!("[{}] {name}: {}", clock(line.at_ms), line.text.trim());
        size += row.len();
        if size > CHARS {
            break;
        }
        out.push(row);
    }
    out.reverse();
    if out.is_empty() {
        return if lang == "es" { "(La llamada acaba de empezar.)".into() } else { "(The call has just started.)".into() };
    }
    out.join("\n")
}

/// `mm:ss` into the call.
pub fn clock(at_ms: u64) -> String {
    let seconds = at_ms / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

/// Who `member` is told it is, and how a call is spoken in.
pub fn system(member: &MemberSnap, team: &str, lead: bool, roster: &str, facts: &str, lang: &str) -> String {
    let name = crate::team::member_name(member);
    let role = member.member.role.trim();
    let own = member.prompt.trim();
    if lang == "es" {
        format!(
            "{own}\n\n# Llamada con el equipo «{team}»\n\
             Estás en una llamada de voz con la persona que dirige el equipo y con tus compañeros. Eres {name}{role_part}.{lead_part}\n\n\
             ## Cómo se habla aquí\n\
             - Lo que escribes se dice en voz alta, con tu voz. Habla como en una reunión: una o dos frases cortas, unas cuarenta palabras como mucho, en primera persona. Di lo más importante y para: si quieren más, te lo piden.\n\
             - Solo palabras: sin Markdown, sin listas, sin código, sin rutas ni URLs. Nombra las cosas por lo que son («el archivo de configuración», «dos pruebas»).\n\
             - No te presentes, no repitas lo que te preguntaron y no cierres con ofrecimientos.\n\
             - Responde desde tu rol y con lo que sabes de verdad. Lo que está en «Hechos» es cierto; lo demás, si no lo sabes sin mirar el código, dilo.\n\
             - Si necesitas consultar el repositorio, ejecutar un comando o hacer un cambio que te pidieron ahora, dilo en una frase y termina con una línea aparte: [[revisar: qué hay que hacer]]. Tus herramientas y permisos se aplican en ese turno. Vuelves a hablar con el resultado.\n\
             - Para darle la palabra a un compañero, termina con una línea aparte: [[palabra: su id]]. Solo cuando su respuesta haga falta ahora.\n\
             - Cuando se acuerde trabajo para después de la llamada, di quién se encarga de cada tarea pendiente.\n\n\
             ## Equipo\n{roster}\n\n## Hechos\n{facts}",
            role_part = if role.is_empty() { String::new() } else { format!(", {role}") },
            lead_part = if lead { " Lideras el equipo: moderas, concretas los acuerdos y decides a quién hace falta oír." } else { "" },
        )
    } else {
        format!(
            "{own}\n\n# Call with the team “{team}”\n\
             You are on a voice call with the person who leads the team and with your colleagues. You are {name}{role_part}.{lead_part}\n\n\
             ## How people talk here\n\
             - What you write is said aloud, in your voice. Talk as in a meeting: one or two short sentences, about forty words at most, first person. Say what matters most and stop: if they want more, they ask.\n\
             - Words only: no Markdown, no lists, no code, no paths or URLs. Name things by what they are (“the configuration file”, “two tests”).\n\
             - Do not introduce yourself, do not repeat the question and do not close with offers.\n\
             - Answer from your role and from what you actually know. What is under “Facts” is true; anything else, if you cannot know it without reading the code, say so.\n\
             - If you need to inspect the repository, run a command, or make a change requested during the call, say so in one sentence and end with a line of its own: [[review: what needs doing]]. Your tools and permissions apply in that turn. You speak again with the result.\n\
             - To hand the word to a colleague, end with a line of its own: [[word: their id]]. Only when their answer is needed now.\n\
             - When work is agreed for after the call, say who owns each pending task.\n\n\
             ## Team\n{roster}\n\n## Facts\n{facts}",
            role_part = if role.is_empty() { String::new() } else { format!(", {role}") },
            lead_part = if lead { " You lead the team: you moderate, pin down what is agreed and decide who needs to be heard." } else { "" },
        )
    }
}

/// What a member is told when it is its turn.
pub enum Ask<'a> {
    /// The user spoke to it.
    Direct(&'a str),
    /// The user asked everybody; `closing` for the lead, who speaks last.
    Round { said: &'a str, closing: bool },
    /// A colleague handed it the word.
    Handed { by: &'a str },
}

pub fn ask(ask: &Ask<'_>, lang: &str) -> String {
    match (ask, lang) {
        (Ask::Direct(said), "es") => format!("Te hablan a ti: «{said}». Responde ahora."),
        (Ask::Direct(said), _) => format!("You are being spoken to: “{said}”. Answer now."),
        (Ask::Round { said, closing: false }, "es") => format!("Se le pregunta a todo el equipo: «{said}». Da tu postura desde tu rol en una o dos frases, sin repetir lo que ya se dijo."),
        (Ask::Round { said, closing: false }, _) => format!("The whole team is asked: “{said}”. Give your view from your role in one or two sentences, without repeating what was said."),
        (Ask::Round { said, closing: true }, "es") => format!("Se le preguntó a todo el equipo: «{said}». Ya hablaron los demás. Cierra la ronda: di en dos frases en qué hay acuerdo y qué falta decidir."),
        (Ask::Round { said, closing: true }, _) => format!("The whole team was asked: “{said}”. The others have spoken. Close the round: say in two sentences what is agreed and what is left to decide."),
        (Ask::Handed { by }, "es") => format!("{by} te da la palabra. Responde a lo que se está hablando."),
        (Ask::Handed { by }, _) => format!("{by} hands you the word. Answer what is being discussed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_asked_of_the_call_is_read_and_never_said() {
        let (said, asks) = read("Lo reviso ahora mismo.\n[[revisar: los índices de la tabla cita]]");
        assert_eq!(said, "Lo reviso ahora mismo.");
        assert_eq!(asks, Asks { look: Some("los índices de la tabla cita".into()), hand: None });

        let (said, asks) = read("Eso lo sabe mejor QA.\n[[palabra: qa]]\n");
        assert_eq!(said, "Eso lo sabe mejor QA.");
        assert_eq!(asks.hand.as_deref(), Some("qa"));

        // English spellings, and one left open at the end of a cut answer.
        assert_eq!(read("On it. [[review: the migration]]").1.look.as_deref(), Some("the migration"));
        assert_eq!(read("Vamos bien. [[palabra: q").0, "Vamos bien.");
        // What a model adds out of habit.
        assert_eq!(read("**Sí.** El `cupo` se protege\n- desde la aplicación.").0, "Sí. El cupo se protege desde la aplicación.");
    }

    #[test]
    fn sentences_are_handed_over_as_they_are_finished() {
        let mut cutter = Cutter::default();
        assert!(cutter.push("El desarrollo est").is_empty());
        assert!(cutter.push("á terminado").is_empty(), "no full stop yet");
        assert_eq!(cutter.push(". QA verifica").as_slice(), ["El desarrollo está terminado."]);
        // A version is not the end of a sentence, and nothing of an ask is said.
        assert_eq!(cutter.push(" la 2.9.11 ahora. ¿Seguimos?\n[[palabra: qa]]").as_slice(), ["QA verifica la 2.9.11 ahora.", "¿Seguimos?"]);
        assert_eq!(cutter.so_far(), "El desarrollo está terminado. QA verifica la 2.9.11 ahora. ¿Seguimos?");
        assert!(cutter.finish("El desarrollo está terminado. QA verifica la 2.9.11 ahora. ¿Seguimos?\n[[palabra: qa]]").is_empty());
    }

    #[test]
    fn an_answer_that_came_whole_is_said_whole_and_a_short_start_waits_for_more() {
        let mut cutter = Cutter::default();
        assert_eq!(cutter.finish("Sí. Falta un escenario de expiración").as_slice(), ["Sí. Falta un escenario de expiración"]);

        let mut cutter = Cutter::default();
        assert!(cutter.push("Ok. ").is_empty(), "too short to say alone");
        assert_eq!(cutter.push("Lo dejamos así entonces. ").as_slice(), ["Ok. Lo dejamos así entonces."]);
        // The engine's final text is another one: what was said stays said, nothing is said twice.
        assert!(cutter.finish("Una respuesta completamente distinta.").is_empty());
    }

    #[test]
    fn the_conversation_is_handed_over_with_who_said_what() {
        let line = |who: &str, name: &str, text: &str, at_ms: u64| Line { id: "x".into(), at_ms, who: who.into(), name: name.into(), text: text.into(), partial: false, kind: "say" };
        let lines = vec![line("user", "", "Líder, ¿cómo vamos?", 32_000), line("lead", "Arquitecto", "Bien.", 34_000), Line { kind: "note", ..line("call", "", "QA consulta", 40_000) }];
        assert_eq!(talk(&lines, "es"), "[00:32] Usuario: Líder, ¿cómo vamos?\n[00:34] Arquitecto: Bien.");
        assert_eq!(talk(&[], "en"), "(The call has just started.)");
    }
}
