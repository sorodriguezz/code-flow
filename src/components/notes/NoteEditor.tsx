import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileText,
  GitBranch,
  LayoutTemplate,
  ListTree,
  MoreHorizontal,
  PenLine,
  Pin,
  PinOff,
  Trash2,
  X,
  History as HistoryIcon,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { NotePreview } from "./NotePreview";
import { ResizeHandle } from "../common/ResizeHandle";
import { NoteToolbar } from "./NoteToolbar";
import { NoteBacklinks } from "./NoteBacklinks";
import { VersionHistoryModal } from "../common/VersionHistoryModal";
import { Segmented } from "../common/Segmented";
import {
  notesClearVersions,
  notesDeleteVersion,
  notesListVersions,
  notesVersionContent,
} from "../../lib/tauri/notesCommands";
import { NoteOutline } from "./NoteOutline";
import { NoteTagBar } from "./NoteTagBar";
import { SaveTemplateModal } from "./SaveTemplateModal";
import { NoteAiPanel } from "./NoteAiPanel";
import { MeetingButton, MeetingSection } from "./meetings/MeetingSection";
import { noteRepoItems } from "./noteRepoItems";
import { ICON_BUTTON, readingMinutes, relativeTime } from "./notesChrome";
import type { NoteMonacoHandle } from "./NoteMonaco";
import type { MarkdownTool } from "../../lib/notes/markdownTools";
import { outlineOf } from "../../lib/notes/outline";
import { bookPath } from "../../lib/notes/tree";
import { exportNotes, type NoteExportFormat } from "../../lib/notes/exportActions";
import { isLinkedNote, type Note, type NoteViewMode } from "../../types/notes";
import { describePath } from "../../lib/editorFiles";
import { useNotesStore } from "../../state/notesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { scrollBehavior } from "../../lib/motion";

/**
 * Monaco is behind `lazy` so that a workspace opened on its gallery never fetches it. It is the
 * largest chunk in the app, and it is not needed until a note is actually opened. Declared at
 * module scope, not inside the component, or every render would create a new lazy component and
 * remount the editor — which for Monaco means losing the undo stack and the scroll position.
 */
const NoteMonaco = lazy(() => import("./NoteMonaco").then((m) => ({ default: m.NoteMonaco })));

/**
 * The open note: header, toolbar, editor, preview, outline, status bar.
 *
 * **The performance decision that matters here is `useDeferredValue`.** The preview re-parses the
 * whole document through `marked` + DOMPurify, and the outline rescans it; doing either
 * synchronously on every keystroke is what makes a Markdown editor feel like it is chewing gum on
 * a long note. React 19's deferred value lets the keystroke commit at once and the expensive
 * derivations catch up in a lower-priority render — so the caret never waits for the preview, and
 * a fast typist simply skips the intermediate ones.
 *
 * The second one is that the *draft* lives in the store while the *row* stays untouched until the
 * autosave fires. A keystroke updates one small object rather than an array of four hundred notes.
 * See `notesStore`.
 */
