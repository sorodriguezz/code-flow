// Puts the local code-completion engine into `src-tauri/resources/llama/`:
//
//   llama-server[.exe]   the FIM server CodeFlow talks to over a loopback port
//   lib*/… .dll          only the libraries that binary actually resolves
//   LICENSE              llama.cpp's, because we are redistributing its binaries — from the
//                        archive when it carries one, from `scripts/assets/` when it does not
//
// Same bargain as `build-iris-runtime.mjs`, which does this for the JRE the IRIS driver needs, and
// deliberately the same shape: a pinned upstream release, checksum-verified, trimmed to what is
// used, written into the app's resources, and skipped entirely when it is already current.
//
// **The weights are not here and never will be.** They are gigabytes, they are optional, and the
// app downloads the one the user picks at runtime into `paths::models_dir()`. This script ships
// only the ~22 MB (macOS) / ~38 MB (Windows) of engine — for comparison, the JRE next door is
// 36 MB.
//
// Run it directly (`pnpm llama:runtime`) or let `tauri build` do it. `--force` re-fetches;
// `--optional` downgrades every failure to a warning, which is what `tauri dev` passes so that
// someone working on the git UI is never blocked by a download.
//
// Cross-compiling: like `jlink`, this produces output for one platform — the assets are per-OS and
// per-arch. That is already how the app is released (one runner each), and it is why there is no
// `--target` flag.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri", "resources", "llama");
const WORK = join(ROOT, "src-tauri", "target", "llama-build");

/**
 * The llama.cpp build this release is pinned to.
 *
 * A tag and not "latest", for the reason every other pinned dependency here is pinned: llama.cpp
 * tags several builds a day, and a release whose engine is whatever was current at build time is a
 * release nobody can reproduce. Bumping it is a deliberate act — change the tag, re-run with
 * `--force`, replace the four hashes below with what it prints, and try a completion.
 */
const BUILD = "b10587";

/**
 * Per-platform assets, each pinned by SHA-256.
 *
 * The hash is the load-bearing part. These binaries are fetched over the network and shipped
 * inside an installer, and a tag alone trusts whatever the URL serves on the day of the build.
 *
 * Only the two platforms the release matrix actually produces. macOS is arm64 only — see the
 * comment on the matrix in `.github/workflows/release.yml`, which made the same call for the JRE:
 * a universal binary paired with a single-architecture runtime installs fine on an Intel Mac and
 * then fails the moment the feature is used, and a missing feature beats a broken one.
 */
const ASSETS = {
  "darwin-arm64": {
    file: `llama-${BUILD}-bin-macos-arm64.tar.gz`,
    sha256: "7695344d6f4d09296fb7f0d75ebcb722cf6cc92a2d052de867b75b5bbc3eeb3c",
  },
  "win32-x64": {
    file: `llama-${BUILD}-bin-win-cpu-x64.zip`,
    sha256: "1abb244f21f00192e75eaf04b2a133202d309d1e7525ea8a58a18f31dfcca693",
  },
};

/**
 * What to keep out of the ~50 files each archive holds.
 *
 * Not guessed. On macOS the list is `otool -L llama-server` closed over itself; on Windows it is
 * the PE import table of `llama-server.exe` closed over itself, which is why `ggml-rpc` appears on
 * one platform and not the other — the macOS build links it and the Windows build does not.
 *
 * `ggml-cpu-*` on Windows is the exception to "only what it resolves": those fourteen files are
 * *not* imported, they are opened at runtime by ggml's backend loader, which scores each against
 * the CPU it finds itself on and takes the best. They cost 16.5 MB and they are the difference
 * between AVX-512 and a baseline build on the machines that have it — on Windows, where this
 * engine has no GPU backend at all, that is the whole of the feature's speed. All fourteen stay.
 *
 * `LICENSE` is deliberately not here even though it ships: the macOS tarball carries one and the
 * Windows zip does not, so it is not a property of the archive to assert. `installLicense` handles
 * it, and see the note on `VENDORED_LICENSE`.
 */
