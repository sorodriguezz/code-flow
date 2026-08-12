const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  cs: "csharp",
  // Two ids because the two dialects have different top levels — a class body is declarations, a
  // routine is statements. `.cls` deliberately displaces Monaco's Apex claim on the extension; every
  // editor in the app passes `language` explicitly, so which one wins is decided here and nowhere
  // else. See `monacoObjectScript`.
  cls: "objectscript-class",
  inc: "objectscript",
  mac: "objectscript",
  int: "objectscript",
  rb: "ruby",
  php: "php",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  xml: "xml",
  dockerfile: "dockerfile",
};

export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}
