//! Who speaks with which voice in a call: every agent one of its own, so they are told apart by
//! ear. An agent keeps the voice chosen for it; the others are given one from what this computer
//! has — downloaded voices first, then the system's — and when there are more agents than voices,
//! the same voice comes back at another pitch.

use crate::speech::{self, Voice};

/// A voice an agent may be given.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolVoice {
    /// As [`Voice::id`] takes it.
    pub id: String,
    pub label: String,
    /// `local` (downloaded) · `clone` · `system` · `cloud`.
    pub kind: &'static str,
    /// `es` · `en` · `multi`.
    pub lang: &'static str,
}

/// OpenAI's voices: its model takes any of them by name.
const OPENAI: &[&str] = &["alloy", "ash", "ballad", "coral", "echo", "nova", "onyx", "sage", "shimmer", "verse"];

/// Every voice an agent can be given by hand, for the agent's editor: the downloaded and cloned
/// ones that are installed, the system's in the app's two languages, and a service's when its key
/// is in.
pub fn every(system: &[speech::system::SystemVoice], rows: &[speech::piper::VoiceRow], openai: bool) -> Vec<PoolVoice> {
    let mut out: Vec<PoolVoice> = rows
        .iter()
        .filter(|row| row.installed)
        .map(|row| PoolVoice {
            id: row.id.to_string(),
            label: row.label.to_string(),
            kind: match row.engine {
                "clone" => "clone",
                // The call's own engine (`speech::pocket`): one model, a voice per agent.
                "pocket" => "pocket",
                _ => "local",
            },
            lang: if row.lang == "multi" { "multi" } else { speech::language(row.lang) },
        })
        .collect();
    for lang in ["es", "en"] {
        out.extend(speech::system::of_language(system, lang).into_iter().map(|voice| PoolVoice { id: format!("system:{}", voice.id), label: voice.name, kind: "system", lang }));
    }
    if openai {
        out.extend(OPENAI.iter().map(|name| PoolVoice { id: format!("cloud:openai:{name}"), label: format!("OpenAI · {name}"), kind: "cloud", lang: "multi" }));
    }
    out
}

/// The voices agents are given without anybody choosing, for a call in `lang`: the natural ones
/// this computer has, then the system's. Never a cloned voice — a person's voice is chosen, not
/// fallen into — and a service's only when it is what the user already reads aloud with
/// (`cloud`): what an agent says does not leave the computer because a call started.
pub fn pool(all: &[PoolVoice], lang: &str, cloud: bool) -> Vec<PoolVoice> {
    let of = |kind: &str| -> Vec<PoolVoice> { all.iter().filter(|voice| voice.kind == kind && (voice.lang == lang || voice.lang == "multi") && !character(voice)).cloned().collect() };
    // The call's own engine first (`speech::pocket`); what is made of the rest is [`only`]'s.
    let mut out: Vec<PoolVoice> = of("pocket");
    if cloud {
        out.extend(of("cloud"));
    }
    out.extend(of("local"));
    out.extend(of("system"));
    out
}

/// A system voice nobody is given, though it can be chosen: the ones that play a character — an old
/// man, a deep growl — and macOS's synthesiser voices (Eddy, Flo, Reed, Sandy, Shelley), which
/// every Mac lists in every language and which sound like a machine from another decade. On a Mac
/// with one or two real Spanish voices they were most of the pool, so most of a large team spoke
/// with them (the user, 2026-11-25: «siguen escuchándose muy mal»).
fn character(voice: &PoolVoice) -> bool {
    const CHARACTERS: &[&str] = &["Grandma", "Grandpa", "Rocko", "Abuela", "Abuelo", "Eddy", "Flo", "Reed", "Sandy", "Shelley"];
    voice.kind == "system" && CHARACTERS.iter().any(|name| voice.label == *name || voice.label.starts_with(&format!("{name} ")))
}

pub fn only(pool: Vec<PoolVoice>, kind: &str) -> Vec<PoolVoice> {
    let of = |kind: &str| -> Vec<PoolVoice> { pool.iter().filter(|voice| voice.kind == kind).cloned().collect() };
    if matches!(kind, "pocket" | "local" | "system" | "cloud") {
        let kept = of(kind);
        if !kept.is_empty() {
            return kept;
        }
    }
    // Left to the app — or nothing of the kind asked for: the call's engine, when it is installed,
    // is the whole pool. Twenty-seven voices that are each another voice, with nothing weaker
    // mixed in between them.
    let natural = of("pocket");
    if natural.is_empty() {
        pool
    } else {
        natural
    }
}

