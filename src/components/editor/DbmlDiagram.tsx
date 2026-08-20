import { forwardRef, useState } from "react";
import { Table2 } from "lucide-react";
import type { DbmlSchema } from "../../lib/dbml/types";
import { DbmlCanvas } from "../dbml/DbmlCanvas";
import { useT } from "../../state/languageStore";
import { BouncingDots } from "../common/BouncingDots";
import { EmptyState } from "../common/EmptyState";

/**
 * A `.dbml` file, drawn, in the editor's preview pane.
 *
 * **The same canvas the Diagrams workspace uses**, in its read-only mode: one renderer for "a DBML
 * schema as a picture", so a file previewed here and the same file opened as a diagram cannot look
 * like two different schemas. What this adds is the states a file has and a document does not — the
 * parser still loading, and a file that does not parse.
 *
 * The boxes can still be dragged, and the drag is deliberately *not* written anywhere: this is a
 * preview of a file on disk, and nudging a box to read a line is not an edit to it.
 */
export const DbmlDiagram = forwardRef<
  HTMLDivElement,
  {
    /** `null` while the parser is still on its way — see `loading`. */
    schema: DbmlSchema | null;
    /** The DBML parser is its own chunk, fetched the first time a `.dbml` file is opened in a
     * session (see `EditorPane`). Until it lands there is nothing parsed to draw, and the honest
     * answer is "loading" — an empty diagram would read as "this file declares no tables", which
     * is a different claim and a wrong one. */
    loading?: boolean;
    onScroll?: () => void;
  }
>(function DbmlDiagram({ schema, loading = false, onScroll }, ref) {
  const t = useT();
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);

  // Same shape the pane uses for a file that hasn't finished reading, so waiting for the parser
  // looks like every other wait in the editor rather than like a fourth kind of blank.
  if (loading || !schema) {
    return (
      <div className="flex h-full items-center justify-center">
        <BouncingDots />
      </div>
    );
  }

  return (
    <div ref={ref} onScroll={onScroll} className="flex h-full min-h-0 flex-col">
      {schema.error && (
        <p className="shrink-0 whitespace-pre-wrap border-b border-[var(--cf-danger)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] px-3 py-2 font-mono text-[11px] text-[var(--cf-danger)]">
          {schema.error}
        </p>
      )}
      {schema.tables.length === 0 && schema.enums.length === 0 ? (
        <EmptyState icon={Table2} title={t("dbml.emptyTitle")} subtitle={t("dbml.emptySubtitle")} />
      ) : (
        <DbmlCanvas
          schema={schema}
          positions={positions}
          onMoveTable={(id, x, y) => setPositions((current) => ({ ...current, [id]: { x, y } }))}
          selected={selected}
          onSelect={setSelected}
          mode="all"
          density="roomy"
          className="flex-1"
        />
      )}
    </div>
  );
});
