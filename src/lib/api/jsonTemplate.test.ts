import { describe, expect, it } from "vitest";
import { checkJsonTemplate, formatJsonTemplate } from "./jsonTemplate";

describe("raw JSON templates", () => {
  it("accepts raw and quoted variables and keeps both when formatted", () => {
    const source = '{"contadores":{{ contadores }},"fechaHora":"{{fechaHora}}","filas":[{{fila}},true]}';
    const result = checkJsonTemplate(source);
    expect(result).toEqual({ hasVariables: true, error: null, offset: 0 });
    const formatted = formatJsonTemplate(source, result.hasVariables);
    expect(formatted).toContain('\n  "contadores": {{ contadores }},');
    expect(formatted).toContain('"fechaHora": "{{fechaHora}}"');
    expect(formatted).toContain("{{fila}}");
    expect(checkJsonTemplate(formatted).error).toBeNull();
  });

  it("does not treat a variable after an escaped quote as a raw value", () => {
    expect(checkJsonTemplate(String.raw`{"text":"say \"hi\" to {{name}}", "data": {{data}}}`).error).toBeNull();
  });

  it("reports actual syntax errors at their original offsets", () => {
    const source = '{"data": {{data}}, "missing" true}';
    const result = checkJsonTemplate(source);
    expect(result.hasVariables).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.offset).toBe(source.indexOf("true"));
  });

  it("rejects incomplete tokens and trailing commas", () => {
    expect(checkJsonTemplate('{"data": {{data} }').error).toBeTruthy();
    expect(checkJsonTemplate('{"data": {{data}},}').error).toBeTruthy();
  });
});