/// How the same voice sounds the second, third… time it is given: `(pitch, rate)`, each a little
/// off the voice as it is. Small on purpose — a voice moved far is not understood — and both
/// moved, so two of them are told apart by more than how high they are.
const TURNS: [(f32, f32); 6] = [(1.0, 1.0), (0.97, 1.0), (1.03, 1.0), (0.985, 0.96), (1.015, 1.04), (1.0, 0.95)];

/// One voice per seat, in the seats' order. `seats` are `(agent id, the voice chosen for it)`.
/// Stable: the same agents with the same voices installed sound the same call after call.
pub fn cast(seats: &[(String, Option<Voice>)], pool: &[PoolVoice]) -> Vec<Voice> {
    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, chosen) in seats {
        if let Some(voice) = chosen {
            *used.entry(voice.id.clone()).or_default() += 1;
        }
    }
    let mut unnamed = 0usize;
    seats
        .iter()
        .map(|(agent, chosen)| {
            if let Some(voice) = chosen {
                return voice.clone();
            }
            if pool.is_empty() {
                // Nothing to tell them apart by but the pitch of the one voice there is.
                unnamed += 1;
                let (pitch, rate) = TURNS[(unnamed - 1) % TURNS.len()];
                return Voice { pitch, rate, ..Voice::default() };
            }
            // From where its own id points, the voice fewest agents have so far.
            let start = (hash(agent) as usize) % pool.len();
            let pick = (0..pool.len()).map(|step| &pool[(start + step) % pool.len()]).min_by_key(|voice| used.get(&voice.id).copied().unwrap_or(0)).expect("a pool with a voice in it");
            let times = used.entry(pick.id.clone()).or_default();
            let (pitch, rate) = TURNS[*times % TURNS.len()];
            let voice = Voice { id: pick.id.clone(), pitch, rate };
            *times += 1;
            voice
        })
        .collect()
}

