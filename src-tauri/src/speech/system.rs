//! The computer's own voice: `say` on macOS, SAPI on Windows, espeak-ng on Linux.
//!
//! Each writes a WAV file that [`super::player`] then plays — never straight to the speaker, so the
//! chosen output, the volume and «Callar» work the same for every engine. No download, no key, and
//! it runs on any laptop: the default engine.

use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// One installed voice. `id` is what the engine is told (`say -v`, `SelectVoice`, `espeak -v`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemVoice {
    pub id: String,
    pub name: String,
    /// BCP-47-ish (`es-MX`, `en-US`); empty when the engine does not say.
    pub lang: String,
}

/// The last listing and when it was read: «Automática» looks its voice up for every utterance, and
/// each listing is a process (`say -v '?'`, PowerShell).
static LISTED: Mutex<Option<(Instant, Vec<SystemVoice>)>> = Mutex::new(None);
const LISTING_KEPT: Duration = Duration::from_secs(300);

/// The installed voices, Spanish and English first — the app's two languages. Always read afresh
/// (Settings asks for it, and a voice may just have been added); kept for [`default_for`].
pub fn voices() -> Vec<SystemVoice> {
    let mut found = listed();
    found.sort_by_key(|voice| {
        let lang = voice.lang.to_ascii_lowercase();
        (if lang.starts_with("es") { 0 } else if lang.starts_with("en") { 1 } else { 2 }, voice.name.clone())
    });
    *LISTED.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), found.clone()));
    found
}

/// The voice «Automática» reads `lang` (`es` · `en`) with on this computer, if it has one.
pub fn default_for(lang: &str) -> Option<String> {
    let kept = LISTED.lock().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|(at, _)| at.elapsed() < LISTING_KEPT).map(|(_, voices)| voices.clone());
    pick(&kept.unwrap_or_else(voices), lang)
}

/// Each system's own voice for the language, where it ships one everybody has.
const PREFERRED: &[&str] = &["Samantha", "Paulina", "Mónica", "Monica", "Microsoft Zira", "Microsoft Sabina", "Microsoft Helena"];
/// macOS's novelty and 1990s voices: listed as English, never what anyone means by "a voice".
const NOVELTY: &[&str] = &[
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Fred", "Good News", "Jester", "Junior", "Kathy", "Organ",
    "Ralph", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
];

/// [`default_for`] over a given listing: a preferred voice in `lang`, else the first one in it that
/// is not a novelty. Without one, the caller passes no voice and the system's default speaks.
pub fn pick(voices: &[SystemVoice], lang: &str) -> Option<String> {
    let speaks = |voice: &&SystemVoice| voice.lang.to_ascii_lowercase().starts_with(lang);
    // «Paulina (Español (México))» is Paulina; «Microsoft Zira Desktop» is Microsoft Zira.
    let named = |voice: &SystemVoice, name: &str| voice.name == name || voice.name.starts_with(&format!("{name} "));
    PREFERRED
        .iter()
        .find_map(|name| voices.iter().filter(speaks).find(|voice| named(voice, name)))
        .or_else(|| voices.iter().filter(speaks).find(|voice| !NOVELTY.iter().any(|name| named(voice, name))))
        .map(|voice| voice.id.clone())
}

#[cfg(target_os = "macos")]
fn listed() -> Vec<SystemVoice> {
    let Ok(output) = crate::proc::std_command("say").arg("-v").arg("?").output() else { return Vec::new() };
    parse_say_voices(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(windows)]
fn listed() -> Vec<SystemVoice> {
    let script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                  $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    let Ok(output) = crate::proc::std_command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, lang) = line.trim().split_once('|')?;
            Some(SystemVoice { id: name.to_string(), name: name.to_string(), lang: lang.to_string() })
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn listed() -> Vec<SystemVoice> {
    let Some(program) = espeak() else { return Vec::new() };
    let Ok(output) = crate::proc::std_command(program).arg("--voices").output() else { return Vec::new() };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let lang = fields.get(1)?.to_string();
            Some(SystemVoice { id: lang.clone(), name: fields.get(3).unwrap_or(&lang.as_str()).to_string(), lang })
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn espeak() -> Option<&'static str> {
    ["espeak-ng", "espeak"].into_iter().find(|p| crate::containers::cli::find(p).is_some())
}

/// `say -v '?'`: `Name    lang    # sample`, where a name may itself hold spaces and parentheses
/// («Eddy (Español (México))»).
pub fn parse_say_voices(listing: &str) -> Vec<SystemVoice> {
    listing
        .lines()
        .filter_map(|line| {
            let (head, _) = line.split_once('#')?;
            let head = head.trim_end();
            let (name, lang) = head.rsplit_once(char::is_whitespace)?;
            let name = name.trim();
            let lang = lang.trim();
            if name.is_empty() || !lang.contains('_') {
                return None;
            }
            Some(SystemVoice { id: name.to_string(), name: name.to_string(), lang: lang.replace('_', "-") })
        })
        .collect()
}

/// A temporary WAV path of our own, removed by the caller.
fn scratch() -> PathBuf {
    std::env::temp_dir().join(format!("codeflow-voice-{}-{}.wav", std::process::id(), uuid::Uuid::new_v4().simple()))
}

/// Says `text` with `voice` (`""` = the system's default) at `rate` (1 = normal) into samples.
pub fn synthesize(text: &str, voice: &str, rate: f32) -> Result<(Vec<f32>, u32), String> {
    let path = scratch();
    let result = run(text, voice, rate, &path).and_then(|_| {
        let bytes = std::fs::read(&path).map_err(|e| format!("The voice wrote nothing: {e}"))?;
        super::wav::parse(&bytes)
    });
    let _ = std::fs::remove_file(&path);
    result
}

fn feed(mut command: std::process::Command, text: &str, what: &str) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {what}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("{what}: {e}"))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("{what}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(format!("{what} failed: {}", detail.trim().lines().last().unwrap_or("no detail")))
}

