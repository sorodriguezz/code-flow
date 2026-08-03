import { useEffect, useMemo, useState } from "react";
import { ClipboardList, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { BATCH_STATUS, SOURCE_KIND } from "./storyStatus";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { CARD } from "../api/panelChrome";
import { relativeTime } from "../api/settingsChrome";
import { ToolbarButton } from "../db/dbChrome";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import { useStoriesStore } from "../../state/storiesStore";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import type { StoryBatch } from "../../types/domain";

/** Where a row's menu was asked for. Only the id is kept, never the row itself — a generation
 * landing replaces the row object, and a menu built from the copy captured on right-click would go
 * on offering "generate" for a batch that has already finished. */
type RowMenu = { x: number; y: number; id: string };

/**
 * The workspace's batches — the index of "what documentation has been turned into a backlog".
 *
 * Flat and newest-first rather than grouped: a batch is a document, and there are tens of them
 * where there are hundreds of agent tasks. The row's second line carries what actually
 * distinguishes two of them — where the source came from, how many stories are in it, and how many
 * of those have reached Azure Boards.
 */
export function StoryBatchList({ width, onNewBatch }: { width: number; onNewBatch: () => void }) {
  const t = useT();
  const batches = useStoriesStore((s) => s.batches);
  const loading = useStoriesStore((s) => s.loading);
  const query = useStoriesStore((s) => s.query);
  const selectedId = useStoriesStore((s) => s.selectedId);
  const targetOpen = useStoriesStore((s) => s.targetOpen);
  const setQuery = useStoriesStore((s) => s.setQuery);
  const toggleTarget = useStoriesStore((s) => s.toggleTarget);
  const activeView = useUiStore((s) => s.activeView);

  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // The menu portals to `document.body`, and this view is hidden rather than unmounted — left
  // open, it would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "stories") setMenu(null);
  }, [activeView]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return batches;
    return batches.filter(
      (batch) =>
        batch.title.toLowerCase().includes(needle) ||
        batch.source_ref.toLowerCase().includes(needle) ||
        batch.ado_project.toLowerCase().includes(needle),
    );
  }, [batches, query]);

  const menuBatch = menu ? (batches.find((batch) => batch.id === menu.id) ?? null) : null;

  const menuItems = (batch: StoryBatch): MenuItem[] => [
    { label: t("stories.rename"), icon: Pencil, onClick: () => setRenamingId(batch.id) },
    {
      label: t("stories.deleteBatch"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => {
        void confirmAction(t("stories.deleteBatchConfirm", { name: batch.title })).then((ok) => {
          if (ok) void useStoriesStore.getState().remove(batch.id);
        });
      },
    },
  ];

  return (
    <div style={{ width }} className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("stories.batches")}
        </span>
        <ToolbarButton onClick={onNewBatch} title={t("stories.newBatch")}>
          <Plus size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={toggleTarget} active={targetOpen} title={t("stories.target")}>
          <SlidersHorizontal size={13} />
        </ToolbarButton>
      </div>

      <div className="relative shrink-0 px-1.5 py-1.5">
        <Search
          size={12}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("stories.searchPlaceholder")}
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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {loading ? null : batches.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
            <div className="w-full">
              <EmptyState
                icon={ClipboardList}
                title={t("stories.batchesEmpty")}
                subtitle={t("stories.batchesEmptyHint")}
              />
            </div>
            <button
              type="button"
              onClick={onNewBatch}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Plus size={13} />
              {t("stories.newBatch")}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
            {t("stories.noMatches")}
          </p>
        ) : (
          <div className="px-1.5">
            {filtered.map((batch) =>
              renamingId === batch.id ? (
                <RenameRow
                  key={batch.id}
                  value={batch.title}
                  onCancel={() => setRenamingId(null)}
                  onCommit={(name) => {
                    void useStoriesStore.getState().rename(batch.id, name);
                    setRenamingId(null);
                  }}
                />
              ) : (
                <BatchRow
                  key={batch.id}
                  batch={batch}
                  selected={batch.id === selectedId}
                  onMenu={(x, y) => setMenu({ x, y, id: batch.id })}
                />
              ),
            )}
          </div>
        )}
      </div>

      {menu && menuBatch && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menuBatch)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function BatchRow({
  batch,
  selected,
  onMenu,
}: {
  batch: StoryBatch;
  selected: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const generating = useStoriesStore((s) => s.runByBatch[batch.id] !== undefined);
  const stories = useStoriesStore((s) => s.storiesByBatch[batch.id]);

  // The live flag wins over the stored status: the row is the truth about a run in this session,
  // and a persisted `generating` is only ever a leftover.
  const status = generating ? "generating" : batch.status;
  const { icon: Icon, color } = BATCH_STATUS[status];
  const { icon: SourceIcon } = SOURCE_KIND[batch.source_kind];

  const when = relativeTime(batch.updated_at, {
    now: t("ai.justNow"),
    minutes: t("ai.minutesAgo"),
    hours: t("ai.hoursAgo"),
    days: t("ai.daysAgo"),
  });

  // Counts only once the batch has been opened: the list deliberately doesn't load every batch's
  // stories, and showing "0 historias" for one that simply hasn't been read yet would be a lie.
  const counts = stories
    ? [
        t("stories.countStories", { n: stories.length }),
        ...(stories.some((story) => story.work_item_id > 0)
          ? [t("stories.countPublished", { n: stories.filter((s) => s.work_item_id > 0).length })]
          : []),
      ]
    : [];
  const meta = [t(SOURCE_KIND[batch.source_kind].labelKey), ...counts, when].filter(Boolean).join(" · ");

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group relative flex w-full items-start rounded-md ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <button
        type="button"
        onClick={() => void useStoriesStore.getState().select(batch.id)}
        aria-current={selected ? "page" : undefined}
        title={batch.source_ref || batch.title}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pl-2 text-left"
      >
        <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {status === "generating" ? (
            <ThinkingOrb size="sm" />
          ) : status === "ready" ? (
            <SourceIcon size={13} className="text-[var(--cf-text-muted)]" />
          ) : (
            <Icon size={13} className={color} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] ${selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"}`}
          >
            {batch.title || t("stories.untitled")}
          </span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{meta}</span>
        </span>
      </button>
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={t("api.moreActions")}
        title={t("api.moreActions")}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.right - 4, rect.bottom + 2);
        }}
        className="flex w-6 shrink-0 items-center justify-center self-stretch rounded-r-md text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

function RenameRow({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Pencil size={12} className="text-[var(--cf-text-muted)]" />
      </span>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(draft);
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1 py-0.5 text-[12px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}
