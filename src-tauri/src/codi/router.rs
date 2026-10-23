//! The first of Codi's three tiers: an order that names one action plainly — «abre flujos», «cambia
//! al repositorio api pagos», «saca las notas a una ventana» — runs without any model, in well under
//! a millisecond, from the words the catalogue itself carries (`ActionSpec::aliases` for the verb,
//! `ActionSpec::vocabulary` for the values).
//!
//! **Sure or nothing.** It answers only when exactly one action's verb is in the order and every
//! required parameter was found; a tie, a missing value or a second verb ("…y después…") goes to the
//! local model or the provider, which read the whole sentence. Running the wrong thing at once would
//! cost more than the second the model takes.

use serde_json::{Map, Value};

use super::ui::ActionSpec;

/// Lowercase, without accents or punctuation — how aliases and vocabulary are written.
pub fn normalize(text: &str) -> String {
    let folded: String = text
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What Codi itself handles, before any action: be quiet, stop listening, the courtesy that needs no
/// answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Own {
    /// «para», «silencio», «cállate»: stop speaking now.
    Hush,
    /// «apaga el micrófono», «deja de escuchar».
    MicOff,
    /// «gracias»: nothing to do, a short answer.
    Thanks,
}

pub fn own(order: &str) -> Option<Own> {
    let text = normalize(order);
    let is = |phrases: &[&str]| phrases.iter().any(|p| text == *p || text.starts_with(&format!("{p} ")) && text.split(' ').count() <= p.split(' ').count() + 1);
    if is(&["para", "parale", "silencio", "callate", "calla", "basta", "stop", "quiet", "be quiet", "shut up", "enough", "ya basta"]) {
        return Some(Own::Hush);
    }
    if is(&["apaga el microfono", "deja de escuchar", "no escuches", "stop listening", "mute the microphone", "turn off the microphone"]) {
        return Some(Own::MicOff);
    }
    if is(&["gracias", "muchas gracias", "thanks", "thank you", "perfecto gracias", "listo gracias"]) {
        return Some(Own::Thanks);
    }
    None
}

/// The words a question starts with.
const QUESTION: &[&str] = &[
    "que", "cual", "cuales", "como", "donde", "cuando", "cuanto", "cuantos", "cuantas", "quien", "quienes", "hay", "what", "which", "where",
    "how", "who", "when", "is", "are", "do", "does", "did", "can",
];

/// Words left around a free-text value that are not part of it: «cambia **al repositorio** api
/// pagos» → `api pagos`.
const FILLER: &[&str] = &[
    "al", "a", "el", "la", "los", "las", "de", "del", "en", "un", "una", "mi", "por", "favor", "porfa", "repo", "repositorio", "proyecto",
    "workspace", "espacio", "trabajo", "rama", "branch", "the", "to", "my", "please", "repository", "project", "app", "aplicacion", "ventana",
    "panel", "codi",
];

/// What may come before an order's verb without being part of what is ordered: a call to Codi, a
/// courtesy, the generic «haz» of «haz un pull». Anything else said first means the verb found later
/// is not the sentence's — «haz un pool **del repositorio** x» is not «repositorio x».
const LEAD: &[&str] = &[
    "oye", "hey", "ok", "okay", "vale", "bueno", "ahora", "ya", "now", "haz", "hazme", "hace", "do", "puedes", "podrias", "can", "could",
    "would", "you",
];

/// Words a question carries around what it asks about, explained by its being asked: «how does
/// flows **work**», «¿cuántas conexiones **tengo**?».
const ASKED: &[&str] = &[
    "work", "works", "exactly", "exactamente", "ahora", "now", "actualmente", "currently", "local", "localmente", "locally", "tengo", "tenemos",
    "have", "i", "we",
];

/// Splits a sentence in words, keeping each one's normalized form beside the original.
fn words(order: &str) -> Vec<(String, String)> {
    order
        .split_whitespace()
        .map(|word| (normalize(word), word.trim_matches(|c: char| !c.is_alphanumeric()).to_string()))
        .filter(|(normal, _)| !normal.is_empty())
        .collect()
}

/// Where `phrase` (normalized, several words) sits in `words`, as a range of word indices.
fn find(words: &[(String, String)], phrase: &str) -> Option<(usize, usize)> {
    let wanted: Vec<&str> = phrase.split(' ').filter(|w| !w.is_empty()).collect();
    if wanted.is_empty() || wanted.len() > words.len() {
        return None;
    }
    (0..=words.len() - wanted.len()).find(|&start| wanted.iter().enumerate().all(|(i, w)| words[start + i].0 == *w)).map(|start| (start, start + wanted.len()))
}

