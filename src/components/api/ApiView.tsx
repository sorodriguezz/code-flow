import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cookie,
  Download,
  Eye,
  Play,
  Plus,
  Settings,
  Settings2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ApiSidebar } from "./ApiSidebar";
import { RequestTabs } from "./RequestTabs";
import { RequestBuilder } from "./RequestBuilder";
import { CodeSnippetPanel } from "./CodeSnippetPanel";
import { EnvironmentModal } from "./EnvironmentModal";
import { ImportModal } from "./ImportModal";
import { ExportModal } from "./ExportModal";
import { RunnerModal } from "./RunnerModal";
import { ApiSettingsModal } from "./ApiSettingsModal";
import { CookieModal } from "./CookieModal";
import { tabActions } from "./tabActions";
import { CARD } from "./panelChrome";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useUiStore } from "../../state/uiStore";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { lookupVariable } from "../../lib/api/variables";
import type { VariableContext } from "../../lib/api/variables";
import { VARIABLE_SCOPE_ORDER } from "../../types/api";
import type { VariableScope } from "../../types/api";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The API client's shell: toolbar, sidebar, tab strip, request builder, response pane and the
 * code-snippet panel. Every panel below reads `apiStore`/`apiRuntimeStore` on its own — this file
 * only decides what is on screen, owns the modals, and binds the three keyboard shortcuts.
 */

const NO_ENVIRONMENT = "";

function ToolbarButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cf-text-muted)] dark:hover:bg-white/[0.08]"
    >
      <Icon size={14} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Variable quick look
// ---------------------------------------------------------------------------

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
 */
