import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, NoteFileVersion, NoteMetaRow, NoteSaved } from "../types/notes";

/**
 * The Notes store's write path, which had no tests: `flush` and the races it exists to win, the
 * quit guard's view of an unsaved note, and the trash / rename / import actions that sit on top.
 *
 * Every IPC call goes through one mocked `invoke`, so a test states what the backend answers and
 * then reads back what the store sent — the same arrangement `docsStore.test.ts` uses.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./aiRunStore", () => ({ useAiRunStore: { getState: () => ({ cancel: async () => {} }) } }));

const { useNotesStore } = await import("./notesStore");
const { useConfirmStore } = await import("./confirmStore");
const { collectUnsaved, saveAllUnsaved } = await import("../lib/unsavedWork");

const meta = (over: Partial<NoteMetaRow> = {}): NoteMetaRow => ({
  id: "n1",
  workspace_id: "w1",
  book_id: "b1",
  title: "Nota",
  excerpt: "",
  tags: "[]",
  pinned: false,
  word_count: 0,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  scope: "workspace",
  origin_project_id: "",
  origin_path: "",
  ...over,
});

const asNote = (row: NoteMetaRow): Note => ({ ...row, tags: [] });

/** What `notes_save_note` answers — the row, and no file version for a note that mirrors none. */
const saved = (row: NoteMetaRow | null): NoteSaved => ({ meta: row, version: null });

/** Resolves when the promise is released by the test — a backend call left hanging on purpose. */
function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

const saves = () => calls.filter((call) => call.name === "notes_save_note").map((call) => call.args.content);