const KEEP = {
  "darwin-arm64": {
    // Exact names. Several of these are symlinks in the archive and are resolved into real files
    // on the way out — see `copyResolved`. Shipping the symlink plus its target would work and
    // would also double the bytes for no reason.
    exact: [
      "llama-server",
      "libllama-server-impl.dylib",
      "libllama-common.0.dylib",
      "libmtmd.0.dylib",
      "libllama.0.dylib",
      "libggml.0.dylib",
      "libggml-cpu.0.dylib",
      "libggml-blas.0.dylib",
      "libggml-metal.0.dylib",
      "libggml-rpc.0.dylib",
      "libggml-base.0.dylib",
    ],
    prefixes: [],
    executable: ["llama-server"],
  },
  "win32-x64": {
    exact: [
      "llama-server.exe",
      "llama-server-impl.dll",
      "llama-common.dll",
      "llama.dll",
      "mtmd.dll",
      "ggml.dll",
      "ggml-base.dll",
      "libomp.dll",
    ],
    prefixes: ["ggml-cpu-"],
    executable: [],
  },
};

/**
 * llama.cpp's MIT license, for the archive that does not carry one.
 *
 * This is what broke the first Windows release. `LICENSE` sat in `KEEP["win32-x64"].exact` by
 * symmetry with the macOS list — every exact name is required, the checksum had already proven the
 * asset was the pinned one, and the build died reporting a layout change over the one file that had
 * never been in `llama-<build>-bin-win-cpu-x64.zip` to begin with. The macOS tarball does ship it.
 *
 * Dropping it instead would be the wrong repair: these are llama.cpp's binaries inside an installer,
 * and the MIT license travels with them. So the archive's copy wins when there is one, this stands
 * in when there is not, and `installLicense` fails the build if neither produced a file — the same
 * bargain as the `missing` check above, for the same reason.
 *
 * The text is upstream's, verbatim from the macOS tarball of the pinned BUILD. Re-copy it from
 * there when bumping BUILD if upstream ever edits it.
 */
const VENDORED_LICENSE = join(ROOT, "scripts", "assets", "llama.cpp-LICENSE");

const force = process.argv.includes("--force");
const optional = process.argv.includes("--optional");

main().catch((error) => {
  if (optional) {
    console.warn(`\nllama-runtime: skipped — ${error.message}`);
    console.warn(
      "llama-runtime: the app will build and run; local code completion won't work until this succeeds.\n",
    );
    process.exit(0);
  }
  console.error(`\nllama-runtime: ${error.message}\n`);
  process.exit(1);
});

