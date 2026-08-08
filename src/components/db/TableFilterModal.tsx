import { useMemo, useState } from "react";
import { Filter, Plus, Trash2, X } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { INPUT } from "./dbChrome";
import {
  formatFilterTerms,
  parseFilterTerms,
  type FilterTerms,
} from "../../lib/db/objectFilter";
import { useDbStore, parseSpec } from "../../state/dbStore";
import { useT } from "../../state/languageStore";
import {
  engineInfo,
  sameFilterTarget,
  type DbFilterTarget,
  type DbNodeKind,
} from "../../types/database";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The filter on one thing.
 *
 * **The scope is not a question this dialog asks.** It was answered by the right-click that opened
 * it: on a connection this is the schema list, on a schema it is everything in that schema, on the
 * Tables folder it is that schema's tables and nothing else. An earlier version offered tabs and a
 * scope toggle, which meant every filter took two decisions — one with the pointer and one with a
 * radio that could disagree with it. What is left is one switch and two lists.
 *
 * **Why two lists instead of one box.** The stored form is a single pattern — `app_*, !tmp_*` — and
 * it stays that way. But the two halves of it do opposite things, and the character that says which
 * is which is one `!` wide, at the front of a term, in a comma-separated line that may be sixty
 * characters long. Split into *include* and *exclude*, the same filter says what it does before you
 * have finished reading it.
 *
 * **Why Enable is not the same as Clear.** The question this dialog exists to answer is usually "is
 * a filter the reason I can't see that table?" — and the way to answer it is to switch the filter
 * off and look. Clearing answers it too, by destroying the terms that took ten minutes to get right.
 * Off keeps them.
 */
