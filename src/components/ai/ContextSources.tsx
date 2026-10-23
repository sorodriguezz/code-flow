import { AtSign, Brain, CircleSlash, FileCode2, FileDiff, FilePen, ListTree, TextSelect, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import type { ContextSource, ContextSourceKind } from "../../lib/editorContext";
import type { TranslationKey } from "../../lib/i18n/translations";

const ICON: Record<ContextSourceKind, LucideIcon> = {
  active_file: FileCode2,
  selection: TextSelect,
  unsaved: FilePen,
  diagnostics: TriangleAlert,
  mention: AtSign,
  diff: FileDiff,
  memory: Brain,
  knowledge: ListTree,
  withheld: CircleSlash,
};

const KIND_KEY: Record<ContextSourceKind, TranslationKey> = {
  active_file: "context.activeFile",
  selection: "context.selection",
  unsaved: "context.unsaved",
  diagnostics: "context.diagnostics",
  mention: "context.mention",
  diff: "context.diff",
  memory: "context.memory",
  knowledge: "context.knowledge",
  withheld: "context.withheld",
};

/** Why nothing went, by the code the backend files it with (`context::need::Withheld`). */
const WITHHELD_KEY: Record<string, TranslationKey> = {
  follow_up: "context.withheldFollowUp",
  general: "context.withheldGeneral",
  tools_only: "context.withheldToolsOnly",
};

/** What a chip says: its file or place, or — for nothing attached — why, in the user's language. */
function chipLabel(source: ContextSource, t: ReturnType<typeof useT>): string {
  if (source.kind !== "withheld") return source.label;
  const key = WITHHELD_KEY[source.label];
  return key ? t(key) : source.label;
}

/**
 * «Contexto usado»: what CodeFlow put in front of the engine for an answer besides the question —
 * one quiet line under the bubble, each source a chip that opens its file where it has one.
 */
export function ContextSources({ sources }: { sources: ContextSource[] }) {
  const t = useT();
  if (sources.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
      <span>{t("context.used")}</span>
      {sources.map((source, index) => {
        const Icon = ICON[source.kind] ?? FileCode2;
        const label = chipLabel(source, t);
        const title = source.kind === "withheld" ? t("context.withheld") : `${t(KIND_KEY[source.kind])}: ${label}`;
        const body = (
          <>
            <Icon size={11} className="shrink-0" />
            <span className="max-w-[220px] truncate">{label}</span>
          </>
        );
        const chip = "inline-flex h-5 items-center gap-1 rounded-[5px] px-1.5 shadow-[inset_0_0_0_1px_var(--cf-border)]";
        return source.path ? (
          <button
            key={`${source.kind}-${index}`}
            type="button"
            title={title}
            onClick={() => useUiStore.getState().openInEditor(source.path ?? "", source.startLine ?? undefined)}
            className={`${chip} hover:text-[var(--cf-text)]`}
          >
            {body}
          </button>
        ) : (
          <span key={`${source.kind}-${index}`} title={title} className={chip}>
            {body}
          </span>
        );
      })}
    </div>
  );
}
