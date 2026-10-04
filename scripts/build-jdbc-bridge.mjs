// Builds the one piece of Java CodeFlow ships, into `src-tauri/resources/jdbc/`:
//
//   codeflow-jdbc-bridge.jar     the NDJSON servant in `src-tauri/java/`, which every JDBC driver
//                                runs inside (see `datasource/jvm.rs`)
//
// That is all the installer carries for JDBC now. The Java runtime and the drivers themselves —
// Oracle's, InterSystems', Snowflake's and the rest of the driver catalogue — are downloaded by the
// app the first time a connection needs them (`datasource/drivers.rs`), each checked against the
// hash `src/lib/db/driverCatalog.json` pins. This script used to `jlink` a runtime and fetch two
// drivers into the bundle: some fifty megabytes every install paid for, used by the few that ever
// opened an IRIS or Oracle connection.
//
// Run it directly (`pnpm jdbc:bridge`) or let `tauri build` do it. It is incremental: the jar is
// rebuilt only when its source changed. `--force` rebuilds regardless.

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src-tauri", "java", "com", "codeflow", "jdbc", "JdbcBridge.java");
const OUT = join(ROOT, "src-tauri", "resources", "jdbc");
const JAR = join(OUT, "codeflow-jdbc-bridge.jar");
const MAIN_CLASS = "com.codeflow.jdbc.JdbcBridge";
// Kept outside `OUT`, because everything in there is copied verbatim into the app bundle and a
// build stamp has no business shipping to users.
const WORK = join(ROOT, "src-tauri", "target", "jdbc-bridge-build");

/**
 * The oldest Java the bridge is compiled for, and so the oldest JDK that can build it — and the
 * oldest a user can point a driver's "Java home" at (`REQUIRED_JAVA` in `jvm.rs`). The runtime the
 * app downloads is newer (`runtime.java` in the catalogue).
 */
const RELEASE = "17";

/**
 * Vendor directories worth descending into when scanning for an installed JDK. Without the filter,
 * `C:\Program Files` alone means thousands of pointless directory reads.
 */
const JAVA_DIR =
  /java|jdk|zulu|temurin|adoptium|corretto|sapmachine|semeru|graalvm|liberica|bellsoft|openjdk|oracle|microsoft/i;

const force = process.argv.includes("--force");

/**
 * Turns a failure into a warning.
 *
 * Used by `tauri dev`, where a missing JDK must not stop someone working on the git UI. Packaging
 * never passes it: an installer without the bridge would ship a database workspace whose JDBC
 * drivers cannot connect, and that has to fail loudly.
 */
const optional = process.argv.includes("--optional");

main().catch((error) => {
  if (optional) {
    console.warn(`\njdbc-bridge: skipped — ${error.message}`);
    console.warn("jdbc-bridge: the app will build and run; JDBC connections won't work until this succeeds.\n");
    process.exit(0);
  }
  console.error(`\njdbc-bridge: ${error.message}\n`);
  process.exit(1);
});

async function main() {
  const digest = createHash("sha256").update(await readFile(SOURCE)).digest("hex");
  const stamp = join(WORK, "bridge.stamp");
  if (!force && existsSync(JAR)) {
    const have = await readFile(stamp, "utf8").catch(() => "");
    if (have.trim() === digest) {
      console.log("jdbc-bridge: the jar matches its source, skipping javac");
      return;
    }
  }

  const jdk = locateJdk();
  console.log(`jdbc-bridge: using JDK ${jdk.version} at ${jdk.home}`);

  const classes = join(WORK, "classes");
  await rm(classes, { recursive: true, force: true });
  await mkdir(classes, { recursive: true });
  await mkdir(OUT, { recursive: true });

  console.log("jdbc-bridge: javac → codeflow-jdbc-bridge.jar");
  run(
    jdk.tool("javac"),
    [
      // Pinned rather than left to the building JDK: the jar has to run on whatever runtime a user's
      // machine downloads or a driver is pointed at, and `--release` is what guarantees it will.
      "--release",
      RELEASE,
      // The source is UTF-8; javac otherwise trusts the platform default, which on Windows is
      // windows-1252 and chokes on the arrows in the protocol comments.
      "-encoding",
      "UTF-8",
      "-Xlint:all",
      "-d",
      classes,
      SOURCE,
    ],
    "javac",
  );
  run(jdk.tool("jar"), ["--create", "--file", JAR, "--main-class", MAIN_CLASS, "-C", classes, "."], "jar");
  await mkdir(WORK, { recursive: true });
  await writeFile(stamp, `${digest}\n`);
  console.log(`\njdbc-bridge: ready in ${OUT}`);
}

