import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/languageStore", () => ({ useT: () => (key: string) => key }));

import { groupToasts } from "./Toast";
import { MorphToast } from "./MorphToast";

const toast = (id: string, message: string, type: "error" | "success" | "info" = "error") => ({ id, message, type });

describe("groupToasts", () => {
  it("draws twins raised while one is up as one card, raised, at the newest raise's place", () => {
    const groups = groupToasts([toast("a", "offline"), toast("b", "Copied", "info"), toast("c", "offline")]);
    expect(groups.map((g) => [g.key, g.ids, g.raise, g.order])).toEqual([
      ["a", ["a", "c"], 1, 2],
      ["b", ["b"], 0, 1],
    ]);
  });

  it("keeps the same text in two kinds apart", () => {
    expect(groupToasts([toast("a", "x", "error"), toast("b", "x", "info")])).toHaveLength(2);
  });

  it("lets a short line be the pill and sends a long or multi-line one below it", () => {
    const [short, long, lines] = groupToasts([
      toast("a", "Rama creada", "success"),
      toast("b", "x".repeat(120)),
      toast("c", "one\ntwo", "info"),
    ]);
    expect([short.fits, long.fits, lines.fits]).toEqual([true, false, false]);
  });
});

describe("MorphToast", () => {
  const card = (props: Partial<Parameters<typeof MorphToast>[0]> = {}) =>
    renderToStaticMarkup(
      <MorphToast
        tone="success"
        title="Rama creada"
        titleKey="Rama creada"
        align="center"
        duration={6000}
        canExpand
        leaving={false}
        {...props}
      />,
    );

  it("announces an error as an alert and anything else as a status", () => {
    expect(card({ tone: "error", urgent: true })).toContain('role="alert"');
    expect(card()).toContain('role="status"');
  });

  it("is a pill and nothing more without a body, and starts at rest so the rise has a from", () => {
    const pill = card();
    expect(pill).not.toContain("cf-morph-body");
    expect(pill).toContain('data-ready="false"');
    expect(card({ body: "the remote contains work that you do not have" })).toContain("cf-morph-body");
  });

  it("filters its own shape through a goo id a url() reference can name", () => {
    const html = card({ body: "detail" });
    const id = /<filter id="([^"]+)"/.exec(html)?.[1];
    expect(id).toMatch(/^cf-goo-[\w-]+$/);
    expect(html).toContain(`filter="url(#${id})"`);
  });

  it("is one button when it goes somewhere, labelled by where", () => {
    const html = card({ onActivate: () => {}, activateLabel: "Go there" });
    expect(html).toMatch(/<button type="button" class="cf-morph-hit" title="Go there">/);
  });
});
