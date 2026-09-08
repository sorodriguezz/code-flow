import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDbml } from "../../lib/dbml/parse";
import { DbmlCanvas } from "./DbmlCanvas";
import { columnsFor } from "./SandboxGrid";

/**
 * The two things about the Datos surface that a unit test can hold still, and that nothing else
 * covers: what the grid decides about each column, and whether the row counts reach the drawing.
 *
 * The engine itself is proved elsewhere and properly — `lib/dbml/sqlite.engine.test.ts` runs the
 * emitted DDL through a real `sqlite3`, and `sandbox.rs`'s own tests exercise paging, batches and
 * the attach limit. What those cannot see is the React side reading the *schema* correctly, which
 * is where `auto` and the foreign-key picker come from.
 */

const SCHEMA = parseDbml(`
Table usuarios {
  id integer [pk, increment]
  email varchar(120) [not null, unique]
  rol rol
  creado timestamp [default: \`now()\`]
}

Table productos {
  sku varchar(20) [pk, not null]
  nombre varchar(80) [not null]
}

Table pedidos {
  id uuid [pk]
  usuario_id integer [not null, ref: > usuarios.id]
  sku varchar(20) [not null, ref: > productos.sku]
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

describe("what the grid decides about a column", () => {
  it("marks an integer key `auto` and a text key not", () => {
    // The bug this pins: skipping the first column because it is first. `productos.sku` is a
    // `varchar` key — nothing fills it but you — and a grid that greyed it out and skipped it with
    // Tab would walk the user into `NOT NULL constraint failed` on the one cell it told them to
    // ignore.
    const usuarios = columnsFor(SCHEMA, tableOf("usuarios"));
    const productos = columnsFor(SCHEMA, tableOf("productos"));
    expect(usuarios.find((column) => column.name === "id")?.auto).toBe(true);
    expect(productos.find((column) => column.name === "sku")?.auto).toBe(false);
  });

  it("treats a uuid key as yours to fill when it has no default", () => {
    const pedidos = columnsFor(SCHEMA, tableOf("pedidos"));
    expect(pedidos.find((column) => column.name === "id")?.auto).toBe(false);
  });

  it("counts a column with a default as self-filling", () => {
    const usuarios = columnsFor(SCHEMA, tableOf("usuarios"));
    expect(usuarios.find((column) => column.name === "creado")?.auto).toBe(true);
  });

  it("finds the reference behind a foreign-key cell, including a text one", () => {
    const pedidos = columnsFor(SCHEMA, tableOf("pedidos"));
    expect(pedidos.find((column) => column.name === "usuario_id")?.ref).toEqual({
      parent: "usuarios",
      parentColumns: ["id"],
      columns: ["usuario_id"],
    });
    expect(pedidos.find((column) => column.name === "sku")?.ref?.parent).toBe("productos");
  });

  it("carries an enum's values so the cell can be a list rather than a text box", () => {
    const usuarios = columnsFor(SCHEMA, tableOf("usuarios"));
    expect(usuarios.find((column) => column.name === "rol")?.enumValues).toEqual([
      "admin",
      "user",
    ]);
  });
});

describe("the counts on the drawing", () => {
  const draw = (rowCounts?: Record<string, number>) =>
    renderToStaticMarkup(
      <DbmlCanvas
        schema={SCHEMA}
        positions={{}}
        rowCounts={rowCounts}
        selected={null}
        onSelect={() => {}}
        mode="all"
        density="compact"
      />,
    );

  it("shows `~N` per table when a scratch database has been built", () => {
    const html = draw({ usuarios: 12, productos: 3, pedidos: 0 });
    expect(html).toContain("~12");
    expect(html).toContain("~3");
    expect(html).toContain("~0");
  });

  it("shows nothing at all when there is no sandbox", () => {
    expect(draw()).not.toContain("~");
  });

  it("keeps the geometry it had before the counts existed", () => {
    // The counts ride inside the 34px header band. If they ever changed a box's size, every edge
    // the router places would move with it — and `route.test.ts` measures those. Comparing the two
    // renderings' `<rect>` and `<path>` geometry is the cheapest way to pin that.
    const geometry = (html: string) =>
      [...html.matchAll(/<(?:rect|path|g)\s[^>]*?(?:d|transform|width|height)="[^"]*"/g)]
        .map((match) => match[0])
        .join("|");
    expect(geometry(draw({ usuarios: 12, productos: 3, pedidos: 0 }))).toBe(geometry(draw()));
  });

  it("paints them in a colour that survives the exported PNG", () => {
    // `diagramSvg` substitutes `var(--…)` and nothing else, so a `color-mix()` here would look
    // right on screen and reach the exported image as a function the renderer cannot evaluate.
    const html = draw({ usuarios: 12 });
    const counts = /<text[^>]*>~12/.exec(html) ?? /~12/.exec(html);
    expect(counts).not.toBeNull();
    expect(html).not.toMatch(/color-mix\([^)]*\)"[^>]*>~/);
  });
});

describe("the IPC surface", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Every command name and argument, checked against the Rust side by hand once and pinned here.
   *
   * Tauri converts a camelCase key to snake_case on the way in, so `schemaJson` reaches
   * `schema_json`. Nothing type-checks that hop — a renamed parameter compiles cleanly on both
   * sides and fails only at runtime, in the one place this repository has no automated way to
   * reach.
   */
  it("calls each command with the arguments the Rust side declares", async () => {
    const calls: { name: string; args: unknown }[] = [];
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve(null);
      },
    }));
    const api = await import("../../lib/tauri/sandboxCommands");

    await api.sandboxOpen("d1", "CREATE TABLE t (a);", "abc123", "{}", "{}");
    await api.sandboxStatus("d1");
    await api.sandboxCounts("d1");
    await api.sandboxPage("d1", "usuarios", 0, 200);
    await api.sandboxExecute("d1", "select 1");
    await api.sandboxCancel("d1");
    await api.sandboxWipe("d1");
    await api.sandboxClose("d1");
    await api.sandboxSweep();

    expect(calls.map((call) => call.name)).toEqual([
      "sandbox_open",
      "sandbox_status",
      "sandbox_counts",
      "sandbox_page",
      "sandbox_execute",
      "sandbox_cancel",
      "sandbox_wipe",
      "sandbox_close",
      "sandbox_sweep",
    ]);
    expect(calls[0].args).toEqual({
      diagramId: "d1",
      ddl: "CREATE TABLE t (a);",
      fingerprint: "abc123",
      schemaJson: "{}",
      constraintsJson: "{}",
    });
    expect(calls[3].args).toEqual({
      diagramId: "d1",
      table: "usuarios",
      offset: 0,
      limit: 200,
    });
    expect(calls[4].args).toEqual({ diagramId: "d1", sql: "select 1" });
    expect(calls[8].args).toBeUndefined();
  });
});