/// A small number parser for what speech recognizers sometimes write out: digits, or Spanish and
/// English words up to ninety-nine.
fn number(words: &[(String, String)], used: &[bool]) -> Option<(i64, Vec<usize>)> {
    for (index, (word, _)) in words.iter().enumerate() {
        if !used[index] {
            if let Ok(n) = word.parse::<i64>() {
                return Some((n, vec![index]));
            }
        }
    }
    const UNITS: &[(&str, i64)] = &[
        ("uno", 1), ("un", 1), ("one", 1), ("dos", 2), ("two", 2), ("tres", 3), ("three", 3), ("cuatro", 4), ("four", 4), ("cinco", 5),
        ("five", 5), ("seis", 6), ("six", 6), ("siete", 7), ("seven", 7), ("ocho", 8), ("eight", 8), ("nueve", 9), ("nine", 9), ("diez", 10),
        ("ten", 10), ("once", 11), ("doce", 12), ("quince", 15), ("veinte", 20), ("twenty", 20), ("treinta", 30), ("thirty", 30), ("cuarenta", 40),
        ("forty", 40), ("cincuenta", 50), ("fifty", 50), ("sesenta", 60), ("sixty", 60), ("setenta", 70), ("seventy", 70), ("ochenta", 80),
        ("eighty", 80), ("noventa", 90), ("ninety", 90),
    ];
    let value = |w: &str| UNITS.iter().find(|(name, _)| *name == w).map(|(_, n)| *n);
    for (index, (word, _)) in words.iter().enumerate() {
        if used[index] {
            continue;
        }
        if let Some(tens) = value(word) {
            // «cuarenta y dos», «forty two»
            let mut taken = vec![index];
            let mut total = tens;
            if tens >= 20 {
                let next = if words.get(index + 1).is_some_and(|(w, _)| w == "y") { index + 2 } else { index + 1 };
                if let Some(unit) = words.get(next).and_then(|(w, _)| value(w)).filter(|u| *u < 10) {
                    total += unit;
                    taken.extend(index + 1..=next);
                }
            }
            return Some((total, taken));
        }
    }
    None
}

/// Words that ask to see what is done: «…y muéstramelo», «…en pantalla». Only after the order's
/// first word — «muéstrame las notas» is an order of its own, not a wish about another one.
const SHOW: &[&str] = &[
    "y muestramelo", "y muestralo", "y abremelo", "y abrelo", "muestramelo", "abrelo", "en pantalla", "a la vista", "and show me", "and show it",
    "and open it", "show me", "on screen",
];

/// Words that ask not to see it: «sin abrir», «en segundo plano» — anywhere in the order.
const HIDE: &[&str] = &[
    "sin abrir nada", "sin abrirlo", "sin abrir", "sin mostrarlo", "sin mostrar", "en segundo plano", "in the background", "without opening it", "without opening", "without showing", "dont open", "do not open",
];

/// What an order says about being seen — `Some(true)` for «…y muéstramelo», `Some(false)` for «sin
/// abrir» — and the order without those words. An action that can work out of sight takes it as its
/// `show` (Settings › Codi › «Trabajar en segundo plano» decides when nothing is said).
pub fn screen_hint(order: &str) -> (Option<bool>, String) {
    let all = words(order);
    let mut cut = vec![false; all.len()];
    let mut hint = None;
    let mut phrases: Vec<(&str, bool)> = HIDE.iter().map(|p| (*p, false)).chain(SHOW.iter().map(|p| (*p, true))).collect();
    // The longest first, so «sin abrir nada» is not left with «nada».
    phrases.sort_by_key(|(phrase, _)| std::cmp::Reverse(phrase.split(' ').count()));
    for (phrase, show) in phrases {
        let wanted: Vec<&str> = phrase.split(' ').collect();
        if wanted.len() > all.len() {
            continue;
        }
        for start in 0..=all.len() - wanted.len() {
            if show && start == 0 {
                continue;
            }
            let span = start..start + wanted.len();
            if cut[span.clone()].iter().any(|c| *c) || !wanted.iter().enumerate().all(|(i, w)| all[start + i].0 == *w) {
                continue;
            }
            cut[span].iter_mut().for_each(|c| *c = true);
            hint = Some(show);
        }
    }
    if hint.is_none() {
        return (None, order.to_string());
    }
    let mut rest = all.iter().zip(&cut).filter(|(_, c)| !**c).map(|((_, original), _)| original.as_str()).collect::<Vec<_>>().join(" ");
    // What makes it a question is kept.
    if order.trim_start().starts_with('¿') {
        rest.insert(0, '¿');
    }
    if order.trim_end().ends_with('?') {
        rest.push('?');
    }
    (hint, rest)
}

