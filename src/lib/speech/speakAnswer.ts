/**
 * An AI answer handed to the reading aloud, as «Lectura en voz alta › Respuestas de la IA» says.
 *
 * Imported lazily: the chat stores are below `speechStore` in the import graph (it reads the
 * meetings and dictation stores, which reach back into them), so a static import here would be a
 * cycle. By the time an answer lands, the store has long been loaded by the status bar.
 */
export function speakAnswer(markdown: string, workspaceId: string | null): void {
  void import("../../state/speechStore")
    .then(({ useSpeechStore }) => useSpeechStore.getState().speakAnswer(markdown, workspaceId))
    .catch(() => {});
}

/** Text the user asked to hear right now — a message's «Leer en voz alta», a selection. */
export function speakNow(text: string, origin: "message" | "selection"): void {
  void import("../../state/speechStore")
    .then(({ useSpeechStore }) => useSpeechStore.getState().say(text, origin, { interrupt: true }))
    .catch(() => {});
}
