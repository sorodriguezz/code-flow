import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { buttonClass, iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { validateVariables, type VariableProblem, type VariableRow } from "./runInputs";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * A row as the editor draws it. `fixed` is a variable the pipeline file (GitLab) or the definition
 * (Azure) declared: its name is theirs, so it can be emptied or removed but not renamed — renamed,
 * it would be a new variable the host has never heard of.
 */
export interface EditorRow extends VariableRow {
  fixed?: boolean;
  /** GitLab's `options:` — the value then comes from a dropdown. */
  options?: string[];
  description?: string | null;
}

let rowCounter = 0;

/** A key for a new row. Rows are reordered and removed, so an index would re-key the wrong one. */
export function newRowId(): string {
  rowCounter += 1;
  return `variable-${rowCounter}`;
}

const PROBLEM: Record<VariableProblem, TranslationKey> = {
  name: "pipelines.variableName",
  duplicate: "pipelines.variableDuplicate",
  empty: "pipelines.variableEmpty",
};

/**
 * Key/value rows, each with a "hide" toggle.
 *
 * Hidden means a password field here and `••••••` in the confirmation — and, on Azure, a variable
 * sent with `isSecret`. GitLab has no queue-time masking at all, which the toggle's tooltip says
 * rather than letting "hidden" imply more than it does.
 */
export function VariablesEditor({
  rows,
  onChange,
  provider,
}: {
  rows: EditorRow[];
  onChange: (rows: EditorRow[]) => void;
  provider: string;
}) {
  const t = useT();
  const problems = validateVariables(rows, provider);
  const update = (id: string, patch: Partial<EditorRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const maskHint: TranslationKey =
    provider === "azure"
      ? "pipelines.variableMaskHintAzure"
      : provider === "bitbucket"
        ? "pipelines.variableMaskHintBitbucket"
        : "pipelines.variableMaskHintGitlab";

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const problem = problems[row.id];
        const keyField = (
          <input
            value={row.key}
            readOnly={row.fixed}
            onChange={(e) => update(row.id, { key: e.target.value })}
            placeholder={t("pipelines.variableKey")}
            aria-label={t("pipelines.variableKey")}
            aria-invalid={problem ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            className={fieldClass({ size: "sm", className: `w-full font-mono ${row.fixed ? "text-[var(--cf-text-muted)]" : ""}` })}
          />
        );
        return (
          <div key={row.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-[38%] shrink-0">
                {row.description ? (
                  <Tooltip label={row.key} description={row.description}>
                    {keyField}
                  </Tooltip>
                ) : (
                  keyField
                )}
              </div>
              {row.options && row.options.length > 0 && !row.masked ? (
                <div className="min-w-0 flex-1">
                  <Select
                    size="compact"
                    value={row.value}
                    onChange={(value) => update(row.id, { value })}
                    options={row.options.map((option) => ({ value: option, label: option }))}
                    ariaLabel={row.key || t("pipelines.variableValue")}
                  />
                </div>
              ) : (
                <input
                  type={row.masked ? "password" : "text"}
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  placeholder={t("pipelines.variableValue")}
                  aria-label={t("pipelines.variableValue")}
                  spellCheck={false}
                  autoComplete="off"
                  className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })}
                />
              )}
              <Tooltip label={t("pipelines.variableMask")} description={t(maskHint)}>
                <button
                  type="button"
                  aria-pressed={row.masked}
                  aria-label={t("pipelines.variableMask")}
                  onClick={() => update(row.id, { masked: !row.masked })}
                  className={iconButtonClass({ size: "sm", active: row.masked })}
                >
                  {row.masked ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </Tooltip>
              <Tooltip label={t("pipelines.variableRemove")}>
                <button
                  type="button"
                  aria-label={t("pipelines.variableRemove")}
                  onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}
                  className={iconButtonClass({ size: "sm" })}
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </div>
            {problem && (
              <p className="pl-0.5 text-[11px] text-[var(--cf-danger)]">
                {t(problem === "name" && provider === "azure" ? "pipelines.variableNameAzure" : PROBLEM[problem])}
              </p>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...rows, { id: newRowId(), key: "", value: "", masked: false }])}
        className={buttonClass({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        <Plus size={12} />
        {t("pipelines.variableAdd")}
      </button>
    </div>
  );
}