/// One action this order plainly names, with its params — or `None` when it is not sure. Said with
/// «…y muéstramelo» or «sin abrir», an action that takes `show` gets it.
pub fn route(order: &str, specs: &[ActionSpec]) -> Option<(String, Value)> {
    let (hint, rest) = screen_hint(order);
    let (id, mut params) = route_plain(&rest, specs)?;
    if let Some(show) = hint {
        let takes = specs.iter().find(|spec| spec.id == id).and_then(|spec| spec.params.pointer("/properties/show")).is_some();
        if takes {
            if let Some(map) = params.as_object_mut() {
                map.insert("show".into(), Value::Bool(show));
            }
        }
    }
    Some((id, params))
}

fn route_plain(order: &str, specs: &[ActionSpec]) -> Option<(String, Value)> {
    let words = words(order);
    if words.is_empty() {
        return None;
    }
    // A second order in the same sentence is the model's to split.
    if words.iter().any(|(w, _)| matches!(w.as_str(), "despues" | "luego" | "then" | "afterwards")) {
        return None;
    }
    // A question wants an answer read from the screen, which is the model's: «en qué rama estoy»
    // is not «lista las ramas». The few actions that answer one by acting — «cómo funciona
    // flujos» is its tour — say how it is asked (`questions`), and only those are looked for in
    // one; every word of it must then be explained, so «qué es un commit» stays the model's.
    let question = asks(order, &words);
    let verbs = |spec: &ActionSpec| if question { spec.questions.clone() } else { spec.aliases.clone() };
    // Two actions' verbs in two places of the sentence («abre el panel… y reinicia el backend») are
    // two orders.
    // Each action's verbs taken together («abre la configuración», «configuración de»): the span of
    // the sentence they cover.
    // An alias made only of words that ride along anyway («repositorio», «repo») names a thing, not
    // an order, and does not make a second one.
    let mut spans: Vec<(String, (usize, usize))> = Vec::new();
    for spec in specs {
        let Some(aliases) = verbs(spec) else { continue };
        let covered = aliases
            .es
            .iter()
            .chain(aliases.en.iter())
            .map(|alias| normalize(alias))
            .filter(|alias| !alias.split(' ').all(|w| FILLER.contains(&w)))
            .filter_map(|alias| find(&words, &alias))
            .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)));
        if let Some(span) = covered {
            spans.push((spec.id.clone(), span));
        }
    }
    // A verb inside another action's longer one is part of it, not an order of its own: «abre» and
    // «consulta» in «abre una consulta rápida».
    let inside = |id: &str, at: (usize, usize)| spans.iter().any(|(other, there)| other != id && there.0 <= at.0 && at.1 <= there.1 && there.1 - there.0 > at.1 - at.0);
    let spans: Vec<(String, (usize, usize))> = spans.iter().filter(|(id, at)| !inside(id, *at)).cloned().collect();
    let apart = |a: (usize, usize), b: (usize, usize)| a.1 <= b.0 || b.1 <= a.0;
    if spans.iter().any(|(id, at)| spans.iter().any(|(other, there)| other != id && apart(*at, *there))) {
        return None;
    }
    let mut found: Vec<(i64, String, Value)> = Vec::new();
    for spec in specs {
        let Some(aliases) = verbs(spec) else { continue };
        // The longest of its verbs present in the order.
        let hit = aliases
            .es
            .iter()
            .chain(aliases.en.iter())
            .map(|alias| normalize(alias))
            .filter_map(|alias| find(&words, &alias).map(|at| (alias.split(' ').count(), at)))
            .max_by_key(|(len, _)| *len);
        let Some((verb_len, (from, to))) = hit else { continue };
        let mut used = vec![false; words.len()];
        used[from..to].iter_mut().for_each(|u| *u = true);
        let Some(mut params) = fill(spec, &words, &mut used, from) else { continue };
        // A `question` is the user's, whole: «¿qué decidimos sobre el login?» is answered as it was
        // asked, not from the words its phrase left over.
        if let Some(question) = params.as_object_mut().and_then(|map| map.get_mut("question")) {
            *question = Value::String(order.trim().to_string());
        }
        // The verb opens the order: what is said before it is a call, a courtesy, a value it named
        // («las notas en modo isla») or another of its own verbs («saca el chat a una ventana aparte»).
        let mut own = vec![false; words.len()];
        for alias in aliases.es.iter().chain(aliases.en.iter()) {
            if let Some((a, b)) = find(&words, &normalize(alias)) {
                own[a..b].iter_mut().for_each(|o| *o = true);
            }
        }
        if (0..from).any(|i| !used[i] && !own[i] && !FILLER.contains(&words[i].0.as_str()) && !LEAD.contains(&words[i].0.as_str())) {
            continue;
        }
        // What is left unexplained: a sure match explains nearly every word.
        let left = words
            .iter()
            .zip(&used)
            .filter(|((w, _), u)| !**u && !FILLER.contains(&w.as_str()) && !LEAD.contains(&w.as_str()) && !(question && ASKED.contains(&w.as_str())))
            .count();
        if left > if question { 0 } else { 2 } {
            continue;
        }
        // Words left where a closed value was expected name something it does not offer: «explícame
        // el proyecto noah cli» is not the tour of the app on screen.
        if left > 0 && spec_has_unfilled_enum(spec, &params) {
            continue;
        }
        let explained = used.iter().filter(|u| **u).count() as i64;
        found.push((verb_len as i64 * 4 + explained - left as i64 * 3, spec.id.clone(), params));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    match found.as_slice() {
        [] => None,
        [only] => Some((only.1.clone(), only.2.clone())),
        [first, second, ..] if first.0 > second.0 => Some((first.1.clone(), first.2.clone())),
        _ => None,
    }
}

