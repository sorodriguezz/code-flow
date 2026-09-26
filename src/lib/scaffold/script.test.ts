import { describe, expect, it } from "vitest";
import { buildScript, previewStep, quote } from "./script";

const LABELS = { skipped: "skipped", done: "Done" };

describe("quote", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(quote("sh", "create-vite@9.2.1")).toBe("create-vite@9.2.1");
    expect(quote("sh", "my app")).toBe("'my app'");
    expect(quote("sh", "it's")).toBe(`'it'\\''s'`);
    expect(quote("sh", "$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(quote("ps", "it's")).toBe("'it''s'");
    expect(quote("ps", "C:\\Users\\me")).toBe("'C:\\Users\\me'");
  });
});

describe("buildScript", () => {
  it("writes an argv step, its directory and its banner for sh", () => {
    const script = buildScript(
      "sh",
      [{ title: "Create", cwd: "/tmp/my projects", argv: ["npx", "--yes", "create-vite@9", "app"] }],
      LABELS,
    );
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(script).toContain("cf_step Create");
    expect(script).toContain("cd '/tmp/my projects' && npx --yes create-vite@9 app");
    expect(script.trimEnd().endsWith("Done")).toBe(true);
  });

  it("wraps an optional step so its failure is reported and skipped", () => {
    const sh = buildScript("sh", [{ title: "Commit", argv: ["git", "commit", "-m", "Initial commit"], optional: true }], LABELS);
    expect(sh).toContain("{ git commit -m 'Initial commit'; } || cf_skip skipped");
    const ps = buildScript("ps", [{ title: "Commit", argv: ["git", "commit"], optional: true }], LABELS);
    expect(ps).toContain("try { & 'git' 'commit'; Cf-Throw } catch { Cf-Skip 'skipped' }");
  });

  it("checks every native command's exit code on PowerShell", () => {
    const ps = buildScript("ps", [{ title: "Install", cwd: "C:\\p", argv: ["npm", "install"] }], LABELS);
    expect(ps).toContain("Set-Location -LiteralPath 'C:\\p'; & 'npm' 'install'; Cf-Check");
  });

  it("uses a step's raw line for the shell it is running in", () => {
    const step = { title: "Freeze", sh: ".venv/bin/pip freeze > requirements.txt", ps: "pip freeze | Out-File requirements.txt" };
    expect(buildScript("sh", [step], LABELS)).toContain(".venv/bin/pip freeze > requirements.txt");
    expect(buildScript("ps", [step], LABELS)).toContain("pip freeze | Out-File requirements.txt");
    expect(previewStep("ps", { title: "x", argv: ["npm", "i"] })).toBe("& 'npm' 'i'");
  });

  it("sets a step's variables for its program only", () => {
    const step = { title: "ng", argv: ["npx", "ng", "new"], env: { NG_CLI_ANALYTICS: "false", "bad name": "x" } };
    expect(buildScript("sh", [step], LABELS)).toContain("NG_CLI_ANALYTICS=false npx ng new");
    expect(buildScript("ps", [step], LABELS)).toContain("$env:NG_CLI_ANALYTICS = 'false'; & 'npx' 'ng' 'new'; Cf-Check");
  });
});

describe.skipIf(process.platform === "win32")("the sh script, actually run", () => {
  it("steps over an optional failure and stops at a required one", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "cf-script-"));
    const run = (steps: Parameters<typeof buildScript>[1]) => {
      const file = join(dir, "s.sh");
      writeFileSync(file, buildScript("sh", steps, LABELS));
      try {
        return { code: 0, out: execFileSync("/bin/sh", [file], { cwd: dir, encoding: "utf8" }) };
      } catch (e) {
        const error = e as { status: number; stdout: string };
        return { code: error.status, out: error.stdout };
      }
    };

    const tolerant = run([
      { title: "may fail", argv: ["false"], optional: true },
      { title: "then this", cwd: dir, argv: ["sh", "-c", "echo reached > marker"] },
    ]);
    expect(tolerant.code).toBe(0);
    expect(tolerant.out).toContain("(skipped)");
    expect(tolerant.out).toContain("Done");

    const strict = run([
      { title: "fails", argv: ["sh", "-c", "exit 3"] },
      { title: "never", argv: ["sh", "-c", "echo nope"] },
    ]);
    expect(strict.code).toBe(3);
    expect(strict.out).not.toContain("nope");
    rmSync(dir, { recursive: true, force: true });
  });
});
