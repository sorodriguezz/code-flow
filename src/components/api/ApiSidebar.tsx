import { useMemo, useState } from "react";
import {
  Check,
  Cookie,
  Download,
  Globe,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Settings2,
  X,
} from "lucide-react";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollectionTree, ContextMenu, MethodBadge, type MenuItem } from "./CollectionTree";
import { HistoryList } from "./HistoryList";
import { CARD } from "./panelChrome";
import { useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ApiCollection, ApiFolder, ApiRequestRow } from "../../types/api";

const WIDTH_MIN = 220;
const WIDTH_MAX = 520;

/** Beyond this the list stops being a list; the query wants narrowing, not more scrolling. */
const MAX_RESULTS = 100;

type Section = "collections" | "environments" | "history";

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `Collection / Folder / Subfolder` — where a hit lives, since a flat result list has dropped
 * the nesting that would otherwise say so. */
function breadcrumb(
  request: ApiRequestRow,
  collections: ApiCollection[],
  folders: ApiFolder[],
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = request.folder_id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parent_id;
  }
  const collection = collections.find((c) => c.id === request.collection_id);
  if (collection) names.unshift(collection.name);
  return names.join(" / ");
}

function SearchResults({ query }: { query: string }) {
  const t = useT();
  const collections = useApiStore((s) => s.collections);
  const folders = useApiStore((s) => s.folders);
  const requests = useApiStore((s) => s.requests);
  const openRequest = useApiStore((s) => s.openRequest);

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests
      .filter(
        (request) =>
          request.name.toLowerCase().includes(needle) ||
          request.method.toLowerCase().includes(needle) ||
          request.url.toLowerCase().includes(needle),
      )
      .slice(0, MAX_RESULTS);
  }, [requests, query]);

  if (hits.length === 0) {
    return (
      <p className="px-3 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
        {t("api.searchNoResults", { query: query.trim() })}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {hits.map((request) => (
        <button
          key={request.id}
          onClick={() => openRequest(request.id)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <MethodBadge protocol={request.protocol} method={request.method} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-[var(--cf-text)]">{request.name}</span>
            <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
              {breadcrumb(request, collections, folders)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

function EnvironmentsSection({ onManage }: { onManage: () => void }) {
  const t = useT();
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiStore((s) => s.setActiveEnvironment);

  const globals = environments.find((e) => e.is_global);
  const selectable = environments.filter((e) => !e.is_global);

  const row = (
    key: string,
    label: string,
    active: boolean,
    onClick: () => void,
    icon?: React.ReactNode,
  ) => (
    <button
      key={key}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      {icon ?? <span className="w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={13} className="shrink-0" />}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("api.environments")}
        </span>
        <ToolbarButton onClick={onManage} title={t("api.env.manage")}>
          <Settings2 size={13} />
        </ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {row("none", t("api.env.noEnvironment"), activeEnvironmentId === null, () =>
          setActiveEnvironment(null),
        )}
        {selectable.map((environment) =>
          row(environment.id, environment.name, activeEnvironmentId === environment.id, () =>
            setActiveEnvironment(environment.id),
          ),
        )}
        {/* Globals is never "selected" — it's in scope for every send — so it opens the editor
            instead of switching anything. */}
        {globals &&
          row(
            globals.id,
            t("api.env.globals"),
            false,
            onManage,
            <Globe size={13} className="shrink-0 text-[var(--cf-text-muted)]" />,
          )}
        {selectable.length === 0 && (
          <button
            onClick={onManage}
            className="mt-1 w-full rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            {t("api.env.new")}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

export function ApiSidebar() {
  const t = useT();
  const width = useLayoutStore((s) => s.sizes.apiSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const createCollection = useApiStore((s) => s.createCollection);
  const openModal = useApiModalStore((s) => s.openApiModal);

  const [section, setSection] = useState<Section>("collections");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const sections: { id: Section; label: string }[] = [
    { id: "collections", label: t("api.collections") },
    { id: "environments", label: t("api.environments") },
    { id: "history", label: t("api.history") },
  ];

  const newCollection = async () => {
    const created = await createCollection(t("api.untitledCollection"));
    if (created) {
      useToastStore.getState().pushToast(t("api.toast.collectionCreated", { name: created.name }), "success");
    }
  };

  const overflowItems: MenuItem[] = [
    { label: t("api.cookies"), icon: Cookie, onClick: () => openModal({ kind: "cookies" }) },
    { label: t("api.settings.title"), icon: Settings, onClick: () => openModal({ kind: "settings" }) },
  ];

  return (
    <>
      <div
        style={{ width }}
        className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}
      >
        <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("api.title")}
          </span>
          <ToolbarButton onClick={() => void newCollection()} title={t("api.newCollection")}>
            <Plus size={13} />
          </ToolbarButton>
          <ToolbarButton onClick={() => openModal({ kind: "import" })} title={t("api.import.title")}>
            <Download size={13} />
          </ToolbarButton>
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 2 });
            }}
            title={t("api.moreActions")}
          >
            <MoreHorizontal size={13} />
          </ToolbarButton>
        </div>

        <div className="flex shrink-0 gap-0.5 px-1.5 pt-1.5">
          {sections.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSection(entry.id)}
              className={`min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-[11px] font-medium ${
                section === entry.id
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {section === "collections" && (
          <div className="relative shrink-0 px-1.5 py-1.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("api.searchPlaceholder")}
              className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title={t("api.clearSearch")}
                aria-label={t("api.clearSearch")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {section === "collections" ? (
            query.trim() ? (
              <SearchResults query={query} />
            ) : (
              <CollectionTree />
            )
          ) : section === "environments" ? (
            <EnvironmentsSection onManage={() => openModal({ kind: "environments" })} />
          ) : (
            <HistoryList />
          )}
        </div>
      </div>

      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        onChange={(value) => setSize("apiSidebarWidth", value)}
        onCommit={(value) => commitSize("apiSidebarWidth", value)}
      />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={overflowItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
