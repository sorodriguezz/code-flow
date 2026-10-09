//! Turning what whisper heard and what the speaker model found into the lines a person reads:
//! words labelled with a voice, grouped into turns, cleaned of what whisper invents, and the
//! microphone's echo of the call taken out.

use serde::{Deserialize, Serialize};

use super::audio::Channel;

/// One word with its times on the channel's timeline. `text` keeps the leading space whisper puts
/// before a word that is not glued to the previous one.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// One line of the transcript: a run of one voice on one channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub channel: Channel,
    /// A speaker key within the meeting: `me`, or `p0`, `p1`… for the separated voices, or `others`
    /// for a system channel nobody separated.
    pub speaker: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

pub const ME: &str = "me";
pub const OTHERS: &str = "others";

pub fn person(index: usize) -> String {
    format!("p{index}")
}

/// A pause this long starts a new line even within one voice.
const PAUSE_MS: i64 = 1_500;
/// A line ends at the first sentence end after this many words, and at the latest at twice it.
const LINE_WORDS: usize = 40;

/// What whisper writes for sounds rather than words, and the lines it invents in silence — whole
/// lines only: a sentence that *contains* "gracias" is speech.
const INVENTED: &[&str] = &[
    "subtítulos realizados por la comunidad de amara.org",
    "subtítulos por la comunidad de amara.org",
    "subtitulado por la comunidad de amara.org",
    "subtítulos en español de la comunidad de amara.org",
    "suscríbete",
    "suscríbete al canal",
    "gracias por ver el video",
    "gracias por ver",
    "thanks for watching",
    "thank you for watching",
    "subtitles by the amara.org community",
    "música",
    "music",
    "aplausos",
    "risas",
    "silencio",
];

/// Whisper's bracketed and parenthesised sound marks out, spaces collapsed.
pub fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' if depth > 0 => depth -= 1,
            '♪' => {}
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalised(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '.')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .to_string()
}

/// Whether a whole segment is something whisper made up: one of the known lines, or a short text
/// the model itself thought was not speech.
pub fn invented(text: &str, no_speech: f32) -> bool {
    let plain = normalised(text);
    if plain.is_empty() {
        return true;
    }
    if INVENTED.iter().any(|known| plain == *known) {
        return true;
    }
    no_speech > 0.8 && plain.split_whitespace().count() <= 3
}

/// Words from whisper's one-word segments, shifted by where their piece starts. Sound marks and
/// empty words are dropped.
pub fn words_from(segments: &[crate::dictation::engine::Segment], offset_ms: i64) -> Vec<Word> {
    segments
        .iter()
        .filter(|segment| !segment.text.contains("[BLANK_AUDIO]"))
        .filter_map(|segment| {
            let cleaned = clean_text(&segment.text);
            if cleaned.is_empty() {
                return None;
            }
            // Keep whether it was glued to the previous word (a comma, an apostrophe) or not.
            let text = if segment.text.starts_with(' ') { format!(" {cleaned}") } else { cleaned };
            Some(Word { start_ms: offset_ms + segment.start_ms, end_ms: offset_ms + segment.end_ms.max(segment.start_ms), text })
        })
        .collect()
}

/// A labelled window on the timeline: `label` is the cluster the speaker model put it in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Turn {
    pub start_ms: i64,
    pub end_ms: i64,
    pub label: usize,
}

/// The label of the moment `at`: the turn covering it with the nearest centre, or the nearest turn
/// within `reach_ms`.
fn label_at(turns: &[Turn], at: i64, reach_ms: i64) -> Option<usize> {
    // Ranked by (outside?, distance): any window the moment falls inside beats every window it is
    // near; among those it is inside, the one whose centre is nearest wins, so overlapping windows
    // split their overlap.
    let mut best: Option<((bool, i64), usize)> = None;
    for turn in turns {
        let rank = if at < turn.start_ms {
            (true, turn.start_ms - at)
        } else if at > turn.end_ms {
            (true, at - turn.end_ms)
        } else {
            (false, ((turn.start_ms + turn.end_ms) / 2 - at).abs())
        };
        if rank.0 && rank.1 > reach_ms {
            continue;
        }
        if best.is_none_or(|(b, _)| rank < b) {
            best = Some((rank, turn.label));
        }
    }
    best.map(|(_, label)| label)
}

