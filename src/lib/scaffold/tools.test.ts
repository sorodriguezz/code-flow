import { describe, expect, it } from "vitest";
import { previewStep } from "./script";
import { recipesFor, type ToolId } from "./tools";

/** Everything a recipe would run, as text. */
function commands(tool: ToolId, line: string | undefined, platform: "macos" | "linux" | "windows" = "macos") {
  const present = new Set(["brew", "fnm", "nvm", "volta", "uv", "node", "winget", "apt"]);
  return recipesFor(tool, { platform, present, line })
    .flatMap((recipe) => recipe.steps.map((step) => previewStep(platform === "windows" ? "ps" : "sh", step)))
    .join("\n");
}

describe("install recipes", () => {
  it("install the line that was picked", () => {
    expect(commands("node", "22")).toContain("fnm install 22");
    expect(commands("node", "22")).toContain("nvm install 22");
    expect(commands("java", "21")).toContain("temurin@21");
    expect(commands("python", "3.12")).toContain("uv python install 3.12");
    expect(commands("php", "8.5")).toContain("php.new/install/mac/8.5");
    expect(commands("dotnet", "9")).toContain("--channel 9.0");
  });

  /**
   * With no line (the registry was unreachable) nothing falls back to a number written here: every
   * recipe asks its installer for the current LTS or latest. A number in this file is a number that
   * goes stale — the first cut pinned nvm's installer to v0.40.3, and it was four releases old within
   * weeks.
   */
  it("never fall back to a version number of their own", () => {
    for (const tool of ["node", "java", "python", "php", "dotnet"] as ToolId[]) {
      for (const platform of ["macos", "linux", "windows"] as const) {
        const text = commands(tool, undefined, platform)
          // Not versions: a TLS protocol, a regex group, and the Windows TLS-1.2 bit flag.
          .replace(/tlsv1\.2|\\1|3072/g, "");
        expect(text, `${tool} on ${platform}`).not.toMatch(/(^|[^\w.])v?\d+\.\d+/); // 3.13, v0.40.3
        expect(text, `${tool} on ${platform}`).not.toMatch(/@\d/); // node@24, temurin@21
        expect(text, `${tool} on ${platform}`).not.toMatch(/\b(install|default|use|channel) \d/); // fnm install 24
        expect(text, `${tool} on ${platform}`).not.toMatch(/\.\d+(\.|\b)/); // Temurin.21.JDK, SDK.10
      }
    }
    expect(commands("node", undefined)).toContain("fnm install --lts");
    expect(commands("node", undefined)).toContain("nvm install --lts");
    expect(commands("dotnet", undefined)).toContain("--channel LTS");
    expect(commands("php", undefined)).toContain("php.new/install/mac)");
  });

  it("resolve nvm's installer to its newest release when the script runs", () => {
    const text = commands("node", "24");
    expect(text).toContain("api.github.com/repos/nvm-sh/nvm/releases/latest");
    expect(text).toContain("${NVM_TAG:-master}/install.sh");
    expect(text).not.toMatch(/nvm\/v\d/);
  });

  it("skip php.new for the lines it has no binaries for", () => {
    expect(commands("php", "8.3")).not.toContain("php.new");
    expect(commands("php", "8.4")).toContain("php.new/install/mac/8.4");
  });
});
