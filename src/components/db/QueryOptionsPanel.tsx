import { RotateCcw, Search } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { DbQueryOptions } from "../../types/database";

/**
 * The rest of a MongoDB query: what comes back, in what order, under which index, and how much.
 *
 * **Why these live outside the filter box.** A filter is a document and these are not — `projection`
 * and `sort` are separate arguments to `find`, `hint` names an index, and `skip`/`limit`/`maxTimeMS`
 * are numbers. Folding them into one text box would mean inventing a syntax for a command that
 * already has one, and the first thing anyone would type is the raw command document — which the
 * console is for.
 *
 * **Skip and limit against the pager.** They are the user's, and the pager's are the panel's, so
 * they compose rather than compete: `skip` moves the whole window (it is added to the page's own
 * offset) and `limit` is a ceiling on the query as a whole, which the pager stops at and the total
 * is counted under. Both are honoured by the count as well as by the page, so "1 – 25 of 40" under
 * a limit of 40 is the truth rather than a number the pages can't reach.
 *
 * Everything is text, applied on submit with the filter — see `DbQueryOptions`. Nothing here parses:
 * what a document means is the driver's judgement, and a second parser in the webview would only
 * disagree with it.
 */
export function QueryOptionsPanel({
  value,
  onChange,
  onReset,
}: {
  value: DbQueryOptions;
  onChange: (patch: Partial<DbQueryOptions>) => void;
  /** Clears the options *and* the filter — the "start again" the query bar needs, and what Reset
   *  means in every other query builder. */
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="border-t border-[var(--cf-border)] bg-black/[0.015] px-2 py-2 dark:bg-white/[0.02]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-x-3 gap-y-1.5">
        <Option
          label={t("db.optionProject")}
          placeholder="{ field: 0 }"
          value={value.projection}
          onChange={(projection) => onChange({ projection })}
        />
        <Option
          label={t("db.optionMaxTime")}
          placeholder="60000"
          value={value.max_time_ms}
          onChange={(max_time_ms) => onChange({ max_time_ms })}
        />
        <Option
          label={t("db.optionSort")}
          placeholder="{ field: -1 }"
          value={value.sort}
          onChange={(sort) => onChange({ sort })}
        />
        <Option
          label={t("db.optionSkip")}
          placeholder="0"
          value={value.skip}
          onChange={(skip) => onChange({ skip })}
        />
        <Option
          label={t("db.optionCollation")}
          placeholder="{ locale: 'simple' }"
          value={value.collation}
          onChange={(collation) => onChange({ collation })}
        />
        <Option
          label={t("db.optionLimit")}
          placeholder="0"
          value={value.limit}
          onChange={(limit) => onChange({ limit })}
        />
        <Option
          label={t("db.optionHint")}
          placeholder={t("db.optionHintPlaceholder")}
          value={value.hint}
          onChange={(hint) => onChange({ hint })}
        />
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[11px] font-medium text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <RotateCcw size={11} />
          {t("db.resetQuery")}
        </button>
        {/* The submit of the form this panel sits in, so Enter anywhere in it does the same thing —
            the options and the filter are one question and are asked together. */}
        <button
          type="submit"
          className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[11px] font-medium text-white hover:brightness-110"
        >
          <Search size={11} />
          {t("db.runFind")}
        </button>
      </div>
    </div>
  );
}

/** One labelled box. The label sits above rather than beside it so the seven of them line up in a
 *  grid whatever the panel's width, instead of the inputs stepping in and out with the label
 *  lengths. */
function Option({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="w-[68px] shrink-0 text-right text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-[2px] font-mono text-[11.5px] text-[var(--cf-text)] outline-none placeholder:font-sans placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
      />
    </label>
  );
}
