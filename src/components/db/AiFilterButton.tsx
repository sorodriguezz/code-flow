import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Square } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { fieldClass } from "../common/recipes";
import { dbAiFilter } from "../../lib/tauri/dbCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useDbStore, type DbDataTab } from "../../state/dbStore";
import { useT } from "../../state/languageStore";

/**
 * «Generar filtro con IA», beside the grid's filter box: describe the rows — «solo números en
 * PAPER_ID», «el nombre contiene una L» — and the box gets the condition in the connection's own
 * syntax, applied. What runs is always on screen in the box, editable, so a filter the model got
 * wrong is one glance and one edit away rather than a hidden query.
 *
 * With a filter already applied the request refines it («ahora solo los de 1990»): the backend sends
 * it along, and the model is told to combine rather than replace.
 */
export function AiFilterButton({ tab, onFilter }: { tab: DbDataTab; onFilter: (filter: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = runId !== null;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !running) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, running]);

  const generate = async () => {
    const asked = request.trim();
    if (!asked || running) return;
    const id = newRunId("db-assist");
    const workspaceId = useDbStore.getState().workspaceId;
    useAiRunStore.getState().start(id, { kindKey: "agents.liveKindDb", detail: asked, workspaceId });
    setRunId(id);
    setError(null);
    try {
      const filter = await dbAiFilter(
        tab.connectionId,
        tab.node,
        // The shape the grid already has — names and types, never a value.
        (tab.result?.columns ?? []).map((column) => ({ name: column.name, type_name: column.type_name })),
        tab.filter,
        asked,
        id,
        workspaceId,
      );
      onFilter(filter);
      setRequest("");
      setOpen(false);
    } catch (e) {
      if (!isCancellation(e)) setError(String(e));
    } finally {
      useAiRunStore.getState().finish(id);
      setRunId(null);
    }
  };

  return (
    <span ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={t("db.aiFilter")}
        aria-label={t("db.aiFilter")}
        aria-expanded={open}
        className={`flex h-[22px] items-center gap-1 rounded border px-1.5 text-[11px] transition-colors ${
          open
            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        }`}
      >
        {running ? <ThinkingOrb size="sm" /> : <AiSparkles size={12} />}
        <span className="hidden sm:inline">{t("db.aiFilterShort")}</span>
      </button>

      {open && (
        // Above the bar: the bar sits at the bottom of the panel, and a popover opening downward
        // would open off the panel.
        <div
          role="dialog"
          aria-label={t("db.aiFilter")}
          className="absolute bottom-full right-0 z-30 mb-2 w-[min(460px,80vw)] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5 shadow-[var(--cf-shadow-modal)]"
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--cf-text)]">
            <AiSparkles size={12} className="text-[var(--cf-accent)]" />
            {t("db.aiFilter")}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              // Its own keys: the bar is a form, and Enter here must generate, not submit the
              // filter that is about to be replaced.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  void generate();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  if (running && runId) void useAiRunStore.getState().cancel(runId);
                  else setOpen(false);
                }
              }}
              disabled={running}
              placeholder={tab.filter.trim() ? t("db.aiFilterRefinePlaceholder") : t("db.aiFilterPlaceholder")}
              className={fieldClass({ size: "sm", className: "flex-1" })}
            />
            {running ? (
              <button
                type="button"
                onClick={() => runId && void useAiRunStore.getState().cancel(runId)}
                title={t("db.aiFilterStop")}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Square size={11} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!request.trim()}
                title={t("db.aiFilterGenerate")}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded bg-[var(--cf-accent-fill)] text-white disabled:opacity-40"
              >
                <CornerDownLeft size={12} />
              </button>
            )}
          </div>
          {error ? (
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">{error}</p>
          ) : (
            <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--cf-text-faint)]">
              {tab.filter.trim() ? t("db.aiFilterRefineHint") : t("db.aiFilterHint")}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
