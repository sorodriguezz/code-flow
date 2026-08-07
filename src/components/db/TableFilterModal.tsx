import { useState } from "react";
import { Filter } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { INPUT, Row } from "./dbChrome";
import { useDbStore, parseSpec } from "../../state/dbStore";
import { useT } from "../../state/languageStore";

/** The two things a filter can be about. A schema is offered only when one was right-clicked. */
type Scope = "schema" | "connection";

/**
 * The name filter over tables, views and routines — written from the tree.
 *
 * **Why it is not only in the connection dialog.** It was, and that is the problem: the field lives
 * on the Schemas tab, three levels into Data sources, and the moment you want it is the moment you
 * are looking at ninety tables you did not come for. This is the same setting, reachable from the
 * thing it is about.
 *
 * **Why the scope is a choice and not an assumption.** The gesture is a right-click on one schema,
 * so that is what the dialog opens on. But the pattern people write first is usually `tmp_*` or
 * `!bkp_*` — noise that every schema in the database has — and making them repeat it per schema
 * would be the wrong default in the other direction. Both are one radio apart, and the summary
 * under the field says which one is about to be written.
 */
export function ObjectFilterModal({
  connectionId,
  schema,
  onClose,
}: {
  connectionId: string;
  /** The schema the menu was opened on, or `null` when it was opened for the connection. */
  schema: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const row = useDbStore((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  const setObjectFilter = useDbStore((s) => s.setObjectFilter);
  const config = row ? parseSpec(row) : null;

  const override = config?.schema_object_filters.find(
    (entry) => entry.schema.toLowerCase() === schema?.toLowerCase(),
  );
  // Opens on the schema when one was right-clicked, and on the connection otherwise — except when
  // that schema has no filter of its own and the connection does, where the thing the user is
  // looking at is the connection's pattern and editing a copy of it under the schema would be a
  // surprise.
  const [scope, setScope] = useState<Scope>(
    schema === null || (!override && config?.object_filter) ? "connection" : "schema",
  );
  const [pattern, setPattern] = useState(
    (schema !== null && override ? override.pattern : config?.object_filter) ?? "",
  );
  const [busy, setBusy] = useState(false);

  if (!config) return null;

  const target = scope === "schema" && schema !== null ? schema : null;

  /** Moving the radio swaps in whatever that scope currently holds, so the field always shows the
   * value that is about to be overwritten rather than one carried over from the other scope. */
  const pick = (next: Scope) => {
    setScope(next);
    setPattern(
      (next === "schema" && schema !== null ? override?.pattern : config.object_filter) ?? "",
    );
  };

  const apply = async (value: string) => {
    setBusy(true);
    await setObjectFilter(connectionId, target, value);
    setBusy(false);
    onClose();
  };

  return (
    <ApiModal
      icon={Filter}
      title={t("db.objectFilter")}
      subtitle={row?.name}
      width="max-w-md"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          {/* Its own button rather than "save an empty box": clearing is the action people come
              back for, and it should not require selecting text first. */}
          <GhostButton onClick={() => void apply("")}>{t("db.objectFilterClear")}</GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <button
            onClick={() => void apply(pattern)}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            {t("db.objectFilterApply")}
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        {schema !== null && (
          <Row label={t("db.objectFilterScope")}>
            <div className="flex gap-1 rounded-md border border-[var(--cf-border)] p-0.5">
              {([
                { id: "schema" as const, label: t("db.objectFilterOnlySchema", { name: schema }) },
                { id: "connection" as const, label: t("db.objectFilterWholeConnection") },
              ]).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => pick(option.id)}
                  aria-pressed={scope === option.id}
                  className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-[12px] font-medium ${
                    scope === option.id
                      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                      : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Row>
        )}

        <Row label={t("db.objectFilterPattern")} hint={t("db.objectFilterGrammar")}>
          <input
            autoFocus
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply(pattern);
            }}
            placeholder={t("db.objectFilterPlaceholder")}
            className={INPUT}
          />
        </Row>

        {/* What the tree will do, in the tense it will do it in. The field alone can't say whether
            `App*` is about to narrow one schema or all of them. */}
        <p className="text-[11px] text-[var(--cf-text-muted)]">
          {pattern.trim()
            ? target
              ? t("db.objectFilterSummarySchema", { name: target, pattern: pattern.trim() })
              : t("db.objectFilterSummaryConnection", { pattern: pattern.trim() })
            : target
              ? t("db.objectFilterEmptySchema", { name: target })
              : t("db.objectFilterEmptyConnection")}
        </p>

        {/* Overrides written from other schemas, so a tree filtered somewhere the user is not
            looking is still explainable from here rather than only from the Schemas tab. */}
        {config.schema_object_filters.length > 0 && (
          <div className="rounded-md border border-[var(--cf-border)]">
            <p className="border-b border-[var(--cf-border)] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("db.objectFilterPerSchema")}
            </p>
            <ul className="max-h-32 overflow-y-auto">
              {config.schema_object_filters.map((entry) => (
                <li
                  key={entry.schema}
                  className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1 text-[12px] last:border-b-0"
                >
                  <span className="min-w-0 truncate font-medium text-[var(--cf-text)]">
                    {entry.schema}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                    {entry.pattern}
                  </span>
                  <button
                    onClick={() => void setObjectFilter(connectionId, entry.schema, "")}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
                  >
                    {t("db.objectFilterRemove")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ApiModal>
  );
}