/// Where each word is placed for labelling, anchored to the speech the detector found.
///
/// whisper's word times drift — the last word of a sentence routinely lands half a second into the
/// pause after it, which is where the next person starts. The detector's stretches are precise, so
/// each sentence is pinned to the stretch it overlaps most, and a word of it lying in a pause (or
/// just across the edge of a neighbouring stretch) is moved inside that one. A word well inside
/// another stretch keeps its place: a sentence can genuinely run across two turns.
pub fn anchor(words: &[Word], stretches: &[(i64, i64)]) -> Vec<i64> {
    const PULL_MS: i64 = 800;
    let mut out: Vec<i64> = words.iter().map(|w| (w.start_ms + w.end_ms) / 2).collect();
    if stretches.is_empty() {
        return out;
    }
    let containing = |at: i64| stretches.iter().position(|(s, e)| *s <= at && at <= *e);
    let mut first = 0;
    for index in 0..words.len() {
        let ends = words[index].text.trim_end().ends_with(['.', '?', '!', '…']) || index + 1 == words.len();
        if !ends {
            continue;
        }
        let (from, to) = (words[first].start_ms, words[index].end_ms);
        let dominant = stretches
            .iter()
            .enumerate()
            .map(|(k, (s, e))| (k, to.min(*e) - from.max(*s)))
            .max_by_key(|(_, overlap)| *overlap)
            .filter(|(_, overlap)| *overlap > 0)
            .map(|(k, _)| k)
            .or_else(|| {
                let middle = (from + to) / 2;
                stretches.iter().enumerate().min_by_key(|(_, (s, e))| if middle < *s { s - middle } else { (middle - e).max(0) }).map(|(k, _)| k)
            });
        if let Some(dominant) = dominant {
            let (s, e) = stretches[dominant];
            for position in out.iter_mut().take(index + 1).skip(first) {
                let near_edge = (*position < s && s - *position <= PULL_MS) || (*position > e && *position - e <= PULL_MS);
                match containing(*position) {
                    Some(k) if k == dominant => {}
                    Some(_) if !near_edge => {}
                    _ => *position = (*position).clamp(s, e),
                }
            }
        }
        first = index + 1;
    }
    out
}

/// A speaker key per word: the turn it falls in, a neighbour's for a word between turns.
#[cfg(test)]
pub fn label_words(words: &[Word], turns: &[Turn]) -> Vec<Option<usize>> {
    let positions: Vec<i64> = words.iter().map(|w| (w.start_ms + w.end_ms) / 2).collect();
    label_positions(&positions, turns)
}

/// [`label_words`] for positions already anchored with [`anchor`].
pub fn label_positions(positions: &[i64], turns: &[Turn]) -> Vec<Option<usize>> {
    let mut labels: Vec<Option<usize>> = positions.iter().map(|at| label_at(turns, *at, 1_500)).collect();
    // Unlabelled words take the previous word's voice, or the next one's at the start.
    let mut last = None;
    for label in labels.iter_mut() {
        match label {
            Some(found) => last = Some(*found),
            None => *label = last,
        }
    }
    let mut next = None;
    for label in labels.iter_mut().rev() {
        match label {
            Some(found) => next = Some(*found),
            None => *label = next,
        }
    }
    labels
}

/// Words grouped into lines: a new line where the voice changes, after a long pause, or at a
/// sentence end once a line is long.
pub fn group(words: &[Word], speakers: &[String], channel: Channel) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut count = 0usize;
    for (word, speaker) in words.iter().zip(speakers) {
        let start_new = match lines.last() {
            None => true,
            Some(line) => {
                let sentence_end = line.text.ends_with(['.', '?', '!', '…']);
                line.speaker != *speaker
                    || word.start_ms - line.end_ms > PAUSE_MS
                    || (count >= LINE_WORDS && sentence_end)
                    || count >= LINE_WORDS * 2
            }
        };
        if start_new {
            lines.push(Line { channel, speaker: speaker.clone(), start_ms: word.start_ms, end_ms: word.end_ms, text: word.text.trim_start().to_string() });
            count = 1;
        } else if let Some(line) = lines.last_mut() {
            line.text.push_str(&word.text);
            line.end_ms = line.end_ms.max(word.end_ms);
            count += 1;
        }
    }
    for line in &mut lines {
        line.text = line.text.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    lines.retain(|line| !invented(&line.text, 0.0));
    lines
}

