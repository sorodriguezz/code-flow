//! Which notes are about the same thing, read off their words — no model, no index, the same
//! answer every time.
//!
//! Each note is a bag of its distinctive words: accents and case folded, plurals brought to one
//! form, the words every note has (articles, «reunión», the headings a recipe writes) left out.
//! A word counts for more the fewer notes say it, and three times over when it is in the title or
//! a tag. Two notes are alike by the cosine of those weights — so a long transcript and a short
//! note about the same subject still meet.
//!
//! One shared word is a coincidence: a pair needs [`MIN_SHARED`] of them and a score over
//! [`THRESHOLD`] before it is called alike.

use std::collections::{BTreeMap, HashMap, HashSet};

/// The least two notes must score to be called alike.
pub const THRESHOLD: f32 = 0.16;
/// The fewest distinct words they must share.
pub const MIN_SHARED: usize = 3;
/// How much of a note's text is read: a two-hour transcript says its subject long before this.
const MAX_CHARS: usize = 40_000;
/// How many shared words are kept to say why.
const SHOWN: usize = 5;

/// One note, as this module reads it.
pub struct Doc<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub tags: &'a [String],
    /// The body and, when the note holds a meeting, what was said in it.
    pub text: &'a str,
}

/// A note that is alike.
#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub id: String,
    pub score: f32,
    /// The words that make them alike, as they are written, the most telling first.
    pub shared: Vec<String>,
}

/// The notes of `others` most like `source`, the closest first.
pub fn rank(source: &Doc<'_>, others: &[Doc<'_>], limit: usize) -> Vec<Match> {
    let own = bag(source);
    if own.counts.is_empty() || others.is_empty() {
        return Vec::new();
    }
    let bags: Vec<Bag> = others.iter().map(bag).collect();
    // How many notes say each word — the source among them.
    let mut said_by: HashMap<&str, usize> = HashMap::new();
    for bag in std::iter::once(&own).chain(bags.iter()) {
        for stem in bag.counts.keys() {
            *said_by.entry(stem.as_str()).or_default() += 1;
        }
    }
    let total = (bags.len() + 1) as f32;
    let weight = |stem: &str, count: f32| (1.0 + count.ln()) * (((total + 1.0) / (said_by.get(stem).copied().unwrap_or(1) as f32 + 1.0)).ln() + 1.0);
    // Ordered maps, so the sums below add up in the same order — and to the same digit — every time.
    let weigh = |bag: &Bag| -> (BTreeMap<String, f32>, f32) {
        let weights: BTreeMap<String, f32> = bag.counts.iter().map(|(stem, count)| (stem.clone(), weight(stem, *count))).collect();
        let norm = weights.values().map(|w| w * w).sum::<f32>().sqrt();
        (weights, norm)
    };
    let (own_weights, own_norm) = weigh(&own);
    let mut found: Vec<Match> = Vec::new();
    for (doc, bag) in others.iter().zip(&bags) {
        if doc.id == source.id {
            continue;
        }
        let (weights, norm) = weigh(bag);
        if norm == 0.0 || own_norm == 0.0 {
            continue;
        }
        let mut shared: Vec<(&String, f32)> = own_weights.iter().filter_map(|(stem, w)| weights.get(stem).map(|other| (stem, w * other))).collect();
        if shared.len() < MIN_SHARED {
            continue;
        }
        let score = shared.iter().map(|(_, product)| product).sum::<f32>() / (own_norm * norm);
        if score < THRESHOLD {
            continue;
        }
        // The same order every time: by weight, then by the word itself.
        shared.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let words = shared.iter().take(SHOWN).map(|(stem, _)| own.written.get(*stem).cloned().unwrap_or_else(|| (*stem).clone())).collect();
        found.push(Match { id: doc.id.to_string(), score, shared: words });
    }
    found.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    found.truncate(limit);
    found
}

