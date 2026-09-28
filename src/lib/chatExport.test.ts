import { describe, expect, it } from "vitest";
import {
  conversationToJson,
  conversationToMarkdown,
  exportFileName,
  type ExportConversation,
  type ExportLabels,
} from "./chatExport";

const labels: ExportLabels = {
  exported: "Exportada",
  repository: "Repositorio",
  attachments: "Adjuntos",
  you: "Tú",
  assistant: "Asistente",
  error: "Error",
  stopped: "Detenido",
  outputs: "Archivos generados",
  process: (n) => `Proceso · ${n} pasos`,
};

const conversation: ExportConversation = {
  title: "Informe de ventas",
  repository: "api",
  exportedAt: "2026-09-28T12:00:00Z",
  attachments: [{ name: "ventas.csv", path: "/tmp/chat/ventas.csv", bytes: 120 }],
  turns: [
    { role: "user", content: "Resume el CSV", createdAt: "2026-09-28T11:00:00Z" },
    {
      role: "assistant",
      content: "Hecho. Ver el archivo.",
      createdAt: "2026-09-28T11:01:00Z",
      provider: "claude",
      model: "sonnet",
      outputs: ["informe.xlsx"],
      trace: [
        { stream: "stdout", text: "⏵ Read: ventas.csv" },
        { stream: "stdout", text: "```inside```" },
      ],
    },
    { role: "user", content: "¿Y por región?" },
    { role: "assistant", content: "QUOTA_EXCEEDED::You've hit your session limit · resets 12am", isError: true },
    { role: "assistant", content: "", isCancelled: true },
  ],
};

describe("conversationToMarkdown", () => {
  const markdown = conversationToMarkdown(conversation, labels);

  it("opens with the title, the repository and the attachments by path", () => {
    expect(markdown.startsWith("# Informe de ventas\n")).toBe(true);
    expect(markdown).toContain("- Repositorio: api");
    expect(markdown).toContain("  - ventas.csv — `/tmp/chat/ventas.csv`");
  });

  it("writes each turn under who said it, with the engine and the files it wrote", () => {
    expect(markdown).toContain("## Tú · 2026-09-28 11:00 UTC");
    expect(markdown).toContain("## Asistente · claude · sonnet · 2026-09-28 11:01 UTC");
    expect(markdown).toContain("Archivos generados:\n- `informe.xlsx`");
  });

  it("keeps a failure readable — without the app's marker — and a stop as a stop", () => {
    expect(markdown).toContain("> **Error:** You've hit your session limit · resets 12am");
    expect(markdown).not.toContain("QUOTA_EXCEEDED::");
    expect(markdown).toContain("_Detenido_");
  });

  it("folds the process under a fence nothing inside can close", () => {
    expect(markdown).toContain("<details><summary>Proceso · 2 pasos</summary>");
    expect(markdown).toContain("````\n⏵ Read: ventas.csv\n```inside```\n````");
  });

  it("leaves the process out when it was not asked for", () => {
    const light = conversationToMarkdown(
      { ...conversation, turns: conversation.turns.map(({ trace: _dropped, ...turn }) => turn) },
      labels,
    );
    expect(light).not.toContain("<details>");
  });
});

describe("conversationToJson", () => {
  it("is data with English keys, markers stripped, traces only when present", () => {
    const parsed = JSON.parse(conversationToJson(conversation));
    expect(parsed.title).toBe("Informe de ventas");
    expect(parsed.attachments[0].path).toBe("/tmp/chat/ventas.csv");
    expect(parsed.turns[1]).toMatchObject({ role: "assistant", provider: "claude", outputs: ["informe.xlsx"] });
    expect(parsed.turns[1].trace).toHaveLength(2);
    expect(parsed.turns[0].trace).toBeUndefined();
    expect(parsed.turns[3].content).toBe("You've hit your session limit · resets 12am");
    expect(parsed.turns[4].isCancelled).toBe(true);
  });
});

describe("exportFileName", () => {
  it("is a name every platform accepts", () => {
    expect(exportFileName("Informe: ventas/2026?", "markdown")).toBe("Informe ventas 2026.md");
    expect(exportFileName("   ", "json")).toBe("conversation.json");
    expect(exportFileName("fin.", "json")).toBe("fin.json");
    expect(exportFileName("x".repeat(200), "markdown")).toHaveLength(83);
  });
});
