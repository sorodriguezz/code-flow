import { Link2, ListOrdered, MousePointerClick, Pin, X } from "lucide-react";
import {
  groupOfTable,
  neighboursOf,
  tableOf,
  type DbmlRef,
  type DbmlSchema,
} from "../../lib/dbml/types";
import { ICON_BUTTON } from "../diagrams/diagramsChrome";
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
 */
export function DbmlInspector({
  schema,
  id,
  onSelect,
  onClose,
  onOpen,
  pinned = false,
  onTogglePin,
  width,
}: {
  schema: DbmlSchema;
  /** The selected table or enum. `null` draws the empty state. */
  id: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Jumps to the declaration in the editor. */
  onOpen?: (id: string) => void;
  /** Held: the canvas can no longer change what is being read. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Set by the workbench, which owns the seam. Omitted by the read-only callers, which have none. */
  width?: number;
}) {
  const t = useT();
  const table = id ? tableOf(schema, id) : null;
  const asEnum = id ? schema.enums.find((entry) => entry.id === id) : null;

  const outgoing = id ? schema.refs.filter((ref) => ref.from.table === id) : [];
  const incoming = id ? schema.refs.filter((ref) => ref.to.table === id) : [];
  const related = id ? neighboursOf(schema, id).tables.size : 0;
  const group = id ? groupOfTable(schema, id) : undefined;

  return (
    <aside
      style={{ width: width ?? 236 }}
      className="flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2.5 py-[7px]">
        <span className="min-w-0 flex-1 truncate text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
          {t("dbml.inspector.title")}
        </span>
        {id && onTogglePin && (
          <button
            type="button"
            className={ICON_BUTTON}
            style={pinned ? { color: "var(--cf-accent)" } : undefined}
            title={t(pinned ? "dbml.inspector.unpin" : "dbml.inspector.pin")}
            aria-label={t(pinned ? "dbml.inspector.unpin" : "dbml.inspector.pin")}
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            {/* One glyph in two states rather than two glyphs: a crossed-out pin on the button
                that *applies* the pin reads as "pinning is off limits here". */}
            <Pin size={12} fill={pinned ? "currentColor" : "none"} />
          </button>
        )}
        {id && (
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("dbml.inspector.close")}
            aria-label={t("dbml.inspector.close")}
            onClick={onClose}
          >
            <X size={12} />
          </button>
        )}
      </header>

      {!table && !asEnum ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <MousePointerClick size={18} className="text-[var(--cf-text-muted)] opacity-60" />
          <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("dbml.selectHint")}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2.5">
          <p className="text-[9px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
            {t(asEnum ? "dbml.inspector.enum" : "dbml.inspector.table")}
          </p>
          <h2 className="mt-0.5 truncate font-mono text-[14px] font-semibold text-[var(--cf-text)]">
            {table ? table.name : asEnum?.name}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--cf-text-muted)]">
            {related > 0 && <span>{t("dbml.relatedCount", { count: String(related) })}</span>}
            {group && (
              <span className="rounded bg-[var(--cf-text-muted)]/15 px-1.5 py-[1px] font-mono text-[9.5px]">
                {group.name}
              </span>
            )}
            {pinned && (
              <span className="text-[9.5px] uppercase tracking-wide text-[var(--cf-accent)]">
                {t("dbml.inspector.pinned")}
              </span>
            )}
          </p>

          {table?.note && (
            <Section label={t("dbml.inspector.note")}>
              <p className="whitespace-pre-wrap rounded-md bg-[var(--cf-field)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {table.note}
              </p>
            </Section>
          )}

          {asEnum && (
            <Section label={t("dbml.inspector.valuesCount", { count: String(asEnum.values.length) })}>
              {asEnum.values.map((value) => (
                <div key={value.name} className="flex items-center gap-2 py-[3px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{value.name}</span>
                  {value.note && (
                    <span className="max-w-[50%] truncate text-[9.5px] text-[var(--cf-text-muted)]">
                      {value.note}
                    </span>
                  )}
                </div>
              ))}
            </Section>
          )}

          {table && (
            <Section label={t("dbml.inspector.fieldsCount", { count: String(table.fields.length) })}>
              {table.fields.map((field) => (
                <div key={field.name} className="py-[3px]">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px]"
                      style={{
                        color: field.pk ? "var(--cf-warning)" : undefined,
                        fontStyle: field.notNull || field.pk ? undefined : "italic",
                        opacity: field.notNull || field.pk ? 1 : 0.7,
                      }}
                    >
                      {field.name}
                    </span>
                    {field.pk && <Badge label="PK" tone="key" />}
                    {field.unique && !field.pk && <Badge label="U" tone="unique" />}
                    {field.type && <Badge label={field.type} tone="type" />}
                  </div>
                  {/* The `[note: '…']` on the column. This panel is the only place it is ever
                      readable: on the canvas the row is a name, a type and its badges, and there is
                      no width left for a sentence — which is why a note written in the document used
                      to be invisible everywhere but the document. */}
                  {field.note && (
                    <p className="mt-[1px] border-l border-[var(--cf-border)] pl-1.5 text-[9.5px] leading-snug text-[var(--cf-text-muted)]">
                      {field.note}
                    </p>
                  )}
                  {field.default !== null && (
                    <p className="mt-[1px] pl-1.5 font-mono text-[9.5px] leading-snug text-[var(--cf-text-muted)]">
                      {t("dbml.inspector.default", { value: field.default })}
                    </p>
                  )}
                </div>
              ))}
            </Section>
          )}

          {table && (
            <Section label={t("dbml.inspector.relations")}>
              {outgoing.length === 0 && incoming.length === 0 && (
                <p className="py-1 text-[10.5px] text-[var(--cf-text-muted)]">
                  {t("dbml.inspector.noRelations")}
                </p>
              )}
              {outgoing.map((ref) => (
                <Relation key={`out-${ref.id}`} refer={ref} onClick={() => onSelect(ref.to.table)} />
              ))}
              {incoming.map((ref) => (
                <Relation key={`in-${ref.id}`} refer={ref} onClick={() => onSelect(ref.from.table)} />
              ))}
            </Section>
          )}

          {table && table.indexes.length > 0 && (
            <Section label={t("dbml.inspector.indexes")}>
              {table.indexes.map((index, at) => (
                <div key={`${index.name}-${at}`} className="flex items-center gap-1.5 py-[3px]">
                  <ListOrdered size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                    {index.columns.join(", ")}
                  </span>
                  {index.unique && <Badge label="U" tone="unique" />}
                </div>
              ))}
            </Section>
          )}
        </div>
      )}

      {onOpen && id && (
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="shrink-0 border-t border-[var(--cf-border)] px-2.5 py-1.5 text-left text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
        >
          {t("dbml.goToDefinition")}
        </button>
      )}
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 first:mt-2">
      <h3 className="mb-1 text-[9px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
        {label}
      </h3>
      {children}
    </section>
  );
}

