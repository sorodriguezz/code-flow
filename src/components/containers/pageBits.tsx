import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Copy, ExternalLink, Loader2, Star, X } from "lucide-react";
import { Button } from "../common/Button";
import type { MenuItem } from "../common/ContextMenu";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { RowAction, TextView } from "./containerBits";
import { NO_ROWS } from "./ui";
import { dockerHubUrl, imageName, onDockerHub } from "./pageModel";
import { containersHubSearch, containersHubTags, containersText } from "../../lib/tauri/containersCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { listKey, useContainersStore, type ListState } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { HubRepo, HubTag, ImageRow, RuntimeId, RuntimeInfo } from "../../types/containers";

/**
 * What the images, volumes, networks, Compose, build and overview pages share beyond `ui.tsx`: the
 * side drawer a row opens, the picked-rows bar, an inspect document read once, and the image field
 * that searches Docker Hub. (A pull or a build runs as one of the manager's jobs — `JobsPanel`.)
 */

// ------------------------------------------------------------------------------------ lists

/** One of an engine's lists, as the store holds it — the rows falling back to the one shared empty
 *  array, so a selector never hands zustand a fresh `[]`. */
export function useEngineList<T>(runtime: RuntimeId, context: string | null, what: string): { list: ListState | undefined; rows: T[] } {
  const list = useContainersStore((s) => s.lists[listKey(runtime, context, null, what)]);
  return { list, rows: (list?.rows ?? NO_ROWS) as T[] };
}

// ------------------------------------------------------------------------------------- menus

export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

/** Where a row's menu opens: at the pointer for a right-click, under the `⋯` button for a click. */
export function menuAt(event: ReactMouseEvent, items: MenuItem[]): NonNullable<MenuState> {
  event.preventDefault();
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const pointer = event.type === "contextmenu";
  return { x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom + 2, items };
}

// ------------------------------------------------------------------------------- picked rows

export function usePicked() {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setPicked((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  /** Picks exactly these — none for `null`. */
  const setAll = useCallback((keys: string[] | null) => setPicked(new Set(keys ?? [])), []);
  return { picked, toggle, setAll };
}

/** The bar over a table while rows are picked: how many, what can be done to all of them. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3 text-[12px]">
      <span className="font-medium text-[var(--cf-text)]">{t("containers.m.picked", { count })}</span>
      {children}
      <div className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onClear}>
        {t("containers.m.clearPick")}
      </Button>
    </div>
  );
}

/** Keeps a click inside a row's cell (its checkbox, say) from opening the row. */
export function StopClick({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}

/** An id or name shown short and copied whole on click. */
export function CopyText({ text, shown, toast, title }: { text: string; shown?: string; toast: string; title: string }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).catch(() => {});
        pushSuccessToast(toast);
      }}
      title={title}
      className="flex w-fit max-w-full items-center gap-1 font-mono text-[11px] text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"
    >
      <span className="truncate">{shown ?? text}</span>
      <Copy size={9} className="shrink-0 opacity-0 group-hover:opacity-100" />
    </button>
  );
}

/** One muted line inside a drawer or a form — a list still being read, or why it could not be. */
export function MutedLine({ children }: { children: ReactNode }) {
  return <p className="py-1 text-[12px] text-[var(--cf-text-muted)]">{children}</p>;
}

// ------------------------------------------------------------------------------------ drawer

export type DrawerView = "details" | "json";

/**
 * A row's side panel, beside its table rather than over it: the page stays readable and another row
 * is a click away. Escape closes it — unless it was meant for Monaco (its find widget, say).
 */
export function Drawer({
  title,
  view,
  onView,
  onClose,
  layoutId,
  children,
}: {
  title: string;
  view: DrawerView;
  onView: (view: DrawerView) => void;
  onClose: () => void;
  /** The view toggle's thumb, one per page. */
  layoutId: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <aside
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest(".monaco-editor")) return;
        e.stopPropagation();
        onClose();
      }}
      className="flex min-h-0 w-[45%] min-w-[300px] max-w-[760px] shrink-0 flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-2">
        <h4 className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-[var(--cf-text)]" title={title}>
          {title}
        </h4>
        <Segmented
          layoutId={layoutId}
          size="sm"
          value={view}
          onChange={onView}
          options={[
            { value: "details", label: t("containers.m.drawer.details") },
            { value: "json", label: "JSON" },
          ]}
        />
        <RowAction label={t("common.close")} onClick={onClose}>
          <X size={13} />
        </RowAction>
      </div>
      {children}
    </aside>
  );
}

/** The scrolling body of a drawer's details. */
export function DrawerBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">{children}</div>;
}

export interface InspectState {
  text: string | null;
  error: string | null;
}