/// The label a whole line takes: the one its time overlaps most.
pub fn label_line(start_ms: i64, end_ms: i64, turns: &[Turn]) -> Option<usize> {
    let mut overlap: std::collections::HashMap<usize, i64> = std::collections::HashMap::new();
    for turn in turns {
        let shared = end_ms.min(turn.end_ms) - start_ms.max(turn.start_ms);
        if shared > 0 {
            *overlap.entry(turn.label).or_default() += shared;
        }
    }
    overlap.into_iter().max_by_key(|(label, ms)| (*ms, std::cmp::Reverse(*label))).map(|(label, _)| label).or_else(|| label_at(turns, (start_ms + end_ms) / 2, 3_000))
}

fn tokens(text: &str) -> Vec<String> {
    normalised(text).split_whitespace().map(|w| w.trim_matches('.').to_string()).filter(|w| !w.is_empty()).collect()
}

/// Which of `ours` also run, in order, through `theirs` — the longest common subsequence, marked.
fn common_run(ours: &[String], theirs: &[String]) -> Vec<bool> {
    let (n, m) = (ours.len(), theirs.len());
    let mut table = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if ours[i] == theirs[j] { table[i + 1][j + 1] + 1 } else { table[i + 1][j].max(table[i][j + 1]) };
        }
    }
    let mut marked = vec![false; n];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if ours[i] == theirs[j] {
            marked[i] = true;
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    marked
}

/// Runs of at least this many words the call said too are its echo, not a coincidence.
const ECHO_RUN: usize = 3;

/// The microphone's lines minus the call coming back through the speakers. A mic line made mostly
/// of what an overlapping system line said is dropped; one that only carries some of it (the
/// person recording spoke over the echo) keeps its own words and loses the echoed runs.
///
/// For lines without word times — the live text. The final pass has times and uses
/// [`drop_echo_words`] instead, which is surer.
pub fn drop_echo(mic: Vec<Line>, system: &[Line]) -> Vec<Line> {
    mic.into_iter()
        .filter_map(|mut line| {
            let ours = tokens(&line.text);
            if ours.is_empty() {
                return Some(line);
            }
            let theirs: Vec<String> = system
                .iter()
                .filter(|other| line.end_ms.min(other.end_ms + 1_500) - line.start_ms.max(other.start_ms - 1_500) > 0)
                .flat_map(|other| tokens(&other.text))
                .collect();
            if theirs.is_empty() {
                return Some(line);
            }
            let marked = common_run(&ours, &theirs);
            let echoed = marked.iter().filter(|m| **m).count();
            if echoed as f32 / ours.len() as f32 >= 0.6 {
                return None;
            }
            let words: Vec<&str> = line.text.split_whitespace().collect();
            if words.len() != ours.len() {
                return Some(line);
            }
            let keep = keep_mask(&marked);
            if keep.iter().all(|k| *k) {
                return Some(line);
            }
            line.text = words.iter().zip(&keep).filter(|(_, k)| **k).map(|(w, _)| *w).collect::<Vec<_>>().join(" ");
            (!line.text.trim().is_empty()).then_some(line)
        })
        .collect()
}

/// `false` for every word inside a run of at least [`ECHO_RUN`] marked words.
fn keep_mask(marked: &[bool]) -> Vec<bool> {
    let mut keep = vec![true; marked.len()];
    let mut index = 0;
    while index < marked.len() {
        if !marked[index] {
            index += 1;
            continue;
        }
        let start = index;
        while index < marked.len() && marked[index] {
            index += 1;
        }
        if index - start >= ECHO_RUN {
            keep[start..index].iter_mut().for_each(|k| *k = false);
        }
    }
    keep
}

