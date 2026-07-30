// Builds everything CodeFlow needs to reach InterSystems IRIS over JDBC, into
// `src-tauri/resources/iris/`:
//
//   runtime/                     a jlink-trimmed JRE — the only Java the app ever runs
//   iris-bridge.jar              the NDJSON servant in `src-tauri/java/`
//   intersystems-jdbc-<v>.jar    the driver, from Maven Central, checksum-pinned
//
// IRIS has no pure-Rust driver, so a JVM is not optional — but a *full* JRE would be. `jlink` cuts
// it to the four modules the driver actually resolves (verified with `jdeps`), which is the
// difference between ~45 MB and ~200 MB in the installer.
//
// Run it directly (`pnpm iris:runtime`) or let `tauri build` do it. It is incremental: each of the
// three outputs is skipped when it is already present and current, so a rebuild costs nothing.
// `--force` rebuilds regardless.
//
// A note on cross-compiling: `jlink` produces a runtime for the platform of the JDK running it, so
// this must run on each target OS. That is already how the app is released (one runner per
// platform), but it is the reason there is no `--target` flag here.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JAVA_SRC = join(ROOT, "src-tauri", "java");
const OUT = join(ROOT, "src-tauri", "resources", "iris");
const WORK = join(ROOT, "src-tauri", "target", "iris-build");

/**
 * The InterSystems JDBC driver, pinned by version *and* by hash.
 *
 * The hash is the point: this is the one artefact fetched from the network, and it ends up inside
 * a shipped installer. A version number alone would trust whatever the URL serves on the day of
 * the build.
 */
const DRIVER = {
  version: "3.11.0",
  sha256: "08469804eadbfe62f8139b42cd81af814180300f006d5132dd1ab11c8f9d80ce",
  get jar() {
    return `intersystems-jdbc-${this.version}.jar`;
  },
  get url() {
    return `https://repo1.maven.org/maven2/com/intersystems/intersystems-jdbc/${this.version}/${this.jar}`;
  },
};

/**
 * What the runtime has to carry. `jdeps --print-module-deps` on the driver answers
 * `java.base,java.security.jgss,java.sql`; `java.naming` is added because `DriverManager` reaches
 * for JNDI on some paths, and `java.logging` because the driver's own tracing writes through it.
 *
 * Adding a module is cheap. Guessing one away is not: the failure is a `NoClassDefFoundError` deep
 * inside a connection attempt, months later, on a machine you don't have.
 */
const MODULES = ["java.base", "java.sql", "java.naming", "java.logging", "java.security.jgss"];

/** The oldest Java the bridge is compiled for, and so the oldest JDK that can build it. */
const RELEASE = "17";

const force = process.argv.includes("--force");

/**
 * Turns a failure into a warning.
 *
 * Used by `tauri dev`, where a missing JDK must not stop someone working on the git UI. Packaging
 * never passes it: an installer without the runtime would ship an IRIS engine that cannot connect,
 * and that has to fail loudly.
 */
const optional = process.argv.includes("--optional");

main().catch((error) => {
  if (optional) {
    console.warn(`\niris-runtime: skipped — ${error.message}`);
    console.warn("iris-runtime: the app will build and run; IRIS connections won't work until this succeeds.\n");
    process.exit(0);
  }
  console.error(`\niris-runtime: ${error.message}\n`);
  process.exit(1);
});

async function main() {
  const jdk = locateJdk();
  console.log(`iris-runtime: using JDK ${jdk.version} at ${jdk.home}`);

  await mkdir(OUT, { recursive: true });
  await buildRuntime(jdk);
  await fetchDriver();
  await buildBridge(jdk);

  console.log(`\niris-runtime: ready in ${OUT}`);
}

// ---------------------------------------------------------------------------
// The JDK doing the building
// ---------------------------------------------------------------------------

function locateJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(process.env.JAVA_HOME);
  }
  if (process.platform === "darwin") {
    const found = spawnSync("/usr/libexec/java_home", { encoding: "utf8" });
    if (found.status === 0) {
      candidates.push(found.stdout.trim());
    }
  }
  // Last resort: whatever `javac` is on PATH, resolved back to its home.
  const onPath = spawnSync(exe("javac"), ["-version"], { encoding: "utf8" });
  if (onPath.status === 0) {
    candidates.push(null); // null means "use the bare tool names"
  }

  for (const home of candidates) {
    const version = probe(home);
    if (!version) continue;
    if (version < Number(RELEASE)) {
      throw new Error(
        `the JDK at ${home ?? "PATH"} is Java ${version}, but the IRIS bridge needs ${RELEASE} or newer`,
      );
    }
    return { home: home ?? "PATH", version, tool: (name) => (home ? join(home, "bin", exe(name)) : exe(name)) };
  }

  throw new Error(
    "no JDK found. Building CodeFlow's IRIS support needs one (javac, jar and jlink) — set " +
      "JAVA_HOME, or install a JDK " +
      RELEASE +
      "+ such as Temurin. This is a build-time requirement only; the app ships its own runtime.",
  );
}

