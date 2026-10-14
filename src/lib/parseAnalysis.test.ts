import { describe, expect, it } from "vitest";
import {
  buildFixpack,
  computeQualityGatePassed,
  formatFindingAsComment,
  formatSummaryComment,
  locationLabel,
  parseAnalysis,
  type SummaryMemory,
} from "./parseAnalysis";

/**
 * The review format is a contract between three readers: this parser, the backend's
 * (`review::merge::parse`) and the renderer that writes it (`review::render`). The report below is
 * what `review_markdown` produces — the same headings, the same field markers, the same footer — so
 * a change on either side that breaks the other shows up here.
 */
const REPORT = `📈 CALIDAD: Fiabilidad=D Seguridad=A Mantenibilidad=B

🚦 Quality Gate: ❌ FAILED
🔍 Alcance: 3 archivo(s) · +40 −5 · nivel completo · lentes correctness,security

Resumen del cambio: agrega el pago con tarjeta.

### 🚨 [Crítico · Bug] null-dereference · F-001

Se accede a \`cuenta.saldo\` sin verificar que exista.

📍 Ubicación: src/services/pago.ts:42-50

💭 Por qué: \`buscarCuenta\` retorna null cuando el id no existe.

💡 Sugerencia: Guarda temprano y retorna 404.

🛠️ Ejemplo de solución:
\`\`\`ts
if (!cuenta) return res.status(404).end();
\`\`\`

🎯 Confianza: 85/100

---

### ⚠️ [Mayor · Code Smell] null-dereference · F-002

El mismo patrón, más abajo en el archivo.

📍 Ubicación: \`src/services/pago.ts:480\`

💭 Por qué: La respuesta del proveedor puede venir vacía.

💡 Sugerencia: Valida antes de leer.

🎯 Confianza: 70/100

---

### ℹ️ [Menor · Code Smell] naming · F-003

Nombre poco claro.

💭 Por qué: \`x\` no dice nada.

💡 Sugerencia: Renómbralo.

---
🤖 Revisado con Claude (claude-sonnet)`;

describe("parseAnalysis", () => {
  const parsed = parseAnalysis(REPORT);

  it("reads the grades line and keeps the prose before the first finding", () => {
    expect(parsed.grades).toEqual({ reliability: "D", security: "A", maintainability: "B" });
    expect(parsed.summary).toContain("Resumen del cambio");
    expect(parsed.summary).not.toContain("📈");
    expect(parsed.summary).not.toContain("F-001");
  });

  it("splits the footer off the last finding", () => {
    expect(parsed.footer).toBe("🤖 Revisado con Claude (claude-sonnet)");
    expect(parsed.findings[2].suggestion).not.toContain("🤖");
  });

  it("reads every finding with its own id, even two of one category in one file", () => {
    expect(parsed.findings.map((f) => f.id)).toEqual(["F-001", "F-002", "F-003"]);
    expect(parsed.findings.map((f) => f.category)).toEqual(["null-dereference", "null-dereference", "naming"]);
    expect(parsed.findings.map((f) => f.severity)).toEqual(["critical", "warning", "info"]);
  });

  it("reads each field of a finding", () => {
    const [first] = parsed.findings;
    expect(first.type).toBe("Bug");
    expect(first.subtitle).toBe("Se accede a `cuenta.saldo` sin verificar que exista.");
    expect(first.location).toEqual({ file: "src/services/pago.ts", startLine: 42, endLine: 50 });
    expect(first.why).toBe("`buscarCuenta` retorna null cuando el id no existe.");
    expect(first.suggestion).toBe("Guarda temprano y retorna 404.");
    expect(first.exampleLang).toBe("ts");
    expect(first.exampleCode).toContain("status(404)");
    expect(first.confidence).toBe(85);
  });

  /** The model wraps paths in Markdown everywhere; a location that parses to nothing would silently
   * post an unanchored comment. */
  it("reads a location wrapped in backticks, and a single line", () => {
    expect(parsed.findings[1].location).toEqual({ file: "src/services/pago.ts", startLine: 480, endLine: 480 });
  });

  it("leaves a finding with no location or confidence unanchored rather than guessing", () => {
    expect(parsed.findings[2].location).toBeNull();
    expect(parsed.findings[2].confidence).toBeNull();
  });

  it("falls back to the whole text when nothing matches the format", () => {
    const loose = parseAnalysis("Todo se ve bien ✅");
    expect(loose.findings).toEqual([]);
    expect(loose.summary).toBe("Todo se ve bien ✅");
    expect(loose.grades).toBeNull();
    expect(loose.footer).toBeNull();
  });

  /** The heading is only a finding when it carries its id — the Rust parser is laxer on purpose
   * (it assigns ids itself); a report that reaches this one has been rendered with them. */
  it("does not take a heading without an id for a finding", () => {
    expect(parseAnalysis("### 🚨 [Crítico · Bug] npe\n\nsub").findings).toEqual([]);
  });
});

describe("the comment a finding is published as", () => {
  const [first] = parseAnalysis(REPORT).findings;

  it("mirrors the backend's comment_markdown: heading with the id, no location line", () => {
    const body = formatFindingAsComment(first);
    expect(body.startsWith("### 🚨 [Bug] null-dereference · F-001")).toBe(true);
    expect(body).toContain("💭 **Por qué:** `buscarCuenta` retorna null");
    expect(body).toContain("💡 **Sugerencia:** Guarda temprano");
    expect(body).toContain("🎯 Confianza: 85/100");
    expect(body).not.toContain("📍");
  });

  it("labels a location the way the review writes it", () => {
    expect(locationLabel({ file: "a.ts", startLine: 4, endLine: 4 })).toBe("a.ts:4");
    expect(locationLabel({ file: "a.ts", startLine: 4, endLine: 9 })).toBe("a.ts:4-9");
  });
});

