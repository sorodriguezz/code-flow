import { useEffect, useMemo, useState } from "react";
import { Bug, ChevronRight, CircleDot, ListFilter, RefreshCw, Settings2 } from "lucide-react";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import { iconButtonClass } from "../../common/Button";
import { chipClass, sectionLabelClass, tabCountClass } from "../../common/recipes";
import { Row } from "../TreeRow";
import { useTicketStore, AUTO_MOVE_KEY, BRANCH_PREFIX_KEY, BUG_PREFIX_KEY } from "../../../state/ticketStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useChainStore } from "../../../state/chainStore";
import { useT } from "../../../state/languageStore";
import { promptAction } from "../../../state/promptStore";
import { getSetting, setSetting } from "../../../lib/tauri/commands";
import { boardLabelKey } from "../../../lib/boardLabel";
import {
  NO_FILTERS,
  displayKey,
  filterTickets,
  groupTickets,
  ticketUid,
  valuesOf,
  type TicketFilters,
} from "../../../lib/tickets/ticketKeys";
import type { Ticket } from "../../../lib/tauri/ticketCommands";

/** The chip tone a state category reads in. */
export function stateTone(category: string): "neutral" | "accent" | "ok" | "warn" | "info" {
  switch (category) {
    case "doing":
      return "info";
    case "review":
      return "warn";
    case "done":
      return "ok";
    default:
      return "neutral";
  }
}

export function TicketTypeGlyph({ ticket, size = 13 }: { ticket: Ticket; size?: number }) {
  const bug = /bug|defect|error|incidente/i.test(ticket.work_item_type);
  return bug ? (
    <Bug size={size} className="text-[var(--cf-danger)]" />
  ) : (
    <CircleDot size={size} className="text-[var(--cf-text-muted)]" />
  );
}

/**
 * «TICKETS», the last section of the Tareas tree: the tickets assigned to you on every connected
 * board, grouped by board, newest review work first (user, 2026-10-23: «… como una sección nueva
 * «Tickets» … lista de tickets asignados a ti (por proveedor y proyecto, con filtros por estado y
 * sprint)»). The tree's own search box filters it too. A row opens the ticket in the middle column.
 *
 * Read from the boards once per session when it first draws, and again on its refresh button —
 * never on a timer: it is someone else's API with someone else's quota.
 */
