//! A voice from a service: OpenAI's `/v1/audio/speech` or ElevenLabs' text-to-speech. Both are asked
//! for raw 16-bit PCM, so nothing is decoded — OpenAI's comes at 24 kHz, ElevenLabs' at the 22 050
//! Hz requested. The text leaves this computer; Settings says so beside the choice.

use serde_json::json;

/// The keychain entries the keys live under.
pub const OPENAI_KEY: &str = "speech-openai-key";
pub const ELEVENLABS_KEY: &str = "speech-elevenlabs-key";

/// The voice an account has without choosing: OpenAI's own names, and ElevenLabs' premade «Rachel».
pub const OPENAI_DEFAULT_VOICE: &str = "alloy";
pub const ELEVENLABS_DEFAULT_VOICE: &str = "21m00Tcm4TlvDq8ikWAM";

pub fn key_name(service: &str) -> Option<&'static str> {
    match service {
        "openai" => Some(OPENAI_KEY),
        "elevenlabs" => Some(ELEVENLABS_KEY),
        _ => None,
    }
}

/// Says `text` through `service` with `voice` at `speed`: mono samples and their rate.
pub async fn synthesize(service: &str, voice: &str, text: &str, speed: f32) -> Result<(Vec<f32>, u32), String> {
    let name = key_name(service).ok_or_else(|| format!("Unknown voice service {service}"))?;
    let key = crate::secrets::get_secret(name)?.filter(|k| !k.trim().is_empty()).ok_or("SPEECH_NO_KEY")?;
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let (request, rate) = match service {
        "openai" => (
            http.post("https://api.openai.com/v1/audio/speech").bearer_auth(key.trim()).json(&json!({
                "model": "gpt-4o-mini-tts",
                "input": text,
                "voice": if voice.trim().is_empty() { OPENAI_DEFAULT_VOICE } else { voice.trim() },
                "response_format": "pcm",
                "speed": speed.clamp(0.5, 2.0),
            })),
            24_000,
        ),
        _ => {
            let voice = if voice.trim().is_empty() { ELEVENLABS_DEFAULT_VOICE } else { voice.trim() };
            (
                http.post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=pcm_22050"))
                    .header("xi-api-key", key.trim())
                    .json(&json!({
                        "text": text,
                        "model_id": "eleven_multilingual_v2",
                        // ElevenLabs takes 0.7–1.2.
                        "voice_settings": { "speed": speed.clamp(0.7, 1.2) },
                    })),
                22_050,
            )
        }
    };
    let response = request.send().await.map_err(|e| format!("Could not reach the voice service: {e}"))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        return Err(format!("The voice service answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body)));
    }
    Ok((super::wav::from_pcm16(&bytes), rate))
}
