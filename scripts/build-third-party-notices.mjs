// Writes `THIRD-PARTY-NOTICES.md` — the list of everything CodeFlow ships that CodeFlow did not
// write, and the handful of notices those components' licences oblige us to pass on.
//
// Section 6 of `LICENSE` says third-party components are governed by their own licences. That
// sentence is only true if those licences are actually *reachable*, and a few of them go further
// and require us to say something specific to whoever installs an Official Build:
//
//   MPL-2.0 §3.2(a)   tell recipients of the Executable Form where to get the Source Code Form
//   GPL-2.0 §3        the same, for the OpenJDK image inside `resources/iris/runtime/`
//   InterSystems      a copy of its terms of use must accompany any distribution of the driver
//   Oracle            the same for ojdbc11 — met by the licence the jar carries inside itself
//
// None of that is satisfied by a file nobody generates, so this script exists to make the file
// cheap to regenerate and expensive to forget. Same bargain as the three runtime builders next
// door: pinned inputs, loud failures, no step that depends on somebody remembering it.
//
//   pnpm notices           regenerate the file
//   pnpm notices:check     fail if what is on disk is not what this script would write
//   --offline              never let cargo touch the network; report what is missing instead
//
// Everything it reads is already on the machine, so it runs offline:
//
//   npm      `pnpm licenses list --json --prod` — the installed production tree, which is the
//            lockfile's resolution rather than `package.json`'s ranges
//   Rust     `cargo metadata --offline --locked`, filtered to the platforms a release is built for,
//            from `src-tauri/Cargo.lock` and the local registry cache. Only when that cache lacks a
//            crate (a fresh CI runner) does it let cargo download the manifests — never with
//            `--offline`, which reports the failure instead
//   native   `NATIVE` below — the C libraries some `-sys` crates compile into the binary. Their
//            licences are not the crate's, so every run re-reads the licence text inside the
//            crate's own copy of the source and stops if it no longer says what the table claims
//   bundles  `BUNDLED` below — the runtimes, drivers and web app the `build-*` scripts download,
//            whose licences live upstream and cannot be read out of any lockfile. Their *versions*
//            are scraped back out of those scripts, so bumping a pin there cannot leave a stale
//            version here; when a downloaded artefact is on disk, its licence is checked as well
//   assets   the fonts and icon sets the frontend ships, read from their own metadata
//
// What this script will not do is guess. An unfamiliar licence identifier is reported; a copyleft
// one that no dual-licence election disarms stops the run, because that is a decision for a person
// and not a row in a generated table. Copyleft that has been found but not yet decided on is named
// in `OPEN` and printed as an open item, never folded in as settled.
//
// The output is a function of the lockfiles, the pins and the constants below — not of the
// machine, the date, the locale or the app's version — so two runs on one tree write the same bytes.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.md");
const REPO = "https://github.com/sorodriguezz/code-flow";

const check = process.argv.includes("--check");
const offline = process.argv.includes("--offline");

// ---------------------------------------------------------------------------
// The part a person maintains
// ---------------------------------------------------------------------------

/**
 * The platforms an Official Build is produced for — one per leg of the release matrix in
 * `.github/workflows/release.yml`. `releaseTargets()` reads that matrix back, so a leg added there
 * without a row here stops the run instead of quietly shipping crates nobody listed.
 *
 * The Rust graph is filtered to these. A crate only Linux, Android or wasm would pull — GTK, D-Bus,
 * the JNI bindings — is in `Cargo.lock` but in no installer.
 */
const TARGETS = [
  { runner: "macos-latest", triple: "aarch64-apple-darwin", label: "macOS" },
  { runner: "windows-latest", triple: "x86_64-pc-windows-msvc", label: "Windows" },
];

/**
 * What ships inside an Official Build that no lockfile knows about.
 *
 * Everything here is downloaded or built by one of the sibling scripts and copied into the
 * installer — `bundle.resources` in `tauri.conf.json` for the first four, the frontend bundle for
 * draw.io. `version` is deliberately not a literal: it is read back out of the file that pins it
 * (see `scrape`), so the only way to change it here is to change the pin there.
 *
 * `verify` re-reads whatever licence evidence is on disk. The artefacts themselves are build
 * outputs and absent from a fresh clone, so a check that needs one is skipped when it is missing —
 * it never changes the output, only whether the run is allowed to finish.
 */
const BUNDLED = [
  {
    name: "llama.cpp (with ggml)",
    version: () => scrape("scripts/build-llama-runtime.mjs", /^const BUILD = "([^"]+)";/m),
    licence: "MIT",
    url: "https://github.com/ggml-org/llama.cpp",
    ships: "`resources/llama/` — `llama-server` and the ggml libraries it resolves",
    by: "scripts/build-llama-runtime.mjs",
    verify() {
      proveFile("scripts/assets/llama.cpp-LICENSE", ["MIT License", "The ggml authors"], "llama.cpp", "MIT");
      proveFile("src-tauri/resources/llama/LICENSE", ["MIT License"], "llama.cpp", "MIT", { optional: true });
    },
  },
  {
    // The image is jlinked from whatever JDK the build machine has, so the licence below is only
    // the licence of an *Official* Build. `verify` asserts rather than reports for that reason: if
    // the release workflow ever moves off Temurin, the licence in this row stops being true and
    // the run stops with it.
    name: "Eclipse Temurin JDK (jlink image)",
    version: () => scrape(".github/workflows/release.yml", /java-version:\s*"?([0-9.]+)"?/),
    licence: "GPL-2.0-only WITH Classpath-exception-2.0",
    url: "https://adoptium.net/temurin/",
    ships: "`resources/iris/runtime/` — trimmed by `jlink` to the modules the two JDBC drivers load",
    by: "scripts/build-iris-runtime.mjs",
    notice: "jdk",
    verify() {
      expect(".github/workflows/release.yml", /distribution:\s*(\S+)/, "temurin");
    },
  },
  {
    name: "InterSystems IRIS JDBC driver",
    version: () => scrape("scripts/build-iris-runtime.mjs", /const DRIVER = \{[\s\S]*?version: "([^"]+)"/),
    licence: "LicenseRef-InterSystems-IERTU (proprietary)",
    url: "https://repo1.maven.org/maven2/com/intersystems/intersystems-jdbc/",
    terms: "https://www.intersystems.com/IERTU/",
    ships: "`resources/iris/intersystems-jdbc-<version>.jar`",
    by: "scripts/build-iris-runtime.mjs",
    notice: "iris",
    verify(version) {
      proveJar(
        `src-tauri/resources/iris/intersystems-jdbc-${version}.jar`,
        "META-INF/maven/com.intersystems/intersystems-jdbc/pom.xml",
        ["<url>https://www.intersystems.com/IERTU/</url>"],
        "the InterSystems driver",
        "the InterSystems External Repository Terms of Use",
      );
    },
  },
  {
    name: "Oracle JDBC driver (ojdbc11)",
    version: () => scrape("scripts/build-iris-runtime.mjs", /const ORACLE_DRIVER = \{[\s\S]*?version: "([^"]+)"/),
    licence: "LicenseRef-Oracle-FUTC (proprietary)",
    url: "https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc11/",
    ships: "`resources/iris/ojdbc11-<version>.jar`",
    by: "scripts/build-iris-runtime.mjs",
    notice: "oracle",
    verify(version) {
      proveJar(
        `src-tauri/resources/iris/ojdbc11-${version}.jar`,
        "META-INF/license.txt",
        ["Oracle Free Distribution, Hosting, and Use Terms and Conditions", "redistributing unmodified Programs"],
        "the Oracle driver",
        "the Oracle Free Use Terms and Conditions",
      );
    },
  },
  {
    name: "draw.io",
    version: () => scrape("scripts/build-drawio-webapp.mjs", /const RELEASE = \{[\s\S]*?version: "([^"]+)"/),
    licence: "Apache-2.0",
    url: "https://github.com/jgraph/drawio",
    ships: "`public/drawio/` — vendored into the frontend bundle",
    by: "scripts/build-drawio-webapp.mjs",
  },
];

/**
 * C libraries that a `-sys` crate compiles from its own bundled copy of the source and links into
 * the app's binary.
 *
 * A crate's `license` field describes the crate — for these, a few hundred lines of Rust bindings.
 * The library underneath arrives under its own licence, which no lockfile records, so it is written
 * down here and *proved* on every run: `proof` names a file inside the crate's source and phrases
 * that file must still contain (whitespace and comment markers are ignored). A library that is
 * relicensed upstream therefore fails the run the day its crate is bumped, rather than leaving
 * this table asserting a licence nobody ships.
 *
 * `on` is where the build script really compiles the bundled copy, which is not the same as where
 * the crate is in the graph: `libz-sys` is in the macOS graph too, but links the system's zlib
 * there. Established from each crate's `build.rs` and from the macOS build's own `output` files
 * (`cargo:rustc-link-lib=static=…`), and worth re-checking when one of these crates moves.
 */