describe("the summary comment", () => {
  const parsed = parseAnalysis(REPORT);

  it("judges the gate on the whole review, not on what was ticked", () => {
    expect(computeQualityGatePassed(parsed.findings)).toBe(false);
    const onlyMinor = formatSummaryComment(parsed, "2026-09-28", [parsed.findings[2]]);
    expect(onlyMinor).toContain("❌ FAILED");
    expect(onlyMinor).toContain("1 de 3 publicado(s)");
  });

  it("lists what the memory says was resolved and discarded", () => {
    const memory: SummaryMemory = {
      all: [],
      resolved: [
        {
          id: "F-007",
          severity: "critical",
          tipo: "Bug",
          categoria: "race",
          subtitulo: "s",
          archivo: "src/a.ts",
          lineas: "3",
          confianza: 90,
          estado: "resuelto",
          introducido_en_iter: 1,
        },
      ],
      discarded: [
        {
          id: "F-008",
          severity: "info",
          tipo: "Code Smell",
          categoria: "naming",
          subtitulo: "s",
          archivo: null,
          lineas: null,
          confianza: null,
          estado: "falso_positivo",
          introducido_en_iter: 1,
          motivo_descarte: "es intencional\ny documentado",
        },
      ],
      iter: 2,
      level: "completo",
      engine: "Claude",
      model: "claude-sonnet",
      files: 3,
      additions: 40,
      deletions: 5,
    };
    const body = formatSummaryComment(parsed, "2026-09-28", parsed.findings, memory);
    expect(body).toContain("~~F-007~~");
    expect(body).toContain("✔️ Resuelto");
    expect(body).toContain("🚫 Falso positivo — es intencional y documentado");
    expect(body).toContain("iteración 2");
  });
});

describe("severities, the gate policy and exact replacements", () => {
  const parsed = parseAnalysis(REPORT);

  it("keeps the fine severity the heading names, not just the bucket", () => {
    expect(parsed.findings.map((f) => f.severityLabel)).toEqual(["Crítico", "Mayor", "Menor"]);
    expect(parsed.findings[1].severity).toBe("warning");
  });

  /** The badge follows the policy the run was reviewed under — a gate that blocks on Mayor fails here. */
  it("judges the gate by the run's own policy", () => {
    const withoutCritical = parsed.findings.slice(1);
    expect(computeQualityGatePassed(withoutCritical)).toBe(true);
    expect(computeQualityGatePassed(withoutCritical, ["Blocker", "Crítico", "Mayor"])).toBe(false);
    expect(computeQualityGatePassed(withoutCritical, ["blocker", "major"])).toBe(false);
  });

  it("counts the published findings by their real severity", () => {
    const body = formatSummaryComment(parsed, "2026-10-14", parsed.findings);
    expect(body).toContain("1 Crítico · 1 Mayor · 1 Menor");
    expect(body).not.toMatch(/\d Info/);
  });

  const withReplacement = parseAnalysis(`### 🚨 [Crítico · Bug] npe · F-001

Se lee saldo sin validar.

📍 Ubicación: src/a.ts:4-5

💭 Por qué: puede ser null.

💡 Sugerencia: Valida antes.

✏️ Reemplazo: 4-5
\`\`\`ts
if (!c) return;
return c.saldo;
\`\`\`

🎯 Confianza: 80/100
`).findings[0];

  it("reads an exact replacement apart from the example and the suggestion", () => {
    expect(withReplacement.replacement).toEqual({ start: 4, end: 5, lang: "ts", code: "if (!c) return;\nreturn c.saldo;" });
    expect(withReplacement.exampleCode).toBe("");
    expect(withReplacement.suggestion).toBe("Valida antes.");
  });

  it("publishes it as the host's own suggestion when it can apply", () => {
    expect(formatFindingAsComment(withReplacement, "github")).toContain("```suggestion\nif (!c) return;");
    expect(formatFindingAsComment(withReplacement, "gitlab")).toContain("```suggestion:-1+0");
    expect(formatFindingAsComment(withReplacement, "azure")).toContain("Reemplazo sugerido (líneas 4-5)");
    const elsewhere = { ...withReplacement, location: { file: "src/a.ts", startLine: 9, endLine: 9 } };
    expect(formatFindingAsComment(elsewhere, "github")).not.toContain("```suggestion");
  });
});

describe("the fix-pack", () => {
  it("carries every finding under action names", () => {
    const pack = JSON.parse(buildFixpack(parseAnalysis(REPORT), 42));
    expect(pack.schema).toBe("pr-review-fixpack/v1");
    expect(pack.pr).toBe(42);
    expect(pack.hallazgos).toHaveLength(3);
    expect(pack.hallazgos[0]).toMatchObject({
      id: "F-001",
      archivo: "src/services/pago.ts",
      lineas: "42-50",
      problema: "Se accede a `cuenta.saldo` sin verificar que exista.",
      correccion: "Guarda temprano y retorna 404.",
    });
  });
});
