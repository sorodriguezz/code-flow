import { useEffect, useMemo, useState } from "react";
import { Box, Download, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { chipClass } from "../common/recipes";
import { RowAction, ago } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, Dialog, EmptyLine, Field, FilterChips, LiveMark, LoadingLine, NO_ROWS, PageHead, PageToolbar, SearchField, Td, Th, fmtBytes, trClass } from "./ui";
import { ImageGlyph } from "./imageGlyph";
import { RunContainerDialog } from "./RunContainerDialog";
import { BulkBar, CopyText, ImageSearchField, StopClick, menuAt, useEngineList, usePicked, type MenuState } from "./pageBits";
import { firstRead, imageUseCount, imageUsers, pullableReference, shortReference } from "./pageModel";
import { confirmAction } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import type { ContainerRow, ImageRow, RuntimeInfo } from "../../types/containers";

/**
 * An engine's images as lite-dock lists them: every tag with its size and age, the containers that
 * use it, the ones no tag names any more, a pull from Docker Hub followed in a terminal, a container
 * run from one, and a side panel with its layers and its inspect document.
 */

type Filter = "all" | "inUse" | "unused" | "dangling";
type Usage = { users: ContainerRow[]; count: number };

/** One row per tag, so a row is the image and the name it goes by. */
const keyOf = (row: ImageRow) => `${row.id}|${row.reference}`;
/** What an engine removes or pulls a row by: its name, or its id when it has none. */
const refOf = (row: ImageRow) => (row.dangling ? row.id : row.reference);
const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
const isUp = (row: ContainerRow) => row.state === "running" || row.state === "restarting";
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
  const select = useContainersStore((s) => s.select);
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
      if (filter === "unused" && (usage.get(keyOf(row))?.count ?? 0) > 0) return false;
      if (filter === "dangling" && !row.dangling) return false;
      if (!needle) return true;
      return row.reference.toLowerCase().includes(needle) || row.id.toLowerCase().replace(/^sha256:/, "").startsWith(needle);
    });
  }, [rows, usage, query, filter]);
  const pickedRows = rows.filter((row) => picked.has(keyOf(row)));
  const allPicked = shown.length > 0 && shown.every((row) => picked.has(keyOf(row)));
  /** The image's own page, over the list — its layers, how it runs, its vulnerabilities. */
  const openImage = (row: ImageRow) => select({ runtime: runtime.id, context, namespace: null, object: "image", id: refOf(row), name: refOf(row) });

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
    engineMenu({ runtime: runtime.id, context, object: "image", image: row, t, act, select: () => openImage(row) }).map((item) =>
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
        <FilterChips
          label={t("containers.m.filters")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("containers.m.images.filter.all"), count: rows.length },
            { value: "inUse", label: t("containers.m.images.inUse"), count: inUseCount, tone: "ok" },
            { value: "unused", label: t("containers.m.images.filter.unused"), count: rows.length - inUseCount, tone: "idle" },
            { value: "dangling", label: t("containers.m.images.filter.dangling"), count: danglingCount, title: t("containers.m.images.danglingHint") },
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col [&_table]:table-fixed">
        {!runtime.running ? (
          <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
        ) : list?.error ? (
          <EmptyLine>{list.error}</EmptyLine>
        ) : firstRead(list) ? (
          <LoadingLine />
        ) : shown.length === 0 ? (
          <EmptyLine>{rows.length ? t("containers.m.images.noMatch") : t("containers.m.images.none")}</EmptyLine>
        ) : (
          <DataTable minWidth={820}>
            <thead>
              <tr>
                <Th align="center" width={32}>
                  <Checkbox checked={allPicked} onChange={() => setAll(allPicked ? null : shown.map(keyOf))} />
                </Th>
                <Th>{t("containers.m.images.col.repository")}</Th>
                <Th width={150}>{t("containers.m.images.col.tag")}</Th>
                <Th width={150}>{t("containers.m.images.col.usedBy")}</Th>
                <Th width={120}>{t("containers.fact.id")}</Th>
                <Th align="right" width={84}>
                  {t("containers.m.images.col.size")}
                </Th>
                <Th width={96}>{t("containers.m.images.col.created")}</Th>
                <Th align="right" width={112}>
                  {t("containers.m.col.actions")}
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const key = keyOf(row);
                const { users, count } = usageOf(row);
                const working = busy[`image|${refOf(row)}`];
                const running = users.filter(isUp).length;
                const repository = row.dangling ? "<none>" : shortReference(row.repository);
                return (
                  <tr key={key} className={trClass(picked.has(key), true)} onClick={() => openImage(row)} onContextMenu={(e) => setMenu(menuAt(e, rowMenu(row)))}>
                    <Td tall align="center" className="w-8">
                      <StopClick>
                        <Checkbox checked={picked.has(key)} onChange={() => toggle(key)} />
                      </StopClick>
                    </Td>
                    <Td tall>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ImageGlyph reference={row.dangling ? "" : row.reference} dim={count === 0} />
                        <span
                          className={`truncate font-medium ${row.dangling ? "font-mono text-[var(--cf-text-faint)]" : "text-[var(--cf-text)] group-hover:text-[var(--cf-accent)]"}`}
                          title={row.dangling ? row.id : row.reference}
                        >
                          {repository}
                        </span>
                        {row.dangling && (
                          <span className={chipClass("neutral")} title={t("containers.m.images.danglingHint")}>
                            {t("containers.m.images.dangling")}
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td tall>
                      {row.dangling || row.tag === "<none>" ? (
                        <span className="text-[var(--cf-text-faint)]">—</span>
                      ) : (
                        <span className="inline-block max-w-full truncate rounded-full border border-[var(--cf-border)] bg-[var(--cf-hover)] px-2 py-px font-mono text-[11px] text-[var(--cf-text)]" title={row.tag}>
                          {row.tag}
                        </span>
                      )}
                    </Td>
                    <Td tall title={users.map((u) => u.name).join(", ") || undefined}>
                      {count > 0 ? (
                        <span className="flex flex-col leading-tight">
                          <span className="text-[var(--cf-text)]">{count === 1 ? t("containers.m.images.usedByOne") : t("containers.m.images.usedByMany", { count })}</span>
                          {users.length > 0 && (
                            <span className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]" title={t("containers.m.images.runningStopped", { running, stopped: users.length - running })}>
                              {running > 0 && (
                                <span className="inline-flex items-center gap-0.5">
                                  <Box size={11} className="text-[var(--cf-success)]" />
                                  {running}
                                </span>
                              )}
                              {users.length - running > 0 && (
                                <span className="inline-flex items-center gap-0.5">
                                  <Box size={11} className="text-[var(--cf-text-faint)]" />
                                  {users.length - running}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[var(--cf-text-faint)]">
                          <Box size={11} />
                          {t("containers.m.images.notInUse")}
                        </span>
                      )}
                    </Td>
                    <Td tall>
                      <StopClick>
                        <CopyText text={row.id} shown={shortId(row.id)} toast={t("containers.m.images.copiedId")} title={t("containers.copyId")} />
                      </StopClick>
                    </Td>
                    <Td tall align="right" className="text-[var(--cf-text)]">
                      {row.sizeBytes !== null ? fmtBytes(row.sizeBytes) : row.size || "—"}
                    </Td>
                    <Td tall className="whitespace-nowrap text-[var(--cf-text-muted)]" title={row.created}>
                      {ago(row.created, language) || "—"}
                    </Td>
                    <Td tall align="right" className="w-[112px]">
                      <StopClick>
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
                      </StopClick>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {pulling && <PullDialog runtime={runtime} context={context} onPull={pull} onClose={() => setPulling(false)} />}
      {runImage !== null && <RunContainerDialog runtime={runtime} context={context} initialImage={runImage} onClose={() => setRunImage(null)} />}
    </div>
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
