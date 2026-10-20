import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskReview } from "../../state/taskReviewStore";

/**
 * What the review tab promises on screen: the files the agent touched, how many notes are waiting
 * on each, and a send button that says how many are about to go. Every one of those is a number the
 * user reads before spending a turn, so they are pinned here as markup rather than as store state.
 *
 * The store is a stand-in rather than the real one. These render on the server (the suite has no
 * DOM), and zustand serves a server render from its *initial* state — seeding the real store would
 * assert against an empty review no matter what was put in it.
 */

let review: TaskReview;

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
// The file icon subscribes to the icon catalogue with no server snapshot, which a render on the
// server refuses outright. It draws a glyph; nothing here is about glyphs.
vi.mock("../common/FileGlyph", () => ({ FileGlyph: () => null }));
vi.mock("../../state/taskReviewStore", () => {
  const store = (selector: (s: unknown) => unknown) =>
    selector({ byTask: { t1: review }, load: async () => {}, selectFile: async () => {} });
  store.getState = () => ({ load: async () => {}, selectFile: async () => {} });
  return { useTaskReviewStore: store, reviewOf: () => review };
});

const { TaskReviewPanel } = await import("./TaskReviewPanel");

function seed(patch: Partial<TaskReview> = {}): void {
  review = {
    repoPath: "/tmp/wt/login",
    files: [
      { path: "src/a.ts", status: "modified", binary: false, added: 2, removed: 1, staged: false },
      { path: "src/b.ts", status: "untracked", binary: false, added: 9, removed: 0, staged: false },
    ],
    loading: false,
    error: "",
    selected: null,
    diff: null,
    diffLoading: false,
    comments: [],
    general: "",
    ...patch,
  };
}

const render = () => renderToStaticMarkup(<TaskReviewPanel taskId="t1" repoPath="/tmp/wt/login" />);

beforeEach(() => seed());

describe("TaskReviewPanel", () => {
  it("lists the changed files with what each adds and removes", () => {
    const html = render();
    expect(html).toContain("a.ts");
    expect(html).toContain("b.ts");
    expect(html).toContain("+2");
    expect(html).toContain("−1");
    expect(html).toContain("2 changed file(s)");
  });

  it("offers nothing to send while no comment has been written", () => {
    const html = render();
    expect(html).toContain("Send review");
    expect(html).not.toContain("Send review (");
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it("counts the comments on the send button and on the file they belong to", () => {
    seed({
      comments: [
        { id: "c1", path: "src/a.ts", side: "new", lineno: 7, code: "+ a", body: "usa una constante", createdAt: 1 },
        { id: "c2", path: "src/a.ts", side: "new", lineno: 9, code: "+ b", body: "y esto", createdAt: 2 },
      ],
      general: "revisa los tests",
    });
    const html = render();
    // Two line comments plus the general note.
    expect(html).toContain("Send review (3)");
    expect(html).toContain("src/a.ts:7");
    expect(html).toContain("usa una constante");
  });

  it("says why the changes could not be read instead of showing a clean tree", () => {
    seed({ error: "not a git repository", files: [] });
    const html = render();
    expect(html).toContain("The changes could not be read");
    expect(html).toContain("not a git repository");
  });

  it("tells the reader how to leave a comment when there are none", () => {
    expect(render()).toContain("No comments yet");
  });

  it("draws the open file's diff with a button on every line", () => {
    seed({
      selected: "src/a.ts",
      diff: {
        old_path: "src/a.ts",
        new_path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            lines: [
              { origin: " ", content: "const a = 1", old_lineno: 1, new_lineno: 1 },
              { origin: "+", content: "const b = 2", old_lineno: null, new_lineno: 2 },
            ],
          },
        ],
      },
    });
    const html = render();
    expect(html).toContain("const b = 2");
    expect(html).toContain("@@ -1,2 +1,2 @@");
    expect((html.match(/aria-label="Comment on this line"/g) ?? []).length).toBe(2);
  });

  it("says so for a binary file rather than drawing an empty diff", () => {
    seed({
      selected: "logo.png",
      diff: { old_path: "logo.png", new_path: "logo.png", status: "modified", binary: true, hunks: [] },
    });
    expect(render()).toContain("Binary file");
  });

  it("is read-only where no agent works: no comment button, no composer", () => {
    seed({
      selected: "src/a.ts",
      diff: {
        old_path: "src/a.ts",
        new_path: "src/a.ts",
        status: "modified",
        binary: false,
        hunks: [{ header: "@@ -1 +1 @@", lines: [{ origin: "+", content: "const b = 2", old_lineno: null, new_lineno: 1 }] }],
      },
    });
    const html = renderToStaticMarkup(<TaskReviewPanel taskId="t1" repoPath="/tmp/wt/login" sendTo={{ kind: "none" }} />);
    expect(html).toContain("const b = 2");
    expect(html).not.toContain("Comment on this line");
    expect(html).not.toContain("Send review");
    expect(html).not.toContain("Show the comments");
  });

  it("names the terminal agent the review goes to", () => {
    const html = renderToStaticMarkup(
      <TaskReviewPanel
        taskId="t1"
        repoPath="/tmp/wt/login"
        sendTo={{ kind: "terminal", agents: [{ sessionId: "pty-1", label: "Claude Code" }] }}
      />,
    );
    expect(html).toContain("Send to Claude Code");
  });

  // A `//` line placed between JSX tags is not a comment — React renders it as text.
  it("renders no source comments as text", () => {
    expect(render().replace(/<[^>]*>/g, "")).not.toMatch(/\/\/|\/\*/);
  });
});
