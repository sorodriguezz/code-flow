import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Code2,
  Link2,
  ListOrdered,
  MousePointerClick,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  groupOfTable,
  neighboursOf,
  tableOf,
  type DbmlRef,
  type DbmlSchema,
} from "../../lib/dbml/types";
import type { Cardinality, FieldEdit, RefEnd } from "../../lib/dbml/edit";
import { typeSuggestions } from "../../lib/dbml/dataTypes";
import type { DbmlMarkKind } from "../../lib/dbml/layout";
import { ContextMenu } from "../common/ContextMenu";
import {
  LegendBadge,
  LEGEND,
  MARK_COLOUR,
  MARK_KINDS,
  markMenuItems,
  markNamesOf,
} from "./markChrome";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { Select } from "../common/Select";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass, fieldClass, inspectorClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { PANE_TITLE } from "../diagrams/diagramsChrome";
import { useT } from "../../state/languageStore";

/**
 * What the selected box actually says.
 *
 * The canvas answers "what is this joined to"; a box on a canvas cannot answer "what is the type of
 * the third column, and is it nullable" without becoming unreadable at any zoom that fits the
 * schema. This is that second question, and it is why selecting a table does two things at once —
 * lights up its neighbourhood *and* fills this in.
 *
 * A column of the layout rather than a panel floating over the canvas: it is up whenever the
 * diagram is, so overlaying it would permanently cover the top-right corner of the drawing, and a
 * panel that appears and disappears would resize the canvas — and shift the whole schema sideways —
 * every time a table was clicked. With nothing selected it says so and keeps its width.
 *
 * Every relation listed here is clickable, and clicking one selects the table at the other end.
 * That turns the panel into a way of *walking* the schema: the thing you want after reading
 * `orders.customer_id → customers.id` is almost always `customers`.
 *
 * # Why so little of it is on screen at once
 *
 * Everything below used to be drawn expanded and all at the same time: the note, every column with
 * up to three pills on it, its note and its default each on their own line, both directions of
 * every relation, then the indexes. On a forty-column table that is several screens of panel in a
 * column 236px wide, and the effect is that *nothing* in it is findable — the two facts you came
 * for are somewhere in the middle of thirty you did not.
 *
 * So it is layered by how often the answer is wanted:
 *
 * 1. **Always up**: the name, what group it is in, how many tables it touches. The header does not
 *    scroll, so this stays true however far down the panel you are.
 * 2. **Open by default**: the columns and the relations. These are what the panel is for.
 * 3. **Folded**: the note, the indexes, an enum's values. Real, occasionally the whole reason you
 *    opened the panel, and not what you are looking at nine times out of ten. Each header carries
 *    its own count, so a fold never hides *whether* there is anything in it — only what.
 * 4. **Behind a disclosure on the row**: a column's note and its default. Per column rather than per
 *    section, because one documented column should not cost every other column a line.
 *
 * The other half of the noise was the type pill. It is the one badge that appears on *every* row —
 * PK and unique are the exception, a type is universal — so as a pill it drew a bordered, filled
 * box down the whole panel to say something the eye reads as a column of text anyway. It is now
 * muted text, right-aligned into its own column. PK and unique stay tinted chips: they are rare
 * enough that a chip is a mark rather than a texture.
 */