const NATIVE = {
  "libgit2-sys": {
    library: "libgit2",
    version: (dir) => scrapeIn(dir, "libgit2/include/git2/version.h", /LIBGIT2_VERSION\s+"([^"]+)"/),
    licence: "GPL-2.0-only WITH GCC-exception-2.0",
    url: (version) => `https://github.com/libgit2/libgit2/tree/v${version}`,
    proof: ["libgit2/COPYING", ["GNU GENERAL PUBLIC LICENSE Version 2, June 1991", "LINKING EXCEPTION"]],
    on: ["macOS", "Windows"],
    notice: "libgit2",
    // What libgit2-sys's `build.rs` compiles out of libgit2's own `deps/` and `src/`, each under a
    // licence of its own. Not listed: `deps/zlib` (libz-sys provides zlib instead), `deps/winhttp`
    // (headers for MinGW builds; MSVC uses the SDK's) and `deps/ntlmclient` (never enabled).
    parts: [
      {
        library: "llhttp",
        version: (dir) => {
          const text = readIn(dir, "libgit2/deps/llhttp/llhttp.h");
          const part = (name) => text.match(new RegExp(`LLHTTP_VERSION_${name}\\s+(\\d+)`))?.[1];
          return [part("MAJOR"), part("MINOR"), part("PATCH")].every(Boolean)
            ? [part("MAJOR"), part("MINOR"), part("PATCH")].join(".")
            : fail("could not read llhttp's version out of libgit2-sys");
        },
        licence: "MIT",
        path: "deps/llhttp/",
        proof: ["libgit2/deps/llhttp/LICENSE-MIT", ["This software is licensed under the MIT License."]],
      },
      {
        library: "PCRE",
        version: (dir) => {
          const text = readIn(dir, "libgit2/deps/pcre/pcre.h");
          const major = text.match(/define PCRE_MAJOR\s+(\d+)/)?.[1];
          const minor = text.match(/define PCRE_MINOR\s+(\d+)/)?.[1];
          return major && minor ? `${major}.${minor}` : fail("could not read PCRE's version out of libgit2-sys");
        },
        licence: "BSD-3-Clause",
        path: "deps/pcre/",
        proof: ["libgit2/deps/pcre/LICENCE", ['distributed under the terms of the "BSD" licence', "Neither the name of the University of Cambridge"]],
      },
      {
        library: "SHA-1 collision detection (sha1dc)",
        licence: "MIT",
        path: "src/util/hash/sha1dc/",
        proof: ["libgit2/src/util/hash/sha1dc/sha1.c", ["Distributed under the MIT Software License."]],
      },
      {
        library: "LibXDiff (xdiff)",
        licence: "LGPL-2.1-or-later",
        path: "deps/xdiff/",
        proof: [
          "libgit2/deps/xdiff/xdiff.h",
          [
            "LibXDiff by Davide Libenzi",
            "GNU Lesser General Public License as published by the Free Software Foundation; either version 2.1 of the License, or (at your option) any later version.",
          ],
        ],
        open: "xdiff",
      },
    ],
  },
  "libssh2-sys": {
    library: "libssh2",
    version: (dir) => scrapeIn(dir, "libssh2/include/libssh2.h", /define LIBSSH2_VERSION\s+"([^"]+)"/),
    licence: "BSD-3-Clause",
    url: () => "https://libssh2.org/",
    proof: ["libssh2/COPYING", ["Redistribution and use in source and binary forms", "Neither the name of the copyright holder"]],
    on: ["macOS", "Windows"],
  },
  "libsqlite3-sys": {
    library: "SQLite",
    version: (dir) => scrapeIn(dir, "sqlite3/sqlite3.h", /define SQLITE_VERSION\s+"([^"]+)"/),
    licence: "blessing",
    url: () => "https://sqlite.org/copyright.html",
    proof: ["sqlite3/sqlite3.h", ["The author disclaims copyright to this source code. In place of a legal notice, here is a blessing:"]],
    on: ["macOS", "Windows"],
  },
  "openssl-src": {
    library: "OpenSSL",
    version: (dir) => {
      const text = readIn(dir, "openssl/VERSION.dat");
      const field = (name) => text.match(new RegExp(`^${name}=(\\d+)`, "m"))?.[1];
      return [field("MAJOR"), field("MINOR"), field("PATCH")].every(Boolean)
        ? [field("MAJOR"), field("MINOR"), field("PATCH")].join(".")
        : fail("could not read OpenSSL's version out of openssl-src");
    },
    licence: "Apache-2.0",
    url: () => "https://www.openssl.org/",
    proof: ["openssl/LICENSE.txt", ["Apache License Version 2.0, January 2004"]],
    // `git2`'s `vendored-openssl` feature is scoped to macOS in Cargo.toml, and on Windows libgit2
    // and libssh2 use the system's own TLS and crypto.
    on: ["macOS"],
  },
  "libz-sys": {
    library: "zlib",
    version: (dir) => scrapeIn(dir, "src/zlib/zlib.h", /define ZLIB_VERSION\s+"([^"]+)"/),
    licence: "Zlib",
    url: () => "https://zlib.net/",
    proof: ["src/zlib/LICENSE", ["This software is provided 'as-is'", "Permission is granted to anyone to use this software for any purpose"]],
    // macOS ships a zlib of its own, which the build links instead; MSVC has none, so Windows
    // compiles the bundled copy.
    on: ["Windows"],
  },
};

/**
 * Crates with a `links` key that were read and found to compile no third-party native code.
 *
 * `links` is how a crate says "I link a native library", which is exactly the case `NATIVE` exists
 * for — so any crate that declares one and appears in neither list is reported, because nobody has
 * yet checked what its build script puts into the binary.
 */
const LINKS_REVIEWED = [
  { name: /^tauri(-plugin-[a-z0-9-]+)?$/, why: "Tauri's `links` key only passes permission metadata between build scripts" },
  { name: "openssl-sys", why: "builds the OpenSSL that `openssl-src` carries, listed above, and links nothing else" },
  { name: "ring", why: "its C and assembly are ring's own and BoringSSL's, covered by the licence the crate declares" },
  { name: "objc2-exception-helper", why: "a few lines of Objective-C of its own, under the crate's licence" },
  {
    name: "mongocrypt-sys",
    why: "declares a link to a system libmongocrypt and compiles nothing; the driver feature that would load it is off",
  },
];

/**
 * The fonts the frontend ships, and where each one's licence is read from.
 *
 * `fontsource` packages describe themselves in `metadata.json`. The other two are fonts *inside* a
 * package whose own licence is not the font's — pdfmake embeds Roboto as base64 in the file the app
 * imports — so their licence is read out of the font's `name` table instead. A font that carries
 * no licence of its own ships under its package's, which is said so rather than inferred.
 */
const FONTS = [
  { family: "Instrument Sans", use: "the interface", package: "@fontsource-variable/instrument-sans", kind: "fontsource" },
  { family: "JetBrains Mono", use: "the editor, terminal and code", package: "@fontsource-variable/jetbrains-mono", kind: "fontsource" },
  { family: "Roboto", use: "text in exported PDFs", package: "pdfmake", kind: "vfs", file: "build/vfs_fonts.js", entry: "Roboto-Regular.ttf" },
  { family: "codicon", use: "the editor's own icons", package: "monaco-editor", kind: "ttf", file: "esm/vs/base/browser/ui/codicons/codicon/codicon.ttf" },
];

/** The weights the app offers to download: read out of the catalogue, never restated here. */
const MODELS = {
  source: "src-tauri/src/localai/catalogue.rs",
  url: "https://huggingface.co/ggml-org",
};

/**
 * Deliberate choices between the branches of a dual licence.
 *
 * A dual-licensed component gives *us* the choice, and the choice has consequences: taking
 * Apache-2.0 for DOMPurify is the difference between owing MPL-2.0 §3.2 for it and owing nothing.
 * Recording the election is what makes it an election rather than an ambiguity, so each one is
 * written down here with its reason and reprinted in the generated file.
 *
 * Anything not named here is elected by `PREFERENCE`, which only ever picks among branches the
 * component itself offers.
 */
const ELECTIONS = {
  dompurify: {
    take: "Apache-2.0",
    why: "the other branch is MPL-2.0; electing Apache-2.0 keeps DOMPurify out of the source-disclosure block above, and it ships unmodified either way",
  },
};

/** How an `A OR B` licence resolves when no explicit election covers it. First match wins. */
const PREFERENCE = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "ISC",
  "Zlib",
  "0BSD",
  "Unlicense",
  "BSL-1.0",
  "MIT-0",
  "CC0-1.0",
];

