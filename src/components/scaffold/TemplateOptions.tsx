import { useT } from "../../state/languageStore";
import type { VersionLine } from "../../lib/scaffold/api";
import type { Options, OptionValue, PackageManager, Template, TemplateOption, ToggleOption } from "../../lib/scaffold/catalog";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { DependencyPicker } from "./DependencyPicker";
import { Field } from "./Field";

/**
 * A template's own choices, drawn by kind: two to four choices are a segmented control, more are a
 * select, the toggles share one row of checkboxes (they are extras, not decisions) — or, when they
 * name a group like NestJS's dependencies, a field of their own picked the way Spring's starters are
 * — free text is a field, and a runtime version is a select of that runtime's living lines.
 */
export function TemplateOptions({
  template,
  opts,
  onChange,
  pm,
  onPm,
  runtimeLines,
  problems,
}: {
  template: Template;
  opts: Options;
  onChange: (id: string, value: OptionValue) => void;
  pm: PackageManager;
  onPm: (pm: PackageManager) => void;
  /** Lines per runtime option id, already narrowed to what the template can use. */
  runtimeLines: Record<string, VersionLine[]>;
  /** Per text option id, what is wrong with it. */
  problems: Record<string, string | null>;
}) {
  const t = useT();
  const visible = template.options.filter((option) => !option.when || option.when(opts));
  const toggles = visible.filter((option): option is ToggleOption => option.kind === "toggle" && !option.group);
  const groups = new Map<TranslationKey, ToggleOption[]>();
  for (const option of visible) {
    if (option.kind === "toggle" && option.group) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  }
  const rest = visible.filter((option) => option.kind !== "toggle");
  const label = (option: TemplateOption) => option.label ?? (option.labelKey ? t(option.labelKey) : option.id);

  return (
    <>
      {rest.map((option) => {
        if (option.kind === "choice") {
          const choices = option.choices.map((choice) => ({
            value: choice.value,
            label: choice.label ?? (choice.labelKey ? t(choice.labelKey) : choice.value),
          }));
          const value = String(opts[option.id] ?? option.default);
          return (
            <Field key={option.id} label={label(option)}>
              {choices.length <= 4 ? (
                <Segmented
                  layoutId={`scaffold-${template.id}-${option.id}`}
                  size="sm"
                  value={value}
                  onChange={(next) => onChange(option.id, next)}
                  options={choices}
                />
              ) : (
                <div className="w-[200px]">
                  <Select size="sm" value={value} onChange={(next) => onChange(option.id, next)} options={choices} ariaLabel={label(option)} />
                </div>
              )}
            </Field>
          );
        }
        if (option.kind === "text") {
          return (
            <Field key={option.id} label={label(option)} error={problems[option.id]}>
              <input
                value={String(opts[option.id] ?? "")}
                onChange={(e) => onChange(option.id, e.target.value.trim())}
                spellCheck={false}
                className={fieldClass({ size: "sm", className: "w-full font-mono" })}
              />
            </Field>
          );
        }
        if (option.kind === "runtime") {
          const lines = runtimeLines[option.id] ?? [];
          return (
            <Field key={option.id} label={label(option)}>
              <div className="w-[200px]">
                <Select
                  size="sm"
                  value={String(opts[option.id] ?? "")}
                  onChange={(next) => onChange(option.id, next)}
                  ariaLabel={label(option)}
                  placeholder={t("scaffold.loading")}
                  options={lines.map((line) => ({
                    value: line.line,
                    label: `${line.line}${line.channel === "lts" ? " · LTS" : ""}  (${line.version})`,
                  }))}
                />
              </div>
            </Field>
          );
        }
        return null;
      })}
      {template.pms && (
        <Field label={t("scaffold.opt.packageManager")}>
          <Segmented
            layoutId={`scaffold-${template.id}-pm`}
            size="sm"
            value={pm}
            onChange={onPm}
            options={template.pms.map((value) => ({ value, label: value }))}
          />
        </Field>
      )}
      {toggles.length > 0 && (
        <Field label={t("scaffold.opt.include")} align="start">
          <Checkboxes options={toggles} opts={opts} onChange={onChange} label={label} />
        </Field>
      )}
      {[...groups].map(([group, options]) => {
        const picked = (option: ToggleOption) => Boolean(opts[option.id] ?? option.default);
        return (
          <Field key={group} label={t(group)} align="start">
            <DependencyPicker
              items={options.map((option) => ({
                id: option.id,
                name: label(option),
                description: option.descriptionKey ? t(option.descriptionKey) : undefined,
                group: option.section ? t(option.section) : undefined,
              }))}
              selected={options.filter(picked).map((option) => option.id)}
              onToggle={(id) => {
                const option = options.find((candidate) => candidate.id === id);
                if (option) onChange(id, !picked(option));
              }}
              popular={options.filter((option) => option.popular).map((option) => option.id)}
              label={t(group)}
              searchPlaceholder={t("scaffold.deps.search", { what: t(group).toLowerCase() })}
            />
          </Field>
        );
      })}
    </>
  );
}

/** A row of toggles, wrapping. */
function Checkboxes({
  options,
  opts,
  onChange,
  label,
}: {
  options: ToggleOption[];
  opts: Options;
  onChange: (id: string, value: OptionValue) => void;
  label: (option: TemplateOption) => string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
      {options.map((option) => (
        <label key={option.id} className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--cf-text)]">
          <Checkbox checked={Boolean(opts[option.id] ?? option.default)} onChange={(next) => onChange(option.id, next)} />
          {label(option)}
        </label>
      ))}
    </div>
  );
}