/// `order` is a question: «¿…?», or a first word that asks («cómo», «qué», «en qué», «para qué»,
/// «por qué»)
/// — after the name, when the order still carries it (typed into Codi's window).
fn asks(order: &str, words: &[(String, String)]) -> bool {
    let words: Vec<&str> = words.iter().map(|(w, _)| w.as_str()).skip_while(|w| matches!(*w, "codi" | "cody" | "oye" | "hey")).collect();
    order.trim_end().ends_with('?')
        || order.trim_start().trim_start_matches(|c: char| !c.is_alphanumeric() && c != '¿').starts_with('¿')
        || words.first().is_some_and(|w| QUESTION.contains(w) || (matches!(*w, "en" | "para" | "por") && words.get(1).is_some_and(|next| QUESTION.contains(next))))
}

/// Every required param of `spec` from the words not used yet, or `None` when one is missing.
/// Free text is read only after the verb, which starts at `from`.
///
/// An optional `repo` is free text too, when nothing else was said: «haz pull del repositorio api
/// pagos».
fn fill(spec: &ActionSpec, words: &[(String, String)], used: &mut [bool], from: usize) -> Option<Value> {
    let empty = Map::new();
    let properties = spec.params.get("properties").and_then(Value::as_object).unwrap_or(&empty);
    let required: Vec<&str> = spec.params.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    // A repository and the workspace it is in, said together, are two free texts in one: the model
    // splits them.
    if properties.contains_key("workspace") && (words.iter().any(|(w, _)| w == "workspace") || find(words, "espacio de trabajo").is_some()) {
        return None;
    }
    let mut params = Map::new();
    let mut free: Option<String> = None;
    // Closed values first (an app's name), then numbers, then what is left as the free text.
    for (name, schema) in properties {
        if let Some(values) = schema.get("enum").and_then(Value::as_array) {
            let vocabulary = spec.vocabulary.as_ref().and_then(|v| v.get(name));
            let mut best: Option<(usize, String, (usize, usize))> = None;
            for value in values.iter().filter_map(Value::as_str) {
                let mut names: Vec<String> = vec![normalize(value)];
                if let Some(said) = vocabulary.and_then(|v| v.get(value)) {
                    names.extend(said.es.iter().chain(said.en.iter()).map(|w| normalize(w)));
                }
                for spoken in names.iter().filter(|n| !n.is_empty()) {
                    if let Some(at) = find(words, spoken) {
                        if used[at.0..at.1].iter().any(|u| *u) {
                            continue;
                        }
                        let len = spoken.split(' ').count();
                        if best.as_ref().is_none_or(|(l, _, _)| len > *l) {
                            best = Some((len, value.to_string(), at));
                        }
                    }
                }
            }
            if let Some((_, value, (from, to))) = best {
                used[from..to].iter_mut().for_each(|u| *u = true);
                params.insert(name.clone(), Value::String(value));
            }
        }
    }
    for (name, schema) in properties {
        if params.contains_key(name) {
            continue;
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("integer") | Some("number") => {
                if let Some((n, taken)) = number(words, used) {
                    taken.iter().for_each(|i| used[*i] = true);
                    params.insert(name.clone(), Value::from(n));
                }
            }
            Some("boolean") => {}
            Some("string") if schema.get("enum").is_none() && required.contains(&name.as_str()) => {
                // One free-text param a sentence: the words not explained, in their own spelling.
                if free.is_none() {
                    if let Some(text) = free_text(words, used, from) {
                        free = Some(name.clone());
                        params.insert(name.clone(), Value::String(text));
                    }
                }
            }
            _ => {}
        }
    }
    if params.is_empty() && properties.get("repo").is_some_and(|schema| schema.get("type").and_then(Value::as_str) == Some("string")) {
        if let Some(text) = free_text(words, used, from) {
            params.insert("repo".into(), Value::String(text));
        }
    }
    // Fillers around what was found count as explained.
    for (index, (normal, _)) in words.iter().enumerate() {
        if FILLER.contains(&normal.as_str()) {
            used[index] = true;
        }
    }
    required.iter().all(|key| params.contains_key(*key)).then_some(Value::Object(params))
}

