// Vendors the draw.io editor into `public/drawio/`, which is what the Diagrams workspace embeds.
//
// The Diagrams canvas is draw.io running in an iframe. It could be pointed at
// `embed.diagrams.net`, and that is what most integrations do — but CodeFlow is a desktop app that
// has to open a diagram on a plane, and an editor fetched over the network is an editor that
// sometimes isn't there. So the webapp ships inside the bundle and the iframe loads
// `/drawio/index.html`, same origin as the app, which is also what lets `postMessage` work without
// opening anything up.
//
// Run it directly (`pnpm drawio:webapp`) or let `tauri build` do it. It is incremental: an output
// that is already present and stamped with the current version is left alone, so a rebuild costs
// nothing. `--force` re-fetches regardless.
//
// **The archive is pinned by version *and* by hash.** This is the one artefact fetched from the
// network that ends up inside a shipped installer, and a version number alone would trust whatever
// the URL serves on the day of the build. Bumping draw.io is therefore a deliberate two-line
// change here, reviewed like any other — not something that happens by itself.
//
// Licence: draw.io is Apache-2.0 (github.com/jgraph/drawio), so redistributing the webapp inside
// the app is fine. `public/drawio/LICENSE` is written alongside it to keep that visible.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "drawio");
/** Records which release `OUT` holds, so an incremental run can tell current from stale. */
const STAMP = join(OUT, ".drawio-version");

/**
 * The release, pinned by version and by SHA-256 of the archive.
 *
 * `draw.war` is the only artefact jgraph publishes for the webapp — a Java WAR, which is a ZIP with
 * a `WEB-INF/` the servlet container reads and the rest of us delete (see `DROP`).
 *
 * To bump: change `version`, run `pnpm drawio:webapp --force`, take the hash the script prints when
 * it refuses, and paste it here. The refusal is the point — it makes "I checked what I am shipping"
 * a step rather than an intention.
 */
const RELEASE = {
  version: "31.1.8",
  sha256: "46389bd60810f9775cd463c9eff4f4f8335f10926d613b0606ad4e978f46d49b",
  get url() {
    return `https://github.com/jgraph/drawio/releases/download/v${this.version}/draw.war`;
  },
};

/**
 * What is deleted after unpacking, and why each entry is safe to delete.
 *
 * The rule for this list is **server-side, dev-only, or a doorway out of the app** — never "a
 * feature somebody might not use". Every shape library, every template and every stencil stays:
 * the reason to embed draw.io rather than write an editor is to get all of it, and a trim that
 * quietly removes the AWS shapes turns that decision into the worst of both.
 *
 * Sizes are from v31.1.8, as a sanity check when this is next revisited.
 */