/// The microphone's words minus the call's echo, by time: a run of mic words that the system
/// channel also said, in order, within a second and a half of when the mic heard them.
pub fn drop_echo_words(mic: Vec<Word>, system: &[Word]) -> Vec<Word> {
    if system.is_empty() || mic.is_empty() {
        return mic;
    }
    const NEAR_MS: i64 = 1_500;
    let norm = |w: &Word| normalised(&w.text).trim_matches('.').to_string();
    let theirs: Vec<(i64, i64, String)> = system.iter().map(|w| (w.start_ms, w.end_ms, norm(w))).collect();
    // A mic word is a candidate when the call said the same word at about the same moment.
    let mut marked: Vec<bool> = mic
        .iter()
        .map(|word| {
            let text = norm(word);
            !text.is_empty() && theirs.iter().any(|(s, e, t)| *t == text && *s <= word.end_ms + NEAR_MS && *e >= word.start_ms - NEAR_MS)
        })
        .collect();
    // A lone candidate is a coincidence ("sí" said by both); a run is the echo.
    let keep = keep_mask(&marked);
    marked.clear();
    mic.into_iter().zip(keep).filter(|(_, k)| *k).map(|(w, _)| w).collect()
}

/// Lines of both channels in time order.
pub fn merge(mut lines: Vec<Line>) -> Vec<Line> {
    lines.sort_by_key(|line| (line.start_ms, line.end_ms));
    lines
}