#[cfg(target_os = "macos")]
fn run(text: &str, voice: &str, rate: f32, path: &std::path::Path) -> Result<(), String> {
    let mut command = crate::proc::std_command("say");
    if !voice.trim().is_empty() {
        command.args(["-v", voice.trim()]);
    }
    // `say` speaks about 185 words a minute.
    let words_per_minute = (185.0 * rate.clamp(0.5, 2.0)).round() as u32;
    command
        .args(["-r", &words_per_minute.to_string(), "--file-format=WAVE", "--data-format=LEI16@22050", "-o"])
        .arg(path)
        .args(["-f", "-"]);
    feed(command, text, "say")
}

#[cfg(windows)]
fn run(text: &str, voice: &str, rate: f32, path: &std::path::Path) -> Result<(), String> {
    let quoted = |text: &str| format!("'{}'", text.replace('\'', "''"));
    let pick = if voice.trim().is_empty() { String::new() } else { format!("$s.SelectVoice({});", quoted(voice.trim())) };
    // SAPI's rate runs -10…10 around 0 = normal; each step is roughly 10 %.
    let steps = (((rate.clamp(0.5, 2.0) - 1.0) * 10.0).round() as i32).clamp(-10, 10);
    let script = format!(
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; {pick} \
         $s.Rate = {steps}; $s.SetOutputToWaveFile({}); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()",
        quoted(&path.to_string_lossy())
    );
    let mut command = crate::proc::std_command("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    feed(command, text, "Windows' voice")
}

#[cfg(not(any(target_os = "macos", windows)))]
fn run(text: &str, voice: &str, rate: f32, path: &std::path::Path) -> Result<(), String> {
    let program = espeak().ok_or("No voice on this computer — install espeak-ng")?;
    let mut command = crate::proc::std_command(program);
    command.arg("-w").arg(path).args(["-s", &((175.0 * rate.clamp(0.5, 2.0)).round() as u32).to_string(), "--stdin"]);
    if !voice.trim().is_empty() {
        command.args(["-v", voice.trim()]);
    }
    feed(command, text, "espeak")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_say_voice_names_that_hold_spaces() {
        let listing = "Albert              en_US    # Hello! My name is Albert.\n\
                       Eddy (Español (México)) es_MX    # ¡Hola! Me llamo Eddy.\n\
                       Grandma (Inglés (EE. UU.)) en_US    # Hello! My name is Grandma.\n\
                       broken line without a hash\n";
        let voices = parse_say_voices(listing);
        assert_eq!(voices.len(), 3);
        assert_eq!(voices[1], SystemVoice { id: "Eddy (Español (México))".into(), name: "Eddy (Español (México))".into(), lang: "es-MX".into() });
    }

    #[test]
    fn automatic_picks_a_real_voice_in_the_language() {
        let voice = |name: &str, lang: &str| SystemVoice { id: name.into(), name: name.into(), lang: lang.into() };
        let mac = vec![
            voice("Albert", "en-US"),
            voice("Bad News", "en-US"),
            voice("Eddy (Inglés (EE. UU.))", "en-US"),
            voice("Samantha", "en-US"),
            voice("Eddy (Español (México))", "es-MX"),
            voice("Paulina (Español (México))", "es-MX"),
        ];
        assert_eq!(pick(&mac, "en").as_deref(), Some("Samantha"));
        assert_eq!(pick(&mac, "es").as_deref(), Some("Paulina (Español (México))"));
        // No preferred voice: the first that is not a novelty, never Albert.
        let plain = vec![voice("Albert", "en-US"), voice("Eddy (Inglés (EE. UU.))", "en-US")];
        assert_eq!(pick(&plain, "en").as_deref(), Some("Eddy (Inglés (EE. UU.))"));
        assert_eq!(pick(&[voice("Albert", "en-US")], "en"), None);
        assert_eq!(pick(&mac[..4], "es"), None);
        let windows = vec![voice("Microsoft David Desktop", "en-US"), voice("Microsoft Zira Desktop", "en-US")];
        assert_eq!(pick(&windows, "en").as_deref(), Some("Microsoft Zira Desktop"));
    }

    /// The real voice: `CODEFLOW_TEST_SAY=1` on a Mac.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn the_system_voice_speaks_into_samples() {
        if std::env::var("CODEFLOW_TEST_SAY").is_err() {
            return;
        }
        let voice = voices().into_iter().find(|v| v.lang.starts_with("es")).map(|v| v.id).unwrap_or_default();
        let (samples, rate) = synthesize("Hola, soy el pensamiento de CodeFlow.", &voice, 1.0).unwrap();
        assert_eq!(rate, 22_050);
        assert!(samples.len() > rate as usize, "{} samples", samples.len());
        assert!(samples.iter().any(|v| v.abs() > 0.05));
    }
}
