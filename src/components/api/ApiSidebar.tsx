import { useMemo, useState } from "react";
import {
  Check,
  Cookie,
  Boxes,
  Download,
  FileCode2,
  Globe,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings,
  Settings2,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import {
  explorerClass,
  fieldClass,
  rowClass,
  sectionLabelClass,
  segItemClass,
  segTrackClass,
} from "../common/recipes";
import { CollectionTree, MethodBadge } from "./CollectionTree";
import { ContextMenu, type MenuItem} from "../common/ContextMenu";
import { EnvironmentBar } from "./EnvironmentBar";
import { HistoryList } from "./HistoryList";
import { useApiStore } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useCollabStore } from "../../state/collabStore";
import { useUiStore } from "../../state/uiStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ApiCollection, ApiFolder, ApiRequestRow } from "../../types/api";

const WIDTH_MIN = 220;
const WIDTH_MAX = 520;

/** Beyond this the list stops being a list; the query wants narrowing, not more scrolling. */
const MAX_RESULTS = 100;

type Section = "collections" | "environments" | "history";

/** The explorer's icon buttons: 26px targets (they were 20px), named by the app's own tooltip. */
function ToolbarButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        disabled={disabled}
        className={iconButtonClass({ size: "sm" })}
      >
        {children}
      </button>
    </Tooltip>
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
      <p className="px-4 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
        {t("api.searchNoResults", { query: query.trim() })}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2.5 pt-1">
      {hits.map((request) => (
        <button
          key={request.id}
          type="button"
          onClick={() => openRequest(request.id)}
          className={rowClass(false, "py-1.5")}
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
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={rowClass(active, "h-[30px]")}
    >
      {icon ?? <span className="w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={14} className="shrink-0 text-[var(--cf-accent)]" />}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${sectionLabelClass} shrink-0 pl-3.5 pr-2 pt-1`}>
        <span className="min-w-0 flex-1 truncate">{t("api.environments")}</span>
        <ToolbarButton onClick={onManage} title={t("api.env.manage")}>
          <Settings2 size={15} />
        </ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2.5">
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
            <Globe size={14} className="shrink-0 text-[var(--cf-text-faint)]" />,
          )}
        {selectable.length === 0 && (
          <button
            type="button"
            onClick={onManage}
            className={buttonClass({ variant: "ghost", size: "sm", className: "mt-1 w-full" })}
          >
            <Plus size={13} />
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
  const collections = useApiStore((s) => s.collections);
  const openTabs = useApiStore((s) => s.openTabs);
  const entityTabs = useApiStore((s) => s.entityTabs);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const conflicts = useCollabStore((s) => s.conflicts);

  const [section, setSection] = useState<Section>("collections");
  const [query, setQuery] = useState("");
  /**
   * The one floating menu this sidebar has room for.
   *
   * `items` is what tells the two apart: absent means the overflow menu behind the ellipsis, which
   * is what this state was added for. The `+` fills it in with its own two entries.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; items?: MenuItem[] } | null>(null);

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

  // The runner always runs *something*: whatever collection the focused tab belongs to — a
  // request's, or the one whose settings are open — or the first one, so the button doesn't need
  // a picker of its own.
  const runnerCollectionId =
    openTabs.find((tab) => tab.id === activeTabId)?.collectionId ??
    entityTabs.find((tab) => tab.id === activeTabId)?.collectionId ??
    collections[0]?.id ??
    null;

  const overflowItems: MenuItem[] = [
    { label: t("api.cookies"), icon: Cookie, onClick: () => openModal({ kind: "cookies" }) },
    {
      label: t("api.settings.title"),
      icon: Settings,
      onClick: () => useUiStore.getState().openApiSettings(),
    },
  ];

  return (
    <>
      <div data-tour="api-sidebar" style={{ width }} className={`${explorerClass} h-full overflow-hidden`}>
        {/* The explorer's head is its three sections — one segmented control rather than a title
            over a row of pills: the title row of the window already says "API client". */}
        <div className="flex h-11 shrink-0 items-center px-2.5">
          <div role="group" aria-label={t("api.title")} className={segTrackClass({ full: true, className: "min-w-0 flex-1" })}>
            {sections.map((entry) => {
              const active = section === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSection(entry.id)}
                  aria-pressed={active}
                  // Truncated in a narrow explorer, so the native title is the fallback that reads
                  // the whole word.
                  title={entry.label}
                  // Sized by its word, not an equal third: "Colecciones" is half again as long as
                  // the other two, and equal thirds cut it off at the explorer's default width.
                  className={segItemClass(active, { className: "min-w-0 flex-auto" })}
                >
                  {active && <ActivePill layoutId="cf-api-section-pill" variant="raised" />}
                  <span className="relative truncate">{entry.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* The tools: the search box over the tree, then everything that creates, runs, imports or
            joins something. On the other two sections the search has nothing to search, so the
            buttons simply keep their place at the right. */}
        <div className="flex shrink-0 items-center gap-1.5 pb-2 pl-2.5 pr-2">
          {section === "collections" ? (
            <label
              className={fieldClass({
                size: "sm",
                className:
                  "flex flex-1 cursor-text items-center gap-1.5 pl-2 pr-0.5 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]",
              })}
            >
              <Search size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("api.searchPlaceholder")}
                aria-label={t("api.searchPlaceholder")}
                className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)]"
              />
              {query && (
                <Tooltip label={t("api.clearSearch")}>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label={t("api.clearSearch")}
                    className={iconButtonClass({ size: "xs" })}
                  >
                    <X size={13} />
                  </button>
                </Tooltip>
              )}
            </label>
          ) : (
            <span className="flex-1" />
          )}
          <div data-tour="api-sidebar-actions" className="flex shrink-0 items-center gap-0.5">
            {/* Two things can be created here and the button used to assume one of them.
                A collection is the container; a request is the thing you actually came to make — and
                needing a collection before you can try a URL is the friction scratch requests exist to
                remove. So it asks, with the request first because that is the common errand. */}
            <ToolbarButton
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  x: rect.left,
                  y: rect.bottom + 2,
                  items: [
                    {
                      label: t("api.newRequest"),
                      icon: FileCode2,
                      onClick: () => useApiStore.getState().openScratchTab(),
                    },
                    {
                      label: t("api.newCollection"),
                      icon: Boxes,
                      onClick: () => void newCollection(),
                    },
                  ],
                });
              }}
              title={t("api.newLabel")}
            >
              <Plus size={15} />
            </ToolbarButton>
            <ToolbarButton
              onClick={() =>
                runnerCollectionId &&
                openModal({ kind: "runner", collectionId: runnerCollectionId, folderId: null })
              }
              disabled={runnerCollectionId === null}
              title={t("api.runner.title")}
            >
              <Play size={15} />
            </ToolbarButton>
            <ToolbarButton onClick={() => openModal({ kind: "import" })} title={t("api.import.title")}>
              <Download size={15} />
            </ToolbarButton>
            {/* Collaboration gets its own button rather than a line in the overflow menu: pasting an
                invitation code is the first thing a new team member does in this app, and it should
                not be two clicks behind a "…". */}
            <ToolbarButton
              onClick={() => openModal({ kind: "collab" })}
              title={t("api.collab.importCollaborative")}
            >
              <Users size={15} />
            </ToolbarButton>
            {conflicts.length > 0 && (
              <ToolbarButton
                onClick={() => openModal({ kind: "conflicts" })}
                title={t("api.conflict.subtitle", { n: String(conflicts.length) })}
              >
                <span className="relative flex items-center justify-center text-[var(--cf-warning)]">
                  <ShieldAlert size={15} />
                  <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--cf-warning)]" />
                </span>
              </ToolbarButton>
            )}
            <ToolbarButton
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 2 });
              }}
              title={t("api.moreActions")}
            >
              <MoreHorizontal size={15} />
            </ToolbarButton>
          </div>
        </div>

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

        {/* Docked to the foot of the explorer: the environment is a property of the whole client,
            not of the section on screen, so it stays put while the sections above it change. */}
        <EnvironmentBar />
      </div>

      {/* Seamless: the explorer draws its own right hairline. */}
      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        onChange={(value) => setSize("apiSidebarWidth", value)}
        onCommit={(value) => commitSize("apiSidebarWidth", value)}
        seamless
      />

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items ?? overflowItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