/// FNV-1a: the same on every run and every computer, which `DefaultHasher` does not promise.
fn hash(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(id: &str, kind: &'static str, lang: &'static str) -> PoolVoice {
        PoolVoice { id: id.into(), label: id.into(), kind, lang }
    }

    fn seats(ids: &[&str]) -> Vec<(String, Option<Voice>)> {
        ids.iter().map(|id| (id.to_string(), None)).collect()
    }

    #[test]
    fn every_agent_gets_a_different_voice_while_there_are_enough() {
        let pool = vec![voice("a", "local", "es"), voice("b", "local", "es"), voice("system:Paulina", "system", "es"), voice("system:Jorge", "system", "es")];
        let given = cast(&seats(&["lead", "dba", "qa", "dev"]), &pool);
        let mut ids: Vec<&str> = given.iter().map(|v| v.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4, "{given:?}");
        assert!(given.iter().all(|v| v.pitch == 1.0), "nobody needs another pitch yet");
        // The same team sounds the same the next time.
        assert_eq!(given, cast(&seats(&["lead", "dba", "qa", "dev"]), &pool));
    }

    #[test]
    fn with_fewer_voices_than_agents_the_same_voice_comes_back_at_another_pitch() {
        let pool = vec![voice("a", "local", "es"), voice("b", "local", "es")];
        let given = cast(&seats(&["lead", "dba", "qa", "dev", "ops"]), &pool);
        let mut pairs: Vec<(String, i32, i32)> = given.iter().map(|v| (v.id.clone(), (v.pitch * 1000.0).round() as i32, (v.rate * 1000.0).round() as i32)).collect();
        pairs.sort();
        pairs.dedup();
        assert_eq!(pairs.len(), 5, "no two sound alike: {given:?}");
        // …and none is moved far from the voice as it is: a voice at an extreme is not understood.
        assert!(given.iter().all(|v| (v.pitch - 1.0).abs() <= 0.04 && (v.rate - 1.0).abs() <= 0.05), "{given:?}");

        // No voice at all: the one there is, a little apart each time.
        let alone = cast(&seats(&["lead", "dba", "qa"]), &[]);
        assert!(alone.iter().all(|v| v.id.is_empty()));
        assert_eq!(alone.iter().map(|v| (v.pitch * 1000.0).round() as i32).collect::<Vec<_>>(), vec![1000, 970, 1030]);
    }

    #[test]
    fn a_chosen_voice_is_kept_and_nobody_else_is_given_it_first() {
        let pool = vec![voice("a", "local", "es"), voice("b", "local", "es")];
        let mut team = seats(&["lead", "dba"]);
        team[0].1 = Some(Voice { id: "a".into(), pitch: 0.9, rate: 1.1 });
        let given = cast(&team, &pool);
        assert_eq!(given[0], Voice { id: "a".into(), pitch: 0.9, rate: 1.1 });
        assert_eq!(given[1].id, "b");
    }

    #[test]
    fn the_pool_is_this_computer_s_voices_in_the_call_s_language() {
        let all = vec![
            voice("es_MX-claude-high", "local", "es"),
            voice("kokoro-af_heart", "local", "en"),
            voice("clone-mine", "clone", "multi"),
            voice("system:Paulina", "system", "es"),
            voice("system:Samantha", "system", "en"),
            voice("cloud:openai:alloy", "cloud", "multi"),
        ];
        let ids = |lang: &str, cloud: bool| pool(&all, lang, cloud).into_iter().map(|v| v.id).collect::<Vec<_>>();
        assert_eq!(ids("es", false), vec!["es_MX-claude-high", "system:Paulina"]);
        assert_eq!(ids("en", false), vec!["kokoro-af_heart", "system:Samantha"]);
        // One kind alone when asked, and everything when this computer has none of it.
        let es = pool(&all, "es", true);
        assert_eq!(only(es.clone(), "system").into_iter().map(|v| v.id).collect::<Vec<_>>(), vec!["system:Paulina"]);
        assert_eq!(only(es.clone(), "auto").len(), es.len());
        assert_eq!(only(pool(&all, "es", false), "cloud").len(), 2, "no service here: the pool as it is");
        // A voice that plays a character is nobody's by default.
        let with_characters = vec![voice("system:Paulina", "system", "es"), PoolVoice { label: "Grandpa (Español (México))".into(), ..voice("system:Grandpa (Español (México))", "system", "es") }, PoolVoice { label: "Rocko".into(), ..voice("system:Rocko", "system", "es") }];
        assert_eq!(pool(&with_characters, "es", false).into_iter().map(|v| v.id).collect::<Vec<_>>(), vec!["system:Paulina"]);
        // Nor macOS's synthesiser voices, listed in every language: what this Mac's `say` offers
        // for Spanish, as it names them.
        let listed = ["Eddy (Español (España))", "Flo (Español (México))", "Mónica", "Paulina", "Reed (Español (España))", "Sandy (Español (México))", "Shelley (Español (España))"];
        let mac: Vec<PoolVoice> = listed.iter().map(|name| PoolVoice { label: (*name).into(), ..voice(&format!("system:{name}"), "system", "es") }).collect();
        assert_eq!(pool(&mac, "es", false).into_iter().map(|v| v.label).collect::<Vec<_>>(), vec!["Mónica", "Paulina"]);
        // The call's own engine, once installed, is everybody's voice unless another kind is asked for.
        let mut with_engine = all.clone();
        with_engine.push(voice("pocket-lola", "pocket", "multi"));
        with_engine.push(voice("pocket-javert", "pocket", "multi"));
        let es = pool(&with_engine, "es", true);
        assert_eq!(only(es.clone(), "auto").into_iter().map(|v| v.id).collect::<Vec<_>>(), vec!["pocket-lola", "pocket-javert"]);
        assert_eq!(only(es.clone(), "").len(), 2);
        assert_eq!(only(es.clone(), "pocket").len(), 2);
        assert_eq!(only(es.clone(), "system").into_iter().map(|v| v.id).collect::<Vec<_>>(), vec!["system:Paulina"]);
        // A service only for somebody who already reads aloud with it.
        assert_eq!(ids("es", true), vec!["cloud:openai:alloy", "es_MX-claude-high", "system:Paulina"]);
    }
}
