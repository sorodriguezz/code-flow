# CodeFlow's natural-voice server for calls (`speech::pocket`): Pocket TTS, loaded once, answering
# one JSON request per line on stdin with one JSON line on stdout. Started with
# `python -I pocket_server.py <voices dir>` inside the engine's own venv; the app reads
# `{"ready": ...}` before it sends anything.
#
#   {"op": "say", "text": "...", "lang": "es", "voice": "lola", "out": "/path/out.wav"}
#     -> {"ok": true, "ms": 412, "rate": 24000}  |  {"ok": false, "error": "..."}
#   {"op": "warm", "lang": "es", "voices": ["lola", ...]}  -> {"ok": true, "ms": 3100}
#   {"op": "ping"} -> {"ok": true}
#
# One model per language, loaded the first time it is asked for; one state per voice and language,
# kept in memory and written beside the weights so the next start reads it instead of making it.
# Nothing else is printed on stdout: the libraries' own chatter goes to stderr.
import contextlib
import json
import os
import sys
import time
import wave

MODELS = {"es": "spanish", "en": "english"}
models = {}
states = {}


def answer(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def model_for(lang):
    name = MODELS.get(lang, "english")
    if name not in models:
        from pocket_tts import TTSModel

        models[name] = TTSModel.load_model(language=name)
    return name, models[name]


def state_for(store, name, model, voice):
    key = (name, voice)
    if key not in states:
        saved = os.path.join(store, f"{name}-{voice}.safetensors")
        if os.path.isfile(saved):
            states[key] = model.get_state_for_audio_prompt(saved)
        else:
            states[key] = model.get_state_for_audio_prompt(voice)
            try:
                from pocket_tts import export_model_state

                os.makedirs(store, exist_ok=True)
                export_model_state(states[key], saved)
            except Exception:  # noqa: BLE001 — it is only a shortcut for the next start
                pass
    return states[key]


def say(store, request):
    import torch

    name, model = model_for(request.get("lang") or "es")
    state = state_for(store, name, model, request["voice"])
    audio = model.generate_audio(state, request["text"])
    pcm = (audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
    with wave.open(request["out"], "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(model.sample_rate)
        out.writeframes(pcm)
    return model.sample_rate


def main():
    store = sys.argv[1] if len(sys.argv) > 1 else "."
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import pocket_tts  # noqa: F401 — proves the install before anything is asked
    except Exception as error:  # noqa: BLE001 — the app shows the reason
        answer({"ready": False, "error": f"{type(error).__name__}: {error}"[:800]})
        return
    answer({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            answer({"ok": False, "error": "not JSON"})
            continue
        op = request.get("op")
        if op == "ping":
            answer({"ok": True})
            continue
        try:
            begun = time.time()
            with contextlib.redirect_stdout(sys.stderr):
                if op == "say":
                    rate = say(store, request)
                elif op == "warm":
                    name, model = model_for(request.get("lang") or "es")
                    for voice in request.get("voices") or []:
                        state_for(store, name, model, voice)
                    rate = model.sample_rate
                else:
                    answer({"ok": False, "error": "unknown op"})
                    continue
            answer({"ok": True, "ms": int((time.time() - begun) * 1000), "rate": rate})
        except Exception as error:  # noqa: BLE001
            answer({"ok": False, "error": f"{type(error).__name__}: {error}"[:800]})


if __name__ == "__main__":
    main()
