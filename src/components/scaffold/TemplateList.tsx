import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useT } from "../../state/languageStore";
import { CATEGORY_LABELS, CATEGORY_ORDER, TEMPLATES, type Template } from "../../lib/scaffold/catalog";
import { explorerClass, fieldClass, rowClass, sectionLabelClass } from "../common/recipes";
import { TemplateLogo } from "./TemplateLogo";

/**
 * The column of templates, grouped by what they build. The search matches the name and the one-line
 * description, so "api" finds Express, Nest and FastAPI as well as anything called API.
 */
export function TemplateList({
  selected,
  onSelect,
  disabled,
}: {
  selected: string;
  onSelect: (template: Template) => void;
  disabled: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = TEMPLATES.filter(
      (template) =>
        !needle ||
        template.name.toLowerCase().includes(needle) ||
        t(template.descriptionKey).toLowerCase().includes(needle),
    );
    return CATEGORY_ORDER.map((category) => ({
      category,
      templates: matches.filter((template) => template.category === category),
    })).filter((group) => group.templates.length > 0);
  }, [query, t]);

  return (
    <div className={`${explorerClass} w-[212px]`}>
      <div className="relative shrink-0 px-2.5 pb-1 pt-2.5">
        <Search
          size={13}
          className="pointer-events-none absolute left-[18px] top-1/2 mt-[3px] -translate-y-1/2 text-[var(--cf-text-faint)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("scaffold.search")}
          aria-label={t("scaffold.search")}
          data-no-initial-focus
          className={fieldClass({ size: "sm", className: "w-full pl-7" })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" role="listbox" aria-label={t("scaffold.title")}>
        {groups.map((group) => (
          <div key={group.category}>
            <div className={sectionLabelClass}>{t(CATEGORY_LABELS[group.category])}</div>
            {group.templates.map((template) => {
              const active = template.id === selected;
              return (
                <button
                  key={template.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={disabled}
                  onClick={() => onSelect(template)}
                  title={t(template.descriptionKey)}
                  className={rowClass(active, "h-8 disabled:opacity-50")}
                >
                  <TemplateLogo logo={template.logo} name={template.name} size={16} />
                  <span className="min-w-0 flex-1 truncate">{template.name}</span>
                </button>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("scaffold.noMatch")}</p>
        )}
      </div>
    </div>
  );
}
