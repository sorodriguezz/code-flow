/**
 * The collection's «Mock» panel: the rules its mock server answers with, the server's switch, and
 * what it has been asked (user, 2026-10-23: «Servidor de mocks: en API, dentro de cada colección,
 * con un botón «Levantar mock»»).
 *
 * The rules are saved on their own Save, apart from the settings tab's — they live in `api_mocks`,
 * not on the collection row, and a running mock picks them up the moment they are saved, so the
 * moment they go live should be one the user chose.
 */

import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import { badgeColor, statusColor } from "./methodStyle";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useApiMockStore } from "../../state/apiMockStore";
import { writeClipboardText } from "../../lib/clipboard";
import { apiPickFile, apiReadTextFile } from "../../lib/tauri/apiCommands";
import { importAny } from "../../lib/api/importers";
import {
  defaultMockConfig,
  isSensitiveHeader,
  maskValue,
  mergeRoutes,
  newRoute,
  newVariant,
  routeFromLog,
  routesFromImport,
} from "../../lib/api/mock";
import {
  mockGetConfig,
  mockSaveConfig,
  type MockConfig,
  type MockLogEntry,
  type MockMatchKind,
  type MockRoute,
  type MockVariant,
} from "../../lib/tauri/mockCommands";
import { generateIntoConfig, startMock, stopMock } from "./mockActions";
import type { TranslationKey } from "../../lib/i18n/translations";

