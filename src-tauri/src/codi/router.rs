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

/// One action this order plainly names, with its params — or `None` when it is not sure.
pub fn route(order: &str, specs: &[ActionSpec]) -> Option<(String, Value)> {
    let words = words(order);
    if words.is_empty() {
        return None;
    }
    // A second order in the same sentence is the model's to split.
    if words.iter().any(|(w, _)| matches!(w.as_str(), "despues" | "luego" | "then" | "afterwards")) {
        return None;
    }
    // A question wants an answer read from the screen, which is the model's: «en qué rama estoy»
    // is not «lista las ramas».
    if order.trim_end().ends_with('?')
        || order.trim_start().starts_with('¿')
        || words.first().is_some_and(|(w, _)| QUESTION.contains(&w.as_str()) || (w == "en" && words.get(1).is_some_and(|(next, _)| QUESTION.contains(&next.as_str()))))
    {
        return None;
    }
    // Two actions' verbs in two places of the sentence («abre el panel… y reinicia el backend») are
    // two orders.
    // Each action's verbs taken together («abre la configuración», «configuración de»): the span of
    // the sentence they cover.
    let mut spans: Vec<(String, (usize, usize))> = Vec::new();
    for spec in specs {
        let Some(aliases) = &spec.aliases else { continue };
        let covered = aliases
            .es
            .iter()
            .chain(aliases.en.iter())
            .filter_map(|alias| find(&words, &normalize(alias)))
            .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)));
        if let Some(span) = covered {
            spans.push((spec.id.clone(), span));
        }
    }
    let apart = |a: (usize, usize), b: (usize, usize)| a.1 <= b.0 || b.1 <= a.0;
    if spans.iter().any(|(id, at)| spans.iter().any(|(other, there)| other != id && apart(*at, *there))) {
        return None;
    }
    let mut found: Vec<(i64, String, Value)> = Vec::new();
    for spec in specs {
        let Some(aliases) = &spec.aliases else { continue };
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
        let Some(params) = fill(spec, &words, &mut used) else { continue };
        // What is left unexplained: a sure match explains nearly every word.
        let left = words.iter().zip(&used).filter(|((w, _), u)| !**u && !FILLER.contains(&w.as_str())).count();
        if left > 2 {
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

/// Every required param of `spec` from the words not used yet, or `None` when one is missing.
fn fill(spec: &ActionSpec, words: &[(String, String)], used: &mut [bool]) -> Option<Value> {
    let empty = Map::new();
    let properties = spec.params.get("properties").and_then(Value::as_object).unwrap_or(&empty);
    let required: Vec<&str> = spec.params.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
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
                    let text: Vec<&str> = words
                        .iter()
                        .zip(used.iter())
                        .filter(|((normal, _), u)| !**u && !FILLER.contains(&normal.as_str()))
                        .map(|((_, original), _)| original.as_str())
                        .collect();
                    if !text.is_empty() {
                        let joined = text.join(" ");
                        free = Some(name.clone());
                        for (index, (normal, _)) in words.iter().enumerate() {
                            if !used[index] && !FILLER.contains(&normal.as_str()) {
                                used[index] = true;
                            }
                        }
                        params.insert(name.clone(), Value::String(joined));
                    }
                }
            }
            _ => {}
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
                words_of(&["cambia al repositorio", "cambia al repo", "cambia de repositorio"], &["switch to repository", "switch to repo"]),
                json!({ "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }),
                false,
            ),
            spec("review.pr", words_of(&["revisa el pull request", "revisa el pr"], &["review pull request", "review pr"]), json!({ "type": "object", "properties": { "number": { "type": "integer" } }, "required": ["number"] }), false),
            spec("git.pull", words_of(&["haz pull", "pull"], &["pull"]), json!({ "type": "object", "properties": {} }), false),
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
        let specs: Vec<ActionSpec> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases: &[(&str, Option<(&str, &str)>)] = &[
            ("abre flujos", Some(("app.open", "flows"))),
            ("abre las notas", Some(("app.open", "notes"))),
            ("open the database", Some(("app.open", "api:database"))),
            ("cambia al repositorio api pagos", Some(("repo.switch", "api pagos"))),
            ("saca el chat a una ventana aparte", Some(("island.detach", "chat"))),
            ("cambia al workspace de clientes", Some(("workspace.switch", "clientes"))),
            ("abre la configuración de voz", Some(("settings.open", "voice"))),
            ("muéstrame el grafo de commits", Some(("view.open", "graph"))),
            ("haz pull", Some(("git.pull", ""))),
            // No verb: named, it is to be seen (user report, 2026-10-21).
            ("Ahora el panel de chat.", Some(("panel.ai", ""))),
            ("cierra el panel de chat", Some(("panel.ai", "close"))),
            ("en qué rama estoy", None),
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
