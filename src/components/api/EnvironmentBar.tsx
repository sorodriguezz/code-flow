import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, Settings2 } from "lucide-react";
import { Select } from "../common/Select";
import { useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useT } from "../../state/languageStore";
import { lookupVariable } from "../../lib/api/variables";
import type { VariableContext } from "../../lib/api/variables";
import { VARIABLE_SCOPE_ORDER } from "../../types/api";
import type { VariableScope } from "../../types/api";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The environment picker and its variable quick look, docked to the foot of the sidebar card —
 * the same corner Postman puts them in, and close to the collections they resolve against.
 */

const NO_ENVIRONMENT = "";

/** How far the quick look panel keeps from the viewport edges when it can't sit flush left. */
const PANEL_WIDTH = 340;
const VIEWPORT_MARGIN = 8;

const SCOPE_LABEL: Record<VariableScope, TranslationKey> = {
  local: "api.scope.local",
  data: "api.scope.data",
  environment: "api.scope.environment",
  collection: "api.scope.collection",
  global: "api.scope.global",
};

interface QuickLookRow {
  key: string;
  value: string;
  secret: boolean;
  /** A lower-precedence scope also defines this name, so this row is not what a send would use. */
  shadowed: boolean;
}

function rowsForScope(scope: VariableScope, ctx: VariableContext): QuickLookRow[] {
  const shadowed = (key: string) => lookupVariable(key, ctx)?.scope !== scope;
  if (scope === "local" || scope === "data") {
    return Object.entries(ctx[scope]).map(([key, value]) => ({
      key,
      value,
      secret: false,
      shadowed: shadowed(key),
    }));
  }
  return ctx[scope]
    .filter((variable) => variable.enabled && variable.key.trim() !== "")
    .map((variable) => ({
      key: variable.key,
      value: variable.currentValue !== "" ? variable.currentValue : variable.initialValue,
      secret: variable.secret,
      shadowed: shadowed(variable.key),
    }));
}

/**
 * Postman's eye icon: every variable currently in scope, in the precedence order a send resolves
 * them, so "why is `{{baseUrl}}` still the staging host" is one click to answer.
 *
 * The panel is portalled and opens upward: its host card clips its overflow, and the trigger now
 * sits at the bottom of the window with nothing below it to open into.
 */
function VariableQuickLook({ collectionId }: { collectionId: string | null }) {
  const t = useT();
  const openModal = useApiModalStore((s) => s.openApiModal);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const open = pos !== null;

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)),
      bottom: window.innerHeight - rect.top + 4,
      maxHeight: Math.max(160, rect.top - 12),
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setPos(null);
    };
    const onReflow = () => setPos(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  // `variableContext()` returns a fresh object per call, so it can never be a selector — it is
  // rebuilt only when one of the things it reads changes.
  const context = useMemo(
    () => useApiStore.getState().variableContext(collectionId),
    [collectionId, collections, environments, activeEnvironmentId],
  );

  const sections = VARIABLE_SCOPE_ORDER.map((scope) => ({ scope, rows: rowsForScope(scope, context) }))
    .filter((section) => section.rows.length > 0);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => (open ? setPos(null) : place())}
        title={t("api.env.quickLook")}
        aria-label={t("api.env.quickLook")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <Eye size={14} />
      </button>

      {pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              left: pos.left,
              bottom: pos.bottom,
              width: PANEL_WIDTH,
              maxHeight: Math.min(420, pos.maxHeight),
            }}
            className="z-[9999] flex flex-col overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5">
              <span className="flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
                {t("api.env.quickLook")}
              </span>
              <button
                type="button"
                title={t("api.env.manage")}
                aria-label={t("api.env.manage")}
                onClick={() => {
                  setPos(null);
                  openModal({ kind: "environments" });
                }}
                className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
              >
                <Settings2 size={13} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {sections.length === 0 ? (
                <p className="px-1.5 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">
                  {t("api.env.noVariables")}
                </p>
              ) : (
                sections.map(({ scope, rows }) => (
                  <div key={scope} className="mb-2 last:mb-0">
                    <p className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                      {t(SCOPE_LABEL[scope])}
                    </p>
                    {rows.map((row) => (
                      <div
                        key={`${scope}:${row.key}`}
                        title={row.shadowed ? t("api.env.shadowed") : undefined}
                        className={`flex items-baseline gap-2 rounded px-1.5 py-0.5 ${
                          row.shadowed ? "opacity-45 line-through" : ""
                        }`}
                      >
                        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-[var(--cf-accent)]">
                          {row.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--cf-text)]">
                          {row.secret ? "••••••••" : row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function EnvironmentBar() {
  const t = useT();
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiStore((s) => s.setActiveEnvironment);
  const openTabs = useApiStore((s) => s.openTabs);
  const entityTabs = useApiStore((s) => s.entityTabs);
  const activeTabId = useApiStore((s) => s.activeTabId);

  const options = useMemo(
    () => [
      { value: NO_ENVIRONMENT, label: t("api.env.noEnvironment") },
      ...environments
        .filter((environment) => !environment.is_global)
        .map((environment) => ({ value: environment.id, label: environment.name })),
    ],
    [environments, t],
  );

  // A settings tab counts too: with a collection open, its own variables are the collection scope
  // the picker should be showing.
  const collectionId =
    openTabs.find((tab) => tab.id === activeTabId)?.collectionId ??
    entityTabs.find((tab) => tab.id === activeTabId)?.collectionId ??
    null;

  return (
    <div
      data-tour="api-env"
      className="flex shrink-0 items-center gap-1 border-t border-[var(--cf-border)] px-1.5 py-1.5"
    >
      <div className="min-w-0 flex-1">
        <Select
          size="sm"
          value={activeEnvironmentId ?? NO_ENVIRONMENT}
          onChange={(value) => setActiveEnvironment(value === NO_ENVIRONMENT ? null : value)}
          options={options}
          ariaLabel={t("api.env.select")}
        />
      </div>
      <VariableQuickLook collectionId={collectionId} />
    </div>
  );
}