/** An object's inspect document, read when `id` is given and again when it changes. */
export function useInspect(runtime: RuntimeId, context: string | null, object: string, id: string | null): InspectState {
  const [state, setState] = useState<InspectState>({ text: null, error: null });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ text: null, error: null });
    containersText({ runtime, context, object, id, view: "inspect" })
      .then((text) => {
        if (alive) setState({ text, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setState({ text: null, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [runtime, context, object, id]);
  return state;
}

/** A drawer's JSON view. */
export function InspectPane({ state }: { state: InspectState }) {
  const t = useT();
  if (state.error) return <DrawerBody><MutedLine>{state.error}</MutedLine></DrawerBody>;
  if (state.text === null) return <DrawerBody><MutedLine>{t("containers.m.loading")}</MutedLine></DrawerBody>;
  return <TextView value={state.text} language="json" />;
}

// ------------------------------------------------------------------------------ image field

/**
 * An image to pull: this engine's own, or one found on Docker Hub as it is typed — official ones
 * marked, stars counted, and the tags of the one picked offered beside the field. The search of «Ejecutar
 * contenedor», with its list laid out under the field rather than floating over it.
 */
export function ImageSearchField({
  runtime,
  context,
  value,
  onChange,
  onSubmit,
}: {
  runtime: RuntimeInfo;
  context: string | null;
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
}) {
  const t = useT();
  const { rows: images } = useEngineList<ImageRow>(runtime.id, context, "images");
  const [hub, setHub] = useState<HubRepo[]>([]);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [tags, setTags] = useState<HubTag[] | null>(null);
  const local = useMemo(() => [...new Set(images.filter((i) => !i.dangling && i.reference && !i.reference.includes("<none>")).map((i) => i.reference))], [images]);
  const localMatches = useMemo(() => {
    const needle = value.trim().toLowerCase();
    if (!needle) return local;
    return local.filter((reference) => reference.toLowerCase().includes(needle));
  }, [value, local]);
  const term = imageName(value.trim());
  useEffect(() => {
    if (term.length < 2 || !onDockerHub(term)) {
      setHub([]);
      setHubLoading(false);
      return;
    }
    let alive = true;
    setHubLoading(true);
    const timer = setTimeout(() => {
      containersHubSearch(term, 8)
        .then((found) => {
          if (!alive) return;
          setHub(found);
          setHubError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setHub([]);
          setHubError(String(e));
        })
        .finally(() => {
          if (alive) setHubLoading(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [term]);

  const pickHub = (repo: HubRepo) => {
    onChange(`${repo.name}:latest`);
    setTags(null);
    containersHubTags(repo.name, 40)
      .then(setTags)
      .catch(() => setTags([]));
  };
  const groupClass = "px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex gap-1">
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setTags(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t("containers.m.run.imagePlaceholder")}
          spellCheck={false}
          aria-label={t("containers.m.run.image")}
          className={fieldClass({ size: "sm", className: "w-full font-mono" })}
        />
        {tags && tags.length > 0 && (
          <div className="w-[130px] shrink-0">
            <Select
              size="sm"
              value={value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : "latest"}
              onChange={(tag) => onChange(`${imageName(value)}:${tag}`)}
              options={tags.map((tag) => ({ value: tag.name, label: tag.name }))}
              ariaLabel={t("containers.m.run.tag")}
            />
          </div>
        )}
      </div>
      <div className="max-h-[300px] overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
        <div className={groupClass}>{t("containers.m.run.localImages")}</div>
        {localMatches.length ? (
          localMatches.map((reference) => (
            <button
              key={reference}
              onClick={() => {
                onChange(reference);
                setTags(null);
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-[var(--cf-hover)]"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{reference}</span>
              <span className={chipClass("ok")}>{t("containers.m.run.downloaded")}</span>
            </button>
          ))
        ) : (
          <p className="px-2 py-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.m.run.noLocalMatch")}</p>
        )}
        <div className={`${groupClass} flex items-center gap-1.5 pt-2`}>
          Docker Hub
          {hubLoading && <Loader2 size={10} className="animate-spin" />}
        </div>
        {hub.map((repo) => (
          <div key={repo.name} className={`flex items-start gap-1 rounded-md px-2 py-1 hover:bg-[var(--cf-hover)] ${imageName(value.trim()) === repo.name ? "bg-[var(--cf-accent-soft)]" : ""}`}>
            <button onClick={() => pickHub(repo)} className="flex min-w-0 flex-1 flex-col text-left">
              <span className="flex items-center gap-1.5 text-[12.5px]">
                <span className="truncate font-mono font-medium">{repo.name}</span>
                {repo.official && <span className={chipClass("accent")}>{t("containers.m.run.official")}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-[var(--cf-text-muted)]">
                  <Star size={10} />
                  {repo.stars.toLocaleString()}
                </span>
              </span>
              {repo.description && <span className="line-clamp-1 text-[11px] text-[var(--cf-text-muted)]">{repo.description}</span>}
            </button>
            <button onClick={() => void openExternalUrl(dockerHubUrl(repo.name))} title={t("containers.m.run.viewOnHub")} className="mt-0.5 shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]">
              <ExternalLink size={11} />
            </button>
          </div>
        ))}
        {!hubLoading && hub.length === 0 && (
          <p className="px-2 py-1 text-[11.5px] text-[var(--cf-text-muted)]">
            {hubError ?? (term.length < 2 ? t("containers.m.run.typeToSearch") : onDockerHub(term) ? t("containers.m.run.noHubMatch") : t("containers.m.images.notOnHub"))}
          </p>
        )}
      </div>
    </div>
  );
}
