import { describe, expect, it } from "vitest";
import { valueKind } from "./debugValue";
import { namesIn } from "./useDebugEditorValues";

describe("valueKind", () => {
  it("reads the kind off a debugger's preview text", () => {
    expect(valueKind('"18019701-K"')).toBe("string");
    expect(valueKind("42")).toBe("number");
    expect(valueKind("-3.5e2")).toBe("number");
    expect(valueKind("true")).toBe("boolean");
    expect(valueKind("null")).toBe("nullish");
    expect(valueKind("undefined")).toBe("nullish");
    expect(valueKind("class PacienteService")).toBe("function");
    expect(valueKind("(getter)")).toBe("accessor");
    expect(valueKind("Object")).toBe("object");
    expect(valueKind("Array(3)")).toBe("object");
  });
});

describe("namesIn", () => {
  it("takes the names a line uses, not properties, strings or keywords", () => {
    expect(namesIn("    if (cachedPaciente) return cachedPaciente;")).toEqual(["cachedPaciente"]);
    expect(namesIn("const paciente = await this._mpi.findByDocumento(documento);")).toEqual(["paciente", "this", "documento"]);
    expect(namesIn("`${documento.tipoDocumento}:${x}` // documento")).toEqual([]);
  });
});
