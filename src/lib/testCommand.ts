/**
 * The command line that runs a test file — or the one test under the caret — from the editor, in
 * the terminal dock. Pure: the editor hands in the file's path and text and what it found in the
 * nearest manifest, and gets back a working directory (relative to the repository) and a command.
 *
 * One runner per ecosystem, the way each one is run by hand: vitest / jest / the `test` script for
 * JavaScript and TypeScript, pytest, `go test`, `cargo test`, Maven or Gradle, `dotnet test`. Nothing
 * here installs anything: a runner the project does not have fails in the terminal, where the user
 * can read why.
 */

export type TestLanguage = "js" | "python" | "go" | "rust" | "java" | "kotlin" | "csharp";

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const PY_TEST = /(^|\/)test_[^/]*\.py$|_test\.py$/i;
const GO_TEST = /_test\.go$/;
const JAVA_TEST = /(Test|Tests|IT)\.java$/;
const KOTLIN_TEST = /(Test|Tests)\.kt$/;
const CS_TEST = /Tests?\.cs$/;

/** Which runner family a file belongs to, or `null` when it is not a test file. A Rust file is one
 *  when it lives under `tests/` or declares a `#[test]`. */
export function testLanguageOf(path: string, text: string): TestLanguage | null {
  if (JS_TEST.test(path)) return "js";
  if (PY_TEST.test(path)) return "python";
  if (GO_TEST.test(path)) return "go";
  if (path.endsWith(".rs") && (/(^|\/)tests\//.test(path) || /#\[(tokio::)?test\]/.test(text))) return "rust";
  if (JAVA_TEST.test(path)) return "java";
  if (KOTLIN_TEST.test(path)) return "kotlin";
  if (CS_TEST.test(path)) return "csharp";
  return null;
}

/** The manifest that decides how a file's tests run — looked for from the file's folder upward. */
export function manifestNamesFor(language: TestLanguage): string[] {
  switch (language) {
    case "js":
      return ["package.json"];
    case "python":
      return ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"];
    case "go":
      return ["go.mod"];
    case "rust":
      return ["Cargo.toml"];
    case "java":
    case "kotlin":
      return ["pom.xml", "build.gradle.kts", "build.gradle"];
    case "csharp":
      return [];
  }
}

/** The test enclosing `line` (1-based) — the nearest declaration at or above it. */
export function testNameAt(language: TestLanguage, text: string, line: number): string | null {
  const lines = text.split(/\r\n|\r|\n/).slice(0, Math.max(0, line));
  const patterns: Record<TestLanguage, RegExp> = {
    js: /\b(?:it|test|describe)(?:\.(?:only|skip|each\([^)]*\)|concurrent))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/,
    python: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
    go: /^func\s+(Test\w+)\s*\(/,
    rust: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/,
    java: /^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?void\s+(\w+)\s*\(/,
    kotlin: /^\s*fun\s+`?([^`(]+)`?\s*\(/,
    csharp: /^\s*public\s+(?:async\s+)?(?:void|Task)\s+(\w+)\s*\(/,
  };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = patterns[language].exec(lines[i]);
    if (match) return language === "js" ? match[2] : match[1];
  }
  return null;
}

/** Every test a file declares, in order — the Tests view's rows under a file. Not nested `describe`
 *  blocks for JavaScript: their tests are listed flat, as a runner's `-t` filter reaches them. */
export function testNamesIn(language: TestLanguage, text: string): { name: string; line: number }[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: { name: string; line: number }[] = [];
  const declares: Record<TestLanguage, RegExp> = {
    js: /\b(?:it|test)(?:\.(?:only|skip|concurrent|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/,
    python: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
    go: /^func\s+(Test\w+)\s*\(/,
    rust: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/,
    java: /^\s*(?:public\s+|protected\s+)?void\s+(\w+)\s*\(/,
    kotlin: /^\s*fun\s+`?([^`(]+)`?\s*\(/,
    csharp: /^\s*public\s+(?:async\s+)?(?:void|Task)\s+(\w+)\s*\(/,
  };
  // Rust, Java, Kotlin and C# mark a test with an attribute or annotation on the lines above it.
  const marked: Partial<Record<TestLanguage, RegExp>> = {
    rust: /#\[(?:tokio::)?test\b/,
    java: /@(?:Test|ParameterizedTest|RepeatedTest)\b/,
    kotlin: /@Test\b/,
    csharp: /\[(?:Fact|Theory|Test|TestMethod|TestCase)\b/,
  };
  lines.forEach((line, i) => {
    const match = declares[language].exec(line);
    if (!match) return;
    const mark = marked[language];
    if (mark && !lines.slice(Math.max(0, i - 4), i).some((above) => mark.test(above))) return;
    out.push({ name: language === "js" ? match[2] : match[1], line: i + 1 });
  });
  return out;
}

/** Python's own test class around the caret, for pytest's `file::Class::test`. */
function pythonClassAt(text: string, line: number): string | null {
  const lines = text.split(/\r\n|\r|\n/).slice(0, line);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^class\s+(\w+)/.exec(lines[i]);
    if (match) return match[1];
    // Back at the module's left edge without a class: the test is a plain function.
    if (/^(?:async\s+)?def\s/.test(lines[i])) return null;
  }
  return null;
}

/**
 * A test name as a runner's `-t` regex that needs no escaping in any shell: every character a regex
 * or a shell would read specially becomes `.`, which matches it. The terminal's shell is whatever the
 * user picked — Git Bash by default on Windows, but PowerShell or cmd as easily — and those three
 * escape differently, so nothing here relies on escaping at all.
 */
function safeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\"`'%!]/g, ".");
}

/** Double quotes, which bash, zsh, PowerShell and cmd all read the same way — for text with none of
 *  `"`, `$`, `` ` `` or `%` in it (see `safeRegex`; paths with them are not worth the escaping). */
function quote(text: string): string {
  return `"${text}"`;
}

export interface TestRunInput {
  language: TestLanguage;
  /** The file, relative to the repository. */
  path: string;
  text: string;
  /** The folder of the manifest found (relative to the repository, `""` for its root), and the
   *  manifest's name and text — or `null` when none was found. */
  manifest: { dir: string; name: string; text: string } | null;
  /** The JavaScript package manager the editor already settled on for the repository. */
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  windows: boolean;
  /** Run only the test enclosing this line (1-based). */
  line?: number;
}

export interface TestRun {
  /** Relative to the repository. */
  cwd: string;
  command: string;
  /** What the terminal tab is called. */
  title: string;
}

function relativeTo(dir: string, path: string): string {
  return dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.[^.]+$/, "");
}

const EXEC: Record<TestRunInput["packageManager"], string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };

/** The command for `input`, or `null` when the file's ecosystem has no runner this can name. */
export function testCommand(input: TestRunInput): TestRun | null {
  const { language, path, text, manifest, windows } = input;
  const name = input.line ? testNameAt(language, text, input.line) : null;
  const file = path.slice(path.lastIndexOf("/") + 1);
  const title = name ? `${file} · ${name}` : file;
  switch (language) {
    case "js": {
      const dir = manifest?.dir ?? "";
      const rel = relativeTo(dir, path);
      const pkg = manifest?.text ?? "";
      const filter = name ? ` -t ${quote(safeRegex(name))}` : "";
      if (/"vitest"/.test(pkg)) return { cwd: dir, command: `${EXEC[input.packageManager]} vitest run ${quote(rel)}${filter}`, title };
      if (/"jest"/.test(pkg)) return { cwd: dir, command: `${EXEC[input.packageManager]} jest ${quote(rel)}${filter}`, title };
      if (/"test"\s*:/.test(pkg)) {
        const run = input.packageManager === "npm" ? "npm test --" : `${input.packageManager} test`;
        return { cwd: dir, command: `${run} ${quote(rel)}${filter}`, title };
      }
      return null;
    }
    case "python": {
      const python = windows ? "python" : "python3";
      const cls = name ? pythonClassAt(text, input.line ?? 0) : null;
      const target = name ? `${path}${cls ? `::${cls}` : ""}::${name}` : path;
      return { cwd: "", command: `${python} -m pytest ${quote(target)}`, title };
    }
    case "go": {
      const dir = manifest?.dir ?? "";
      const pkgDir = relativeTo(dir, dirOf(path));
      const target = pkgDir ? `./${pkgDir}` : ".";
      // Quoted for cmd, where a bare `^` is its escape character.
      const run = name ? ` -run ${quote(`^${name}$`)}` : "";
      return { cwd: dir, command: `go test ${target}${run}`, title };
    }
    case "rust": {
      const dir = manifest?.dir ?? "";
      const rel = relativeTo(dir, path);
      // An integration test file is its own target; anything else is filtered by name.
      const integration = /^tests\/[^/]+\.rs$/.test(rel) ? ` --test ${baseName(rel)}` : "";
      return { cwd: dir, command: `cargo test${integration}${name ? ` ${name}` : ""}`, title };
    }
    case "java":
    case "kotlin": {
      const dir = manifest?.dir ?? "";
      const cls = baseName(path);
      if (manifest?.name === "pom.xml") {
        return { cwd: dir, command: `mvn -q test ${quote(`-Dtest=${cls}${name ? `#${name}` : ""}`)}`, title };
      }
      if (manifest) {
        // `./gradlew.bat` runs from Git Bash and PowerShell alike, Windows' two usual shells.
        const gradlew = windows ? "./gradlew.bat" : "./gradlew";
        return { cwd: dir, command: `${gradlew} test --tests ${quote(`*${cls}${name ? `.${name}` : ""}`)}`, title };
      }
      return null;
    }
    case "csharp": {
      const cls = baseName(path);
      return { cwd: dirOf(path), command: `dotnet test --filter ${quote(`FullyQualifiedName~${cls}${name ? `.${name}` : ""}`)}`, title };
    }
  }
}
