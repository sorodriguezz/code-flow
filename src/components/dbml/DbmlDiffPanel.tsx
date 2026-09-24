import { useMemo, useState } from "react";
import { ArrowLeftRight, Minus, Pencil, Plus } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { diffSchemas, type DiffStatus, type SchemaDiff } from "../../lib/dbml/diff";
import type { DbmlSchema } from "../../lib/dbml/types";
import { TOOL_AREA, ToolClose } from "./toolChrome";
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
  onClose,
}: {
  schema: DbmlSchema;
  /** The parser, handed down so the heavy chunk stays owned by the workbench. */
  parse: (source: string) => DbmlSchema;
  /** Closes the tool. This panel has no row of actions of its own, so it sits in the corner the
   *  other two put it in — top right, over the list rather than beside a verb. */
  onClose: () => void;
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
      <div className="flex min-h-0 w-[38%] shrink-0 flex-col gap-2 border-r border-[var(--cf-border)] p-3">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[13px] font-medium text-[var(--cf-text)]">{t("dbml.diff.other")}</span>
          <span className="flex-1" />
          {/* A toggle, and drawn as one: lit while the pasted side is the *after*. It used to look
              the same either way, so which reading the list was in had to be remembered. */}
          <Tooltip label={t("dbml.diff.swap")}>
            <button
              type="button"
              onClick={() => setSwapped((current) => !current)}
              aria-label={t("dbml.diff.swap")}
              aria-pressed={swapped}
              className={iconButtonClass({ size: "md", active: swapped })}
            >
              <ArrowLeftRight size={15} />
            </button>
          </Tooltip>
        </div>
        <textarea
          value={other}
          onChange={(event) => setOther(event.target.value)}
          spellCheck={false}
          placeholder={t("dbml.diff.placeholder")}
          className={`${TOOL_AREA} min-h-0 flex-1 resize-none font-mono leading-relaxed`}
        />
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto p-3 pr-12">
        <div className="absolute right-3 top-2 z-10">
          <ToolClose onClose={onClose} />
        </div>
        {diff === null ? (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("dbml.diff.empty")}</p>
        ) : !diff.changed ? (
          <p className="text-[12px] text-[var(--cf-success)]">{t("dbml.diff.noChanges")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-[var(--cf-text-muted)]">
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
                  <div key={table.id} className="rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <StatusMark status={table.status} />
                      <span className="font-mono text-[12px] font-semibold">{table.name}</span>
                      <span className="text-[11px] text-[var(--cf-text-faint)]">
                        {t(`dbml.diff.${table.status}` as "dbml.diff.added")}
                      </span>
                    </div>
                    {table.fields
                      .filter((field) => field.status !== "unchanged")
                      .map((field) => (
                        <div key={field.name} className="mt-1 flex items-baseline gap-1.5 pl-5">
                          <StatusMark status={field.status} />
                          <span className="font-mono text-[12px]">{field.name}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
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
                      <span className="font-mono text-[12px]">{entry.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
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
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{ref.key}</span>
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
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** The one-glyph statement of what happened, in the colour the rest of the app uses for it. */
function StatusMark({ status }: { status: DiffStatus }) {
  if (status === "added") return <Plus size={13} className="shrink-0 text-[var(--cf-success)]" />;
  if (status === "removed") return <Minus size={13} className="shrink-0 text-[var(--cf-danger)]" />;
  if (status === "modified") return <Pencil size={12} className="shrink-0 text-[var(--cf-warning)]" />;
  return <span className="w-[13px] shrink-0" />;
}
