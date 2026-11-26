//! Who a thing said in a call is for, and whether it is an order to the call itself — read off the
//! words alone, with no model: a call that waits a second to learn who was spoken to is not a call.
//!
//! A name counts where a person is named when spoken to: at the start of what is said or at its
//! very end («DBA, ¿cómo ves la base?», «¿qué opinas, QA?»). In the middle it is somebody being
//! talked *about* («el backend debería exponer eso»), and nobody is being asked.

use crate::codi::router::normalize;

/// What the call itself is told to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// «Háganlo»: what was agreed starts now.
    Go,
    /// «Esperen»: whoever is speaking stops.
    Wait,
    /// «Terminamos»: the call ends as if hung up.
    End,
}

/// Who answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum To {
    /// These members, in the order they were named.
    Members(Vec<String>),
    /// Everybody, a turn each.
    Team,
    /// Nobody was named: whoever spoke last, else the lead.
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routed {
    pub order: Option<Order>,
    pub to: To,
}

/// One seat as the router knows it.
pub struct Seat<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub role: &'a str,
    pub lead: bool,
}

/// How far into what is said a name is still an address.
const OPENING: usize = 5;

const LEAD_WORDS: &[&str] = &["lider", "lead", "leader", "jefe", "jefa"];
const TEAM_WORDS: &[&str] = &["equipo", "team", "todos", "todas", "everyone", "everybody"];
const TEAM_PHRASES: &[&str] = &[
    "que opina el equipo", "que opinan", "que piensa el equipo", "que piensan", "que dice el equipo", "que dicen todos",
    "what does the team think", "what do you all think", "what does everyone think",
];
const GO: &[&str] = &[
    "haganlo", "hagamoslo", "hagan eso", "manos a la obra", "empiecen", "comiencen", "ejecutenlo", "ejecuten el plan", "ponganse a trabajar",
    "pongamonos a trabajar", "adelante con el plan", "adelante con eso", "denle", "dale con eso",
    "go ahead", "do it", "get to work", "start working", "make it happen", "lets do it", "let s do it", "get started",
];
const WAIT: &[&str] = &["esperen", "espera", "esperate", "para", "paren", "silencio", "un momento", "momento", "wait", "stop", "hold on", "one moment"];
const END: &[&str] = &[
    "terminamos", "eso es todo", "eso seria todo", "cuelgo", "voy a colgar", "hasta luego", "nos vemos", "fin de la llamada", "cerramos",
    "that s all", "thats all", "we re done", "were done", "bye", "goodbye", "end the call", "hang up",
];
const NOT: &[&str] = &["no", "aun", "todavia", "not", "don", "dont", "never", "nunca"];

