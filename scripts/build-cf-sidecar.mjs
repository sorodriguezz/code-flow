// Puts `cf` — the command an agent runs inside one of CodeFlow's shells — where Tauri can bundle it:
//
//   src-tauri/resources/cf/cf[.exe]   (installed as `cf-cli/` — `cf/` would collide with the binary in target/)
//
// # Why this is needed at all
//
// `cf` is a package of its own (`src-tauri/cf/`), so building the app does not build it, and an
// **installed** app has no `target/` anyway — without this the binary would not exist, and `cf` would
// be "not a command" for every user. It is its own package because, as a `[[bin]]` of the app, it
// dragged the whole app's library into its build: a release compiled CodeFlow twice (see
// `src-tauri/cf/Cargo.toml`). On its own it has no dependencies and builds in seconds.
//
// # Why a resource and not `externalBin`
//
// `externalBin` is Tauri's own slot for a second executable. It was ruled out while `cf` was a
// `[[bin]]` of the app: `tauri-build` checks that it exists on every build of the package, including
// the one that produced it — a cycle. A resource has no such check as long as its directory is there,
// which is why `resources/cf/README.md` is committed — the same trick the JDBC bridge and the llama
// runtime next door use — and it needs no per-target file names, so it stays. `terminal.rs::cli_path`
// looks in the resource directory and then beside the app's own binary.
//
// Run it directly (`pnpm cf:sidecar`) or let `tauri build`/`tauri dev` do it. `--optional`
// downgrades every failure to a warning, which is what `tauri dev` passes: someone working on the
// git UI should never be blocked because a 250 KB helper would not compile.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI = join(HERE, "..", "src-tauri");
const PACKAGE = join(TAURI, "cf");
const OUT = join(TAURI, "resources", "cf");

const optional = process.argv.includes("--optional");
const release = process.argv.includes("--release");

async function main() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const profile = release ? "release" : "debug";
  const built = join(PACKAGE, "target", profile, `cf${suffix}`);
  const target = join(OUT, `cf${suffix}`);
  const source = join(PACKAGE, "src", "main.rs");

  // Already current: the copy is newer than the source it was built from. Checked rather than always
  // rebuilt because this runs before *every* `tauri dev`, and cargo's own freshness check still
  // costs a second of lock contention with the build that follows it.
  if (existsSync(target) && existsSync(source)) {
    const [madeAt, writtenAt] = await Promise.all([stat(target), stat(source)]);
    if (madeAt.mtimeMs >= writtenAt.mtimeMs) {
      console.log(`cf sidecar: up to date (${target})`);
      return;
    }
  }

  const build = spawnSync("cargo", ["build", ...(release ? ["--release"] : [])], {
    cwd: PACKAGE,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("cargo build of src-tauri/cf failed");
  if (!existsSync(built)) throw new Error(`cargo produced no ${built}`);

  await mkdir(OUT, { recursive: true });
  await copyFile(built, target);
  console.log(`cf sidecar: ${target}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (optional) {
    // The app runs without it; `cf` is then simply not a command inside its shells, which is the
    // same thing that happens outside the app. See `terminal.rs::cli_path`.
    console.warn(`cf sidecar: skipped (${message})`);
    return;
  }
  console.error(`cf sidecar: ${message}`);
  process.exit(1);
});
