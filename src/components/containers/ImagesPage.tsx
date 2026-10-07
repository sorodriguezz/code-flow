import { useEffect, useMemo, useState } from "react";
import { Download, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Segmented } from "../common/Segmented";
import { chipClass } from "../common/recipes";
import { Facts, RowAction, SectionTitle, StateDot, ago, stateTone } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, Dialog, EmptyLine, Field, LiveMark, NO_ROWS, PageHead, PageToolbar, SearchField, Td, Th, fmtBytes, trClass } from "./ui";
import { RunContainerDialog } from "./RunContainerDialog";
import {
  BulkBar,
  CopyText,
  Drawer,
  DrawerBody,
  ImageSearchField,
  InspectPane,
  MutedLine,
  StopClick,
  menuAt,
  useEngineList,
  useInspect,
  usePicked,
  type DrawerView,
  type MenuState,
} from "./pageBits";
import { imageUseCount, imageUsers, layerCommand, pullableReference } from "./pageModel";
import { containersImageHistory } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import type { ContainerRow, ImageLayer, ImageRow, RuntimeInfo } from "../../types/containers";

/**
 * An engine's images as lite-dock lists them: every tag with its size and age, the containers that
 * use it, the ones no tag names any more, a pull from Docker Hub followed in a terminal, a container
 * run from one, and a side panel with its layers and its inspect document.
 */

type Filter = "all" | "inUse" | "dangling";
type Usage = { users: ContainerRow[]; count: number };

/** One row per tag, so a row is the image and the name it goes by. */
const keyOf = (row: ImageRow) => `${row.id}|${row.reference}`;
/** What an engine removes or pulls a row by: its name, or its id when it has none. */
const refOf = (row: ImageRow) => (row.dangling ? row.id : row.reference);
const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
const UNUSED: Usage = { users: NO_ROWS, count: 0 };