/**
 * Licence identifiers somebody has already looked at.
 *
 * Not a legal opinion — a memory. An identifier that is not in here has never been reviewed for
 * this project, so the script says so instead of quietly folding it into a table where it would
 * look exactly as settled as the other seven hundred rows.
 */
const REVIEWED = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "GPL-2.0-only WITH Classpath-exception-2.0",
  "GPL-2.0-only WITH GCC-exception-2.0",
  "ISC",
  "LGPL-2.1-or-later",
  "LicenseRef-InterSystems-IERTU (proprietary)",
  "LicenseRef-Oracle-FUTC (proprietary)",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
  "blessing",
]);

/** Copyleft that no permissive branch has disarmed. Stops the run; a person decides. */
const COPYLEFT = /\b(AGPL|LGPL|GPL-[123]|SSPL|CDDL|EPL-|OSL-|CPAL)/;

/** Copyleft that has been looked at and accepted, together with the reason it is safe to ship. */
const COPYLEFT_ALLOWED = new Map([
  ["GPL-2.0-only WITH Classpath-exception-2.0", "linking to the JDK's classes does not extend the GPL to CodeFlow"],
  ["GPL-2.0-only WITH GCC-exception-2.0", "libgit2's linking exception: linking it into a program and distributing that program is unrestricted"],
]);

/**
 * Copyleft that has been found shipping and **not** yet decided on, keyed by the `open` tag of the
 * row it belongs to. The run does not stop for these — the decision is recorded as pending, loudly,
 * in the generated file and on every run — but only the rows named here get that treatment.
 */
