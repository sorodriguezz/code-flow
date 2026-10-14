import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string) => key,
  useLanguageStore: Object.assign((select: (s: { language: string }) => unknown) => select({ language: "en" }), {
    getState: () => ({ language: "en" }),
  }),
}));

const { ChatModelPicker } = await import("./ChatModelPicker");

/**
 * The Changes panel's 🛡 and its model picker are one control: the run on the left, the chevron that
 * opens the `analyze` routing menu on the right, and both naming the engine on hover.
 */
describe("ChatModelPicker split", () => {
  const markup = renderToStaticMarkup(
    <ChatModelPicker
      task="analyze"
      variant="split"
      liveModel={null}
      chatActive={false}
      title="changes.analyzeModelHint"
      tour="changes-analyze"
      action={{ icon: <svg data-glyph="shield" />, label: "analyze.button", onClick: () => {} }}
    />,
  );
  const buttons = markup.match(/<button[^>]*>/g) ?? [];

  it("is one control, anchored for the tour, holding exactly the run and the menu's trigger", () => {
    expect(markup.startsWith("<div")).toBe(true);
    expect(markup.split('data-tour="changes-analyze"').length - 1).toBe(1);
    expect(buttons).toHaveLength(2);
    // The run's glyph is inside the first half, not beside the control.
    expect(markup.indexOf('data-glyph="shield"')).toBeLessThan(markup.indexOf("aria-haspopup"));
  });

  it("names the run on its half and the route under it", () => {
    const [run] = buttons;
    expect(run).toContain('aria-label="analyze.button"');
    expect(run).toMatch(/title="analyze\.button\n[^"]+"/);
    expect(run).not.toContain("aria-haspopup");
  });

  it("makes the chevron the menu's trigger, headed with the task's own question", () => {
    const [, chevron] = buttons;
    expect(chevron).toContain('aria-haspopup="menu"');
    expect(chevron).toContain('aria-expanded="false"');
    expect(chevron).toMatch(/aria-label="task\.analyzeModelFor: [^"]+"/);
    expect(chevron).toMatch(/title="[^"]+\nchanges\.analyzeModelHint"/);
  });
});

/**
 * The Inbox's "Analizar cambios": the same two halves at a button's size, with the run's name in
 * words — the text runs it, the chevron beside it opens the `analyze` routing menu.
 */
describe("ChatModelPicker button", () => {
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      <ChatModelPicker
        task="analyze"
        variant="button"
        liveModel={null}
        chatActive={false}
        title="changes.analyzeModelHint"
        action={{
          icon: <svg data-glyph="shield" />,
          label: "assistant.analyze",
          disabled,
          title: disabled ? "analyze.nothingToAnalyze" : undefined,
          onClick: () => {},
        }}
      />,
    );

  it("spells the run out on its half and keeps the chevron as the menu's trigger", () => {
    const markup = render(false);
    const buttons = markup.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(markup).toMatch(/data-glyph="shield"[^]*assistant\.analyze<\/button>/);
    expect(buttons[0]).not.toContain("aria-haspopup");
    expect(buttons[1]).toContain('aria-haspopup="menu"');
    expect(buttons[1]).toMatch(/aria-label="task\.analyzeModelFor: [^"]+"/);
  });

  it("turns only the run off when there is nothing to run — the engine can still be chosen", () => {
    const buttons = render(true).match(/<button[^>]*>/g) ?? [];
    expect(buttons[0]).toContain("disabled");
    expect(buttons[0]).toMatch(/title="assistant\.analyze\n[^"]+\nanalyze\.nothingToAnalyze"/);
    expect(buttons[1]).not.toContain("disabled");
  });
});
