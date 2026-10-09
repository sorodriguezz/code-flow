import {
  dictationRecordCancel,
  dictationRecordFinish,
  dictationRecordStart,
  onDictationLevel,
  onDictationLimit,
} from "../tauri/dictationCommands";

/**
 * The microphone, as the dictation store drives it.
 *
 * Read natively (`dictation::capture` — CoreAudio, WASAPI), **not** with `getUserMedia`: the
 * webview answered that with its own browser-style prompt ("… wants to use your microphone"), and
 * could not name the inputs until the prompt was answered, so Settings could not offer a choice.
 * The audio stays in the backend — it is downsampled to 16 kHz there and transcribed in place. What
 * reaches this side is the level, for the waveform, and the text.
 *
 * A recording is named by an id minted here, so the level events can be matched to it before the
 * backend has even answered the start: the listeners are attached first.
 */

export interface Recording {
  /** Releases the microphone and transcribes what was heard. `language`: a code, or `"auto"`. */
  finish: (modelId: string, language: string) => Promise<string>;
  /** Releases the microphone and drops the audio. */
  cancel: () => void;
}

/** `device`: an input's id, `""` for the system's default. `onLimit` fires once, when the backend
 *  has held its longest recording (five minutes). */
export async function startRecording(device: string, onLevel: (level: number) => void, onLimit: () => void): Promise<Recording> {
  const session = crypto.randomUUID();
  const unlisten = await Promise.all([
    onDictationLevel((event) => {
      if (event.session === session) onLevel(event.level);
    }),
    onDictationLimit((limited) => {
      if (limited === session) onLimit();
    }),
  ]);
  let settled = false;
  const release = () => {
    settled = true;
    unlisten.forEach((stop) => stop());
  };
  try {
    await dictationRecordStart(session, device);
  } catch (error) {
    release();
    throw error;
  }
  return {
    finish: (modelId, language) => {
      release();
      return dictationRecordFinish(session, modelId, language);
    },
    cancel: () => {
      if (settled) return;
      release();
      void dictationRecordCancel(session).catch(() => {});
    },
  };
}