const OPEN = {
  xdiff: {
    title: "libgit2's xdiff is LGPL-2.1-or-later",
    body: (libgit2) => [
      `LibXDiff — the diff engine inside libgit2 ${libgit2.version}, in \`deps/xdiff/\` — is compiled into the`,
      "app on both platforms, and its files carry a licence header of their own: the GNU LGPL, version",
      "2.1 or later. libgit2's `COPYING` does not mention it separately. Section 6 of the LGPL-2.1",
      "attaches conditions to distributing a program statically linked with such a library: a",
      "prominent notice that it is used (this file), a copy of the LGPL itself, the library's source",
      `(libgit2's own, at <${libgit2.url}>), and terms that let the user modify the`,
      "library and relink the program — including the reverse engineering needed to debug that.",
      "Whether libgit2's linking exception already covers these files, or those conditions apply as",
      "written, is the maintainer's decision. Until it is made, this stays open rather than settled.",
    ],
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const targets = releaseTargets();
  const npm = collectNpm();
  const cargo = collectCargo(targets);
  const native = collectNative(cargo.packages);
  const bundled = collectBundled();
  const fonts = collectFonts(npm.dirs);
  const icons = collectIconSets(npm.dirs);
  const carried = collectCarriedNotices(npm.dirs, cargo.packages);
  const models = collectModels();

  audit([
    ...npm.components,
    ...cargo.components,
    ...native.map((row) => ({ name: row.name, declared: row.licence, elected: row.licence, open: row.open })),
    ...bundled.map((row) => ({ name: row.name, declared: row.licence, elected: row.licence })),
    ...fonts.map((row) => ({ name: row.family, declared: row.licence, elected: row.licence })),
    ...icons.map((row) => ({ name: row.name, declared: row.licence, elected: row.licence })),
  ]);
  warnAboutStaleConstants(npm, cargo);

  const markdown = render({ targets, npm: npm.components, cargo: cargo.components, native, bundled, fonts, icons, carried, models });
  const tally =
    `${resolved(npm.components)} npm packages, ${resolved(cargo.components)} crates, ` +
    `${native.filter((row) => !row.part).length} C libraries, ${bundled.length} bundled runtimes`;

  if (check) {
    const current = await readFile(OUT, "utf8").catch(() => "");
    if (current === markdown) {
      console.log(`notices: THIRD-PARTY-NOTICES.md is current — ${tally}.`);
      return;
    }
    throw new Error(
      "THIRD-PARTY-NOTICES.md is out of date.\n" +
        "        A dependency moved and the notices did not. Run `pnpm notices` and commit the result.\n" +
        firstDifference(current, markdown),
    );
  }

  await writeFile(OUT, markdown);
  console.log(`notices: THIRD-PARTY-NOTICES.md — ${tally}.`);
}

/** Where the committed file and the regenerated one part ways, so a failed check says what moved. */
function firstDifference(current, next) {
  if (current === "") return "        (THIRD-PARTY-NOTICES.md is missing.)";
  const a = current.split("\n");
  const b = next.split("\n");
  const line = a.findIndex((text, index) => text !== b[index]);
  const at = line < 0 ? a.length : line;
  return (
    `        First difference, line ${at + 1}:\n` +
    `          committed: ${a[at] ?? "(end of file)"}\n` +
    `          generated: ${b[at] ?? "(end of file)"}`
  );
}

/**
 * How many resolved versions a set of rows covers.
 *
 * Not the same as the number of rows, and the gap is wide: the Rust graph resolves several versions
 * of `windows-sys`, which is one row and several crates. Reporting rows as if they were crates would
 * undercount the tree.
 */
function resolved(components) {
  return components.reduce((count, component) => count + component.versions.length, 0);
}

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

/**
 * The release matrix, read back out of the workflow and held against `TARGETS`.
 *
 * Only the runner names can be read — the workflow never spells a triple — so the comparison is on
 * those, and the triple each runner produces is the fact `TARGETS` records.
 */
function releaseTargets() {
  const workflow = readRepo(".github/workflows/release.yml");
  const runners = [...workflow.matchAll(/^\s*-\s*platform:\s*(\S+)/gm)].map((match) => match[1]);
  const known = TARGETS.map((target) => target.runner);
  const same = runners.length === known.length && runners.every((runner) => known.includes(runner));
  if (!same) {
    throw new Error(
      `.github/workflows/release.yml builds on [${runners.join(", ")}] but TARGETS lists [${known.join(", ")}].\n` +
        "        A platform was added to or removed from the release. Update TARGETS with the triple it builds.",
    );
  }
  return TARGETS;
}

/**
 * The npm side, from pnpm's own view of the installed tree.
 *
 * `--prod` and not the whole tree: devDependencies build the app, they do not ship in it. The one
 * that looks like an exception is `monaco-editor`, and it is not one — it is a peer of
 * `@monaco-editor/react`, so pnpm resolves it into the production tree and it appears below on its
 * own merits rather than because of a special case here.
 */
function collectNpm() {
  warnIfInstallIsStale();
  const raw = run("pnpm", ["licenses", "list", "--json", "--prod"], ROOT, "pnpm licenses list");

  let grouped;
  try {
    grouped = JSON.parse(raw);
  } catch {
    throw new Error("`pnpm licenses list` produced no JSON — run `pnpm install` first.");
  }

  const components = [];
  const dirs = new Map();
  for (const packages of Object.values(grouped)) {
    for (const pkg of packages) {
      const declared = normalise(pkg.license);
      components.push({
        name: pkg.name,
        versions: [...new Set(pkg.versions)].sort(byText),
        declared,
        elected: elect(pkg.name, declared),
        url: pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`,
      });
      const known = dirs.get(pkg.name) ?? [];
      pkg.versions.forEach((version, index) => known.push({ version, dir: pkg.paths[index] }));
      dirs.set(pkg.name, known);
    }
  }
  for (const entries of dirs.values()) entries.sort((a, b) => byText(a.version, b.version));
  return { components: dedupe(components), dirs };
}

/**
 * `pnpm licenses list` describes `node_modules`, not the lockfile. pnpm keeps a copy of the
 * lockfile it last installed from; when that copy and the committed one differ, the npm tables
 * would describe a tree CI will never see, so say so before writing them.
 */
function warnIfInstallIsStale() {
  const installed = join(ROOT, "node_modules", ".pnpm", "lock.yaml");
  if (!existsSync(installed)) return;
  if (readFileSync(installed, "utf8") !== readRepo("pnpm-lock.yaml")) {
    console.warn(
      "notices: node_modules was installed from a different pnpm-lock.yaml than the one on disk —" +
        " run `pnpm install` first, or the npm tables will not match what CI generates.",
    );
  }
}

/**
 * The Rust side, from the resolved graph rather than from `Cargo.toml`'s direct lines.
 *
 * Filtered to `TARGETS`, then walked through normal and build dependencies from the root. Dev
 * dependencies are skipped — a crate that only a `#[test]` reaches is not in the installer.
 *
 * `--locked` because a notices run must never be the thing that rewrites `Cargo.lock`, and
 * `--offline` first because everything it needs is normally already in the registry cache.
 */
function collectCargo(targets) {
  const cwd = join(ROOT, "src-tauri");
  const args = [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    ...targets.flatMap((target) => ["--filter-platform", target.triple]),
  ];

  let result = spawn("cargo", [...args, "--offline"], cwd);
  if (result.status !== 0 && !result.error && !offline) {
    console.warn(
      "notices: cargo could not resolve the graph offline — retrying with network access, which a cold" +
        " registry cache needs (pass --offline to forbid this).",
    );
    result = spawn("cargo", args, cwd);
  }
  if (result.status !== 0 && /--locked/.test(result.stderr ?? "")) {
    fail(
      "src-tauri/Cargo.lock is behind src-tauri/Cargo.toml, and a notices run never rewrites it.\n" +
        "        Let cargo catch the lockfile up first (`cargo check` in src-tauri), then run this again.",
    );
  }
  const raw = output(result, "cargo metadata", offline ? " (offline: the registry cache is missing crates — run `cargo fetch` in src-tauri once)" : "");
  const metadata = JSON.parse(raw);

  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));

  const reached = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = dep.dep_kinds ?? [];
      if (kinds.length > 0 && !kinds.some((kind) => kind.kind === null || kind.kind === "build")) continue;
      pending.push(dep.pkg);
    }
  }

  const components = [];
  const packages = new Map();
  for (const id of reached) {
    if (id === metadata.resolve.root) continue;
    const pkg = byId.get(id);
    if (!pkg) continue;
    if (!pkg.license && !pkg.license_file) {
      throw new Error(
        `${pkg.name} ${pkg.version} declares no licence at all.\n` +
          "        Read its repository before shipping it, then record what you found.",
      );
    }
    const declared = pkg.license ? normalise(pkg.license) : `see ${pkg.license_file} in the crate`;
    components.push({
      name: pkg.name,
      versions: [pkg.version],
      declared,
      elected: elect(pkg.name, declared),
      url: pkg.repository || pkg.homepage || `https://crates.io/crates/${pkg.name}`,
    });
    const known = packages.get(pkg.name) ?? [];
    known.push(pkg);
    packages.set(pkg.name, known);
  }
  for (const list of packages.values()) list.sort((a, b) => byText(a.version, b.version));
  return { components: dedupe(components), packages };
}

/** The C libraries in `NATIVE`, proved against the source each crate actually carries. */
function collectNative(packages) {
  const rows = [];
  for (const [crate, spec] of Object.entries(NATIVE)) {
    for (const pkg of packages.get(crate) ?? []) {
      const dir = dirname(pkg.manifest_path);
      const version = spec.version(dir);
      proveIn(dir, spec.proof, `${spec.library} in ${crate} ${pkg.version}`, spec.licence);
      const row = {
        name: spec.library,
        version,
        licence: spec.licence,
        on: spec.on,
        from: `\`${crate}\` ${pkg.version}`,
        url: spec.url(version),
        notice: spec.notice,
        part: false,
      };
      rows.push(row);
      for (const part of spec.parts ?? []) {
        proveIn(dir, part.proof, `${part.library} in ${crate} ${pkg.version}`, part.licence);
        rows.push({
          name: part.library,
          version: part.version ? part.version(dir) : null,
          licence: part.licence,
          on: spec.on,
          from: `${spec.library}'s \`${part.path}\``,
          url: row.url,
          open: part.open,
          parent: row,
          part: true,
        });
      }
    }
  }

  for (const list of packages.values()) {
    for (const pkg of list) {
      if (!pkg.links || NATIVE[pkg.name] || LINKS_REVIEWED.some((entry) => matches(entry.name, pkg.name))) continue;
      console.warn(
        `notices: ${pkg.name} ${pkg.version} declares \`links = "${pkg.links}"\` and has never been reviewed for` +
          " native code it compiles in. Read its build script, then add it to NATIVE or LINKS_REVIEWED.",
      );
    }
  }
  return rows;
}

function collectBundled() {
  return BUNDLED.map((entry) => {
    const version = entry.version();
    entry.verify?.(version);
    return { ...entry, version, ships: entry.ships.replace("<version>", version) };
  });
}

/** The fonts in `FONTS`, each licence read from the font's own package or the font itself. */
function collectFonts(npmDirs) {
  const rows = [];
  for (const font of FONTS) {
    const install = npmDirs.get(font.package)?.[0];
    if (!install) continue;
    const { dir, version } = install;

    if (font.kind === "fontsource") {
      const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (meta.family !== font.family) fail(`${font.package} now describes "${meta.family}", not "${font.family}" — update FONTS`);
      if (meta.license?.type !== pkg.license) {
        fail(`${font.package}: metadata.json says ${meta.license?.type} and package.json says ${pkg.license} — read its LICENSE`);
      }
      rows.push({
        family: meta.family,
        version: `${version} (upstream ${meta.version})`,
        licence: meta.license.type,
        ships: `\`${font.package}\``,
        use: font.use,
        copyright: firstSentence(meta.license.attribution),
        inherited: false,
      });
      continue;
    }

    let bytes;
    if (font.kind === "vfs") {
      const source = readFileSync(join(dir, font.file), "utf8");
      const quoted = font.entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = source.match(new RegExp(`"${quoted}"\\s*:\\s*"([A-Za-z0-9+/=]+)"`));
      if (!match) fail(`${font.entry} is no longer embedded in ${font.package}/${font.file} — update FONTS`);
      bytes = Buffer.from(match[1], "base64");
    } else {
      bytes = readFileSync(join(dir, font.file));
    }

    const names = fontNames(bytes, `${font.package}/${font.file}`);
    if (names[1] !== font.family) fail(`${font.package}/${font.file} is now "${names[1]}", not "${font.family}" — update FONTS`);
    const own = names[13] ? fontLicence(names[13], `${font.family} in ${font.package}`) : null;
    const packageLicence = normalise(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).license);
    rows.push({
      family: names[1],
      version: (names[5] ?? "").replace(/^Version\s+/i, "").replace(/;.*$/, "") || "—",
      licence: own ?? packageLicence,
      ships: `inside \`${font.package}\` ${version} (\`${font.file}\`)`,
      use: font.use,
      copyright: names[0] ?? null,
      inherited: own === null,
      package: font.package,
    });
  }
  return rows;
}

/** Every `@iconify-json/*` set in the production tree, described by its own `info.json`. */
function collectIconSets(npmDirs) {
  const rows = [];
  const names = [...npmDirs.keys()].filter((name) => name.startsWith("@iconify-json/")).sort(byText);
  for (const name of names) {
    const { dir, version } = npmDirs.get(name)[0];
    const path = join(dir, "info.json");
    if (!existsSync(path)) fail(`${name} has no info.json — its licence cannot be read offline. Read its README and record it.`);
    const info = JSON.parse(readFileSync(path, "utf8"));
    const licence = info.license?.spdx;
    if (!licence) fail(`${name}'s info.json names no SPDX licence (${info.license?.title ?? "none"}) — read ${info.license?.url ?? "its README"}`);
    rows.push({
      name: info.name ?? name,
      package: name,
      version,
      upstream: info.version ?? null,
      author: info.author?.name ?? "—",
      authorUrl: info.author?.url ?? null,
      licence,
      licenceUrl: info.license?.url ?? null,
      total: info.total ?? null,
    });
  }
  return rows;
}

/**
 * Notices files the components carry beside their licence — `NOTICE`, `ThirdPartyNotices.txt` and
 * the like — for code they incorporated from elsewhere. Listed, not reprinted: the copy inside the
 * published package is the authoritative one.
 */
function collectCarriedNotices(npmDirs, packages) {
  const NOTICE = /^(NOTICE|NOTICES|THIRD[-_]?PARTY([-_]?NOTICES)?|ThirdPartyNotices)(\.[A-Za-z]+)?$/i;
  const filesIn = (dir) => {
    try {
      return readdirSync(dir)
        .filter((file) => NOTICE.test(file) && statSync(join(dir, file)).isFile())
        .sort(byText);
    } catch {
      return [];
    }
  };

  const rows = [];
  for (const [name, installs] of npmDirs) {
    for (const { dir, version } of installs) {
      const files = filesIn(dir);
      if (files.length > 0) rows.push({ name, version, files, kind: "npm" });
    }
  }
  for (const [name, list] of packages) {
    for (const pkg of list) {
      const files = filesIn(dirname(pkg.manifest_path));
      if (files.length > 0) rows.push({ name, version: pkg.version, files, kind: "crate" });
    }
  }
  return rows.sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));
}

