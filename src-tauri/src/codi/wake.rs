//! «Codi, …»: whether an utterance is addressed to Codi, and what it asks once the name is taken off.
//!
//! **The name is read in the transcript, not listened for by a second model.** Every utterance is
//! transcribed here anyway (Parakeet, ~0.1 s), and transcribers spell a name they do not know the
//! way it sounds: measured on 2026-10-21, «Codi» came back as «Cody» nearly every time, and «Kodi»,
//! «Coti», «Código» now and then. So the first word or two are compared by sound, not by spelling —
//! an edit distance of one on the folded form, the names a user added beside it, an «oye» / «hey»
//! before it — and a comma after it is part of it.

use super::router::normalize;

/// What a recognizer writes for «Codi» — kept short and specific: «código» stays an order word.
const HEARD_AS: &[&str] = &["codi", "cody", "kodi", "kody", "coti", "codie", "kodie", "godi", "coddy", "codis", "codys", "kodis"];

/// What may come before the name and is not the order: «oye Codi», «ok Codi», «hey Cody».
const BEFORE: &[&str] = &["oye", "hey", "ey", "ok", "okay", "hola", "hi", "hello", "eh", "oiga"];

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let here = row[j + 1];
            row[j + 1] = (row[j + 1] + 1).min(row[j] + 1).min(previous + usize::from(ca != *cb));
            previous = here;
        }
    }
    row[b.len()]
}

/// One word sounds like one of `names`.
fn sounds_like(word: &str, names: &[String]) -> bool {
    HEARD_AS.contains(&word) || names.iter().any(|name| word == name || (name.len() >= 4 && word.len() >= 3 && distance(word, name) <= 1))
}

/// The order, when `heard` starts with Codi's name (or one of `names`): the words after it, in their
/// own spelling. `None` when it is not addressed to Codi.
pub fn addressed(heard: &str, names: &[String]) -> Option<String> {
    let words: Vec<&str> = heard.split_whitespace().collect();
    let folded: Vec<String> = words.iter().map(|w| normalize(w)).collect();
    let mut at = 0;
    while at < folded.len() && at < 2 && BEFORE.contains(&folded[at].as_str()) {
        at += 1;
    }
    let first = folded.get(at)?;
    // «Co di» split in two by the recognizer.
    let joined = folded.get(at + 1).map(|next| format!("{first}{next}"));
    let taken = if sounds_like(first, names) {
        1
    } else if joined.as_deref().is_some_and(|j| sounds_like(j, names)) {
        2
    } else {
        return None;
    };
    let rest = words[at + taken..].join(" ");
    Some(rest.trim_start_matches([',', '.', ':', ';', '!', '¡', '?', '¿', ' ']).trim().to_string())
}

/// A yes or a no to the question Codi is asking — a short answer only, and not one that says both
/// (its own «di sí o no» heard back from the speakers says both).
pub fn yes_or_no(heard: &str) -> Option<bool> {
    let text = normalize(heard);
    let words: Vec<&str> = text.split(' ').filter(|w| !w.is_empty()).collect();
    if words.is_empty() || words.len() > 5 {
        return None;
    }
    let yes = words.iter().any(|w| matches!(*w, "si" | "sip" | "dale" | "confirmo" | "confirma" | "hazlo" | "adelante" | "yes" | "yeah" | "yep" | "sure" | "ok" | "okay" | "claro" | "afirmativo"))
        || text.contains("do it")
        || text.contains("go ahead");
    let no = words.iter().any(|w| matches!(*w, "no" | "nop" | "cancela" | "cancelar" | "nope" | "cancel" | "negativo" | "espera" | "wait"))
        || text.contains("no lo hagas")
        || text.contains("don t");
    match (yes, no) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["codi".to_string()]
    }

    #[test]
    fn the_name_is_heard_however_it_was_spelled() {
        assert_eq!(addressed("Cody, abre flujos.", &names()).as_deref(), Some("abre flujos."));
        assert_eq!(addressed("Codi abre flujos", &names()).as_deref(), Some("abre flujos"));
        assert_eq!(addressed("Oye Kodi, cambia al repositorio api pagos", &names()).as_deref(), Some("cambia al repositorio api pagos"));
        assert_eq!(addressed("Hey Cody, open the database app.", &names()).as_deref(), Some("open the database app."));
        assert_eq!(addressed("co di silencio", &names()).as_deref(), Some("silencio"));
        assert_eq!(addressed("Codi.", &names()).as_deref(), Some(""));
    }

    #[test]
    fn what_is_not_addressed_to_it_is_left_alone() {
        assert_eq!(addressed("Abre flujos", &names()), None);
        assert_eq!(addressed("El código de la rama main está listo", &names()), None, "«código» is a word, not the name");
        assert_eq!(addressed("Necesitamos migrar la base de datos", &names()), None);
        assert_eq!(addressed("", &names()), None);
    }

    #[test]
    fn a_name_the_user_added_is_answered_too() {
        let names = vec!["codi".to_string(), "jarvis".to_string()];
        assert_eq!(addressed("Jarvis, abre las notas", &names).as_deref(), Some("abre las notas"));
        assert_eq!(addressed("Jervis abre las notas", &names).as_deref(), Some("abre las notas"), "one sound off");
    }

    #[test]
    fn yes_and_no_are_short_and_never_both() {
        assert_eq!(yes_or_no("Sí."), Some(true));
        assert_eq!(yes_or_no("Dale, hazlo"), Some(true));
        assert_eq!(yes_or_no("yes, do it"), Some(true));
        assert_eq!(yes_or_no("No."), Some(false));
        assert_eq!(yes_or_no("no lo hagas"), Some(false));
        assert_eq!(yes_or_no("di sí o no"), None, "its own question, heard back");
        assert_eq!(yes_or_no("sí, pero primero revisa los tests que están fallando en la rama"), None, "too long to be an answer");
    }
}