// ---------------------------------------------------------------------------
// The JDK doing the building
// ---------------------------------------------------------------------------

function locateJdk() {
  const seen = new Set();
  const candidates = [];
  const consider = (home) => {
    const key = home ?? "PATH";
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(home);
    }
  };

  // Explicit configuration first, so a machine that deliberately pins a JDK keeps it.
  if (process.env.JAVA_HOME) {
    consider(process.env.JAVA_HOME);
  }
  if (process.platform === "darwin") {
    const found = spawnSync("/usr/libexec/java_home", { encoding: "utf8" });
    if (found.status === 0) {
      consider(found.stdout.trim());
    }
  }
  // `null` means "use the bare tool names" — whatever is on PATH.
  if (spawnSync(exe("javac"), ["-version"], { encoding: "utf8" }).status === 0) {
    consider(null);
  }
  // Then anything installed in the usual place, newest-looking first.
  for (const home of discoverJavaHomes()) {
    consider(home);
  }

  const rejected = [];
  for (const home of candidates) {
    const version = probe(home);
    if (!version) {
      // Overwhelmingly the JRE-not-JDK case, which is worth naming: it is invisible otherwise, and
      // "JAVA_HOME is set" makes it look like the machine is configured when it isn't.
      rejected.push(`${home ?? "PATH"} — no javac here (a JRE, not a JDK)`);
      continue;
    }
    if (version < Number(RELEASE)) {
      rejected.push(`${home ?? "PATH"} — Java ${version}, needs ${RELEASE} or newer`);
      continue;
    }
    return {
      home: home ?? "PATH",
      version,
      tool: (name) => (home ? join(home, "bin", exe(name)) : exe(name)),
    };
  }

  // Everything that was looked at and why it didn't qualify. Without this the message is "no JDK
  // found" on a machine that visibly has Java installed, which reads as the script being broken.
  const summary = rejected.length
    ? `\nJava was found, but none of it can build the bridge:\n${rejected.map((r) => `  · ${r}`).join("\n")}\n`
    : "";

  throw new Error(
    `no usable JDK. Building CodeFlow's JDBC bridge needs one (javac and jar).\n${summary}\n  ${installHint()}\n\n` +
      "Then re-run, or just start the app again — it is detected automatically, PATH and JAVA_HOME " +
      "included.\nThis is a build-time requirement only: nobody who installs CodeFlow needs Java — " +
      "the app downloads the runtime its drivers need the first time one is used.",
  );
}

/**
 * Java homes sitting in the platform's usual install directory. Looking only where the environment
 * says to look is not enough — a JDK in its default location should never be missed.
 */
function discoverJavaHomes() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let roots;
  if (process.platform === "win32") {
    roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], home && join(home, "AppData", "Local", "Programs")];
  } else if (process.platform === "darwin") {
    roots = ["/Library/Java/JavaVirtualMachines", home && join(home, "Library", "Java", "JavaVirtualMachines")];
  } else {
    roots = ["/usr/lib/jvm", "/usr/java", "/opt/java"];
  }

  const found = [];
  for (const root of roots) {
    if (root) {
      collectJavaHomes(root, 3, found);
    }
  }
  // Descending, so a newer version is tried first: the names carry the version (`JDK\21`,
  // `temurin-22.0.2`), which sorts close enough for a preference that only has to be reasonable.
  return found.sort().reverse();
}

function collectJavaHomes(dir, depth, out) {
  if (depth < 0 || !existsSync(dir)) {
    return;
  }
  if (existsSync(join(dir, "bin", exe("javac")))) {
    out.push(dir); // a JDK — no reason to look inside it
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable (permissions, a dead junction) — not this script's problem
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (depth === 3 && !JAVA_DIR.test(entry.name)) {
      continue;
    }
    collectJavaHomes(join(dir, entry.name), depth - 1, out);
  }
}

/** The one command that fixes it, for the platform actually running. */
function installHint() {
  switch (process.platform) {
    case "win32":
      return `winget install EclipseAdoptium.Temurin.${RELEASE}.JDK`;
    case "darwin":
      return "brew install --cask temurin";
    default:
      return `sudo apt install openjdk-${RELEASE}-jdk    (or your distro's equivalent)`;
  }
}

/** The feature version of a candidate JDK, or null when it isn't one (a JRE has no `javac`). */
function probe(home) {
  const javac = home ? join(home, "bin", exe("javac")) : exe("javac");
  const result = spawnSync(javac, ["-version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  // `javac 21.0.12` — on stdout since JDK 9, on stderr before.
  const text = String(result.stdout || result.stderr).trim();
  const major = Number.parseInt(text.replace(/^javac\s+/, "").split(".")[0], 10);
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
