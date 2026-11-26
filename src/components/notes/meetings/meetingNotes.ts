import { useMeetingsStore } from "../../../state/meetingsStore";
import { useNotesStore } from "../../../state/notesStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useLanguageStore, translate } from "../../../state/languageStore";
import { meetingsHome } from "../../../lib/notes/filing";
import { builtInTemplates, fillTemplate } from "../../../lib/notes/templates";
import { freshLines, mergePreparation, type PrepLabels } from "../../../lib/notes/prepMerge";
import { notesGetNote, notesPrepareMeeting, notesSaveNote } from "../../../lib/tauri/notesCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../../state/aiRunStore";
import { pushErrorToast, useToastStore } from "../../../state/toastStore";

/**
 * The notes a meeting starts from: one that is recording the moment it exists («Reunión ahora», and
 * the card the call detector raises), and one written before it («Preparar reunión»).
 *
 * Both are filed the same way — in the book the workspace's meetings already live in, whatever it is
 * called, inside that month's book (`lib/notes/filing`) — so a meeting and what was prepared for it
 * sit together and a year of them is twelve books.
 */

/** This month's book inside the workspace's meetings book; both made when missing. */
async function meetingsBookNow(): Promise<string | null> {
  const notes = useNotesStore.getState();
  const home =
    meetingsHome(notes.books, notes.notes, useMeetingsStore.getState().notesWith, translate("meetings.bookName"))?.id ??
    (await notes.createBook(null, translate("meetings.bookName")));
  if (!home) return null;
  return (await useNotesStore.getState().monthBook(home)) ?? home;
}

/** The open workspace with its notes loaded in this window, or `null` with none open. */
async function workspaceNotes(): Promise<string | null> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId) return null;
  const notes = useNotesStore.getState();
  if (notes.workspaceId !== workspaceId) await notes.setWorkspace(workspaceId);
  return workspaceId;
}

/** A new note titled `title`, open, and recording a meeting of `kind` into it. */
export async function startMeetingNote(title: string, kind: "virtual" | "room"): Promise<void> {
  const workspaceId = await workspaceNotes();
  if (!workspaceId) return;
  const book = await meetingsBookNow();
  if (!book) return;
  const noteId = await useNotesStore.getState().createNote(book);
  if (!noteId) return;
  useNotesStore.getState().editDraft({ title });
  void useNotesStore.getState().flush();
  const language = useLanguageStore.getState().language === "en" ? "en" : "es";
  await useMeetingsStore.getState().start({ noteId, workspaceId, kind, language });
}

/** «Reunión ahora»: the note is named by when it started. */
export function startMeetingNow(kind: "virtual" | "room"): Promise<void> {
  const when = new Date().toLocaleString(useLanguageStore.getState().language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return startMeetingNote(translate("notes.meetingNowTitle", { when }), kind);
}

/**
 * «Preparar reunión»: a note about `topic` with what to settle before walking in — the goal, the
 * questions, the decisions needed. The meeting is then recorded from that same note, so what was
 * asked and what was answered end up on one page.
 */
export async function prepareMeetingNote(topic: string): Promise<void> {
  const subject = topic.trim();
  if (!subject || !(await workspaceNotes())) return;
  const template = builtInTemplates().find((candidate) => candidate.id === "builtin:prep");
  const book = await meetingsBookNow();
  if (!template || !book) return;
  const title = translate("notes.prepTitle", { topic: subject });
  // The template's own heading is its name and the date; here the note is about something.
  const body = fillTemplate(template.content, subject).replace(/^#\s+.*$/m, `# ${title}`);
  const noteId = await useNotesStore.getState().createNote(book, { ...template, name: title, content: body });
  // And what the earlier notes and meetings say about it goes in while the person reads the page.
  if (noteId) void proposeFromEarlier(noteId, subject);
}

/** The tag a preparation carries — what the note's menu offers «Proponer preguntas…» by. */
export const PREP_TAG = "preparacion";

/** The subject of a preparation, read back off its title («Preparación — tema»). */
export function prepTopic(title: string): string {
  const lead = translate("notes.prepTitle", { topic: "" }).trim();
  const clean = title.trim();
  return (lead && clean.startsWith(lead) ? clean.slice(lead.length) : clean).trim();
}

const prepLabels = (): PrepLabels => ({
  known: translate("notes.prep.known"),
  questions: translate("notes.prep.questions"),
  decisions: translate("notes.prep.decisions"),
  risks: translate("notes.prep.risks"),
  sources: translate("notes.prep.sources"),
});

/** Runs under way, by note: a second one on the same note waits for the first. */
const proposing = new Set<string>();

/**
 * Fills a preparation from what was already written: the earlier notes and meetings that speak of
 * `topic` are read by a model (`notes_prepare_meeting`) and what it proposes — what is known, what
 * to ask, what to get decided, what is at risk — goes under the note's own headings, each line with
 * the note it came from. Nothing the person wrote is replaced. With no earlier note on the subject
 * no model is asked.
 */
export async function proposeFromEarlier(noteId: string, topic: string): Promise<void> {
  const workspaceId = useNotesStore.getState().workspaceId;
  const subject = topic.trim();
  if (!workspaceId || !subject || proposing.has(noteId)) return;
  proposing.add(noteId);
  const toast = useToastStore.getState().pushToast;
  const runId = newRunId("note-prep");
  useAiRunStore.getState().start(runId, {
    kindKey: "notes.prep.runKind",
    detail: subject,
    target: { view: "notes", select: { kind: "note", id: noteId } },
    workspaceId,
  });
  toast(translate("notes.prep.looking", { topic: subject }), "info");
  try {
    // What was typed so far is what the model must not repeat.
    await useNotesStore.getState().flush();
    const language = useLanguageStore.getState().language.startsWith("en") ? "English" : "español";
    const result = await notesPrepareMeeting({ noteId, topic: subject, language, runId, workspaceId });
    if (result.nothing) {
      toast(translate("notes.prep.nothing", { topic: subject }), "info");
      return;
    }
    const merge = (content: string) => mergePreparation(content, result.proposal, result.sources, prepLabels());
    const open = useNotesStore.getState();
    let added: number;
    if (open.workspaceId === workspaceId && open.draft?.id === noteId) {
      // The note on screen: into its draft, over whatever was typed while the model read.
      added = freshLines(open.draft.content, result.proposal);
      if (added > 0) open.editDraft({ content: merge(open.draft.content) });
    } else {
      // Left meanwhile: written where it is kept, and the store told it changed.
      const row = await notesGetNote(noteId);
      if (!row) return;
      added = freshLines(row.content, result.proposal);
      if (added > 0) {
        await notesSaveNote(noteId, row.title, merge(row.content), row.tags);
        if (useNotesStore.getState().workspaceId === workspaceId) await useNotesStore.getState().noteChangedElsewhere(noteId);
      }
    }
    const cited = new Set([...result.proposal.known, ...result.proposal.questions, ...result.proposal.decisions, ...result.proposal.risks].map((line) => line.from).filter(Boolean)).size;
    if (added === 0) toast(translate("notes.prep.empty", { topic: subject }), "info");
    else toast(cited === 1 ? translate("notes.prep.doneOne") : translate("notes.prep.done", { count: Math.max(cited, 1) }), "success");
  } catch (error) {
    if (!isCancellation(error)) {
      const text = String(error);
      pushErrorToast(text.includes("MEETINGS_LOCAL_UNAVAILABLE") ? translate("meetings.ai.localUnavailable") : text);
    }
  } finally {
    useAiRunStore.getState().finish(runId);
    proposing.delete(noteId);
  }
}
