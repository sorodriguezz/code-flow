/**
 * The microphone, as whisper wants it: mono, 16 kHz, 16-bit.
 *
 * Captured in the webview (`getUserMedia`), not natively: WebKit and WebView2 both already speak to
 * the system's audio, ask for the permission, and pick the input the user chose in the OS. The
 * graph is a `ScriptProcessorNode` rather than an `AudioWorklet` — deprecated, but in every engine
 * this app runs on, and an AudioWorklet needs a module loaded by URL, which the production CSP would
 * have to be widened for. Each buffer is kept as it came and also measured (RMS) for the waveform;
 * the downsampling to 16 kHz happens once, on stop.
 */

/** Recordings stop by themselves here — about 10 MB of audio, and minutes of transcription. */
export const MAX_SECONDS = 300;
const TARGET_RATE = 16_000;

export interface Recording {
  /** The audio so far, as 16 kHz 16-bit PCM; the microphone is released. */
  stop: () => Int16Array;
  /** Releases the microphone and drops the audio. */
  cancel: () => void;
}

export async function startRecording(onLevel: (level: number) => void, onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const chunks: Float32Array[] = [];
  let length = 0;
  let limited = false;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    length += input.length;
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    onLevel(Math.sqrt(sum / input.length));
    if (!limited && length >= context.sampleRate * MAX_SECONDS) {
      limited = true;
      onLimit();
    }
  };
  // A processor only runs while it is connected through to the destination. It writes nothing to
  // its output buffer, so what reaches the speakers is silence.
  source.connect(processor);
  processor.connect(context.destination);
  const release = () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  return {
    stop: () => {
      release();
      return toPcm16(downsample(join(chunks, length), context.sampleRate, TARGET_RATE));
    },
    cancel: release,
  };
}

function join(chunks: Float32Array[], length: number): Float32Array {
  const all = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

/** Averages each output sample's span of input: a box filter is enough for speech, and keeps
 *  what lies above 8 kHz from folding back into the band whisper listens to. */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

/** Little-endian bytes, base64 — what `dictation_transcribe` reads. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  pcm.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  let text = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(text);
}
