//! What is said, cut into the pieces the voice says one at a time — so every piece is evened out
//! to the same loudness ([`super::level`]) and the pauses between them are the app's, not the
//! model's (user, 2026-11-19: «hay partes donde se acelera o habla más bajo, no es tan uniforme»).
//!
//! A piece is a sentence. A sentence too long for a natural voice to say evenly — it hurries
//! through a run of 300 characters — is cut at its commas, semicolons or colons, and failing those
//! at a space. A sentence too short to stand alone («Sí.», «Listo.») goes with the next one: said
//! by itself a natural voice clips it.

/// Longer than this, a sentence is cut at its clauses.
pub const MAX_CHARS: usize = 160;
/// Shorter than this, a sentence is said with the next.
const MIN_CHARS: usize = 16;
/// After a sentence, at rate 1.
pub const SENTENCE_PAUSE_MS: u32 = 300;
/// After a clause a long sentence was cut at, and at a comma, semicolon or colon inside a piece
/// ([`marks`]).
pub const CLAUSE_PAUSE_MS: u32 = 150;

/// Words whose dot does not end a sentence when what follows is a name: titles the abbreviations
/// pass did not write out (a service's text, a user's own). A single capital is an initial («J.
/// Pérez»).
const NO_END: &[&str] = &["sr", "sra", "srta", "dr", "dra", "ud", "uds", "mr", "mrs", "ms", "st", "av", "avda", "dpto", "depto"];

/// Where a pause belongs inside a piece the voice says whole: after each internal `.` `!` `?` `…`
/// (a short sentence said with the next) and each `,` `;` `:`. `at` is how far into the piece's
/// letters it falls, 0–1 — where in the audio its silence should be found ([`super::level::fit_pauses`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mark {
    pub at: f32,
    pub pause_ms: u32,
}

pub fn marks(text: &str) -> Vec<Mark> {
    let chars: Vec<char> = text.chars().collect();
    let letters = chars.iter().filter(|c| c.is_alphanumeric()).count();
    if letters == 0 {
        return Vec::new();
    }
    let mut seen = 0usize;
    let mut out = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        if c.is_alphanumeric() {
            seen += 1;
            continue;
        }
        let followed = chars.get(i + 1).is_some_and(|next| next.is_whitespace());
        let more = seen < letters;
        let pause_ms = match c {
            '.' | '!' | '?' | '…' => SENTENCE_PAUSE_MS,
            ',' | ';' | ':' => CLAUSE_PAUSE_MS,
            _ => continue,
        };
        // A mark at the very end is the piece's own pause, and «...» counts once.
        if followed && more && out.last().is_none_or(|last: &Mark| last.at < seen as f32 / letters as f32) {
            out.push(Mark { at: seen as f32 / letters as f32, pause_ms });
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub text: String,
    /// The silence after it; none after the last.
    pub pause_ms: u32,
}

/// `text` in the pieces it is said in.
pub fn split(text: &str) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for sentence in merge_short(sentences(text)) {
        let clauses = clauses(&sentence);
        let last = clauses.len().saturating_sub(1);
        for (i, clause) in clauses.into_iter().enumerate() {
            out.push(Segment { text: clause, pause_ms: if i == last { SENTENCE_PAUSE_MS } else { CLAUSE_PAUSE_MS } });
        }
    }
    if let Some(last) = out.last_mut() {
        last.pause_ms = 0;
    }
    out
}

/// Sentences, each with its closing mark (and a closing quote or bracket after it). A mark not
/// followed by a space or the end — `3.5`, `p.ej` — does not end one.
fn sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        current.push(c);
        if matches!(c, '.' | '!' | '?' | '…') {
            while let Some(&close) = chars.get(i + 1).filter(|next| matches!(next, '.' | '!' | '?' | '…' | ')' | ']' | '"' | '\'' | '»' | '”' | '’')) {
                current.push(close);
                i += 1;
            }
            if chars.get(i + 1).is_none_or(|next| next.is_whitespace()) && !before_a_name(&current, chars.get(i + 2).copied()) {
                push_trimmed(&mut out, &mut current);
            }
        }
        i += 1;
    }
    push_trimmed(&mut out, &mut current);
    out
}