/** The feature version of a candidate JDK, or null when it isn't one (a JRE has no `jlink`). */
function probe(home) {
  const jlink = home ? join(home, "bin", exe("jlink")) : exe("jlink");
  const result = spawnSync(jlink, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const major = Number.parseInt(String(result.stdout || result.stderr).trim().split(".")[0], 10);
  return Number.isFinite(major) ? major : null;
}

function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function run(command, args, what) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${what} failed (${command} exited ${result.status ?? "on a signal"})`);
  }
}

// ---------------------------------------------------------------------------
// 1. The trimmed runtime
// ---------------------------------------------------------------------------

async function buildRuntime(jdk) {
  const runtime = join(OUT, "runtime");
  // Kept outside `OUT`, because everything in there is copied verbatim into the app bundle and a
  // build stamp has no business shipping to users.
  const stamp = join(WORK, "runtime.stamp");
  const want = `${jdk.version}\n${MODULES.join(",")}\n`;

  if (!force && existsSync(join(runtime, "bin", exe("java")))) {
    const have = await readFile(stamp, "utf8").catch(() => "");
    if (have === want) {
      console.log("iris-runtime: runtime is current, skipping jlink");
      return;
    }
  }

  // jlink refuses to write into a directory that exists, so a rebuild starts clean.
  await rm(runtime, { recursive: true, force: true });

  // `zip-6` is the JDK 21+ spelling; older releases take a bare level. Trying the modern one first
  // and falling back keeps this working across the JDKs a contributor might have.
  const compression = jdk.version >= 21 ? "zip-6" : "2";
  console.log(`iris-runtime: jlink → ${runtime}`);
  run(
    jdk.tool("jlink"),
    [
      "--add-modules",
      MODULES.join(","),
      "--strip-debug",
      "--no-header-files",
      "--no-man-pages",
      `--compress=${compression}`,
      "--output",
      runtime,
    ],
    "jlink",
  );
  // jlink writes its bundled licence files read-only (mode 444). Tauri copies this whole tree into
  // the app bundle on every build, and the second build fails with EACCES trying to overwrite one.
  // Making the tree writable is the fix — it is a build output, not an installed runtime.
  await makeWritable(runtime);
  await mkdir(WORK, { recursive: true });
  await writeFile(stamp, want);
}

/** Adds owner-write to everything under `dir`. A no-op in effect on Windows, which has no such mode. */
async function makeWritable(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // the target is in this same tree and gets its own visit
    if (entry.isDirectory()) {
      await makeWritable(path);
      continue;
    }
    const { mode } = await stat(path);
    if (!(mode & 0o200)) {
      await chmod(path, mode | 0o200);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The driver
// ---------------------------------------------------------------------------

async function fetchDriver() {
  const target = join(OUT, DRIVER.jar);

  if (!force && existsSync(target)) {
    const digest = createHash("sha256").update(await readFile(target)).digest("hex");
    if (digest === DRIVER.sha256) {
      console.log(`iris-runtime: ${DRIVER.jar} is present and verified, skipping download`);
      return;
    }
    console.log(`iris-runtime: ${DRIVER.jar} failed its checksum, re-downloading`);
  }

  // Any older pinned version left behind would land on the classpath beside the new one, and two
  // copies of the driver is a coin flip over which `IRISDriver` wins.
  await removeStaleDrivers(target);

  console.log(`iris-runtime: downloading ${DRIVER.url}`);
  const response = await fetch(DRIVER.url);
  if (!response.ok) {
    throw new Error(`Maven Central answered ${response.status} for ${DRIVER.jar}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DRIVER.sha256) {
    throw new Error(
      `${DRIVER.jar} does not match its pinned checksum.\n  expected ${DRIVER.sha256}\n  got      ${digest}\n` +
        "Nothing was written. Either the pin in this script is stale, or the download is not what it claims to be.",
    );
  }
  await writeFile(target, bytes);
  console.log(`iris-runtime: ${DRIVER.jar} verified (sha256 ${digest.slice(0, 16)}…)`);
}

async function removeStaleDrivers(keep) {
  const entries = await readdir(OUT).catch(() => []);
  for (const entry of entries) {
    if (entry.startsWith("intersystems-jdbc-") && entry.endsWith(".jar") && join(OUT, entry) !== keep) {
      console.log(`iris-runtime: removing superseded ${entry}`);
      await rm(join(OUT, entry), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The bridge
// ---------------------------------------------------------------------------

async function buildBridge(jdk) {
  const source = join(JAVA_SRC, "com", "codeflow", "iris", "IrisBridge.java");
  const jar = join(OUT, "iris-bridge.jar");
  // Outside `OUT` for the same reason as the runtime's: `OUT` is shipped verbatim.
  const stamp = join(WORK, "bridge.stamp");

  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  if (!force && existsSync(jar)) {
    const have = await readFile(stamp, "utf8").catch(() => "");
    if (have.trim() === digest) {
      console.log("iris-runtime: bridge jar matches its source, skipping javac");
      return;
    }
  }

  const classes = join(WORK, "classes");
  await rm(classes, { recursive: true, force: true });
  await mkdir(classes, { recursive: true });

  console.log("iris-runtime: javac → iris-bridge.jar");
  run(
    jdk.tool("javac"),
    [
      // Pinned rather than left to the building JDK: the jar has to run on the trimmed runtime a
      // *different* machine produced, and `--release` is what guarantees it will.
      "--release",
      RELEASE,
      "-Xlint:all",
      "-classpath",
      join(OUT, DRIVER.jar),
      "-d",
      classes,
      source,
    ],
    "javac",
  );
  run(jdk.tool("jar"), ["--create", "--file", jar, "--main-class", "com.codeflow.iris.IrisBridge", "-C", classes, "."], "jar");
  await writeFile(stamp, `${digest}\n`);
}