export function TicketsSection({ query }: { query: string }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const tickets = useTicketStore((s) => s.tickets);
  const errors = useTicketStore((s) => s.errors);
  const loading = useTicketStore((s) => s.loading);
  const fetchedAt = useTicketStore((s) => s.fetchedAt);
  const filters = useTicketStore((s) => s.filters);
  const selectedUid = useTicketStore((s) => s.selectedUid);
  const links = useTicketStore((s) => s.links);
  // A task, a chain or a template on screen wins the middle column; the row is only "selected"
  // while the ticket is what is actually shown.
  const taskSelected = useAgentsStore((s) => s.selectedId !== null);
  const chainSelected = useChainStore((s) => s.selectedId !== null || s.selectedTemplateId !== null);
  const otherSelected = taskSelected || chainSelected;
  const [expanded, setExpanded] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "filter" | "settings" } | null>(null);
  const [autoMove, setAutoMove] = useState(true);

  useEffect(() => {
    void useTicketStore.getState().loadCache();
    void getSetting(AUTO_MOVE_KEY)
      .then((value) => setAutoMove(value !== "0"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    void useTicketStore.getState().loadLinks(workspaceId);
    if (expanded && useTicketStore.getState().fetchedAt === 0) void useTicketStore.getState().refresh(workspaceId);
  }, [workspaceId, expanded]);

  const visible = useMemo(() => filterTickets(tickets, filters, query), [tickets, filters, query]);
  const groups = useMemo(() => groupTickets(visible), [visible]);
  const linkedUids = useMemo(() => new Set(links.map((link) => link.ticket_uid)), [links]);
  const filtering = filters.boards.length + filters.states.length + filters.sprints.length + filters.types.length > 0;

  const toggle = (field: keyof TicketFilters, value: string) => {
    const current = filters[field];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    useTicketStore.getState().setFilters({ ...filters, [field]: next });
  };
  const check = (on: boolean, label: string) => (on ? `✓ ${label}` : label);

  const filterItems = (): MenuItem[] => {
    const boards = groupTickets(tickets).map((group) => ({
      key: group.key,
      label: `${t(boardLabelKey(group.provider))} · ${group.project}`,
    }));
    const section = (field: keyof TicketFilters, label: string, values: { key: string; label: string }[]): MenuItem | null =>
      values.length === 0
        ? null
        : {
            label,
            onClick: () => undefined,
            children: values.map((value) => ({
              label: check(filters[field].includes(value.key), value.label),
              onClick: () => toggle(field, value.key),
            })),
          };
    const plain = (values: string[]) => values.map((value) => ({ key: value, label: value }));
    const items = [
      section("boards", t("tickets.filterBoard"), boards),
      section("states", t("tickets.filterState"), plain(valuesOf(tickets, "state"))),
      section("sprints", t("tickets.filterSprint"), plain(valuesOf(tickets, "sprint"))),
      section("types", t("tickets.filterType"), plain(valuesOf(tickets, "work_item_type"))),
    ].filter((item): item is MenuItem => item !== null);
    if (filtering) {
      items.push({ label: t("tickets.clearFilters"), separated: true, onClick: () => useTicketStore.getState().setFilters(NO_FILTERS) });
    }
    return items;
  };

  const editPrefix = async (key: string, fallback: string, label: string) => {
    const current = (await getSetting(key).catch(() => null)) ?? fallback;
    const next = await promptAction(label, { initial: current, allowEmpty: true });
    if (next !== null) await setSetting(key, next).catch(() => undefined);
  };

  const settingsItems = (): MenuItem[] => [
    {
      label: check(autoMove, t("tickets.autoMove")),
      onClick: () => {
        const next = !autoMove;
        setAutoMove(next);
        void setSetting(AUTO_MOVE_KEY, next ? "1" : "0").catch(() => undefined);
      },
    },
    {
      label: t("tickets.branchPrefix"),
      separated: true,
      onClick: () => void editPrefix(BRANCH_PREFIX_KEY, "feature/", t("tickets.branchPrefix")),
    },
    { label: t("tickets.bugPrefix"), onClick: () => void editPrefix(BUG_PREFIX_KEY, "bugfix/", t("tickets.bugPrefix")) },
  ];

  return (
    <section>
      <div className={`group/section ${sectionLabelClass} pr-0`}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex min-h-[22px] min-w-0 flex-1 items-center gap-1.5 text-left uppercase transition-colors hover:text-[var(--cf-text-muted)]"
        >
          <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
          <span className="truncate">{t("tickets.section")}</span>
          {visible.length > 0 && <span className={`${tabCountClass} tracking-normal`}>{visible.length}</span>}
        </button>
        <Tooltip label={t("tickets.filter")}>
          <button
            type="button"
            onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, kind: "filter" })}
            aria-label={t("tickets.filter")}
            aria-pressed={filtering}
            className={iconButtonClass({
              size: "xs",
              active: filtering,
              className: filtering ? "" : "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100",
            })}
          >
            <ListFilter size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t("tickets.settings")}>
          <button
            type="button"
            onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, kind: "settings" })}
            aria-label={t("tickets.settings")}
            className={iconButtonClass({ size: "xs", className: "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100" })}
          >
            <Settings2 size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t("tickets.refresh")}>
          <button
            type="button"
            onClick={() => void useTicketStore.getState().refresh(workspaceId)}
            disabled={loading}
            aria-label={t("tickets.refresh")}
            className={iconButtonClass({
              size: "xs",
              className: loading ? "" : "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100",
            })}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </Tooltip>
      </div>
      {expanded && (
        <div className="pb-1">
          {errors.map((error) => (
            <p
              key={`${error.provider}:${error.account}`}
              title={error.message}
              className="truncate px-2 py-0.5 text-[11.5px] text-[var(--cf-danger)]"
            >
              {t(boardLabelKey(error.provider))} · {error.account}: {error.message}
            </p>
          ))}
          {groups.length === 0 && (fetchedAt > 0 || tickets.length > 0) && (
            <p className="px-2 py-1 text-[12px] text-[var(--cf-text-faint)]">
              {t(query || filtering ? "agents.noMatches" : "tickets.none")}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key}>
              <p
                title={group.account}
                className="flex items-center gap-1 truncate px-2 pb-0.5 pt-1.5 text-[11px] text-[var(--cf-text-muted)]"
              >
                <span className="truncate">
                  {t(boardLabelKey(group.provider))} · {group.project}
                </span>
                <span className="tabular-nums text-[var(--cf-text-faint)]">{group.tickets.length}</span>
              </p>
              {group.tickets.map((ticket, at) => {
                const uid = ticketUid(ticket);
                const meta = [displayKey(ticket), ticket.sprint, ticket.priority].filter(Boolean).join(" · ");
                return (
                  <Row
                    key={uid}
                    at={at}
                    selected={uid === selectedUid && !otherSelected}
                    onClick={() => useTicketStore.getState().select(uid)}
                    title={`${displayKey(ticket)} · ${ticket.title}`}
                    glyph={<TicketTypeGlyph ticket={ticket} />}
                    label={ticket.title}
                    meta={meta}
                    chip={ticket.state || undefined}
                    flag={
                      linkedUids.has(uid) ? (
                        <span className={chipClass("accent", "h-4 px-1 text-[10.5px]")}>{t("tickets.started")}</span>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={menu.kind === "filter" ? t("tickets.filter") : t("tickets.settings")}
          items={menu.kind === "filter" ? filterItems() : settingsItems()}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
