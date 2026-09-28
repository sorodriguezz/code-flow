import { cellSource, cellType, notebookFileExtension, notebookLanguage, type NotebookDoc } from "./nbformat";

/**
 * A notebook as a script, in the "percent" format (`# %%` between cells) that VS Code, Spyder,
 * PyCharm and Jupytext all read back as cells: code as it is, Markdown as comments under
 * `# %% [markdown]`. Outputs are not part of a script.
 *
 * In a Python notebook, IPython's own syntax — `%matplotlib inline`, `!pip install …` — is commented
 * out rather than left to break the file, the way Jupytext writes it.
 */

/** The line-comment marker of the notebook's language. */
export function commentPrefix(language: string): string {
  const lang = language.toLowerCase();
  if (["javascript", "typescript", "java", "scala", "kotlin", "c", "c++", "cpp", "csharp", "c#", "go", "rust", "swift", "dart", "groovy"].includes(lang)) {
    return "//";
  }
  if (["sql", "haskell", "lua", "ada"].includes(lang)) return "--";
  if (["matlab", "octave", "erlang", "prolog"].includes(lang)) return "%";
  return "#";
}

/** The script's extension: the kernel's own, else by language, else `.py`. */
export function scriptExtension(doc: NotebookDoc): string {
  const fromKernel = notebookFileExtension(doc);
  if (fromKernel) return fromKernel;
  const byLanguage: Record<string, string> = {
    python: ".py",
    r: ".r",
    julia: ".jl",
    javascript: ".js",
    typescript: ".ts",
    scala: ".scala",
    rust: ".rs",
    go: ".go",
  };
  return byLanguage[notebookLanguage(doc)] ?? ".py";
}

function commented(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `${prefix} ${line}` : prefix))
    .join("\n");
}

export function notebookToScript(doc: NotebookDoc): string {
  const language = notebookLanguage(doc);
  const prefix = commentPrefix(language);
  const python = language === "python";
  const blocks: string[] = [];
  for (const cell of doc.cells) {
    const source = cellSource(cell).replace(/\s+$/, "");
    const type = cellType(cell);
    if (type === "code") {
      const body = python
        ? source
            .split("\n")
            .map((line) => (/^\s*[%!]/.test(line) ? `# ${line}` : line))
            .join("\n")
        : source;
      blocks.push(`${prefix} %%\n${body}`);
    } else if (type === "markdown") {
      blocks.push(`${prefix} %% [markdown]\n${commented(source, prefix)}`);
    } else {
      blocks.push(`${prefix} %% [raw]\n${commented(source, prefix)}`);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}