/**
 * The same chips the canvas draws on a row, in HTML.
 *
 * Tinted rather than flooded, and to the same three tones, for the same reason the canvas's are:
 * the badge on a box and the badge in this panel describe one column, and two treatments of that
 * would make the reader check whether they mean the same thing.
 */
function Badge({ label, tone }: { label: string; tone: "key" | "unique" | "type" }) {
  if (tone === "type") {
    return (
      <span className="shrink-0 rounded bg-[var(--cf-text-muted)]/15 px-1.5 py-[1px] font-mono text-[9.5px] text-[var(--cf-text-muted)]">
        {label}
      </span>
    );
  }
  const hue = tone === "key" ? "var(--cf-warning)" : "var(--cf-violet)";
  return (
    <span
      className="shrink-0 rounded border px-1.5 py-[1px] text-[8.5px] font-bold"
      style={{
        color: hue,
        borderColor: `color-mix(in oklab, ${hue} 40%, transparent)`,
        background: `color-mix(in oklab, ${hue} 18%, transparent)`,
      }}
    >
      {label}
    </span>
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
function Relation({ refer, onClick }: { refer: DbmlRef; onClick: () => void }) {
  const [one, many] =
    refer.from.relation === "1" ? [refer.from, refer.to] : [refer.to, refer.from];
  const side = (end: typeof one) => `${end.table}.${end.fields.join(", ")}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${side(one)} < ${side(many)}`}
      className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors hover:bg-[var(--cf-accent-soft)]"
    >
      <Link2 size={10} className="shrink-0 text-[var(--cf-accent)]" />
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
        {side(one)} <span className="text-[var(--cf-accent)]">&lt;</span> {side(many)}
      </span>
    </button>
  );
}
