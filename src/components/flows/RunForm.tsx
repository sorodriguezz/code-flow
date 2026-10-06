import { useMemo, useState } from "react";
import { Play } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { Rows, asRows, str } from "./fieldRows";
import type { FlowFormField } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useT } from "../../state/languageStore";

/**
 * The form a manual run asks for (`flows::form`): the trigger's field editor, and the dialog that
 * fills it in before the run starts.
 *
 * The dialog belongs to the run store, not to a button: every way a person starts a run from a
 * manual trigger with fields — Ejecutar, up to a node, a step, the explorer, the schedule list —
 * goes through `flowRunsStore.start`, which asks the backend which form that run needs.
 */

const FIELD_TYPES = ["text", "longText", "number", "boolean", "select", "date"] as const;

/** The manual trigger's fields: a key, the label a person reads, its type, a default, required. */
export function FormFieldsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", label: "", type: "text", required: false, default: "", options: "" })}
      addLabel={t("flows.form.addField")}
      render={(row, set) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
          <div className="flex min-w-0 gap-1.5">
            <input
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
              value={str(row.name)}
              placeholder={t("flows.form.key")}
              aria-label={t("flows.form.key")}
              title={t("flows.form.keyHint")}
              onChange={(event) => set({ ...row, name: event.target.value })}
            />
            <div className="w-[118px] shrink-0">
              <Select
                value={str(row.type) || "text"}
                onChange={(type) => set({ ...row, type })}
                options={FIELD_TYPES.map((type) => ({ value: type, label: t(`flows.form.type.${type}` as TranslationKey) }))}
                size="sm"
              />
            </div>
          </div>
          <input
            className={fieldClass({ size: "sm", className: "w-full text-[12px]" })}
            value={str(row.label)}
            placeholder={t("flows.form.label")}
            aria-label={t("flows.form.label")}
            onChange={(event) => set({ ...row, label: event.target.value })}
          />
          {row.type === "select" && (
            <input
              className={fieldClass({ size: "sm", className: "w-full text-[12px]" })}
              value={str(row.options)}
              placeholder={t("flows.form.optionsPlaceholder")}
              aria-label={t("flows.form.options")}
              onChange={(event) => set({ ...row, options: event.target.value })}
            />
          )}
          <div className="flex min-w-0 items-center gap-1.5">
            {row.type !== "boolean" && (
              <input
                className={fieldClass({ size: "sm", className: "min-w-0 flex-1 text-[12px]" })}
                value={str(row.default)}
                placeholder={t("flows.form.default")}
                aria-label={t("flows.form.default")}
                onChange={(event) => set({ ...row, default: event.target.value })}
              />
            )}
            <label className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <Checkbox checked={row.required === true} onChange={(required) => set({ ...row, required })} />
              {t("flows.form.required")}
            </label>
          </div>
        </div>
      )}
    />
  );
}

function initialValue(field: FlowFormField): unknown {
  if (field.type === "boolean") return field.default === true || field.default === "true";
  const text = typeof field.default === "string" ? field.default : field.default == null ? "" : String(field.default);
  if (field.type === "select" && !text) return field.options[0] ?? "";
  return text;
}

function missing(field: FlowFormField, value: unknown): boolean {
  return field.required && field.type !== "boolean" && String(value ?? "").trim() === "";
}

/** The run's form, while a run waits for it. */
export function FlowRunFormDialog() {
  const t = useT();
  const prompt = useFlowRunsStore((s) => s.formPrompt);
  if (!prompt) return null;
  // Keyed by the prompt, so a second run's form starts from its own defaults.
  return <RunFormBody key={`${prompt.flowId}:${prompt.form.triggerId}`} fields={prompt.form.fields} title={prompt.form.triggerName} t={t} />;
}

function RunFormBody({ fields, title, t }: { fields: FlowFormField[]; title: string; t: ReturnType<typeof useT> }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((field) => [field.name, initialValue(field)])));
  const blocked = useMemo(() => fields.some((field) => missing(field, values[field.name])), [fields, values]);
  const answer = useFlowRunsStore.getState().answerForm;
  const submit = () => {
    if (!blocked) answer(values);
  };
  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));

  return (
    <ApiModal icon={Play} title={t("flows.form.title")} subtitle={title} width="max-w-md" onClose={() => answer(null)}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {fields.map((field, index) => {
          const value = values[field.name];
          const label = (
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">
              {field.label}
              {field.required && field.type !== "boolean" && <span className="text-[var(--cf-danger)]"> *</span>}
            </span>
          );
          if (field.type === "boolean") {
            return (
              <label key={field.name} className="flex items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
                <Checkbox checked={value === true} onChange={(checked) => set(field.name, checked)} />
                {field.label}
              </label>
            );
          }
          return (
            <label key={field.name} className="flex flex-col gap-1">
              {label}
              {field.type === "longText" ? (
                <textarea
                  autoFocus={index === 0}
                  rows={4}
                  value={str(value)}
                  onChange={(event) => set(field.name, event.target.value)}
                  className={fieldClass({ size: "sm", className: "h-auto resize-y py-1.5 text-[12.5px]" })}
                />
              ) : field.type === "select" ? (
                <Select
                  value={str(value)}
                  onChange={(next) => set(field.name, next)}
                  options={field.options.map((option) => ({ value: option, label: option }))}
                  size="sm"
                />
              ) : (
                <input
                  autoFocus={index === 0}
                  type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                  value={str(value)}
                  onChange={(event) => set(field.name, event.target.value)}
                  className={fieldClass({ size: "sm", className: "text-[12.5px]" })}
                />
              )}
            </label>
          );
        })}
        <div className="flex justify-end gap-2">
          <Button size="sm" type="button" onClick={() => answer(null)}>
            {t("flows.form.cancel")}
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={blocked}>
            <Play size={12} />
            {t("flows.run.run")}
          </Button>
        </div>
      </form>
    </ApiModal>
  );
}

/** What a web page node picks out: a field name, a CSS selector, what of the match (its text, its
 *  HTML or an attribute), and whether every match or the first. */
export function ExtractRulesEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", selector: "", attribute: "", all: false })}
      addLabel={t("flows.extract.add")}
      render={(row, set) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
          <div className="flex min-w-0 gap-1.5">
            <input
              className={fieldClass({ size: "sm", className: "w-[96px] shrink-0 font-mono text-[11.5px]" })}
              value={str(row.name)}
              placeholder={t("flows.extract.name")}
              aria-label={t("flows.extract.name")}
              onChange={(event) => set({ ...row, name: event.target.value })}
            />
            <input
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
              value={str(row.selector)}
              placeholder={t("flows.extract.selector")}
              aria-label={t("flows.extract.selector")}
              onChange={(event) => set({ ...row, selector: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
              value={str(row.attribute)}
              placeholder={t("flows.extract.attribute")}
              aria-label={t("flows.extract.attribute")}
              onChange={(event) => set({ ...row, attribute: event.target.value })}
            />
            <label className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]" title={t("flows.extract.allHint")}>
              <Checkbox checked={row.all === true} onChange={(all) => set({ ...row, all })} />
              {t("flows.extract.all")}
            </label>
          </div>
        </div>
      )}
    />
  );
}
