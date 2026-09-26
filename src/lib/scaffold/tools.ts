import type { ScaffoldPlatform, VersionSource } from "./api";
import type { Step } from "./script";
import type { Dialect } from "./semver";

/**
 * The toolchains a template can need, and how each one gets installed.
 *
 * **Installing is a command the user sees and runs.** Every recipe below is a step for the same
 * on-screen terminal the templates run in, shown in full before it runs. Nothing here edits a shell
 * profile, touches `PATH` or elevates on its own: where a package manager needs a password (a JDK's
 * installer, `apt`), it asks for it in that terminal, and the user types it there.
 *
 * **Version managers first.** On a machine that already uses fnm, nvm or Volta, installing Node
 * through Homebrew would put a second, competing `node` on the `PATH`, and which one wins would
 * depend on the order of lines in a profile. So the recipes are listed in the order they should be
 * preferred, and the first one whose manager is present is the default: the tool the user already
 * manages versions with, then the platform's package manager, then the vendor's own installer.
 */

export type ToolId =
  | "node"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "java"
  | "go"
  | "python"
  | "uv"
  | "php"
  | "composer"
  | "dotnet"
  | "cargo"
  | "git";

export interface ToolInfo {
  id: ToolId;
  name: string;
  /** A key in `SCAFFOLD_LOGOS`; the tool's initial is drawn when it has none. */
  logo?: string;
  /** How a requirement on this tool is written by the registry it comes from. */
  dialect: Dialect;
  /** Where installable versions come from. Absent: only "the latest" can be installed. */
  versions?: VersionSource;
  /** The vendor's own install page, for when no recipe applies. */
  homepage: string;
}

