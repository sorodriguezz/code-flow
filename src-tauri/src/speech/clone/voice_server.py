# CodeFlow's voice-cloning server (`speech::clone`): one engine, loaded once, answering one JSON
# request per line on stdin with one JSON line on stdout. Started with `python -I voice_server.py
# <engine>` inside the engine's own venv; the app reads `{"ready": ...}` before it sends anything.
#
#   {"op": "say", "text": "...", "lang": "es", "ref": "/path/ref.wav", "out": "/path/out.wav"}
#     -> {"ok": true, "ms": 812, "rate": 24000}  |  {"ok": false, "error": "..."}
#   {"op": "ping"} -> {"ok": true}
#
# Nothing else is printed on stdout: the libraries' own chatter goes to stderr, which the app logs.
import contextlib
import json
import os
import sys
import time


def answer(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def device_for(engine):
    import torch

    if torch.cuda.is_available():
        return "cuda"
    # XTTS has operators the Apple GPU does not run; Chatterbox does, with the fallback on.
    if engine == "chatterbox" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load(engine, device):
    with contextlib.redirect_stdout(sys.stderr):
        if engine == "chatterbox":
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            return ChatterboxMultilingualTTS.from_pretrained(device=device)
        from TTS.api import TTS

        return TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)


def say(engine, model, request):
    with contextlib.redirect_stdout(sys.stderr):
        if engine == "chatterbox":
            import torchaudio

            wav = model.generate(request["text"], language_id=request.get("lang") or "es", audio_prompt_path=request["ref"])
            torchaudio.save(request["out"], wav.detach().cpu(), model.sr)
            return model.sr
        model.tts_to_file(text=request["text"], speaker_wav=request["ref"], language=request.get("lang") or "es", file_path=request["out"])
        return 24000


def main():
    engine = sys.argv[1] if len(sys.argv) > 1 else "chatterbox"
    started = time.time()
    try:
        device = device_for(engine)
        model = load(engine, device)
    except Exception as error:  # noqa: BLE001 — the app shows the reason
        answer({"ready": False, "error": f"{type(error).__name__}: {error}"[:800]})
        return
    answer({"ready": True, "device": device, "ms": int((time.time() - started) * 1000)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            answer({"ok": False, "error": "not JSON"})
            continue
        if request.get("op") == "ping":
            answer({"ok": True})
            continue
        if request.get("op") != "say":
            answer({"ok": False, "error": "unknown op"})
            continue
        try:
            begun = time.time()
            rate = say(engine, model, request)
            answer({"ok": True, "ms": int((time.time() - begun) * 1000), "rate": rate})
        except Exception as error:  # noqa: BLE001
            answer({"ok": False, "error": f"{type(error).__name__}: {error}"[:800]})


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    main()
