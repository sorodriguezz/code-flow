import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextSource } from "../../lib/editorContext";

/**
 * «Contexto usado» names what went with the question — and, when the turn's judgement attached
 * nothing of the project (`context::need`), says so and why, in the user's words rather than the
 * code the backend files it under.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { ContextSources } = await import("./ContextSources");

const source = (patch: Partial<ContextSource>): ContextSource => ({
  kind: "active_file",
  label: "src/app.ts",
  path: "src/app.ts",
  startLine: null,
  endLine: null,
  ...patch,
});

describe("ContextSources", () => {
  it("words why nothing of the project was attached", () => {
    const html = renderToStaticMarkup(<ContextSources sources={[source({ kind: "withheld", label: "general", path: null })]} />);
    expect(html).toContain("general question");
    expect(html).not.toContain(">general<");
    expect(html).toContain("the model can still look it up with its tools");
  });

  it("keeps a file's chip as its path beside the reason", () => {
    const html = renderToStaticMarkup(
      <ContextSources sources={[source({}), source({ kind: "withheld", label: "follow_up", path: null })]} />,
    );
    expect(html).toContain("src/app.ts");
    expect(html).toContain("follow-up");
  });
});