export const TOOLS: Record<ToolId, ToolInfo> = {
  node: {
    id: "node",
    name: "Node.js",
    logo: "node",
    dialect: "npm",
    versions: { kind: "runtime", product: "nodejs" },
    homepage: "https://nodejs.org/en/download",
  },
  npm: { id: "npm", name: "npm", logo: "npm", dialect: "npm", homepage: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm" },
  pnpm: { id: "pnpm", name: "pnpm", logo: "pnpm", dialect: "npm", homepage: "https://pnpm.io/installation" },
  yarn: { id: "yarn", name: "Yarn", logo: "yarn", dialect: "npm", homepage: "https://yarnpkg.com/getting-started/install" },
  bun: { id: "bun", name: "Bun", logo: "bun", dialect: "npm", homepage: "https://bun.sh/docs/installation" },
  java: {
    id: "java",
    name: "Java (JDK)",
    logo: "java",
    dialect: "npm",
    versions: { kind: "runtime", product: "eclipse-temurin" },
    homepage: "https://adoptium.net/temurin/releases/",
  },
  go: {
    id: "go",
    name: "Go",
    logo: "go",
    dialect: "npm",
    homepage: "https://go.dev/dl/",
  },
  python: {
    id: "python",
    name: "Python",
    logo: "python",
    dialect: "pep440",
    versions: { kind: "runtime", product: "python" },
    homepage: "https://www.python.org/downloads/",
  },
  uv: { id: "uv", name: "uv", dialect: "npm", homepage: "https://docs.astral.sh/uv/getting-started/installation/" },
  php: {
    id: "php",
    name: "PHP",
    logo: "php",
    dialect: "composer",
    versions: { kind: "runtime", product: "php" },
    homepage: "https://php.new",
  },
  composer: { id: "composer", name: "Composer", dialect: "composer", homepage: "https://getcomposer.org/download/" },
  dotnet: {
    id: "dotnet",
    name: ".NET SDK",
    logo: "dotnet",
    dialect: "npm",
    versions: { kind: "runtime", product: "dotnet" },
    homepage: "https://dotnet.microsoft.com/download",
  },
  cargo: { id: "cargo", name: "Rust (cargo)", logo: "rust", dialect: "npm", homepage: "https://rustup.rs" },
  git: { id: "git", name: "Git", logo: "git", dialect: "npm", homepage: "https://git-scm.com/downloads" },
};

/** The managers a recipe can go through. Probed with the tools, never required by a template. */
export const MANAGER_IDS = ["brew", "winget", "fnm", "nvm", "volta", "apt", "dnf", "pacman"] as const;

/** Everything one detection pass asks about. */
export const DETECT_IDS: string[] = [...(Object.keys(TOOLS) as ToolId[]), ...MANAGER_IDS];

export interface InstallContext {
  platform: ScaffoldPlatform;
  /** Ids of the tools and managers found on this machine. */
  present: Set<string>;
  /** The version line to install — `24`, `21`, `3.13` — for a tool that has lines. Absent (the
   *  registry could not be reached), every recipe asks its installer for the current LTS or latest
   *  instead of a number of ours: a version written here would be the wrong one within months. */
  line?: string;
  /** Whether that line is an LTS, for the one installer (winget's Node) that can only say "LTS". */
  lts?: boolean;
}

export interface Recipe {
  /** Stable, for remembering the user's choice. */
  id: string;
  /** What it goes through, as named in the picker: "fnm", "Homebrew", "winget", "script". */
  label: string;
  steps: Step[];
  /** Whether it may stop to ask for the user's password. */
  sudo?: boolean;
}

const WINGET_ACCEPT = ["--accept-source-agreements", "--accept-package-agreements"];

function winget(id: string): Step {
  return { title: `winget ${id}`, argv: ["winget", "install", "--exact", "--id", id, ...WINGET_ACCEPT] };
}

/** A Homebrew formula that exists versioned (`node@22`) for older lines and unversioned for the newest. */
function brewVersioned(formula: string, line: string, cask = false): Step {
  const kind = cask ? "--cask" : "--formula";
  const install = cask ? "brew install --cask" : "brew install";
  const link = cask ? "" : ` && brew link --overwrite --force ${formula}@${line}`;
  return {
    title: `Homebrew ${formula}@${line}`,
    sh: `if brew info ${kind} ${formula}@${line} >/dev/null 2>&1; then ${install} ${formula}@${line}${link}; else ${install} ${formula}; fi`,
  };
}

function sudoLinux(present: Set<string>, packages: { apt?: string; dnf?: string; pacman?: string }): Recipe[] {
  const recipes: Recipe[] = [];
  if (present.has("apt") && packages.apt)
    recipes.push({
      id: "apt",
      label: "apt",
      sudo: true,
      steps: [{ title: "apt", sh: `sudo apt-get update && sudo apt-get install -y ${packages.apt}` }],
    });
  if (present.has("dnf") && packages.dnf)
    recipes.push({ id: "dnf", label: "dnf", sudo: true, steps: [{ title: "dnf", sh: `sudo dnf install -y ${packages.dnf}` }] });
  if (present.has("pacman") && packages.pacman)
    recipes.push({
      id: "pacman",
      label: "pacman",
      sudo: true,
      steps: [{ title: "pacman", sh: `sudo pacman -S --noconfirm ${packages.pacman}` }],
    });
  return recipes;
}

/** Only digits and dots reach a command line: a version line comes from a registry, but is checked
 *  anyway. `null` means "whatever is current" — see `InstallContext.line`. */
function safeLine(line: string | undefined): string | null {
  return line && /^[0-9.]+$/.test(line) ? line : null;
}

/**
 * nvm's own installer, always its newest release.
 *
 * nvm publishes no "latest" URL — its README pins a tag, and a tag pinned here went stale within
 * weeks (v0.40.3 in the first cut; v0.40.8 by the time anyone asked). So the tag is asked of GitHub
 * when the script runs, and `master` — whose installer points at the newest release too — stands in
 * if the API does not answer (offline, or its 60-an-hour anonymous limit).
 */
const NVM_INSTALL =
  "NVM_TAG=$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest | sed -n 's/.*\"tag_name\": *\"\\([^\"]*\\)\".*/\\1/p' | head -n 1); " +
  'curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG:-master}/install.sh" | bash';

/**
 * The ways `tool` can be installed here, most preferred first. Empty when nothing applies — the panel
 * then offers the vendor's page instead.
 */
export function recipesFor(tool: ToolId, ctx: InstallContext): Recipe[] {
  const { platform, present } = ctx;
  const unix = platform !== "windows";
  const has = (id: string) => present.has(id);
  const recipes: Recipe[] = [];

  switch (tool) {
    case "node": {
      const line = safeLine(ctx.line);
      // Without a line, each manager's own word for "the current LTS".
      const nvmUse = line ? `nvm install ${line} && nvm alias default ${line}` : "nvm install --lts && nvm alias default 'lts/*'";
      if (has("fnm"))
        recipes.push({
          id: "fnm",
          label: "fnm",
          steps: line
            ? [
                { title: `fnm install ${line}`, argv: ["fnm", "install", line] },
                { title: `fnm default ${line}`, argv: ["fnm", "default", line] },
              ]
            : [
                { title: "fnm install --lts", argv: ["fnm", "install", "--lts"] },
                { title: "fnm default lts-latest", argv: ["fnm", "default", "lts-latest"] },
              ],
        });
      if (has("volta"))
        recipes.push({
          id: "volta",
          label: "Volta",
          steps: [{ title: `volta node${line ? `@${line}` : ""}`, argv: ["volta", "install", line ? `node@${line}` : "node"] }],
        });
      if (unix && has("nvm"))
        recipes.push({
          id: "nvm",
          label: "nvm",
          steps: [{ title: `nvm ${line ?? "--lts"}`, sh: `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh" && ${nvmUse}` }],
        });
      if (unix && has("brew"))
        recipes.push({
          id: "brew",
          label: "Homebrew",
          steps: [line ? brewVersioned("node", line) : { title: "brew node", argv: ["brew", "install", "node"] }],
        });
      if (!unix && has("winget"))
        recipes.push({ id: "winget", label: "winget", steps: [winget(ctx.lts === false ? "OpenJS.NodeJS" : "OpenJS.NodeJS.LTS")] });
      if (unix)
        recipes.push({
          id: "nvm-script",
          label: "nvm (script)",
          steps: [
            {
              title: `nvm ${line ?? "--lts"}`,
              sh: `${NVM_INSTALL} && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && ${nvmUse}`,
            },
          ],
        });
      break;
    }
    case "npm":
      // npm ships with Node; the recipe is Node's.
      return recipesFor("node", ctx);
    case "pnpm":
    case "yarn": {
      if (has("node")) recipes.push({ id: "npm", label: "npm", steps: [{ title: `npm -g ${tool}`, argv: ["npm", "install", "--global", `${tool}@latest`] }] });
      if (unix && has("brew")) recipes.push({ id: "brew", label: "Homebrew", steps: [{ title: `brew ${tool}`, argv: ["brew", "install", tool] }] });
      if (!unix && has("winget")) recipes.push({ id: "winget", label: "winget", steps: [winget(tool === "pnpm" ? "pnpm.pnpm" : "Yarn.Yarn")] });
      break;
    }
    case "bun": {
      if (has("node")) recipes.push({ id: "npm", label: "npm", steps: [{ title: "npm -g bun", argv: ["npm", "install", "--global", "bun"] }] });
      if (unix && has("brew")) recipes.push({ id: "brew", label: "Homebrew", steps: [{ title: "brew bun", argv: ["brew", "install", "oven-sh/bun/bun"] }] });
      recipes.push({
        id: "script",
        label: "bun.sh",
        steps: [{ title: "bun.sh", sh: "curl -fsSL https://bun.sh/install | bash", ps: "irm bun.sh/install.ps1 | iex" }],
      });
      break;
    }
    case "java": {
      const line = safeLine(ctx.line);
      if (platform === "macos" && has("brew"))
        recipes.push({
          id: "brew",
          label: "Homebrew (Temurin)",
          sudo: true,
          steps: [line ? brewVersioned("temurin", line, true) : { title: "brew temurin", argv: ["brew", "install", "--cask", "temurin"] }],
        });
      // winget names every JDK by its number; with no line there is nothing to ask it for.
      if (!unix && has("winget") && line)
        recipes.push({ id: "winget", label: "winget (Temurin)", steps: [winget(`EclipseAdoptium.Temurin.${line}.JDK`)] });
      if (platform === "linux")
        recipes.push(
          ...sudoLinux(
            present,
            line
              ? { apt: `openjdk-${line}-jdk`, dnf: `java-${line}-openjdk-devel`, pacman: `jdk${line}-openjdk` }
              : { apt: "default-jdk", dnf: "java-latest-openjdk-devel", pacman: "jdk-openjdk" },
          ),
        );
      break;
    }
    case "go": {
      if (unix && has("brew")) recipes.push({ id: "brew", label: "Homebrew", steps: [{ title: "brew go", argv: ["brew", "install", "go"] }] });
      if (!unix && has("winget")) recipes.push({ id: "winget", label: "winget", steps: [winget("GoLang.Go")] });
      if (platform === "linux") recipes.push(...sudoLinux(present, { apt: "golang-go", dnf: "golang", pacman: "go" }));
      break;
    }
    case "python": {
      const line = safeLine(ctx.line);
      if (has("uv"))
        recipes.push({
          id: "uv",
          label: "uv",
          steps: [{ title: `uv python ${line ?? "latest"}`, argv: ["uv", "python", "install", ...(line ? [line] : []), "--default"] }],
        });
      if (unix && has("brew"))
        recipes.push({
          id: "brew",
          label: "Homebrew",
          steps: [{ title: `brew python${line ? `@${line}` : ""}`, argv: ["brew", "install", line ? `python@${line}` : "python"] }],
        });
      if (!unix && has("winget") && line) recipes.push({ id: "winget", label: "winget", steps: [winget(`Python.Python.${line}`)] });
      if (platform === "linux")
        recipes.push(...sudoLinux(present, { apt: "python3 python3-venv python3-pip", dnf: "python3", pacman: "python" }));
      break;
    }
    case "uv": {
      if (unix && has("brew")) recipes.push({ id: "brew", label: "Homebrew", steps: [{ title: "brew uv", argv: ["brew", "install", "uv"] }] });
      if (!unix && has("winget")) recipes.push({ id: "winget", label: "winget", steps: [winget("astral-sh.uv")] });
      recipes.push({
        id: "script",
        label: "astral.sh",
        steps: [
          {
            title: "astral.sh/uv",
            sh: "curl -LsSf https://astral.sh/uv/install.sh | sh",
            ps: "irm https://astral.sh/uv/install.ps1 | iex",
          },
        ],
      });
      break;
    }
    case "php":
    case "composer": {
      const line = safeLine(ctx.line);
      // php.new is Laravel's own one-liner: PHP, Composer and the Laravel installer together, per
      // platform, with no system package manager involved. With no number it installs its current
      // default, the newest PHP it builds.
      const os = platform === "macos" ? "mac" : platform;
      const path = line ? `${os}/${line}` : os;
      // It serves its script for any number, but the binaries behind it exist from 8.4 on (8.2 and
      // 8.3 answer 403, checked 2026-09-26) — offering it for an older line is a failed install.
      if (!line || Number(line) >= 8.4) {
        recipes.push({
          id: "php.new",
          label: "php.new",
          steps: [
            {
              title: `php.new ${line ?? "latest"}`,
              sh: `/bin/bash -c "$(curl -fsSL https://php.new/install/${path})"`,
              ps:
                "Set-ExecutionPolicy Bypass -Scope Process -Force; " +
                "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; " +
                `iex ((New-Object System.Net.WebClient).DownloadString('https://php.new/install/${line ? `windows/${line}` : "windows"}'))`,
            },
          ],
        });
      }
      const brewComposer: Step = { title: "brew composer", argv: ["brew", "install", "composer"] };
      if (unix && has("brew"))
        recipes.push({
          id: "brew",
          label: "Homebrew",
          steps:
            tool === "php"
              ? [line ? brewVersioned("php", line) : { title: "brew php", argv: ["brew", "install", "php"] }, brewComposer]
              : [brewComposer],
        });
      if (platform === "linux")
        recipes.push(
          ...sudoLinux(present, {
            apt: tool === "php" ? "php-cli php-xml php-mbstring php-curl php-zip unzip composer" : "composer",
            dnf: tool === "php" ? "php-cli php-xml php-mbstring composer" : "composer",
            pacman: tool === "php" ? "php composer" : "composer",
          }),
        );
      break;
    }
    case "dotnet": {
      const line = safeLine(ctx.line);
      if (!unix && has("winget") && line) recipes.push({ id: "winget", label: "winget", steps: [winget(`Microsoft.DotNet.SDK.${line}`)] });
      if (unix)
        recipes.push({
          id: "dotnet-install",
          label: "dotnet-install",
          // Into ~/.dotnet, no password; the detection pass looks there as well as on PATH. `LTS` is
          // the script's own name for the current long-term release.
          steps: [
            {
              title: `dotnet ${line ? `${line}.0` : "LTS"}`,
              sh: `curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel ${line ? `${line}.0` : "LTS"}`,
            },
          ],
        });
      if (platform === "macos" && has("brew"))
        recipes.push({ id: "brew", label: "Homebrew", sudo: true, steps: [{ title: "brew dotnet-sdk", argv: ["brew", "install", "--cask", "dotnet-sdk"] }] });
      break;
    }
    case "cargo": {
      if (unix)
        recipes.push({
          id: "rustup",
          label: "rustup",
          steps: [{ title: "rustup", sh: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" }],
        });
      if (!unix && has("winget")) recipes.push({ id: "winget", label: "winget", steps: [winget("Rustlang.Rustup")] });
      break;
    }
    case "git": {
      if (platform === "macos") {
        if (has("brew")) recipes.push({ id: "brew", label: "Homebrew", steps: [{ title: "brew git", argv: ["brew", "install", "git"] }] });
        recipes.push({ id: "xcode", label: "Xcode CLT", steps: [{ title: "xcode-select --install", argv: ["xcode-select", "--install"] }] });
      }
      if (!unix && has("winget")) recipes.push({ id: "winget", label: "winget", steps: [winget("Git.Git")] });
      if (platform === "linux") recipes.push(...sudoLinux(present, { apt: "git", dnf: "git", pacman: "git" }));
      break;
    }
  }
  // A step with no line for this shell cannot run here.
  return recipes.filter((recipe) => recipe.steps.every((step) => step.argv || (unix ? step.sh : step.ps)));
}
