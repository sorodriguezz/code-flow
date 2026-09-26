import { useState } from "react";
import { Check } from "lucide-react";
import { AiGlyph } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { FloatingAiWindow } from "../ai/FloatingAiWindow";
import { notesWriteWithAi } from "../../lib/tauri/notesCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useNotesStore } from "../../state/notesStore";
import { notify } from "../../state/notificationStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";

/** The routing row this runs under — `AiTask::Notes` on the Rust side. */
const TASK = "notes";

/**
 * Asks an engine for Markdown to put in the note.
 *
 * **A floating window over the editor, not a modal** — `FloatingAiWindow`, which the wiki's
 * "generate" shares. The instruction is written *about* the text underneath it — "expand this
 * section", "turn the list below into a table" — so the editor stays live and in view behind it.
 *
 * **The engine is picked on the `notes` row.** It once had its own provider/model selects and a
 * choice remembered per workspace — which made notes the one feature whose model lived somewhere
 * other than Settings → AI → model per task. It routes through the `notes` task like everything
 * else, and the chip in this window writes that same row (`ChatModelPicker`): a second door to the
 * one setting, not a second setting.
 *
 * What comes back is inserted, never auto-saved over anything: with a selection it replaces it,
 * without one it lands at the caret. Either way it is one Monaco edit, so **Ctrl+Z takes it back
 * out** — which is the only thing that makes a generate button safe to press on a document you
 * care about.
 *
 * **The run itself does not live here.** It lives in `notesStore.aiByNote`, keyed by note, because
 * this window is the shortest-lived thing in the feature: it unmounts when the note is closed, when
 * the view is switched to preview-only, when the workspace changes — and the model keeps working
 * through all three. What that buys is visible from here: reopening a note that is still writing
 * shows it writing, with the Stop button back; and an answer that arrived while the user was
 * somewhere else is offered rather than lost. `insertAi` (`NoteEditor`) is the other half — it
 * refuses to write into whatever note happens to be open, which is what makes parking necessary in
 * the first place.
 */
