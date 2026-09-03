import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import type { DbmlSchema } from "../../lib/dbml/types";

/**
 * Which relationship the canvas is lighting, and who gets to decide.
 *
 * The inspector lists a table's relations only while that table is *selected*, which means the
 * canvas is already lit up with the table's whole neighbourhood — every line it touches. Hovering
 * one row has to narrow that to the single line the row names, or the highlight answers a question
 * nobody asked. So `focusRef` outranks `selected`, and this is the test that says so: it is the one
 * ordering decision in `focusKind`/`focusId` that is not obvious from reading them.
 *
 * Opacity is the assertion because opacity is the feature. `0.95` is a lit line, `0.16` a dimmed
 * one — see the link render in `DbmlCanvas`.
 */
const column = (name: string, pk = false) => ({
  name,
  type: "integer",
  pk,
  notNull: false,
  unique: false,
  increment: false,
  default: null,
  note: "",
});

const table = (id: string, extra: string[]) => ({
  id,
  schema: "public",
  name: id,
  alias: null,
  note: "",
  fields: [column("id", true), ...extra.map((name) => column(name))],
  indexes: [],
});

const SCHEMA = {
  tables: [
    table("usuarios", []),
    table("comentarios", ["usuario_id"]),
    table("historias", ["usuario_id"]),
    table("me_gusta", ["usuario_id"]),
  ],
  enums: [],
  groups: [],
  error: null,
  refs: ["comentarios", "historias", "me_gusta"].map((from, at) => ({
    id: `r${at}`,
    from: { table: from, fields: ["usuario_id"], relation: "*" },
    to: { table: "usuarios", fields: ["id"], relation: "1" },
  })),
} as unknown as DbmlSchema;

function draw(focusRef: string | null) {
  return renderToStaticMarkup(
    <DbmlCanvas
      schema={SCHEMA}
      positions={{}}
      selected="usuarios"
      onSelect={() => {}}
      mode="all"
      density="roomy"
      focusRef={focusRef}
    />,
  );
}

const occurrences = (html: string, opacity: string) =>
  (html.match(new RegExp(`opacity="${opacity}"`, "g")) ?? []).length;

describe("hovering a relation in the inspector", () => {
  it("lights the table's whole neighbourhood when nothing is hovered", () => {
    const html = draw(null);
    expect(occurrences(html, "0.95")).toBe(SCHEMA.refs.length);
  });

  it("narrows to the one relationship under the pointer", () => {
    const html = draw("r1");
    expect(occurrences(html, "0.95")).toBe(1);
    // …and pushes the other two back, rather than merely leaving them at their neutral weight.
    expect(occurrences(html, "0.16")).toBeGreaterThanOrEqual(SCHEMA.refs.length - 1);
  });
});