function VariableQuickLook({ collectionId }: { collectionId: string | null }) {
  const t = useT();
  const openModal = useApiModalStore((s) => s.openApiModal);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
    <div ref={wrapperRef} className="relative shrink-0">
      <ToolbarButton icon={Eye} label={t("api.env.quickLook")} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 flex max-h-[420px] w-[340px] flex-col overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5">
            <span className="flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
              {t("api.env.quickLook")}
            </span>
            <button
              type="button"
              title={t("api.env.manage")}
              aria-label={t("api.env.manage")}
              onClick={() => {
                setOpen(false);
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
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function ApiEmptyState() {
  const t = useT();
  const openModal = useApiModalStore((s) => s.openApiModal);
  const collections = useApiStore((s) => s.collections);
  const pushToast = useToastStore((s) => s.pushToast);

  const newCollection = async () => {
    const created = await useApiStore.getState().createCollection(t("api.untitledCollection"));
    if (created) pushToast(t("api.toast.collectionCreated", { name: created.name }), "success");
  };

  const action = (label: string, icon: LucideIcon, onClick: () => void, primary = false) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium ${
          primary
            ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
            : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        }`}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
      {/* `EmptyState` is `h-full`, so it needs a box with a resolved height to centre itself in;
          without one it would either collapse or eat the row the buttons live in. */}
      <div className="h-[150px] w-full">
        {/* The subtitle says "this workspace" rather than just "no collections": an empty API view
            straight after a workspace switch otherwise reads as "my collections are gone". */}
        <EmptyState
          icon={Zap}
          title={t("api.title")}
          subtitle={collections.length === 0 ? t("api.noCollectionsInWorkspace") : undefined}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {action(t("api.newRequest"), Plus, () => useApiStore.getState().openScratchTab(), true)}
        {action(t("api.newCollection"), Plus, () => void newCollection())}
        {action(t("api.import.title"), Download, () => openModal({ kind: "import" }))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ApiView() {
  const t = useT();
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiStore((s) => s.setActiveEnvironment);
  const openTabs = useApiStore((s) => s.openTabs);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const activeView = useUiStore((s) => s.activeView);
  const modal = useApiModalStore((s) => s.modal);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const closeModal = useApiModalStore((s) => s.closeApiModal);

  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;

  const closeActiveTab = useCallback(async () => {
    const store = useApiStore.getState();
    const tab = store.openTabs.find((candidate) => candidate.id === store.activeTabId);
    if (!tab) return;
    if (tab.dirty) {
      const name = tab.name || t("api.untitledRequest");
      if (!(await confirmAction(t("editor.closeDirtyConfirm", { name })))) return;
    }
    useApiStore.getState().closeTab(tab.id);
  }, [t]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘S would save an API request
  // while the user is looking at the diff of a commit.
  useEffect(() => {
    if (activeView !== "api") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      // A modal covers the builder, so ⌘W there would close a tab the user can't even see.
      if (useApiModalStore.getState().modal !== null) return;
      const tabId = useApiStore.getState().activeTabId;
      if (!tabId) return;
      if (e.key === "s") {
        e.preventDefault();
        tabActions(tabId)?.save();
      } else if (e.key === "Enter") {
        e.preventDefault();
        tabActions(tabId)?.send();
      } else if (e.key === "w") {
        e.preventDefault();
        void closeActiveTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, closeActiveTab]);

  const environmentOptions = useMemo(
    () => [
      { value: NO_ENVIRONMENT, label: t("api.env.noEnvironment") },
      ...environments
        .filter((environment) => !environment.is_global)
        .map((environment) => ({ value: environment.id, label: environment.name })),
    ],
    [environments, t],
  );

  // The runner always runs *something*: whatever collection the open request belongs to, or the
  // first one, so the toolbar button doesn't need a picker of its own.
  const runnerCollectionId = activeTab?.collectionId ?? collections[0]?.id ?? null;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1">
          <div className="w-[220px] shrink-0">
            <Select
              size="sm"
              value={activeEnvironmentId ?? NO_ENVIRONMENT}
              onChange={(value) => setActiveEnvironment(value === NO_ENVIRONMENT ? null : value)}
              options={environmentOptions}
              ariaLabel={t("api.env.select")}
            />
          </div>
          <VariableQuickLook collectionId={activeTab?.collectionId ?? null} />

          <div className="flex-1" />

          <ToolbarButton
            icon={Play}
            label={t("api.runner.title")}
            disabled={runnerCollectionId === null}
            onClick={() =>
              runnerCollectionId &&
              openModal({ kind: "runner", collectionId: runnerCollectionId, folderId: null })
            }
          />
          <ToolbarButton
            icon={Download}
            label={t("api.import.title")}
            onClick={() => openModal({ kind: "import" })}
          />
          <ToolbarButton
            icon={Cookie}
            label={t("api.cookies")}
            onClick={() => openModal({ kind: "cookies" })}
          />
          <ToolbarButton
            icon={Settings}
            label={t("api.settings.title")}
            onClick={() => openModal({ kind: "settings" })}
          />
        </div>

        {/* Padded and gapped so each column reads as its own card, the way the Editor view lays
            out its rail, tree and editor. The request area is the one that gains most from it:
            flush against the window it looked like a form bolted to the frame. */}
        <div className="flex min-h-0 flex-1 gap-1.5 overflow-hidden p-2">
          <ApiSidebar />

          <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
            {openTabs.length > 0 && <RequestTabs />}
            <div className="min-h-0 flex-1">
              {activeTab ? <RequestBuilder tabId={activeTab.id} /> : <ApiEmptyState />}
            </div>
          </div>

          {/* The snippet mirrors one request, so it has nothing to show without an open tab. */}
          {activeTab && <CodeSnippetPanel tabId={activeTab.id} />}
        </div>
      </div>

      {modal?.kind === "environments" && <EnvironmentModal onClose={closeModal} />}
      {modal?.kind === "import" && <ImportModal onClose={closeModal} />}
      {modal?.kind === "cookies" && <CookieModal onClose={closeModal} />}
      {modal?.kind === "settings" && <ApiSettingsModal onClose={closeModal} />}
      {modal?.kind === "export" && (
        <ExportModal collectionId={modal.collectionId} onClose={closeModal} />
      )}
      {modal?.kind === "runner" && (
        <RunnerModal collectionId={modal.collectionId} folderId={modal.folderId} onClose={closeModal} />
      )}
    </>
  );
}
