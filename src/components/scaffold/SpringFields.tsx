import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { SpringMeta } from "../../lib/scaffold/api";
import { springRangeIncludes } from "../../lib/scaffold/spring";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { chipClass, fieldClass, sectionLabelClass } from "../common/recipes";
import { Field } from "./Field";

/** The Spring form's own state — everything start.spring.io asks except the name, which is the
 *  project's. `packageEdited` stops the package following the group once the user has typed one. */
export interface SpringState {
  type: string;
  language: string;
  bootVersion: string;
  javaVersion: string;
  packaging: string;
  groupId: string;
  packageName: string;
  packageEdited: boolean;
  dependencies: string[];
}

/** Starters most projects begin with, offered one click away above the full list. */
const POPULAR = ["web", "data-jpa", "security", "validation", "actuator", "lombok", "devtools", "postgresql", "mysql", "h2", "webflux", "thymeleaf"];

export function initialSpring(meta: SpringMeta, saved?: Partial<SpringState>): SpringState {
  const has = (list: { id: string }[], id: string | undefined) => (id && list.some((c) => c.id === id) ? id : undefined);
  return {
    type: has(meta.types, saved?.type) ?? (has(meta.types, meta.typeDefault) ? meta.typeDefault : meta.types[0]?.id ?? "maven-project"),
    language: has(meta.languages, saved?.language) ?? meta.languageDefault,
    // The Boot line is never remembered: last month's default is this month's old version.
    bootVersion: meta.bootDefault,
    javaVersion: has(meta.javaVersions, saved?.javaVersion) ?? meta.javaDefault,
    packaging: has(meta.packagings, saved?.packaging) ?? meta.packagingDefault,
    groupId: saved?.groupId || meta.groupDefault,
    packageName: "",
    packageEdited: false,
    dependencies: saved?.dependencies?.length ? saved.dependencies : ["web"],
  };
}

export function SpringFields({
  meta,
  value,
  packageName,
  onChange,
  packageProblem,
}: {
  meta: SpringMeta;
  value: SpringState;
  /** The package as it will be sent: typed, or derived from the group and the project's name. */
  packageName: string;
  onChange: (patch: Partial<SpringState>) => void;
  packageProblem: string | null;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const byId = useMemo(() => {
    const map = new Map<string, { name: string; description: string; versionRange: string; group: string }>();
    for (const group of meta.dependencies)
      for (const dep of group.values) map.set(dep.id, { ...dep, group: group.name });
    return map;
  }, [meta]);

  const toggle = (id: string) =>
    onChange({
      dependencies: value.dependencies.includes(id)
        ? value.dependencies.filter((dep) => dep !== id)
        : [...value.dependencies, id],
    });

  const needle = query.trim().toLowerCase();
  const groups = meta.dependencies
    .map((group) => ({
      name: group.name,
      values: group.values.filter(
        (dep) => !needle || dep.name.toLowerCase().includes(needle) || dep.description.toLowerCase().includes(needle) || dep.id.includes(needle),
      ),
    }))
    .filter((group) => group.values.length > 0);
  const popular = POPULAR.filter((id) => byId.has(id) && !value.dependencies.includes(id));

  return (
    <>
      <Field label={t("scaffold.spring.build")}>
        <Segmented
          layoutId="scaffold-spring-type"
          size="sm"
          value={value.type}
          onChange={(type) => onChange({ type })}
          options={meta.types.map((type) => ({ value: type.id, label: type.name.replace(" - ", " · ") }))}
        />
      </Field>
      <Field label={t("scaffold.opt.language")}>
        <Segmented
          layoutId="scaffold-spring-language"
          size="sm"
          value={value.language}
          onChange={(language) => onChange({ language })}
          options={meta.languages.map((language) => ({ value: language.id, label: language.name }))}
        />
      </Field>
      <Field label="Spring Boot">
        <div className="w-[200px]">
          <Select
            size="sm"
            value={value.bootVersion}
            onChange={(bootVersion) => onChange({ bootVersion })}
            ariaLabel="Spring Boot"
            options={meta.bootVersions.map((boot) => ({ value: boot.id, label: boot.name }))}
          />
        </div>
      </Field>
      <Field label="Java">
        <Segmented
          layoutId="scaffold-spring-java"
          size="sm"
          value={value.javaVersion}
          onChange={(javaVersion) => onChange({ javaVersion })}
          options={meta.javaVersions.map((java) => ({ value: java.id, label: java.name }))}
        />
      </Field>
      <Field label={t("scaffold.spring.packaging")}>
        <Segmented
          layoutId="scaffold-spring-packaging"
          size="sm"
          value={value.packaging}
          onChange={(packaging) => onChange({ packaging })}
          options={meta.packagings.map((packaging) => ({ value: packaging.id, label: packaging.name }))}
        />
      </Field>
      <Field label={t("scaffold.spring.group")}>
        <input
          value={value.groupId}
          onChange={(e) => onChange({ groupId: e.target.value.trim() })}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "w-full font-mono" })}
        />
      </Field>
      <Field label={t("scaffold.spring.package")} error={packageProblem}>
        <input
          value={packageName}
          onChange={(e) => onChange({ packageName: e.target.value.trim(), packageEdited: true })}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "w-full font-mono" })}
        />
      </Field>
      <Field label={t("scaffold.spring.dependencies")} align="start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {value.dependencies.map((id) => {
              const dep = byId.get(id);
              const fits = dep ? springRangeIncludes(dep.versionRange, value.bootVersion) : true;
              return (
                <span
                  key={id}
                  title={fits ? dep?.description : t("scaffold.spring.incompatible", { range: dep?.versionRange ?? "" })}
                  className={chipClass(fits ? "accent" : "warn", "pr-1")}
                >
                  {dep?.name ?? id}
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={t("scaffold.remove")}
                    className="rounded-[3px] p-px opacity-70 hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              onClick={() => setPicking((open) => !open)}
              aria-expanded={picking}
              className={chipClass("neutral", "cursor-pointer hover:text-[var(--cf-text)]")}
            >
              <Plus size={11} />
              {t("scaffold.spring.add")}
            </button>
          </div>
          {!picking && popular.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {popular.slice(0, 8).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggle(id)}
                  title={byId.get(id)?.description}
                  className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                >
                  + {byId.get(id)?.name}
                </button>
              ))}
            </div>
          )}
          {picking && (
            <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
              <div className="relative border-b border-[var(--cf-border)] p-1.5">
                <Search size={12} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("scaffold.spring.search")}
                  className={fieldClass({ size: "sm", className: "w-full pl-7" })}
                />
              </div>
              <div className="max-h-[220px] overflow-y-auto p-1">
                {groups.map((group) => (
                  <div key={group.name}>
                    <div className={`${sectionLabelClass} pt-2`}>{group.name}</div>
                    {group.values.map((dep) => {
                      const fits = springRangeIncludes(dep.versionRange, value.bootVersion);
                      const checked = value.dependencies.includes(dep.id);
                      return (
                        <label
                          key={dep.id}
                          title={fits ? dep.description : t("scaffold.spring.incompatible", { range: dep.versionRange })}
                          className={`flex items-start gap-2 rounded-md px-2 py-1 ${
                            fits || checked ? "cursor-pointer hover:bg-[var(--cf-hover)]" : "opacity-45"
                          }`}
                        >
                          <Checkbox checked={checked} disabled={!fits && !checked} onChange={() => toggle(dep.id)} className="mt-0.5" />
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px] text-[var(--cf-text)]">{dep.name}</span>
                            <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{dep.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Field>
    </>
  );
}
