import { useEffect, useMemo, useState } from "react";
import { Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu } from "../common/ContextMenu";
import { Select } from "../common/Select";
import { chipClass, fieldClass } from "../common/recipes";
import { Facts, RowAction, SectionTitle } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, Dialog, EmptyLine, Field, LiveMark, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { BulkBar, CopyText, Drawer, DrawerBody, InspectPane, MutedLine, StopClick, menuAt, useEngineList, useInspect, usePicked, type DrawerView, type MenuState } from "./pageBits";
import { firstRead, networkFacts, validObjectName } from "./pageModel";
import { containersCreateNetwork } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { ContainerRow, NetworkRow, RuntimeInfo } from "../../types/containers";

/**
 * An engine's networks: the ones it brings (`bridge`, `host`, `none`, Podman's `podman`), which can be
 * neither picked nor removed, and the ones made for containers to find each other by name. Created,
 * removed, the unused ones cleaned up; a side panel with the subnet and who is attached.
 */

const DRIVERS = ["bridge", "overlay", "macvlan"];
const shortId = (id: string) => id.slice(0, 12);

export function NetworksPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const { list, rows } = useEngineList<NetworkRow>(runtime.id, context, "networks");
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
    if (runtime.running) void refreshList(runtime.id, "networks");
  }, [runtime.id, runtime.running, context, refreshList]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(needle) || row.driver.toLowerCase().includes(needle) || row.id.toLowerCase().startsWith(needle));
  }, [rows, query]);
  // The engine's own networks are never picked: nothing done to several at once applies to them.
  const pickable = useMemo(() => shown.filter((row) => !row.builtin), [shown]);
  const pickedRows = rows.filter((row) => !row.builtin && picked.has(row.name));
  const allPicked = pickable.length > 0 && pickable.every((row) => picked.has(row.name));
  const openRow = openName ? rows.find((row) => row.name === openName) : undefined;

  const removeOne = async (row: NetworkRow) => {
    if (await confirmAction(t("containers.confirmRemoveNetwork", { name: row.name, context: place }), true, t("containers.remove"))) {
      void act({ runtime: runtime.id, context, object: "network", action: "remove", ids: [row.name], label: t("containers.done.remove", { name: row.name }) });
    }
  };
  const bulkRemove = async () => {
    if (!pickedRows.length) return;
    const names = pickedRows.map((row) => row.name);
    if (!(await confirmAction(t("containers.m.networks.confirmRemoveMany", { count: names.length, names: names.join(", "), context: place }), true, t("containers.remove")))) return;
    void act({ runtime: runtime.id, context, object: "network", action: "remove", ids: names, label: t("containers.m.networks.removed", { count: names.length }) });
    setAll(null);
  };
  const rowMenu = (row: NetworkRow) => engineMenu({ runtime: runtime.id, context, object: "network", id: row.name, network: row, t, act, select: () => setOpenName(row.name) });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.section.networks")} sub={rows.length ? String(rows.length) : undefined}>
        <Button
          size="sm"
          variant="ghost"
          title={t("containers.prune.networks")}
          onClick={async () => {
            if (await confirmAction(t("containers.prune.confirmNetworks", { context: place }), true, t("containers.prune.confirm"))) {
              void act({ runtime: runtime.id, context, object: "network", action: "prune", ids: [], label: t("containers.prune.doneNetworks") });
            }
          }}
          disabled={!runtime.running || ctr || !rows.some((row) => !row.builtin)}
        >
          <Trash2 size={13} />
          {t("containers.m.cleanUp")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!runtime.running || ctr}>
          <Plus size={13} />
          {t("containers.m.networks.create")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.networks.search")} />
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
          ) : firstRead(list) ? (
            <LoadingLine />
          ) : shown.length === 0 ? (
            <EmptyLine>{rows.length ? t("containers.m.networks.noMatch") : t("containers.m.networks.none")}</EmptyLine>
          ) : (
            <DataTable minWidth={openRow ? 480 : 620}>
              <thead>
                <tr>
                  <Th align="center" width={32}>
                    <Checkbox checked={allPicked} onChange={() => setAll(allPicked ? null : pickable.map((row) => row.name))} disabled={pickable.length === 0} />
                  </Th>
                  <Th>{t("containers.m.col.name")}</Th>
                  <Th width={120}>{t("containers.fact.id")}</Th>
                  <Th width={100}>{t("containers.m.networks.col.driver")}</Th>
                  <Th width={80}>{t("containers.m.networks.col.scope")}</Th>
                  <Th align="right" width={56}>
                    {t("containers.m.col.actions")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr
                    key={row.id || row.name}
                    className={trClass(picked.has(row.name) || openName === row.name, true)}
                    onClick={() => setOpenName(row.name)}
                    onContextMenu={(e) => setMenu(menuAt(e, rowMenu(row)))}
                  >
                    <Td align="center" className="w-8">
                      {!row.builtin && (
                        <StopClick>
                          <Checkbox checked={picked.has(row.name)} onChange={() => toggle(row.name)} />
                        </StopClick>
                      )}
                    </Td>
                    <Td>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium text-[var(--cf-text)]" title={row.name}>
                          {row.name}
                        </span>
                        {row.builtin && (
                          <span className={chipClass("neutral")} title={t("containers.m.networks.builtinHint")}>
                            {t("containers.m.networks.builtin")}
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>{row.id ? <CopyText text={row.id} shown={shortId(row.id)} toast={t("containers.m.networks.copiedId")} title={t("containers.copyId")} /> : <span className="text-[var(--cf-text-faint)]">—</span>}</Td>
                    <Td className="text-[var(--cf-text-muted)]">{row.driver || "—"}</Td>
                    <Td className="text-[var(--cf-text-muted)]">{row.scope || "—"}</Td>
                    <Td className="w-[56px]">
                      <div className="flex items-center justify-end gap-0.5">
                        {!row.builtin && (
                          <RowAction label={t("containers.remove")} danger disabled={busy[`network|${row.name}`]} onClick={() => void removeOne(row)}>
                            <Trash2 size={12} />
                          </RowAction>
                        )}
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
        {openRow && <NetworkDrawer key={openRow.name} runtime={runtime} context={context} row={openRow} onClose={() => setOpenName(null)} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {creating && <CreateNetworkDialog runtime={runtime} context={context} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** A network's facts — its addressing and members read from its inspect document, which the JSON
 *  view shows whole. One read serves both. */
function NetworkDrawer({ runtime, context, row, onClose }: { runtime: RuntimeInfo; context: string | null; row: NetworkRow; onClose: () => void }) {
  const t = useT();
  const select = useContainersStore((s) => s.select);
  const { rows: containers } = useEngineList<ContainerRow>(runtime.id, context, "containers");
  const refreshList = useContainersStore((s) => s.refreshList);
  const [view, setView] = useState<DrawerView>("details");
  // Members are linked to their containers' pages: the list they are found in is read here too.
  useEffect(() => {
    void refreshList(runtime.id, "containers");
  }, [runtime.id, refreshList]);
  const inspect = useInspect(runtime.id, context, "network", row.name);
  const facts = useMemo(() => (inspect.text ? networkFacts(inspect.text) : null), [inspect.text]);
  return (
    <Drawer title={row.name} view={view} onView={setView} onClose={onClose} layoutId="networks-drawer-view">
      {view === "json" ? (
        <InspectPane state={inspect} />
      ) : (
        <DrawerBody>
          <Facts
            rows={[
              [t("containers.m.col.name"), row.name],
              [t("containers.fact.id"), row.id ? <CopyText text={row.id} shown={shortId(row.id)} toast={t("containers.m.networks.copiedId")} title={t("containers.copyId")} /> : ""],
              [t("containers.m.networks.col.driver"), row.driver],
              [t("containers.m.networks.col.scope"), row.scope],
              [t("containers.m.networks.subnet"), facts?.subnets.join(", ") ?? ""],
              [t("containers.m.networks.gateway"), facts?.gateways.join(", ") ?? ""],
              [t("containers.m.networks.internal"), facts?.internal === null || !facts ? "" : facts.internal ? t("common.yes") : t("common.no")],
            ]}
          />
          {inspect.error ? (
            <MutedLine>{inspect.error}</MutedLine>
          ) : inspect.text === null ? (
            <MutedLine>{t("containers.m.loading")}</MutedLine>
          ) : facts && facts.containers.length > 0 ? (
            <>
              <SectionTitle>
                {t("containers.fact.containers")} · {facts.containers.length}
              </SectionTitle>
              <ul className="flex flex-col gap-0.5 text-[12px]">
                {facts.containers.map((member) => {
                  const known = containers.find((c) => c.name === member.name);
                  return (
                    <li key={member.name} className="flex min-w-0 items-center gap-2">
                      {known ? (
                        <button
                          onClick={() => select({ runtime: runtime.id, context, namespace: null, object: "container", id: known.id, name: known.name })}
                          title={t("containers.m.openDetail")}
                          className="min-w-0 truncate text-left text-[var(--cf-accent)] hover:underline"
                        >
                          {member.name}
                        </button>
                      ) : (
                        <span className="min-w-0 truncate text-[var(--cf-text)]">{member.name}</span>
                      )}
                      <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-muted)]">{member.ip}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </DrawerBody>
      )}
    </Drawer>
  );
}

/** A network for containers to find each other by name: `bridge` on one engine, `overlay` across a
 *  swarm, `macvlan` for an address on the host's own network. */
function CreateNetworkDialog({ runtime, context, onClose }: { runtime: RuntimeInfo; context: string | null; onClose: () => void }) {
  const t = useT();
  const refreshList = useContainersStore((s) => s.refreshList);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = validObjectName(name);
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await containersCreateNetwork(runtime.id, context, name.trim(), driver);
      pushSuccessToast(t("containers.m.networks.created", { name: name.trim() }));
      void refreshList(runtime.id, "networks");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t("containers.m.networks.create")}
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
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="app-net" spellCheck={false} className={fieldClass({ size: "sm", className: "w-full font-mono" })} />
        </Field>
        <Field label={t("containers.m.networks.col.driver")}>
          <Select size="sm" value={driver} onChange={setDriver} options={DRIVERS.map((d) => ({ value: d, label: d }))} ariaLabel={t("containers.m.networks.col.driver")} />
        </Field>
        {error && <MutedLine>{error}</MutedLine>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
