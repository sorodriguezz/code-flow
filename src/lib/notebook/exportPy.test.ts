import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNotebook } from "./nbformat";
import { commentPrefix, notebookToScript, scriptExtension } from "./exportPy";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("notebookToScript", () => {
  it("writes code as it is and Markdown as comments, in the percent format", () => {
    const doc = parseNotebook(
      JSON.stringify({
        cells: [
          { cell_type: "markdown", metadata: {}, source: ["# Título\n", "\n", "texto"] },
          { cell_type: "code", execution_count: 1, metadata: {}, outputs: [{ output_type: "stream", name: "stdout", text: "x" }], source: "%matplotlib inline\nimport pandas as pd\n!pip list\nx = 1\n" },
          { cell_type: "raw", metadata: {}, source: "raw" },
        ],
        metadata: { language_info: { name: "python", file_extension: ".py" } },
        nbformat: 4,
        nbformat_minor: 4,
      }),
    );
    expect(notebookToScript(doc)).toBe(
      "# %% [markdown]\n# # Título\n#\n# texto\n\n" +
        "# %%\n# %matplotlib inline\nimport pandas as pd\n# !pip list\nx = 1\n\n" +
        "# %% [raw]\n# raw\n",
    );
    expect(scriptExtension(doc)).toBe(".py");
  });

  it("uses the notebook language's comments and extension", () => {
    const r = parseNotebook(fixture("nbformat-4.4.ipynb"));
    expect(scriptExtension(r)).toBe(".r");
    expect(notebookToScript(r).startsWith("# %% [markdown]\n# Sin ids")).toBe(true);
    expect(commentPrefix("typescript")).toBe("//");
    expect(commentPrefix("sql")).toBe("--");
  });

  it("leaves outputs out", () => {
    const script = notebookToScript(parseNotebook(fixture("jupyter-written.ipynb")));
    expect(script).not.toContain("iVBOR");
    expect(script).not.toContain("ZeroDivisionError");
    expect(script).toContain("# %%\n1/0");
  });
});