/// The transcript as an AI engine reads it: one line per turn, `[12:34] María: …`.
pub fn for_ai(lines: &[(i64, String, String)]) -> String {
    let mut out = String::new();
    for (start_ms, name, text) in lines {
        out.push_str(&format!("[{}] {}: {}\n", super::clock(*start_ms), name, text));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(start: i64, end: i64, text: &str) -> Word {
        Word { start_ms: start, end_ms: end, text: text.into() }
    }

    #[test]
    fn sound_marks_and_invented_lines_go() {
        assert_eq!(clean_text(" [Música] Hola (risas) a todos"), "Hola a todos");
        assert!(invented("Subtítulos realizados por la comunidad de Amara.org", 0.0));
        assert!(invented(" ¡Suscríbete! ", 0.0));
        assert!(!invented("Gracias por ver el informe, María.", 0.0));
        assert!(invented("Ok.", 0.9));
        assert!(!invented("Ok.", 0.1));
    }

    #[test]
    fn words_follow_the_turns_they_fall_in() {
        let words = vec![w(0, 400, " Hola"), w(400, 800, " a"), w(800, 1200, " todos."), w(5_000, 5_400, " Gracias"), w(5_400, 5_900, " Juan.")];
        let turns = vec![Turn { start_ms: 0, end_ms: 2_000, label: 0 }, Turn { start_ms: 4_800, end_ms: 6_800, label: 1 }];
        let labels = label_words(&words, &turns);
        assert_eq!(labels, vec![Some(0), Some(0), Some(0), Some(1), Some(1)]);
        let speakers: Vec<String> = labels.iter().map(|l| person(l.unwrap())).collect();
        let lines = group(&words, &speakers, Channel::System);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Hola a todos.");
        assert_eq!((lines[1].speaker.as_str(), lines[1].start_ms, lines[1].end_ms), ("p1", 5_000, 5_900));
    }

    #[test]
    fn a_word_between_turns_takes_its_neighbours_voice() {
        let words = vec![w(0, 300, " Sí"), w(9_000, 9_300, " no"), w(20_000, 20_300, " ok")];
        let turns = vec![Turn { start_ms: 19_500, end_ms: 21_000, label: 2 }];
        assert_eq!(label_words(&words, &turns), vec![Some(2), Some(2), Some(2)]);
    }

    #[test]
    fn a_sentence_end_that_drifts_into_the_pause_stays_with_its_speaker() {
        // Eddy speaks 22.1–25.1 s, Grandpa from 26.0 s; whisper put "tarde." at 25.3–25.9.
        let stretches = vec![(22_114, 25_119), (26_019, 29_671)];
        let words = vec![w(21_800, 22_400, " Me"), w(24_500, 25_290, " la"), w(25_290, 25_900, " tarde."), w(26_100, 26_400, " Yo"), w(29_400, 30_100, " pacientes.")];
        let positions = anchor(&words, &stretches);
        assert!(positions[2] <= 25_119, "{positions:?}");
        assert!(positions[4] >= 26_019 && positions[4] <= 29_671, "{positions:?}");
        let turns = vec![Turn { start_ms: 22_114, end_ms: 25_119, label: 1 }, Turn { start_ms: 26_019, end_ms: 29_671, label: 2 }];
        assert_eq!(label_positions(&positions, &turns), vec![Some(1), Some(1), Some(1), Some(2), Some(2)]);
    }

    #[test]
    fn a_long_pause_starts_a_new_line() {
        let words = vec![w(0, 300, " Uno"), w(5_000, 5_300, " dos")];
        let lines = group(&words, &[ME.to_string(), ME.to_string()], Channel::Mic);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn a_line_takes_the_voice_it_overlaps_most() {
        let turns = vec![Turn { start_ms: 0, end_ms: 1_000, label: 0 }, Turn { start_ms: 1_000, end_ms: 4_000, label: 1 }];
        assert_eq!(label_line(500, 3_500, &turns), Some(1));
        assert_eq!(label_line(9_000, 9_500, &turns), None);
    }

    #[test]
    fn echoed_words_go_and_the_recorders_own_stay() {
        let system = vec![w(1_000, 1_300, " Propongo"), w(1_300, 1_700, " implementar"), w(1_700, 2_000, " CQRS"), w(2_000, 2_400, " ahora.")];
        // The echo, 40 ms late, then the person recording saying something of their own over it.
        let mic = vec![w(1_040, 1_340, " propongo"), w(1_340, 1_740, " implementar"), w(1_740, 2_040, " CQRS"), w(2_040, 2_440, " ahora."), w(2_500, 2_800, " Sí,"), w(2_800, 3_200, " de"), w(3_200, 3_500, " acuerdo.")];
        let kept: Vec<String> = drop_echo_words(mic, &system).into_iter().map(|w| w.text).collect();
        assert_eq!(kept, vec![" Sí,", " de", " acuerdo."]);
        // A single shared word is not an echo.
        let lone = drop_echo_words(vec![w(5_000, 5_200, " sí")], &[w(5_100, 5_300, " sí")]);
        assert_eq!(lone.len(), 1);
    }

    #[test]
    fn a_live_line_loses_the_echo_run_and_keeps_its_own_words() {
        let system = vec![Line { channel: Channel::System, speaker: "others".into(), start_ms: 0, end_ms: 4_000, text: "Propongo implementar CQRS para separar lecturas".into() }];
        let mic = vec![Line { channel: Channel::Mic, speaker: ME.into(), start_ms: 0, end_ms: 6_000, text: "Buenos días a todos, propongo implementar CQRS para separar lecturas. Bien, revisemos la consistencia de la agenda".into() }];
        let kept = drop_echo(mic, &system);
        assert_eq!(kept.len(), 1);
        assert!(!kept[0].text.to_lowercase().contains("implementar"), "{}", kept[0].text);
        assert!(kept[0].text.starts_with("Buenos días"), "{}", kept[0].text);
    }

    #[test]
    fn the_call_heard_through_the_speakers_is_not_said_twice() {
        let system = vec![Line { channel: Channel::System, speaker: "p0".into(), start_ms: 1_000, end_ms: 4_000, text: "Propongo implementar CQRS para separar lecturas".into() }];
        let mic = vec![
            Line { channel: Channel::Mic, speaker: ME.into(), start_ms: 1_100, end_ms: 4_100, text: "propongo implementar CQRS para separar las lecturas".into() },
            Line { channel: Channel::Mic, speaker: ME.into(), start_ms: 6_000, end_ms: 7_000, text: "De acuerdo, revisemos la consistencia".into() },
        ];
        let kept = drop_echo(mic, &system);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].text.starts_with("De acuerdo"));
    }

    #[test]
    fn the_ai_reads_times_and_names() {
        let text = for_ai(&[(754_000, "María".into(), "Hola.".into())]);
        assert_eq!(text, "[12:34] María: Hola.\n");
    }
}
