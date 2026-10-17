import { useEffect, useMemo, useState } from "react";
import { FolderCode, Loader2, Search } from "lucide-react";
import { ApiModal } from "./ApiModal";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { badgeColor } from "./methodStyle";
import { apiImportTree, apiScanRoutes, type RouteHit } from "../../lib/tauri/apiCommands";
import { buildImportPayload } from "../../lib/api/importPayload";
import { useApiStore } from "../../state/apiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { defaultRequestSpec, emptyKeyValue, type ApiRequestSpec, type ImportedCollection, type ImportedItem } from "../../types/api";

const NO_PROJECTS: never[] = [];

function rowId(): string {
  return `kv-${Math.random().toString(36).slice(2, 10)}`;
}

/** The request a route becomes: the method, `{{baseUrl}}` + the path, its `:params` in the table. */
function specForRoute(route: RouteHit): ApiRequestSpec {
  const spec = defaultRequestSpec("http");
  spec.method = route.method;
  spec.url = `{{baseUrl}}${route.path}`;
  spec.pathVars = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => ({ ...emptyKeyValue(rowId()), key: match[1] }));
  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    spec.body = { ...spec.body, mode: "raw", rawLanguage: "json", raw: "{\n  \n}" };
    spec.headers = [{ ...emptyKeyValue(rowId()), key: "Content-Type", value: "application/json" }];
  }
  spec.description = `${route.framework} · ${route.file}:${route.line}`;
  return spec;
}

/** One folder per resource — the path's first segment that is not a parameter (`/users/:id` → users). */
function groupRoutes(routes: RouteHit[]): ImportedItem[] {
  const folders = new Map<string, ImportedItem[]>();
  const loose: ImportedItem[] = [];
  for (const route of routes) {
    const item: ImportedItem = { kind: "request", name: `${route.method} ${route.path}`, spec: specForRoute(route) };
    const segments = route.path.split("/").filter((segment) => segment && !segment.startsWith(":"));
    const resource = segments[0] === "api" || /^v\d+$/.test(segments[0] ?? "") ? segments.find((s, i) => i > 0 && s !== "api" && !/^v\d+$/.test(s)) : segments[0];
    if (!resource) {
      loose.push(item);
      continue;
    }
    folders.set(resource, [...(folders.get(resource) ?? []), item]);
  }
  const grouped: ImportedItem[] = [...folders.entries()].map(([name, items]) =>
    items.length === 1
      ? items[0]
      : { kind: "folder", name, description: "", auth: null, preScript: "", postScript: "", items },
  );
  return [...grouped, ...loose];
}

/**
 * «Desde el código del repositorio»: the routes a repository of this workspace declares, read from
 * its source (`api_scan_routes`), turned into a collection — or one of them opened as a scratch tab.
 */
export function RepoRoutesModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined) ?? NO_PROJECTS);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const [projectId, setProjectId] = useState(() => (projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "");
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [routes, setRoutes] = useState<RouteHit[] | null>(null);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const keyOf = (route: RouteHit) => `${route.method} ${route.path} ${route.file}`;

  useEffect(() => {
    if (!project) return;
    let live = true;
    setRoutes(null);
    setError("");
    setExcluded(new Set());
    setName(t("api.routes.collectionName", { name: project.name }));
    void apiScanRoutes(project.local_path)
      .then((found) => live && setRoutes(found))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [project, t]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (routes ?? []).filter((route) => !needle || `${route.method} ${route.path} ${route.file}`.toLowerCase().includes(needle));
  }, [routes, query]);
  const chosen = (routes ?? []).filter((route) => !excluded.has(keyOf(route)));

  const toggle = (route: RouteHit, on: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (on) next.delete(keyOf(route));
      else next.add(keyOf(route));
      return next;
    });

  const open = (route: RouteHit) => {
    const store = useApiStore.getState();
    const tabId = store.openScratchTab("http");
    store.updateDraft(tabId, specForRoute(route));
    store.renameTab(tabId, `${route.method} ${route.path}`);
    onClose();
  };

  const create = async () => {
    const store = useApiStore.getState();
    if (!store.workspaceId || chosen.length === 0) return;
    setCreating(true);
    try {
      const collection: ImportedCollection = {
        name: name.trim() || t("api.routes.collectionName", { name: project?.name ?? "" }),
        description: t("api.routes.collectionDescription", { path: project?.local_path ?? "" }),
        auth: null,
        variables: [
          { id: rowId(), key: "baseUrl", initialValue: baseUrl.trim(), currentValue: baseUrl.trim(), secret: false, enabled: true, description: "" },
        ],
        preScript: "",
        postScript: "",
        items: groupRoutes(chosen),
      };
      await apiImportTree(store.workspaceId, buildImportPayload("routes", [collection], []));
      await store.reloadTree();
      pushSuccessToast(t("api.routes.created", { n: chosen.length }));
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <ApiModal
      icon={FolderCode}
      title={t("api.routes.title")}
      subtitle={t("api.routes.subtitle")}
      width="max-w-3xl"
      height="h-[78vh]"
      busy={creating}
      onClose={onClose}
      toolbar={
        projects.length > 0 ? (
          <div className="w-[220px]">
            <Select size="sm" value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.name }))} ariaLabel={t("api.routes.repo")} />
          </div>
        ) : undefined
      }
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">
            {routes ? t("api.routes.count", { chosen: chosen.length, total: routes.length }) : ""}
          </span>
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={() => void create()} disabled={creating || chosen.length === 0} className={buttonClass({ variant: "primary", size: "sm" })}>
            {creating && <Loader2 size={13} className="animate-spin" />}
            {t("api.routes.create")}
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <label className="flex min-w-[160px] flex-1 items-center gap-1.5">
            <span className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("api.routes.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })} />
          </label>
          <label className="flex min-w-[200px] flex-1 items-center gap-1.5" title={t("api.routes.baseUrlHint")}>
            <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text-muted)]">{"{{baseUrl}}"}</span>
            <input value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })} />
          </label>
          <label className="flex w-full items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2">
            <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("api.routes.filter")} className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-[var(--cf-text)] outline-none" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {projects.length === 0 ? (
            <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("api.routes.noRepos")}</p>
          ) : error ? (
            <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
          ) : routes === null ? (
            <div className="flex items-center gap-2 p-4 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("api.routes.scanning")}
            </div>
          ) : routes.length === 0 ? (
            <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("api.routes.none")}</p>
          ) : (
            shown.map((route) => (
              <div key={keyOf(route)} className="group flex items-center gap-2 px-3 py-1 text-[12px] hover:bg-[var(--cf-hover)]">
                <Checkbox checked={!excluded.has(keyOf(route))} onChange={(on) => toggle(route, on)} />
                <span className="w-16 shrink-0 rounded px-1 text-center font-mono text-[10.5px] font-bold" style={{ color: badgeColor("http", route.method), backgroundColor: `color-mix(in oklab, ${badgeColor("http", route.method)} 12%, transparent)` }}>
                  {route.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--cf-text)]">{route.path}</span>
                <span className="hidden shrink-0 truncate text-[11px] text-[var(--cf-text-faint)] sm:block" title={`${route.file}:${route.line}`}>
                  {route.framework} · {route.file.split("/").pop()}:{route.line}
                </span>
                <button type="button" onClick={() => open(route)} className={buttonClass({ variant: "ghost", size: "sm", className: "opacity-0 group-hover:opacity-100 focus:opacity-100" })}>
                  {t("api.routes.open")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </ApiModal>
  );
}
