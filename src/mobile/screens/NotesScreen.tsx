import { useCallback, useEffect, useMemo, useState } from "react";
import { BookText, FilePlus2, Link2, Pencil, Pin, PinOff, Search, X } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { onInvalidate } from "../invalidate";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { PushBar } from "../ui/AppBar";
import { BottomBar } from "../ui/BottomBar";
import { RootBar } from "../ui/RootBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import { Markdown } from "../ui/Markdown";
import type { NoteBookRow, NoteMetaRow, NoteRow } from "../../types/notes";

/**
 * Notes, from a phone: read them, search them, jot one, fix one.
 *
 * A note is the thing most worth having away from the desk — the decision from Tuesday's meeting,
 * the command that fixes the staging database — and the thing most worth being able to write there,
 * because the thought arrives on the train.
 *
 * # What is here and what is not
 *
 * The list, the search (titles as you type, bodies from the desk), one note rendered, and three
 * writes: a new note, an edit, a pin. No deleting, no moving between books, no templates, no
 * versions, no graph, no AI — the desk's Notes is an app for arranging a body of writing, and this
 * is for reading and adding to it.
 *
 * Two rules protect what is written at the desk. A save names the version it was editing, and is
 * refused if the note changed since — the draft stays, the note is reloaded. And a note that
 * mirrors a file in a repository is read-only here: saving one writes the file, checked against
 * the copy on disk, which a phone has never read.
 */

interface Tree {
  notes: NoteMetaRow[];
  books: NoteBookRow[];
}

interface SearchHit {
  id: string;
  snippet: string;
}

/** A book's name with the books it sits inside: `Reuniones › Noviembre 2026`. */
function bookPath(books: NoteBookRow[], id: string | null): string {
  const names: string[] = [];
  let at = books.find((book) => book.id === id);
  // Bounded, because the parent chain comes from another process's table and a loop in it must not
  // become one here.
  for (let depth = 0; at && depth < 8; depth++) {
    names.unshift(at.name);
    at = books.find((book) => book.id === at?.parent_id);
  }
  return names.join(" › ");
}

/** The Notes tab. */
export function NotesScreen() {
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const readOnly = useMobileStore((s) => s.readOnly);
  const push = useNav((s) => s.push);
  const [tree, setTree] = useState<Tree | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [bookId, setBookId] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setTree({ notes: [], books: [] });
      setState("ready");
      return;
    }
    try {
      setTree(await rpc<Tree>("notes_phone_tree", { workspaceId }));
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [workspaceId]);

  useEffect(() => {
    setState("loading");
    setBookId("");
    void load();
  }, [load]);

  // A note written somewhere else — an agent, a flow, this phone's own save a screen deeper.
  useEffect(() => onInvalidate("notes", null, () => void load()), [load]);

  // Bodies are searched at the desk: the list here carries titles and excerpts, never content.
  // Debounced, from three characters — a two-letter query matches most of a notebook.
  const needle = query.trim();
  useEffect(() => {
    if (!workspaceId || needle.length < 3) {
      setHits([]);
      return;
    }
    let alive = true;
    const id = window.setTimeout(() => {
      void rpc<SearchHit[]>("notes_search", { workspaceId, query: needle })
        .then((found) => alive && setHits(found))
        .catch(() => alive && setHits([]));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [workspaceId, needle]);

  const books = tree?.books ?? [];
  const shown = useMemo(() => {
    const notes = tree?.notes ?? [];
    const lower = needle.toLowerCase();
    const body = new Map(hits.map((hit) => [hit.id, hit.snippet]));
    return notes
      .filter((note) => !bookId || note.book_id === bookId)
      .filter(
        (note) =>
          !lower ||
          note.title.toLowerCase().includes(lower) ||
          note.tags.toLowerCase().includes(lower) ||
          note.excerpt.toLowerCase().includes(lower) ||
          body.has(note.id),
      )
      .map((note) => ({ note, snippet: body.get(note.id) ?? "" }))
      .sort((a, b) => Number(b.note.pinned) - Number(a.note.pinned) || b.note.updated_at.localeCompare(a.note.updated_at));
  }, [tree, needle, bookId, hits]);

  // Where a new note goes: the book being looked at, or the one written in most recently.
  const targetBook = bookId || tree?.notes.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.book_id || books[0]?.id || "";

  return (
    <Screen
      onRefresh={() => load()}
      bar={
        <RootBar
          title={t("nav.notes")}
          actions={
            !readOnly && targetBook && workspaceId ? (
              <IconButton
                icon={<FilePlus2 size={18} />}
                label={t("notes.new")}
                onClick={() => {
                  navigated();
                  push({ k: "note", workspaceId, id: "", bookId: targetBook, title: t("notes.new") });
                }}
              />
            ) : undefined
          }
          below={
            <div className="space-y-2 px-3 pb-2">
              <label className="flex items-center gap-2 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3">
                <Search size={15} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("notes.search")}
                  aria-label={t("notes.search")}
                  className="min-h-[2.5rem] min-w-0 flex-1 bg-transparent outline-none"
                />
                {query && <IconButton icon={<X size={15} />} label={t("common.dismiss")} onClick={() => setQuery("")} />}
              </label>
              {books.length > 1 && (
                <select
                  value={bookId}
                  onChange={(e) => setBookId(e.target.value)}
                  aria-label={t("notes.book")}
                  className="w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none"
                >
                  <option value="">{t("notes.allBooks")}</option>
                  {books
                    .map((book) => ({ id: book.id, path: bookPath(books, book.id) }))
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map((book) => (
                      <option key={book.id} value={book.id}>
                        {book.path}
                      </option>
                    ))}
                </select>
              )}
            </div>
          }
        />
      }
    >
      {state === "loading" ? (
        <Section>
          <SkeletonList rows={5} />
        </Section>
      ) : state === "error" ? (
        <ErrorState title={t("notes.failed")} detail={failure} onRetry={() => void load()} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<BookText size={26} aria-hidden />}
          title={needle || bookId ? t("notes.noMatch") : t("notes.none")}
          hint={needle || bookId ? undefined : t("notes.noneHint")}
        />
      ) : (
        <Section>
          <Card>
            {shown.map(({ note, snippet }, index) => (
              <div key={note.id}>
                {index > 0 && <Divider />}
                <Row
                  leading={
                    note.pinned ? (
                      <Pin size={14} className="text-[var(--cf-accent-text)]" aria-hidden />
                    ) : note.origin_path ? (
                      <Link2 size={14} className="text-[var(--cf-text-muted)]" aria-hidden />
                    ) : undefined
                  }
                  title={note.title || t("notes.untitled")}
                  subtitle={[snippet || note.excerpt, bookId ? "" : bookPath(books, note.book_id), sinceIso(note.updated_at)].filter(Boolean).join(" · ")}
                  onClick={() => {
                    navigated();
                    push({ k: "note", workspaceId: workspaceId ?? "", id: note.id, bookId: note.book_id ?? "", title: note.title || t("notes.untitled") });
                  }}
                />
              </div>
            ))}
          </Card>
        </Section>
      )}
    </Screen>
  );
}