export function NoteEditor() {
  const draft = useNotesStore((s) => s.draft);
  const notes = useNotesStore((s) => s.notes);
  const books = useNotesStore((s) => s.books);
  const viewMode = useNotesStore((s) => s.viewMode);
  const outlineOpen = useNotesStore((s) => s.outlineOpen);
  /** The version-history dialog. Local state: nothing outside this editor opens it. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const saving = useNotesStore((s) => s.saving);
  const savedAt = useNotesStore((s) => s.savedAt);
  /** The open note's AI run, if it has one. A stable object reference, so this costs nothing on the
   *  keystrokes that already re-render this component. */
  const noteRun = useNotesStore((s) => (s.draft ? s.aiByNote[s.draft.id] : undefined));
  const workspaceId = useNotesStore((s) => s.workspaceId);

  const editDraft = useNotesStore((s) => s.editDraft);
  const setViewMode = useNotesStore((s) => s.setViewMode);
  const toggleOutline = useNotesStore((s) => s.toggleOutline);
  const togglePinned = useNotesStore((s) => s.togglePinned);
  const duplicateNote = useNotesStore((s) => s.duplicateNote);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const openNote = useNotesStore((s) => s.openNote);
  const closeNote = useNotesStore((s) => s.closeNote);

  const outlineWidth = useLayoutStore((s) => s.sizes.notesOutlineWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const monaco = useRef<NoteMonacoHandle>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [templating, setTemplating] = useState(false);
  /** The selection captured when the AI window opened, `null` when it is closed. Taken then rather
   *  than read on submit, because focus moves into the window and Monaco's selection is gone by the
   *  time it is used. */
  const [aiSelection, setAiSelection] = useState<string | null>(null);
  const [caretHeadingLine, setCaretHeadingLine] = useState(0);
  /** The title as it was when the field took focus — what a rename is measured against when the
   *  field is left. A ref: it is read on blur and nothing renders from it. */
  const titleAtFocus = useRef<string | null>(null);

  const note = draft ? notes.find((n) => n.id === draft.id) ?? null : null;
  const content = draft?.content ?? "";

  // The expensive derivations run against the *deferred* text. See the component's doc comment —
  // this single hook is what keeps typing on a long note at keystroke speed.
  const settled = useDeferredValue(content);
  const headings = useMemo(() => outlineOf(settled), [settled]);
  const words = useMemo(() => settled.split(/\s+/).filter(Boolean).length, [settled]);
  const breadcrumb = useMemo(
    () => bookPath(books, note?.book_id ?? null),
    [books, note?.book_id],
  );

  // Set only when the caret crosses into a different heading's section, not on every cursor move:
  // Monaco fires that event for each arrow key, and re-rendering this component per keypress is
  // exactly the cost the deferred value above exists to avoid paying.
  const onCursorLine = useCallback(
    (line: number) => {
      // Monaco counts lines from 1; `Heading.line` counts from 0. Converted here, once, so what
      // reaches `NoteOutline` is in the same space as the headings it compares against — the two
      // being one apart is invisible until the caret lands exactly on a heading, and then the rail
      // marks the section *below* the one you are in.
      const zeroBased = line - 1;
      let boundary = 0;
      for (const heading of headings) {
        if (heading.line <= zeroBased) boundary = heading.line;
        else break;
      }
      setCaretHeadingLine((previous) => (previous === boundary ? previous : boundary));
    },
    [headings],
  );

  // An image file pasted or dropped into the editor. Notes are Markdown in a database with no
  // blob store beside it, so a picture can only be referenced by URL — and saying that once, at
  // the moment someone tries, is worth more than any amount of documentation nobody reads.
  const onImageRejected = useCallback(() => {
    useToastStore.getState().pushToast(t("notes.imageUrlsOnly"), "info");
  }, [t]);

  // Stable identities, because `NoteToolbar` is memoised and this component re-renders on every
  // keystroke — an inline arrow would re-render seventeen buttons per character typed.
  const applyTool = useCallback((tool: MarkdownTool) => monaco.current?.apply(tool), []);
  // A toggle, not an open: the button stays pressed while the window is up, and pressing it again
  // is the same gesture as closing it. Re-reading the selection on that second press would replace
  // the captured one with "" — focus is in the window by then, not in Monaco.
  const toggleAi = useCallback(
    () => setAiSelection((current) => (current === null ? (monaco.current?.selectedText() ?? "") : null)),
    [],
  );
  const closeAi = useCallback(() => {
    // A failure the user has now read is not offered again — it would otherwise sit in the map
    // until the note was next generated on, and reopening the note would reintroduce a red box
    // about something that went wrong an hour ago. A parked *answer* is left alone: closing this
    // window is not the same gesture as throwing the text away, and the window has its own Discard
    // button for that.
    const state = useNotesStore.getState();
    const id = state.draft?.id;
    const run = id ? state.aiByNote[id] : undefined;
    if (id && run?.status === "failed") state.clearAi(id, run.runId);
    setAiSelection(null);
  }, []);

  /**
   * Puts generated Markdown into the note it was generated for — or refuses, and says so.
   *
   * **The refusal is the entire function.** This used to be a bare
   * `monaco.current?.replaceSelection(markdown)`, and every part of that sentence was a hazard:
   * `monaco.current` is the *live* editor, and this view deliberately never remounts it between
   * notes (see `NotesView`), so a run started on note X that landed after the user clicked note Y
   * wrote X's paragraphs into Y — at Y's caret, marking Y dirty, and eight hundred milliseconds
   * later autosaving it — while the notification cheerfully pointed at X. The cross-workspace
   * version was quieter and no better: the editor is unmounted, `monaco.current` is null, and the
   * generation simply evaporated.
   *
   * So the run's own note and workspace, captured before it started, are compared against what the
   * store says is open *now*. `false` means the caller must park the text rather than write it.
   */
  const insertAi = useCallback((noteId: string, workspaceId: string, markdown: string) => {
    const state = useNotesStore.getState();
    if (state.workspaceId !== workspaceId || state.draft?.id !== noteId) return false;
    const editor = monaco.current;
    if (!editor) return false;
    editor.replaceSelection(markdown);
    return true;
  }, []);

  /**
   * A meeting's AI writing into its note: at the end, as one Monaco edit so ⌘Z takes it back. With
   * the editor hidden (preview only) it goes into the draft directly — still saved, just not
   * undoable. `false` when the note on screen is no longer the one asked about.
   */
  const appendFromMeeting = useCallback((noteId: string, markdown: string) => {
    const state = useNotesStore.getState();
    if (state.draft?.id !== noteId) return false;
    const editor = monaco.current;
    if (editor && state.viewMode !== "preview") {
      editor.appendText(markdown);
      return true;
    }
    const current = state.draft.content.trimEnd();
    state.editDraft({ content: current ? `${current}\n\n${markdown}` : markdown });
    return true;
  }, []);

  // Scrolling the editor scrolls the preview, one way only. Two-way sync is a feedback loop that
  // needs a suppression flag and still stutters where the two panes' heights disagree — and the
  // question a split view answers is "what does what I am writing look like", which is the editor
  // leading.
  const onScroll = useCallback((ratio: number) => {
    const pane = previewPane.current;
    if (!pane) return;
    const travel = pane.scrollHeight - pane.clientHeight;
    if (travel > 0) pane.scrollTop = ratio * travel;
  }, []);

  // The editor is not remounted between notes (see `NotesView`), so the preview keeps whatever
  // scroll the previous note left it at — which on a short note means opening it half way down a
  // document that has already ended. Monaco restores its own view state per model; this is the
  // preview's half of the same job.
  useEffect(() => {
    if (previewPane.current) previewPane.current.scrollTop = 0;
    setCaretHeadingLine(0);
    // The AI window holds the selection it was opened over. That selection belongs to the note that
    // was on screen, so it goes with it rather than being carried into the next one. The effect
    // below reopens the window — with no selection — when the arriving note has a run of its own.
    setAiSelection(null);
  }, [draft?.id]);

  /**
   * A note that is still writing, or that is holding an answer nobody could insert while the user
   * was elsewhere, comes back with its AI window up.
   *
   * This is what makes a run re-attachable, and it is not a convenience. The Stop button lives in
   * that window and is the only one in the app — `AgentActivity` lists the run but offers no
   * cancel — so before this, closing a note mid-generation orphaned the run for good. And a parked
   * answer would otherwise be a notification pointing at a note that showed no sign of having one.
   *
   * `current ?? ""` rather than a plain open, so a window the user already has up keeps the
   * selection it captured. Empty is the right value for the reopened case: the selection it was
   * started over belongs to an editing session that has ended, and a parked insert goes to the
   * caret. A *failure* is deliberately not reopened — it has already been toasted and filed, and
   * popping a window over the note to say so again is noise.
   */
  useEffect(() => {
    if (noteRun && noteRun.status !== "failed") setAiSelection((current) => current ?? "");
  }, [noteRun]);

  // Preview-only has no editor for the AI window to float over — and nothing for it to write into.
  // Closing it there rather than hiding it means coming back doesn't restore a window whose typed
  // instruction went with the unmounted component anyway.
  useEffect(() => {
    if (viewMode === "preview") setAiSelection(null);
  }, [viewMode]);

  // Ctrl/Cmd-S writes now rather than waiting out the debounce. The note is already being saved
  // continuously, so this is not what makes the data safe — it is what lets someone who has typed
  // Ctrl-S at the end of every paragraph for twenty years keep doing it and be told it worked.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void useNotesStore.getState().flush();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!draft || !note) return null;

  const showEditor = viewMode !== "preview";
  const showPreview = viewMode !== "editor";

  // The *draft*, not the row: what is on screen is what the user means by "this note", and
  // exporting the last saved version would silently drop the sentence they just typed.
  const exportAs = (format: NoteExportFormat) =>
    void exportNotes(
      format,
      [{ id: draft.id, title: draft.title, content: draft.content }],
      draft.title || t("notes.untitled"),
    );

  const MODES: { mode: NoteViewMode; icon: typeof PenLine; labelKey: Parameters<typeof t>[0] }[] = [
    { mode: "editor", icon: PenLine, labelKey: "notes.modeEditor" },
    { mode: "split", icon: Columns2, labelKey: "notes.modeSplit" },
    { mode: "preview", icon: Eye, labelKey: "notes.modePreview" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------- header ---------- */}
      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 pb-2 pt-2">
        <div className="flex items-center gap-1">
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 text-[11px] text-[var(--cf-text-muted)]"
            aria-label={t("notes.location")}
          >
            {breadcrumb.length === 0 ? (
              <span className="truncate">{t("notes.root")}</span>
            ) : (
              breadcrumb.map((book, index) => (
                <span key={book.id} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight size={10} className="shrink-0 opacity-60" />}
                  <span className="truncate">{book.name}</span>
                </span>
              ))
            )}
          </nav>

          {/* The app's segmented control, icon-only: the three are views of the same note, and the
              names are on the tooltips. */}
          <Segmented
            size="sm"
            layoutId="cf-note-view-mode"
            value={viewMode}
            onChange={setViewMode}
            options={MODES.map(({ mode, icon, labelKey }) => ({ value: mode, icon, title: t(labelKey) }))}
          />

          <MeetingButton noteId={note.id} />

          <button
            type="button"
            onClick={toggleOutline}
            aria-pressed={outlineOpen}
            title={t("notes.outline")}
            aria-label={t("notes.outline")}
            className={`${ICON_BUTTON} ${outlineOpen ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : ""}`}
          >
            <ListTree size={13} />
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            title={t("versions.open")}
            aria-label={t("versions.open")}
            className={ICON_BUTTON}
          >
            <HistoryIcon size={13} />
          </button>

          <button
            type="button"
            onClick={() => void togglePinned(note.id)}
            title={note.pinned ? t("notes.unpin") : t("notes.pin")}
            aria-label={note.pinned ? t("notes.unpin") : t("notes.pin")}
            className={`${ICON_BUTTON} ${note.pinned ? "text-[var(--cf-accent)]" : ""}`}
          >
            {note.pinned ? <Pin size={13} fill="currentColor" /> : <Pin size={13} />}
          </button>

          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t("notes.moreActions")}
            onClick={(event) =>
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  {
                    label: note.pinned ? t("notes.unpin") : t("notes.pin"),
                    icon: note.pinned ? PinOff : Pin,
                    onClick: () => void togglePinned(note.id),
                  },
                  {
                    label: t("notes.duplicate"),
                    icon: Copy,
                    onClick: () => {
                      void duplicateNote(note.id).then((id) => id && void openNote(id));
                    },
                  },
                  {
                    label: t("notes.saveAsTemplate"),
                    icon: LayoutTemplate,
                    onClick: () => setTemplating(true),
                  },
                  ...noteRepoItems(note.id),
                  {
                    label: t("notes.exportMarkdown"),
                    icon: Download,
                    separated: true,
                    onClick: () => exportAs("md"),
                  },
                  {
                    label: t("notes.exportHtml"),
                    icon: FileCode2,
                    onClick: () => exportAs("html"),
                  },
                  {
                    label: t("notes.exportPdf"),
                    icon: FileText,
                    onClick: () => exportAs("pdf"),
                  },
                  {
                    // No confirmation: it lands in the trash, which is where it is undone.
                    label: t("notes.moveToTrash"),
                    icon: Trash2,
                    danger: true,
                    separated: true,
                    onClick: () => void deleteNote(note.id),
                  },
                ],
              })
            }
          >
            <MoreHorizontal size={13} />
          </button>

          <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />

          {/* Leaving the note, not deleting it. `closeNote` flushes the draft before it drops it,
              so whatever was typed a second ago is written even if the autosave debounce had not
              fired yet — which is what makes this safe to press mid-sentence. */}
          <button
            type="button"
            onClick={() => void closeNote()}
            title={t("notes.closeNoteHint")}
            aria-label={t("notes.closeNote")}
            className={ICON_BUTTON}
          >
            <X size={14} />
          </button>
        </div>

        <input
          value={draft.title}
          onChange={(event) => editDraft({ title: event.target.value })}
          onFocus={() => {
            titleAtFocus.current = draft.title;
          }}
          // A rename is judged when the field is left, not per keystroke: "Ret", "Retr", "Retro" are
          // not three renames. The store asks, with the count, before rewriting any link.
          onBlur={(event) => {
            const before = titleAtFocus.current;
            titleAtFocus.current = null;
            if (before !== null) {
              void useNotesStore.getState().offerLinkRewrite(draft.id, before, event.target.value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder={t("notes.untitled")}
          aria-label={t("notes.noteTitle")}
          spellCheck={false}
          // Borderless and large: this is the document's title, not a form field, and a box around
          // it would make the header read as a settings panel over the writing.
          className="mt-1 w-full bg-transparent text-[17px] font-semibold text-[var(--cf-text)] outline-none placeholder:font-normal placeholder:italic placeholder:text-[var(--cf-text-muted)]"
        />

        <div className="mt-1.5">
          <NoteTagBar tags={draft.tags} onChange={(tags) => editDraft({ tags })} />
        </div>
      </div>

      {workspaceId && (
        <MeetingSection
          noteId={draft.id}
          workspaceId={workspaceId}
          noteTitle={draft.title}
          onInsert={appendFromMeeting}
        />
      )}

      {showEditor && (
        <NoteToolbar
          onApply={applyTool}
          onAi={toggleAi}
          aiOpen={aiSelection !== null}
          disabled={!showEditor}
        />
      )}

      {/* ---------- surfaces ---------- */}
      {/* `h-full` on both the row and the editor's own column, and it is load-bearing rather than
          belt-and-braces: Monaco's container is a chain of `height: 100%` elements, and a
          percentage height only resolves against an ancestor whose height is definite. `flex-1`
          alone gave the row a *used* height but left `height: auto` in the cascade, so the chain
          collapsed to nothing and Monaco initialised into a zero-height box — blank, and with no
          later resize to recover from. `EditorPane` has always wrapped its own editor in
          `<div className="flex h-full">` for exactly this reason. */}
      <div className="flex h-full min-h-0 flex-1">
        {showEditor && (
          // `relative`: the AI window is positioned against this column, so it floats over the
          // Markdown it is writing into and travels with the pane when the split is dragged.
          <div className={`relative h-full min-w-0 ${showPreview ? "flex-1" : "w-full"}`}>
            <Suspense fallback={<div className="h-full w-full bg-[var(--cf-surface)]" />}>
              <NoteMonaco
                handle={monaco}
                noteId={draft.id}
                value={draft.content}
                onChange={(next) => editDraft({ content: next })}
                onScroll={showPreview ? onScroll : undefined}
                onCursorLine={outlineOpen ? onCursorLine : undefined}
                onImageRejected={onImageRejected}
              />
            </Suspense>

            {aiSelection !== null && (
              <NoteAiPanel selection={aiSelection} onInsert={insertAi} onClose={closeAi} />
            )}
          </div>
        )}

        {showEditor && showPreview && (
          <div className="w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />
        )}

        {showPreview && (
          <div
            ref={previewPane}
            className={`min-w-0 overflow-y-auto px-6 py-4 ${showEditor ? "flex-1" : "w-full"}`}
          >
            {settled.trim() ? (
              // Memoised on `source`, and `source` is the deferred text — so the document is
              // parsed and re-highlighted once per settled edit rather than once per keystroke.
              <NotePreview source={settled} className="cf-markdown-preview mx-auto max-w-[760px]" />
            ) : (
              <p className="mx-auto max-w-[760px] text-[13px] italic text-[var(--cf-text-muted)]">
                {t("notes.previewEmpty")}
              </p>
            )}
          </div>
        )}

        {outlineOpen && (
          <>
            <ResizeHandle
              axis="x"
              value={outlineWidth}
              min={160}
              max={420}
              invert
              onChange={(value) => setSize("notesOutlineWidth", value)}
              onCommit={(value) => commitSize("notesOutlineWidth", value)}
            />
            <div
              style={{ width: outlineWidth }}
              className="flex shrink-0 flex-col border-l border-[var(--cf-border)]"
            >
              {/* The outline takes the room it needs and the backlinks take what is left, capped —
                  a note with forty headings must not push "what links here" off the bottom, and a
                  note with two must not leave two thirds of the rail empty above it. */}
              <div className="min-h-0 flex-1 overflow-hidden">
              <NoteOutline
                headings={headings}
                activeLine={caretHeadingLine}
                onSelect={(heading, index) => {
                  // In preview-only there is no editor to move the caret in, so the click scrolls
                  // the rendered document instead. By *index*, because `marked` emits no `id` on
                  // its headings — the rail's Nth row is the Nth heading element, which is the
                  // alignment `outlineOf` goes out of its way to preserve.
                  if (showEditor) {
                    monaco.current?.goToLine(heading.line + 1);
                    return;
                  }
                  previewPane.current
                    ?.querySelectorAll("h1, h2, h3, h4, h5, h6")
                    .item(index)
                    ?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
                }}
              />
              </div>
              {note && (
                <div className="max-h-[45%] min-h-[92px] shrink-0">
                  <NoteBacklinks noteId={note.id} title={note.title} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---------- status bar ---------- */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--cf-border)] px-3 text-[11px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">{t("notes.wordCount", { n: words })}</span>
        <span className="tabular-nums">{t("notes.charCount", { n: settled.length })}</span>
        <span className="tabular-nums">{t("notes.readingTime", { n: readingMinutes(words) })}</span>
        {note && isLinkedNote(note) && <LinkedFileChip note={note} />}
        <span className="ml-auto flex items-center gap-1.5">
          {saving ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cf-accent-fill)]" />
              {t("notes.saving")}
            </>
          ) : draft.dirty ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-warning)]" />
              {t("notes.unsaved")}
            </>
          ) : savedAt ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-success)]" />
              {t("notes.savedAt", { when: relativeTime(savedAt, language) })}
            </>
          ) : null}
        </span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {templating && <SaveTemplateModal onClose={() => setTemplating(false)} />}

      {historyOpen && note && (
        <VersionHistoryModal
          title={note.title || t("notes.untitled")}
          listVersions={() => notesListVersions(note.id)}
          readVersion={(versionId) => notesVersionContent(versionId)}
          deleteVersion={(versionId) => notesDeleteVersion(versionId)}
          clearVersions={() => notesClearVersions(note.id)}
          // Through the store's own save, not a direct command: the store is what keeps the open
          // buffer, the excerpt and the tree row in step, and writing behind it would leave the
          // editor showing the old text over the restored one.
          // Through the draft the editor already holds, then a flush: `editDraft` is what the
          // Monaco buffer, the excerpt and the tree row all read from, so writing behind it would
          // leave the editor showing the old text over the restored one. `flush` is what the
          // autosave calls, and it is what records the pre-restore text as a version on the way
          // past — which is what makes "I restored the wrong one" recoverable.
          onRestore={async (content) => {
            useNotesStore.getState().editDraft({ content });
            await useNotesStore.getState().flush();
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The status bar's word on a note that mirrors a file: which file, in which repository — and, when
 * something is wrong with the file, what. In the warning colour while its last save was refused
 * because the file moved on disk, or when the file could not be read when the note opened; the
 * refused save is a button then, which asks the question again (reload or overwrite) for someone
 * who cancelled it.
 */
function LinkedFileChip({ note }: { note: Note }) {
  const t = useT();
  const fileError = useNotesStore((s) => s.fileError);
  const conflicted = useNotesStore((s) => s.fileConflict === note.id);
  const reviewFileConflict = useNotesStore((s) => s.reviewFileConflict);
  // Any workspace's list: a global note is on this shelf with its home's repository.
  const repo = useWorkspaceStore(
    (s) =>
      Object.values(s.projectsByWorkspace)
        .flat()
        .find((project) => project.id === note.origin_project_id)?.name ?? "",
  );
  const path = note.origin_path;
  const title = conflicted
    ? t("editor.diskConflict", { name: describePath(path).name })
    : fileError
      ? t("repoSync.fileUnreadable", { path, error: fileError })
      : t("repoSync.linkedTo", { path, repo });
  const body = (
    <>
      <GitBranch size={11} className="shrink-0" aria-hidden />
      <span className="truncate font-mono">{path}</span>
    </>
  );
  const tone = conflicted || fileError ? "text-[var(--cf-warning)]" : "";
  return conflicted ? (
    <button
      type="button"
      onClick={() => void reviewFileConflict()}
      title={title}
      className={`flex min-w-0 items-center gap-1 hover:underline ${tone}`}
    >
      {body}
    </button>
  ) : (
    <span title={title} className={`flex min-w-0 items-center gap-1 ${tone}`}>
      {body}
    </span>
  );
}