export function DbmlInspector({
  schema,
  id,
  onSelect,
  onClose,
  onOpen,
  onHoverRef,
  pinned = false,
  onTogglePin,
  width,
  mark,
  fieldMark,
  edit,
}: {
  schema: DbmlSchema;
  /** The selected table or enum. `null` draws the empty state. */
  id: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Jumps to the declaration in the editor. */
  onOpen?: (id: string) => void;
  /**
   * The relationship the pointer is on, or `null`.
   *
   * Reading a relation row and finding the line it names are the same question asked twice: the
   * panel says `usuarios.id < historias.usuario_id` and the canvas has forty lines on it. Hovering
   * the row narrows the drawing to that one relationship — the same highlight hovering the line
   * itself produces, driven from the other end.
   */
  onHoverRef?: (id: string | null) => void;
  /** Held: the canvas can no longer change what is being read. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Set by the workbench, which owns the seam. Omitted by the read-only callers, which have none. */
  width?: number;
  /**
   * Turns the panel into a form. Omitted by the read-only callers, which then get what they had.
   *
   * `blocked` is the document not parsing: the operations below name a table taken from the parsed
   * schema, and with a syntax error that schema no longer describes the text — see `applyEdit` in
   * the workbench. The controls stay *visible* and go inert with a reason, rather than vanishing,
   * because a panel that loses half its buttons the moment you mistype a brace reads as a bug in
   * the panel.
   */
  /** The review mark on what is selected, and how to change it. Independent of `edit`: a mark is
   *  written to the sidecar comment, so it stays available while the document does not parse. */
  mark?: {
    current?: DbmlMarkKind;
    set: (mark: DbmlMarkKind | null) => void;
  };
  /**
   * The same, one row down: the review mark on each of the selected table's columns.
   *
   * A lookup and a setter rather than a map, so the panel never has to know how a column's mark is
   * keyed — and cannot read one belonging to a column of the table that *was* selected. Independent
   * of `edit` for the same reason `mark` is: a mark goes to the sidecar, which needs nothing parsed.
   */
  fieldMark?: {
    of: (column: string) => DbmlMarkKind | undefined;
    set: (column: string, mark: DbmlMarkKind | null) => void;
  };
  edit?: {
    blocked: boolean;
    blockedReason: string;
    addField: (table: string, field: FieldEdit) => void;
    updateField: (table: string, name: string, field: FieldEdit) => void;
    dropField: (table: string, name: string) => void;
    /** Both arguments are table **ids** — the sidecar carrying the mark and the dragged position is
     *  keyed by them. See `moveSidecarKey` in the workbench. */
    renameTable: (from: string, to: string) => void;
    /** Removes the selected table — or enum, which `edits.dropTable` also handles — along with
     *  every relationship that named it and its entry in any table group. Takes the **id**. */
    dropTable: (id: string) => void;
    setNote: (table: string, note: string) => void;
    addRef: (from: RefEnd, to: RefEnd, cardinality: Cardinality) => void;
    dropRef: (from: RefEnd, to: RefEnd) => void;
  };
}) {
  const t = useT();
  /** Which "+" form is open, if any. One at a time: two open forms in a 236px column is a wall. */
  const [adding, setAdding] = useState<"field" | "ref" | null>(null);
  const table = id ? tableOf(schema, id) : null;
  const asEnum = id ? schema.enums.find((entry) => entry.id === id) : null;

  const outgoing = id ? schema.refs.filter((ref) => ref.from.table === id) : [];
  const incoming = id ? schema.refs.filter((ref) => ref.to.table === id) : [];
  const related = id ? neighboursOf(schema, id).tables.size : 0;
  const group = id ? groupOfTable(schema, id) : undefined;

  // A form left open while the selection moves would submit against the table now on screen.
  useEffect(() => setAdding(null), [id]);

  // The row's own `pointerleave` covers the ordinary case. This covers the two that are not:
  // the selection moving out from under the pointer, and a row being deleted while hovered —
  // both of which would otherwise leave the canvas lit for a relationship nobody is looking at.
  useEffect(() => () => onHoverRef?.(null), [id, onHoverRef]);

  /**
   * What the type box offers: this document's enums, then the types it already uses, then the
   * standard list.
   *
   * It used to be only the middle third — the types this schema happens to contain — sorted
   * alphabetically. On a new schema holding one `integer` column, that is a suggestion list
   * containing the word "integer", which is worse than none because it looks like the feature is
   * working. The generic catalogue and the ordering live in `lib/dbml/dataTypes.ts`.
   */
  const typeOptions = useMemo(() => {
    const used: string[] = [];
    for (const entry of schema.tables) {
      for (const field of entry.fields) if (field.type) used.push(field.type);
    }
    return typeSuggestions(used, schema.enums.map((entry) => entry.name));
  }, [schema]);

  return (
    <aside style={{ width: width ?? 236 }} className={`${inspectorClass} overflow-hidden`}>
      {/* The inspector's head is a toolbar — 44px, the pane's name and its two icon buttons — so
          its hairline lines up with the workbench's toolbar hairline across the canvas. */}
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] pl-3.5 pr-2">
        <span className={PANE_TITLE}>{t("dbml.inspector.title")}</span>
        {id && onTogglePin && (
          <Tooltip label={t(pinned ? "dbml.inspector.unpin" : "dbml.inspector.pin")}>
            <button
              type="button"
              className={iconButtonClass({ size: "sm", active: pinned })}
              aria-label={t(pinned ? "dbml.inspector.unpin" : "dbml.inspector.pin")}
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              {/* One glyph in two states rather than two glyphs: a crossed-out pin on the button
                  that *applies* the pin reads as "pinning is off limits here". */}
              <Pin size={15} fill={pinned ? "currentColor" : "none"} />
            </button>
          </Tooltip>
        )}
        {id && (
          <Tooltip label={t("dbml.inspector.close")}>
            <button
              type="button"
              className={iconButtonClass({ size: "sm" })}
              aria-label={t("dbml.inspector.close")}
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </Tooltip>
        )}
      </header>

      {!table && !asEnum ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <MousePointerClick size={18} className="text-[var(--cf-text-faint)]" />
          <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">
            {t("dbml.selectHint")}
          </p>
        </div>
      ) : (
        <>
          {/* Outside the scroller on purpose. What you are looking at is the one thing that must
              still be true at the bottom of a forty-column table — scrolling the name away leaves a
              list of columns belonging to nothing. */}
          <div className="shrink-0 border-b border-[var(--cf-border)] px-3.5 pb-3 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t(asEnum ? "dbml.inspector.enum" : "dbml.inspector.table")}
            </p>
            {/* Double click to rename, which is the gesture the canvas box uses for the same
                thing. A pencil would be a fifth control in a header that already has two. */}
            <InlineName
              value={table ? table.name : (asEnum?.name ?? "")}
              // Enums too, now that `renameTable` rewrites the columns typed with them — without
              // that pass a renamed enum left `state estado` behind, which parses (DBML takes any
              // word as a type) and silently stops being an enum reference.
              editable={Boolean(edit) && !edit?.blocked && Boolean(table || asEnum)}
              title={edit?.blocked ? edit.blockedReason : t("dbml.inspector.rename")}
              // The id, not the name: the sidecar holding this table's mark and its dragged
              // position is keyed by it. See `moveSidecarKey` in the workbench.
              onCommit={(next) => id && edit?.renameTable(id, next)}
            />
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--cf-text-faint)]">
              {related > 0 && <span>{t("dbml.relatedCount", { count: String(related) })}</span>}
              {group && <span className={chipClass("neutral", "font-mono")}>{group.name}</span>}
              {/* The word and the glyph, not a colour alone: "held" has to read to somebody who
                  cannot tell the accent from the text beside it. */}
              {pinned && (
                <span className={chipClass("accent")}>
                  <Pin size={11} fill="currentColor" />
                  {t("dbml.inspector.pinned")}
                </span>
              )}
            </p>

            {/* The review mark, in the header rather than in a section.
                It is a property of the *whole* table, like its name and its group, and it is what
                you are setting over and over on a model being triaged — so it sits with the two
                facts that never scroll away rather than behind a fold. Three buttons and no words
                on them: the colours are the legend the canvas already draws, the names are in their
                tooltips, and a row of three words would be wider than the panel. */}
            {mark && table && (
              <div className="mt-2.5 flex items-center gap-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t("dbml.mark.title")}
                </span>
                {MARK_KINDS.map((kind) => (
                  <MarkSwatch
                    key={kind}
                    kind={kind}
                    on={mark.current === kind}
                    label={t(`dbml.mark.${kind}` as "dbml.mark.remove")}
                    onClick={() => mark.set(mark.current === kind ? null : kind)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
            {table && (table.note || edit) && (
              <Section label={t("dbml.inspector.note")}>
                {edit ? (
                  <NoteField
                    value={table.note}
                    disabled={edit.blocked}
                    title={edit.blocked ? edit.blockedReason : undefined}
                    onCommit={(next) => edit.setNote(table.name, next)}
                  />
                ) : (
                  <p className="whitespace-pre-wrap rounded-md bg-[var(--cf-sunken)] px-2.5 py-2 text-[12px] leading-snug text-[var(--cf-text-muted)]">
                    {table.note}
                  </p>
                )}
              </Section>
            )}

            {asEnum && (
              <Section
                label={t("dbml.inspector.valuesCount", { count: String(asEnum.values.length) })}
                open
              >
                {asEnum.values.map((value) => (
                  <div key={value.name} className="flex min-h-[26px] items-center gap-2 px-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                      {value.name}
                    </span>
                    {value.note && (
                      <span className="max-w-[50%] truncate text-[11px] text-[var(--cf-text-faint)]">
                        {value.note}
                      </span>
                    )}
                  </div>
                ))}
              </Section>
            )}

            {table && (
              <Section
                label={t("dbml.inspector.fieldsCount", { count: String(table.fields.length) })}
                open
                action={
                  edit
                    ? ({ expand }) => (
                        <AddButton
                          title={edit.blocked ? edit.blockedReason : t("dbml.inspector.addField")}
                          disabled={edit.blocked}
                          onClick={() => {
                            expand();
                            setAdding("field");
                          }}
                        />
                      )
                    : undefined
                }
              >
                {table.fields.map((field) => (
                  <FieldRow
                    key={field.name}
                    field={field}
                    types={typeOptions}
                    mark={
                      fieldMark
                        ? {
                            current: fieldMark.of(field.name),
                            set: (next) => fieldMark.set(field.name, next),
                          }
                        : undefined
                    }
                    edit={
                      edit
                        ? {
                            blocked: edit.blocked,
                            blockedReason: edit.blockedReason,
                            siblings: table.fields.map((entry) => entry.name),
                            save: (next) => edit.updateField(table.name, field.name, next),
                            remove: () => edit.dropField(table.name, field.name),
                          }
                        : undefined
                    }
                  />
                ))}
                {edit && adding === "field" && (
                  <FieldForm
                    types={typeOptions}
                    taken={table.fields.map((field) => field.name)}
                    onCancel={() => setAdding(null)}
                    onSave={(next) => {
                      edit.addField(table.name, next);
                      setAdding(null);
                    }}
                  />
                )}
              </Section>
            )}

            {table && (
              <Section
                label={t("dbml.inspector.relations")}
                count={outgoing.length + incoming.length}
                open
                action={
                  edit
                    ? ({ expand }) => (
                        <AddButton
                          title={edit.blocked ? edit.blockedReason : t("dbml.inspector.addRelation")}
                          disabled={edit.blocked || table.fields.length === 0}
                          onClick={() => {
                            expand();
                            setAdding("ref");
                          }}
                        />
                      )
                    : undefined
                }
              >
                {outgoing.length === 0 && incoming.length === 0 && adding !== "ref" && (
                  <p className="px-1 py-1 text-[12px] text-[var(--cf-text-faint)]">
                    {t("dbml.inspector.noRelations")}
                  </p>
                )}
                {edit && adding === "ref" && (
                  <RefForm
                    schema={schema}
                    from={table}
                    onCancel={() => setAdding(null)}
                    onSave={(from, to, cardinality) => {
                      edit.addRef(from, to, cardinality);
                      setAdding(null);
                    }}
                  />
                )}
                {/* Two labelled runs rather than one list. Both directions were already here and
                    already listed one after the other — what was missing was the word that says
                    which is which, so "does this table point at that one or the other way round"
                    was a question you answered by re-reading the notation. The two labels have
                    existed in the translations since this panel was written. */}
                {outgoing.length > 0 && (
                  <Direction label={t("dbml.inspector.references")}>
                    {outgoing.map((ref) => (
                      <Relation
                        key={`out-${ref.id}`}
                        refer={ref}
                        onHover={onHoverRef}
                        onClick={() => onSelect(ref.to.table)}
                        onRemove={
                          edit && !edit.blocked
                            ? () =>
                                edit.dropRef(
                                  { table: ref.from.table, column: ref.from.fields[0] },
                                  { table: ref.to.table, column: ref.to.fields[0] },
                                )
                            : undefined
                        }
                      />
                    ))}
                  </Direction>
                )}
                {incoming.length > 0 && (
                  <Direction label={t("dbml.inspector.referencedBy")}>
                    {incoming.map((ref) => (
                      <Relation
                        key={`in-${ref.id}`}
                        refer={ref}
                        onHover={onHoverRef}
                        onClick={() => onSelect(ref.from.table)}
                        onRemove={
                          edit && !edit.blocked
                            ? () =>
                                edit.dropRef(
                                  { table: ref.from.table, column: ref.from.fields[0] },
                                  { table: ref.to.table, column: ref.to.fields[0] },
                                )
                            : undefined
                        }
                      />
                    ))}
                  </Direction>
                )}
              </Section>
            )}

            {table && table.indexes.length > 0 && (
              <Section label={t("dbml.inspector.indexes")} count={table.indexes.length}>
                {table.indexes.map((index, at) => (
                  <div key={`${index.name}-${at}`} className="flex min-h-[26px] items-center gap-1.5 px-1">
                    <ListOrdered size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                      {index.columns.join(", ")}
                    </span>
                    {index.unique && <LegendBadge label="U" />}
                  </div>
                ))}
              </Section>
            )}
          </div>
        </>
      )}

      {/* The two footer actions as real buttons — the ghost and danger-ghost recipes, full width —
          rather than lines of 10px text that happened to be clickable. */}
      {id && (onOpen || (edit && (table || asEnum))) && (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-[var(--cf-border)] p-1.5">
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(id)}
              className={buttonClass({ variant: "ghost", className: "w-full justify-start" })}
            >
              <Code2 size={14} className="shrink-0" />
              {t("dbml.goToDefinition")}
            </button>
          )}

          {/* Deleting the whole thing, in the footer rather than the header or behind a fold. The
              header already refuses a third control, a hover row action needs a row and a table
              has none, and a section holding one button is a button you have to unfold to find.
              Outside the scroller, so it is in the same place on a two-column table and on a
              forty-column one — and last, so a destructive control is never the thing directly
              above what you were reaching for. No confirmation, matching this panel's own
              `dropField`/`dropRelation` and the canvas menu: the change is one text edit on
              Monaco's undo stack and in the history panel. */}
          {edit && (table || asEnum) && (
            <div
              // On the wrapper, not the button: a disabled button takes no pointer events, so the
              // reason it is disabled would never be shown on it.
              title={edit.blocked ? edit.blockedReason : undefined}
            >
              <button
                type="button"
                disabled={edit.blocked}
                onClick={() => {
                  edit.dropTable(id);
                  // The selection self-heals once the re-parse notices the id is gone, but that is
                  // a parse debounce away — long enough to read as a panel still describing what
                  // you just deleted.
                  onClose();
                }}
                className={buttonClass({
                  variant: "danger-ghost",
                  className: "w-full justify-start",
                })}
              >
                <Trash2 size={14} className="shrink-0" />
                {t(asEnum ? "dbml.dropEnum" : "dbml.dropTable")}
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * A folding heading, in this panel's own size.
 *
 * `CollapsibleSection`'s `dense` variant rather than a local one, so the fold behaves the way it
 * does everywhere else in the app — including the `action` slot with `expand()`, which is what the
 * "add a column" buttons will hang off.
 *
 * `count` is drawn beside the title rather than folded into it because several of these labels
 * already carry their own number (`{count} columns`), and a section cannot say a number twice.
 */
function Section({
  label,
  count,
  open = false,
  action,
  children,
}: {
  label: string;
  count?: number;
  open?: boolean;
  /** The "+" button, when the panel is editable. Given `expand` so the click both unfolds the
   *  section and opens the form inside it — see `CollapsibleSection`, which explains why. */
  action?: (ctx: { open: boolean; expand: () => void }) => React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-3 first:mt-0">
      <CollapsibleSection
        dense
        defaultOpen={open}
        title={label}
        action={(ctx) => (
          <span className="flex shrink-0 items-center gap-1 pl-1">
            {count !== undefined && (
              <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{count}</span>
            )}
            {action?.(ctx)}
          </span>
        )}
      >
        {children}
      </CollapsibleSection>
    </section>
  );
}

/**
 * One of the three marks, as a real button.
 *
 * A 22px target holding the swatch: a filled dot when it is the current mark and a ring when it is
 * not, so the state is legible without reading a colour against two other colours — which is the
 * thing that stops working for a reader who cannot tell the red from the amber. It used to *be* the
 * 16px circle, which had to be aimed at.
 *
 * The names are in the tooltip rather than on the buttons, and it says the state once one is set —
 * "Marked for removal", and that pressing it again clears it — rather than offering to do again
 * what has already been done. `aria-label` keeps the verb, which is what a pressed toggle is read
 * as.
 */
function MarkSwatch({
  kind,
  on,
  label,
  onClick,
}: {
  kind: DbmlMarkKind;
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <Tooltip
      label={on ? markNamesOf(t)[kind] : label}
      description={on ? t("dbml.mark.clear") : undefined}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={on}
        className={iconButtonClass({ size: "xs" })}
      >
        <span
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full border-2"
          style={{
            borderColor: MARK_COLOUR[kind],
            background: on ? MARK_COLOUR[kind] : "transparent",
          }}
        >
          {on && <Check size={9} className="text-[var(--cf-on-accent)]" strokeWidth={3.5} />}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * A column's review mark: the state and the control, as one dot.
 *
 * # Why one dot and not three swatches
 *
 * The table above gets three swatches because it has one mark and a permanent place in a header
 * that never scrolls. A column has forty siblings in a 236px column, and three swatches on each of
 * them is 120 coloured circles in a panel whose whole design note is about how little of it should
 * be on screen at once. So the three are folded behind the one thing worth drawing per row —
 * *whether this column has been decided about, and which way* — and the menu is where the three
 * live. That also makes the indicator and the control the same target at the same x, which is what
 * lets the column of them be both read and used without the eye leaving the left edge. The dot is
 * 8px and the target around it is the app's 22px floor — it was the dot alone, which is a thing you
 * aim at rather than press.
 *
 * Unmarked, it is invisible until the pointer is on the row (or the keyboard is on the button, or
 * its menu is open). Marked, it is always there — a decision that only shows itself on hover is a
 * decision you have to go looking for.
 */
function FieldMark({
  name,
  current,
  set,
}: {
  name: string;
  current?: DbmlMarkKind;
  set: (mark: DbmlMarkKind | null) => void;
}) {
  const t = useT();
  const [at, setAt] = useState<DOMRect | null>(null);
  // The state when there is one, the offer when there is not: a tooltip on something already marked
  // that reads "Mark for removal" is an offer to do again what has been done.
  const label = current ? markNamesOf(t)[current] : t("dbml.mark.field");

  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={at !== null}
          onClick={(event) =>
            setAt(at ? null : event.currentTarget.getBoundingClientRect())
          }
          className={iconButtonClass({
            size: "xs",
            className:
              current || at ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          })}
        >
          {/* Filled when it is set and a ring when it is not — the same pair `MarkSwatch` uses, so
              the two controls read as one idea, and so the state survives a reader who cannot
              tell the red from the amber. */}
          <span
            className="h-2 w-2 rounded-full border"
            style={{
              borderColor: current ? MARK_COLOUR[current] : "var(--cf-text-muted)",
              background: current ? MARK_COLOUR[current] : "transparent",
            }}
          />
        </button>
      </Tooltip>
      {at && (
        <ContextMenu
          x={at.left}
          y={at.bottom}
          anchor={{ top: at.top, bottom: at.bottom, left: at.left, right: at.right }}
          // Which column, because by the time the menu is open it is covering the row it came from.
          heading={name}
          onClose={() => setAt(null)}
          items={markMenuItems(current, set, t)}
        />
      )}
    </>
  );
}

/**
 * A 22px icon action of this panel, labelled by the app's tooltip.
 *
 * The span between the tooltip and the button is what keeps the label reachable while the button is
 * *disabled*, which is exactly when it matters here — the label is then the reason ("the document
 * does not parse"). A disabled button takes no pointer events (`iconButtonClass` says so), so the
 * pointer lands on the span, which is inside the tooltip's trigger; on the bare button it would land
 * on nothing and the reason would never be shown.
 */
function RowAction({
  label,
  ariaLabel,
  disabled,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  /** The accessible name, when the tooltip is saying something else — a blocked reason. */
  ariaLabel?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <span className="inline-flex shrink-0">
        <button
          type="button"
          aria-label={ariaLabel ?? label}
          disabled={disabled}
          onClick={onClick}
          className={
            danger
              ? "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40"
              : iconButtonClass({ size: "xs" })
          }
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}

/** The "+" on a section header. */
function AddButton({
  title,
  disabled,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <RowAction label={title} disabled={disabled} onClick={onClick}>
      <Plus size={14} />
    </RowAction>
  );
}

/**
 * A name that becomes an input on a double click.
 *
 * Double click rather than a pencil button, to match the canvas box — the same gesture renames a
 * table wherever you are looking at it. Escape abandons, Enter and blur commit, and a commit that
 * did not change anything is dropped before it reaches the document so the history does not fill
 * with revisions that say nothing.
 */
function InlineName({
  value,
  editable,
  title,
  onCommit,
}: {
  value: string;
  editable: boolean;
  title: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // A rename that lands, or a different table arriving, closes the input.
  useEffect(() => setDraft(null), [value]);

  if (draft === null) {
    return (
      <h2
        title={editable ? title : undefined}
        onDoubleClick={editable ? () => setDraft(value) : undefined}
        className={`mt-1 truncate font-mono text-[15px] font-semibold text-[var(--cf-text)] ${
          editable ? "cursor-text" : ""
        }`}
      >
        {value}
      </h2>
    );
  }

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    setDraft(null);
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
      // The field's halo rather than a bare accent edge — the same focus every text field in the
      // app wears — at the name's own size, so the heading does not jump when it turns into one.
      className="mt-1 w-full rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-1.5 py-0.5 font-mono text-[15px] font-semibold text-[var(--cf-text)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] outline-none"
    />
  );
}

/** The table's `note`, as a textarea that commits on blur. */
function NoteField({
  value,
  disabled,
  title,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  title?: string;
  onCommit: (next: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      value={draft}
      disabled={disabled}
      title={title}
      rows={2}
      placeholder={t("dbml.inspector.notePlaceholder")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[12px] leading-snug text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/**
 * The column form, used both to add one and to edit one.
 *
 * One component for both because they collect exactly the same thing, and two would drift the
 * moment a setting was added to one of them. The type field is an `input` with a `datalist` rather
 * than a `Select`: DBML's type is free text — `varchar(120)`, `numeric(10,2)`, an enum name — so a
 * closed list would be wrong, while no list at all throws away the fact that a schema uses six
 * types over and over.
 */
function FieldForm({
  initial,
  types,
  taken,
  onSave,
  onCancel,
}: {
  initial?: FieldEdit;
  types: string[];
  /** The other columns of this table. A name already in here would not parse — see below. */
  taken: string[];
  onSave: (field: FieldEdit) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const listId = useMemo(() => `cf-dbml-types-${Math.random().toString(36).slice(2)}`, []);
  const [field, setField] = useState<FieldEdit>(
    initial ?? { name: "", type: "", pk: false, unique: false, notNull: false },
  );
  const set = (patch: Partial<FieldEdit>) => setField((current) => ({ ...current, ...patch }));

  // Two columns of one name is not a messy table, it is a document that does not parse — so the
  // canvas would go blank on what looked like a successful edit. Refused at the form rather than
  // silently renamed, because unlike the "+" on the canvas this is a name the user typed on
  // purpose, and quietly saving it as `email_2` is not what they asked for.
  const clash =
    field.name.trim().length > 0 &&
    field.name.trim().toLowerCase() !== initial?.name.toLowerCase() &&
    taken.some((name) => name.toLowerCase() === field.name.trim().toLowerCase());

  // Both halves are required: a column with no type is not legal DBML — the parser reads the next
  // line's first word as this one's type — so `addField` declines it outright. Better to say so on
  // the button than to accept the form and silently do nothing.
  const ready = field.name.trim().length > 0 && field.type.trim().length > 0 && !clash;

  const save = () => {
    if (!ready) return;
    onSave({ ...field, name: field.name.trim(), type: field.type.trim() });
  };

  return (
    <div
      className={FORM_CARD}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          save();
        }
        if (event.key === "Escape") onCancel();
      }}
    >
      <input
        autoFocus
        value={field.name}
        onChange={(event) => set({ name: event.target.value })}
        placeholder={t("dbml.inspector.fieldName")}
        aria-invalid={clash}
        // The clash is drawn off `aria-invalid`, which the field already carries for a screen
        // reader — one fact, one attribute, and the recipe's own border is left alone.
        className={fieldClass({
          size: "sm",
          className: "w-full font-mono aria-[invalid=true]:border-[var(--cf-danger)]",
        })}
      />
      {clash && (
        <p className="-mt-0.5 text-[11px] leading-snug text-[var(--cf-danger)]">
          {t("dbml.inspector.nameTaken")}
        </p>
      )}
      <input
        value={field.type}
        list={listId}
        onChange={(event) => set({ type: event.target.value })}
        placeholder={t("dbml.inspector.fieldType")}
        className={fieldClass({ size: "sm", className: "w-full font-mono" })}
      />
      <datalist id={listId}>
        {types.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>

      {/* The column's own `[note: '…']`.
          Third rather than hidden behind a disclosure: it is the only place in the app that note can
          be written, and a column worth documenting is usually documented as it is created. One row,
          so it costs the form a line rather than a section. */}
      <input
        value={field.note ?? ""}
        onChange={(event) => set({ note: event.target.value })}
        placeholder={t("dbml.inspector.fieldNote")}
        className={fieldClass({ size: "sm", className: "w-full" })}
      />

      {/* The flags wear the legend when they are on — a `PK` switched on here is the same amber as
          the `PK` it will become on the row and on the canvas. */}
      <div className="flex flex-wrap items-center gap-1">
        <Toggle
          label="PK"
          hue={LEGEND.PK}
          on={Boolean(field.pk)}
          onClick={() => set({ pk: !field.pk })}
        />
        <Toggle
          label="U"
          hue={LEGEND.U}
          on={Boolean(field.unique)}
          onClick={() => set({ unique: !field.unique })}
        />
        <Toggle
          label={t("dbml.inspector.notNull")}
          hue={LEGEND.NN}
          on={Boolean(field.notNull)}
          onClick={() => set({ notNull: !field.notNull })}
        />
        <Toggle
          label={t("dbml.inspector.increment")}
          hue={LEGEND.AI}
          on={Boolean(field.increment)}
          onClick={() => set({ increment: !field.increment })}
        />
      </div>
      <FormActions onCancel={onCancel} onSave={save} ready={ready} />
    </div>
  );
}

/** Where the two inspector forms sit: a card lifted off the panel, with an accent hairline. */
const FORM_CARD =
  "my-1.5 flex flex-col gap-1.5 rounded-lg border border-[var(--cf-accent-line)] bg-[var(--cf-surface)] p-2";

/** Cancel and Save, worded — they were two 16px glyphs, a tick and a cross, at the form's corner. */
function FormActions({
  onCancel,
  onSave,
  ready,
}: {
  onCancel: () => void;
  onSave: () => void;
  ready: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-0.5 flex items-center justify-end gap-1">
      <button type="button" onClick={onCancel} className={buttonClass({ variant: "ghost", size: "sm" })}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!ready}
        className={buttonClass({ variant: "primary", size: "sm" })}
      >
        <Check size={13} />
        {t("common.save")}
      </button>
    </div>
  );
}

/**
 * One of the column form's flags — an independent switch, not one of a set, so a toggle chip rather
 * than a segment. On, it takes the hue it is given (the legend's, for the four flags), off it is a
 * hairline outline that tints on hover.
 */
function Toggle({
  label,
  on,
  hue = "var(--cf-accent)",
  onClick,
}: {
  label: string;
  on: boolean;
  hue?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex h-[22px] items-center rounded-md px-2 text-[10.5px] font-bold uppercase tracking-[0.03em] transition-colors duration-100 ${
        on
          ? ""
          : "text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      }`}
      style={
        on
          ? {
              color: hue,
              background: `color-mix(in oklab, ${hue} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${hue} 45%, transparent)`,
            }
          : undefined
      }
    >
      {label}
    </button>
  );
}

/**
 * The relationship form: this table's column, the other table, its column.
 *
 * Three `Select`s and not a text field, because unlike a type every part of a relationship is drawn
 * from a closed set the document already contains — and a `Ref:` naming something that does not
 * exist is the one edit here that breaks the whole diagram rather than one row of it.
 */
function RefForm({
  schema,
  from,
  onSave,
  onCancel,
}: {
  schema: DbmlSchema;
  from: NonNullable<ReturnType<typeof tableOf>>;
  onSave: (from: RefEnd, to: RefEnd, cardinality: Cardinality) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [column, setColumn] = useState(from.fields[0]?.name ?? "");
  const others = schema.tables.filter((entry) => entry.id !== from.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const targetTable = schema.tables.find((entry) => entry.id === target);
  const [targetColumn, setTargetColumn] = useState("");
  const [cardinality, setCardinality] = useState<Cardinality>(">");

  // The chosen column has to belong to the chosen table; picking a new table invalidates it.
  useEffect(() => {
    setTargetColumn(
      targetTable?.fields.find((field) => field.pk)?.name ?? targetTable?.fields[0]?.name ?? "",
    );
  }, [targetTable]);

  if (others.length === 0) {
    return (
      <p className="px-1 py-1 text-[12px] text-[var(--cf-text-faint)]">
        {t("dbml.inspector.needTwo")}
      </p>
    );
  }

  return (
    <div className={FORM_CARD} onKeyDown={(event) => event.key === "Escape" && onCancel()}>
      <Select
        size="sm"
        ariaLabel={t("dbml.inspector.fromColumn")}
        value={column}
        onChange={setColumn}
        options={from.fields.map((field) => ({ value: field.name, label: field.name }))}
      />
      {/* The four arrows are one choice out of four, so the segmented control rather than four
          toggles that happened to exclude each other. One form is open at a time, so the thumb's
          id cannot meet itself on screen. */}
      <Segmented
        size="sm"
        full
        layoutId="dbml-ref-cardinality"
        value={cardinality}
        onChange={setCardinality}
        options={(["<", ">", "-", "<>"] as Cardinality[]).map((mark) => ({
          value: mark,
          label: <span className="font-mono">{mark}</span>,
        }))}
      />
      <Select
        size="sm"
        ariaLabel={t("dbml.inspector.toTable")}
        value={target}
        onChange={setTarget}
        options={others.map((entry) => ({ value: entry.id, label: entry.name }))}
      />
      <Select
        size="sm"
        ariaLabel={t("dbml.inspector.toColumn")}
        value={targetColumn}
        onChange={setTargetColumn}
        options={(targetTable?.fields ?? []).map((field) => ({
          value: field.name,
          label: field.name,
        }))}
      />
      <FormActions
        onCancel={onCancel}
        ready={Boolean(column && targetTable && targetColumn)}
        onSave={() =>
          targetTable &&
          onSave(
            { table: from.name, column },
            { table: targetTable.name, column: targetColumn },
            cardinality,
          )
        }
      />
    </div>
  );
}

/** The "references" / "referenced by" run inside the relations section. */
function Direction({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5 first:mt-0">
      <p className="mb-0.5 pl-1 text-[11px] text-[var(--cf-text-faint)]">{label}</p>
      {children}
    </div>
  );
}

/**
 * One column.
 *
 * The row itself is name, badges, type — one line, always. What the column *documents* about itself
 * (its `[note: '…']` and its `[default: …]`) hangs off a disclosure at the end of the row instead of
 * appearing under it, because those two lines used to be charged to the whole table: a schema whose
 * author documented their columns properly was the one whose panel you could not read.
 *
 * The button is only drawn when there is something behind it, so a row without it is a row with
 * nothing more to say — which makes the glyph itself worth scanning for.
 */
function FieldRow({
  field,
  types,
  mark,
  edit,
}: {
  field: {
    name: string;
    type: string;
    pk: boolean;
    unique: boolean;
    notNull: boolean;
    increment: boolean;
    note: string;
    default: string | null;
  };
  types: string[];
  /** This column's review mark and how to change it. Absent on the read-only callers. */
  mark?: {
    current?: DbmlMarkKind;
    set: (mark: DbmlMarkKind | null) => void;
  };
  edit?: {
    blocked: boolean;
    blockedReason: string;
    /** Every column of this table, this one included — the form drops its own before checking. */
    siblings: string[];
    save: (next: FieldEdit) => void;
    remove: () => void;
  };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const hasDetail = Boolean(field.note) || field.default !== null;

  // The row is rebuilt from the document after a save, so leaving the form open would show a
  // second copy of what is now the row above it.
  useEffect(
    () => setEditing(false),
    [field.name, field.type, field.pk, field.unique, field.notNull, field.increment, field.note],
  );

  if (editing && edit) {
    return (
      <FieldForm
        types={types}
        taken={edit.siblings}
        // Every setting the column has, including the ones the form shows no control for. What is
        // handed in here is what comes back out, so anything missing from this object is silently
        // deleted by an edit that never mentioned it — `increment` was, until it was not.
        initial={{
          name: field.name,
          type: field.type,
          pk: field.pk,
          unique: field.unique,
          notNull: field.notNull,
          increment: field.increment,
          default: field.default,
          note: field.note,
        }}
        onCancel={() => setEditing(false)}
        onSave={(next) => {
          edit.save(next);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="group">
      <div className="relative flex min-h-[26px] items-center gap-1">
        {/* The review mark, as one 8px circle in a slot every row reserves.
            Held *before* the name, and it is the only thing in this panel that is: a column of dots
            down the left edge is the shape you can read forty rows of at a glance, which is the
            entire question this feature answers ("which of these still need looking at"). Anywhere
            else on the row it would land at a different x on every line, because the type column
            that precedes it is as wide as each type happens to be.
            The slot is reserved whether or not this column is marked — a steady indent is cheaper
            than a list of names that jogs sideways as marks are set — and on an unmarked row it is
            empty until the pointer is on the row. */}
        {mark && <FieldMark name={field.name} current={mark.current} set={mark.set} />}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px]"
          style={{
            color: field.pk ? LEGEND.PK : undefined,
            fontStyle: field.notNull || field.pk ? undefined : "italic",
            // Struck through when it is going, which is the one mark that needs no legend — the
            // same treatment the canvas gives the same column, and the table's name above it.
            textDecoration: mark?.current === "remove" ? "line-through" : undefined,
            textDecorationColor: mark?.current === "remove" ? MARK_COLOUR.remove : undefined,
            opacity:
              mark?.current === "remove" ? 0.55 : field.notNull || field.pk ? 1 : 0.7,
          }}
        >
          {field.name}
        </span>
        {/* The legend's own chips, in the canvas's order — see `LEGEND`. */}
        {field.pk && <LegendBadge label="PK" />}
        {field.unique && !field.pk && <LegendBadge label="U" />}
        {/* Text, not a pill — see the note on this component. Right-aligned so the types line up
            into a column of their own, which is the shape that makes them skimmable. */}
        {field.type && (
          <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
            {field.type}
          </span>
        )}
        {hasDetail && (
          <Tooltip label={t("dbml.inspector.detail")}>
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-label={t("dbml.inspector.detail")}
              aria-expanded={open}
              className={iconButtonClass({ size: "xs" })}
            >
              <ChevronDown
                size={13}
                className="transition-transform"
                style={{ transform: open ? "rotate(180deg)" : undefined }}
              />
            </button>
          </Tooltip>
        )}
        {/* The two row actions appear on hover, laid *over* the end of the row rather than beside
            it. At the 22px every target in the app is now, two of them held in reserve on every row
            would take a fifth of a 236px panel away from the names; over the type column they cost
            nothing, and nothing moves sideways as the pointer runs down the list, which is what the
            reserved width used to buy. The fade behind them is the panel's own tone, so the type
            under them is covered rather than overprinted. Left of the disclosure, which has to stay
            pressable on a hovered row. */}
        {edit && (
          <span
            className="absolute inset-y-0 flex items-center gap-0.5 pl-5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
            style={{
              right: hasDetail ? 22 : 0,
              background:
                "linear-gradient(to right, transparent, color-mix(in oklab, var(--cf-sunken) 55%, var(--cf-surface)) 16px)",
            }}
          >
            <RowAction
              label={edit.blocked ? edit.blockedReason : t("dbml.inspector.editField")}
              ariaLabel={t("dbml.inspector.editField")}
              disabled={edit.blocked}
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} />
            </RowAction>
            <RowAction
              label={edit.blocked ? edit.blockedReason : t("dbml.inspector.dropField")}
              ariaLabel={t("dbml.inspector.dropField")}
              disabled={edit.blocked}
              danger
              onClick={edit.remove}
            >
              <Trash2 size={13} />
            </RowAction>
          </span>
        )}
      </div>
      {open && (
        <div
          className={`mb-1 mt-0.5 border-l border-[var(--cf-border)] pl-2 ${mark ? "ml-[26px]" : ""}`}
        >
          {field.note && (
            <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{field.note}</p>
          )}
          {field.default !== null && (
            <p className="font-mono text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("dbml.inspector.default", { value: field.default })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One relationship, as a button: the whole point is that it takes you to the other end.
 *
 * Written in DBML's own notation — `users.id < posts.author_id`, the one side first and the `<`
 * opening towards the many side — rather than as an arrow between two halves. It is the same
 * sentence the document itself contains, so reading it here and reading the `Ref:` line in the
 * editor do not require translating between two ways of saying it.
 */
function Relation({
  refer,
  onClick,
  onRemove,
  onHover,
}: {
  refer: DbmlRef;
  onClick: () => void;
  onRemove?: () => void;
  /** Lights this relationship on the canvas while the pointer is on the row. */
  onHover?: (id: string | null) => void;
}) {
  const t = useT();
  const [one, many] =
    refer.from.relation === "1" ? [refer.from, refer.to] : [refer.to, refer.from];
  const side = (end: typeof one) => `${end.table}.${end.fields.join(", ")}`;
  return (
    // A row rather than a button, now that there are two things to click on it: a button inside a
    // button is invalid, and the walk-the-schema click is still the whole width of the label.
    <div
      // `pointerenter`/`pointerleave` rather than `mouseover`/`mouseout`: those bubble from the two
      // buttons inside the row, so moving between the label and the delete icon would report a
      // leave and re-light the whole neighbourhood for a frame.
      onPointerEnter={() => onHover?.(refer.id)}
      onPointerLeave={() => onHover?.(null)}
      className="group/rel flex min-h-[26px] w-full items-center gap-1.5 rounded-md pl-1 transition-colors duration-100 hover:bg-[var(--cf-hover)]"
    >
      {/* In the accent, like the line it names on the canvas: a relationship is the one thing on
          that canvas the accent is for. */}
      <Link2 size={13} className="shrink-0 text-[var(--cf-accent)]" />
      <button
        type="button"
        onClick={onClick}
        title={`${side(one)} < ${side(many)}`}
        className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-[var(--cf-text-muted)] transition-colors group-hover/rel:text-[var(--cf-text)]"
      >
        {side(one)} <span className="text-[var(--cf-accent)]">&lt;</span> {side(many)}
      </button>
      {onRemove && (
        <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/rel:opacity-100">
          <RowAction label={t("dbml.inspector.dropRelation")} danger onClick={onRemove}>
            <Trash2 size={13} />
          </RowAction>
        </span>
      )}
    </div>
  );
}
