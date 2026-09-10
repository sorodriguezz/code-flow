import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDbml } from "../../lib/dbml/parse";
import type { CellFailure } from "../../lib/dbml/sqlite";
import type { SandboxPage } from "../../lib/tauri/sandboxCommands";
import { SandboxGrid, columnsFor, draftIsDirty, errorCell } from "./SandboxGrid";

/**
 * The two things that made the Datos grid read as broken, pinned so they cannot come back.
 *
 * Both were reported the same way — "there is no option to save, and delete does not work" — and
 * neither was in the engine, the store or the IPC. One was a refusal thrown away, the other was a
 * gesture with nothing on screen to reveal it.
 *
 * There is no DOM in this suite (no jsdom, no testing-library — see `rows.test.tsx`), so the second
 * half is checked as *markup*: whether the controls are rendered at all, which is exactly the
 * property that was missing. What a click does is proved by the store's own tests and by
 * `sandbox.rs`.
 */

const SCHEMA = parseDbml(`
Table usuarios {
  id integer [pk, increment]
  email varchar(120) [not null, unique]
  rol rol
  creado timestamp [default: \`now()\`]
}

Table bitacora {
  id integer [pk, increment]
  at timestamp [default: \`now()\`]
}

Enum rol {
  admin
  user
}
`);

const tableOf = (id: string) => {
  const found = SCHEMA.tables.find((table) => table.id === id);
  if (!found) throw new Error(`no table ${id} — the fixture did not parse`);
  return found;
};

const COLUMNS = columnsFor(SCHEMA, tableOf("usuarios"));

/** `id` and `creado` fill themselves, so `email` and `rol` are the cells you can type into. */
const TYPED = COLUMNS.filter((column) => !column.auto);

const failure = (over: Partial<CellFailure>): CellFailure => ({
  table: "usuarios",
  column: null,
  code: "other",
  detail: "",
  ...over,
});

describe("where a refusal is shown", () => {
  it("puts it on the cell when the engine named one the user can see", () => {
    expect(errorCell(failure({ column: "email", code: "unique" }), TYPED)).toBe("email");
  });

  it("sends a refusal that names no column to the banner", () => {
    // The bug this pins. `readFailure` answers `column: null` for a table-level CHECK, a composite
    // reference and `FOREIGN KEY constraint failed`, and the grid used to respond with
    // `setErrors({})` — so the save wrote nothing, said nothing, and looked like a dead button.
    expect(errorCell(failure({ code: "foreignKey" }), TYPED)).toBeNull();
    expect(
      errorCell(failure({ code: "other", detail: "no such table: usuarios" }), TYPED),
    ).toBeNull();
  });

  it("sends it to the banner when the named column has no cell on this row", () => {
    // `id` is `auto`: the draft row renders it as the word `auto`, with no input and no ref to
    // focus. A message filed under it would be as invisible as one that was dropped.
    expect(errorCell(failure({ column: "id", code: "notNull" }), TYPED)).toBeNull();
    expect(errorCell(failure({ column: "borrado", code: "notNull" }), TYPED)).toBeNull();
  });
});

describe("when a save is worth offering", () => {
  it("says no to an untouched draft", () => {
    expect(draftIsDirty({})).toBe(false);
  });

  it("says yes as soon as one cell holds something", () => {
    expect(draftIsDirty({ email: "ana@achs.cl" })).toBe(true);
    expect(draftIsDirty({ email: null, rol: "admin" })).toBe(true);
  });

  it("says no again when the cell is emptied", () => {
    // "Actually, no" should leave the toolbar as it found it. Erasing what you typed arrives here
    // as `null` — `onChange` sends `value || null` — so an explicit NULL cannot count either, and
    // that is fine: a row of nothing but NULLs is what a plain default insert already writes.
    expect(draftIsDirty({ email: null })).toBe(false);
    expect(draftIsDirty({ email: "" })).toBe(false);
  });
});