const METHODS = ["*", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const SOURCE_LABELS: Record<MockRoute["source"], TranslationKey> = {
  request: "api.mock.source.request",
  openapi: "api.mock.source.openapi",
  manual: "api.mock.source.manual",
  log: "api.mock.source.log",
};

const BODY_EDITOR_OPTIONS = {
  ...OVERFLOW_SAFE_OPTIONS,
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbers: "off" as const,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  folding: false,
  renderLineHighlight: "none" as const,
  automaticLayout: true,
};

export function MockPanel({ collectionId }: { collectionId: string }) {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);
  const running = useApiMockStore((s) => s.running[collectionId]);
  const ensure = useApiMockStore((s) => s.ensure);
  const [saved, setSaved] = useState<MockConfig | null>(null);
  const [draft, setDraft] = useState<MockConfig>(defaultMockConfig);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"route" | "log">("route");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ensure();
    let live = true;
    void mockGetConfig(collectionId)
      .then((config) => {
        if (!live) return;
        setSaved(config);
        setDraft(config);
        setSelectedId(config.routes[0]?.id ?? null);
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
    return () => {
      live = false;
    };
  }, [collectionId, ensure]);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const selected = draft.routes.find((r) => r.id === selectedId) ?? null;

  const patchRoute = (id: string, patch: Partial<MockRoute>) =>
    setDraft((d) => ({ ...d, routes: d.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  const save = async (config = draft) => {
    await mockSaveConfig(collectionId, config);
    setSaved(config);
    setDraft(config);
  };

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = () =>
    run(async () => {
      if (running) {
        await stopMock(collectionId);
        return;
      }
      if (dirty || !draft.routes.length) {
        // The first press on an empty mock fills it from the collection, as the header button does.
        const config = draft.routes.length ? draft : (await generateIntoConfig(collectionId, draft)).config;
        await save(config);
        if (!selectedId) setSelectedId(config.routes[0]?.id ?? null);
      }
      const status = await startMock(collectionId);
      pushToast(t("api.mock.started", { url: status.url }), "success");
    });

  const generate = () =>
    run(async () => {
      const { config, added } = await generateIntoConfig(collectionId, draft);
      setDraft(config);
      if (!selectedId) setSelectedId(config.routes[0]?.id ?? null);
      pushToast(t("api.mock.generated", { count: String(added) }), added ? "success" : "info");
    });

  const importOpenApi = () =>
    run(async () => {
      const path = await apiPickFile(["json", "yaml", "yml"]);
      if (!path) return;
      const result = await importAny(await apiReadTextFile(path), { includeExamples: true });
      if (result.format !== "openapi") {
        pushErrorToast(t("api.mock.notOpenApi"));
        return;
      }
      const { routes, added } = mergeRoutes(draft.routes, routesFromImport(result));
      setDraft((d) => ({ ...d, routes }));
      if (!selectedId) setSelectedId(routes[0]?.id ?? null);
      pushToast(t("api.mock.generated", { count: String(added) }), added ? "success" : "info");
    });

  const addRoute = (route = newRoute()) => {
    setDraft((d) => ({ ...d, routes: [...d.routes, route] }));
    setSelectedId(route.id);
    setView("route");
  };

  const removeRoute = (id: string) => {
    setDraft((d) => ({ ...d, routes: d.routes.filter((r) => r.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };

  if (saved === null) return <div className="h-full" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The server: its switch, where it listens, and the three choices that change how. */}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleServer()}
          className={buttonClass({ variant: running ? "secondary" : "primary", size: "sm" })}
        >
          {running ? <Square size={12} /> : <Play size={12} />}
          {running ? t("api.mock.stop") : t("api.mock.start")}
        </button>
        {running ? (
          <span className={chipClass("ok")}>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-success)]" />
            <span className="font-mono">{running.url}</span>
            <Tooltip label={t("api.mock.copyUrl")}>
              <button
                type="button"
                aria-label={t("api.mock.copyUrl")}
                onClick={() =>
                  void writeClipboardText(running.url).then(() => pushToast(t("api.mock.copied"), "success"))
                }
                className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--cf-hover)]"
              >
                <Copy size={10} />
              </button>
            </Tooltip>
          </span>
        ) : (
          <span className={chipClass("neutral")}>{t("api.mock.stopped")}</span>
        )}

        <label className="ml-2 flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          {t("api.mock.port")}
          <input
            value={draft.port || ""}
            onChange={(e) => setDraft((d) => ({ ...d, port: clampInt(e.target.value, 0, 65535) }))}
            placeholder={t("api.mock.portAuto")}
            inputMode="numeric"
            className={fieldClass({ size: "sm", className: "w-[72px] tabular-nums" })}
          />
        </label>
        <CheckLabel checked={draft.cors} onChange={(cors) => setDraft((d) => ({ ...d, cors }))} label={t("api.mock.cors")} hint={t("api.mock.corsHint")} />
        <CheckLabel
          checked={draft.withServices}
          onChange={(withServices) => setDraft((d) => ({ ...d, withServices }))}
          label={t("api.mock.withServices")}
          hint={t("api.mock.withServicesHint")}
        />
        <CheckLabel checked={draft.exposeLan} onChange={(exposeLan) => setDraft((d) => ({ ...d, exposeLan }))} label={t("api.mock.exposeLan")} hint={t("api.mock.exposeLanHint")} />

        <button
          type="button"
          onClick={() => void run(() => save())}
          disabled={!dirty || busy}
          className={buttonClass({ variant: "secondary", size: "sm", className: "ml-auto" })}
        >
          <Save size={12} />
          {t("api.save")}
        </button>
      </div>
      {draft.exposeLan && (
        <p className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-3.5 py-1 text-[12px] text-[var(--cf-warning)]">
          <TriangleAlert size={12} className="shrink-0" />
          {t("api.mock.exposeLanWarning")}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Routes */}
        <div className="flex w-[280px] shrink-0 flex-col border-r border-[var(--cf-border)]">
          <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
            <span className="min-w-0 flex-1 truncate pl-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              {t("api.mock.routes", { count: String(draft.routes.length) })}
            </span>
            <Tooltip label={t("api.mock.generate")} description={t("api.mock.generateHint")}>
              <button type="button" disabled={busy} onClick={() => void generate()} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.generate")}>
                <Wand2 size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t("api.mock.importOpenApi")} description={t("api.mock.importOpenApiHint")}>
              <button type="button" disabled={busy} onClick={() => void importOpenApi()} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.importOpenApi")}>
                <FileUp size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t("api.mock.addRoute")}>
              <button type="button" onClick={() => addRoute()} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.addRoute")}>
                <Plus size={13} />
              </button>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {draft.routes.length === 0 && (
              <p className="px-3 py-1 text-[12px] text-[var(--cf-text-muted)]">{t("api.mock.noRoutes")}</p>
            )}
            {draft.routes.map((route) => (
              <div
                key={route.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedId(route.id);
                  setView("route");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSelectedId(route.id);
                }}
                className={`mx-1 flex h-7 cursor-default items-center gap-1.5 rounded-md px-1.5 text-[12px] ${
                  route.id === selectedId && view === "route" ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                } ${route.enabled ? "" : "opacity-50"}`}
              >
                <span onClick={(e) => e.stopPropagation()} className="flex">
                  <Checkbox checked={route.enabled} onChange={(enabled) => patchRoute(route.id, { enabled })} />
                </span>
                <span className="w-[46px] shrink-0 truncate font-mono text-[10.5px] font-semibold" style={{ color: badgeColor("http", route.method === "*" ? "GET" : route.method) }}>
                  {route.method === "*" ? t("api.mock.anyMethod") : route.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]" title={route.path}>
                  {route.path}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Route editor / log */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
            <Segmented
              size="sm"
              layoutId="cf-api-mock-view"
              value={view}
              onChange={setView}
              options={[
                { value: "route", label: t("api.mock.route") },
                { value: "log", label: t("api.mock.log") },
              ]}
            />
            {view === "route" && selected && (
              <Tooltip label={t("api.mock.removeRoute")}>
                <button type="button" onClick={() => removeRoute(selected.id)} className={iconButtonClass({ size: "xs", className: "ml-auto" })} aria-label={t("api.mock.removeRoute")}>
                  <Trash2 size={13} />
                </button>
              </Tooltip>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {view === "log" ? (
              <MockLog collectionId={collectionId} onAddRoute={(entry) => addRoute(routeFromLog(entry))} />
            ) : selected ? (
              <RouteEditor key={selected.id} route={selected} onChange={(patch) => patchRoute(selected.id, patch)} />
            ) : (
              <p className="px-3.5 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("api.mock.pickRoute")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw.replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function CheckLabel({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <Tooltip label={label} description={hint}>
      <label className="flex cursor-default items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
        <Checkbox checked={checked} onChange={onChange} />
        {label}
      </label>
    </Tooltip>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{children}</span>;
}

// ---------------------------------------------------------------------------
// Route editor
// ---------------------------------------------------------------------------

function RouteEditor({ route, onChange }: { route: MockRoute; onChange: (patch: Partial<MockRoute>) => void }) {
  const t = useT();
  const patchVariant = (id: string, patch: Partial<MockVariant>) =>
    onChange({ variants: route.variants.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  const moveVariant = (index: number, delta: number) => {
    const next = [...route.variants];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange({ variants: next });
  };

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-[120px] flex-col gap-1">
          <FieldLabel>{t("api.mock.method")}</FieldLabel>
          <Select
            size="sm"
            value={route.method}
            onChange={(method) => onChange({ method })}
            options={METHODS.map((m) => ({ value: m, label: m === "*" ? t("api.mock.anyMethod") : m }))}
          />
        </label>
        <label className="flex min-w-[220px] flex-1 flex-col gap-1">
          <FieldLabel>{t("api.mock.path")}</FieldLabel>
          <input value={route.path} onChange={(e) => onChange({ path: e.target.value })} placeholder="/users/:id" className={fieldClass({ size: "sm", className: "font-mono" })} />
        </label>
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <FieldLabel>{t("api.mock.name")}</FieldLabel>
          <input value={route.name} onChange={(e) => onChange({ name: e.target.value })} className={fieldClass({ size: "sm" })} />
        </label>
      </div>
      <p className="-mt-1.5 text-[11.5px] text-[var(--cf-text-faint)]">
        {t("api.mock.pathHint")} · {t(SOURCE_LABELS[route.source] ?? "api.mock.source.manual")}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <FieldLabel>{t("api.mock.delay")}</FieldLabel>
          <span className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
            <input
              value={route.delayMinMs || ""}
              onChange={(e) => onChange({ delayMinMs: clampInt(e.target.value, 0, 60000) })}
              placeholder="0"
              inputMode="numeric"
              className={fieldClass({ size: "sm", className: "w-[70px] tabular-nums" })}
            />
            –
            <input
              value={route.delayMaxMs || ""}
              onChange={(e) => onChange({ delayMaxMs: clampInt(e.target.value, 0, 60000) })}
              placeholder="0"
              inputMode="numeric"
              className={fieldClass({ size: "sm", className: "w-[70px] tabular-nums" })}
            />
            ms
          </span>
        </label>
        <label className="flex w-[170px] flex-col gap-1">
          <FieldLabel>{t("api.mock.failure")}</FieldLabel>
          <Select
            size="sm"
            value={route.errorMode}
            onChange={(errorMode) => onChange({ errorMode: errorMode as MockRoute["errorMode"] })}
            options={[
              { value: "none", label: t("api.mock.failure.none") },
              { value: "status", label: t("api.mock.failure.status") },
              { value: "drop", label: t("api.mock.failure.drop") },
            ]}
          />
        </label>
        {route.errorMode !== "none" && (
          <>
            {route.errorMode === "status" && (
              <label className="flex flex-col gap-1">
                <FieldLabel>{t("api.mock.status")}</FieldLabel>
                <input
                  value={route.errorStatus || ""}
                  onChange={(e) => onChange({ errorStatus: clampInt(e.target.value, 0, 599) })}
                  inputMode="numeric"
                  className={fieldClass({ size: "sm", className: "w-[64px] tabular-nums" })}
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <FieldLabel>{t("api.mock.probability")}</FieldLabel>
              <span className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
                <input
                  value={Math.round(route.errorRate * 100) || ""}
                  onChange={(e) => onChange({ errorRate: clampInt(e.target.value, 0, 100) / 100 })}
                  placeholder="0"
                  inputMode="numeric"
                  className={fieldClass({ size: "sm", className: "w-[56px] tabular-nums" })}
                />
                %
              </span>
            </label>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <FieldLabel>{t("api.mock.variants")}</FieldLabel>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-faint)]">{t("api.mock.variantsHint")}</span>
        <button
          type="button"
          onClick={() => onChange({ variants: [newVariant({ name: t("api.mock.variant"), matchKind: "query" }), ...route.variants] })}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <Plus size={12} />
          {t("api.mock.addVariant")}
        </button>
      </div>
      {route.variants.map((variant, index) => (
        <VariantCard
          key={variant.id}
          variant={variant}
          isLast={index === route.variants.length - 1}
          canUp={index > 0}
          canDown={index < route.variants.length - 1}
          onUp={() => moveVariant(index, -1)}
          onDown={() => moveVariant(index, 1)}
          onRemove={() => onChange({ variants: route.variants.filter((v) => v.id !== variant.id) })}
          onChange={(patch) => patchVariant(variant.id, patch)}
        />
      ))}
      <p className="text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("api.mock.templateHint")}</p>
    </div>
  );
}

function VariantCard({
  variant,
  isLast,
  canUp,
  canDown,
  onUp,
  onDown,
  onRemove,
  onChange,
}: {
  variant: MockVariant;
  isLast: boolean;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onChange: (patch: Partial<MockVariant>) => void;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const language = variant.body.trim().startsWith("{") || variant.body.trim().startsWith("[") ? "json" : "plaintext";
  const conditional = variant.matchKind !== "always";

  return (
    <div className="rounded-lg border border-[var(--cf-border)]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <input
          value={variant.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("api.mock.variant")}
          className={fieldClass({ size: "sm", className: "w-[130px]" })}
        />
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.mock.when")}</span>
        <Select
          size="sm"
          className="!w-[150px]"
          value={variant.matchKind}
          onChange={(matchKind) => onChange({ matchKind: matchKind as MockMatchKind })}
          options={[
            { value: "always", label: isLast ? t("api.mock.match.default") : t("api.mock.match.always") },
            { value: "query", label: t("api.mock.match.query") },
            { value: "header", label: t("api.mock.match.header") },
            { value: "body", label: t("api.mock.match.body") },
          ]}
        />
        {conditional && (
          <>
            <input
              value={variant.matchKey}
              onChange={(e) => onChange({ matchKey: e.target.value })}
              placeholder={variant.matchKind === "body" ? "user.role" : t("api.mock.key")}
              className={fieldClass({ size: "sm", className: "w-[120px] font-mono" })}
            />
            <span className="text-[12px] text-[var(--cf-text-muted)]">=</span>
            <input
              value={variant.matchValue}
              onChange={(e) => onChange({ matchValue: e.target.value })}
              placeholder={t("api.mock.value")}
              className={fieldClass({ size: "sm", className: "w-[120px] font-mono" })}
            />
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.mock.status")}</span>
          <input
            value={variant.status || ""}
            onChange={(e) => onChange({ status: clampInt(e.target.value, 0, 599) })}
            inputMode="numeric"
            className={fieldClass({ size: "sm", className: "w-[56px] tabular-nums" })}
            style={{ color: statusColor(variant.status) }}
          />
          <button type="button" disabled={!canUp} onClick={onUp} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.moveUp")}>
            <ArrowUp size={12} />
          </button>
          <button type="button" disabled={!canDown} onClick={onDown} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.moveDown")}>
            <ArrowDown size={12} />
          </button>
          <button type="button" onClick={onRemove} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.removeVariant")}>
            <X size={12} />
          </button>
        </span>
      </div>
      <HeaderRows headers={variant.headers} onChange={(headers) => onChange({ headers })} />
      <div className="h-[150px] border-t border-[var(--cf-border)]">
        <Editor
          height="100%"
          path={`cf-api:/mock/${variant.id}`}
          language={language}
          value={variant.body}
          theme={monacoTheme}
          onChange={(value) => onChange({ body: value ?? "" })}
          options={BODY_EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
}

function HeaderRows({ headers, onChange }: { headers: MockVariant["headers"]; onChange: (next: MockVariant["headers"]) => void }) {
  const t = useT();
  const patch = (index: number, change: Partial<MockVariant["headers"][number]>) =>
    onChange(headers.map((h, i) => (i === index ? { ...h, ...change } : h)));
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      {headers.map((header, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Checkbox checked={header.enabled} onChange={(enabled) => patch(index, { enabled })} />
          <input value={header.key} onChange={(e) => patch(index, { key: e.target.value })} placeholder={t("api.mock.headerName")} className={fieldClass({ size: "sm", className: "w-[180px] font-mono" })} />
          <input value={header.value} onChange={(e) => patch(index, { value: e.target.value })} placeholder={t("api.mock.value")} className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })} />
          <button type="button" onClick={() => onChange(headers.filter((_, i) => i !== index))} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.removeHeader")}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...headers, { key: "", value: "", enabled: true }])}
        className="self-start text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      >
        + {t("api.mock.addHeader")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

function MockLog({ collectionId, onAddRoute }: { collectionId: string; onAddRoute: (entry: MockLogEntry) => void }) {
  const t = useT();
  const entries = useApiMockStore((s) => s.logs[collectionId]);
  const loadLog = useApiMockStore((s) => s.loadLog);
  const clearLog = useApiMockStore((s) => s.clearLog);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    void loadLog(collectionId);
  }, [collectionId, loadLog]);

  const rows = useMemo(() => [...(entries ?? [])].reverse(), [entries]);
  const open = rows.find((e) => e.seq === openSeq) ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11.5px] text-[var(--cf-text-faint)]">
        <span className="min-w-0 flex-1 truncate">{t("api.mock.logHint")}</span>
        <Tooltip label={reveal ? t("api.mock.hideSecrets") : t("api.mock.revealSecrets")}>
          <button type="button" onClick={() => setReveal((r) => !r)} className={iconButtonClass({ size: "xs", active: reveal })} aria-pressed={reveal} aria-label={t("api.mock.revealSecrets")}>
            {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </Tooltip>
        <Tooltip label={t("api.mock.clearLog")}>
          <button type="button" disabled={!rows.length} onClick={() => void clearLog(collectionId)} className={iconButtonClass({ size: "xs" })} aria-label={t("api.mock.clearLog")}>
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>
      {rows.length === 0 && <p className="px-3 py-1 text-[12px] text-[var(--cf-text-muted)]">{t("api.mock.logEmpty")}</p>}
      {rows.map((entry) => (
        <div key={entry.seq}>
          <button
            type="button"
            onClick={() => setOpenSeq(openSeq === entry.seq ? null : entry.seq)}
            className={`flex h-7 w-full items-center gap-2 px-3 text-left text-[12px] ${openSeq === entry.seq ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"}`}
          >
            <span className="w-[62px] shrink-0 tabular-nums text-[var(--cf-text-faint)]">{new Date(entry.at).toLocaleTimeString()}</span>
            <span className="w-[52px] shrink-0 font-mono text-[10.5px] font-semibold" style={{ color: badgeColor("http", entry.method) }}>
              {entry.method}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={entry.path}>
              {entry.path}
              {entry.query ? `?${entry.query}` : ""}
            </span>
            <span className={`max-w-[160px] shrink-0 truncate ${entry.routeId || entry.variantName === "cors-preflight" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-warning)]"}`}>
              {entry.variantName === "cors-preflight" ? t("api.mock.preflight") : (entry.routeName ?? t("api.mock.noRoute"))}
            </span>
            <span className="w-[38px] shrink-0 text-right font-mono tabular-nums" style={{ color: entry.status ? statusColor(entry.status) : "var(--cf-danger)" }}>
              {entry.status || t("api.mock.dropped")}
            </span>
            <span className="w-[54px] shrink-0 text-right tabular-nums text-[var(--cf-text-faint)]">{entry.latencyMs} ms</span>
          </button>
          {open?.seq === entry.seq && (
            <div className="flex flex-col gap-2 border-y border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2">
              {!entry.routeId && entry.variantName !== "cors-preflight" && (
                <button type="button" onClick={() => onAddRoute(entry)} className={buttonClass({ variant: "secondary", size: "sm", className: "self-start" })}>
                  <Plus size={12} />
                  {t("api.mock.addFromCall")}
                </button>
              )}
              <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[11.5px]">
                {entry.headers.map(([key, value], i) => (
                  <div key={i} className="contents">
                    <span className="text-[var(--cf-text-muted)]">{key}</span>
                    <span className="break-all">{!reveal && isSensitiveHeader(key) ? maskValue(value) : value}</span>
                  </div>
                ))}
              </div>
              {entry.body && (
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--cf-border)] px-2 py-1.5 font-mono text-[11.5px]">
                  {entry.body}
                  {entry.bodyTruncated ? "\n…" : ""}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
