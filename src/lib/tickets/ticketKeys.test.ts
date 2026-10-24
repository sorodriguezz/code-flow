import { describe, expect, it } from "vitest";
import type { Ticket, TicketLink } from "../tauri/ticketCommands";
import {
  NO_FILTERS,
  branchTicketToken,
  displayKey,
  filterTickets,
  groupTickets,
  ticketForBranch,
  ticketUid,
  valuesOf,
} from "./ticketKeys";

function ticket(partial: Partial<Ticket>): Ticket {
  return {
    provider: "jira",
    account: "https://acme.atlassian.net",
    project: "Web",
    container_id: "WEB",
    id: 1,
    key: "",
    title: "Algo",
    state: "To Do",
    state_category: "todo",
    work_item_type: "Story",
    sprint: "",
    priority: "",
    url: "",
    updated_at: "2026-10-20",
    state_field: "",
    ...partial,
  };
}

function link(partial: Partial<TicketLink>): TicketLink {
  return {
    id: "l1",
    workspace_id: "w",
    project_id: "p1",
    ticket_uid: "",
    ticket: ticket({}),
    branch: "",
    worktree_path: "",
    pr_id: 0,
    pr_url: "",
    stage: "started",
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

describe("branchTicketToken", () => {
  it("reads keys and numbers off the last segment", () => {
    expect(branchTicketToken("feature/AB-123-titulo")).toBe("AB-123");
    expect(branchTicketToken("bugfix/4821-totales")).toBe("4821");
    expect(branchTicketToken("eng-7")).toBe("ENG-7");
    expect(branchTicketToken("users/sofia/123_fix")).toBe("123");
    expect(branchTicketToken("feature/ENG-7")).toBe("ENG-7");
  });

  it("leaves versions, words and lone digits alone", () => {
    for (const branch of ["main", "release/2026.10", "v2-hotfix", "feature/7-x", "feature/AB-12x", "codeflow/task-1a2b3c4d"]) {
      expect(branchTicketToken(branch)).toBeNull();
    }
  });
});

describe("ticketForBranch", () => {
  const jira = ticket({ key: "ABC-5", id: 10005, state: "In Review" });
  const azure = ticket({ provider: "azure", account: "acme", id: 4821 });
  const github = ticket({ provider: "github", account: "github.com", key: "acme/web#4821", id: 4821 });

  it("prefers the recorded link, with the fresh copy of its ticket", () => {
    const stale = { ...jira, state: "To Do" };
    const links = [link({ branch: "feature/x", ticket_uid: ticketUid(jira), ticket: stale })];
    const found = ticketForBranch("p1", "feature/x", links, [jira]);
    expect(found?.linked).toBe(true);
    expect(found?.ticket.state).toBe("In Review");
    expect(ticketForBranch("p2", "feature/x", links, [jira])).toBeNull();
  });

  it("matches a parsed token only when one ticket has it", () => {
    expect(ticketForBranch("p1", "feature/ABC-5-login", [], [jira, azure])?.ticket.key).toBe("ABC-5");
    expect(ticketForBranch("p1", "bugfix/4821-x", [], [azure])?.linked).toBe(false);
    expect(ticketForBranch("p1", "bugfix/4821-x", [], [azure, github]), "ambiguous").toBeNull();
    expect(ticketForBranch("p1", "main", [], [azure])).toBeNull();
    expect(ticketForBranch("p1", null, [], [azure])).toBeNull();
  });
});

describe("filters and groups", () => {
  const list = [
    ticket({ key: "ABC-1", title: "Iniciar sesión", sprint: "Sprint 1", state: "To Do", updated_at: "1" }),
    ticket({ key: "ABC-2", title: "Pagos", sprint: "Sprint 2", state: "In Review", state_category: "review", updated_at: "2" }),
    ticket({ provider: "azure", account: "acme", project: "Api", id: 9, title: "Bug", work_item_type: "Bug" }),
  ];

  it("filters by board, state, sprint, type and folded search", () => {
    expect(filterTickets(list, { ...NO_FILTERS, sprints: ["Sprint 2"] }, "").map((t) => t.key)).toEqual(["ABC-2"]);
    expect(filterTickets(list, NO_FILTERS, "sesion").map((t) => t.key)).toEqual(["ABC-1"]);
    expect(filterTickets(list, NO_FILTERS, "#9")).toHaveLength(1);
    expect(filterTickets(list, { ...NO_FILTERS, types: ["Bug"] }, "")).toHaveLength(1);
    expect(filterTickets(list, { ...NO_FILTERS, boards: ["azure:acme:Api"] }, "")).toHaveLength(1);
    expect(valuesOf(list, "sprint")).toEqual(["Sprint 1", "Sprint 2"]);
  });

  it("groups by board with review work first", () => {
    const groups = groupTickets(list);
    expect(groups.map((g) => g.project)).toEqual(["Web", "Api"]);
    expect(groups[0].tickets.map((t) => t.key)).toEqual(["ABC-2", "ABC-1"]);
  });

  it("names and identifies tickets like the backend", () => {
    expect(displayKey(list[0])).toBe("ABC-1");
    expect(displayKey(list[2])).toBe("#9");
    expect(ticketUid(list[2])).toBe("azure:acme:9");
  });
});