describe("the controls the grid puts on screen", () => {
  const PAGE: SandboxPage = {
    columns: [
      { name: "id", type_name: "INTEGER" },
      { name: "email", type_name: "TEXT" },
      { name: "rol", type_name: "TEXT" },
      { name: "creado", type_name: "TEXT" },
    ],
    rows: [
      ["1", "ana@achs.cl", "admin", "2026-01-01"],
      ["2", "beto@achs.cl", null, "2026-01-02"],
    ],
    rowids: [1, 2],
    total: 2,
  };

  // English is the store's initial language and the per-key fallback, so the compiled `en`
  // dictionary is what a server render reads.
  const html = renderToStaticMarkup(
    <SandboxGrid
      diagramId="d1"
      table="usuarios"
      page={PAGE}
      columns={COLUMNS}
      onInsert={async () => null}
      onUpdate={async () => null}
      onDelete={async () => null}
      onJumpTo={() => {}}
    />,
  );

  it("asks for nothing while the draft is empty", () => {
    // Writing rows by hand is optional, and most visits here only read the data. A permanent
    // "Save row" — filled, accented, beside a permanently ticked gutter — turned the grid into a
    // form that looked like it was waiting on you.
    expect(html).not.toContain("Save row");
    expect(html).not.toContain("Discard");
  });

  it("still marks where a row would go", () => {
    // The `+` in the draft's gutter stays: it says *this is the row you would type into*, which is
    // a label, not a demand.
    const draft = html.slice(html.lastIndexOf('<tr style="height:26px"'));
    expect(draft).toContain("lucide-plus");
  });

  it("gives every row a tick, and the page one over them", () => {
    // Selection used to live on a bare row-number gutter that happened to be clickable, with no
    // box, no label and no hover — so "Delete 0", greyed out, was as far as anyone got.
    expect([...html.matchAll(/type="checkbox"/g)]).toHaveLength(PAGE.rows.length + 1);
    expect(html).toContain("Select every row on this page");
    expect(html).toContain("Select this row");
  });

  it("counts only what is ticked on the delete, and waits for one", () => {
    expect(html).toContain("Delete 0");
    const remove = /<button[^>]*title="Deletes the selected rows[^"]*"[^>]*>/.exec(html);
    expect(remove?.[0]).toContain('disabled=""');
  });

  it("keeps the draft's own cells typeable and its self-filling ones marked", () => {
    // The last `<tr>` is the draft. `id` and `creado` fill themselves, so they say `auto` and take
    // no input at all; `email` is a text box and `rol`, being an enum, is a list of its values.
    const draft = html.slice(html.lastIndexOf('<tr style="height:26px"'));
    expect([...draft.matchAll(/>auto</g)]).toHaveLength(2);
    expect([...draft.matchAll(/<input(?![^>]*type="checkbox")/g)]).toHaveLength(1);
    expect(draft).toContain('<option value="admin">');
  });
});

describe("a table with nothing to type into", () => {
  /** Both columns fill themselves, so the draft can never become dirty. */
  const html = renderToStaticMarkup(
    <SandboxGrid
      diagramId="d1"
      table="bitacora"
      page={{
        columns: [
          { name: "id", type_name: "INTEGER" },
          { name: "at", type_name: "TEXT" },
        ],
        rows: [],
        rowids: [],
        total: 0,
      }}
      columns={columnsFor(SCHEMA, tableOf("bitacora"))}
      onInsert={async () => null}
      onUpdate={async () => null}
      onDelete={async () => null}
      onJumpTo={() => {}}
    />,
  );

  it("offers the save anyway, or the table could never be given a row", () => {
    // The one place the button appears unasked, and the reason is that there is no other way in:
    // no cell to focus, no keystroke to press, and `draftIsDirty` stuck at false forever. What it
    // sends is `INSERT … DEFAULT VALUES`.
    expect(html).toContain("Save row");
    expect(html).toContain('aria-label="Save row"');
  });
});