/// `current` ends in a title or an initial and a capital comes next: «Dr. Soto», «J. Pérez».
fn before_a_name(current: &str, next: Option<char>) -> bool {
    if !next.is_some_and(char::is_uppercase) || !current.ends_with('.') {
        return false;
    }
    let word = current[..current.len() - 1].rsplit(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
    let initial = word.chars().count() == 1 && word.chars().all(char::is_uppercase);
    initial || NO_END.contains(&word.to_lowercase().as_str())
}

fn push_trimmed(out: &mut Vec<String>, current: &mut String) {
    let piece = current.trim();
    if !piece.is_empty() {
        out.push(piece.to_string());
    }
    current.clear();
}

/// A sentence too short to say alone, joined to the one after it.
fn merge_short(sentences: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut carried: Option<String> = None;
    for sentence in sentences {
        let sentence = match carried.take() {
            Some(before) => format!("{before} {sentence}"),
            None => sentence,
        };
        if sentence.chars().count() < MIN_CHARS {
            carried = Some(sentence);
        } else {
            out.push(sentence);
        }
    }
    if let Some(rest) = carried {
        match out.last_mut() {
            // A short last one goes with the one before rather than alone.
            Some(last) if last.chars().count() + rest.chars().count() < MAX_CHARS => {
                last.push(' ');
                last.push_str(&rest);
            }
            _ => out.push(rest),
        }
    }
    out
}

/// A sentence in pieces of at most [`MAX_CHARS`]: whole when it fits, else as many clauses (cut
/// after `,` `;` `:`) as fit in each piece, and a clause still too long at its spaces.
fn clauses(sentence: &str) -> Vec<String> {
    if sentence.chars().count() <= MAX_CHARS {
        return vec![sentence.to_string()];
    }
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = sentence.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        if matches!(c, ',' | ';' | ':') && chars.peek().is_some_and(|next| next.is_whitespace()) {
            parts.push(std::mem::take(&mut current));
        }
    }
    parts.push(current);
    let mut out: Vec<String> = Vec::new();
    let mut piece = String::new();
    for part in parts.iter().map(|part| part.trim()).filter(|part| !part.is_empty()) {
        if !piece.is_empty() && piece.chars().count() + 1 + part.chars().count() > MAX_CHARS {
            out.push(std::mem::take(&mut piece));
        }
        if !piece.is_empty() {
            piece.push(' ');
        }
        piece.push_str(part);
        while piece.chars().count() > MAX_CHARS {
            let (head, tail) = cut_at_space(&piece, MAX_CHARS);
            out.push(head);
            piece = tail;
        }
    }
    if !piece.trim().is_empty() {
        out.push(piece);
    }
    out
}

/// `text` cut at the last space before `max` characters (or at `max` when there is none).
fn cut_at_space(text: &str, max: usize) -> (String, String) {
    let byte_max = text.char_indices().nth(max).map_or(text.len(), |(at, _)| at);
    let at = text[..byte_max].rfind(' ').filter(|&at| at > 0).unwrap_or(byte_max);
    (text[..at].trim().to_string(), text[at..].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_are_pieces_with_the_apps_pauses() {
        let said = split("Abre el panel de pipelines. Luego elige uno de la lista? Hecho.");
        let texts: Vec<&str> = said.iter().map(|segment| segment.text.as_str()).collect();
        // «Hecho.» is too short to stand alone: it goes with the sentence before.
        assert_eq!(texts, vec!["Abre el panel de pipelines.", "Luego elige uno de la lista? Hecho."]);
        assert_eq!(said[0].pause_ms, SENTENCE_PAUSE_MS);
        assert_eq!(said[1].pause_ms, 0);
    }

    #[test]
    fn a_number_or_an_abbreviation_does_not_end_a_sentence() {
        let said = split("La versión 3.5 trae cambios grandes (ver la nota.) Y algo más que contar.");
        assert_eq!(said.len(), 2, "{said:?}");
        assert_eq!(said[0].text, "La versión 3.5 trae cambios grandes (ver la nota.)");
    }

    #[test]
    fn a_title_or_an_initial_does_not_end_a_sentence() {
        let said = split("Lo revisó el Dr. Soto junto con J. Pérez ayer. Luego lo aprobaron todos.");
        assert_eq!(said.len(), 2, "{said:?}");
        assert_eq!(said[0].text, "Lo revisó el Dr. Soto junto con J. Pérez ayer.");
    }

    #[test]
    fn marks_fall_where_the_punctuation_does() {
        let found = marks("Sí. Lo reviso, ahora.");
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].pause_ms, SENTENCE_PAUSE_MS);
        assert_eq!(found[1].pause_ms, CLAUSE_PAUSE_MS);
        // «Sí» is 2 of the 15 letters; «Sí Lo reviso» 10.
        assert!((found[0].at - 2.0 / 15.0).abs() < 1e-4);
        assert!((found[1].at - 10.0 / 15.0).abs() < 1e-4);
        assert!(marks("Sin pausas dentro.").is_empty());
        assert!(marks("Espera... ya.").len() == 1);
    }

    #[test]
    fn a_short_first_sentence_goes_with_the_next() {
        let said = split("Sí. Lo reviso ahora mismo y te cuento.");
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].text, "Sí. Lo reviso ahora mismo y te cuento.");
    }

    #[test]
    fn a_long_sentence_is_cut_at_its_clauses() {
        let clause = "esta es una parte de una frase larguísima que no termina nunca";
        let long = format!("{clause}, {clause}, {clause}, {clause}.");
        let said = split(&long);
        assert!(said.len() >= 2, "{said:?}");
        assert!(said.iter().all(|segment| segment.text.chars().count() <= MAX_CHARS), "{said:?}");
        assert_eq!(said[0].pause_ms, CLAUSE_PAUSE_MS);
        // Nothing lost.
        let joined = said.iter().map(|segment| segment.text.as_str()).collect::<Vec<_>>().join(" ");
        assert_eq!(joined, long);
        // No punctuation at all: cut at the spaces.
        let words = "palabra ".repeat(60);
        assert!(split(words.trim()).iter().all(|segment| segment.text.chars().count() <= MAX_CHARS));
    }
}