/** The downloadable models, read out of the Rust catalogue that offers them. */
function collectModels() {
  const source = readRepo(MODELS.source);
  const block = source.match(/pub const CATALOGUE: &\[ModelSpec\] = &\[([\s\S]*?)\n\];/)?.[1];
  if (!block) fail(`could not find CATALOGUE in ${MODELS.source} — it was renamed or reshaped. Fix collectModels.`);
  const models = [...block.matchAll(/ModelSpec \{([\s\S]*?)\n\s*\},/g)].map((match) => {
    const field = (name) => match[1].match(new RegExp(`\\b${name}: "([^"]+)"`))?.[1];
    const model = { label: field("label"), repo: field("repo"), licence: field("licence") };
    if (!model.label || !model.repo || !model.licence) fail(`a CATALOGUE entry in ${MODELS.source} no longer has label, repo and licence`);
    return model;
  });
  if (models.length === 0) fail(`CATALOGUE in ${MODELS.source} parsed as empty — fix collectModels.`);
  return models;
}

// ---------------------------------------------------------------------------
// Licence arithmetic
// ---------------------------------------------------------------------------

/**
 * Puts a licence expression into one shape, so the tables group by meaning rather than by
 * punctuation.
 *
 * crates.io has accepted free text in this field for a decade, so the same permissive pair arrives
 * as `MIT/Apache-2.0`, `MIT OR Apache-2.0`, `Apache-2.0 / MIT` and `Apache-2.0/MIT` — four headings
 * for one licence. npm adds a fifth spelling by wrapping compound expressions in parentheses.
 * Slashes become `OR`, wrapping parentheses go, and a pure `OR` chain is sorted.
 *
 * Only a pure chain. `OR` is commutative, so sorting one preserves its meaning even when a branch
 * carries a `WITH`; `AND` is not, and neither is a parenthesised sub-expression, so an expression
 * containing either is left exactly as declared.
 */
