import type { Ticket, TicketLink } from "../tauri/ticketCommands";

/**
 * The pure half of «Tickets»: identity, the key a branch carries, which ticket a repository's
 * current branch belongs to, and the list's filters. The projects panel calls `ticketForBranch` on
 * every row, so everything here works from what is already in memory — never a request.
 */

/** `provider:account:key-or-id` — the twin of `Ticket::uid` in `boards/tickets.rs`. */
export function ticketUid(ticket: Pick<Ticket, "provider" | "account" | "key" | "id">): string {
  const which = ticket.key.trim() || String(ticket.id);
  return `${ticket.provider.trim().toLowerCase()}:${ticket.account.trim().toLowerCase()}:${which}`;
}

/** Whether the board numbers its tickets with a key people say aloud. */
function keyed(ticket: Pick<Ticket, "provider" | "key">): boolean {
  return (ticket.provider === "jira" || ticket.provider === "linear") && ticket.key.trim() !== "";
}

/** How the chip names it: `ABC-123`, `#123`. */
export function displayKey(ticket: Pick<Ticket, "provider" | "key" | "id">): string {
  return keyed(ticket) ? ticket.key.trim() : `#${ticket.id}`;
}

/** The token a branch created from this ticket carries — `Ticket::branch_token` on the Rust side. */
export function ticketToken(ticket: Pick<Ticket, "provider" | "key" | "id">): string {
  return keyed(ticket) ? ticket.key.trim().toUpperCase() : String(ticket.id);
}

/**
 * The ticket token in a branch name, if any: `feature/ABC-123-x` → `ABC-123`, `bugfix/4821-x` →
 * `4821`. Read from the last path segment, where every naming convention puts it. A version
 * (`release/2026.10`, `v2-hotfix`) is nobody's, and a lone digit is too little to call a ticket.
 */
export function branchTicketToken(branch: string): string | null {
  const last = branch.trim().split("/").pop() ?? "";
  const key = /^([A-Za-z]+)-(\d+)(?:[-_].*)?$/.exec(last);
  if (key) return `${key[1].toUpperCase()}-${key[2]}`;
  const number = /^(\d{2,})(?:[-_].*)?$/.exec(last);
  if (number) {
    const trimmed = number[1].replace(/^0+/, "");
    return trimmed || null;
  }
  return null;
}

/**
 * The ticket a repository's branch belongs to: the link «Empezar» recorded first (the newest copy of
 * its ticket from the list if there is one), else a ticket whose token the branch name carries —
 * and only when exactly one known ticket has it, since `#123` exists on every board that numbers.
 */
export function ticketForBranch(
  projectId: string,
  branch: string | null | undefined,
  links: readonly TicketLink[],
  tickets: readonly Ticket[],
): { ticket: Ticket; linked: boolean } | null {
  if (!branch) return null;
  const link = links.find((candidate) => candidate.project_id === projectId && candidate.branch === branch);
  if (link) {
    const fresh = tickets.find((ticket) => ticketUid(ticket) === link.ticket_uid);
    return { ticket: fresh ?? link.ticket, linked: true };
  }
  const token = branchTicketToken(branch);
  if (!token) return null;
  const matches = tickets.filter((ticket) => ticketToken(ticket) === token);
  return matches.length === 1 ? { ticket: matches[0], linked: false } : null;
}

export interface TicketFilters {
  /** `provider:account:project` keys — empty means every board. */
  boards: string[];
  states: string[];
  sprints: string[];
  types: string[];
}

export const NO_FILTERS: TicketFilters = { boards: [], states: [], sprints: [], types: [] };

/** The board a ticket is grouped under. */
export function boardOf(ticket: Ticket): string {
  return `${ticket.provider}:${ticket.account}:${ticket.project}`;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function filterTickets(tickets: readonly Ticket[], filters: TicketFilters, query: string): Ticket[] {
  const needle = fold(query.trim());
  return tickets.filter((ticket) => {
    if (filters.boards.length > 0 && !filters.boards.includes(boardOf(ticket))) return false;
    if (filters.states.length > 0 && !filters.states.includes(ticket.state)) return false;
    if (filters.sprints.length > 0 && !filters.sprints.includes(ticket.sprint)) return false;
    if (filters.types.length > 0 && !filters.types.includes(ticket.work_item_type)) return false;
    if (!needle) return true;
    return fold(`${displayKey(ticket)} ${ticket.key} ${ticket.title} ${ticket.project}`).includes(needle);
  });
}

/** The distinct values of one field, in first-seen order, blanks left out. */
export function valuesOf(tickets: readonly Ticket[], field: "state" | "sprint" | "work_item_type"): string[] {
  const seen = new Set<string>();
  for (const ticket of tickets) {
    const value = ticket[field].trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

export interface TicketGroup {
  key: string;
  provider: Ticket["provider"];
  project: string;
  account: string;
  tickets: Ticket[];
}

/** Grouped by board (provider · project), in the order boards first appear; inside a group, work in
 * review first, then in progress, then the rest — newest first within each. */
export function groupTickets(tickets: readonly Ticket[]): TicketGroup[] {
  const order: Record<string, number> = { review: 0, doing: 1, todo: 2, "": 3, done: 4 };
  const groups = new Map<string, TicketGroup>();
  for (const ticket of tickets) {
    const key = boardOf(ticket);
    let group = groups.get(key);
    if (!group) {
      group = { key, provider: ticket.provider, project: ticket.project, account: ticket.account, tickets: [] };
      groups.set(key, group);
    }
    group.tickets.push(ticket);
  }
  for (const group of groups.values()) {
    group.tickets.sort(
      (a, b) =>
        (order[a.state_category] ?? 3) - (order[b.state_category] ?? 3) || b.updated_at.localeCompare(a.updated_at),
    );
  }
  return [...groups.values()];
}