export function ObjectFilterModal({
  connectionId,
  target,
  onClose,
}: {
  connectionId: string;
  target: DbFilterTarget;
  onClose: () => void;
}) {
  const t = useT();
  const row = useDbStore((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  const setFilter = useDbStore((s) => s.setFilter);
  const config = useMemo(() => (row ? parseSpec(row) : null), [row]);
  /** Whether the level under a database is called a schema. Mongo has no schema level at all — a
   * database lists collections — and the same filter narrows them, so only the word changes. */
  const sql = row ? engineInfo(row.kind).sql : true;

  /** The stored pattern and flag for exactly this target — the only two values the dialog edits. */
  const stored = useMemo(() => {
    if (!config) return { pattern: "", enabled: true };
    if (target.kind === "schemas") {
      return { pattern: config.schema_filter, enabled: config.schema_filter_enabled };
    }
    if (target.schema === null) {
      return { pattern: config.object_filter, enabled: config.object_filter_enabled };
    }
    const entry = config.schema_object_filters.find((candidate) =>
      sameFilterTarget(
        { kind: "objects", schema: candidate.schema, folder: candidate.folder ?? null },
        target,
      ),
    );
    return { pattern: entry?.pattern ?? "", enabled: entry?.enabled ?? true };
  }, [config, target]);

  const [terms, setTerms] = useState<FilterTerms>(() => parseFilterTerms(stored.pattern));
  const [enabled, setEnabled] = useState(stored.enabled);
  const [busy, setBusy] = useState(false);

  /**
   * Every *other* filter on this connection, as sentences.
   *
   * Read-only, and the one thing on screen that is not about the target. Without it the dialog would
   * claim to hold a connection's visibility while quietly not showing a filter set somewhere else —
   * and a schema listing three of its ninety tables for no visible reason is the worst bug this
   * feature could have. Now that a filter can sit on a folder, that is easier to hit, not harder.
   */
  const others = useMemo(() => {
    if (!config) return [];
    const out: { label: string; pattern: string; enabled: boolean; target: DbFilterTarget }[] = [];
    const add = (
      candidate: DbFilterTarget,
      pattern: string,
      isEnabled: boolean,
      label: string,
    ) => {
      if (!pattern.trim() || sameFilterTarget(candidate, target)) return;
      out.push({ label, pattern, enabled: isEnabled, target: candidate });
    };
    add(
      { kind: "schemas" },
      config.schema_filter,
      config.schema_filter_enabled,
      t(sql ? "db.filterOnSchemas" : "db.filterOnCollections"),
    );
    add(
      { kind: "objects", schema: null, folder: null },
      config.object_filter,
      config.object_filter_enabled,
      t("db.filterOnEverything"),
    );
    for (const entry of config.schema_object_filters) {
      const folder = entry.folder ?? null;
      add(
        { kind: "objects", schema: entry.schema, folder },
        entry.pattern,
        entry.enabled,
        folder
          ? t(folderLabelKey(folder), { name: entry.schema })
          : t("db.filterOnSchema", { name: entry.schema }),
      );
    }
    return out;
  }, [config, target, t, sql]);

  if (!config) return null;

  const apply = async (pattern: string, on: boolean) => {
    setBusy(true);
    await setFilter(connectionId, target, pattern, on);
    setBusy(false);
    onClose();
  };

  return (
    <ApiModal
      icon={Filter}
      title={describe(target, sql, t)}
      subtitle={row?.name}
      width="max-w-xl"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          {/* Its own button rather than "save empty lists": clearing is the action people come back
              for, and it should not require emptying two boxes by hand first. */}
          <GhostButton onClick={() => void apply("", true)}>{t("db.filterClearThis")}</GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <button
            onClick={() => void apply(formatFilterTerms(terms), enabled)}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            {t("db.filterApply")}
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <label className="flex cursor-pointer items-center gap-2 text-[12px] font-medium text-[var(--cf-text)]">
          <Checkbox checked={enabled} onChange={setEnabled} />
          {t("db.filterEnable")}
        </label>

        {/* Dimmed rather than disabled when off: the lists are still worth reading — knowing what
            the filter *would* do is half the reason to switch it off — and still worth editing, so
            a term can be fixed and switched back on in one visit. */}
        <div className={`grid gap-3 sm:grid-cols-2 ${enabled ? "" : "opacity-50"}`}>
          <TermList
            title={t("db.filterInclude")}
            hint={t("db.filterIncludeHint")}
            placeholder={placeholderFor(target, sql)}
            terms={terms.include}
            onChange={(include) => setTerms({ ...terms, include })}
          />
          <TermList
            title={t("db.filterExclude")}
            hint={t("db.filterExcludeHint")}
            placeholder={placeholderFor(target, sql)}
            terms={terms.exclude}
            onChange={(exclude) => setTerms({ ...terms, exclude })}
          />
        </div>

        <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("db.filterGrammar")}
        </p>

        {others.length > 0 && (
          <div className="rounded-md border border-[var(--cf-border)]">
            <p className="border-b border-[var(--cf-border)] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("db.filterElsewhere")}
            </p>
            <ul className="max-h-32 overflow-y-auto">
              {others.map((entry) => (
                <li
                  key={entry.label}
                  className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1 text-[12px] last:border-b-0"
                >
                  <span
                    className={`min-w-0 truncate ${
                      entry.enabled
                        ? "text-[var(--cf-text)]"
                        : "text-[var(--cf-text-muted)] line-through"
                    }`}
                  >
                    {entry.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                    {entry.pattern}
                  </span>
                  <button
                    onClick={() => void setFilter(connectionId, entry.target, "", true)}
                    title={t("db.filterRemove")}
                    className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
                  >
                    <Trash2 size={12} />
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

// ---------------------------------------------------------------------------
// Saying what a target is
// ---------------------------------------------------------------------------

function folderLabelKey(folder: DbNodeKind): TranslationKey {
  switch (folder) {
    case "view_folder":
      return "db.filterOnViews";
    case "routine_folder":
      return "db.filterOnRoutines";
    case "sequence_folder":
      return "db.filterOnSequences";
    default:
      return "db.filterOnTables";
  }
}

/** The dialog's own title. It is the only thing saying what is about to be narrowed, now that
 * nothing on screen asks. */
function describe(
  target: DbFilterTarget,
  sql: boolean,
  t: (key: TranslationKey, vars?: Record<string, string>) => string,
): string {
  if (target.kind === "schemas") return t(sql ? "db.filterOnSchemas" : "db.filterOnCollections");
  if (target.schema === null) return t("db.filterOnEverything");
  if (target.folder) return t(folderLabelKey(target.folder), { name: target.schema });
  return t("db.filterOnSchema", { name: target.schema });
}

/** An example of the right shape for what is being filtered — a schema name reads nothing like a
 * table name, and a placeholder that showed `app_*` under a schema list would be a bad hint. */
function placeholderFor(target: DbFilterTarget, sql: boolean): string {
  if (target.kind !== "schemas") return "app_*";
  return sql ? "public" : "events";
}

// ---------------------------------------------------------------------------
// One editable list of patterns
// ---------------------------------------------------------------------------

/**
 * Rows are text inputs rather than labels you select and then Remove, which is the shape the dialogs
 * this imitates use. Editing a term in place is the commonest thing anyone does to a filter —
 * `app_` was meant to be `app_*` — and select-then-press-Remove-then-retype is three gestures for a
 * one-character fix.
 */
function TermList({
  title,
  hint,
  placeholder,
  terms,
  onChange,
}: {
  title: string;
  hint: string;
  placeholder: string;
  terms: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  /** Focuses the row that `Add` just created, without threading a ref per row. */
  const [justAdded, setJustAdded] = useState(-1);

  const add = () => {
    setJustAdded(terms.length);
    onChange([...terms, ""]);
  };

  return (
    <div className="flex min-w-0 flex-col rounded-md border border-[var(--cf-border)]">
      <div className="flex items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {title}
        </span>
        <button
          type="button"
          onClick={add}
          title={t("db.filterAdd")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={terms.length === 0}
          title={t("db.filterClear")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="min-h-[92px] space-y-1 overflow-y-auto p-1.5" style={{ maxHeight: 168 }}>
        {terms.length === 0 ? (
          <p className="px-1 py-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>
        ) : (
          terms.map((term, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                autoFocus={index === justAdded}
                value={term}
                onChange={(e) => onChange(terms.map((v, at) => (at === index ? e.target.value : v)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder={placeholder}
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
              <button
                type="button"
                onClick={() => onChange(terms.filter((_, at) => at !== index))}
                title={t("db.filterRemove")}
                className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