/// Reads `text` as said to a call with `seats`.
pub fn route(text: &str, seats: &[Seat<'_>]) -> Routed {
    let said = normalize(text);
    let words: Vec<&str> = said.split(' ').filter(|w| !w.is_empty()).collect();
    Routed { order: order(&said, &words), to: addressed(&said, &words, seats) }
}

/// Whether `text` names somebody or tells the call to wait — what gets through while an agent is
/// speaking on a computer with no headphones, where anything else may be the agent heard back.
pub fn cuts_in(text: &str, seats: &[Seat<'_>]) -> bool {
    let routed = route(text, seats);
    routed.order == Some(Order::Wait) || !matches!(routed.to, To::Open)
}

/// Words that give somebody the word and ask nothing: «adelante», «habla», «el siguiente».
const YIELD: &[&str] = &[
    "habla", "hable", "hablen", "adelante", "dale", "dime", "dinos", "cuenta", "cuentame", "cuentanos", "escucho", "escuchamos", "palabra", "sigue", "siga",
    "continua", "continue", "siguiente", "turno", "go", "ahead", "speak", "talk", "tell", "listening", "next", "turn", "floor", "word",
];
/// Words that say nothing by themselves, around a name or a [`YIELD`].
const SMALL: &[&str] = &[
    "a", "al", "el", "la", "los", "las", "le", "te", "tu", "tienes", "tiene", "que", "por", "favor", "ya", "ahora", "si", "ok", "okay", "vale", "bueno", "oye", "y",
    "es", "su", "me", "nos", "de", "del", "the", "you", "your", "have", "has", "is", "it", "s", "please", "now", "yes", "we", "re", "i", "m", "us", "to",
];

/// Whether `text` only gives the word — a name by itself, «adelante», «te escucho, DBA» — and asks
/// nothing: said to somebody with a hand up, it is what lets it speak, not a new question.
pub fn yields(text: &str, seats: &[Seat<'_>]) -> bool {
    let said = normalize(text);
    let words: Vec<&str> = said.split(' ').filter(|w| !w.is_empty()).collect();
    let names: std::collections::HashSet<String> = seats.iter().flat_map(|seat| keys(seat, seats)).flat_map(|key| key.split(' ').map(str::to_string).collect::<Vec<_>>()).collect();
    let named = words.iter().any(|word| names.contains(*word));
    let rest: Vec<&str> = words.iter().copied().filter(|word| !names.contains(*word) && !SMALL.contains(word)).collect();
    // Something has to say it: a name, or a word that gives the word.
    (named || !rest.is_empty()) && rest.iter().all(|word| YIELD.contains(word))
}

fn has_phrase(said: &str, phrase: &str) -> bool {
    said == phrase || said.starts_with(&format!("{phrase} ")) || said.ends_with(&format!(" {phrase}")) || said.contains(&format!(" {phrase} "))
}

fn order(said: &str, words: &[&str]) -> Option<Order> {
    let any = |list: &[&str]| list.iter().any(|phrase| has_phrase(said, phrase));
    // «No lo hagan todavía» holds the words of an order and means the opposite.
    let refused = words.iter().any(|w| NOT.contains(w));
    if words.len() <= 4 && any(WAIT) {
        return Some(Order::Wait);
    }
    if !refused && words.len() <= 10 && any(GO) {
        return Some(Order::Go);
    }
    if !refused && words.len() <= 7 && any(END) {
        return Some(Order::End);
    }
    None
}

fn addressed(said: &str, words: &[&str], seats: &[Seat<'_>]) -> To {
    if TEAM_PHRASES.iter().any(|phrase| has_phrase(said, phrase)) {
        return To::Team;
    }
    // Where an address may stand: the opening words and the last two.
    let zone = |at: usize, len: usize| at < OPENING || at + len + 2 > words.len();
    let found_at = |key: &[&str]| -> Option<usize> {
        if key.is_empty() || key.len() > words.len() {
            return None;
        }
        (0..=words.len() - key.len()).find(|at| words[*at..*at + key.len()] == *key && zone(*at, key.len()))
    };
    // Each seat's best match: the earliest, and the longest there.
    let mut hits: Vec<(usize, usize, &str)> = Vec::new();
    for seat in seats {
        let mut best: Option<(usize, usize)> = None;
        for key in keys(seat, seats) {
            let key: Vec<&str> = key.split(' ').collect();
            if let Some(at) = found_at(&key) {
                let better = best.is_none_or(|(old_at, old_len)| at < old_at || (at == old_at && key.len() > old_len));
                if better {
                    best = Some((at, key.len()));
                }
            }
        }
        if let Some((at, len)) = best {
            hits.push((at, len, seat.id));
        }
    }
    // «Líder backend» is that member, not the lead and that member: a match inside a longer one
    // of somebody else's is a word of their name.
    let inside = |(at, len, id): &(usize, usize, &str)| hits.iter().any(|(other_at, other_len, other)| other != id && other_len > len && other_at <= at && at + len <= other_at + other_len);
    let mut named: Vec<(usize, &str)> = hits.iter().filter(|hit| !inside(hit)).map(|(at, _, id)| (*at, *id)).collect();
    if named.is_empty() && words.iter().enumerate().any(|(at, word)| TEAM_WORDS.contains(word) && zone(at, 1)) {
        return To::Team;
    }
    if named.is_empty() {
        return To::Open;
    }
    named.sort();
    To::Members(named.into_iter().map(|(_, id)| id.to_string()).collect())
}

/// What a seat answers to: its whole name, its whole role, the words of its name nobody else's name
/// holds («QA», «DBA»), and «líder» for the lead.
fn keys(seat: &Seat<'_>, seats: &[Seat<'_>]) -> Vec<String> {
    let name = normalize(seat.name);
    let role = normalize(seat.role);
    let mut keys = Vec::new();
    for whole in [&name, &role] {
        if !whole.is_empty() && seats.iter().filter(|other| normalize(other.name) == **whole || normalize(other.role) == **whole).count() == 1 {
            keys.push(whole.clone());
        }
    }
    for word in name.split(' ').filter(|w| w.len() >= 2 && !FILLER.contains(w)) {
        let others = seats.iter().filter(|other| other.id != seat.id && normalize(other.name).split(' ').any(|w| w == word)).count();
        if others == 0 {
            keys.push(word.to_string());
        }
    }
    if seat.lead {
        keys.extend(LEAD_WORDS.iter().map(|word| word.to_string()));
    }
    keys.sort();
    keys.dedup();
    keys
}

/// Words of a name that name nobody: «de», «the», a seniority.
const FILLER: &[&str] = &["de", "del", "la", "el", "los", "las", "y", "the", "of", "and", "senior", "junior", "sr", "jr"];

#[cfg(test)]
mod tests {
    use super::*;

    fn seats() -> Vec<Seat<'static>> {
        vec![
            Seat { id: "lead", name: "Arquitecto", role: "Arquitectura", lead: true },
            Seat { id: "tl", name: "Líder técnico", role: "Coordinación", lead: false },
            Seat { id: "be", name: "Líder backend", role: "Backend", lead: false },
            Seat { id: "dba", name: "DBA", role: "Base de datos", lead: false },
            Seat { id: "qa", name: "QA", role: "Calidad", lead: false },
            Seat { id: "ui", name: "Diseñador UI", role: "Interfaz", lead: false },
            Seat { id: "ux", name: "Diseñador UX", role: "Experiencia", lead: false },
        ]
    }

    fn to(text: &str) -> To {
        route(text, &seats()).to
    }

    #[test]
    fn a_name_at_the_start_or_the_end_is_who_is_asked() {
        assert_eq!(to("DBA, ¿cómo ves la base de datos de core agenda?"), To::Members(vec!["dba".into()]));
        assert_eq!(to("¿Encontraste algún problema, QA?"), To::Members(vec!["qa".into()]));
        assert_eq!(to("Oye arquitecto, una duda sobre los eventos"), To::Members(vec!["lead".into()]));
        // A whole name wins over a word it shares: both designers are «diseñador».
        assert_eq!(to("Diseñador UX, ¿qué opinas del flujo?"), To::Members(vec!["ux".into()]));
        assert_eq!(to("Líder técnico, organiza eso"), To::Members(vec!["tl".into()]));
        // By what it does.
        assert_eq!(to("Calidad, ¿qué falta probar?"), To::Members(vec!["qa".into()]));
        // Tildes and case are how it was heard, not who it is.
        assert_eq!(to("lider tecnico: organiza eso"), To::Members(vec!["tl".into()]));
    }

    #[test]
    fn several_names_answer_in_the_order_they_were_said() {
        assert_eq!(to("QA y DBA, analicen esto juntos"), To::Members(vec!["qa".into(), "dba".into()]));
        assert_eq!(to("Arquitecto y QA, ¿están de acuerdo?"), To::Members(vec!["lead".into(), "qa".into()]));
    }

    #[test]
    fn someone_talked_about_is_not_being_asked() {
        assert_eq!(to("Creo que para esa parte del trabajo lo mejor sería que el dba revise los índices antes de seguir con lo demás"), To::Open);
        assert_eq!(to("¿Y por qué?"), To::Open);
        assert_eq!(to("Continuemos con lo anterior"), To::Open);
    }

    #[test]
    fn the_lead_answers_to_lider_only_when_no_name_holds_the_word() {
        // «Líder» alone is the lead of the team, not one of the two whose name starts with it.
        assert_eq!(to("Líder, ¿cómo vamos con la autenticación?"), To::Members(vec!["lead".into()]));
        assert_eq!(to("Líder backend, ¿cómo vamos?"), To::Members(vec!["be".into()]));
    }

    #[test]
    fn the_team_is_everybody() {
        assert_eq!(to("¿Qué opina el equipo?"), To::Team);
        assert_eq!(to("Equipo, quiero que discutan eventos de dominio contra llamadas síncronas"), To::Team);
        assert_eq!(to("What does the team think?"), To::Team);
        // A name said with it is the one asked.
        assert_eq!(to("QA, ¿y qué dice el resto del equipo de pruebas de esa otra área tan grande?"), To::Members(vec!["qa".into()]));
    }

    #[test]
    fn orders_to_the_call_are_short_and_mean_it() {
        let order = |text: &str| route(text, &seats()).order;
        assert_eq!(order("Háganlo"), Some(Order::Go));
        assert_eq!(order("Perfecto equipo, manos a la obra"), Some(Order::Go));
        assert_eq!(order("ok, go ahead"), Some(Order::Go));
        assert_eq!(order("No lo hagan todavía"), None);
        assert_eq!(order("Esperen"), Some(Order::Wait));
        assert_eq!(order("Para para"), Some(Order::Wait));
        assert_eq!(order("Esto es para el módulo de pagos que vimos ayer"), None, "«para» inside a sentence");
        assert_eq!(order("Listo, eso es todo"), Some(Order::End));
        assert_eq!(order("Terminamos por hoy"), Some(Order::End));
        assert_eq!(order("¿Cuándo terminamos la migración de la base de datos de agenda del core?"), None);
    }

    #[test]
    fn giving_the_word_asks_nothing() {
        let yields = |text: &str| yields(text, &seats());
        assert!(yields("Arquitecto"));
        assert!(yields("Adelante, arquitecto"));
        assert!(yields("Te escucho, DBA"));
        assert!(yields("Que hable el QA"));
        assert!(yields("El siguiente"));
        assert!(yields("Dale"));
        assert!(yields("DBA, tienes la palabra"));
        // A question is a question, whoever it names.
        assert!(!yields("DBA, ¿qué falta para que la base soporte particiones?"));
        assert!(!yields("Arquitecto, ¿y los eventos?"));
        // Neither a name nor a word that gives the word.
        assert!(!yields("Sí"));
        assert!(!yields(""));
    }

    #[test]
    fn over_an_agent_s_voice_only_a_name_or_a_wait_gets_through() {
        assert!(cuts_in("Esperen", &seats()));
        assert!(cuts_in("QA, un segundo", &seats()));
        assert!(!cuts_in("el desarrollo está terminado y se verifican los escenarios", &seats()));
    }
}