const DROP = [
  // The Java servlet half of the WAR: JSPs, classes and the export/proxy endpoints. Nothing in a
  // statically-served webapp reads it. ~5.2 MB.
  "WEB-INF",
  // An all-in-one bundle for a different embedding style. `index.html` loads `js/main.js`, which
  // never asks for this; the only mention of it anywhere in the archive is a README. ~21 MB, and
  // by far the biggest single win.
  "js/integrate.min.js",
  // The unminified sources. `js/main.js` loads these only under `?dev=1`, which the app never
  // passes. ~12 MB together.
  "js/diagramly",
  "js/grapheditor",
  // The read-only viewer builds. CodeFlow embeds the editor; a diagram is drawn in the app or not
  // at all. ~6.4 MB.
  "js/viewer.min.js",
  "js/viewer-static.min.js",
  // Cloud pickers and their landing pages. Deliberately gone rather than merely hidden: a diagram
  // lives in this workspace's database, and a "Save to Google Drive" that half-works is worse than
  // one that isn't there. `Editor.enableWebFonts` and friends are turned off in the embed config
  // too — this is the belt to that's braces.
  "js/onedrive",
  "connect",
  "dropbox.html",
  "github.html",
  "gitlab.html",
  "onedrive3.html",
  "teams.html",
  "open.html",
  // A service worker inside a Tauri webview caches the app's own origin and then serves it back
  // across upgrades. Nothing good comes of that here.
  "service-worker.js",
  "service-worker.js.map",

  // ---- Features this app does not surface -------------------------------------------------
  //
  // The trim above is "cannot possibly be needed". This block is a judgement call, and the line it
  // draws is: **the app has its own version, or the feature has no door in this UI.** It is the
  // reason the number below is 57 MB rather than 100.

  // draw.io's own template picker. The Diagrams workspace has `TemplatePickerModal`, seeded with
  // templates that are editable rows — offering a second, read-only picker under File → New would
  // be two answers to the same question. ~5.4 MB.
  "templates",
  // **`math4` is deliberately NOT here, and this is the note saying why.**
  //
  // MathJax is 3.3 MB for formula rendering nobody has asked this app for, so it looks like the
  // easiest 3.3 MB in the archive. It is not: the editor requests `math4/es5/startup.js` while
  // booting, unconditionally, and **without it the editor does not start at all** — a blank frame,
  // ten requests, no error anybody would connect to a deleted folder.
  //
  // The obvious escape is `js/PreConfig.js`, a customisation file that sets `DRAW_MATH_URL`. That
  // does not work either: `app.min.js` reads it as `window.DRAW_MATH_URL || "math4/es5"`, so any
  // falsy override falls straight back to the default path. Suppressing the fetch would mean
  // pointing it at a stub and re-applying that edit on every version bump, to save 3.3 MB out of
  // 58. Not worth it. If you are here to try again: this was tried, and it broke the boot.

  // The plugin loader's bundled plugins. There is no UI to enable one — Extras → Plugins is part
  // of the desktop build, not this embed.
  "plugins",
  // Diagram-from-text and org-chart layouts, neither of which has an entry point here, and the
  // WebRTC peer used by draw.io's own real-time collaboration, which this app does not run.
  "js/plantuml",
  "js/orgchart",
  "js/orgchart.min.js",
  "js/simplepeer",
  // The clipart photo library behind the shape search's "Image" results. ~10.1 MB of pictures for
  // a feature nobody opens a diagram editor for.
  "img/lib",

  // ---- Shape libraries a software team does not open ---------------------------------------
  //
  // **This is the one part of the list that removes something real**, so it is spelled out shape
  // set by shape set rather than hidden behind a glob. What stays is what a codebase is drawn
  // with: general, flowchart, UML, ER, BPMN, network, C4, and the current AWS, Azure and GCP.
  //
  // Superseded cloud icon sets — AWS is on v4, and v2/v3 are kept upstream only so old documents
  // still render. A document that used them opens with blank shapes; that is the cost, and it is
  // why they are listed here and not silently globbed.
  "stencils/aws2",
  "stencils/aws3.xml",
  "stencils/alibaba_cloud.xml",
  // Physical-plant and vendor sets: server racks, Cisco's network gear, Veeam, Microsoft Office,
  // road signage. ~19 MB between them.
  "stencils/rack",
  "stencils/cisco",
  "stencils/cisco19.xml",
  "stencils/cisco_safe",
  "stencils/veeam",
  "stencils/office",
  "stencils/signs",
];

/** Language files to keep, matching what `lib/i18n` ships. The other ~59 are ~5 MB of nothing. */
const KEEP_LANGUAGES = new Set(["dia.txt", "dia_es.txt"]);

const force = process.argv.includes("--force");
/** Turns a failure into a warning — used by `tauri dev`, never by packaging. See `main`. */
const optional = process.argv.includes("--optional");

function log(message) {
  process.stdout.write(`[drawio] ${message}\n`);
}

/** Whether `OUT` already holds this exact release. */
async function isCurrent() {
  try {
    const stamped = (await readFile(STAMP, "utf8")).trim();
    return stamped === RELEASE.version && existsSync(join(OUT, "index.html"));
  } catch {
    return false;
  }
}