async function asked() {
  for (let i = 0; i < 100; i++) {
    const request = useConfirmStore.getState().request;
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("nothing was asked");
}

beforeEach(() => {
  calls = [];
  handlers = {
    notes_save_note: (args) => saved(meta({ title: String(args.title) })),
  };
  useConfirmStore.setState({ request: null });
  useNotesStore.setState({
    workspaceId: "w1",
    loading: false,
    notes: [asNote(meta())],
    books: [],
    activeId: "n1",
    draft: { id: "n1", title: "Nota", content: "hola", tags: [], dirty: false },
    bodies: { n1: "hola" },
    bodyOrder: ["n1"],
    saving: false,
    trash: null,
    trashOpen: false,
    fileVersions: {},
    fileConflict: null,
    fileError: "",
  });
});

describe("flush", () => {
  it("writes a dirty draft once, and nothing when it is clean", async () => {
    await useNotesStore.getState().flush();
    expect(saves()).toEqual([]);
    useNotesStore.getState().editDraft({ content: "hola mundo" });
    await useNotesStore.getState().flush();
    expect(saves()).toEqual(["hola mundo"]);
    expect(useNotesStore.getState().draft?.dirty).toBe(false);
  });

  it("writes again when a keystroke lands while the first write is in flight", async () => {
    const first = gate<NoteSaved>();
    let count = 0;
    handlers.notes_save_note = (args) =>
      ++count === 1 ? first.promise : saved(meta({ title: String(args.title) }));

    useNotesStore.getState().editDraft({ content: "uno" });
    const flushing = useNotesStore.getState().flush();
    // Typed during the round trip: the draft is dirty again behind the await.
    useNotesStore.getState().editDraft({ content: "uno dos" });
    first.open(saved(meta()));
    await flushing;

    expect(saves()).toEqual(["uno", "uno dos"]);
    expect(useNotesStore.getState().draft).toMatchObject({ content: "uno dos", dirty: false });
  });

  it("joins a write already under way instead of racing it", async () => {
    const first = gate<NoteSaved>();
    handlers.notes_save_note = () => first.promise;
    useNotesStore.getState().editDraft({ content: "x" });
    const a = useNotesStore.getState().flush();
    const b = useNotesStore.getState().flush();
    first.open(saved(meta()));
    await Promise.all([a, b]);
    expect(saves()).toEqual(["x"]);
  });

  it("keeps the draft dirty when the write fails, and does not spin retrying", async () => {
    handlers.notes_save_note = () => {
      throw new Error("disco lleno");
    };
    useNotesStore.getState().editDraft({ content: "no se guarda" });
    await useNotesStore.getState().flush();
    expect(saves()).toEqual(["no se guarda"]);
    expect(useNotesStore.getState().draft?.dirty).toBe(true);
  });

  it("does not flag a different note dirty when the failed write was for one already left", async () => {
    const pending = gate<NoteMetaRow>();
    handlers.notes_save_note = () => pending.promise.then(() => Promise.reject(new Error("x")));
    useNotesStore.getState().editDraft({ content: "a" });
    const flushing = useNotesStore.getState().flush();
    useNotesStore.setState({ draft: { id: "n2", title: "Otra", content: "", tags: [], dirty: false } });
    pending.open(meta());
    await flushing;
    expect(useNotesStore.getState().draft).toMatchObject({ id: "n2", dirty: false });
  });

  it("drops the draft when the note was deleted from elsewhere", async () => {
    handlers.notes_save_note = () => saved(null);
    useNotesStore.getState().editDraft({ content: "tarde" });
    await useNotesStore.getState().flush();
    expect(useNotesStore.getState().draft).toBeNull();
    expect(useNotesStore.getState().notes).toEqual([]);
  });

  it("folds back only the columns it wrote, so a pin made meanwhile survives", async () => {
    const pending = gate<NoteSaved>();
    handlers.notes_save_note = () => pending.promise;
    useNotesStore.getState().editDraft({ title: "Nuevo" });
    const flushing = useNotesStore.getState().flush();
    useNotesStore.setState((state) => ({ notes: state.notes.map((n) => ({ ...n, pinned: true })) }));
    pending.open(saved(meta({ title: "Nuevo", pinned: false })));
    await flushing;
    expect(useNotesStore.getState().notes[0]).toMatchObject({ title: "Nuevo", pinned: true });
  });
});

describe("a note that mirrors a file", () => {
  const read: NoteFileVersion = { mtime_ms: 1, size: 4, hash: "aa" };
  const written: NoteFileVersion = { mtime_ms: 2, size: 9, hash: "bb" };
  const linked = (over: Partial<NoteMetaRow> = {}) =>
    meta({ origin_project_id: "p1", origin_path: "docs/plan.md", ...over });
  const lastSave = () => calls.filter((call) => call.name === "notes_save_note").slice(-1)[0]?.args;

  beforeEach(() => {
    useNotesStore.setState({ notes: [asNote(linked())], fileVersions: { n1: read }, fileConflict: null });
  });

  it("saves over the version it last read, and keeps the one it wrote for the next save", async () => {
    handlers.notes_save_note = () => ({ meta: linked(), version: written });
    useNotesStore.getState().editDraft({ content: "hola mundo" });
    await useNotesStore.getState().flush();
    expect(lastSave()).toMatchObject({ expected: read, force: false });
    expect(useNotesStore.getState().fileVersions.n1).toEqual(written);
  });

  it("asks before writing over a file that moved, and writes over it when told to", async () => {
    let count = 0;
    handlers.notes_save_note = () => {
      if (++count === 1) throw new Error("changed-on-disk: docs/plan.md changed on disk since it was opened");
      return { meta: linked(), version: written };
    };
    useNotesStore.getState().editDraft({ content: "mía" });
    await useNotesStore.getState().flush();
    expect(useNotesStore.getState().fileConflict).toBe("n1");
    expect(useNotesStore.getState().draft?.dirty).toBe(true);

    await asked();
    useConfirmStore.getState().pick("overwrite");
    for (let i = 0; i < 50 && useNotesStore.getState().fileConflict; i++) await Promise.resolve();
    expect(lastSave()).toMatchObject({ content: "mía", force: true });
    expect(useNotesStore.getState()).toMatchObject({ fileConflict: null, fileVersions: { n1: written } });
    expect(useNotesStore.getState().draft?.dirty).toBe(false);
  });

  it("takes the file's copy when told to reload, dropping the edit", async () => {
    handlers.notes_save_note = () => {
      throw new Error("changed-on-disk: docs/plan.md changed on disk since it was opened");
    };
    handlers.notes_pull_file = () => ({
      row: { ...linked({ word_count: 3 }), content: "lo del pull" },
      file_error: "",
      version: written,
    });
    useNotesStore.getState().editDraft({ content: "mía" });
    await useNotesStore.getState().flush({ interactive: false });
    await useNotesStore.getState().resolveFileConflict("reload");
    expect(useNotesStore.getState().draft).toMatchObject({ content: "lo del pull", dirty: false });
    expect(useNotesStore.getState()).toMatchObject({ fileConflict: null, fileVersions: { n1: written } });
    expect(useNotesStore.getState().notes[0].word_count).toBe(3);
  });

  it("opens from its file rather than from the cache", async () => {
    useNotesStore.setState({ activeId: null, draft: null, bodies: { n1: "lo de antes" } });
    handlers.notes_pull_file = () => ({
      row: { ...linked(), content: "lo del archivo" },
      file_error: "",
      version: read,
    });
    await useNotesStore.getState().openNote("n1");
    expect(useNotesStore.getState().draft?.content).toBe("lo del archivo");
    expect(calls.some((call) => call.name === "notes_get_note")).toBe(false);
  });
});

describe("the quit guard's view of a note", () => {
  it("lists a dirty draft, and one whose save is still in flight", async () => {
    expect(collectUnsaved().filter((item) => item.label === "Nota")).toEqual([]);
    useNotesStore.getState().editDraft({ content: "sin guardar" });
    expect(collectUnsaved()).toContainEqual(expect.objectContaining({ label: "Nota" }));

    const pending = gate<NoteSaved>();
    handlers.notes_save_note = () => pending.promise;
    const flushing = useNotesStore.getState().flush();
    // Marked clean before the write lands — and still unsaved as far as a quit is concerned.
    expect(useNotesStore.getState().draft?.dirty).toBe(false);
    expect(collectUnsaved()).toContainEqual(expect.objectContaining({ label: "Nota" }));
    pending.open(saved(meta()));
    await flushing;
    expect(collectUnsaved().filter((item) => item.label === "Nota")).toEqual([]);
  });

  it("saves on the quit's 'save all', and reports the note when it could not", async () => {
    useNotesStore.getState().editDraft({ content: "al salir" });
    expect(await saveAllUnsaved()).toEqual([]);
    expect(saves()).toEqual(["al salir"]);

    handlers.notes_save_note = () => {
      throw new Error("no");
    };
    useNotesStore.getState().editDraft({ content: "otra vez" });
    expect(await saveAllUnsaved()).toContain("Nota");
  });
});

describe("the trash", () => {
  it("moves a note there without asking, and forgets the cached trash", async () => {
    useNotesStore.setState({ trash: [] });
    await useNotesStore.getState().deleteNote("n1");
    expect(calls.map((call) => call.name)).toContain("notes_delete_note");
    expect(useNotesStore.getState()).toMatchObject({ notes: [], activeId: null, draft: null, trash: null });
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("reads the trash when opened, and a restore re-reads the tree", async () => {
    const row = { id: "t1", title: "Vieja", book_name: "", deleted_at: "2026-09-01T00:00:00Z" };
    handlers.notes_list_trash = () => [row];
    handlers.notes_restore_note = () => meta({ id: "t1", book_id: "b9" });
    handlers.notes_load_tree = () => ({ notes: [meta(), meta({ id: "t1", book_id: "b9" })], books: [], templates: [] });

    await useNotesStore.getState().openTrash();
    expect(useNotesStore.getState()).toMatchObject({ trashOpen: true, activeId: null, trash: [row] });

    await useNotesStore.getState().restoreFromTrash("t1");
    expect(calls.find((call) => call.name === "notes_restore_note")?.args.fallbackBookName).toBeTruthy();
    expect(useNotesStore.getState().trash).toEqual([]);
    expect(useNotesStore.getState().notes.map((note) => note.id)).toContain("t1");
  });
});

describe("renaming a note that others link to", () => {
  it("asks nothing when nothing links to it", async () => {
    handlers.notes_count_links = () => 0;
    await useNotesStore.getState().offerLinkRewrite("n1", "Vieja", "Nueva");
    expect(useConfirmStore.getState().request).toBeNull();
    expect(calls.some((call) => call.name === "notes_rewrite_links")).toBe(false);
  });

  it("asks once with the count, rewrites on yes, and drops the rewritten bodies from the cache", async () => {
    useNotesStore.setState({
      notes: [asNote(meta()), asNote(meta({ id: "n2", title: "Diario" }))],
      bodies: { n1: "hola", n2: "[[Vieja]]" },
      bodyOrder: ["n1", "n2"],
    });
    handlers.notes_count_links = () => 1;
    handlers.notes_rewrite_links = () => [meta({ id: "n2", title: "Diario", excerpt: "Nueva" })];

    const offering = useNotesStore.getState().offerLinkRewrite("n1", "Vieja", "Nueva");
    const request = await asked();
    expect(request.message).toContain("1");
    useConfirmStore.getState().respond(true);
    await offering;

    const rewrite = calls.find((call) => call.name === "notes_rewrite_links");
    expect(rewrite?.args).toMatchObject({ oldTitle: "Vieja", newTitle: "Nueva", excludeId: "n1" });
    expect(useNotesStore.getState().bodies).toEqual({ n1: "hola" });
    expect(useNotesStore.getState().notes.find((note) => note.id === "n2")?.excerpt).toBe("Nueva");
  });

  it("offers nothing while another note still answers to the old title", async () => {
    useNotesStore.setState({ notes: [asNote(meta()), asNote(meta({ id: "n2", title: "vieja" }))] });
    handlers.notes_count_links = () => 4;
    await useNotesStore.getState().offerLinkRewrite("n1", "Vieja", "Nueva");
    expect(calls.some((call) => call.name === "notes_count_links")).toBe(false);
  });

  it("offers nothing for a title a link cannot carry", async () => {
    handlers.notes_count_links = () => 3;
    await useNotesStore.getState().offerLinkRewrite("n1", "Vieja", "a|b");
    expect(calls.some((call) => call.name === "notes_count_links")).toBe(false);
  });
});

describe("importing Markdown", () => {
  it("creates the notes in the order they were picked, into the named book", async () => {
    let at = 0;
    handlers.notes_create_note = (args) => meta({ id: `m${++at}`, title: String(args.title), book_id: String(args.bookId) });
    const created = await useNotesStore.getState().importMarkdown("b1", [
      { title: "Uno", content: "1", tags: [] },
      { title: "Dos", content: "2", tags: ["x"] },
    ]);
    expect(created).toBe(2);
    expect(calls.filter((call) => call.name === "notes_create_note").map((call) => call.args.title)).toEqual([
      "Uno",
      "Dos",
    ]);
    expect(calls.find((call) => call.args.title === "Dos")?.args.tags).toBe('["x"]');
  });
});
