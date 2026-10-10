import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { SpringMeta } from "../../lib/scaffold/api";
import { springRangeIncludes } from "../../lib/scaffold/spring";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { fieldClass } from "../common/recipes";
import { DependencyPicker, type PickerItem } from "./DependencyPicker";
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
    // None, and never last project's: every dependency picker starts empty (user, 2026-10-08: "que
    // no tenga seleccionados por defecto"). Spring Web used to be pre-picked; it is first in POPULAR.
    dependencies: [],
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
  // Every starter under Initializr's own headings; one the chosen Boot line does not take says so.
  const starters = useMemo<PickerItem[]>(
    () =>
      meta.dependencies.flatMap((group) =>
        group.values.map((dep) => ({
          id: dep.id,
          name: dep.name,
          description: dep.description,
          group: group.name,
          unavailable: springRangeIncludes(dep.versionRange, value.bootVersion) ? null : t("scaffold.spring.incompatible", { range: dep.versionRange }),
        })),
      ),
    [meta, value.bootVersion, t],
  );

  const toggle = (id: string) =>
    onChange({
      dependencies: value.dependencies.includes(id)
        ? value.dependencies.filter((dep) => dep !== id)
        : [...value.dependencies, id],
    });

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
        <DependencyPicker
          items={starters}
          selected={value.dependencies}
          onToggle={toggle}
          popular={POPULAR}
          label={t("scaffold.spring.dependencies")}
          searchPlaceholder={t("scaffold.spring.search")}
        />
      </Field>
    </>
  );
}

/**
 * The form's shape while start.spring.io is still answering — every row, with its label and a bar
 * where its control will be.
 *
 * Everything in this form comes from that metadata, so until it lands there is nothing of it to
 * draw, and a line of grey "Loading…" under the location field read as a form with nothing more to
 * ask (user, 2026-10-10: it "takes a while to appear"). Same rows, same widths, so the real form
 * replaces this in place instead of pushing the environment check down when it arrives.
 */
export function SpringFieldsSkeleton() {
  const t = useT();
  const bar = (width: string, height = "h-6") => <Skeleton className={height} style={{ width }} />;
  return (
    <div aria-busy className="space-y-2.5">
      <Field label="start.spring.io">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          {t("scaffold.loading")}
        </span>
      </Field>
      <Field label={t("scaffold.spring.build")}>{bar("260px")}</Field>
      <Field label={t("scaffold.opt.language")}>{bar("180px")}</Field>
      <Field label="Spring Boot">{bar("200px")}</Field>
      <Field label="Java">{bar("150px")}</Field>
      <Field label={t("scaffold.spring.packaging")}>{bar("110px")}</Field>
      <Field label={t("scaffold.spring.group")}>{bar("100%", "h-[26px]")}</Field>
      <Field label={t("scaffold.spring.package")}>{bar("100%", "h-[26px]")}</Field>
      <Field label={t("scaffold.spring.dependencies")} align="start">
        {bar("100%", "h-24")}
      </Field>
    </div>
  );
}