function normalise(expression) {
  const text = unwrap(
    String(expression)
      .replace(/\s*\/\s*/g, " OR ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (compound(text)) return text;
  const parts = text.split(/\s+OR\s+/);
  return parts.length > 1 ? [...new Set(parts)].sort(byText).join(" OR ") : text;
}

/** `(MIT OR Apache-2.0)` -> `MIT OR Apache-2.0`, but `(A OR B) AND C` is left alone. */
function unwrap(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    if (depth === 0 && i < text.length - 1) return text;
  }
  return unwrap(text.slice(1, -1).trim());
}

/** An expression whose operands cannot be reordered without changing what it says. */
function compound(expression) {
  return /\bAND\b|[()]/.test(expression);
}

/** Which branch of a dual licence CodeFlow takes. See `ELECTIONS`. */
function elect(name, declared) {
  const explicit = ELECTIONS[name];
  if (explicit) return explicit.take;
  if (compound(declared)) return declared;
  const parts = declared.split(/\s+OR\s+/);
  if (parts.length === 1) return declared;
  return PREFERENCE.find((candidate) => parts.includes(candidate)) ?? declared;
}

/** The SPDX identifier for the licence sentence a font's `name` table carries (name ID 13). */
function fontLicence(text, what) {
  if (/SIL Open Font License,? Version 1\.1/i.test(text)) return "OFL-1.1";
  fail(`${what} says its licence is "${text}", which this script has never mapped — read it, then teach fontLicence.`);
}

/**
 * The guard.
 *
 * Two failures, deliberately different in severity. An identifier nobody has reviewed is worth a
 * warning: the usual cause is a new permissive licence and the usual fix is one line in `REVIEWED`.
 * Copyleft that no election disarmed is worth stopping for, because the usual fix is not a line in
 * this file at all — unless the row is an open item in `OPEN`, which is reported instead.
 */
function audit(components) {
  const unreviewed = new Map();
  const blocking = [];

  for (const component of components) {
    const licence = component.elected;

    if (COPYLEFT.test(licence) && !COPYLEFT_ALLOWED.has(licence)) {
      if (component.open && OPEN[component.open]) {
        console.warn(`notices: open item — ${OPEN[component.open].title}. See "Open items" in THIRD-PARTY-NOTICES.md.`);
        continue;
      }
      blocking.push(`${component.name} — declared ${component.declared}`);
      continue;
    }
    if (REVIEWED.has(licence)) continue;

    for (const part of licence.split(/\s+(?:OR|AND)\s+/)) {
      const id = part.replace(/[()]/g, "").trim();
      if (!id || REVIEWED.has(id)) continue;
      if (!unreviewed.has(id)) unreviewed.set(id, []);
      unreviewed.get(id).push(component.name);
    }
  }

  for (const [licence, names] of unreviewed) {
    const shown = names.slice(0, 4).join(", ");
    const rest = names.length > 4 ? `, +${names.length - 4} more` : "";
    console.warn(`notices: ${licence} has never been reviewed for this project — ${shown}${rest}`);
    console.warn("notices: read it, then add it to REVIEWED in scripts/build-third-party-notices.mjs.");
  }

  if (blocking.length > 0) {
    throw new Error(
      "copyleft with no permissive branch, and no recorded decision:\n" +
        blocking.map((line) => `          ${line}`).join("\n") +
        "\n        This is not a table entry. Decide whether it can ship at all, then either drop" +
        "\n        the dependency or record the decision in COPYLEFT_ALLOWED with the notice it needs.",
    );
  }
}

/** Constants that name something the tree no longer has: harmless, but a sign of drift. */
function warnAboutStaleConstants(npm, cargo) {
  const everything = new Set([...npm.components, ...cargo.components].map((component) => component.name));
  for (const name of Object.keys(ELECTIONS)) {
    if (!everything.has(name)) console.warn(`notices: ELECTIONS names ${name}, which is no longer shipped — remove it.`);
  }
  for (const name of Object.keys(NATIVE)) {
    if (!cargo.packages.has(name)) console.warn(`notices: NATIVE names ${name}, which is no longer in the graph — remove it.`);
  }
  for (const entry of LINKS_REVIEWED) {
    if (typeof entry.name === "string" && !cargo.packages.has(entry.name)) {
      console.warn(`notices: LINKS_REVIEWED names ${entry.name}, which is no longer in the graph — remove it.`);
    }
  }
  for (const font of FONTS) {
    if (!npm.dirs.has(font.package)) console.warn(`notices: FONTS names ${font.package}, which is no longer shipped — remove it.`);
  }

  // Font files in a production package that no FONTS row accounts for. The fonts a package merely
  // carries are not necessarily shipped, but whether they are is exactly what nobody has checked.
  const covered = new Set(FONTS.map((font) => font.package));
  for (const [name, installs] of npm.dirs) {
    if (covered.has(name)) continue;
    for (const { dir, version } of installs) {
      const found = fontFiles(dir);
      if (found > 0) {
        console.warn(
          `notices: ${name} ${version} carries ${found} font file(s) and no FONTS row. If the app ships them,` +
            " add the font to FONTS with the licence read from it.",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Said once, printed above both tables, because both are grouped by a rewritten expression. */
const NORMALISATION = [
  "Licence expressions are shown normalised: a `/` separator becomes `OR`, wrapping parentheses are",
  "dropped, and the branches of an `OR` are sorted, so that one licence gets one heading instead of",
  "four spellings. Expressions containing `AND` are left exactly as their manifest declares them,",
  "because there the order carries meaning.",
].join("\n");

function render({ targets, npm, cargo, native, bundled, fonts, icons, carried, models }) {
  const mpl = [...npm, ...cargo].filter((component) => component.elected === "MPL-2.0").sort(byName);
  const elected = [...npm, ...cargo].filter((component) => ELECTIONS[component.name]).sort(byName);
  const jdk = bundled.find((entry) => entry.notice === "jdk");
  const iris = bundled.find((entry) => entry.notice === "iris");
  const oracle = bundled.find((entry) => entry.notice === "oracle");
  const libgit2 = native.find((row) => row.notice === "libgit2");
  const shipped = (name) => npm.some((component) => component.name === name);
  const platforms = targets.map((target) => target.label).join(" and ");

  // Open items belong to rows: one disappears with the component it is about.
  const open = [];
  for (const row of native) {
    if (row.open && OPEN[row.open]) open.push({ ...OPEN[row.open], lines: OPEN[row.open].body(row.parent ?? row) });
  }

  const out = [];
  const w = (...lines) => out.push(...lines);

  w(
    "# Third-party notices",
    "",
    "CodeFlow ships code that CodeFlow did not write. This file lists it, names the licence each piece",
    "is under, and carries the notices some of those licences require us to pass on to you. It is what",
    "[section 6 of `LICENSE`](LICENSE) refers to.",
    "",
    "Nothing here changes CodeFlow's own licence, and nothing in CodeFlow's licence takes away a",
    "right one of these licences grants you. Where the two disagree about a component, the",
    "component's own licence wins — which is what section 6 says.",
    "",
    "> **Generated file — do not edit by hand.** `pnpm notices` rebuilds it from the resolved",
    "> dependency trees; `pnpm notices:check` fails when what is committed has gone stale. The",
    "> generator is [`scripts/build-third-party-notices.mjs`](scripts/build-third-party-notices.mjs),",
    "> and the facts it cannot read out of a lockfile — the bundled runtimes, the C libraries inside",
    "> the Rust crates, the licence elections — live in named constants at the top of it, which is the",
    "> only place to change them.",
    "",
    "| What ships | Count |",
    "|---|---|",
    `| npm packages (production tree) | ${resolved(npm)} resolved versions of ${npm.length} packages |`,
    `| Rust crates (resolved for ${platforms}) | ${resolved(cargo)} resolved versions of ${cargo.length} crates |`,
    `| C libraries compiled into the app | ${native.filter((row) => !row.part).length}, plus ${native.filter((row) => row.part).length} bundled inside them |`,
    `| Runtimes, drivers and web apps bundled with it | ${bundled.length} |`,
    `| Fonts | ${fonts.length} |`,
    `| Icon sets | ${icons.length} |`,
    "",
    "A package resolved at two versions gets one row carrying both, which is why the first two counts",
    "differ.",
    "",
  );

  // -- The notices that are the point of the file --------------------------

  w(
    "## Notices you are owed",
    "",
    "Most of what follows asks only that its licence travel with it, which this file does. The",
    "components below ask for something specific, and this is it.",
    "",
    "### MPL-2.0 — where to get the source",
    "",
  );

  if (mpl.length === 0) {
    w("CodeFlow currently ships nothing under the MPL-2.0.", "");
  } else {
    w(
      "CodeFlow's installers are Executable Form. [Section 3.2(a) of the Mozilla Public License",
      "2.0](https://www.mozilla.org/en-US/MPL/2.0/) requires that we tell you how to obtain the",
      "Source Code Form of the files it covers, so:",
      "",
      "> **The Source Code Form of the MPL-2.0 components listed below is available to you, at no",
      "> charge, at the project URL given for each one, at the exact version listed. If you would",
      "> rather not fetch it yourself, open an issue at",
      `> <${REPO}/issues> and we will send you a copy at no`,
      "> charge. This offer is good for any recipient of an Official Build.**",
      "",
      "These components ship **unmodified**. CodeFlow adds no Modifications to any MPL-2.0 file, so",
      "the Source Code Form upstream publishes is the Source Code Form inside the installer.",
      "",
      table(mpl),
      "",
    );
    if (shipped("@novnc/novnc")) {
      w(
        "noVNC's core — the VNC client behind the Remote workspace's desktop viewer — is bundled into",
        "the frontend, minified. Its own `LICENSE.txt` names the files that core took from elsewhere",
        "under MPL-compatible licences: `vendor/pako/` (MIT) and `core/des.js` (BSD-style).",
        "",
      );
    }
  }

  if (jdk) {
    w(
      "### The bundled Java runtime — GPL-2.0 with the Classpath Exception",
      "",
      `\`resources/iris/runtime/\` is an OpenJDK image, built by \`jlink\` from Eclipse Temurin ${jdk.version}`,
      "and shipped inside the installer so that nobody has to install Java to reach an IRIS or Oracle",
      "database. It is [GPL-2.0-only WITH Classpath-exception-2.0](https://openjdk.org/legal/gplv2+ce.html).",
      "",
      "The Classpath Exception is what makes it safe to ship next to CodeFlow's own code: linking to",
      "these classes does not make CodeFlow a derivative work, and CodeFlow's licence is unaffected.",
      "The runtime's own source obligation is unaffected too, so:",
      "",
      "> **The complete corresponding source for the bundled Java runtime is published by the",
      `> Adoptium project at <https://github.com/adoptium/jdk${major(jdk.version)}u>, and the exact`,
      `> builds at <${jdk.url}>. If you would rather not fetch it yourself,`,
      `> open an issue at <${REPO}/issues> and we will`,
      "> send you a copy at no charge.**",
      "",
      "The image carries its own `legal/` directory — the licence of every module in it, and the",
      "notices for the third-party code OpenJDK itself incorporates — and that directory ships inside",
      "the installer with it.",
      "",
      "It is produced by `scripts/build-iris-runtime.mjs` from whichever JDK is on the build machine.",
      "The version above is the one the release workflow pins, and so the one every Official Build",
      "contains; a build made on some other JDK carries that JDK's licence instead.",
      "",
    );
  }

  if (libgit2) {
    w(
      "### libgit2 — GPL-2.0 with a linking exception",
      "",
      `The Git engine is libgit2 ${libgit2.version}, compiled into the app's own binary from the copy inside the`,
      "`libgit2-sys` crate and shipped unmodified. Its `COPYING` puts it under the GPL-2.0 with what it",
      "calls a *linking exception* (SPDX: `GPL-2.0-only WITH GCC-exception-2.0`): linking the compiled",
      "library into a program, and distributing that program, carries no restriction from libgit2's",
      "licence. The GPL still governs libgit2's own files, whose source at the exact version is",
      `<${libgit2.url}>.`,
      "",
      "libgit2 compiles in pieces of other projects under licences of their own. They are listed with",
      "it under *C libraries compiled into the app* below, and one of them is an open item.",
      "",
    );
  }

  if (iris) {
    w(
      "### The InterSystems JDBC driver — its terms must travel with it",
      "",
      `\`${iris.ships.replace(/`/g, "")}\` is InterSystems' own driver, downloaded from Maven Central`,
      "and shipped unmodified. It is **not** open source: its POM points at the",
      `[InterSystems External Repository Terms of Use](${iris.terms}), which allow redistribution on`,
      "conditions — among them that a copy of those terms accompany every distribution of the driver,",
      "that no fee be charged for its distribution or use, that its markings and notices stay in place,",
      "and that it be neither modified nor reverse engineered. CodeFlow ships it verbatim and free of",
      "charge. The copy travels with it: the terms as InterSystems publishes them are kept in this",
      "repository, in `scripts/assets/`, and `scripts/build-iris-runtime.mjs` writes them beside the jar",
      "as `resources/iris/InterSystems-External-Repository-Terms-of-Use.pdf`, which the installer carries",
      "in the app's `iris/` resources. A build without them fails rather than ship the driver alone.",
      "",
    );
  }

  if (oracle) {
    w(
      "### The Oracle JDBC driver — its licence travels inside the jar",
      "",
      `\`${oracle.ships.replace(/`/g, "")}\` is Oracle's thin JDBC driver, downloaded from Maven Central`,
      "and shipped unmodified; it is what lets Oracle connections work with no Oracle client installed.",
      "It is **not** open source either. Its licence is `META-INF/license.txt` inside the jar itself,",
      "titled *Oracle Free Distribution, Hosting, and Use Terms and Conditions* — the terms",
      "`scripts/build-iris-runtime.mjs` calls the Oracle Free Use Terms and Conditions. They allow",
      "redistributing the unmodified driver on conditions much like InterSystems': a copy of the",
      "licence with every distribution, no additional fee for it, its markings and notices left in",
      "place, no reverse engineering. The jar carries its licence wherever it goes, which is how the",
      "copy requirement is met.",
      "",
    );
  }

  if (open.length > 0) {
    w("### Open items", "", "Found, written down, and not yet resolved:", "");
    for (const item of open) {
      w(`- **${item.title}.**`, ...item.lines.map((line) => `  ${line}`));
    }
    w("");
  }

  // -- Elections -----------------------------------------------------------

  w(
    "## Where a licence offered a choice",
    "",
    "A dual-licensed component gives the distributor the choice, and the choice has consequences.",
    `Unless named below, CodeFlow takes the first of ${PREFERENCE.slice(0, 4)
      .map((id) => `\`${id}\``)
      .join(", ")} … that the component offers.`,
    "These are the elections made deliberately:",
    "",
  );

  if (elected.length === 0) {
    w("_None recorded._", "");
  } else {
    w("| Component | Declared | CodeFlow takes | Why |", "|---|---|---|---|");
    for (const component of elected) {
      w(`| \`${component.name}\` | ${component.declared} | **${component.elected}** | ${ELECTIONS[component.name].why} |`);
    }
    w("");
  }

  // -- Bundled -------------------------------------------------------------

  w(
    "## Runtimes, drivers and web apps bundled with it",
    "",
    "These are not dependencies of the app's source. They are third-party programs fetched or built",
    "at build time and copied into the installer — the first four through `bundle.resources` in",
    "`tauri.conf.json`, draw.io through the frontend bundle. llama.cpp, the two drivers and draw.io are",
    "pinned by version and verified against a SHA-256 by the script that fetches them; the Java",
    "runtime is cut by `jlink` from the JDK the release workflow installs.",
    "",
    "| Component | Version | Licence (SPDX) | Project | Ships as | Fetched by |",
    "|---|---|---|---|---|---|",
  );
  for (const entry of bundled) {
    w(`| ${entry.name} | \`${entry.version}\` | ${entry.licence} | <${entry.url}> | ${entry.ships} | \`${entry.by}\` |`);
  }
  w(
    "",
    "llama.cpp's `LICENSE` is copied next to its binaries by its build script, so it travels inside",
    "the installer as well as being listed here. draw.io and llama.cpp both carry third-party code of",
    "their own inside what they publish; their repositories at the pinned versions, linked above, are",
    "the authoritative record of it.",
    "",
  );

  // -- Native --------------------------------------------------------------

  w(
    "## C libraries compiled into the app",
    "",
    "Some Rust crates below are thin bindings to a C library they carry a copy of and compile into",
    "the app's binary. The crate's licence covers the bindings; the library arrives under its own,",
    "listed here. Each licence is re-read from the crate's copy of the library on every regeneration.",
    "",
    "| Library | Version | Licence (SPDX) | Compiled in on | Comes from |",
    "|---|---|---|---|---|",
  );
  for (const row of native) {
    const name = row.part ? `↳ ${row.name}` : `**${row.name}**`;
    w(`| ${name} | ${row.version ? `\`${row.version}\`` : "—"} | ${row.licence} | ${row.on.join(", ")} | ${row.from} |`);
  }
  w(
    "",
    "Where a library is compiled in on one platform only, the other uses the operating system's own:",
    "macOS's zlib, and on Windows the CNG cryptography libssh2 uses in place of OpenSSL.",
    "",
  );

  // -- Fonts ---------------------------------------------------------------

  w(
    "## Fonts",
    "",
    "| Font | Version | Licence (SPDX) | Used for | Ships in | Copyright |",
    "|---|---|---|---|---|---|",
  );
  for (const font of fonts) {
    w(`| ${font.family} | ${font.version} | ${font.licence} | ${font.use} | ${font.ships} | ${font.copyright ?? "—"} |`);
  }
  w(
    "",
    "Each OFL font carries its copyright notice and licence in its own metadata, which is where the",
    "SIL Open Font License allows them to travel; they are repeated here.",
  );
  for (const font of fonts.filter((row) => row.inherited)) {
    w(
      `The ${font.family} font declares no licence of its own and ships as part of \`${font.package}\`, under`,
      `that package's (${font.licence}).`,
    );
  }
  w("");

  // -- Icons ---------------------------------------------------------------

  if (icons.length > 0) {
    w(
      "## Icon sets",
      "",
      "The file-icon packs draw from these [Iconify](https://iconify.design/) sets, shipped as JSON and",
      "loaded on demand. Each set's licence is the one its own `info.json` declares.",
      "",
      "| Set | Package | Version | Licence (SPDX) | Author | Icons |",
      "|---|---|---|---|---|---|",
    );
    for (const set of icons) {
      const author = set.authorUrl ? `[${set.author}](${set.authorUrl})` : set.author;
      const version = set.upstream ? `${set.version} (upstream ${set.upstream})` : set.version;
      w(`| ${set.name} | \`${set.package}\` | ${version} | ${set.licence} | ${author} | ${set.total ?? "—"} |`);
    }
    w(
      "",
      "A licence on a logo set covers the drawings, not the brands: the marks remain their owners'",
      "trademarks, and CodeFlow uses them only to identify the tools and services they stand for.",
    );
    if (shipped("lucide-react")) {
      w("The interface's own icons are Lucide (`lucide-react`), listed with the npm packages below.");
    }
    w("");
  }

  // -- npm -----------------------------------------------------------------

  w(
    "## npm packages",
    "",
    "The installed production tree — what `pnpm licenses list --prod` reports, which is the",
    "lockfile's resolution rather than the ranges in `package.json`. devDependencies build the app and",
    "do not ship in it, so they are absent.",
  );
  if (shipped("monaco-editor")) {
    w(
      "`monaco-editor` appears because it is a peer dependency of `@monaco-editor/react` and so",
      "resolves into the production tree.",
    );
  }
  if (shipped("pdfmake")) {
    w(
      "A package that ships a prebuilt bundle carries code from its own dependencies inside it —",
      "pdfmake's browser build, for one — and that package's licence files are the record of what is",
      "in there.",
    );
  }
  w("", NORMALISATION, "", ...byLicence(npm, ["package", "packages"]));

  // -- Rust ----------------------------------------------------------------

  w(
    "## Rust crates",
    "",
    "The resolved graph from `src-tauri/Cargo.lock`, filtered to the platforms a release is built",
    `for (${targets.map((target) => `\`${target.triple}\``).join(", ")}) and walked from the \`codeflow\``,
    "crate through normal and build dependencies. Dev-dependencies are excluded, because nothing a",
    "`#[test]` reaches ends up in an installer; so are crates only another platform would pull — GTK",
    "and D-Bus on Linux, the Android and wasm bindings — for the same reason.",
    "",
    NORMALISATION,
    "",
    ...byLicence(cargo, ["crate", "crates"]),
  );

  // -- Carried notices -----------------------------------------------------

  if (carried.length > 0) {
    w(
      "## Notices the components carry themselves",
      "",
      "Some components carry a notices file beside their licence, for code they took from elsewhere or",
      "for files licensed differently from the rest. Those files are inside the published package at",
      "the version listed, and they are the authoritative record of what they cover.",
      "",
      "| Component | Version | Kind | File |",
      "|---|---|---|---|",
    );
    for (const row of carried) {
      w(`| \`${row.name}\` | ${row.version} | ${row.kind} | ${row.files.map((file) => `\`${file}\``).join(", ")} |`);
    }
    w("");
  }

  // -- Runtime downloads ---------------------------------------------------

  w(
    "## Models downloaded at runtime",
    "",
    "Not redistributed, and in no installer: if you turn on local completion, the app downloads the",
    "model you pick into your own data directory. They are listed here because the app offers them.",
    "",
    `The catalogue in [\`${MODELS.source}\`](${MODELS.source}) offers only weights under a licence the app`,
    "can point at, and a test there fails the build for any other. The conversions are published at",
    `<${MODELS.url}>.`,
    "",
    "| Model | Licence (SPDX) | Published at |",
    "|---|---|---|",
  );
  for (const model of models) {
    w(`| ${model.label} | ${model.licence} | <https://huggingface.co/${model.repo}> |`);
  }
  w("");

  // -- Keeping it honest ---------------------------------------------------

  w(
    "## Licence texts",
    "",
    "Every licence named in this file is published verbatim by SPDX at",
    "`https://spdx.org/licenses/<identifier>.html` — for example",
    "<https://spdx.org/licenses/MPL-2.0.html>. Each npm package and each crate also carries its own",
    "licence file inside the published artefact, and that copy is the authoritative one for that",
    "component: it holds the copyright line these tables have no column for. The two proprietary",
    "driver licences have no SPDX page; they are the documents named in their sections above.",
    "",
    "## Keeping this file honest",
    "",
    "`pnpm notices` regenerates it. `pnpm notices:check` fails when what is committed is not what the",
    "current dependency tree would produce, which is what makes a forgotten regeneration a build",
    "failure rather than a quiet inaccuracy. The generator refuses to run when a dependency arrives",
    "under copyleft that no dual-licence election disarms, re-reads the licence of every C library",
    "compiled into the binary from that library's own source, and warns when a licence identifier or",
    "a crate that links native code turns up that has never been reviewed for this project.",
  );
  if (open.length > 0) {
    w("", `What is still open is listed under *Open items* above — ${open.length === 1 ? "one item" : `${open.length} items`}, each waiting on a decision rather than on this file.`);
  }
  w("");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** One table per licence, heaviest group first, so the interesting tails are not buried. */
function byLicence(components, [one, many]) {
  const groups = new Map();
  for (const component of components) {
    if (!groups.has(component.declared)) groups.set(component.declared, []);
    groups.get(component.declared).push(component);
  }

  const lines = [];
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || byText(a[0], b[0]));
  for (const [licence, members] of ordered) {
    lines.push(
      `### ${licence} — ${members.length} ${members.length === 1 ? one : many}`,
      "",
      table(members.sort(byName)),
      "",
    );
  }
  return lines;
}

