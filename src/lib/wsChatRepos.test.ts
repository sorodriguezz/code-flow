import { describe, expect, it } from "vitest";
import { repoRows, reposReady } from "./wsChatRepos";

const projects = [
  { id: "1", name: "api", local_path: "/w/api" },
  { id: "2", name: "web", local_path: "/w/web" },
  { id: "3", name: "notes", local_path: "/w/notes" },
  { id: "4", name: "new", local_path: "/w/new" },
];
const snapshot = [
  { id: "1", path: "/w/api", name: "api", branch: "main", onDisk: true, isRepo: true },
  { id: "2", path: "/w/web", name: "web", branch: null, onDisk: false, isRepo: false },
  { id: "3", path: "/w/notes", name: "notes", branch: null, onDisk: true, isRepo: false },
];

describe("repoRows", () => {
  it("flags a missing folder and a plain folder, and trusts what the snapshot has not listed", () => {
    const rows = repoRows(projects, snapshot);
    expect(rows.map((r) => r.state)).toEqual(["ok", "missing", "notRepo", "ok"]);
    expect(rows[0].branch).toBe("main");
    expect(reposReady(rows)).toBe(2);
  });
  it("shows everything ok before the snapshot loads", () => {
    expect(reposReady(repoRows(projects, null))).toBe(4);
  });
});