async function download(url) {
  log(`fetching ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Unpacks `archive` into `into`.
 *
 * Two tools tried rather than one, because this runs on three CI runners and neither is everywhere:
 * `unzip` is absent from a bare Windows, and GNU `tar` — which is what Linux has — cannot read a
 * ZIP at all. bsdtar (macOS, and Windows 10 1803 onwards) can. Trying both and reporting what was
 * missing beats a build that fails with "command not found" on one platform only.
 */
function unpack(archive, into) {
  const attempts =
    process.platform === "win32"
      ? [["tar", ["-xf", archive, "-C", into]], ["unzip", ["-q", "-o", archive, "-d", into]]]
      : [["unzip", ["-q", "-o", archive, "-d", into]], ["tar", ["-xf", archive, "-C", into]]];

  const failures = [];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (!result.error && result.status === 0) return command;
    failures.push(`${command}: ${result.error ? result.error.message : `exit ${result.status}`}`);
  }
  throw new Error(
    `could not unpack the archive. Tried — ${failures.join("; ")}. Install \`unzip\`, or a tar that reads ZIPs.`,
  );
}

/** Bytes under `path`, for the summary. Cheap enough on ~10k files and worth printing: this is the
 *  number that decides whether the next trim is worth arguing about. */
async function sizeOf(path) {
  let total = 0;
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const child = join(at, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
  };
  await walk(path);
  return total;
}

async function build() {
  if (!force && (await isCurrent())) {
    log(`public/drawio is already at ${RELEASE.version} — nothing to do`);
    return;
  }

  const archive = await download(RELEASE.url);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== RELEASE.sha256) {
    throw new Error(
      `checksum mismatch for draw.war v${RELEASE.version}\n` +
        `  expected ${RELEASE.sha256}\n` +
        `  received ${digest}\n` +
        `If you are bumping the version on purpose, paste the received hash into RELEASE.sha256 ` +
        `in scripts/build-drawio-webapp.mjs after checking where it came from.`,
    );
  }

  // Unpacked into a temporary directory and moved in at the end, so an interrupted run cannot leave
  // `public/drawio` half-populated and pass the `isCurrent` check on the next build.
  const work = await mkdtemp(join(tmpdir(), "codeflow-drawio-"));
  const staging = join(work, "webapp");
  const warPath = join(work, "draw.war");
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(warPath, archive);
    const tool = unpack(warPath, staging);
    log(`unpacked with ${tool}`);

    const before = await sizeOf(staging);

    for (const entry of DROP) {
      await rm(join(staging, entry), { recursive: true, force: true });
    }
    // The language files, which are one directory rather than a list — and which would be a
    // fifteen-line `DROP` if they were spelled out.
    const languages = join(staging, "resources");
    for (const name of await readdir(languages)) {
      if (name.startsWith("dia") && name.endsWith(".txt") && !KEEP_LANGUAGES.has(name)) {
        await rm(join(languages, name), { force: true });
      }
    }
    // The workbox runtime the deleted service worker was the only caller of. Hashed in its
    // filename, so it is matched rather than named.
    for (const name of await readdir(staging)) {
      if (name.startsWith("workbox-")) await rm(join(staging, name), { force: true });
    }

    const after = await sizeOf(staging);
    await writeFile(STAMP.replace(OUT, staging), `${RELEASE.version}\n`);
    await writeFile(
      join(staging, "LICENSE"),
      `draw.io ${RELEASE.version} — Apache License 2.0\n` +
        `https://github.com/jgraph/drawio/blob/master/LICENSE\n` +
        `Vendored by scripts/build-drawio-webapp.mjs. Not CodeFlow's code.\n`,
    );

    await rm(OUT, { recursive: true, force: true });
    await mkdir(dirname(OUT), { recursive: true });
    await rename(staging, OUT);

    const mb = (bytes) => (bytes / 1e6).toFixed(1);
    log(`v${RELEASE.version} → public/drawio  ${mb(after)} MB (trimmed from ${mb(before)} MB)`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * `fs.rename` across devices fails with `EXDEV`, and the temp directory is routinely on another
 * filesystem from the repo — a container, a RAM disk, a separate volume on Windows. Falling back to
 * a copy keeps the build working there instead of failing on a machine nobody tested on.
 */
async function rename(from, to) {
  const { rename: move, cp } = await import("node:fs/promises");
  try {
    await move(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true });
  }
}

try {
  await build();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (optional) {
    // `tauri dev` passes `--optional`: a developer working on the git UI with no network must not
    // be stopped by a missing diagram editor. The Diagrams workspace reports the absence itself.
    log(`skipped — ${message}`);
  } else {
    process.stderr.write(`[drawio] ${message}\n`);
    process.exit(1);
  }
}