function table(components) {
  const rows = ["| Component | Version | Licence (SPDX) | Project |", "|---|---|---|---|"];
  for (const component of components) {
    rows.push(`| \`${component.name}\` | ${component.versions.join(", ")} | ${component.declared} | ${link(component.url)} |`);
  }
  return rows.join("\n");
}

/** crates.io and npm both carry `git+ssh` and `.git` URLs that a Markdown reader cannot follow. */
function link(url) {
  const cleaned = String(url)
    .trim()
    .replace(/^git\+/, "")
    .replace(/^(?:git|ssh):\/\/git@/, "https://")
    .replace(/#readme$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return /^https?:\/\//.test(cleaned) ? `<${cleaned}>` : cleaned;
}

/**
 * Code-point order, never the locale's. `localeCompare` follows the machine's collation, which is
 * exactly the kind of input a file that CI compares byte for byte must not have.
 */
function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a, b) {
  return byText(a.name, b.name);
}

/** The same package can arrive twice — two versions of it, or one version under two spellings. */
function dedupe(components) {
  const merged = new Map();
  for (const component of components) {
    const key = `${component.name} @@ ${component.declared}`;
    const existing = merged.get(key);
    if (existing) {
      existing.versions = [...new Set([...existing.versions, ...component.versions])].sort(byText);
      continue;
    }
    merged.set(key, { ...component });
  }
  return [...merged.values()].sort(byName);
}