/// The notes of `others` that say the most about `topic` — a few words someone typed, not a note:
/// each is scored by the topic's words it says, a word counting for more the fewer notes say it and
/// the more this one does (three times over in its title or tags, as in [`rank`]). One shared word
/// is enough here: the reader of the result is told to leave out what is not about the topic.
pub fn search(topic: &str, others: &[Doc<'_>], limit: usize) -> Vec<Match> {
    let asked = bag(&Doc { id: "", title: "", tags: &[], text: topic });
    if asked.counts.is_empty() || others.is_empty() {
        return Vec::new();
    }
    let bags: Vec<Bag> = others.iter().map(bag).collect();
    let total = bags.len() as f32;
    let said_by = |stem: &str| bags.iter().filter(|bag| bag.counts.contains_key(stem)).count() as f32;
    let rarity: BTreeMap<&str, f32> = asked.counts.keys().map(|stem| (stem.as_str(), ((total + 1.0) / (said_by(stem) + 1.0)).ln() + 1.0)).collect();
    let mut found: Vec<Match> = others
        .iter()
        .zip(&bags)
        .filter_map(|(doc, bag)| {
            let mut shared: Vec<(&str, f32)> = rarity.iter().filter_map(|(stem, rare)| bag.counts.get(*stem).map(|count| (*stem, rare * (1.0 + count.ln())))).collect();
            if shared.is_empty() {
                return None;
            }
            shared.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            let words = shared.iter().take(SHOWN).map(|(stem, _)| asked.written.get(*stem).cloned().unwrap_or_else(|| (*stem).to_string())).collect();
            // How many of the topic's words it says comes first: a note with all of them once is
            // more on the subject than one that repeats a single one.
            let score = shared.len() as f32 * 100.0 + shared.iter().map(|(_, weight)| weight).sum::<f32>();
            Some(Match { id: doc.id.to_string(), score, shared: words })
        })
        .collect();
    found.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    found.truncate(limit);
    found
}

struct Bag {
    /// How much each word counts in this note, by its folded form.
    counts: BTreeMap<String, f32>,
    /// One way each word is written here, for showing it.
    written: HashMap<String, String>,
}

fn bag(doc: &Doc<'_>) -> Bag {
    let mut bag = Bag { counts: BTreeMap::new(), written: HashMap::new() };
    let mut add = |text: &str, worth: f32| {
        for word in words(text) {
            let Some(stem) = stem(&word) else { continue };
            *bag.counts.entry(stem.clone()).or_default() += worth;
            bag.written.entry(stem).or_insert(word);
        }
    };
    add(doc.title, 3.0);
    for tag in doc.tags {
        add(tag, 3.0);
    }
    let text: String = doc.text.chars().take(MAX_CHARS).collect();
    add(&text, 1.0);
    bag
}

/// The words of `text`, as written (lowercased), in order. Links' addresses and code fences' marks
/// are not words; what is inside a link's text or a code span is.
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_alphanumeric() {
            current.extend(ch.to_lowercase());
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    out
}

/// The form two spellings of one word share — accents folded, a plural's `s` and the `e` it leaves
/// taken off («migraciones» and «migración», «tables» and «table») — or nothing for a word that
/// says nothing: too short, a number, or in [`STOP`].
fn stem(word: &str) -> Option<String> {
    let folded = crate::db::note_queries::fold_for_match(word);
    if folded.chars().count() < 3 || folded.chars().all(|c| c.is_ascii_digit()) || folded.starts_with("http") {
        return None;
    }
    if stop().contains(folded.as_str()) {
        return None;
    }
    let mut stem = folded;
    for ending in ['s', 'e'] {
        if stem.chars().count() >= 5 && stem.ends_with(ending) {
            stem.pop();
        }
    }
    if stop().contains(stem.as_str()) {
        return None;
    }
    Some(stem)
}

fn stop() -> &'static HashSet<&'static str> {
    static STOP_SET: std::sync::LazyLock<HashSet<&'static str>> = std::sync::LazyLock::new(|| STOP.split_whitespace().collect());
    &STOP_SET
}

/// Words that say nothing about what a note is about: the grammar of Spanish and English, the
/// filler of speech, and what every meeting note carries whatever was discussed — the headings the
/// recipes write and the words of a meeting itself.
const STOP: &str = "\
    que qué del las los una uno unos unas por para con sin pero como cómo mas más muy este esta estos estas ese esa esos esas eso esto \
    aquel aquella aqui aquí alli allí ahi ahí hay han has haber habia había hemos habra habrá ser son era eran fue fueron sido siendo \
    estar esta está estan están estaba estaban estamos estoy tener tiene tienen tenia tenía tenemos tengo hacer hace hacen hizo hecho \
    hacemos hago puede pueden podemos puedo podria podría poder debe deben debemos deberia debería quiere quieren queremos quiero \
    vamos van voy iba ir sea sean seria sería sobre entre desde hasta hacia tras cuando cuándo donde dónde quien quién cual cuál cuales \
    porque pues entonces tambien también tampoco solo sólo ya aun aún todavia todavía bien mal asi así algo alguien alguna alguno \
    algunos algunas nada nadie cada todo toda todos todas otro otra otros otras mismo misma mismos mismas tan tanto tanta mucho mucha \
    muchos muchas poco poca pocos pocas menos mejor peor ahora luego despues después antes hoy ayer manana mañana siempre nunca vez veces \
    nos les lo le la se me te mi mis tu tus su sus nuestro nuestra nuestros nuestras ellos ellas ella el él usted ustedes yo \
    si sí no ni o u y e a en de al un es \
    bueno claro vale okay ok osea digamos tipo onda igual cosa cosas tema temas parte forma manera caso casos ejemplo gracias hola \
    the and for are was were been being have has had having not but with from this that these those there here what when where which who whom \
    why how you your yours they them their theirs she her hers his him its our ours will would should could can may might must shall \
    does did doing done into onto over under about above below after before again further then than too very just also only such both \
    each few more most other some any all own same out off down while during until against between through because however \
    one two get got make made like want need know think going yes yeah okay well thing things thanks \
    reunion reunión reuniones meeting meetings nota notas note notes acta actas minutes resumen summary transcripcion transcripción transcript \
    participantes participants duracion duración duration fecha date minuto minutos minute tareas tarea tasks task decisiones decision decisión \
    decisions acuerdos acuerdo agreed proximos próximos pasos next steps pendiente pendientes responsable responsables owner \
    planificacion planificación plan hito hitos milestone plazo riesgos riesgo risks preguntas pregunta questions abiertas open \
    agenda seguimiento followup correo persona personas speaker hablante";

#[cfg(test)]
mod tests {
    use super::*;

    fn doc<'a>(id: &'a str, title: &'a str, text: &'a str) -> Doc<'a> {
        Doc { id, title, tags: &[], text }
    }

    #[test]
    fn a_typed_subject_finds_the_notes_that_speak_of_it() {
        let others = [
            doc("plan", "Outbox para las citas", "Se acordó usar el patrón outbox para publicar los eventos de citas."),
            doc("follow", "Seguimiento", "La tabla outbox ya está creada. Falta el schema."),
            doc("holidays", "Vacaciones del equipo", "Calendario de diciembre y guardias de soporte."),
        ];
        let found = search("Cierre del outbox de citas", &others, 5);
        assert_eq!(found.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["plan", "follow"], "the one that says more of the subject first, and the unrelated one not at all");
        assert!(found[0].shared.iter().any(|word| word == "outbox"), "{:?}", found[0].shared);
        assert!(search("de la y", &others, 5).is_empty(), "a subject of filler words finds nothing");
        assert!(search("kubernetes", &others, 5).is_empty());
    }

    #[test]
    fn notes_about_the_same_subject_meet_and_the_rest_do_not() {
        let source = doc("a", "Outbox para las citas", "Se acordó usar el patrón outbox para publicar los eventos de citas. El DBA crea la tabla outbox con un índice por estado y falta definir el schema.");
        let others = [
            doc("b", "Seguimiento del outbox", "La tabla outbox ya está creada con su índice por estado. Los eventos de citas se publican; el schema quedó como eventos."),
            doc("c", "Vacaciones del equipo", "Calendario de vacaciones de diciembre y quién cubre las guardias de soporte durante las fiestas."),
            doc("d", "Citas", "Una cita."),
        ];
        let found = rank(&source, &others, 5);
        assert_eq!(found.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["b"], "{found:?}");
        assert!(found[0].shared.iter().any(|w| w == "outbox"), "{found:?}");
        assert!(found[0].score >= THRESHOLD);
    }

    #[test]
    fn accents_plurals_and_case_are_one_word() {
        assert_eq!(stem("Migraciones"), stem("migración"));
        assert_eq!(stem("tables"), stem("Table"));
        assert_eq!(stem("clientes"), stem("cliente"));
        // Nothing to say: grammar, a number, what every meeting note has.
        assert_eq!(stem("para"), None);
        assert_eq!(stem("2026"), None);
        assert_eq!(stem("Decisiones"), None);
        assert_eq!(stem("https"), None);
    }

    #[test]
    fn two_notes_that_only_share_a_recipe_s_headings_are_not_alike() {
        let source = doc("a", "Reunión de lunes", "## Resumen\nSe revisó el despliegue del gateway.\n## Tareas\n- [ ] Revisar certificados — responsable — fecha");
        let others = [doc("b", "Reunión de martes", "## Resumen\nSe habló del presupuesto de marketing.\n## Tareas\n- [ ] Enviar la propuesta — responsable — fecha")];
        assert!(rank(&source, &others, 5).is_empty());
    }

    #[test]
    fn a_title_counts_for_more_than_a_passing_mention_and_the_order_is_stable() {
        let source = doc("a", "Migración a Postgres", "Plan de la migración de la base de datos a Postgres con réplicas y ventana de corte.");
        let others = [
            doc("b", "Migración a Postgres: ventana de corte", "La ventana de corte de la migración a Postgres será el sábado, con réplicas listas."),
            doc("c", "Notas sueltas", "Se mencionó la migración a Postgres y las réplicas de paso, junto a la ventana de corte, entre muchos otros asuntos como facturación, permisos, reportes, colas, métricas, alertas, tableros, licencias y proveedores."),
        ];
        let found = rank(&source, &others, 5);
        assert_eq!(found.first().map(|m| m.id.as_str()), Some("b"), "{found:?}");
        assert_eq!(found, rank(&source, &others, 5));
        assert!(rank(&source, &others, 1).len() == 1);
    }

    #[test]
    fn a_note_with_nothing_to_say_matches_nothing() {
        assert!(rank(&doc("a", "", "   "), &[doc("b", "Outbox", "outbox citas eventos")], 5).is_empty());
        assert!(rank(&doc("a", "Outbox", "outbox citas eventos"), &[], 5).is_empty());
    }
}
