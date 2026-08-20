import { useMemo, useState } from "react";
import { ArrowLeftRight, Minus, Pencil, Plus } from "lucide-react";
import { INPUT } from "../db/dbChrome";
import { diffSchemas, type DiffStatus, type SchemaDiff } from "../../lib/dbml/diff";
import type { DbmlSchema } from "../../lib/dbml/types";
import { useT } from "../../state/languageStore";

/**
 * This schema against another one.
 *
 * The question is "what would this migration do", and a text diff cannot answer it: two documents
 * that declare the same thing in a different order, or with the settings written the other way
 * round, produce pages of red and green and no information. `diffSchemas` compares the *models*, so
 * what is listed here is only what actually changed about the database.
 *
 * The pasted side is the **before** by default — you are usually comparing what is deployed against
 * what you are writing — and the swap button is there because the other reading is just as common
 * when reviewing somebody else's change.
 */
export function DbmlDiffPanel({
  schema,
  parse,
}: {
  schema: DbmlSchema;
  /** The parser, handed down so the heavy chunk stays owned by the workbench. */
  parse: (source: string) => DbmlSchema;
}) {
  const t = useT();
  const [other, setOther] = useState("");
  const [swapped, setSwapped] = useState(false);

  const diff = useMemo<SchemaDiff | null>(() => {
    if (!other.trim()) return null;
    const parsed = parse(other);
    return swapped ? diffSchemas(schema, parsed) : diffSchemas(parsed, schema);
  }, [other, parse, schema, swapped]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 w-[38%] shrink-0 flex-col gap-1.5 border-r border-[var(--cf-border)] p-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] font-medium">{t("dbml.diff.other")}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setSwapped((current) => !current)}
            title={t("dbml.diff.swap")}
            aria-label={t("dbml.diff.swap")}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-[3px] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            <ArrowLeftRight size={11} />
          </button>
        </div>
        <textarea
          value={other}
          onChange={(event) => setOther(event.target.value)}
          spellCheck={false}
          placeholder={t("dbml.diff.placeholder")}
          className={`${INPUT} min-h-0 flex-1 resize-none font-mono text-[11.5px] leading-relaxed`}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {diff === null ? (
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("dbml.diff.empty")}</p>
        ) : !diff.changed ? (
          <p className="text-[11.5px] text-[var(--cf-success)]">{t("dbml.diff.noChanges")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[10.5px] text-[var(--cf-text-muted)]">
              {t("dbml.diff.summary", {
                added: String(diff.counts.added),
                modified: String(diff.counts.modified),
                removed: String(diff.counts.removed),
              })}
            </p>

            <Group label={t("dbml.diff.tables")}>
              {diff.tables
                .filter((table) => table.status !== "unchanged")
                .map((table) => (
                  <div key={table.id} className="rounded-md border border-[var(--cf-border)] p-1.5">
                    <div className="flex items-center gap-1.5">
                      <StatusMark status={table.status} />
                      <span className="font-mono text-[11.5px] font-medium">{table.name}</span>
                      <span className="text-[10px] text-[var(--cf-text-muted)]">
                        {t(`dbml.diff.${table.status}` as "dbml.diff.added")}
                      </span>
                    </div>
                    {table.fields
                      .filter((field) => field.status !== "unchanged")
                      .map((field) => (
                        <div key={field.name} className="mt-1 flex items-baseline gap-1.5 pl-4">
                          <StatusMark status={field.status} />
                          <span className="font-mono text-[11px]">{field.name}</span>
                          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--cf-text-muted)]">
                            {field.changes
                              .map((change) => `${change.property}: ${change.before} → ${change.after}`)
                              .join(" · ")}
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
            </Group>

            {diff.enums.some((entry) => entry.status !== "unchanged") && (
              <Group label={t("dbml.diff.enums")}>
                {diff.enums
                  .filter((entry) => entry.status !== "unchanged")
                  .map((entry) => (
                    <div key={entry.id} className="flex items-baseline gap-1.5">
                      <StatusMark status={entry.status} />
                      <span className="font-mono text-[11.5px]">{entry.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--cf-text-muted)]">
                        {[
                          ...entry.added.map((value) => `+${value}`),
                          ...entry.removed.map((value) => `−${value}`),
                        ].join(" ")}
                      </span>
                    </div>
                  ))}
              </Group>
            )}

            {diff.refs.length > 0 && (
              <Group label={t("dbml.diff.relations")}>
                {diff.refs.map((ref) => (
                  <div key={`${ref.status}-${ref.key}`} className="flex items-baseline gap-1.5">
                    <StatusMark status={ref.status} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{ref.key}</span>
                  </div>
                ))}
              </Group>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[9.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** The one-glyph statement of what happened, in the colour the rest of the app uses for it. */
function StatusMark({ status }: { status: DiffStatus }) {
  if (status === "added") return <Plus size={11} className="shrink-0 text-[var(--cf-success)]" />;
  if (status === "removed") return <Minus size={11} className="shrink-0 text-[var(--cf-danger)]" />;
  if (status === "modified") return <Pencil size={10} className="shrink-0 text-[var(--cf-warning)]" />;
  return <span className="w-[11px] shrink-0" />;
}
