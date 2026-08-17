import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  Check,
  ChevronRight,
  Copy,
  Folder,
  LayoutGrid,
  List,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Workflow,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { folderInk, ICON_BUTTON } from "./diagramsChrome";
// Reused rather than reimplemented: "how long ago" is not a notes idea, and two implementations of
// it is how one workspace starts saying "2 days ago" while the other says the date.
import { relativeTime, TagPill } from "../notes/notesChrome";
import { folderPath } from "../../lib/diagrams/tree";
import { filterDiagrams, useDiagramsStore } from "../../state/diagramsStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { Diagram, DiagramSort } from "../../types/diagrams";

/** The orderings offered, in the order the menu lists them. */
const SORTS: DiagramSort[] = ["manual", "updated", "created", "title"];

/**
 * The main pane: the diagrams of the selected folder, as cards or as rows.
 *
 * The counterpart of `NoteGallery`. A click opens the diagram in the editor; the context menu holds
 * the actions that organise it without opening anything.
 *
 * **Pictures are fetched for the cards being drawn, not carried with the tree.** A thumbnail is a
 * PNG of tens of kilobytes and the workspace holds every diagram's metadata at once — see
 * `db/diagram_queries.rs`. The effect below asks for what is on screen; `thumbnails` caches the
 * answers; a diagram nobody has drawn in yet has none, and its card shows a glyph.
 */