/** What the desk answers when a note cannot be saved, as the sentence each one is. Must match the
 *  `NOTE_*` codes in `remotectl/dispatch.rs`. */
function saveFailure(e: unknown): Error {
  const code = e instanceof Error ? e.message : String(e);
  if (code === "note_moved") return new Error(t("notes.moved"));
  if (code === "note_linked") return new Error(t("notes.linked"));
  if (code === "note_gone") return new Error(t("notes.gone"));
  return e instanceof Error ? e : new Error(code);
}

/**
 * One note: read, and — on request — edited.
 *
 * Reading is the default and editing is a mode, because the two want opposite things from a phone
 * screen: reading wants rendered headings and lists and no keyboard, writing wants the source and
 * the keyboard up. An `id` of `""` is a note that does not exist yet, which starts in the editor.
 */
export function NoteScreen({ workspaceId, id, bookId, title }: { workspaceId: string; id: string; bookId: string; title: string }) {
  const run = useMobileStore((s) => s.run);
  const readOnly = useMobileStore((s) => s.readOnly);
  const busy = useBusy("notes");
  const replace = useNav((s) => s.replace);
  const fresh = id === "";
  /** What a new note's draft is filed under: its book, since it has no id yet. */
  const draftKey = fresh ? `new:${bookId}` : id;
  const [note, setNote] = useState<NoteRow | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">(fresh ? "ready" : "loading");
  const [failure, setFailure] = useState<string | null>(null);
  // A draft left from last time reopens the editor on it: the words somebody typed before the
  // phone locked are the reason the draft is kept at all.
  const [editing, setEditing] = useState(() => fresh || readDraft("noteBody", draftKey) !== "");
  const [draftTitle, setDraftTitle] = useState(() => readDraft("noteTitle", draftKey));
  const [draftBody, setDraftBody] = useState(() => readDraft("noteBody", draftKey));

  const load = useCallback(async () => {
    if (fresh) return;
    try {
      const row = await rpc<NoteRow | null>("notes_get_note", { id });
      if (!row) {
        setState("gone");
        return;
      }
      setNote(row);
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [fresh, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Changed elsewhere while it is being *read*. While it is being edited the note on screen is the
  // draft, and the save's own precondition is what catches the conflict.
  useEffect(
    () =>
      onInvalidate("notes", null, (detail) => {
        if (!editing && (!detail.note || detail.note === id)) void load();
      }),
    [editing, id, load],
  );

  const linked = Boolean(note?.origin_path);
  const startEditing = () => {
    if (!note) return;
    setDraftTitle(note.title);
    setDraftBody(note.content);
    setEditing(true);
  };
  const stopEditing = () => {
    clearDraft("noteTitle", draftKey);
    clearDraft("noteBody", draftKey);
    setEditing(false);
  };

  const save = () =>
    void run(
      async () => {
        const heading = draftTitle.trim() || t("notes.untitled");
        try {
          if (fresh) {
            const made = await rpc<NoteMetaRow>("notes_create_note", { workspaceId, bookId, title: heading, content: draftBody });
            stopEditing();
            // The new note takes the form's place, so going back leaves both rather than returning
            // to a form that would write a second copy.
            replace({ k: "note", workspaceId, id: made.id, bookId, title: made.title });
            return;
          }
          const meta = await rpc<NoteMetaRow | null>("notes_save_note", {
            id,
            title: heading,
            content: draftBody,
            // The version this edit started from: the desk refuses when the note changed since.
            baseUpdatedAt: note?.updated_at ?? "",
          });
          if (!meta) throw new Error("note_gone");
          setNote({ ...(note as NoteRow), ...meta, content: draftBody });
          stopEditing();
        } catch (e) {
          throw saveFailure(e);
        }
      },
      "notes",
      t("toast.noteSaved"),
    );

  const togglePin = () => {
    if (!note) return;
    const pinned = !note.pinned;
    void run(
      async () => {
        await rpc("notes_set_pinned", { id, pinned });
        setNote({ ...note, pinned });
      },
      "notes",
    );
  };

  const heading = editing ? (fresh ? t("notes.new") : t("notes.editing")) : note?.title || title;
  const bar = (
    <PushBar
      title={heading}
      actions={
        !editing && note && !readOnly ? (
          <span className="flex items-center">
            <IconButton icon={note.pinned ? <PinOff size={17} /> : <Pin size={17} />} label={t(note.pinned ? "notes.unpin" : "notes.pin")} disabled={busy} onClick={togglePin} />
            {!linked && <IconButton icon={<Pencil size={17} />} label={t("notes.edit")} onClick={startEditing} />}
          </span>
        ) : undefined
      }
    />
  );

  if (state === "loading") {
    return (
      <Screen bar={bar}>
        <Section>
          <SkeletonList rows={5} />
        </Section>
      </Screen>
    );
  }
  if (state === "gone") {
    return (
      <Screen bar={bar}>
        <EmptyState icon={<BookText size={26} aria-hidden />} title={t("notes.gone")} />
      </Screen>
    );
  }
  if (state === "error") {
    return (
      <Screen bar={bar}>
        <ErrorState title={t("notes.readFailed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }

  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--cf-bg)]">
        {bar}
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3">
          <input
            value={draftTitle}
            onChange={(e) => {
              setDraftTitle(e.target.value);
              writeDraft("noteTitle", draftKey, e.target.value);
            }}
            placeholder={t("notes.titlePlaceholder")}
            aria-label={t("notes.titlePlaceholder")}
            className="shrink-0 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 text-md font-medium outline-none focus:border-[var(--cf-accent)]"
          />
          <textarea
            value={draftBody}
            onChange={(e) => {
              setDraftBody(e.target.value);
              writeDraft("noteBody", draftKey, e.target.value);
            }}
            placeholder={t("notes.bodyPlaceholder")}
            aria-label={t("notes.bodyPlaceholder")}
            // The source, in the type it is written in: Markdown's marks are characters, and a
            // proportional face hides how many spaces indent a list.
            className="cf-scroll mb-3 min-h-0 flex-1 resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 font-mono text-base leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
        <BottomBar className="flex gap-2 p-2">
          {!fresh && (
            <Button full disabled={busy} onClick={stopEditing}>
              {t("common.cancel")}
            </Button>
          )}
          <Button full variant="primary" loading={busy} disabled={busy || (fresh && draftBody.trim() === "" && draftTitle.trim() === "")} onClick={save}>
            {t("notes.save")}
          </Button>
        </BottomBar>
      </div>
    );
  }

  return (
    <Screen bar={bar} onRefresh={() => load()}>
      {linked && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 text-xs text-[var(--cf-text-muted)]">
          <Link2 size={14} className="mt-px shrink-0" aria-hidden />
          <span>
            {t("notes.linkedHint")} <span className="font-mono">{note?.origin_path}</span>
          </span>
        </p>
      )}
      <Card padded className="mt-3">
        {note && note.content.trim() !== "" ? (
          <Markdown text={note.content} />
        ) : (
          <p className="text-base text-[var(--cf-text-muted)]">{t("notes.emptyBody")}</p>
        )}
      </Card>
      {note && (
        <p className="mt-2 px-1 text-xs text-[var(--cf-text-muted)]">
          {[note.tags, t("notes.words", { n: note.word_count }), sinceIso(note.updated_at)].filter(Boolean).join(" · ")}
        </p>
      )}
    </Screen>
  );
}