async function main() {
  const platform = `${process.platform}-${process.arch}`;
  const asset = ASSETS[platform];
  const rules = KEEP[platform];
  if (!asset) {
    // Not an error even without `--optional`: a Linux developer can build and run everything else,
    // and `engine::locate()` in Rust already reports the engine as unavailable rather than
    // crashing. Shipping is a different matter, and the release matrix only has the two platforms
    // that are covered.
    console.warn(`llama-runtime: no engine build for ${platform} — skipping.`);
    return;
  }

  // The stamp lives in the work directory rather than in `OUT`, for the reason `build-iris-runtime`
  // keeps its own outside `resources/iris`: that directory is copied verbatim into the bundle, and a
  // build stamp has no business reaching a user's disk.
  //
  // The existence check beside it is what a stamp kept elsewhere costs. `WORK` can outlive an `OUT`
  // that was deleted by hand or restored from a partial cache, and a stamp on its own would then
  // report an engine that is not there — which `tauri build` would package without noticing.
  const stamp = join(WORK, ".build");
  const installed = join(OUT, rules.exact[0]);
  if (!force && (await currentStamp(stamp)) === stampFor(platform) && existsSync(installed)) {
    console.log(`llama-runtime: ${BUILD} already in place for ${platform}.`);
    return;
  }

  await mkdir(WORK, { recursive: true });
  const archive = join(WORK, asset.file);

  // The archive is cached across builds. Verifying rather than trusting its presence is what makes
  // a half-written download from an interrupted build a re-download instead of a corrupt install.
  if (force || !(await hashMatches(archive, asset.sha256))) {
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${asset.file}`;
    console.log(`llama-runtime: fetching ${asset.file}`);
    await download(url, archive);
    const got = await sha256(archive);
    if (got !== asset.sha256) {
      await rm(archive, { force: true });
      throw new Error(
        `checksum mismatch for ${asset.file}\n  expected ${asset.sha256}\n  got      ${got}\n` +
          `If you just bumped BUILD, put the new hash in ASSETS.`,
      );
    }
  }

  const unpacked = join(WORK, `unpacked-${BUILD}-${platform}`);
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  await extract(archive, unpacked);

  const source = await findPayload(unpacked);
  await clearOutput();

  const names = await readdir(source);
  const wanted = names.filter(
    (name) => rules.exact.includes(name) || rules.prefixes.some((p) => name.startsWith(p)),
  );

  // Every exact name must be there. A silently-thinner engine is the worst outcome of a llama.cpp
  // release that renamed a library: `tauri build` succeeds, the installer ships, and the feature
  // dies on the user's machine with a dynamic-link error nobody can read.
  const missing = rules.exact.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `${BUILD} does not contain: ${missing.join(", ")}\n` +
        `The upstream layout changed. Re-derive KEEP["${platform}"] from the dependency closure ` +
        `of llama-server before bumping BUILD.`,
    );
  }

  let total = 0;
  for (const name of wanted) {
    total += await copyResolved(join(source, name), join(OUT, name));
  }
  total += await installLicense(source);
  for (const name of rules.executable) {
    // The tar/zip round trip does not reliably carry the executable bit on every extractor, and a
    // `llama-server` that cannot be exec'd fails with a permission error that reads like a
    // sandbox problem rather than a packaging one.
    await chmodExecutable(join(OUT, name));
  }

  await writeFile(stamp, stampFor(platform), "utf8");
  console.log(
    `llama-runtime: ${wanted.length + 1} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${OUT}`,
  );
}

/** What the stamp holds, so a stale platform or build is detected rather than reused. */
function stampFor(platform) {
  return `${BUILD} ${platform}\n`;
}

async function currentStamp(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function download(url, to) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function hashMatches(path, expected) {
  if (!existsSync(path)) return false;
  return (await sha256(path)) === expected;
}

/**
 * Unpacks with whatever the platform already has.
 *
 * `tar` on both, which is not a typo: Windows has shipped bsdtar in `System32` since Windows 10
 * 1803 and it reads zip perfectly well, so this avoids both a dependency and a second code path.
 */
async function extract(archive, into) {
  const result = spawnSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`could not extract ${archive} (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

/**
 * The directory the binaries are actually in.
 *
 * The macOS tarball wraps everything in `llama-<build>/` and the Windows zip does not, so this
 * looks for `llama-server` rather than assuming either layout — one less thing to notice when
 * upstream changes its packaging.
 */
async function findPayload(root) {
  const holds = async (dir) => {
    const names = await readdir(dir);
    return names.includes("llama-server") || names.includes("llama-server.exe");
  };
  if (await holds(root)) return root;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = join(root, entry.name);
      if (await holds(nested)) return nested;
    }
  }
  throw new Error(`no llama-server in ${root} — the archive layout changed`);
}

/**
 * Copies `from` to `to`, following a symlink to its target.
 *
 * The macOS archive ships each library three times: the real `libggml.0.21.0.dylib` plus
 * `libggml.0.dylib` and `libggml.dylib` pointing at it. `llama-server` resolves the middle name, so
 * that is the one written — as a real file, because a dangling symlink in an app bundle is a
 * launch failure and copying all three would ship the bytes twice.
 */
async function copyResolved(from, to) {
  const real = await realpath(from);
  await copyFile(real, to);
  return (await stat(to)).size;
}

/**
 * Writes `LICENSE` into the output — from the archive when it has one, from the vendored copy when
 * it does not, and never not at all. See the note on `VENDORED_LICENSE`.
 */
async function installLicense(source) {
  const to = join(OUT, "LICENSE");
  const inArchive = join(source, "LICENSE");
  if (existsSync(inArchive)) return copyResolved(inArchive, to);
  if (!existsSync(VENDORED_LICENSE)) {
    throw new Error(
      `${BUILD} ships no LICENSE and ${VENDORED_LICENSE} is gone.\n` +
        `llama.cpp's binaries cannot be redistributed without it.`,
    );
  }
  console.log("llama-runtime: the archive carries no LICENSE — using the vendored copy.");
  return copyResolved(VENDORED_LICENSE, to);
}

/**
 * Empties `OUT` of everything this script put there, and of nothing else.
 *
 * `rm -rf` on the directory would be simpler and was wrong: `README.md` is checked in — the
 * `.gitignore` entry ignores the directory's *contents* and then exempts that one file — so every
 * rebuild deleted a tracked file, leaving a dirty tree here and a phantom deletion in CI.
 */
async function clearOutput() {
  await mkdir(OUT, { recursive: true });
  for (const name of await readdir(OUT)) {
    if (name === "README.md") continue;
    await rm(join(OUT, name), { recursive: true, force: true });
  }
}

async function chmodExecutable(path) {
  if (process.platform === "win32") return;
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o755);
}