export function NoteAiPanel({
  selection,
  onInsert,
  onClose,
}: {
  /** The editor's selection when the window opened, or `""`. Shown so the user knows what will be
   *  replaced — taken then rather than read on submit, because focus is in here by now. */
  selection: string;
  /**
   * Puts the Markdown in the note — **if** the editor is still on that note, in that workspace.
   *
   * The note and the workspace are arguments rather than something the editor reads for itself,
   * because by the time this is called they are history: the caller captured them before the run
   * started, and the whole question is whether the screen still agrees. `false` is "it did not
   * land", and the answer is parked rather than dropped.
   */
  onInsert: (noteId: string, workspaceId: string, markdown: string) => boolean;
  onClose: () => void;
}) {
  const draft = useNotesStore((s) => s.draft);
  /** This note's run, if it has one — running, or holding an answer nobody could insert yet. Read
   *  from the store rather than held here, so it survives this window being closed. */
  const run = useNotesStore((s) => (s.draft ? s.aiByNote[s.draft.id] : undefined));
  const t = useT();

  const [instruction, setInstruction] = useState("");
  const busy = run?.status === "running";
  /** The Markdown waiting to be put in, or `null`. An empty answer never gets here — see `submit`. */
  const parked = run?.status === "ready" && run.markdown ? run.markdown : null;

  const submit = async () => {
    if (!instruction.trim() || busy || parked || !draft) return;
    const id = newRunId("note-ai");
    // Everything the run needs, captured before the first `await`. The panel closes on its own way
    // out, the workspace can change under it, and the note can be swapped for another — so a run
    // that outlives the screen it was started from has to be able to name, on its own, both the
    // note it is writing and the workspace that note lives in. Reading either of them afterwards
    // reads the answer to a different question: "where is the user now".
    const note = { id: draft.id, title: draft.title, content: draft.content };
    const workspaceId = useNotesStore.getState().workspaceId;
    // No workspace means no note could be open, so this is unreachable in practice; it is here
    // because the run's home is a `string` and inventing one would be exactly the guess this whole
    // change exists to delete.
    if (!workspaceId) return;
    // The store owns the run from here. `false` is another generation already writing this same
    // note, or the workspace having moved on between the click and this line.
    if (!useNotesStore.getState().beginAi(note.id, id, workspaceId)) return;
    // The `target` is the note itself, so the status-bar row is not merely labelled with where the
    // run lives but is a way back into it — across a workspace switch, which is the only case in
    // which anyone needs it. It used to be omitted on the grounds that the user is looking at the
    // note while it works; they are, right up until they aren't, and that is the moment the row
    // exists for.
    useAiRunStore.getState().start(id, {
      kindKey: "notes.ai.runKind",
      detail: note.title,
      target: { view: "notes", select: { kind: "note", id: note.id } },
      workspaceId,
    });
    try {
      const markdown = await notesWriteWithAi({
        title: note.title,
        content: note.content,
        selection,
        instruction: instruction.trim(),
        runId: id,
        workspaceId,
      });
      const written = markdown.trim().length > 0;
      // The insert proves its own identity — see `onInsert`. When it refuses, the text is kept
      // against the note it was written for instead of being thrown at whatever is on screen: that
      // wrong write, at another note's caret and autosaved a moment later, is the defect this
      // whole path was rebuilt around.
      const landed = written && onInsert(note.id, workspaceId, markdown);
      if (landed) {
        useNotesStore.getState().clearAi(note.id, id);
        onClose();
      } else if (written) {
        useNotesStore.getState().parkAi(note.id, id, markdown);
      } else {
        // The engine answered with nothing. There is nothing to insert and nothing worth keeping,
        // so the run just ends — and the window closes only if it is still this note's window.
        // Closing is a write to the screen like any other: a run that came back after the user
        // moved on must not shut the window the *next* note has open.
        useNotesStore.getState().clearAi(note.id, id);
        if (useNotesStore.getState().draft?.id === note.id) onClose();
      }
      // The panel may be gone by the time this lands and the note itself is a document with no
      // "new" marker on it, so without this a generation the user walked away from arrives with
      // nothing anywhere to say it did. Only when there was something to insert: an empty answer
      // changed no note, and "note written" for it would be a row that lies — which is also why a
      // parked answer gets its own title rather than borrowing the one that claims it was written.
      if (written) {
        notify({
          source: "notes",
          titleKey: landed ? "notifications.noteWritten" : "notifications.noteReady",
          target: { view: "notes", select: { kind: "note", id: note.id } },
          status: "success",
          detail: note.title,
          workspaceId,
        });
      }
    } catch (error) {
      // Stopping it yourself is not a failure worth a red toast — nor an entry left behind saying
      // something went wrong, when what happened is that you pressed Stop.
      if (isCancellation(error)) {
        useNotesStore.getState().clearAi(note.id, id);
      } else {
        useNotesStore.getState().failAi(note.id, id, String(error));
        // A toast belongs to the workspace the reader is standing in. A red banner thrown over
        // workspace B about a note in workspace A is an interruption nobody can act on; the
        // notification — filed under A, and clickable back into it — is the right channel for a run
        // the user has walked away from, and the failure is waiting on the note itself when they
        // return. Compared against this store's own workspace rather than a live read of the active
        // one, because they are the same value and this one cannot be half-way through a switch.
        if (useNotesStore.getState().workspaceId === workspaceId) pushErrorToast(String(error));
        notify({
          source: "notes",
          titleKey: "notifications.noteWriteFailed",
          target: { view: "notes", select: { kind: "note", id: note.id } },
          status: "error",
          detail: note.title,
          workspaceId,
        });
      }
    } finally {
      useAiRunStore.getState().finish(id);
    }
  };

  /** Puts a parked answer in, now that the note it was written for is open again. */
  const insertParked = () => {
    if (!run || !parked || !draft) return;
    if (!onInsert(draft.id, run.workspaceId, parked)) return;
    useNotesStore.getState().clearAi(draft.id, run.runId);
    onClose();
  };

  return (
    <FloatingAiWindow
      title={selection.trim() ? t("notes.ai.titleReplace") : t("notes.ai.titleWrite")}
      // While it runs there is one thing left to do here, and it is on the footer: Stop.
      closable={!busy}
      onClose={onClose}
      footer={
        busy ? (
          <>
            {/* While it runs there is exactly one thing left to do — stop it — so that is the only
                button. The two it replaces were both dead in this state: a greyed "Cancel" and a
                greyed "Writing…" read as a form waiting on you rather than an engine working. */}
            {run && (
              <button
                type="button"
                onClick={() => void useAiRunStore.getState().cancel(run.runId)}
                className="mr-auto rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-danger)]"
              >
                {t("notes.ai.stop")}
              </button>
            )}
            {/* The orb, not a spinner, and on the panel's own surface rather than inside a filled
                button: it is the app's mark for *an engine burning context* — the same one the
                agent console, the run log and the SQL console show — and a rotating ring is what
                every "loading" in every app looks like. Its colours are tuned against a surface;
                40%-opacity white-on-accent, which is what the disabled button gave it, is where it
                went to die. */}
            <span className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)]">
              <ThinkingOrb size="sm" />
              {t("notes.ai.writing")}
            </span>
          </>
        ) : parked ? (
          <>
            {/* Discard is a real button and not a ✕, because it is the only way this text stops
                being offered — closing the window keeps it, deliberately: a generation you walked
                away from should still be there the next time you open the note, and "I shut the
                window" is not "throw it away". */}
            <button
              type="button"
              onClick={() => {
                if (run && draft) useNotesStore.getState().clearAi(draft.id, run.runId);
              }}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-danger)]"
            >
              {t("notes.ai.discard")}
            </button>
            <button
              type="button"
              onClick={insertParked}
              // The same promise the Write button makes, and it still holds: this is one Monaco
              // edit at the caret, so one undo takes it back out.
              title={t("notes.ai.undoHint")}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <Check size={11} />
              {t("notes.ai.insert")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              {t("notes.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!instruction.trim()}
              // The "one undo takes it back out" promise, as a tooltip rather than a paragraph: it
              // is reassurance about the button, and the window is small enough that a third of it
              // should not be spent on text you read once.
              title={t("notes.ai.undoHint")}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <AiGlyph size={11} onFill />
              {t("notes.ai.write")}
            </button>
          </>
        )
      }
    >
      {/* An answer that finished while this note was not on screen. Shown as itself rather than
          as a status line, because the question it asks — "is this the thing you wanted?" — is
          one nobody can answer from a label. */}
      {parked && (
        <div>
          <span className="mb-1 block text-[10.5px] font-medium text-[var(--cf-accent)]">
            {t("notes.ai.ready")}
          </span>
          <pre className="max-h-16 overflow-hidden rounded-md border border-[color-mix(in_oklab,var(--cf-accent)_35%,transparent)] bg-[var(--cf-field)] px-2 py-1 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
            {parked.slice(0, 240)}
            {parked.length > 240 ? "…" : ""}
          </pre>
        </div>
      )}

      {/* The failure, on the note it happened to. The toast said this too, but the toast was
          shown wherever the user was standing and is long gone by the time they come back here. */}
      {run?.status === "failed" && run.error && (
        <p className="rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] px-2 py-1 text-[10.5px] leading-snug text-[var(--cf-danger)]">
          <span className="font-medium">{t("notifications.noteWriteFailed")}</span>
          <span className="mt-0.5 block break-words opacity-80">{run.error}</span>
        </p>
      )}

      {selection.trim() && (
        <div>
          <span className="mb-1 block text-[10.5px] font-medium text-[var(--cf-text-muted)]">
            {t("notes.ai.willReplace")}
          </span>
          {/* Two lines of it, so "replace this" names something the user can recognise without
              the window turning into a second editor. */}
          <pre className="max-h-12 overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
            {selection.slice(0, 160)}
            {selection.length > 160 ? "…" : ""}
          </pre>
        </div>
      )}

      <textarea
        // Only when the window was opened by the user. Reopening a note that has a run of its own
        // opens it too — and stealing the caret out of the note somebody just went back to, to
        // put it in a field they did not ask for, is how the diagram panel earned its complaint.
        // A *failed* run is not one of those: `NoteEditor` never reopens the window for one, so
        // if it is on screen over a failure the user opened it themselves, and this field is what
        // they came for.
        autoFocus={!run || run.status === "failed"}
        // An answer is waiting: writing the next instruction is not the thing to do, and leaving
        // the field live would leave Cmd+Enter as a key that does nothing at all.
        disabled={parked !== null}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={(event) => {
          // Enter alone is a newline: the instruction is prose and often two sentences.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        rows={3}
        aria-label={t("notes.ai.instruction")}
        placeholder={t("notes.ai.instructionPlaceholder")}
        className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
      />

      {/* The chat's model menu on the `notes` row — the one Settings shows as "Write in a note" —
          so what is picked here is what Settings says, and the other way round. */}
      <ChatModelPicker task={TASK} liveModel={null} chatActive={false} />
    </FloatingAiWindow>
  );
}