export function ImagesPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const { list, rows } = useEngineList<ImageRow>(runtime.id, context, "images");
  const { rows: containers } = useEngineList<ContainerRow>(runtime.id, context, "containers");
  const act = useContainersStore((s) => s.act);
  const busy = useContainersStore((s) => s.busy);
  const refreshList = useContainersStore((s) => s.refreshList);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const { picked, toggle, setAll } = usePicked();
  const [menu, setMenu] = useState<MenuState>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [runImage, setRunImage] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const startJob = useContainersJobsStore((s) => s.start);
  const ctr = runtime.id === "ctr";
  const place = context || runtimeLabel(runtime.id, t);

  useEffect(() => {
    if (!runtime.running) return;
    void refreshList(runtime.id, "images");
    void refreshList(runtime.id, "containers");
  }, [runtime.id, runtime.running, context, refreshList]);

  // Who uses each image, worked out once per read of either list.
  const usage = useMemo(() => {
    const map = new Map<string, Usage>();
    for (const row of rows) {
      const users = imageUsers(row, containers);
      map.set(keyOf(row), { users, count: imageUseCount(row, users) });
    }
    return map;
  }, [rows, containers]);
  const usageOf = (row: ImageRow) => usage.get(keyOf(row)) ?? UNUSED;

  const inUseCount = useMemo(() => rows.filter((row) => (usage.get(keyOf(row))?.count ?? 0) > 0).length, [rows, usage]);
  const danglingCount = useMemo(() => rows.filter((row) => row.dangling).length, [rows]);
  // A size per image, not per tag: three tags of one image are one image on disk.
  const totalBytes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of rows) if (row.sizeBytes !== null) seen.set(row.id, row.sizeBytes);
    return [...seen.values()].reduce((sum, size) => sum + size, 0);
  }, [rows]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^sha256:/, "");
    return rows.filter((row) => {
      if (filter === "inUse" && !((usage.get(keyOf(row))?.count ?? 0) > 0)) return false;
      if (filter === "dangling" && !row.dangling) return false;
      if (!needle) return true;
      return row.reference.toLowerCase().includes(needle) || row.id.toLowerCase().replace(/^sha256:/, "").startsWith(needle);
    });
  }, [rows, usage, query, filter]);
  const pickedRows = rows.filter((row) => picked.has(keyOf(row)));
  const allPicked = shown.length > 0 && shown.every((row) => picked.has(keyOf(row)));
  const openRow = openKey ? rows.find((row) => keyOf(row) === openKey) : undefined;

  const pull = (reference: string) =>
    void startJob(
      t("containers.m.images.pulling", { name: reference }),
      { kind: "pull", runtime: runtime.id, context, target: reference },
      { refresh: ["images"], done: t("containers.done.pull", { name: reference }), runImage: reference },
    );

  /** An image a container uses is kept unless forced — the engine refuses a running one even then. */
  const removeOne = async (row: ImageRow) => {
    const ref = refOf(row);
    const { users, count } = usageOf(row);
    if (count > 0) {
      const who = users.length ? users.map((u) => u.name).join(", ") : t("containers.m.images.nContainers", { count });
      if (await confirmAction(t("containers.m.images.inUseRefused", { name: ref, who, context: place }), true, t("containers.m.images.forceRemove"))) {
        void act({ runtime: runtime.id, context, object: "image", action: "remove", ids: [ref], options: { force: true }, label: t("containers.done.remove", { name: ref }) });
      }
      return;
    }
    if (await confirmAction(t("containers.confirmRemoveImage", { name: ref, context: place }), true, t("containers.remove"))) {
      void act({ runtime: runtime.id, context, object: "image", action: "remove", ids: [ref], label: t("containers.done.remove", { name: ref }) });
    }
  };
  /** The picked ones nothing uses; the rest stay, and the confirmation says which. */
  const bulkRemove = async () => {
    const targets = pickedRows.filter((row) => usageOf(row).count === 0);
    const kept = pickedRows.filter((row) => usageOf(row).count > 0);
    if (!targets.length) {
      pushErrorToast(t("containers.m.images.allInUse", { names: kept.map(refOf).join(", ") }));
      return;
    }
    const message =
      t("containers.m.images.confirmRemoveMany", { count: targets.length, names: targets.map(refOf).join(", "), context: place }) +
      (kept.length ? ` ${t("containers.m.images.keptInUse", { count: kept.length, names: kept.map(refOf).join(", ") })}` : "");
    if (!(await confirmAction(message, true, t("containers.remove")))) return;
    void act({ runtime: runtime.id, context, object: "image", action: "remove", ids: targets.map(refOf), label: t("containers.m.images.removed", { count: targets.length }) });
    setAll(null);
  };

  // The engine menu's own Run asks for ports through a prompt; here it opens the form. Its Remove
  // keeps an image in use like the row's button does.
  const rowMenu = (row: ImageRow): MenuItem[] =>
    engineMenu({ runtime: runtime.id, context, object: "image", image: row, t, act, select: () => setOpenKey(keyOf(row)) }).map((item) =>
      item.label === t("containers.image.run") ? { ...item, onClick: () => setRunImage(refOf(row)) } : item.danger ? { ...item, onClick: () => void removeOne(row) } : item,
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.section.images")} sub={rows.length ? t("containers.m.images.sub", { count: rows.length, size: fmtBytes(totalBytes) }) : undefined}>
        <Button
          size="sm"
          variant="ghost"
          title={t("containers.prune.images")}
          onClick={async () => {
            if (await confirmAction(t("containers.prune.confirmImages", { context: place }), true, t("containers.prune.confirm"))) {
              void act({ runtime: runtime.id, context, object: "image", action: "prune", ids: [], label: t("containers.prune.doneImages") });
            }
          }}
          disabled={!runtime.running || ctr || danglingCount === 0}
        >
          <Trash2 size={13} />
          {t("containers.m.cleanUp")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setPulling(true)} disabled={!runtime.running || ctr}>
          <Download size={13} />
          {t("containers.m.images.pull")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.images.search")} />
        <Segmented
          layoutId="images-filter"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `${t("containers.m.images.filter.all")} ${rows.length}` },
            { value: "inUse", label: `${t("containers.m.images.inUse")} ${inUseCount}` },
            { value: "dangling", label: `${t("containers.m.images.filter.dangling")} ${danglingCount}`, title: t("containers.m.images.danglingHint") },
          ]}
        />
        <div className="flex-1" />
        {runtime.running && <LiveMark />}
      </PageToolbar>
      {pickedRows.length > 0 && (
        <BulkBar count={pickedRows.length} onClear={() => setAll(null)}>
          <Button size="sm" variant="danger" onClick={() => void bulkRemove()}>
            <Trash2 size={12} />
            {t("containers.remove")}
          </Button>
        </BulkBar>
      )}
      <div className="flex min-h-0 flex-1">
        {/* A fixed layout: the drawer narrows the table, and only the name column gives way. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col [&_table]:table-fixed">
          {!runtime.running ? (
            <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
          ) : list?.error ? (
            <EmptyLine>{list.error}</EmptyLine>
          ) : shown.length === 0 ? (
            <EmptyLine>{!list ? t("containers.m.loading") : rows.length ? t("containers.m.images.noMatch") : t("containers.m.images.none")}</EmptyLine>
          ) : (
            <DataTable minWidth={openRow ? 560 : 720}>
              <thead>
                <tr>
                  <Th align="center" width={32}>
                    <Checkbox checked={allPicked} onChange={() => setAll(allPicked ? null : shown.map(keyOf))} />
                  </Th>
                  <Th>{t("containers.m.images.col.reference")}</Th>
                  <Th width={120}>{t("containers.fact.id")}</Th>
                  <Th align="right" width={80}>
                    {t("containers.m.images.col.size")}
                  </Th>
                  <Th width={84}>{t("containers.m.images.col.created")}</Th>
                  <Th align="right" width={68}>
                    {t("containers.m.images.inUse")}
                  </Th>
                  <Th align="right" width={96}>
                    {t("containers.m.col.actions")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const key = keyOf(row);
                  const { users, count } = usageOf(row);
                  const working = busy[`image|${refOf(row)}`];
                  return (
                    <tr key={key} className={`${trClass(picked.has(key) || openKey === key)} cursor-default`} onClick={() => setOpenKey(key)} onContextMenu={(e) => setMenu(menuAt(e, rowMenu(row)))}>
                      <Td align="center" className="w-8">
                        <StopClick>
                          <Checkbox checked={picked.has(key)} onChange={() => toggle(key)} />
                        </StopClick>
                      </Td>
                      <Td>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={`truncate font-mono text-[12px] ${row.dangling ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"}`} title={row.dangling ? row.id : row.reference}>
                            {row.dangling ? "<none>:<none>" : row.reference}
                          </span>
                          {row.dangling && (
                            <span className={chipClass("neutral")} title={t("containers.m.images.danglingHint")}>
                              {t("containers.m.images.dangling")}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <CopyText text={row.id} shown={shortId(row.id)} toast={t("containers.m.images.copiedId")} title={t("containers.copyId")} />
                      </Td>
                      <Td align="right" className="text-[var(--cf-text-muted)]">
                        {row.sizeBytes !== null ? fmtBytes(row.sizeBytes) : row.size || "—"}
                      </Td>
                      <Td className="text-[var(--cf-text-muted)]">{ago(row.created, language) || "—"}</Td>
                      <Td align="right" title={users.map((u) => u.name).join(", ") || undefined}>
                        {count > 0 ? <span className="text-[var(--cf-text)]">{count}</span> : <span className="text-[var(--cf-text-faint)]">—</span>}
                      </Td>
                      <Td className="w-[96px]">
                        <div className="flex items-center justify-end gap-0.5">
                          {!ctr && !row.dangling && (
                            <>
                              <RowAction label={t("containers.image.run")} onClick={() => setRunImage(row.reference)}>
                                <Play size={12} className="text-[var(--cf-success)]" />
                              </RowAction>
                              <RowAction label={t("containers.image.pull")} onClick={() => pull(row.reference)}>
                                <Download size={12} />
                              </RowAction>
                            </>
                          )}
                          <RowAction label={t("containers.remove")} danger disabled={working} onClick={() => void removeOne(row)}>
                            <Trash2 size={12} />
                          </RowAction>
                          <RowAction label={t("containers.m.moreActions")} onClick={(e) => setMenu(menuAt(e, rowMenu(row)))}>
                            <MoreHorizontal size={13} />
                          </RowAction>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </div>
        {openRow && <ImageDrawer key={openKey} runtime={runtime} context={context} row={openRow} usage={usageOf(openRow)} onClose={() => setOpenKey(null)} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {pulling && <PullDialog runtime={runtime} context={context} onPull={pull} onClose={() => setPulling(false)} />}
      {runImage !== null && <RunContainerDialog runtime={runtime} context={context} initialImage={runImage} onClose={() => setRunImage(null)} />}
    </div>
  );
}

/** An image's facts and layers, or its inspect document — read once it is asked for. */
function ImageDrawer({ runtime, context, row, usage, onClose }: { runtime: RuntimeInfo; context: string | null; row: ImageRow; usage: Usage; onClose: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const select = useContainersStore((s) => s.select);
  const [view, setView] = useState<DrawerView>("details");
  const [jsonAsked, setJsonAsked] = useState(false);
  const [layers, setLayers] = useState<{ rows: ImageLayer[] | null; error: string | null }>({ rows: null, error: null });
  const ref = refOf(row);
  const inspect = useInspect(runtime.id, context, "image", jsonAsked ? ref : null);

  useEffect(() => {
    let alive = true;
    setLayers({ rows: null, error: null });
    containersImageHistory(runtime.id, context, ref)
      .then((found) => {
        if (alive) setLayers({ rows: found, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setLayers({ rows: null, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [runtime.id, context, ref]);

  const created = row.created ? ago(row.created, language) : "";
  return (
    <Drawer
      title={row.dangling ? shortId(row.id) : row.reference}
      view={view}
      onView={(next) => {
        setView(next);
        if (next === "json") setJsonAsked(true);
      }}
      onClose={onClose}
      layoutId="images-drawer-view"
    >
      {view === "json" ? (
        <InspectPane state={inspect} />
      ) : (
        <DrawerBody>
          <Facts
            rows={[
              [t("containers.m.images.reference"), <span className="font-mono">{row.dangling ? "<none>:<none>" : row.reference}</span>],
              [t("containers.fact.id"), <CopyText text={row.id} toast={t("containers.m.images.copiedId")} title={t("containers.copyId")} />],
              [t("containers.m.images.col.size"), row.sizeBytes !== null ? fmtBytes(row.sizeBytes) : row.size],
              [t("containers.m.images.col.created"), created && created !== row.created ? <span title={row.created}>{created}</span> : row.created],
              [
                t("containers.fact.usedBy"),
                usage.users.length ? (
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {usage.users.map((user) => (
                      <button
                        key={user.id}
                        onClick={() => select({ runtime: runtime.id, context, namespace: null, object: "container", id: user.id, name: user.name })}
                        title={t("containers.m.openDetail")}
                        className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline"
                      >
                        <StateDot tone={stateTone(user.state, user.health)} />
                        {user.name}
                      </button>
                    ))}
                  </span>
                ) : usage.count > 0 ? (
                  t("containers.m.images.nContainers", { count: usage.count })
                ) : (
                  <span className="text-[var(--cf-text-muted)]">{t("containers.none")}</span>
                ),
              ],
            ]}
          />
          <SectionTitle>
            {t("containers.m.images.layers")}
            {layers.rows ? ` · ${layers.rows.length}` : ""}
          </SectionTitle>
          {layers.error ? (
            <MutedLine>{layers.error}</MutedLine>
          ) : !layers.rows ? (
            <MutedLine>{t("containers.m.loading")}</MutedLine>
          ) : layers.rows.length === 0 ? (
            <MutedLine>{t("containers.m.images.noLayers")}</MutedLine>
          ) : (
            <table className="w-full table-fixed border-separate border-spacing-0 text-[11.5px]">
              <thead>
                <tr>
                  <Th>{t("containers.m.images.col.step")}</Th>
                  <Th align="right" width={76}>
                    {t("containers.m.images.col.size")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {layers.rows.map((layer, index) => (
                  <tr key={`${layer.id}-${index}`}>
                    <Td className="truncate font-mono text-[var(--cf-text)]" title={layer.createdBy}>
                      {layerCommand(layer.createdBy) || "—"}
                    </Td>
                    <Td align="right" className={layer.size ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text-faint)]"}>
                      {fmtBytes(layer.size)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DrawerBody>
      )}
    </Drawer>
  );
}

/** «Descargar imagen»: a reference typed, or found on Docker Hub; the pull itself runs in the page's
 *  job panel, where its progress can be read. */
function PullDialog({ runtime, context, onPull, onClose }: { runtime: RuntimeInfo; context: string | null; onPull: (reference: string) => void; onClose: () => void }) {
  const t = useT();
  const [reference, setReference] = useState("");
  const ok = pullableReference(reference);
  const submit = () => {
    if (!ok) return;
    onPull(reference.trim());
    onClose();
  };
  return (
    <Dialog
      title={t("containers.m.images.pull")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={submit} disabled={!ok}>
            <Download size={13} />
            {t("containers.m.images.pullAction")}
          </Button>
        </>
      }
    >
      <Field label={t("containers.m.run.image")}>
        <ImageSearchField runtime={runtime} context={context} value={reference} onChange={setReference} onSubmit={submit} />
      </Field>
    </Dialog>
  );
}