export function DiagramGallery() {
  const diagrams = useDiagramsStore((s) => s.diagrams);
  const folders = useDiagramsStore((s) => s.folders);
  const query = useDiagramsStore((s) => s.query);
  const tagFilter = useDiagramsStore((s) => s.tagFilter);
  const folderFilter = useDiagramsStore((s) => s.folderFilter);
  const sort = useDiagramsStore((s) => s.sort);
  const galleryView = useDiagramsStore((s) => s.galleryView);
  const activeId = useDiagramsStore((s) => s.activeId);

  const setSort = useDiagramsStore((s) => s.setSort);
  const setGalleryView = useDiagramsStore((s) => s.setGalleryView);
  const setFolderFilter = useDiagramsStore((s) => s.setFolderFilter);
  const openDiagram = useDiagramsStore((s) => s.openDiagram);
  const thumbnails = useDiagramsStore((s) => s.thumbnails);
  const loadThumbnails = useDiagramsStore((s) => s.loadThumbnails);
  const renameDiagram = useDiagramsStore((s) => s.renameDiagram);
  const duplicateDiagram = useDiagramsStore((s) => s.duplicateDiagram);
  const togglePinned = useDiagramsStore((s) => s.togglePinned);
  const deleteDiagram = useDiagramsStore((s) => s.deleteDiagram);
  const toggleTag = useDiagramsStore((s) => s.toggleTag);

  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /**
   * What the pane shows.
   *
   * **While filtering, the folder is ignored and the whole workspace is searched.** A search that
   * only looked inside the folder you happen to have selected would answer "no matches" for a
   * diagram that is right there in the next folder — and the sidebar draws every folder open while
   * a query is live, so the two halves of the screen would disagree about what was found.
   */
  const filtering = query.trim().length > 0 || tagFilter.length > 0;
  const shown = useMemo(
    () =>
      filterDiagrams(diagrams, {
        query,
        tagFilter,
        folderId: filtering ? undefined : folderFilter,
        sort,
      }),
    [diagrams, query, tagFilter, folderFilter, filtering, sort],
  );

  /** The subfolders of the folder being shown, so the gallery can be walked down as well as the
   *  tree. Not while filtering, for the reason above: the result set is the whole workspace then. */
  const subfolders = useMemo(
    () =>
      filtering
        ? []
        : folders
            .filter((folder) => folder.parent_id === folderFilter)
            .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [folders, folderFilter, filtering],
  );

  const crumbs = useMemo(() => folderPath(folders, folderFilter), [folders, folderFilter]);

  /**
   * The pictures for the cards on screen.
   *
   * Asked for after the render that decided what is on screen rather than during it, and only in
   * the grid — the list view draws no pictures, so fetching them for it would be tens of kilobytes
   * per row for nothing. `loadThumbnails` skips ids it has already requested, so a scroll or a
   * re-render costs one comparison per card rather than a round trip.
   */
  useEffect(() => {
    if (galleryView !== "grid" || shown.length === 0) return;
    void loadThumbnails(shown.map((diagram) => diagram.id));
  }, [shown, galleryView, loadThumbnails]);

  const diagramMenu = (diagram: Diagram): MenuItem[] => [
    {
      label: t("diagrams.rename"),
      icon: Pencil,
      onClick: () => {
        void promptAction(t("diagrams.renamePrompt"), {
          initial: diagram.title,
          confirmLabel: t("diagrams.rename"),
        }).then((value) => value && void renameDiagram(diagram.id, value));
      },
    },
    {
      label: diagram.pinned ? t("diagrams.unpin") : t("diagrams.pin"),
      icon: diagram.pinned ? PinOff : Pin,
      onClick: () => void togglePinned(diagram.id),
    },
    {
      label: t("diagrams.duplicate"),
      icon: Copy,
      onClick: () => void duplicateDiagram(diagram.id),
    },
    {
      label: t("diagrams.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => {
        void confirmAction(
          t("diagrams.deleteConfirm", { title: diagram.title || t("diagrams.untitled") }),
        ).then((ok) => ok && void deleteDiagram(diagram.id));
      },
    },
  ];

  const onCardMenu = (event: React.MouseEvent, diagram: Diagram) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: diagramMenu(diagram) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-tour="diagrams-gallery">
      {/* The Notes shelf's header, to the pixel — same padding, same trail-then-count grouping,
          same crumbs, same segmented view switch. The two are one screen over different documents,
          and a bar that is 3px narrower on one side with a different kind of view toggle reads as
          two apps rather than as two rooms of the same one. The count is the deliberate exception:
          it keeps its own wording, because "n diagrams" is not the sentence Notes tells. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <nav
            className="flex min-w-0 items-center gap-0.5 text-[13px]"
            aria-label={t("diagrams.breadcrumb")}
          >
            <Crumb
              label={t("diagrams.allDiagrams")}
              current={crumbs.length === 0}
              onClick={() => setFolderFilter(null)}
            />
            {crumbs.map((folder, index) => (
              <span key={folder.id} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
                <Crumb
                  label={folder.name}
                  tint={folderInk(folder.color)}
                  current={index === crumbs.length - 1}
                  onClick={() => setFolderFilter(folder.id)}
                />
              </span>
            ))}
          </nav>

          <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {t("diagrams.count", { count: String(shown.length) })}
          </span>
        </div>

        <button
          type="button"
          className={ICON_BUTTON}
          title={t("diagrams.sort")}
          aria-label={t("diagrams.sort")}
          onClick={(event) =>
            setMenu({
              x: event.clientX,
              y: event.clientY,
              // Ticked rather than plain, so the button can say what the list is ordered by —
              // which is the one thing the select it replaced gave for free.
              items: SORTS.map((option) => ({
                label: t(`diagrams.sort.${option}` as `diagrams.sort.${DiagramSort}`),
                leading: (
                  <span className="flex h-3 w-3 items-center justify-center">
                    {sort === option && <Check size={11} className="text-[var(--cf-accent)]" />}
                  </span>
                ),
                onClick: () => setSort(option),
              })),
            })
          }
        >
          <ArrowUpDown size={13} />
        </button>

        {/* Both options shown at once, as in Notes, rather than one button that swaps to the other.
            A toggle wearing the icon of the view you are *not* in has to be read twice — the list
            glyph meaning "you are in grid" is the same picture as "you are in list" — and it never
            says which of the two is current. Two buttons, one of them lit, answer that by looking. */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
          <ViewButton
            icon={LayoutGrid}
            label={t("diagrams.viewGrid")}
            active={galleryView === "grid"}
            onClick={() => setGalleryView("grid")}
          />
          <ViewButton
            icon={List}
            label={t("diagrams.viewList")}
            active={galleryView === "list"}
            onClick={() => setGalleryView("list")}
          />
        </div>
      </header>

      {tagFilter.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--cf-border)] px-3 py-1.5">
          {tagFilter.map((tag) => (
            <TagPill
              key={tag}
              tag={tag}
              active
              onRemove={() => toggleTag(tag)}
              removeLabel={t("diagrams.removeTagFilter", { tag })}
            />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {subfolders.length === 0 && shown.length === 0 ? (
          <p className="px-2 py-10 text-center text-[12px] text-[var(--cf-text-muted)]">
            {filtering ? t("diagrams.noMatches") : t("diagrams.galleryEmpty")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {subfolders.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {subfolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => setFolderFilter(folder.id)}
                    className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 text-left text-[12px] transition-colors hover:border-[var(--cf-accent)]"
                  >
                    <Folder size={14} style={{ color: folderInk(folder.color) }} />
                    <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
                  </button>
                ))}
              </div>
            )}

            {galleryView === "grid" ? (
              // Fixed 180px columns, not `minmax(180px, 1fr)`, and the pictures are the whole
              // reason.
              //
              // Stretchy columns divide whatever the pane has left over among however many fit, so
              // a card's width is a fraction of the pane's — 192.33px, 191.67px, 190.5px. That is
              // invisible until something *animates* the pane's width, which the AI panel does on
              // every open and close: eleven frames, eleven fractional card widths, and inside each
              // card an `object-contain` raster re-centred on a different fraction of a pixel every
              // one of them. The thumbnail visibly shakes. Nothing else on the screen does, because
              // nothing else on the screen is a hard-edged bitmap being resampled.
              //
              // A fixed track cannot be a fraction of anything. The panel is on the right and this
              // column's left edge never moves, so a card at track `k` sits at `k × 192px` before
              // the animation and at `k × 192px` after it — the picture is not repainted at all,
              // rather than repainted smoothly. Widening the pane now adds a column instead of
              // fattening the existing ones, which is what a gallery of same-sized tiles should do
              // anyway; the cost is up to one track of ragged space at the right edge.
              <div className="grid grid-cols-[repeat(auto-fill,180px)] gap-3">
                {shown.map((diagram) => (
                  <Card
                    key={diagram.id}
                    diagram={diagram}
                    thumbnail={thumbnails[diagram.id] ?? ""}
                    active={diagram.id === activeId}
                    locale={language}
                    untitled={t("diagrams.untitled")}
                    shapesLabel={t("diagrams.shapes", { count: String(diagram.shape_count) })}
                    onSelect={() => void openDiagram(diagram.id)}
                    onMenu={(event) => onCardMenu(event, diagram)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col">
                {shown.map((diagram) => (
                  <Row
                    key={diagram.id}
                    diagram={diagram}
                    active={diagram.id === activeId}
                    locale={language}
                    untitled={t("diagrams.untitled")}
                    shapesLabel={t("diagrams.shapes", { count: String(diagram.shape_count) })}
                    onSelect={() => void openDiagram(diagram.id)}
                    onMenu={(event) => onCardMenu(event, diagram)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

interface ItemProps {
  diagram: Diagram;
  active: boolean;
  locale: string;
  untitled: string;
  shapesLabel: string;
  onSelect: () => void;
  onMenu: (event: React.MouseEvent) => void;
}

/**
 * One side of the segmented view switch. Notes has the same pair, and the two are kept as twins on
 * purpose — the lit half is drawn as a raised tile in `--cf-surface` so "which view am I in" is
 * answered by depth rather than by working out which icon is missing.
 */
function ViewButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active
          ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-sm"
          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/**
 * One step of the folder trail.
 *
 * The last crumb is where you already are, so it is text rather than a button — a control that does
 * nothing when pressed is worse than no control. The folder's own colour is carried through, which
 * is what makes the trail recognisable as the same folder you picked the colour for in the tree.
 */
function Crumb({
  label,
  current,
  tint,
  onClick,
}: {
  label: string;
  current: boolean;
  tint?: string;
  onClick: () => void;
}) {
  if (current) {
    return (
      <span
        className="min-w-0 truncate font-semibold text-[var(--cf-text)]"
        style={tint ? { color: tint } : undefined}
        aria-current="page"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 truncate rounded px-1 py-0.5 text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.05]"
    >
      {label}
    </button>
  );
}

/**
 * The picture on a card.
 *
 * `src` is the `data:` URI draw.io exported — a PNG at a fixed width, see `THUMBNAIL_EXPORT` for
 * why a raster rather than vector. Drawn through an `<img>` rather than inlined into the DOM, which
 * is not a stylistic choice: an image is a replaced element, so nothing inside it can run a script
 * or reach the app's styles. That matters the day this holds an SVG again.
 *
 * Empty is the ordinary state of a diagram nobody has drawn in yet, not a failure — hence a glyph
 * rather than a broken-image box.
 */
function Thumbnail({ src, alt }: { src: string; alt: string }) {
  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[var(--cf-text-muted)]">
        <Workflow size={22} />
      </div>
    );
  }
  return (
    <img src={src} alt={alt} className="h-full w-full object-contain" draggable={false} />
  );
}

function Card({
  diagram,
  thumbnail,
  active,
  locale,
  untitled,
  shapesLabel,
  onSelect,
  onMenu,
}: ItemProps & { thumbnail: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onMenu}
      className={`flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
        active
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
          : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-accent)]"
      }`}
    >
      <span className="h-[104px] border-b border-[var(--cf-border)] bg-[var(--cf-field)]">
        <Thumbnail src={thumbnail} alt={diagram.title || untitled} />
      </span>
      <span className="flex flex-col gap-1 p-2">
        <span className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
            {diagram.title || <span className="italic text-[var(--cf-text-muted)]">{untitled}</span>}
          </span>
          {diagram.pinned && (
            <Pin size={10} className="shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
          )}
        </span>
        <span className="flex items-center gap-2 text-[10px] text-[var(--cf-text-muted)]">
          <span className="tabular-nums">{relativeTime(diagram.updated_at, locale)}</span>
          {/* Hidden at zero rather than shown as "0 shapes": a new diagram is empty by definition,
              and a count that only ever says nothing is a line of noise on every card. */}
          {diagram.shape_count > 0 && <span className="tabular-nums">{shapesLabel}</span>}
        </span>
        {diagram.tags.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {diagram.tags.map((tag) => (
              <TagPill key={tag} tag={tag} />
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

function Row({ diagram, active, locale, untitled, shapesLabel, onSelect, onMenu }: ItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onMenu}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      }`}
    >
      <Workflow size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate">
        {diagram.title || <span className="italic text-[var(--cf-text-muted)]">{untitled}</span>}
      </span>
      {diagram.pinned && (
        <Pin size={10} className="shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
      )}
      {diagram.shape_count > 0 && (
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {shapesLabel}
        </span>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
        {relativeTime(diagram.updated_at, locale)}
      </span>
    </button>
  );
}
