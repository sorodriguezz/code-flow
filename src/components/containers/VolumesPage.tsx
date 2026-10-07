import { useEffect, useMemo, useState } from "react";
import { Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu } from "../common/ContextMenu";
import { fieldClass } from "../common/recipes";
import { Facts, RowAction, SectionTitle } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, Dialog, EmptyLine, Field, LiveMark, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { BulkBar, CopyText, Drawer, DrawerBody, InspectPane, MutedLine, StopClick, menuAt, useEngineList, useInspect, usePicked, type DrawerView, type MenuState } from "./pageBits";
import { firstRead, validObjectName } from "./pageModel";
import { containersCreateVolume } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { RuntimeInfo, VolumeRow } from "../../types/containers";

/**
 * An engine's volumes: the data its containers keep past their own removal. Each with its driver,
 * where the engine keeps it and the Compose project that made it; created, removed (one or several),
 * the unused ones cleaned up, and a side panel with its labels and its inspect document.
 *
 * Which containers use a volume is not on the row: `ps` does not print mounts, and asking every
 * container for them to fill one column is a read per container on every refresh.
 */

export function VolumesPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const { list, rows } = useEngineList<VolumeRow>(runtime.id, context, "volumes");
  const act = useContainersStore((s) => s.act);
  const busy = useContainersStore((s) => s.busy);
  const refreshList = useContainersStore((s) => s.refreshList);
  const [query, setQuery] = useState("");
  const { picked, toggle, setAll } = usePicked();
  const [menu, setMenu] = useState<MenuState>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const ctr = runtime.id === "ctr";
  const place = context || runtimeLabel(runtime.id, t);

  useEffect(() => {
    if (runtime.running) void refreshList(runtime.id, "volumes");
  }, [runtime.id, runtime.running, context, refreshList]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.driver.toLowerCase().includes(needle) ||
        row.project.toLowerCase().includes(needle) ||
        row.mountpoint.toLowerCase().includes(needle),
    );
  }, [rows, query]);
  const pickedRows = rows.filter((row) => picked.has(row.name));
  const allPicked = shown.length > 0 && shown.every((row) => picked.has(row.name));
  const openRow = openName ? rows.find((row) => row.name === openName) : undefined;

  const removeOne = async (row: VolumeRow) => {
    if (await confirmAction(t("containers.confirmRemoveVolume", { name: row.name, context: place }), true, t("containers.remove"))) {
      void act({ runtime: runtime.id, context, object: "volume", action: "remove", ids: [row.name], label: t("containers.done.remove", { name: row.name }) });
    }
  };
  const bulkRemove = async () => {
    if (!pickedRows.length) return;
    const names = pickedRows.map((row) => row.name);
    if (!(await confirmAction(t("containers.m.volumes.confirmRemoveMany", { count: names.length, names: names.join(", "), context: place }), true, t("containers.remove")))) return;
    void act({ runtime: runtime.id, context, object: "volume", action: "remove", ids: names, label: t("containers.m.done.removed", { count: names.length }) });
    setAll(null);
  };
  const rowMenu = (row: VolumeRow) => engineMenu({ runtime: runtime.id, context, object: "volume", id: row.name, t, act, select: () => setOpenName(row.name) });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.section.volumes")} sub={rows.length ? String(rows.length) : undefined}>
        <Button
          size="sm"
          variant="ghost"
          // Docker 23+ prunes anonymous volumes only; Podman takes every unused one — said where it differs.
          title={runtime.id === "docker" ? `${t("containers.prune.volumes")} — ${t("containers.m.volumes.pruneDocker")}` : t("containers.prune.volumes")}
          onClick={async () => {
            if (await confirmAction(t("containers.prune.confirmVolumes", { context: place }), true, t("containers.prune.confirm"))) {
              void act({ runtime: runtime.id, context, object: "volume", action: "prune", ids: [], label: t("containers.prune.doneVolumes") });
            }
          }}
          disabled={!runtime.running || ctr || rows.length === 0}
        >
          <Trash2 size={13} />
          {t("containers.m.cleanUp")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!runtime.running || ctr}>
          <Plus size={13} />
          {t("containers.m.volumes.create")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.volumes.search")} />
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
        {/* A fixed layout: the drawer narrows the table, and only the name and path give way. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col [&_table]:table-fixed">
          {!runtime.running ? (
            <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
          ) : list?.error ? (
            <EmptyLine>{list.error}</EmptyLine>
          ) : firstRead(list) ? (
            <LoadingLine />
          ) : shown.length === 0 ? (
            <EmptyLine>{rows.length ? t("containers.m.volumes.noMatch") : t("containers.m.volumes.none")}</EmptyLine>
          ) : (
            <DataTable minWidth={openRow ? 520 : 680}>
              <thead>
                <tr>
                  <Th align="center" width={32}>
                    <Checkbox checked={allPicked} onChange={() => setAll(allPicked ? null : shown.map((row) => row.name))} />
                  </Th>
                  <Th>{t("containers.m.col.name")}</Th>
                  <Th width={90}>{t("containers.m.volumes.col.driver")}</Th>
                  <Th>{t("containers.m.volumes.col.mountpoint")}</Th>
                  <Th width={130}>{t("containers.m.volumes.col.project")}</Th>
                  <Th align="right" width={56}>
                    {t("containers.m.col.actions")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr
                    key={row.name}
                    className={trClass(picked.has(row.name) || openName === row.name, true)}
                    onClick={() => setOpenName(row.name)}
                    onContextMenu={(e) => setMenu(menuAt(e, rowMenu(row)))}
                  >
                    <Td align="center" className="w-8">
                      <StopClick>
                        <Checkbox checked={picked.has(row.name)} onChange={() => toggle(row.name)} />
                      </StopClick>
                    </Td>
                    <Td>
                      <span className="block truncate font-medium text-[var(--cf-text)]" title={row.name}>
                        {row.name}
                      </span>
                    </Td>
                    <Td className="text-[var(--cf-text-muted)]">{row.driver || "—"}</Td>
                    <Td>
                      <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={row.mountpoint}>
                        {row.mountpoint || "—"}
                      </span>
                    </Td>
                    <Td>
                      {row.project ? (
                        <span className="block truncate text-[var(--cf-text)]" title={row.project}>
                          {row.project}
                        </span>
                      ) : (
                        <span className="text-[var(--cf-text-faint)]">—</span>
                      )}
                    </Td>
                    <Td className="w-[56px]">
                      <div className="flex items-center justify-end gap-0.5">
                        <RowAction label={t("containers.remove")} danger disabled={busy[`volume|${row.name}`]} onClick={() => void removeOne(row)}>
                          <Trash2 size={12} />
                        </RowAction>
                        <RowAction label={t("containers.m.moreActions")} onClick={(e) => setMenu(menuAt(e, rowMenu(row)))}>
                          <MoreHorizontal size={13} />
                        </RowAction>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
        {openRow && <VolumeDrawer key={openRow.name} runtime={runtime} context={context} row={openRow} onClose={() => setOpenName(null)} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {creating && <CreateVolumeDialog runtime={runtime} context={context} onClose={() => setCreating(false)} />}
    </div>
  );
}

function VolumeDrawer({ runtime, context, row, onClose }: { runtime: RuntimeInfo; context: string | null; row: VolumeRow; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<DrawerView>("details");
  const [jsonAsked, setJsonAsked] = useState(false);
  const inspect = useInspect(runtime.id, context, "volume", jsonAsked ? row.name : null);
  const labels = Object.entries(row.labels ?? {});
  return (
    <Drawer
      title={row.name}
      view={view}
      onView={(next) => {
        setView(next);
        if (next === "json") setJsonAsked(true);
      }}
      onClose={onClose}
      layoutId="volumes-drawer-view"
    >
      {view === "json" ? (
        <InspectPane state={inspect} />
      ) : (
        <DrawerBody>
          <Facts
            rows={[
              [t("containers.m.col.name"), <CopyText text={row.name} toast={t("containers.m.volumes.copiedName")} title={t("containers.copyName")} />],
              [t("containers.m.volumes.col.driver"), row.driver],
              [t("containers.m.volumes.col.mountpoint"), <span className="break-all font-mono text-[11.5px]">{row.mountpoint}</span>],
              [t("containers.m.volumes.col.project"), row.project],
            ]}
          />
          {labels.length > 0 && (
            <>
              <SectionTitle>{t("containers.fact.labels")}</SectionTitle>
              <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                {labels.map(([key, value]) => (
                  <li key={key} className="truncate" title={`${key}=${value}`}>
                    {key}=<span className="text-[var(--cf-text)]">{value}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </DrawerBody>
      )}
    </Drawer>
  );
}

/** A named volume — a name and a driver (`local` unless a plugin provides another). */
function CreateVolumeDialog({ runtime, context, onClose }: { runtime: RuntimeInfo; context: string | null; onClose: () => void }) {
  const t = useT();
  const refreshList = useContainersStore((s) => s.refreshList);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("local");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = validObjectName(name);
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await containersCreateVolume(runtime.id, context, name.trim(), driver.trim() || null);
      pushSuccessToast(t("containers.m.volumes.created", { name: name.trim() }));
      void refreshList(runtime.id, "volumes");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const mono = fieldClass({ size: "sm", className: "w-full font-mono" });
  return (
    <Dialog
      title={t("containers.m.volumes.create")}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {t("common.create")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t("containers.m.col.name")} hint={name.trim() && !valid ? t("containers.m.create.nameInvalid") : undefined}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="app-data" spellCheck={false} className={mono} />
        </Field>
        <Field label={t("containers.m.volumes.col.driver")}>
          <input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="local" spellCheck={false} className={mono} />
        </Field>
        {error && <MutedLine>{error}</MutedLine>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
