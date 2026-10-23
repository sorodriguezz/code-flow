import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useLanguageStore, translate } from "../../../state/languageStore";
import { CodiError, type CodiAction } from "../registry";
import { literal } from "../vocabulary";
import { appOnScreen, defineAction, oneOf, optionalText, outOfSight, params, pickByName, say, showAppHere, showParam, spokenList, text, waitFor } from "./shared";

/**
 * Notas — and Reuniones, which record into a note.
 *
 * Every one runs where Notes lives (`where: "app:notes"`): the island holding it, or the main window
 * when there is none — and the bus hands a request on itself if Notes left after the catalogue was
 * registered. The store is imported when an action runs, not with the catalogue: it is the size of
 * the app, and most sessions never ask Codi for a note.
 *
 * Writing a note and recording a meeting are work: out of sight (Settings › Codi › «Trabajar en
 * segundo plano», or «sin abrir») Notas does not come on screen — the note is written, or the
 * recording started, and said. An island holding Notes shows it either way.
 */

async function notes() {
  const module = await import("../../../state/notesStore");
  await module.ensureNotesStoreLoaded();
  return module.useNotesStore;
}

/** The note's title when none is given: its first line, shortened — what a person would call it. */
function titleFrom(body: string): string {
  const first = body.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  if (!first) return translate("notes.untitled");
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

export const notesCreate = defineAction({
  id: "notes.create",
  title: {
    en: "Write a new note in Notes (Markdown), in this workspace's default notebook.",
    es: "Escribe una nota nueva en Notas (Markdown), en la libreta por defecto del workspace.",
  },
  aliases: { es: ["toma nota", "toma una nota", "anota", "apunta", "crea una nota", "nueva nota", "escribe una nota", "guarda una nota"], en: ["take a note", "note down", "new note", "create a note", "write a note", "make a note"] },
  params: params({ title: optionalText("The note's title. Left out: its first line."), text: text("The note's body, Markdown."), show: showParam }, ["text"]),
  risk: "write",
  where: "app:notes",
  frequent: true,
  run: async ({ title, text: body, show }) => {
    if (!useWorkspaceStore.getState().activeWorkspaceId) throw new CodiError("no workspace is selected", say("codi.say.noWorkspace"));
    // On screen, the note is shown as it is made; an island holding Notes already shows it.
    if (!(await outOfSight(show))) showAppHere("notes");
    const { ensureNotesStoreLoaded, useNotesStore } = await import("../../../state/notesStore");
    await ensureNotesStoreLoaded();
    const id = await useNotesStore.getState().createNote(null);
    if (!id) throw new CodiError("the note could not be created", say("codi.say.noteFailed"));
    const name = title ? String(title) : titleFrom(String(body));
    useNotesStore.getState().editDraft({ title: name, content: String(body) });
    await useNotesStore.getState().flush({ interactive: false });
    return { result: { note: name }, say: say("codi.say.noteCreated", { name }) };
  },
});

/** Opens the note `id` and waits for its body — `openNote` resolves before a linked file is read. */
async function openAndWait(id: string): Promise<void> {
  const store = await notes();
  await store.getState().openNote(id);
  await waitFor(() => store.getState().draft?.id === id, 4000);
}

export function notesActions(): CodiAction[] {
  return [
    notesCreate,
    defineAction({
      id: "notes.search",
      title: {
        en: "Search this workspace's notes by title, tag and body text. Returns titles to open with notes.open.",
        es: "Busca en las notas del workspace por título, etiqueta y texto. Devuelve títulos para abrir con notes.open.",
      },
      aliases: {
        es: ["busca en las notas", "busca la nota", "buscar notas", "tengo una nota sobre", "en que nota"],
        en: ["search the notes", "search notes", "find the note", "find a note about", "which note"],
      },
      params: params({ query: text("Words to look for.") }, ["query"]),
      risk: "read",
      where: "app:notes",
      run: async ({ query }) => {
        if (!useWorkspaceStore.getState().activeWorkspaceId) throw new CodiError("no workspace is selected", say("codi.say.noWorkspace"));
        const store = await notes();
        const { notesSearch } = await import("../../tauri/notesCommands");
        const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
        const { notes: all, workspaceId } = store.getState();
        const byTitle = all.filter((n) => {
          const hay = `${n.title} ${n.tags.join(" ")}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        const hits = workspaceId ? await notesSearch(workspaceId, String(query)).catch(() => []) : [];
        const seen = new Set(byTitle.map((n) => n.id));
        const byBody = hits
          .filter((hit) => !seen.has(hit.id))
          .map((hit) => ({ note: all.find((n) => n.id === hit.id), snippet: hit.snippet }))
          .filter((entry) => entry.note);
        const found = [
          ...byTitle.map((n) => ({ title: n.title, ...(n.excerpt ? { excerpt: n.excerpt.slice(0, 80) } : {}) })),
          ...byBody.map((entry) => ({ title: entry.note!.title, snippet: entry.snippet.slice(0, 80) })),
        ].slice(0, 12);
        return {
          result: { notes: found, total: byTitle.length + byBody.length },
          say: found.length
            ? say("codi.say.notesFound", { list: spokenList(found.map((n) => n.title), 3) })
            : say("codi.say.noNotesFound", { name: String(query) }),
        };
      },
    }),
    defineAction({
      id: "notes.open",
      title: {
        en: "Open a note by its title (loose match).",
        es: "Abre una nota por su título (coincidencia flexible).",
      },
      aliases: {
        es: ["abre la nota", "muestra la nota", "ve a la nota", "abre mi nota", "busca y abre la nota"],
        en: ["open the note", "show the note", "go to the note", "open my note"],
      },
      params: params({ title: text("The note's title, as said.") }, ["title"]),
      risk: "navigate",
      where: "app:notes",
      frequent: true,
      run: async ({ title }) => {
        showAppHere("notes");
        const store = await notes();
        const note = pickByName(store.getState().notes, String(title), (n) => n.title, "note", (n) => n.pinned);
        await openAndWait(note.id);
        return { result: { note: note.title }, say: say("codi.say.noteOpened", { name: note.title }) };
      },
    }),
    defineAction({
      id: "notes.append",
      title: {
        en: "Add text to the end of a note — the one open, or one named by title.",
        es: "Añade texto al final de una nota: la abierta, o una nombrada por su título.",
      },
      aliases: {
        es: ["agrega a la nota", "anade a la nota", "anade", "agrega", "apunta en la nota", "suma a la nota", "escribe en la nota"],
        en: ["add to the note", "append to the note", "append", "add this to the note", "write in the note"],
      },
      params: params({ title: optionalText("The note's title. Left out: the note that is open."), text: text("What to add, Markdown."), show: showParam }, ["text"]),
      risk: "write",
      where: "app:notes",
      run: async ({ title, text: addition, show }) => {
        if (!(await outOfSight(show))) showAppHere("notes");
        const store = await notes();
        if (title) {
          const note = pickByName(store.getState().notes, String(title), (n) => n.title, "note", (n) => n.pinned);
          await openAndWait(note.id);
        }
        const draft = store.getState().draft;
        if (!draft) throw new CodiError("no note is open — name one (title) or open it first", say("codi.say.noNoteOpen"));
        const body = draft.content.trimEnd();
        store.getState().editDraft({ content: body ? `${body}

${String(addition)}
` : `${String(addition)}
` });
        await store.getState().flush({ interactive: false });
        return { result: { note: draft.title, appended: String(addition).length }, say: say("codi.say.noteAppended", { name: draft.title }) };
      },
    }),
    ...meetingActions(),
  ];
}

/** The two kinds of recording the meeting bar offers. */
const MEETING_KINDS = literal({
  virtual: { es: ["virtual", "llamada", "videollamada", "zoom", "meet", "teams", "en linea"], en: ["virtual", "call", "video call", "zoom", "meet", "teams", "online"] },
  room: { es: ["presencial", "sala", "en persona", "en la sala"], en: ["in person", "room", "in the room", "in-person"] },
});

function meetingActions(): CodiAction[] {
  return [
    defineAction({
      id: "meeting.start",
      title: {
        en: "Start recording a meeting into the note that is open (a new meeting note when none is) — virtual: the call's audio too; room: the microphone only.",
        es: "Empieza a grabar una reunión en la nota abierta (una nota de reunión nueva si no hay ninguna). virtual: también el audio de la llamada; room: solo el micrófono.",
      },
      aliases: {
        es: ["graba la reunion", "empieza a grabar", "toma notas de la reunion", "inicia la reunion", "graba esta reunion", "empieza la grabacion"],
        en: ["record the meeting", "start recording", "take meeting notes", "start the meeting", "record this meeting"],
      },
      get vocabulary() {
        return { kind: MEETING_KINDS };
      },
      params: params({ kind: oneOf(["virtual", "room"], "virtual (a call — the default) or room (in person)."), show: showParam }),
      risk: "write",
      where: "app:notes",
      run: async ({ kind, show }) => {
        const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
        if (!workspaceId) throw new CodiError("no workspace is selected", say("codi.say.noWorkspace"));
        // Out of sight, «the note that is open» is one Notes left open some time ago, not one in front
        // of the user: the meeting gets a note of its own instead.
        const quiet = await outOfSight(show);
        const intoOpenNote = !quiet || appOnScreen("notes");
        if (!quiet) showAppHere("notes");
        const { useMeetingsStore } = await import("../../../state/meetingsStore");
        const meetings = useMeetingsStore.getState();
        await meetings.refreshStatus();
        if (useMeetingsStore.getState().status?.recording) {
          throw new CodiError("a meeting is already being recorded", say("codi.say.meetingAlreadyRecording"));
        }
        const store = await notes();
        const noteId = intoOpenNote ? store.getState().activeId : null;
        if (!noteId) {
          // No note open: one of its own in the meetings book, the way «Tomar notas» on a call makes it.
          const { takeNotesHere } = await import("../../../components/notes/meetings/MeetingSuggestion");
          await takeNotesHere("Codi", { show: !quiet });
          await useMeetingsStore.getState().refreshStatus();
          if (!useMeetingsStore.getState().status?.recording) throw new CodiError("the recording did not start", say("codi.say.meetingFailed"));
          return { result: { recording: true, note: store.getState().draft?.title ?? null }, say: say("codi.say.meetingStarted") };
        }
        // What the meeting bar's start strip sends: the kind, the mode the settings chose, the app's
        // language as the spoken one.
        const language = useLanguageStore.getState().language === "en" ? "en" : "es";
        const ok = await meetings.start({
          noteId,
          workspaceId,
          kind: kind === "room" ? "room" : "virtual",
          mode: meetings.settings.mode || undefined,
          language,
        });
        if (!ok) throw new CodiError("the recording did not start", say("codi.say.meetingFailed"));
        return { result: { recording: true, note: store.getState().draft?.title ?? null }, say: say("codi.say.meetingStarted") };
      },
    }),
    defineAction({
      id: "meeting.stop",
      title: { en: "Stop the meeting being recorded; its transcript is made as usual.", es: "Detiene la reunión que se está grabando; su transcripción se hace como siempre." },
      aliases: {
        es: ["deten la grabacion", "para de grabar", "termina la reunion", "deja de grabar", "corta la grabacion"],
        en: ["stop recording", "stop the meeting", "end the meeting", "stop the recording"],
      },
      params: params(),
      risk: "write",
      where: "app:notes",
      run: async () => {
        const { useMeetingsStore } = await import("../../../state/meetingsStore");
        await useMeetingsStore.getState().refreshStatus();
        const recording = useMeetingsStore.getState().status?.recording;
        if (!recording) return { result: { recording: false }, say: say("codi.say.meetingNotRecording") };
        await useMeetingsStore.getState().stop(recording.meetingId);
        return { result: { stopped: recording.meetingId, minutes: Math.round(recording.elapsedMs / 60000) }, say: say("codi.say.meetingStopped") };
      },
    }),
    defineAction({
      id: "meeting.status",
      title: { en: "Whether a meeting is being recorded (and for how long), and what is still being transcribed.", es: "Si se está grabando una reunión (y desde hace cuánto) y qué falta por transcribir." },
      aliases: {
        es: ["estoy grabando", "se esta grabando", "estado de la reunion", "cuanto llevo grabando"],
        en: ["am i recording", "is it recording", "meeting status", "how long have i been recording"],
      },
      params: params(),
      risk: "read",
      where: "app:notes",
      run: async () => {
        const { useMeetingsStore } = await import("../../../state/meetingsStore");
        await useMeetingsStore.getState().refreshStatus();
        const status = useMeetingsStore.getState().status;
        const recording = status?.recording ?? null;
        const minutes = recording ? Math.max(0, Math.round(recording.elapsedMs / 60000)) : 0;
        return {
          result: {
            recording: recording ? { minutes, paused: recording.paused || undefined } : null,
            transcribing: status?.processing ? true : undefined,
            queued: status?.queued.length || undefined,
          },
          say: recording ? say("codi.say.meetingRecording", { n: minutes }) : say("codi.say.meetingNotRecording"),
        };
      },
    }),
  ];
}