/// Whether `spec` takes a closed value (an app, a tour) that the order did not name.
fn spec_has_unfilled_enum(spec: &ActionSpec, params: &Value) -> bool {
    spec.params
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.iter().any(|(name, schema)| schema.get("enum").is_some() && params.get(name).is_none()))
}

/// The words after `from` not explained yet, in their own spelling — and marks them explained.
fn free_text(words: &[(String, String)], used: &mut [bool], from: usize) -> Option<String> {
    let taken: Vec<usize> = (from..words.len()).filter(|&i| !used[i] && !FILLER.contains(&words[i].0.as_str())).collect();
    if taken.is_empty() {
        return None;
    }
    taken.iter().for_each(|&i| used[i] = true);
    Some(taken.iter().map(|&i| words[i].1.as_str()).collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::super::ui::{Risk, Title, Words};
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn words_of(es: &[&str], en: &[&str]) -> Words {
        Words { es: es.iter().map(|s| s.to_string()).collect(), en: en.iter().map(|s| s.to_string()).collect() }
    }

    fn catalogue() -> Vec<ActionSpec> {
        let apps: HashMap<String, Words> = [
            ("flows", words_of(&["flujos"], &["flows"])),
            ("notes", words_of(&["notas"], &["notes"])),
            ("api:database", words_of(&["base de datos", "bd"], &["database"])),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let app_param = json!({ "type": "object", "properties": { "app": { "type": "string", "enum": ["flows", "notes", "api:database"] } }, "required": ["app"] });
        let spec = |id: &str, aliases: Words, params: Value, vocabulary: bool| ActionSpec {
            id: id.into(),
            title: Title { es: id.into(), en: id.into() },
            aliases: Some(aliases),
            vocabulary: vocabulary.then(|| [("app".to_string(), apps.clone())].into_iter().collect()),
            questions: None,
            params,
            risk: Risk::Navigate,
            place: "main".into(),
            frequent: true,
        };
        vec![
            spec("app.open", words_of(&["abre", "abrir", "muestra", "ve a"], &["open", "show", "go to"]), app_param.clone(), true),
            spec("island.detach", words_of(&["saca", "separa"], &["detach", "pop out"]), app_param.clone(), true),
            spec(
                "repo.switch",
                words_of(&["cambia al repositorio", "cambia al repo", "cambia de repositorio", "repositorio"], &["switch to repository", "switch to repo"]),
                json!({ "type": "object", "properties": { "name": { "type": "string" }, "workspace": { "type": "string" } }, "required": ["name"] }),
                false,
            ),
            spec("review.pr", words_of(&["revisa el pull request", "revisa el pr"], &["review pull request", "review pr"]), json!({ "type": "object", "properties": { "number": { "type": "integer" } }, "required": ["number"] }), false),
            spec(
                "git.pull",
                words_of(&["haz pull", "pull", "pool"], &["pull"]),
                json!({ "type": "object", "properties": { "repo": { "type": "string" }, "workspace": { "type": "string" } } }),
                false,
            ),
        ]
    }

    #[test]
    fn plain_orders_run_without_a_model() {
        let specs = catalogue();
        assert_eq!(route("abre flujos", &specs), Some(("app.open".into(), json!({ "app": "flows" }))));
        assert_eq!(route("Abre la base de datos, por favor", &specs), Some(("app.open".into(), json!({ "app": "api:database" }))));
        assert_eq!(route("open the database", &specs), Some(("app.open".into(), json!({ "app": "api:database" }))));
        assert_eq!(route("saca las notas a una ventana aparte", &specs), Some(("island.detach".into(), json!({ "app": "notes" }))));
        assert_eq!(route("cambia al repositorio api pagos", &specs), Some(("repo.switch".into(), json!({ "name": "api pagos" }))));
        assert_eq!(route("revisa el pull request 42", &specs), Some(("review.pr".into(), json!({ "number": 42 }))));
        assert_eq!(route("revisa el pull request cuarenta y dos", &specs), Some(("review.pr".into(), json!({ "number": 42 }))));
        assert_eq!(route("haz pull", &specs), Some(("git.pull".into(), json!({}))));
    }

    /// «Haz un pool del repositorio node.core» went to «repositorio» with «Haz pool node.core» as
    /// the name (user report, 2026-10-22): the verb opens the order, and a repository named after it
    /// is the order's.
    #[test]
    fn an_order_on_a_named_repository_is_that_order() {
        let specs = catalogue();
        let pull = |repo: &str| Some(("git.pull".to_string(), json!({ "repo": repo })));
        assert_eq!(route("Haz un pool del repositorio node.core.", &specs), pull("node.core"));
        assert_eq!(route("haz pull de api pagos", &specs), pull("api pagos"));
        assert_eq!(route("pull del repo facturación por favor", &specs), pull("facturación"));
        assert_eq!(route("repositorio api pagos", &specs), Some(("repo.switch".into(), json!({ "name": "api pagos" }))));
        assert_eq!(route("haz pull de api pagos del workspace clientes", &specs), None, "repository and workspace: the model splits them");
        assert_eq!(route("cambia al repositorio api pagos del workspace clientes", &specs), None);
        assert_eq!(route("configura el pool de conexiones", &specs), None, "another verb said first");
        assert_eq!(route("oye, haz pull", &specs), Some(("git.pull".into(), json!({}))));
    }

    /// «…y muéstramelo» and «sin abrir» say whether the work is seen: taken off the order and handed
    /// to an action that takes `show`, and never read as an order of their own when said first.
    #[test]
    fn whether_it_is_seen_rides_the_order_without_changing_it() {
        assert_eq!(screen_hint("ejecuta el flujo facturación y muéstramelo"), (Some(true), "ejecuta el flujo facturación".to_string()));
        assert_eq!(screen_hint("corre los tests sin abrir nada"), (Some(false), "corre los tests".to_string()));
        assert_eq!(screen_hint("en segundo plano, envía la petición login"), (Some(false), "envía la petición login".to_string()));
        assert_eq!(screen_hint("muéstrame las notas"), (None, "muéstrame las notas".to_string()), "an order to show is not a wish about another");
        assert_eq!(screen_hint("show me the notes"), (None, "show me the notes".to_string()));
        assert_eq!(screen_hint("¿cuántas conexiones hay sin abrir nada?"), (Some(false), "¿cuántas conexiones hay?".to_string()));

        let mut specs = catalogue();
        specs.push(ActionSpec {
            id: "flow.run".into(),
            title: Title { es: "flow.run".into(), en: "flow.run".into() },
            aliases: Some(words_of(&["ejecuta el flujo"], &["run the flow"])),
            vocabulary: None,
            questions: None,
            params: json!({ "type": "object", "properties": { "name": { "type": "string" }, "show": { "type": "boolean" } }, "required": ["name"] }),
            risk: Risk::Write,
            place: "main".into(),
            frequent: true,
        });
        assert_eq!(route("ejecuta el flujo facturación y muéstramelo", &specs), Some(("flow.run".into(), json!({ "name": "facturación", "show": true }))));
        assert_eq!(route("ejecuta el flujo facturación sin abrir", &specs), Some(("flow.run".into(), json!({ "name": "facturación", "show": false }))));
        assert_eq!(route("ejecuta el flujo facturación", &specs), Some(("flow.run".into(), json!({ "name": "facturación" }))));
        assert_eq!(route("haz pull en segundo plano", &specs), Some(("git.pull".into(), json!({}))), "an action without `show` just runs");
    }

    /// A question is taken only by the actions that say how it is asked — a tour answers «cómo
    /// funciona flujos» — and only when every word of it is explained.
    #[test]
    fn a_question_is_routed_only_through_its_own_phrases() {
        let mut specs = catalogue();
        let tours: HashMap<String, Words> = [
            ("flows", words_of(&["flujos"], &["flows"])),
            ("api", words_of(&["cliente api", "api client", "api cliente"], &["api client"])),
            ("db", words_of(&["base de datos", "bd"], &["database"])),
            ("current", words_of(&["esto", "esta app"], &["this", "this app"])),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        specs.push(ActionSpec {
            id: "tour.start".into(),
            title: Title { es: "tour".into(), en: "tour".into() },
            aliases: Some(words_of(&["abre el tour", "tour de", "explicame"], &["start the tour", "tour of", "explain"])),
            vocabulary: Some([("tour".to_string(), tours)].into_iter().collect()),
            questions: Some(words_of(&["como funciona", "como se usa", "que es", "para que sirve"], &["how does", "what is"])),
            params: json!({ "type": "object", "properties": { "tour": { "type": "string", "enum": ["current", "flows", "api", "db"] } }, "required": [] }),
            risk: Risk::Navigate,
            place: "main".into(),
            frequent: true,
        });
        let tour = |name: &str| Some(("tour.start".to_string(), json!({ "tour": name })));
        assert_eq!(route("¿Cómo funciona la app de API client?", &specs), tour("api"));
        assert_eq!(route("cómo funciona la base de datos", &specs), tour("db"));
        assert_eq!(route("Codi, ¿para qué sirve flujos?", &specs), tour("flows"));
        assert_eq!(route("¿qué es esto?", &specs), tour("current"));
        assert_eq!(route("abre el tour de flujos", &specs), tour("flows"));
        assert_eq!(route("explícame la base de datos", &specs), tour("db"));
        assert_eq!(route("abre el tour", &specs), Some(("tour.start".into(), json!({}))));
        assert_eq!(route("¿qué es un commit?", &specs), None, "a word left over: the model's");
        assert_eq!(route("explícame el proyecto noah cli", &specs), None, "not a tour it has: the repository's research, through the model");
        assert_eq!(route("¿cómo funciona el login de la app de pagos?", &specs), None);
        assert_eq!(route("¿abro flujos?", &specs), None, "an action with no question phrase is never asked");
    }

    #[test]
    fn anything_it_is_not_sure_of_goes_to_a_model() {
        let specs = catalogue();
        assert_eq!(route("abre", &specs), None, "no app named");
        assert_eq!(route("abre flujos y después las notas", &specs), None, "two orders");
        assert_eq!(route("qué rama estoy usando ahora mismo", &specs), None);
        assert_eq!(route("¿abro flujos?", &specs), None, "a question");
        assert_eq!(route("abre flujos y saca las notas", &specs), None, "two verbs, two orders");
        assert_eq!(route("abre el archivo de configuración del servidor de producción", &specs), None, "too much left unexplained");
    }

    /// The real catalogue, as the main window registers it (`CODEFLOW_TEST_CATALOGUE=<json>`, written
    /// by `src/lib/codi/catalogueDump.test.ts`), against the orders measured for Codi: what the
    /// router takes must be right, and what it is not sure of it must leave alone.
    #[test]
    #[ignore]
    fn the_real_catalogue_routes_the_plain_orders() {
        let path = std::env::var("CODEFLOW_TEST_CATALOGUE").expect("CODEFLOW_TEST_CATALOGUE=<json>");
        let mut specs: Vec<ActionSpec> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        // The backend's own, as `ui::specs` lists them, first.
        specs.splice(0..0, super::super::native::specs());
        let cases: &[(&str, Option<(&str, &str)>)] = &[
            ("abre flujos", Some(("app.open", "flows"))),
            ("abre las notas", Some(("app.open", "notes"))),
            ("open the database", Some(("app.open", "api:database"))),
            ("cambia al repositorio api pagos", Some(("repo.switch", "api pagos"))),
            ("saca el chat a una ventana aparte", Some(("island.detach", "chat"))),
            ("saca flujos a una isla", Some(("island.detach", "flows"))),
            ("las notas en modo isla", Some(("island.detach", "notes"))),
            ("cambia al workspace de clientes", Some(("workspace.switch", "clientes"))),
            ("abre la configuración de voz", Some(("settings.open", "voice"))),
            ("muéstrame el grafo de commits", Some(("view.open", "graph"))),
            ("haz pull", Some(("git.pull", ""))),
            // The main window put away, Codi still up (user, 2026-10-22).
            ("Codi, trae la aplicación al frente", Some(("app.front", ""))),
            ("muestra codeflow", Some(("app.front", ""))),
            ("abre la app", Some(("app.front", ""))),
            ("Codi, nueva consulta rápida", Some(("quick.open", ""))),
            ("abre una consulta rápida", Some(("quick.open", ""))),
            // Outside CodeFlow (user, 2026-10-22).
            ("abre la app de teams", Some(("system.open", "teams"))),
            ("abre el programa spotify", Some(("system.open", "spotify"))),
            // The filler goes, as from any free text: a search engine needs no articles.
            ("busca en internet el precio del dolar", Some(("web.search", "precio dolar"))),
            ("ejecuta la rutina noticias", Some(("routine.run", "noticias"))),
            ("¿qué apps tengo abiertas?", Some(("desktop.windows", ""))),
            // «pull» heard as «pool», on a repository named (user report, 2026-10-22).
            ("Haz un pool del repositorio node.core.", Some(("git.pull", "node.core"))),
            ("haz fetch de api pagos", Some(("git.fetch", "api pagos"))),
            ("haz push del repo facturación", Some(("git.push", "facturación"))),
            ("haz pull de api pagos en el workspace clientes", None),
            // No verb: named, it is to be seen (user report, 2026-10-21).
            ("Ahora el panel de chat.", Some(("panel.ai", ""))),
            ("cierra el panel de chat", Some(("panel.ai", "close"))),
            // The tours (user, 2026-10-22): asked as a question, or as an order.
            ("¿Cómo funciona la app de API client?", Some(("tour.start", "api"))),
            ("cómo funciona el api cliente", Some(("tour.start", "api"))),
            ("Codi, ¿cómo funciona la base de datos?", Some(("tour.start", "db"))),
            ("¿para qué sirve flujos?", Some(("tour.start", "flows"))),
            ("how does the database work?", Some(("tour.start", "db"))),
            ("abre el tour de las notas", Some(("tour.start", "notes"))),
            ("explícame el llavero", Some(("tour.start", "vault"))),
            ("¿qué es esto?", Some(("tour.start", "current"))),
            ("abre el tour", Some(("tour.start", ""))),
            ("siguiente paso", Some(("tour.next", ""))),
            ("paso anterior", Some(("tour.back", ""))),
            ("repite", Some(("tour.repeat", ""))),
            ("pausa", Some(("tour.pause", ""))),
            ("sigue", Some(("tour.resume", ""))),
            ("termina el tour", Some(("tour.stop", ""))),
            ("¿qué es un commit?", None),
            // Answered from the index, the question whole (user, 2026-10-22: «que la busque súper rápido»).
            ("¿qué decidimos sobre el login?", Some(("knowledge.ask", "¿qué decidimos sobre el login?"))),
            ("codi, ¿qué sabes de la migración a postgres?", Some(("knowledge.ask", "codi, ¿qué sabes de la migración a postgres?"))),
            ("busca en mis notas lo del deploy", Some(("knowledge.ask", "busca en mis notas lo del deploy"))),
            // A repository to explain is researched, through a model (user report, 2026-10-22).
            ("explícame el proyecto noah cli", None),
            ("Necesito que me expliques el proyecto No CLI.", None),
            ("¿cómo funciona el login del repositorio de pagos?", None),
            // Asked, answered without moving the screen; a panel with no tour explained (user, 2026-10-22).
            ("¿Cuántos contenedores tengo corriendo?", Some(("containers.list", ""))),
            ("codi cuántos contenedores tengo corriendo en local", Some(("containers.list", ""))),
            ("¿qué contenedores hay?", Some(("containers.list", ""))),
            ("¿Por qué se cayó el contenedor postgres?", Some(("container.why", "postgres"))),
            ("¿cómo va el pipeline?", Some(("pipeline.status", ""))),
            ("¿por qué falló el pipeline?", Some(("pipeline.explain", ""))),
            // Codi's own tour, narrated by itself (user, 2026-10-22).
            ("¿cómo funciona Codi?", Some(("tour.start", "codi"))),
            ("abre el tour de codi", Some(("tour.start", "codi"))),
            ("¿qué es el panel de contenedores?", Some(("app.about", "containers"))),
            ("¿para qué sirve arquitectura?", Some(("tour.start", "architecture"))),
            ("¿cómo funciona la app de arquitectura?", Some(("tour.start", "architecture"))),
            ("abre el panel de contenedores", Some(("dock.show", "containers"))),
            ("muéstrame los contenedores", Some(("dock.show", "containers"))),
            ("¿cómo va el último pipeline de api pagos en el workspace clientes?", None),
            ("¿qué base de datos ocupa el repositorio api pagos?", None),
            ("en qué rama estoy", None),
            // The app's data from its data, never from what the screen shows — Settings was in front of
            // the database client (user report, 2026-10-22).
            ("¿cuántas conexiones de base de datos tengo?", Some(("db.list", ""))),
            ("¿cuántas conexiones tengo?", Some(("db.list", ""))),
            ("how many database connections do I have?", Some(("db.list", ""))),
            // Work done out of sight, or shown when asked (user, 2026-10-22).
            ("ejecuta el flujo facturación y muéstramelo", Some(("flow.run", "facturación"))),
            ("ejecuta el flujo facturación sin abrir", Some(("flow.run", "facturación"))),
            ("haz pull en segundo plano", Some(("git.pull", ""))),
            ("abre el panel de servicios y reinicia el backend", None),
            ("levanta el frontend y después ábreme la terminal", None),
        ];
        let mut wrong = Vec::new();
        for (order, want) in cases {
            let got = route(order, &specs);
            let ok = match (want, &got) {
                (None, None) => true,
                (Some((id, value)), Some((got_id, params))) => {
                    got_id == id && (value.is_empty() || params.as_object().is_some_and(|p| p.values().any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(value)))))
                }
                _ => false,
            };
            eprintln!("{} {order:?} → {got:?}", if ok { "ok " } else { "XX " });
            if !ok {
                wrong.push(*order);
            }
        }
        assert!(wrong.is_empty(), "{wrong:?}");
    }

    #[test]
    fn codi_hears_its_own_orders() {
        assert_eq!(own("Para."), Some(Own::Hush));
        assert_eq!(own("silencio"), Some(Own::Hush));
        assert_eq!(own("Cállate"), Some(Own::Hush));
        assert_eq!(own("deja de escuchar"), Some(Own::MicOff));
        assert_eq!(own("gracias"), Some(Own::Thanks));
        assert_eq!(own("para el servicio de pagos"), None, "an order that starts like one is still an order");
    }
}