function firstSentence(text) {
  return String(text ?? "").split(/(?<=\))\s|\.\s/)[0].trim() || null;
}

function matches(pattern, name) {
  return typeof pattern === "string" ? pattern === name : pattern.test(name);
}

// ---------------------------------------------------------------------------
// Reading evidence
// ---------------------------------------------------------------------------

/**
 * Pulls a pinned version out of a sibling file rather than restating it here.
 *
 * Restating it would work exactly once. The failure mode of a duplicated version is a notices file
 * naming a llama.cpp build the installer does not contain, which is worse than no file at all — so
 * a pin that cannot be found stops the run rather than falling back to "unknown".
 */
function scrape(relative, pattern) {
  const match = readRepo(relative).match(pattern);
  if (!match) {
    fail(
      `could not find the pinned version in ${relative}.\n` +
        "        The constant it reads was renamed or reshaped. Fix the pattern in BUNDLED.",
    );
  }
  return match[1];
}

/**
 * Scrapes a value and insists it is still the expected one.
 *
 * For the facts that a row in `BUNDLED` silently depends on. The JDK vendor is the example: the
 * licence recorded for the bundled runtime is Temurin's, so a release workflow that quietly moved
 * to another distribution would leave this file asserting a licence nobody shipped.
 */
function expect(relative, pattern, wanted) {
  const found = scrape(relative, pattern);
  if (found !== wanted) {
    fail(
      `${relative} now says "${found}" where the notices assume "${wanted}".\n` +
        "        A bundled component changed underneath its row. Check what it ships under, then\n" +
        "        update that entry in BUNDLED.",
    );
  }
  return found;
}

function readRepo(relative) {
  try {
    return readFileSync(join(ROOT, relative), "utf8");
  } catch {
    fail(`${relative} is missing — the notices cannot be generated without it.`);
  }
}

function readIn(dir, relative) {
  try {
    return readFileSync(join(dir, relative), "utf8");
  } catch {
    fail(`${join(dir, relative)} is missing — the crate no longer carries what NATIVE expects. Re-read it.`);
  }
}

function scrapeIn(dir, relative, pattern) {
  return readIn(dir, relative).match(pattern)?.[1] ?? fail(`could not read a version out of ${join(dir, relative)} — fix NATIVE.`);
}

/** Comment markers and line breaks removed, so a phrase can be matched across a wrapped header. */
function flatten(text) {
  return text.replace(/[\s*#]+/g, " ");
}

function saysAll(text, phrases) {
  const flat = flatten(text);
  return phrases.filter((phrase) => !flat.includes(flatten(phrase)));
}

/** A licence claim in `NATIVE`, held against the text inside the crate's own copy of the source. */
function proveIn(dir, [relative, phrases], what, licence) {
  const missing = saysAll(readIn(dir, relative), phrases);
  if (missing.length > 0) {
    fail(
      `${what}: ${relative} no longer reads as ${licence} (missing "${missing[0]}").\n` +
        "        The library may have been relicensed. Read the file, then update NATIVE.",
    );
  }
}

/** The same, for a file in this repository. `optional` skips a build output that is not there. */
function proveFile(relative, phrases, what, licence, { optional = false } = {}) {
  const path = join(ROOT, relative);
  if (optional && !existsSync(path)) return;
  const missing = saysAll(readRepo(relative), phrases);
  if (missing.length > 0) {
    fail(`${what}: ${relative} no longer reads as ${licence} (missing "${missing[0]}"). Read it, then update BUNDLED.`);
  }
}

/** The same, for a file inside a downloaded jar — skipped when the jar has not been built here. */
function proveJar(relative, entry, phrases, what, licence) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) return;
  const bytes = zipEntry(path, entry);
  if (!bytes) fail(`${relative} has no ${entry} any more — ${what}'s licence evidence moved. Read the jar, then update BUNDLED.`);
  const missing = saysAll(bytes.toString("utf8"), phrases);
  if (missing.length > 0) {
    fail(`${relative}: ${entry} no longer reads as ${licence} (missing "${missing[0]}"). Read it, then update BUNDLED.`);
  }
}

/**
 * One entry out of a zip (a jar), without a dependency: the central directory, then the local
 * header, then stored or deflated bytes. Enough for the drivers' jars; not a general zip reader.
 */
function zipEntry(path, name) {
  const buffer = readFileSync(path);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let k = 0; k < count; k += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    if (buffer.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * The strings in a TrueType/OpenType `name` table, by name ID: 0 copyright, 1 family, 5 version,
 * 13 licence, 14 licence URL. Windows-platform (UTF-16) English records first, Mac Roman after.
 */
function fontNames(buffer, what) {
  const tag = buffer.toString("latin1", 0, 4);
  if (tag !== "\0\x01\0\0" && tag !== "OTTO" && tag !== "true") fail(`${what} is not a TrueType or OpenType font`);
  const tables = buffer.readUInt16BE(4);
  let offset = -1;
  for (let i = 0; i < tables; i += 1) {
    if (buffer.toString("latin1", 12 + i * 16, 16 + i * 16) === "name") offset = buffer.readUInt32BE(12 + i * 16 + 8);
  }
  if (offset < 0) fail(`${what} has no name table`);

  const count = buffer.readUInt16BE(offset + 2);
  const strings = offset + buffer.readUInt16BE(offset + 4);
  const found = {};
  const rank = {};
  for (let i = 0; i < count; i += 1) {
    const record = offset + 6 + i * 12;
    const platform = buffer.readUInt16BE(record);
    const language = buffer.readUInt16BE(record + 4);
    const id = buffer.readUInt16BE(record + 6);
    const length = buffer.readUInt16BE(record + 8);
    const start = strings + buffer.readUInt16BE(record + 10);
    const bytes = buffer.subarray(start, start + length);
    let text;
    let score;
    if (platform === 3 || platform === 0) {
      text = "";
      for (let j = 0; j + 1 < bytes.length; j += 2) text += String.fromCharCode(bytes.readUInt16BE(j));
      score = platform === 3 && language === 0x409 ? 3 : 2;
    } else if (platform === 1) {
      text = bytes.toString("latin1");
      score = 1;
    } else {
      continue;
    }
    if ((rank[id] ?? 0) < score) {
      found[id] = text.trim();
      rank[id] = score;
    }
  }
  return found;
}

/** How many font files a package directory holds, not descending into nested `node_modules`. */
function fontFiles(dir) {
  let count = 0;
  const walk = (at) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(join(at, entry.name));
      else if (/\.(?:ttf|otf|woff2?|eot)$/i.test(entry.name)) count += 1;
    }
  };
  walk(dir);
  return count;
}

/** `17.0.2` -> `17`, for the Adoptium repository name. */
function major(version) {
  return String(version).match(/^(\d+)/)?.[1] ?? version;
}

function fail(message) {
  throw new Error(message);
}

/**
 * Runs a tool. `shell` only on Windows, where pnpm is a `.cmd` shim that `spawnSync` cannot start
 * directly; every argument here is a literal, so there is nothing for a shell to misread.
 */
function spawn(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

/** Turns a tool's failure into a sentence rather than a stack trace. */
function output(result, label, hint = "") {
  if (result.error?.code === "ENOENT") fail(`${label.split(" ")[0]} is not on PATH — ${label} cannot run.`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-6).join("\n          ");
    fail(`${label} failed${hint}:\n          ${detail}`);
  }
  return result.stdout;
}

function run(command, args, cwd, label) {
  return output(spawn(command, args, cwd), label);
}

// Last, not first: `main` runs synchronously up to its first `await`, and everything it reaches on
// the way — `NORMALISATION` included — has to be initialised by then.
main().catch((error) => {
  console.error(`\nnotices: ${error.message}\n`);
  process.exit(1);
});
