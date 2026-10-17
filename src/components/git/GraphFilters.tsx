import { useEffect, useRef, useState } from "react";
import { Filter, X } from "lucide-react";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import { fieldClass, popoverClass } from "../common/recipes";
import {
  narrowingCount,
  NO_COMMIT_FILTER,
  type CommitFilter,
  type CommitScope,
} from "../../lib/commitFilter";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";

/** Which history the graph walks: every branch, the checked-out one, or first parents only. */
export function GraphScopePicker() {
  const t = useT();
  const filter = useRepoStore((s) => s.commitFilter);
  const setFilter = useRepoStore((s) => s.setCommitFilter);
  return (
    <div className="w-[150px] shrink-0">
      <Select
        size="sm"
        value={filter.scope}
        onChange={(value) =>
          void setFilter({ ...filter, scope: value as CommitScope })
        }
        options={[
          { value: "all", label: t("graph.scopeAll") },
          { value: "current", label: t("graph.scopeCurrent") },
          { value: "firstParent", label: t("graph.scopeFirstParent") },
        ]}
        ariaLabel={t("graph.scopeLabel")}
      />
    </div>
  );
}

/**
 * Author, dates and path, walked by the backend — so "every commit by Ana that touched src/api"
 * answers over the whole history, not only over the pages loaded. A badge counts what is set.
 */
export function GraphFilterButton() {
  const t = useT();
  const filter = useRepoStore((s) => s.commitFilter);
  const setFilter = useRepoStore((s) => s.setCommitFilter);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CommitFilter>(filter);
  const boxRef = useRef<HTMLDivElement>(null);
  const count = narrowingCount(filter);

  useEffect(() => {
    if (!open) return;
    setDraft(filter);
    const onDown = (event: MouseEvent) => {
      if (
        boxRef.current &&
        event.target instanceof Node &&
        !boxRef.current.contains(event.target)
      )
        setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // Re-seeded on opening only: the draft is what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = (next: CommitFilter) => {
    setOpen(false);
    void setFilter(next);
  };
  const field = (
    key: "author" | "path" | "since" | "until",
    label: string,
    type = "text",
    placeholder = "",
  ) => (
    <label className="flex flex-col gap-1 text-[11.5px] text-[var(--cf-text-muted)]">
      {label}
      <input
        type={type}
        value={draft[key]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply(draft);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={fieldClass({ size: "sm", className: "w-full" })}
      />
    </label>
  );

  return (
    <div ref={boxRef} className="relative shrink-0">
      <Tooltip label={t("graph.filterTitle")}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={t("graph.filterTitle")}
          aria-expanded={open}
          className={iconButtonClass({
            size: "sm",
            active: count > 0,
            className: "relative",
          })}
        >
          <Filter size={14} />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--cf-accent)] px-[3px] text-[9.5px] font-semibold text-[var(--cf-on-accent,#fff)]">
              {count}
            </span>
          )}
        </button>
      </Tooltip>
      {open && (
        <div
          className={`${popoverClass} absolute right-0 top-[calc(100%+4px)] z-30 w-[280px]`}
        >
          <div className="flex flex-col gap-2.5 p-2">
            {field(
              "author",
              t("graph.filterAuthor"),
              "text",
              t("graph.filterAuthorPlaceholder"),
            )}
            {field("path", t("graph.filterPath"), "text", "src/api")}
            <div className="grid grid-cols-2 gap-2">
              {field("since", t("graph.filterSince"), "date")}
              {field("until", t("graph.filterUntil"), "date")}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() =>
                  apply({ ...NO_COMMIT_FILTER, scope: filter.scope })
                }
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                <X size={12} />
                {t("graph.filterClear")}
              </button>
              <button
                type="button"
                onClick={() => apply(draft)}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                {t("graph.filterApply")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
