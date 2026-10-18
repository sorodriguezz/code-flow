import { describe, expect, it } from "vitest";
import { storiesCsv, storiesMarkdown } from "./storyExport";
import type { StoryDraft } from "../../types/domain";

const story = (patch: Partial<StoryDraft>): StoryDraft =>
  ({
    id: "s1",
    batch_id: "b1",
    seq: 0,
    title: "Pagar con tarjeta",
    narrative: "Como cliente, quiero pagar, para comprar",
    description: "Detalle",
    acceptance_criteria: JSON.stringify(["Dado X\nEntonces Y", "Se guarda, \"ok\""]),
    priority: 2,
    story_points: 3,
    original_estimate: 0,
    tags: "pagos",
    notes: "",
    work_item_id: 0,
    work_item_key: "",
    work_item_url: "",
    verify_status: "",
    verify_summary: "",
    verify_criteria: "[]",
    verified_at: "",
    status: "draft",
    last_error: "",
    created_at: "",
    updated_at: "",
    ...patch,
  }) as StoryDraft;

describe("story export", () => {
  it("writes Markdown with numbered criteria that keep their lines together", () => {
    const text = storiesMarkdown({ title: "Checkout" }, [story({})], { criteria: "Criterios", points: "Puntos", tags: "Etiquetas" });
    expect(text).toContain("# Checkout\n\n## Pagar con tarjeta");
    expect(text).toContain("1. Dado X\n   Entonces Y\n2. Se guarda");
    expect(text).toContain("_Puntos: 3 · Etiquetas: pagos_");
  });

  it("writes CSV with quoted cells where commas, quotes and line breaks need it", () => {
    const csv = storiesCsv([story({ board_state: "Active" })]);
    const [header, row] = csv.replace("﻿", "").trim().split("\r\n");
    expect(header.startsWith("Title,Narrative")).toBe(true);
    expect(row).toContain('"Como cliente, quiero pagar, para comprar"');
    expect(row).toContain('"1. Dado X\nEntonces Y\n2. Se guarda, ""ok"""');
    expect(row.endsWith(",Active")).toBe(true);
  });
});
