# Third-party notices

CodeFlow ships code that CodeFlow did not write. This file lists it, names the licence each piece
is under, and carries the notices some of those licences require us to pass on to you. It is what
[section 6 of `LICENSE`](LICENSE) refers to.

Nothing here changes CodeFlow's own licence, and nothing in CodeFlow's licence takes away a
right one of these licences grants you. Where the two disagree about a component, the
component's own licence wins — which is what section 6 says.

> **Generated file — do not edit by hand.** `pnpm notices` rebuilds it from the resolved
> dependency trees; `pnpm notices:check` fails when what is committed has gone stale. The
> generator is [`scripts/build-third-party-notices.mjs`](scripts/build-third-party-notices.mjs),
> and the facts it cannot read out of a lockfile — the bundled runtimes, the C libraries inside
> the Rust crates, the licence elections — live in named constants at the top of it, which is the
> only place to change them.

| What ships | Count |
|---|---|
| npm packages (production tree) | 343 resolved versions of 314 packages |
| Rust crates (resolved for macOS and Windows) | 846 resolved versions of 745 crates |
| C libraries compiled into the app | 6, plus 4 bundled inside them |
| Runtimes, drivers and web apps bundled with it | 3 |
| Fonts | 10 |
| Icon sets | 2 |

A package resolved at two versions gets one row carrying both, which is why the first two counts
differ.

## Notices you are owed

Most of what follows asks only that its licence travel with it, which this file does. The
components below ask for something specific, and this is it.

### MPL-2.0 — where to get the source

CodeFlow's installers are Executable Form. [Section 3.2(a) of the Mozilla Public License
2.0](https://www.mozilla.org/en-US/MPL/2.0/) requires that we tell you how to obtain the
Source Code Form of the files it covers, so:

> **The Source Code Form of the MPL-2.0 components listed below is available to you, at no
> charge, at the project URL given for each one, at the exact version listed. If you would
> rather not fetch it yourself, open an issue at
> <https://github.com/sorodriguezz/code-flow/issues> and we will send you a copy at no
> charge. This offer is good for any recipient of an Official Build.**

These components ship **unmodified**. CodeFlow adds no Modifications to any MPL-2.0 file, so
the Source Code Form upstream publishes is the Source Code Form inside the installer.

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@novnc/novnc` | 1.7.0 | MPL-2.0 | <https://github.com/novnc/noVNC> |
| `cssparser` | 0.36.0 | MPL-2.0 | <https://github.com/servo/rust-cssparser> |
| `cssparser-macros` | 0.6.1 | MPL-2.0 | <https://github.com/servo/rust-cssparser> |
| `dtoa-short` | 0.3.5 | MPL-2.0 | <https://github.com/upsuper/dtoa-short> |
| `option-ext` | 0.2.0 | MPL-2.0 | <https://github.com/soc/option-ext> |
| `selectors` | 0.36.1 | MPL-2.0 | <https://github.com/servo/stylo> |
| `symphonia` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-bundle-flac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-bundle-mp3` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-aac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-adpcm` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-alac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-pcm` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-vorbis` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-core` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-isomp4` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-ogg` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-riff` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-metadata` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-utils-xiph` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |

noVNC's core — the VNC client behind the Remote workspace's desktop viewer — is bundled into
the frontend, minified. Its own `LICENSE.txt` names the files that core took from elsewhere
under MPL-compatible licences: `vendor/pako/` (MIT) and `core/des.js` (BSD-style).

### libgit2 — GPL-2.0 with a linking exception

The Git engine is libgit2 1.8.1, compiled into the app's own binary from the copy inside the
`libgit2-sys` crate and shipped unmodified. Its `COPYING` puts it under the GPL-2.0 with what it
calls a *linking exception* (SPDX: `GPL-2.0-only WITH GCC-exception-2.0`): linking the compiled
library into a program, and distributing that program, carries no restriction from libgit2's
licence. The GPL still governs libgit2's own files, whose source at the exact version is
<https://github.com/libgit2/libgit2/tree/v1.8.1>.

libgit2 compiles in pieces of other projects under licences of their own. They are listed with
it under *C libraries compiled into the app* below, and one of them is an open item.

### Downloaded on demand, not shipped — the Java runtime and the JDBC drivers

Oracle, InterSystems IRIS and the other databases of the driver catalogue
(`src/lib/db/driverCatalog.json`) are reached through their vendors' own JDBC drivers, which run
in a Java runtime. Neither is part of the installer. The app downloads them — Eclipse Temurin from
Adoptium, each driver from Maven Central or its vendor's own download — only when a connection
first needs them, after asking, and checks every file against the hash the catalogue pins.

They are the publishers' own files, under their own licences — the OpenJDK runtime under
[GPL-2.0-only WITH Classpath-exception-2.0](https://openjdk.org/legal/gplv2+ce.html), each driver
under the terms its vendor publishes with it (linked from the Drivers panel). CodeFlow does not
redistribute any of them. What the installer does carry is `resources/jdbc/codeflow-jdbc-bridge.jar`,
CodeFlow's own code, which the drivers run inside.

### Open items

Found, written down, and not yet resolved:

- **libgit2's xdiff is LGPL-2.1-or-later.**
  LibXDiff — the diff engine inside libgit2 1.8.1, in `deps/xdiff/` — is compiled into the
  app on both platforms, and its files carry a licence header of their own: the GNU LGPL, version
  2.1 or later. libgit2's `COPYING` does not mention it separately. Section 6 of the LGPL-2.1
  attaches conditions to distributing a program statically linked with such a library: a
  prominent notice that it is used (this file), a copy of the LGPL itself, the library's source
  (libgit2's own, at <https://github.com/libgit2/libgit2/tree/v1.8.1>), and terms that let the user modify the
  library and relink the program — including the reverse engineering needed to debug that.
  Whether libgit2's linking exception already covers these files, or those conditions apply as
  written, is the maintainer's decision. Until it is made, this stays open rather than settled.

## Where a licence offered a choice

A dual-licensed component gives the distributor the choice, and the choice has consequences.
Unless named below, CodeFlow takes the first of `MIT`, `Apache-2.0`, `BSD-3-Clause`, `BSD-2-Clause` … that the component offers.
These are the elections made deliberately:

| Component | Declared | CodeFlow takes | Why |
|---|---|---|---|
| `dompurify` | Apache-2.0 OR MPL-2.0 | **Apache-2.0** | the other branch is MPL-2.0; electing Apache-2.0 keeps DOMPurify out of the source-disclosure block above, and it ships unmodified either way |

## Runtimes, drivers and web apps bundled with it

These are not dependencies of the app's source. They are third-party programs fetched at build
time and copied into the installer — llama.cpp through `bundle.resources` in `tauri.conf.json`,
draw.io through the frontend bundle — each pinned by version and verified against a SHA-256 by
the script that fetches it. (The Java runtime and the JDBC drivers are not among them: see
*Downloaded on demand, not shipped* above.)

| Component | Version | Licence (SPDX) | Project | Ships as | Fetched by |
|---|---|---|---|---|---|
| llama.cpp (with ggml) | `b10587` | MIT | <https://github.com/ggml-org/llama.cpp> | `resources/llama/` — `llama-server` and the ggml libraries it resolves | `scripts/build-llama-runtime.mjs` |
| draw.io | `31.1.8` | Apache-2.0 | <https://github.com/jgraph/drawio> | `public/drawio/` — vendored into the frontend bundle | `scripts/build-drawio-webapp.mjs` |
| Luxon | `3.7.2` | MIT | <https://github.com/moment/luxon> | `src-tauri/src/flows/js/luxon.min.js` — embedded in the app binary for Flujos expressions | `vendored from npm luxon` |

llama.cpp's `LICENSE` is copied next to its binaries by its build script, so it travels inside
the installer as well as being listed here. draw.io and llama.cpp both carry third-party code of
their own inside what they publish; their repositories at the pinned versions, linked above, are
the authoritative record of it.

## C libraries compiled into the app

Some Rust crates below are thin bindings to a C library they carry a copy of and compile into
the app's binary. The crate's licence covers the bindings; the library arrives under its own,
listed here. Each licence is re-read from the crate's copy of the library on every regeneration.

| Library | Version | Licence (SPDX) | Compiled in on | Comes from |
|---|---|---|---|---|
| **libgit2** | `1.8.1` | GPL-2.0-only WITH GCC-exception-2.0 | macOS, Windows | `libgit2-sys` 0.17.0+1.8.1 |
| ↳ llhttp | `9.2.1` | MIT | macOS, Windows | libgit2's `deps/llhttp/` |
| ↳ PCRE | `8.45` | BSD-3-Clause | macOS, Windows | libgit2's `deps/pcre/` |
| ↳ SHA-1 collision detection (sha1dc) | — | MIT | macOS, Windows | libgit2's `src/util/hash/sha1dc/` |
| ↳ LibXDiff (xdiff) | — | LGPL-2.1-or-later | macOS, Windows | libgit2's `deps/xdiff/` |
| **libssh2** | `1.11.1_DEV` | BSD-3-Clause | macOS, Windows | `libssh2-sys` 0.3.2 |
| **SQLite** | `3.46.0` | blessing | macOS, Windows | `libsqlite3-sys` 0.30.1 |
| **OpenSSL** | `3.6.3` | Apache-2.0 | macOS | `openssl-src` 300.6.1+3.6.3 |
| **QuickJS-ng** | `0.16.2` | MIT | macOS, Windows | `rquickjs-sys` 0.14.0 |
| **zlib** | `1.3.2` | Zlib | Windows | `libz-sys` 1.1.29 |

Where a library is compiled in on one platform only, the other uses the operating system's own:
macOS's zlib, and on Windows the CNG cryptography libssh2 uses in place of OpenSSL.

## Fonts

| Font | Version | Licence (SPDX) | Used for | Ships in | Copyright |
|---|---|---|---|---|---|
| Instrument Sans | 5.3.0 (upstream v4) | OFL-1.1 | the interface | `@fontsource-variable/instrument-sans` | Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans) |
| JetBrains Mono | 5.3.0 (upstream v24) | OFL-1.1 | the editor, terminal and code | `@fontsource-variable/jetbrains-mono` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Roboto | 3.014 | OFL-1.1 | text in exported PDFs | inside `pdfmake` 0.3.11 (`build/vfs_fonts.js`) | Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) |
| Excalifont | 1.000 | MIT | hand-drawn text on whiteboards | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/Excalifont`) | Copyright (c) 2024 by Excalidraw. All rights reserved. |
| Virgil | 001.001 | OFL-1.1 | hand-drawn text in older whiteboards | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/Virgil`) | Copyright (c) 2011 by Your Own Font Foundry. All rights reserved. |
| Nunito ExtraLight Medium | 3.602 | MIT | plain text on whiteboards | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/Nunito`) | Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito) |
| Comic Shanns Regular | 1.3.0 | MIT | code on whiteboards | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/ComicShanns`) | Copyright (c) 2018 Shannon Miwa; Copyright (c) 2023 Jesus Gonzalez; Copyright (c) 2023 Rodrigo Batista de Moraes; Copyright (c) 2024 Fini Jastrow; Copyright (c) 2024 Kyle Beechly |
| Lilita One | 1.002 | MIT | headings on whiteboards | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/Lilita`) | Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One" |
| Assistant | 3.000 | OFL-1.1 | the whiteboard editor's own controls | inside `@excalidraw/excalidraw` 0.18.1 (`dist/prod/fonts/Assistant/Assistant-Regular.woff2`) | Copyright 2020 The Assistant Project Authors (https://github.com/hafontia/Assistant). Copyright 2010 The Source Sans Pro Authors (https://github.com/adobe-fonts/source-sans-pro), with Reserved Font Name 'Source'. Source is a trademark of Adobe Systems Incorporated in the United States and/or other countries. |
| codicon | 1.15 | MIT | the editor's own icons | inside `monaco-editor` 0.56.0 (`esm/vs/base/browser/ui/codicons/codicon/codicon.ttf`) | — |

Each OFL font carries its copyright notice and licence in its own metadata, which is where the
SIL Open Font License allows them to travel; they are repeated here.
The Excalifont font declares no licence of its own and ships as part of `@excalidraw/excalidraw`, under
that package's (MIT).
The Nunito ExtraLight Medium font declares no licence of its own and ships as part of `@excalidraw/excalidraw`, under
that package's (MIT).
The Comic Shanns Regular font declares no licence of its own and ships as part of `@excalidraw/excalidraw`, under
that package's (MIT).
The Lilita One font declares no licence of its own and ships as part of `@excalidraw/excalidraw`, under
that package's (MIT).
The codicon font declares no licence of its own and ships as part of `monaco-editor`, under
that package's (MIT).

## Icon sets

The file-icon packs draw from these [Iconify](https://iconify.design/) sets, shipped as JSON and
loaded on demand. Each set's licence is the one its own `info.json` declares.

| Set | Package | Version | Licence (SPDX) | Author | Icons |
|---|---|---|---|---|---|
| SVG Logos | `@iconify-json/logos` | 1.2.12 | CC0-1.0 | [Gil Barbara](https://github.com/gilbarbara/logos) | 1861 |
| VSCode Icons | `@iconify-json/vscode-icons` | 1.2.69 (upstream 12.19.0) | MIT | [Roberto Huertas](https://github.com/vscode-icons/vscode-icons) | 1566 |

Single marks copied into the source from sets and artwork the app does not install, for the
AI engines and platforms it integrates with, the databases it connects to and the container
runtimes it drives:

| Source | Licence | Marks |
|---|---|---|
| [Devicon](https://github.com/devicons/devicon) | MIT | Azure DevOps; SQL Server, Azure SQL Database, SQLite, Cassandra, Spark, ClickHouse, Ignite, Firebird; Podman |
| [theSVG](https://github.com/glincker/thesvg) | MIT | CockroachDB, TiDB, H2, Trino, Teradata |
| [Simple Icons](https://github.com/simple-icons/simple-icons) | CC0-1.0 | Oracle |
| [Carbon](https://github.com/carbon-design-system/carbon/tree/main/packages/icons) (IBM) | Apache-2.0 | Db2 |
| Google Cloud Icons | Apache-2.0 | BigQuery, Cloud Spanner |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | MIT | Denodo |
| SVG Logos, from a newer release than the package above | CC0-1.0 | Databricks |
| [MTSWebServices/data-rentgen-ui](https://github.com/MTSWebServices/data-rentgen-ui) | Apache-2.0 | Greenplum |
| [vertica/integrators-guide](https://github.com/vertica/integrators-guide) | Apache-2.0 | Vertica |
| Wikimedia Commons, "Apache Phoenix logo.svg" | Apache-2.0 | Apache Phoenix |
| Wikimedia Commons, "Tibero database logo.png" | CC0-1.0 | Tibero |
| [The ASF's logo index](https://www.apache.org/logos/) | ASF trademark policy | Apache Hive |
| The vendors' and projects' own artwork, at the user's request | none stated | Exasol, Mimer SQL, Tarantool, Apache Derby, HyperSQL |

A licence on a logo set covers the drawings, not the brands: the marks remain their owners'
trademarks, and CodeFlow uses them only to identify the tools and services they stand for.
The interface's own icons are Lucide (`lucide-react`), listed with the npm packages below.

## Notification sounds

Nine notification cues follow [TypeUI's notification catalogue](https://www.typeui.sh/ui-sounds/notifications)
by TypeUI / Bergside LLC. Six recordings ship in `public/sounds/typeui/`; three cues are
generated with Web Audio. Their provenance is recorded in `public/sounds/typeui/SOURCE.md`.
These resources are governed by the [TypeUI EULA](https://www.typeui.sh/license), including
its account and subscription access conditions, rather than CodeFlow's own licence or the
MIT licence of TypeUI's public CLI. TypeUI and its licensors retain ownership of the resources.
Prisma, the tenth cue, is an original CodeFlow melody generated with Web Audio and covered by
CodeFlow's own licence.

## npm packages

The installed production tree — what `pnpm licenses list --prod` reports, which is the
lockfile's resolution rather than the ranges in `package.json`. devDependencies build the app and
do not ship in it, so they are absent.
`monaco-editor` appears because it is a peer dependency of `@monaco-editor/react` and so
resolves into the production tree.
A package that ships a prebuilt bundle carries code from its own dependencies inside it —
pdfmake's browser build, for one — and that package's licence files are the record of what is
in there.

Licence expressions are shown normalised: a `/` separator becomes `OR`, wrapping parentheses are
dropped, and the branches of an `OR` are sorted, so that one licence gets one heading instead of
four spellings. Expressions containing `AND` are left exactly as their manifest declares them,
because there the order carries meaning.

### MIT — 233 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@antfu/install-pkg` | 2.1.0 | MIT | <https://github.com/antfu-collective/install-pkg> |
| `@babel/runtime` | 7.29.7 | MIT | <https://babel.dev/docs/en/next/babel-runtime> |
| `@braintree/sanitize-url` | 6.0.2, 7.1.2 | MIT | <https://github.com/braintree/sanitize-url> |
| `@excalidraw/excalidraw` | 0.18.1 | MIT | <https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw> |
| `@excalidraw/laser-pointer` | 1.3.1 | MIT | <https://www.npmjs.com/package/@excalidraw/laser-pointer> |
| `@excalidraw/markdown-to-text` | 0.1.2 | MIT | <https://github.com/danestves/markdown-to-text> |
| `@excalidraw/mermaid-to-excalidraw` | 2.2.2 | MIT | <https://www.npmjs.com/package/@excalidraw/mermaid-to-excalidraw> |
| `@excalidraw/random-username` | 1.1.0 | MIT | <https://github.com/excalidraw/random-username> |
| `@floating-ui/core` | 1.8.0 | MIT | <https://floating-ui.com> |
| `@floating-ui/dom` | 1.8.0 | MIT | <https://floating-ui.com> |
| `@floating-ui/react-dom` | 2.1.9 | MIT | <https://floating-ui.com/docs/react-dom> |
| `@floating-ui/utils` | 0.2.12 | MIT | <https://floating-ui.com> |
| `@glideapps/ts-necessities` | 2.2.3 | MIT | <https://github.com/glideapps/ts-necessities> |
| `@iconify-json/vscode-icons` | 1.2.69 | MIT | <https://icon-sets.iconify.design/vscode-icons> |
| `@iconify/types` | 2.0.0 | MIT | <https://github.com/iconify/iconify> |
| `@iconify/utils` | 3.1.7 | MIT | <https://iconify.design/docs/libraries/utils> |
| `@mermaid-js/parser` | 0.6.3, 1.2.1 | MIT | <https://github.com/mermaid-js/mermaid/tree/develop/packages/mermaid/parser> |
| `@monaco-editor/loader` | 1.7.0 | MIT | <https://github.com/suren-atoyan/monaco-loader> |
| `@monaco-editor/react` | 4.7.0 | MIT | <https://github.com/suren-atoyan/monaco-react> |
| `@noble/ciphers` | 1.3.0 | MIT | <https://paulmillr.com/noble> |
| `@noble/hashes` | 1.8.0 | MIT | <https://paulmillr.com/noble> |
| `@radix-ui/primitive` | 1.0.0, 1.1.1 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-arrow` | 1.1.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-collection` | 1.0.1 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-compose-refs` | 1.0.0, 1.1.1 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-context` | 1.0.0, 1.1.1 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-direction` | 1.0.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-dismissable-layer` | 1.1.5 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-focus-guards` | 1.1.1 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-focus-scope` | 1.1.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-id` | 1.0.0, 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-popover` | 1.1.6 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-popper` | 1.2.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-portal` | 1.1.4 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-presence` | 1.0.0, 1.1.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-primitive` | 1.0.1, 2.0.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-roving-focus` | 1.0.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-slot` | 1.0.1, 1.1.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-tabs` | 1.0.2 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-callback-ref` | 1.0.0, 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-controllable-state` | 1.0.0, 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-escape-keydown` | 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-layout-effect` | 1.0.0, 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-rect` | 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/react-use-size` | 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@radix-ui/rect` | 1.1.0 | MIT | <https://radix-ui.com/primitives> |
| `@types/d3` | 7.4.3 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3> |
| `@types/d3-array` | 3.2.2 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-array> |
| `@types/d3-axis` | 3.0.6 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-axis> |
| `@types/d3-brush` | 3.0.6 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-brush> |
| `@types/d3-chord` | 3.0.6 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-chord> |
| `@types/d3-color` | 3.1.3 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-color> |
| `@types/d3-contour` | 3.0.6 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-contour> |
| `@types/d3-delaunay` | 6.0.4 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-delaunay> |
| `@types/d3-dispatch` | 3.0.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-dispatch> |
| `@types/d3-drag` | 3.0.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-drag> |
| `@types/d3-dsv` | 3.0.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-dsv> |
| `@types/d3-ease` | 3.0.2 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-ease> |
| `@types/d3-fetch` | 3.0.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-fetch> |
| `@types/d3-force` | 3.0.10 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-force> |
| `@types/d3-format` | 3.0.4 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-format> |
| `@types/d3-geo` | 3.1.1 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-geo> |
| `@types/d3-hierarchy` | 3.1.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-hierarchy> |
| `@types/d3-interpolate` | 3.0.4 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-interpolate> |
| `@types/d3-path` | 3.1.1 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-path> |
| `@types/d3-polygon` | 3.0.2 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-polygon> |
| `@types/d3-quadtree` | 3.0.6 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-quadtree> |
| `@types/d3-random` | 3.0.4 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-random> |
| `@types/d3-scale` | 4.0.9 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale> |
| `@types/d3-scale-chromatic` | 3.1.0 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale-chromatic> |
| `@types/d3-selection` | 3.0.12 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-selection> |
| `@types/d3-shape` | 3.2.0 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-shape> |
| `@types/d3-time` | 3.0.4 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time> |
| `@types/d3-time-format` | 4.0.3 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time-format> |
| `@types/d3-timer` | 3.0.2 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-timer> |
| `@types/d3-transition` | 3.0.9 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-transition> |
| `@types/d3-zoom` | 3.0.9 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-zoom> |
| `@types/geojson` | 7946.0.16 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/geojson> |
| `@types/node` | 26.2.0 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node> |
| `@types/react` | 19.2.17 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react> |
| `@types/react-dom` | 19.2.3 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom> |
| `@types/readable-stream` | 4.0.10 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/readable-stream> |
| `@types/trusted-types` | 2.0.7 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/trusted-types> |
| `@types/urijs` | 1.19.26 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/urijs> |
| `@upsetjs/venn.js` | 2.0.0 | MIT | <https://github.com/upsetjs/venn.js> |
| `@xterm/addon-fit` | 0.11.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master> |
| `@xterm/addon-search` | 0.16.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master> |
| `@xterm/addon-web-links` | 0.12.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master> |
| `@xterm/addon-webgl` | 0.19.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master> |
| `@xterm/xterm` | 6.0.0 | MIT | <https://github.com/xtermjs/xterm.js> |
| `@xyflow/react` | 12.12.0 | MIT | <https://reactflow.dev> |
| `@xyflow/system` | 0.0.83 | MIT | <https://github.com/xyflow/xyflow> |
| `abort-controller` | 3.0.0 | MIT | <https://github.com/mysticatea/abort-controller> |
| `aria-hidden` | 1.2.6 | MIT | <https://github.com/theKashey/aria-hidden> |
| `base64-js` | 0.0.8, 1.5.1 | MIT | <https://github.com/beatgammit/base64-js> |
| `binary-extensions` | 2.3.0 | MIT | <https://github.com/sindresorhus/binary-extensions> |
| `braces` | 3.0.3 | MIT | <https://github.com/micromatch/braces> |
| `brotli` | 1.3.3 | MIT | <https://github.com/devongovett/brotli.js> |
| `browser-or-node` | 3.0.0 | MIT | <https://github.com/flexdinesh/browser-or-node> |
| `browserify-zlib` | 0.2.0 | MIT | <https://github.com/devongovett/browserify-zlib> |
| `buffer` | 6.0.3 | MIT | <https://github.com/feross/buffer> |
| `canvas-roundrect-polyfill` | 0.0.1 | MIT | <https://github.com/Kaiido/roundRect> |
| `chevrotain-allstar` | 0.3.1 | MIT | <https://github.com/langium/chevrotain-allstar> |
| `chokidar` | 3.6.0 | MIT | <https://github.com/paulmillr/chokidar> |
| `classcat` | 5.0.5 | MIT | <https://github.com/jorgebucaran/classcat> |
| `clone` | 2.1.2 | MIT | <https://github.com/pvorb/node-clone> |
| `clsx` | 1.1.1 | MIT | <https://github.com/lukeed/clsx> |
| `commander` | 2.20.3, 7.2.0, 8.3.0 | MIT | <https://github.com/tj/commander.js> |
| `cose-base` | 1.0.3, 2.2.0 | MIT | <https://github.com/iVis-at-Bilkent/cose-base> |
| `cross-env` | 7.0.3 | MIT | <https://github.com/kentcdodds/cross-env> |
| `cross-spawn` | 7.0.6 | MIT | <https://github.com/moxystudio/node-cross-spawn> |
| `csstype` | 3.2.3 | MIT | <https://github.com/frenic/csstype> |
| `cytoscape` | 3.34.3 | MIT | <http://js.cytoscape.org> |
| `cytoscape-cose-bilkent` | 4.1.0 | MIT | <https://github.com/cytoscape/cytoscape.js-cose-bilkent> |
| `cytoscape-fcose` | 2.2.0 | MIT | <https://github.com/iVis-at-Bilkent/cytoscape.js-fcose> |
| `dagre-d3-es` | 7.0.14 | MIT | <https://github.com/tbo47/dagre-es> |
| `dayjs` | 1.11.23 | MIT | <https://day.js.org> |
| `detect-node-es` | 1.1.0 | MIT | <https://github.com/thekashey/detect-node> |
| `dfa` | 1.2.0 | MIT | <https://github.com/devongovett/dfa> |
| `discontinuous-range` | 1.0.0 | MIT | <https://github.com/dtudury/discontinuous-range> |
| `es-toolkit` | 1.52.0 | MIT | <https://es-toolkit.dev> |
| `es6-promise-pool` | 2.5.0 | MIT | <https://github.com/timdp/es6-promise-pool> |
| `event-target-shim` | 5.0.1 | MIT | <https://github.com/mysticatea/event-target-shim> |
| `events` | 3.3.0 | MIT | <https://github.com/Gozala/events> |
| `fast-deep-equal` | 3.1.3 | MIT | <https://github.com/epoberezkin/fast-deep-equal> |
| `fastdom` | 1.0.12 | MIT | <https://github.com/wilsonpage/fastdom> |
| `fill-range` | 7.1.1 | MIT | <https://github.com/jonschlinkert/fill-range> |
| `fontkit` | 2.0.4 | MIT | <https://github.com/foliojs/fontkit> |
| `framer-motion` | 12.42.2 | MIT | <https://github.com/motiondivision/motion> |
| `fsevents` | 2.3.3 | MIT | <https://github.com/fsevents/fsevents> |
| `fuzzy` | 0.1.3 | MIT | <https://github.com/mattyork/fuzzy> |
| `get-nonce` | 1.0.1 | MIT | <https://github.com/theKashey/get-nonce> |
| `glur` | 1.1.2 | MIT | <https://github.com/andr83/glur/issues> |
| `hachure-fill` | 0.5.2 | MIT | <https://github.com/pshihn/hachure-fill> |
| `iconv-lite` | 0.6.3 | MIT | <https://github.com/ashtuchkin/iconv-lite> |
| `image-blob-reduce` | 3.0.1 | MIT | <https://github.com/nodeca/image-blob-reduce> |
| `immutable` | 4.3.9 | MIT | <https://immutable-js.com> |
| `import-meta-resolve` | 4.2.0 | MIT | <https://github.com/wooorm/import-meta-resolve> |
| `is-binary-path` | 2.1.0 | MIT | <https://github.com/sindresorhus/is-binary-path> |
| `is-extglob` | 2.1.1 | MIT | <https://github.com/jonschlinkert/is-extglob> |
| `is-glob` | 4.0.3 | MIT | <https://github.com/micromatch/is-glob> |
| `is-number` | 7.0.0 | MIT | <https://github.com/jonschlinkert/is-number> |
| `is-url` | 1.2.4 | MIT | <https://github.com/segmentio/is-url> |
| `jotai` | 2.11.0 | MIT | <https://github.com/pmndrs/jotai> |
| `jotai-scope` | 0.7.2 | MIT | <https://github.com/jotaijs/jotai-scope> |
| `js-md5` | 0.8.3 | MIT | <https://github.com/emn178/js-md5> |
| `katex` | 0.16.47 | MIT | <https://katex.org> |
| `khroma` | 2.1.0 | MIT | <https://github.com/fabiospampinato/khroma> |
| `langium` | 3.3.1 | MIT | <https://langium.org> |
| `layout-base` | 1.0.2, 2.0.1 | MIT | <https://github.com/iVis-at-Bilkent/layout-base> |
| `linebreak` | 1.1.0 | MIT | <https://github.com/devongovett/linebreaker> |
| `lodash` | 4.18.1 | MIT | <https://lodash.com> |
| `lodash-es` | 4.17.21, 4.18.1 | MIT | <https://lodash.com/custom-builds> |
| `lodash.debounce` | 4.0.8 | MIT | <https://lodash.com> |
| `lodash.throttle` | 4.1.1 | MIT | <https://lodash.com> |
| `luxon` | 3.7.2 | MIT | <https://github.com/moment/luxon> |
| `marked` | 14.0.0, 16.4.2, 18.0.7 | MIT | <https://marked.js.org> |
| `mermaid` | 11.17.2 | MIT | <https://github.com/mermaid-js/mermaid> |
| `monaco-editor` | 0.56.0 | MIT | <https://github.com/microsoft/monaco-editor> |
| `motion-dom` | 12.42.2 | MIT | <https://github.com/motiondivision/motion> |
| `motion-utils` | 12.39.0 | MIT | <https://github.com/motiondivision/motion> |
| `multimath` | 2.0.0 | MIT | <https://github.com/nodeca/multimath> |
| `nanoid` | 3.3.3, 4.0.2 | MIT | <https://github.com/ai/nanoid> |
| `nearley` | 2.20.1 | MIT | <https://github.com/hardmath123/nearley> |
| `normalize-path` | 3.0.0 | MIT | <https://github.com/jonschlinkert/normalize-path> |
| `object-assign` | 4.1.1 | MIT | <https://github.com/sindresorhus/object-assign> |
| `open-color` | 1.9.1 | MIT | <https://github.com/yeun/open-color> |
| `package-manager-detector` | 1.8.0 | MIT | <https://github.com/antfu-collective/package-manager-detector> |
| `pako` | 0.2.9 | MIT | <https://github.com/nodeca/pako> |
| `parsimmon` | 1.18.1 | MIT | <https://github.com/jneen/parsimmon> |
| `path-data-parser` | 0.1.0 | MIT | <https://github.com/pshihn/path-data-parser> |
| `path-key` | 3.1.1 | MIT | <https://github.com/sindresorhus/path-key> |
| `pathe` | 2.0.3 | MIT | <https://github.com/unjs/pathe> |
| `pdfkit` | 0.19.1 | MIT | <http://pdfkit.org> |
| `pdfmake` | 0.3.11 | MIT | <http://pdfmake.org> |
| `perfect-freehand` | 1.2.0 | MIT | <https://github.com/steveruizok/perfect-freehand> |
| `pica` | 7.1.1 | MIT | <https://github.com/nodeca/pica> |
| `picomatch` | 2.3.2 | MIT | <https://github.com/micromatch/picomatch> |
| `pluralize` | 8.0.0 | MIT | <https://github.com/blakeembrey/pluralize> |
| `png-chunk-text` | 1.0.0 | MIT | <https://github.com/hughsk/png-chunk-text> |
| `png-chunks-encode` | 1.0.0 | MIT | <https://github.com/hughsk/png-chunks-encode> |
| `png-chunks-extract` | 1.0.0 | MIT | <https://github.com/hughsk/png-chunks-extract> |
| `png-js` | 1.1.0 | MIT | <https://github.com/devongovett/png.js> |
| `points-on-curve` | 0.2.0, 1.0.1 | MIT | <https://github.com/pshihn/bezier-points> |
| `points-on-path` | 0.2.1 | MIT | <https://github.com/pshihn/points-on-path> |
| `process` | 0.11.10 | MIT | <https://github.com/shtylman/node-process> |
| `qrcode-generator` | 2.0.4 | MIT | <https://github.com/kazuhikoarase/qrcode-generator> |
| `randexp` | 0.4.6 | MIT | <http://fent.github.io/randexp.js> |
| `react` | 19.2.8 | MIT | <https://react.dev> |
| `react-dom` | 19.2.8 | MIT | <https://react.dev> |
| `react-remove-scroll` | 2.7.2 | MIT | <https://github.com/theKashey/react-remove-scroll> |
| `react-remove-scroll-bar` | 2.3.8 | MIT | <https://github.com/theKashey/react-remove-scroll-bar> |
| `react-style-singleton` | 2.2.3 | MIT | <https://github.com/theKashey/react-style-singleton> |
| `readable-stream` | 4.5.2 | MIT | <https://github.com/nodejs/readable-stream> |
| `readdirp` | 3.6.0 | MIT | <https://github.com/paulmillr/readdirp> |
| `restructure` | 3.0.2 | MIT | <https://github.com/devongovett/restructure> |
| `ret` | 0.1.15 | MIT | <https://github.com/fent/ret.js> |
| `roughjs` | 4.6.4, 4.6.6 | MIT | <https://roughjs.com> |
| `safe-buffer` | 5.1.2, 5.2.1 | MIT | <https://github.com/feross/safe-buffer> |
| `safer-buffer` | 2.1.2 | MIT | <https://github.com/ChALkeR/safer-buffer> |
| `sass` | 1.51.0 | MIT | <https://github.com/sass/dart-sass> |
| `scheduler` | 0.27.0 | MIT | <https://react.dev> |
| `shebang-command` | 2.0.0 | MIT | <https://github.com/kevva/shebang-command> |
| `shebang-regex` | 3.0.0 | MIT | <https://github.com/sindresorhus/shebang-regex> |
| `sliced` | 1.0.1 | MIT | <https://github.com/aheckmann/sliced> |
| `sql-formatter` | 15.9.0 | MIT | <https://github.com/sql-formatter-org/sql-formatter> |
| `state-local` | 1.0.7 | MIT | <https://github.com/suren-atoyan/state-local> |
| `strictdom` | 1.0.1 | MIT | <https://github.com/wilsonpage/strictdom> |
| `string_decoder` | 1.3.0 | MIT | <https://github.com/nodejs/string_decoder> |
| `stylis` | 4.4.0 | MIT | <https://github.com/thysultan/stylis.js> |
| `tiny-inflate` | 1.0.3 | MIT | <https://github.com/devongovett/tiny-inflate> |
| `tinyexec` | 1.3.1 | MIT | <https://github.com/tinylibs/tinyexec> |
| `to-regex-range` | 5.0.1 | MIT | <https://github.com/micromatch/to-regex-range> |
| `ts-dedent` | 2.3.0 | MIT | <https://github.com/tamino-martinius/node-ts-dedent> |
| `tunnel-rat` | 0.1.2 | MIT | <https://github.com/pmndrs/tunnel-rat> |
| `undici-types` | 8.3.0 | MIT | <https://undici.nodejs.org> |
| `unicode-properties` | 1.4.1 | MIT | <https://github.com/devongovett/unicode-properties> |
| `unicode-trie` | 2.0.0 | MIT | <https://github.com/devongovett/unicode-trie> |
| `urijs` | 1.19.11 | MIT | <http://medialize.github.io/URI.js> |
| `use-callback-ref` | 1.3.3 | MIT | <https://github.com/theKashey/use-callback-ref> |
| `use-sidecar` | 1.1.3 | MIT | <https://github.com/theKashey/use-sidecar> |
| `use-sync-external-store` | 1.7.0 | MIT | <https://github.com/react/react> |
| `uuid` | 14.0.2 | MIT | <https://github.com/uuidjs/uuid> |
| `vscode-jsonrpc` | 8.2.0 | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| `vscode-languageserver` | 9.0.1 | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| `vscode-languageserver-protocol` | 3.17.5 | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| `vscode-languageserver-textdocument` | 1.0.15 | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| `vscode-languageserver-types` | 3.17.5 | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| `vscode-uri` | 3.0.8 | MIT | <https://github.com/microsoft/vscode-uri> |
| `webworkify` | 1.5.0 | MIT | <https://github.com/substack/webworkify> |
| `wordwrap` | 1.0.0 | MIT | <https://github.com/substack/node-wordwrap> |
| `xmldoc` | 2.0.3 | MIT | <https://github.com/nfarina/xmldoc> |
| `zustand` | 4.5.7, 5.0.14 | MIT | <https://github.com/pmndrs/zustand> |

### ISC — 39 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `anymatch` | 3.1.3 | ISC | <https://github.com/micromatch/anymatch> |
| `d3` | 7.9.0 | ISC | <https://d3js.org> |
| `d3-array` | 3.2.4 | ISC | <https://d3js.org/d3-array> |
| `d3-axis` | 3.0.0 | ISC | <https://d3js.org/d3-axis> |
| `d3-brush` | 3.0.0 | ISC | <https://d3js.org/d3-brush> |
| `d3-chord` | 3.0.1 | ISC | <https://d3js.org/d3-chord> |
| `d3-color` | 3.1.0 | ISC | <https://d3js.org/d3-color> |
| `d3-contour` | 4.0.2 | ISC | <https://d3js.org/d3-contour> |
| `d3-delaunay` | 6.0.4 | ISC | <https://github.com/d3/d3-delaunay> |
| `d3-dispatch` | 3.0.1 | ISC | <https://d3js.org/d3-dispatch> |
| `d3-drag` | 3.0.0 | ISC | <https://d3js.org/d3-drag> |
| `d3-dsv` | 3.0.1 | ISC | <https://d3js.org/d3-dsv> |
| `d3-fetch` | 3.0.1 | ISC | <https://d3js.org/d3-fetch> |
| `d3-force` | 3.0.0 | ISC | <https://d3js.org/d3-force> |
| `d3-format` | 3.1.2 | ISC | <https://d3js.org/d3-format> |
| `d3-geo` | 3.1.1 | ISC | <https://d3js.org/d3-geo> |
| `d3-hierarchy` | 3.1.2 | ISC | <https://d3js.org/d3-hierarchy> |
| `d3-interpolate` | 3.0.1 | ISC | <https://d3js.org/d3-interpolate> |
| `d3-path` | 3.1.0 | ISC | <https://d3js.org/d3-path> |
| `d3-polygon` | 3.0.1 | ISC | <https://d3js.org/d3-polygon> |
| `d3-quadtree` | 3.0.1 | ISC | <https://d3js.org/d3-quadtree> |
| `d3-random` | 3.0.1 | ISC | <https://d3js.org/d3-random> |
| `d3-scale` | 4.0.2 | ISC | <https://d3js.org/d3-scale> |
| `d3-scale-chromatic` | 3.1.0 | ISC | <https://d3js.org/d3-scale-chromatic> |
| `d3-selection` | 3.0.0 | ISC | <https://d3js.org/d3-selection> |
| `d3-shape` | 3.2.0 | ISC | <https://d3js.org/d3-shape> |
| `d3-time` | 3.1.0 | ISC | <https://d3js.org/d3-time> |
| `d3-time-format` | 4.1.0 | ISC | <https://d3js.org/d3-time-format> |
| `d3-timer` | 3.0.1 | ISC | <https://d3js.org/d3-timer> |
| `d3-transition` | 3.0.1 | ISC | <https://d3js.org/d3-transition> |
| `d3-zoom` | 3.0.0 | ISC | <https://d3js.org/d3-zoom> |
| `delaunator` | 5.1.0 | ISC | <https://github.com/mapbox/delaunator> |
| `glob-parent` | 5.1.2 | ISC | <https://github.com/gulpjs/glob-parent> |
| `inherits` | 2.0.4 | ISC | <https://github.com/isaacs/inherits> |
| `internmap` | 1.0.1, 2.0.3 | ISC | <https://github.com/mbostock/internmap> |
| `isexe` | 2.0.0 | ISC | <https://github.com/isaacs/isexe> |
| `lucide-react` | 1.25.0 | ISC | <https://lucide.dev> |
| `which` | 2.0.2 | ISC | <https://github.com/isaacs/node-which> |
| `yaml` | 2.9.0 | ISC | <https://eemeli.org/yaml> |

### Apache-2.0 — 14 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@chevrotain/cst-dts-gen` | 11.0.3 | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| `@chevrotain/gast` | 11.0.3 | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| `@chevrotain/regexp-to-ast` | 11.0.3 | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| `@chevrotain/types` | 11.0.3, 11.1.2 | Apache-2.0 | <https://chevrotain.io/documentation> |
| `@chevrotain/utils` | 11.0.3 | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| `@dbml/core` | 8.3.1 | Apache-2.0 | <https://dbml.dbdiagram.io> |
| `@dbml/parse` | 8.3.1 | Apache-2.0 | <https://dbml.dbdiagram.io> |
| `@swc/helpers` | 0.5.23 | Apache-2.0 | <https://swc.rs> |
| `browser-fs-access` | 0.29.1 | Apache-2.0 | <https://github.com/GoogleChromeLabs/browser-fs-access> |
| `chevrotain` | 11.0.3 | Apache-2.0 | <https://chevrotain.io/docs> |
| `collection-utils` | 1.0.1 | Apache-2.0 | <https://github.com/quicktype/collection-utils> |
| `crc-32` | 0.3.0 | Apache-2.0 | <https://github.com/SheetJS/js-crc32> |
| `pwacompat` | 2.0.17 | Apache-2.0 | <https://github.com/GoogleChrome/pwacompat> |
| `quicktype-core` | 26.0.0 | Apache-2.0 | <https://github.com/glideapps/quicktype> |

### BSD-3-Clause — 10 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `antlr4` | 4.13.2 | BSD-3-Clause | <https://github.com/antlr/antlr4> |
| `d3-array` | 2.12.1 | BSD-3-Clause | <https://d3js.org/d3-array> |
| `d3-ease` | 3.0.1 | BSD-3-Clause | <https://d3js.org/d3-ease> |
| `d3-path` | 1.0.9 | BSD-3-Clause | <https://d3js.org/d3-path> |
| `d3-sankey` | 0.12.3 | BSD-3-Clause | <https://github.com/d3/d3-sankey> |
| `d3-shape` | 1.3.7 | BSD-3-Clause | <https://d3js.org/d3-shape> |
| `ieee754` | 1.2.1 | BSD-3-Clause | <https://github.com/feross/ieee754> |
| `moo` | 0.5.3 | BSD-3-Clause | <https://github.com/tjvr/moo> |
| `rw` | 1.3.3 | BSD-3-Clause | <https://github.com/mbostock/rw> |
| `source-map-js` | 1.2.1 | BSD-3-Clause | <https://github.com/7rulnik/source-map-js> |

### Apache-2.0 OR MIT — 6 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `@tauri-apps/plugin-dialog` | 2.7.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `@tauri-apps/plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `@tauri-apps/plugin-os` | 2.3.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `@tauri-apps/plugin-process` | 2.3.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `@tauri-apps/plugin-updater` | 2.10.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |

### CC0-1.0 — 3 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@iconify-json/logos` | 1.2.12 | CC0-1.0 | <https://icon-sets.iconify.design/logos> |
| `fractional-indexing` | 3.2.0 | CC0-1.0 | <https://github.com/rocicorp/fractional-indexing> |
| `railroad-diagrams` | 1.0.0 | CC0-1.0 | <https://github.com/tabatkins/railroad-diagrams> |

### OFL-1.1 — 2 packages

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@fontsource-variable/instrument-sans` | 5.3.0 | OFL-1.1 | <https://fontsource.org/fonts/instrument-sans> |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | OFL-1.1 | <https://fontsource.org/fonts/jetbrains-mono> |

### 0BSD — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `tslib` | 2.8.1 | 0BSD | <https://www.typescriptlang.org> |

### Apache-2.0 OR MPL-2.0 — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `dompurify` | 3.4.12, 3.4.8 | Apache-2.0 OR MPL-2.0 | <https://github.com/cure53/DOMPurify> |

### BlueOak-1.0.0 — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `sax` | 1.6.1 | BlueOak-1.0.0 | <https://github.com/isaacs/sax-js> |

### MIT AND Zlib — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `pako` | 1.0.11, 2.0.3 | MIT AND Zlib | <https://github.com/nodeca/pako> |

### MPL-2.0 — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `@novnc/novnc` | 1.7.0 | MPL-2.0 | <https://github.com/novnc/noVNC> |

### Python-2.0 — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `argparse` | 2.0.1 | Python-2.0 | <https://github.com/nodeca/argparse> |

### Unlicense — 1 package

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `robust-predicates` | 3.0.3 | Unlicense | <https://github.com/mourner/robust-predicates> |

## Rust crates

The resolved graph from `src-tauri/Cargo.lock`, filtered to the platforms a release is built
for (`aarch64-apple-darwin`, `x86_64-pc-windows-msvc`) and walked from the `codeflow`
crate through normal and build dependencies. Dev-dependencies are excluded, because nothing a
`#[test]` reaches ends up in an installer; so are crates only another platform would pull — GTK
and D-Bus on Linux, the Android and wasm bindings — for the same reason.

Licence expressions are shown normalised: a `/` separator becomes `OR`, wrapping parentheses are
dropped, and the branches of an `OR` are sorted, so that one licence gets one heading instead of
four spellings. Expressions containing `AND` are left exactly as their manifest declares them,
because there the order carries meaning.

### Apache-2.0 OR MIT — 428 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `aead` | 0.5.2, 0.6.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits> |
| `aes` | 0.8.4, 0.9.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/block-ciphers> |
| `aes-gcm` | 0.10.3, 0.11.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/AEADs> |
| `ahash` | 0.8.12 | Apache-2.0 OR MIT | <https://github.com/tkaitchuck/ahash> |
| `allocator-api2` | 0.2.21 | Apache-2.0 OR MIT | <https://github.com/zakarumych/allocator-api2> |
| `anyhow` | 1.0.104 | Apache-2.0 OR MIT | <https://github.com/dtolnay/anyhow> |
| `arc-swap` | 1.9.2 | Apache-2.0 OR MIT | <https://github.com/vorner/arc-swap> |
| `argon2` | 0.5.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/password-hashes/tree/master/argon2> |
| `arraydeque` | 0.5.1 | Apache-2.0 OR MIT | <https://github.com/andylokandy/arraydeque> |
| `arrayvec` | 0.7.8 | Apache-2.0 OR MIT | <https://github.com/bluss/arrayvec> |
| `asn1-rs` | 0.7.2 | Apache-2.0 OR MIT | <https://github.com/rusticata/asn1-rs> |
| `asn1-rs-derive` | 0.6.0 | Apache-2.0 OR MIT | <https://github.com/rusticata/asn1-rs> |
| `asn1-rs-impl` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/rusticata/asn1-rs> |
| `async-channel` | 1.9.0, 2.5.0 | Apache-2.0 OR MIT | <https://github.com/smol-rs/async-channel> |
| `async-compat` | 0.2.6 | Apache-2.0 OR MIT | <https://github.com/smol-rs/async-compat> |
| `async-compression` | 0.4.42 | Apache-2.0 OR MIT | <https://github.com/Nullus157/async-compression> |
| `async-executor` | 1.14.0 | Apache-2.0 OR MIT | <https://github.com/smol-rs/async-executor> |
| `async-global-executor` | 3.1.0 | Apache-2.0 OR MIT | <https://github.com/Keruspe/async-global-executor> |
| `async-imap` | 0.12.0 | Apache-2.0 OR MIT | <https://github.com/async-email/async-imap> |
| `async-lock` | 3.4.2 | Apache-2.0 OR MIT | <https://github.com/smol-rs/async-lock> |
| `async-task` | 4.7.1 | Apache-2.0 OR MIT | <https://github.com/smol-rs/async-task> |
| `async-trait` | 0.1.91 | Apache-2.0 OR MIT | <https://github.com/dtolnay/async-trait> |
| `atoi_simd` | 0.18.1 | Apache-2.0 OR MIT | <https://github.com/RoDmitry/atoi_simd> |
| `atomic-waker` | 1.1.2 | Apache-2.0 OR MIT | <https://github.com/smol-rs/atomic-waker> |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | <https://github.com/cuviper/autocfg> |
| `base64` | 0.21.7, 0.22.1, 0.23.1 | Apache-2.0 OR MIT | <https://github.com/marshallpierce/rust-base64> |
| `base64ct` | 1.8.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats> |
| `beef` | 0.5.2 | Apache-2.0 OR MIT | <https://github.com/maciejhirsz/beef> |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT | <https://github.com/contain-rs/bit-set> |
| `bit-vec` | 0.8.0, 0.9.1 | Apache-2.0 OR MIT | <https://github.com/contain-rs/bit-vec> |
| `bitflags` | 1.3.2, 2.13.1 | Apache-2.0 OR MIT | <https://github.com/bitflags/bitflags> |
| `blake2` | 0.10.6 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hashes> |
| `block-buffer` | 0.10.4, 0.12.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `block-padding` | 0.3.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `blocking` | 1.6.2 | Apache-2.0 OR MIT | <https://github.com/smol-rs/blocking> |
| `bs58` | 0.5.1 | Apache-2.0 OR MIT | <https://github.com/Nullus157/bs58-rs> |
| `bstr` | 1.13.0 | Apache-2.0 OR MIT | <https://github.com/BurntSushi/bstr> |
| `btoi` | 0.5.0 | Apache-2.0 OR MIT | <https://github.com/niklasf/rust-btoi> |
| `bumpalo` | 3.20.3 | Apache-2.0 OR MIT | <https://github.com/fitzgen/bumpalo> |
| `bytecount` | 0.6.9 | Apache-2.0 OR MIT | <https://github.com/llogiq/bytecount> |
| `bzip2` | 0.6.1 | Apache-2.0 OR MIT | <https://github.com/trifectatechfoundation/bzip2-rs> |
| `camino` | 1.2.4 | Apache-2.0 OR MIT | <https://github.com/camino-rs/camino> |
| `cargo-platform` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/rust-lang/cargo> |
| `cargo_toml` | 0.22.3 | Apache-2.0 OR MIT | <https://gitlab.com/lib.rs/cargo_toml> |
| `cbc` | 0.1.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/block-modes> |
| `cc` | 1.3.0 | Apache-2.0 OR MIT | <https://github.com/rust-lang/cc-rs> |
| `ccm` | 0.6.0-rc.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/AEADs> |
| `cff-parser` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/jrmuizel/cff-parser> |
| `cfg-if` | 1.0.4 | Apache-2.0 OR MIT | <https://github.com/rust-lang/cfg-if> |
| `chacha20` | 0.10.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/stream-ciphers> |
| `chrono` | 0.4.45 | Apache-2.0 OR MIT | <https://github.com/chronotope/chrono> |
| `chrono-tz` | 0.10.4 | Apache-2.0 OR MIT | <https://github.com/chronotope/chrono-tz> |
| `cipher` | 0.4.4, 0.5.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits> |
| `cmac` | 0.8.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/MACs> |
| `cmov` | 0.5.4 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `cms` | 0.2.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/cms> |
| `codepage` | 0.1.3 | Apache-2.0 OR MIT | <https://github.com/hsivonen/codepage> |
| `compression-codecs` | 0.4.38 | Apache-2.0 OR MIT | <https://github.com/Nullus157/async-compression> |
| `compression-core` | 0.4.32 | Apache-2.0 OR MIT | <https://github.com/Nullus157/async-compression> |
| `concurrent-queue` | 2.5.0 | Apache-2.0 OR MIT | <https://github.com/smol-rs/concurrent-queue> |
| `connection-string` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/prisma/connection-string> |
| `const-oid` | 0.10.2, 0.9.6 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/const-oid> |
| `const-random` | 0.1.18 | Apache-2.0 OR MIT | <https://github.com/tkaitchuck/constrandom> |
| `const-random-macro` | 0.1.16 | Apache-2.0 OR MIT | <https://github.com/tkaitchuck/constrandom> |
| `cookie` | 0.18.1 | Apache-2.0 OR MIT | <https://github.com/SergioBenitez/cookie-rs> |
| `core-foundation` | 0.10.1, 0.9.4 | Apache-2.0 OR MIT | <https://github.com/servo/core-foundation-rs> |
| `core-foundation-sys` | 0.8.7 | Apache-2.0 OR MIT | <https://github.com/servo/core-foundation-rs> |
| `core-graphics` | 0.25.0 | Apache-2.0 OR MIT | <https://github.com/servo/core-foundation-rs> |
| `core-graphics-types` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/servo/core-foundation-rs> |
| `coreaudio-rs` | 0.14.2 | Apache-2.0 OR MIT | <https://github.com/RustAudio/coreaudio-rs> |
| `cpubits` | 0.1.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `cpufeatures` | 0.2.17, 0.3.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `crc32c` | 0.6.8 | Apache-2.0 OR MIT | <https://github.com/zowens/crc32c> |
| `crc32fast` | 1.5.0 | Apache-2.0 OR MIT | <https://github.com/srijs/rust-crc32fast> |
| `critical-section` | 1.2.0 | Apache-2.0 OR MIT | <https://github.com/rust-embedded/critical-section> |
| `crossbeam-channel` | 0.5.16 | Apache-2.0 OR MIT | <https://github.com/crossbeam-rs/crossbeam> |
| `crossbeam-epoch` | 0.9.18 | Apache-2.0 OR MIT | <https://github.com/crossbeam-rs/crossbeam> |
| `crossbeam-queue` | 0.3.14 | Apache-2.0 OR MIT | <https://github.com/crossbeam-rs/crossbeam> |
| `crossbeam-utils` | 0.8.22 | Apache-2.0 OR MIT | <https://github.com/crossbeam-rs/crossbeam> |
| `crypto-common` | 0.1.7, 0.2.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits> |
| `ctor` | 0.8.0 | Apache-2.0 OR MIT | <https://github.com/mmastrac/rust-ctor> |
| `ctor-proc-macro` | 0.0.7 | Apache-2.0 OR MIT | <https://github.com/mmastrac/rust-ctor> |
| `ctr` | 0.10.1, 0.9.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/block-modes> |
| `ctutils` | 0.4.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `curve25519-dalek-derive` | 0.1.1 | Apache-2.0 OR MIT | <https://github.com/dalek-cryptography/curve25519-dalek> |
| `dasp_sample` | 0.11.0 | Apache-2.0 OR MIT | <https://github.com/rustaudio/sample> |
| `dbl` | 0.5.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `debug_unsafe` | 0.1.4 | Apache-2.0 OR MIT | <https://github.com/RoDmitry/debug_unsafe> |
| `der` | 0.7.10 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/der> |
| `der-parser` | 10.0.0 | Apache-2.0 OR MIT | <https://github.com/rusticata/der-parser> |
| `der_derive` | 0.7.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/der/derive> |
| `deranged` | 0.5.8 | Apache-2.0 OR MIT | <https://github.com/jhpratt/deranged> |
| `derive-syn-parse` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/sharnoff/derive-syn-parse> |
| `derive-where` | 1.6.1 | Apache-2.0 OR MIT | <https://github.com/ModProg/derive-where> |
| `derive_builder` | 0.20.2 | Apache-2.0 OR MIT | <https://github.com/colin-kiegel/rust-derive-builder> |
| `derive_builder_core` | 0.20.2 | Apache-2.0 OR MIT | <https://github.com/colin-kiegel/rust-derive-builder> |
| `derive_builder_macro` | 0.20.2 | Apache-2.0 OR MIT | <https://github.com/colin-kiegel/rust-derive-builder> |
| `des` | 0.8.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/block-ciphers> |
| `digest` | 0.10.7, 0.11.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits> |
| `dirs` | 4.0.0, 5.0.1, 6.0.0 | Apache-2.0 OR MIT | <https://github.com/soc/dirs-rs> |
| `dirs-sys` | 0.3.7, 0.4.1, 0.5.0 | Apache-2.0 OR MIT | <https://github.com/dirs-dev/dirs-sys-rs> |
| `displaydoc` | 0.2.6 | Apache-2.0 OR MIT | <https://github.com/yaahc/displaydoc> |
| `downcast-rs` | 1.2.1 | Apache-2.0 OR MIT | <https://github.com/marcianx/downcast-rs> |
| `dtoa` | 1.0.11 | Apache-2.0 OR MIT | <https://github.com/dtolnay/dtoa> |
| `dtor` | 0.3.0 | Apache-2.0 OR MIT | <https://github.com/mmastrac/rust-ctor> |
| `dtor-proc-macro` | 0.0.6 | Apache-2.0 OR MIT | <https://github.com/mmastrac/rust-ctor> |
| `dyn-clone` | 1.0.20 | Apache-2.0 OR MIT | <https://github.com/dtolnay/dyn-clone> |
| `either` | 1.17.0 | Apache-2.0 OR MIT | <https://github.com/rayon-rs/either> |
| `email-encoding` | 0.4.2 | Apache-2.0 OR MIT | <https://github.com/lettre/email-encoding> |
| `embed_plist` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/nvzqz/embed-plist-rs> |
| `enumflags2` | 0.7.12 | Apache-2.0 OR MIT | <https://github.com/meithecatte/enumflags2> |
| `enumflags2_derive` | 0.7.12 | Apache-2.0 OR MIT | <https://github.com/meithecatte/enumflags2> |
| `equivalent` | 1.0.2 | Apache-2.0 OR MIT | <https://github.com/indexmap-rs/equivalent> |
| `erased-serde` | 0.4.10 | Apache-2.0 OR MIT | <https://github.com/dtolnay/erased-serde> |
| `errno` | 0.3.14 | Apache-2.0 OR MIT | <https://github.com/lambda-fairy/rust-errno> |
| `euclid` | 0.20.14 | Apache-2.0 OR MIT | <https://github.com/servo/euclid> |
| `event-listener` | 2.5.3, 5.4.1 | Apache-2.0 OR MIT | <https://github.com/smol-rs/event-listener> |
| `event-listener-strategy` | 0.5.4 | Apache-2.0 OR MIT | <https://github.com/smol-rs/event-listener-strategy> |
| `fallible-iterator` | 0.2.0, 0.3.0 | Apache-2.0 OR MIT | <https://github.com/sfackler/rust-fallible-iterator> |
| `fallible-streaming-iterator` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/sfackler/fallible-streaming-iterator> |
| `fast-float2` | 0.2.4 | Apache-2.0 OR MIT | <https://github.com/Alexhuszagh/fast-float-rust> |
| `fastrand` | 2.5.0 | Apache-2.0 OR MIT | <https://github.com/smol-rs/fastrand> |
| `fdeflate` | 0.3.7 | Apache-2.0 OR MIT | <https://github.com/image-rs/fdeflate> |
| `filetime` | 0.2.29 | Apache-2.0 OR MIT | <https://github.com/alexcrichton/filetime> |
| `find-msvc-tools` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/rust-lang/cc-rs> |
| `flate2` | 1.1.9 | Apache-2.0 OR MIT | <https://github.com/rust-lang/flate2-rs> |
| `flume` | 0.11.1, 0.12.0 | Apache-2.0 OR MIT | <https://github.com/zesterer/flume> |
| `fnv` | 1.0.7 | Apache-2.0 OR MIT | <https://github.com/servo/rust-fnv> |
| `foreign-types` | 0.5.0 | Apache-2.0 OR MIT | <https://github.com/sfackler/foreign-types> |
| `foreign-types-macros` | 0.2.3 | Apache-2.0 OR MIT | <https://github.com/sfackler/foreign-types> |
| `foreign-types-shared` | 0.3.1 | Apache-2.0 OR MIT | <https://github.com/sfackler/foreign-types> |
| `form_urlencoded` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/servo/rust-url> |
| `fraction` | 0.17.0 | Apache-2.0 OR MIT | <https://github.com/dnsl48/fraction> |
| `futures` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-channel` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-core` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-executor` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-io` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-lite` | 2.6.1 | Apache-2.0 OR MIT | <https://github.com/smol-rs/futures-lite> |
| `futures-macro` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-rustls` | 0.26.0 | Apache-2.0 OR MIT | <https://github.com/quininer/futures-rustls> |
| `futures-sink` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-task` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `futures-util` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/futures-rs> |
| `g2gen` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/WanzenBug/g2p> |
| `g2p` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/WanzenBug/g2p> |
| `g2poly` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/WanzenBug/g2p> |
| `getrandom` | 0.2.17, 0.3.4, 0.4.3 | Apache-2.0 OR MIT | <https://github.com/rust-random/getrandom> |
| `ghash` | 0.5.1, 0.6.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/universal-hashes> |
| `gif` | 0.14.2 | Apache-2.0 OR MIT | <https://github.com/image-rs/image-gif> |
| `git2` | 0.19.0 | Apache-2.0 OR MIT | <https://github.com/rust-lang/git2-rs> |
| `glob` | 0.3.4 | Apache-2.0 OR MIT | <https://github.com/rust-lang/glob> |
| `global-hotkey` | 0.8.0 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/global-hotkey> |
| `hashbrown` | 0.12.3, 0.14.5, 0.17.1 | Apache-2.0 OR MIT | <https://github.com/rust-lang/hashbrown> |
| `hashify` | 0.2.9 | Apache-2.0 OR MIT | <https://github.com/stalwartlabs/hashify> |
| `hashlink` | 0.12.2, 0.9.1 | Apache-2.0 OR MIT | <https://github.com/djc/hashlink> |
| `heck` | 0.5.0 | Apache-2.0 OR MIT | <https://github.com/withoutboats/heck> |
| `hex` | 0.4.3 | Apache-2.0 OR MIT | <https://github.com/KokaKiwi/rust-hex> |
| `hickory-net` | 0.26.1 | Apache-2.0 OR MIT | <https://github.com/hickory-dns/hickory-dns> |
| `hickory-proto` | 0.26.1 | Apache-2.0 OR MIT | <https://github.com/hickory-dns/hickory-dns> |
| `hickory-resolver` | 0.26.1 | Apache-2.0 OR MIT | <https://github.com/hickory-dns/hickory-dns> |
| `hmac` | 0.12.1, 0.13.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/MACs> |
| `html5ever` | 0.38.0 | Apache-2.0 OR MIT | <https://github.com/servo/html5ever> |
| `http` | 1.4.2 | Apache-2.0 OR MIT | <https://github.com/hyperium/http> |
| `httparse` | 1.10.1 | Apache-2.0 OR MIT | <https://github.com/seanmonstar/httparse> |
| `httpdate` | 1.0.3 | Apache-2.0 OR MIT | <https://github.com/pyfisch/httpdate> |
| `hybrid-array` | 0.4.13 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hybrid-array> |
| `hyper-timeout` | 0.5.2 | Apache-2.0 OR MIT | <https://github.com/hjr3/hyper-timeout> |
| `iana-time-zone` | 0.1.65 | Apache-2.0 OR MIT | <https://github.com/strawlab/iana-time-zone> |
| `ident_case` | 1.0.1 | Apache-2.0 OR MIT | <https://github.com/TedDriggs/ident_case> |
| `idna` | 1.1.0 | Apache-2.0 OR MIT | <https://github.com/servo/rust-url> |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT | <https://github.com/hsivonen/idna_adapter> |
| `image` | 0.25.10 | Apache-2.0 OR MIT | <https://github.com/image-rs/image> |
| `image-webp` | 0.2.4 | Apache-2.0 OR MIT | <https://github.com/image-rs/image-webp> |
| `imap-proto` | 0.17.0 | Apache-2.0 OR MIT | <https://github.com/djc/imap-proto> |
| `indexmap` | 1.9.3, 2.14.0 | Apache-2.0 OR MIT | <https://github.com/indexmap-rs/indexmap> |
| `inout` | 0.1.4, 0.2.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `inventory` | 0.3.24 | Apache-2.0 OR MIT | <https://github.com/dtolnay/inventory> |
| `ipconfig` | 0.3.4 | Apache-2.0 OR MIT | <https://github.com/liranringel/ipconfig> |
| `ipnet` | 2.12.0 | Apache-2.0 OR MIT | <https://github.com/krisprice/ipnet> |
| `itertools` | 0.14.0 | Apache-2.0 OR MIT | <https://github.com/rust-itertools/itertools> |
| `itoa` | 1.0.18 | Apache-2.0 OR MIT | <https://github.com/dtolnay/itoa> |
| `jobserver` | 0.1.35 | Apache-2.0 OR MIT | <https://github.com/rust-lang/jobserver-rs> |
| `json-patch` | 3.0.1 | Apache-2.0 OR MIT | <https://github.com/idubrov/json-patch> |
| `jsonptr` | 0.6.3 | Apache-2.0 OR MIT | <https://github.com/chanced/jsonptr> |
| `keyboard-types` | 0.7.0 | Apache-2.0 OR MIT | <https://github.com/pyfisch/keyboard-types> |
| `keyring` | 3.6.3 | Apache-2.0 OR MIT | <https://github.com/hwchen/keyring-rs> |
| `lazy_static` | 1.5.0 | Apache-2.0 OR MIT | <https://github.com/rust-lang-nursery/lazy-static.rs> |
| `libc` | 0.2.189 | Apache-2.0 OR MIT | <https://github.com/rust-lang/libc> |
| `libgit2-sys` | 0.17.0+1.8.1 | Apache-2.0 OR MIT | <https://github.com/rust-lang/git2-rs> |
| `libssh2-sys` | 0.3.2 | Apache-2.0 OR MIT | <https://github.com/alexcrichton/ssh2-rs> |
| `libz-sys` | 1.1.29 | Apache-2.0 OR MIT | <https://github.com/rust-lang/libz-sys> |
| `lock_api` | 0.4.14 | Apache-2.0 OR MIT | <https://github.com/Amanieu/parking_lot> |
| `log` | 0.4.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/log> |
| `logos` | 0.15.1, 0.16.1 | Apache-2.0 OR MIT | <https://github.com/maciejhirsz/logos> |
| `logos-codegen` | 0.15.1, 0.16.1 | Apache-2.0 OR MIT | <https://github.com/maciejhirsz/logos> |
| `logos-derive` | 0.15.1, 0.16.1 | Apache-2.0 OR MIT | <https://github.com/maciejhirsz/logos> |
| `mac-notification-sys` | 0.6.15 | Apache-2.0 OR MIT | <https://github.com/h4llow3En/mac-notification-sys> |
| `mail-parser` | 0.11.9 | Apache-2.0 OR MIT | <https://github.com/stalwartlabs/mail-parser> |
| `manyhow` | 0.11.4 | Apache-2.0 OR MIT | <https://github.com/ModProg/manyhow> |
| `manyhow-macros` | 0.11.4 | Apache-2.0 OR MIT | <https://github.com/ModProg/manyhow> |
| `markup5ever` | 0.38.0 | Apache-2.0 OR MIT | <https://github.com/servo/html5ever> |
| `md-5` | 0.10.6, 0.11.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hashes> |
| `md4` | 0.11.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hashes> |
| `mime` | 0.3.17 | Apache-2.0 OR MIT | <https://github.com/hyperium/mime> |
| `minimal-lexical` | 0.2.1 | Apache-2.0 OR MIT | <https://github.com/Alexhuszagh/minimal-lexical> |
| `muda` | 0.19.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/muda> |
| `mysql-common-derive` | 0.32.2 | Apache-2.0 OR MIT | <https://github.com/blackbeam/rust_mysql_common> |
| `mysql_async` | 0.37.1 | Apache-2.0 OR MIT | <https://github.com/blackbeam/mysql_async> |
| `mysql_common` | 0.37.3 | Apache-2.0 OR MIT | <https://github.com/blackbeam/rust_mysql_common> |
| `notify-rust` | 4.18.0 | Apache-2.0 OR MIT | <https://github.com/hoodie/notify-rust> |
| `ntapi` | 0.4.3 | Apache-2.0 OR MIT | <https://github.com/MSxDOS/ntapi> |
| `num` | 0.4.3 | Apache-2.0 OR MIT | <https://github.com/rust-num/num> |
| `num-bigint` | 0.4.8 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-bigint> |
| `num-cmp` | 0.1.0 | Apache-2.0 OR MIT | <https://github.com/lifthrasiir/num-cmp> |
| `num-complex` | 0.4.6 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-complex> |
| `num-conv` | 0.2.2 | Apache-2.0 OR MIT | <https://github.com/jhpratt/num-conv> |
| `num-integer` | 0.1.47 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-integer> |
| `num-iter` | 0.1.46 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-iter> |
| `num-rational` | 0.4.2 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-rational> |
| `num-traits` | 0.2.19 | Apache-2.0 OR MIT | <https://github.com/rust-num/num-traits> |
| `oid-registry` | 0.8.1 | Apache-2.0 OR MIT | <https://github.com/rusticata/oid-registry> |
| `once_cell` | 1.21.4 | Apache-2.0 OR MIT | <https://github.com/matklad/once_cell> |
| `opaque-debug` | 0.3.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `openssl-src` | 300.6.1+3.6.3 | Apache-2.0 OR MIT | <https://github.com/alexcrichton/openssl-src-rs> |
| `osakit` | 0.3.1 | Apache-2.0 OR MIT | <https://github.com/mdevils/rust-osakit> |
| `p12-keystore` | 0.2.1 | Apache-2.0 OR MIT | <https://github.com/ancwrd1/p12-keystore> |
| `parking` | 2.2.1 | Apache-2.0 OR MIT | <https://github.com/smol-rs/parking> |
| `parking_lot` | 0.12.5 | Apache-2.0 OR MIT | <https://github.com/Amanieu/parking_lot> |
| `parking_lot_core` | 0.9.12 | Apache-2.0 OR MIT | <https://github.com/Amanieu/parking_lot> |
| `password-hash` | 0.5.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits/tree/master/password-hash> |
| `pbkdf2` | 0.12.2, 0.13.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/password-hashes> |
| `pem-rfc7468` | 0.7.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/pem-rfc7468> |
| `percent-encoding` | 2.3.2 | Apache-2.0 OR MIT | <https://github.com/servo/rust-url> |
| `pin-project` | 1.1.13 | Apache-2.0 OR MIT | <https://github.com/taiki-e/pin-project> |
| `pin-project-internal` | 1.1.13 | Apache-2.0 OR MIT | <https://github.com/taiki-e/pin-project> |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | <https://github.com/taiki-e/pin-project-lite> |
| `pin-utils` | 0.1.0 | Apache-2.0 OR MIT | <https://github.com/rust-lang-nursery/pin-utils> |
| `piper` | 0.2.5 | Apache-2.0 OR MIT | <https://github.com/smol-rs/piper> |
| `pkcs12` | 0.1.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/pkcs12> |
| `pkcs5` | 0.7.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/pkcs5> |
| `pkcs8` | 0.10.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/pkcs8> |
| `pkg-config` | 0.3.33 | Apache-2.0 OR MIT | <https://github.com/rust-lang/pkg-config-rs> |
| `png` | 0.17.16, 0.18.1 | Apache-2.0 OR MIT | <https://github.com/image-rs/image-png> |
| `polyval` | 0.6.2, 0.7.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/universal-hashes> |
| `portable-atomic` | 1.14.0 | Apache-2.0 OR MIT | <https://github.com/taiki-e/portable-atomic> |
| `postgres-protocol` | 0.6.12 | Apache-2.0 OR MIT | <https://github.com/rust-postgres/rust-postgres> |
| `postgres-types` | 0.2.14 | Apache-2.0 OR MIT | <https://github.com/rust-postgres/rust-postgres> |
| `postscript` | 0.14.1 | Apache-2.0 OR MIT | <https://github.com/bodoni/postscript> |
| `powerfmt` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/jhpratt/powerfmt> |
| `ppv-lite86` | 0.2.21 | Apache-2.0 OR MIT | <https://github.com/cryptocorrosion/cryptocorrosion> |
| `prefix-trie` | 0.8.4 | Apache-2.0 OR MIT | <https://github.com/tiborschneider/prefix-trie> |
| `proc-macro-crate` | 3.5.0 | Apache-2.0 OR MIT | <https://github.com/bkchr/proc-macro-crate> |
| `proc-macro-utils` | 0.10.0 | Apache-2.0 OR MIT | <https://github.com/ModProg/proc-macro-utils> |
| `proc-macro2` | 1.0.107 | Apache-2.0 OR MIT | <https://github.com/dtolnay/proc-macro2> |
| `prost-reflect` | 0.16.5 | Apache-2.0 OR MIT | <https://github.com/andrewhickman/prost-reflect> |
| `protox` | 0.9.1 | Apache-2.0 OR MIT | <https://github.com/andrewhickman/protox> |
| `protox-parse` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/andrewhickman/protox> |
| `qrcode` | 0.14.1 | Apache-2.0 OR MIT | <https://github.com/kennytm/qrcode-rust> |
| `quick-error` | 2.0.1 | Apache-2.0 OR MIT | <http://github.com/tailhook/quick-error> |
| `quinn` | 0.11.11 | Apache-2.0 OR MIT | <https://github.com/quinn-rs/quinn> |
| `quinn-proto` | 0.11.16 | Apache-2.0 OR MIT | <https://github.com/quinn-rs/quinn> |
| `quinn-udp` | 0.5.15 | Apache-2.0 OR MIT | <https://github.com/quinn-rs/quinn> |
| `quote` | 1.0.47 | Apache-2.0 OR MIT | <https://github.com/dtolnay/quote> |
| `rand` | 0.10.2, 0.8.8, 0.9.5 | Apache-2.0 OR MIT | <https://github.com/rust-random/rand> |
| `rand_chacha` | 0.3.1, 0.9.0 | Apache-2.0 OR MIT | <https://github.com/rust-random/rand> |
| `rand_core` | 0.10.1, 0.6.4, 0.9.5 | Apache-2.0 OR MIT | <https://github.com/rust-random/rand_core> |
| `rand_pcg` | 0.10.2 | Apache-2.0 OR MIT | <https://github.com/rust-random/rngs> |
| `rangemap` | 1.8.0 | Apache-2.0 OR MIT | <https://github.com/jeffparsons/rangemap> |
| `rc2` | 0.8.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/block-ciphers> |
| `rcgen` | 0.14.10 | Apache-2.0 OR MIT | <https://github.com/rustls/rcgen> |
| `ref-cast` | 1.0.26 | Apache-2.0 OR MIT | <https://github.com/dtolnay/ref-cast> |
| `ref-cast-impl` | 1.0.26 | Apache-2.0 OR MIT | <https://github.com/dtolnay/ref-cast> |
| `regex` | 1.13.1 | Apache-2.0 OR MIT | <https://github.com/rust-lang/regex> |
| `regex-automata` | 0.4.16 | Apache-2.0 OR MIT | <https://github.com/rust-lang/regex> |
| `regex-syntax` | 0.8.11 | Apache-2.0 OR MIT | <https://github.com/rust-lang/regex> |
| `relative-path` | 2.0.1 | Apache-2.0 OR MIT | <https://github.com/udoprog/relative-path> |
| `reqwest` | 0.12.28, 0.13.4 | Apache-2.0 OR MIT | <https://github.com/seanmonstar/reqwest> |
| `resolv-conf` | 0.7.6 | Apache-2.0 OR MIT | <https://github.com/hickory-dns/resolv-conf> |
| `rsasl` | 2.3.1 | Apache-2.0 OR MIT | <https://codeberg.org/dequbed/rsasl> |
| `rskafka` | 0.6.0 | Apache-2.0 OR MIT | <https://github.com/influxdata/rskafka> |
| `rust_xlsxwriter` | 0.99.1 | Apache-2.0 OR MIT | <https://github.com/jmcnamara/rust_xlsxwriter> |
| `rustc-hash` | 2.1.3 | Apache-2.0 OR MIT | <https://github.com/rust-lang/rustc-hash> |
| `rustc_version` | 0.4.1 | Apache-2.0 OR MIT | <https://github.com/djc/rustc-version-rs> |
| `rusticata-macros` | 4.1.0 | Apache-2.0 OR MIT | <https://github.com/rusticata/rusticata-macros> |
| `rustls-pki-types` | 1.15.0 | Apache-2.0 OR MIT | <https://github.com/rustls/pki-types> |
| `rustls-platform-verifier` | 0.7.0 | Apache-2.0 OR MIT | <https://github.com/rustls/rustls-platform-verifier> |
| `rustversion` | 1.0.23 | Apache-2.0 OR MIT | <https://github.com/dtolnay/rustversion> |
| `salsa20` | 0.10.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/stream-ciphers> |
| `scopeguard` | 1.2.0 | Apache-2.0 OR MIT | <https://github.com/bluss/scopeguard> |
| `scrypt` | 0.11.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/password-hashes/tree/master/scrypt> |
| `security-framework` | 2.11.1, 3.7.0 | Apache-2.0 OR MIT | <https://github.com/kornelski/rust-security-framework> |
| `security-framework-sys` | 2.17.0 | Apache-2.0 OR MIT | <https://github.com/kornelski/rust-security-framework> |
| `semver` | 1.0.28 | Apache-2.0 OR MIT | <https://github.com/dtolnay/semver> |
| `serde` | 1.0.229 | Apache-2.0 OR MIT | <https://github.com/serde-rs/serde> |
| `serde-untagged` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/dtolnay/serde-untagged> |
| `serde_bytes` | 0.11.19 | Apache-2.0 OR MIT | <https://github.com/serde-rs/bytes> |
| `serde_core` | 1.0.229 | Apache-2.0 OR MIT | <https://github.com/serde-rs/serde> |
| `serde_derive` | 1.0.229 | Apache-2.0 OR MIT | <https://github.com/serde-rs/serde> |
| `serde_derive_internals` | 0.29.1 | Apache-2.0 OR MIT | <https://github.com/serde-rs/serde> |
| `serde_json` | 1.0.151 | Apache-2.0 OR MIT | <https://github.com/serde-rs/json> |
| `serde_path_to_error` | 0.1.20 | Apache-2.0 OR MIT | <https://github.com/dtolnay/path-to-error> |
| `serde_repr` | 0.1.21 | Apache-2.0 OR MIT | <https://github.com/dtolnay/serde-repr> |
| `serde_spanned` | 1.1.1 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `serde_urlencoded` | 0.7.1 | Apache-2.0 OR MIT | <https://github.com/nox/serde_urlencoded> |
| `serde_with` | 3.21.0 | Apache-2.0 OR MIT | <https://github.com/jonasbb/serde_with> |
| `serde_with_macros` | 3.21.0 | Apache-2.0 OR MIT | <https://github.com/jonasbb/serde_with> |
| `serialize-to-javascript` | 0.1.2 | Apache-2.0 OR MIT | <https://github.com/chippers/serialize-to-javascript> |
| `serialize-to-javascript-impl` | 0.1.2 | Apache-2.0 OR MIT | <https://github.com/chippers/serialize-to-javascript> |
| `servo_arc` | 0.4.3 | Apache-2.0 OR MIT | <https://github.com/servo/stylo> |
| `sha1` | 0.10.7, 0.11.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hashes> |
| `sha2` | 0.10.9, 0.11.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/hashes> |
| `shared_library` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/tomaka/shared_library> |
| `shell-words` | 1.1.1 | Apache-2.0 OR MIT | <https://github.com/tmiasko/shell-words> |
| `shlex` | 2.0.1 | Apache-2.0 OR MIT | <https://github.com/comex/rust-shlex> |
| `signal-hook-registry` | 1.4.8 | Apache-2.0 OR MIT | <https://github.com/vorner/signal-hook> |
| `siphasher` | 1.0.3 | Apache-2.0 OR MIT | <https://github.com/jedisct1/rust-siphash> |
| `smallvec` | 1.15.2 | Apache-2.0 OR MIT | <https://github.com/servo/rust-smallvec> |
| `smb2` | 0.22.1 | Apache-2.0 OR MIT | <https://github.com/vdavid/smb2> |
| `socket2` | 0.6.5 | Apache-2.0 OR MIT | <https://github.com/rust-lang/socket2> |
| `softbuffer` | 0.4.8 | Apache-2.0 OR MIT | <https://github.com/rust-windowing/softbuffer> |
| `spki` | 0.7.3 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/spki> |
| `stable_deref_trait` | 1.2.1 | Apache-2.0 OR MIT | <https://github.com/storyyeller/stable_deref_trait> |
| `stop-token` | 0.7.0 | Apache-2.0 OR MIT | <https://github.com/async-rs/stop-token> |
| `streaming-iterator` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/sfackler/streaming-iterator> |
| `string_cache` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/servo/string-cache> |
| `string_cache_codegen` | 0.6.1 | Apache-2.0 OR MIT | <https://github.com/servo/string-cache> |
| `stringprep` | 0.1.5 | Apache-2.0 OR MIT | <https://github.com/sfackler/rust-stringprep> |
| `suppaftp` | 10.0.1 | Apache-2.0 OR MIT | <https://github.com/veeso/suppaftp> |
| `swift-rs` | 1.0.7 | Apache-2.0 OR MIT | <https://github.com/Brendonovich/swift-rs> |
| `syn` | 2.0.119, 3.0.3 | Apache-2.0 OR MIT | <https://github.com/dtolnay/syn> |
| `sys-locale` | 0.3.2 | Apache-2.0 OR MIT | <https://github.com/1Password/sys-locale> |
| `system-configuration` | 0.7.0 | Apache-2.0 OR MIT | <https://github.com/mullvad/system-configuration-rs> |
| `system-configuration-sys` | 0.6.0 | Apache-2.0 OR MIT | <https://github.com/mullvad/system-configuration-rs> |
| `tagptr` | 0.2.0 | Apache-2.0 OR MIT | <https://github.com/oliver-giersch/tagptr> |
| `tar` | 0.4.46 | Apache-2.0 OR MIT | <https://github.com/composefs/tar-rs> |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-build` | 2.6.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-codegen` | 2.6.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-macros` | 2.6.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-plugin` | 2.6.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-plugin-autostart` | 2.5.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-dialog` | 2.7.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-fs` | 2.5.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-global-shortcut` | 2.3.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-notification` | 2.4.0 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-os` | 2.3.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-process` | 2.3.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-single-instance` | 2.4.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-plugin-updater` | 2.10.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| `tauri-runtime` | 2.11.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-runtime-wry` | 2.11.4 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-utils` | 2.9.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| `tauri-winrt-notification` | 0.7.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/winrt-notification> |
| `tempfile` | 3.27.0 | Apache-2.0 OR MIT | <https://github.com/Stebalien/tempfile> |
| `tendril` | 0.5.1 | Apache-2.0 OR MIT | <https://github.com/servo/html5ever> |
| `thiserror` | 1.0.69, 2.0.19 | Apache-2.0 OR MIT | <https://github.com/dtolnay/thiserror> |
| `thiserror-impl` | 1.0.69, 2.0.19 | Apache-2.0 OR MIT | <https://github.com/dtolnay/thiserror> |
| `tiberius` | 0.12.3 | Apache-2.0 OR MIT | <https://github.com/prisma/tiberius> |
| `time` | 0.3.54 | Apache-2.0 OR MIT | <https://github.com/time-rs/time> |
| `time-core` | 0.1.9 | Apache-2.0 OR MIT | <https://github.com/time-rs/time> |
| `time-macros` | 0.2.32 | Apache-2.0 OR MIT | <https://github.com/time-rs/time> |
| `tls_codec` | 0.4.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats> |
| `tls_codec_derive` | 0.4.2 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats> |
| `tokio-postgres` | 0.7.18 | Apache-2.0 OR MIT | <https://github.com/rust-postgres/rust-postgres> |
| `tokio-rustls` | 0.24.1, 0.25.0, 0.26.4 | Apache-2.0 OR MIT | <https://github.com/rustls/tokio-rustls> |
| `toml` | 0.9.12+spec-1.1.0, 1.1.3+spec-1.1.0 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `toml_datetime` | 0.7.5+spec-1.1.0, 1.1.1+spec-1.1.0 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `toml_edit` | 0.25.13+spec-1.1.0 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `toml_parser` | 1.1.2+spec-1.1.0 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `toml_writer` | 1.1.2+spec-1.1.0 | Apache-2.0 OR MIT | <https://github.com/toml-rs/toml> |
| `tray-icon` | 0.24.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tray-icon> |
| `ttf-parser` | 0.25.1 | Apache-2.0 OR MIT | <https://github.com/harfbuzz/ttf-parser> |
| `tungstenite` | 0.29.0, 0.30.0 | Apache-2.0 OR MIT | <https://github.com/snapview/tungstenite-rs> |
| `typed-builder` | 0.22.0 | Apache-2.0 OR MIT | <https://github.com/idanarye/rust-typed-builder> |
| `typed-builder-macro` | 0.22.0 | Apache-2.0 OR MIT | <https://github.com/idanarye/rust-typed-builder> |
| `typed-path` | 0.12.3 | Apache-2.0 OR MIT | <https://github.com/chipsenkbeil/typed-path> |
| `typeid` | 1.0.3 | Apache-2.0 OR MIT | <https://github.com/dtolnay/typeid> |
| `typenum` | 1.20.1 | Apache-2.0 OR MIT | <https://github.com/paholg/typenum> |
| `unic-char-property` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/open-i18n/rust-unic> |
| `unic-char-range` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/open-i18n/rust-unic> |
| `unic-common` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/open-i18n/rust-unic> |
| `unic-ucd-ident` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/open-i18n/rust-unic> |
| `unic-ucd-version` | 0.9.0 | Apache-2.0 OR MIT | <https://github.com/open-i18n/rust-unic> |
| `unicase` | 2.9.0 | Apache-2.0 OR MIT | <https://github.com/seanmonstar/unicase> |
| `unicode-bidi` | 0.3.18 | Apache-2.0 OR MIT | <https://github.com/servo/unicode-bidi> |
| `unicode-normalization` | 0.1.25 | Apache-2.0 OR MIT | <https://github.com/unicode-rs/unicode-normalization> |
| `unicode-properties` | 0.1.4 | Apache-2.0 OR MIT | <https://github.com/unicode-rs/unicode-properties> |
| `unicode-segmentation` | 1.13.3 | Apache-2.0 OR MIT | <https://github.com/unicode-rs/unicode-segmentation> |
| `unicode-width` | 0.1.14 | Apache-2.0 OR MIT | <https://github.com/unicode-rs/unicode-width> |
| `unicode-xid` | 0.2.6 | Apache-2.0 OR MIT | <https://github.com/unicode-rs/unicode-xid> |
| `universal-hash` | 0.5.1, 0.6.1 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/traits> |
| `uom` | 0.38.0 | Apache-2.0 OR MIT | <https://github.com/iliekturtles/uom> |
| `url` | 2.5.8 | Apache-2.0 OR MIT | <https://github.com/servo/rust-url> |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT | <https://github.com/hsivonen/utf8_iter> |
| `uuid` | 1.24.0 | Apache-2.0 OR MIT | <https://github.com/uuid-rs/uuid> |
| `vcpkg` | 0.2.15 | Apache-2.0 OR MIT | <https://github.com/mcgoo/vcpkg-rs> |
| `version_check` | 0.9.5 | Apache-2.0 OR MIT | <https://github.com/SergioBenitez/version_check> |
| `web_atoms` | 0.2.5 | Apache-2.0 OR MIT | <https://github.com/servo/html5ever> |
| `weezl` | 0.1.12 | Apache-2.0 OR MIT | <https://github.com/image-rs/weezl> |
| `widestring` | 1.2.1 | Apache-2.0 OR MIT | <https://github.com/VoidStarKat/widestring-rs> |
| `winapi` | 0.3.9 | Apache-2.0 OR MIT | <https://github.com/retep998/winapi-rs> |
| `window-vibrancy` | 0.6.0 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri-plugin-vibrancy> |
| `windows` | 0.56.0, 0.61.3, 0.62.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-collections` | 0.2.0, 0.3.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-core` | 0.56.0, 0.61.2, 0.62.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-future` | 0.2.1, 0.3.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-implement` | 0.56.0, 0.60.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-interface` | 0.56.0, 0.59.3 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-link` | 0.1.3, 0.2.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-numerics` | 0.2.0, 0.3.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-registry` | 0.6.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-result` | 0.1.2, 0.3.4, 0.4.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-strings` | 0.4.2, 0.5.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-sys` | 0.48.0, 0.59.0, 0.60.2, 0.61.2 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-targets` | 0.48.5, 0.52.6, 0.53.5 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-threading` | 0.1.0, 0.2.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows-version` | 0.1.7 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `windows_x86_64_msvc` | 0.48.5, 0.52.6, 0.53.1 | Apache-2.0 OR MIT | <https://github.com/microsoft/windows-rs> |
| `wry` | 0.55.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/wry> |
| `x509-cert` | 0.2.5 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/formats/tree/master/x509-cert> |
| `x509-parser` | 0.18.1 | Apache-2.0 OR MIT | <https://github.com/rusticata/x509-parser> |
| `xattr` | 1.6.1 | Apache-2.0 OR MIT | <https://github.com/Stebalien/xattr> |
| `yaml-rust2` | 0.13.0 | Apache-2.0 OR MIT | <https://github.com/Ethiraric/yaml-rust2> |
| `yasna` | 0.6.0 | Apache-2.0 OR MIT | <https://github.com/qnighy/yasna.rs> |
| `zeroize` | 1.9.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |
| `zeroize_derive` | 1.5.0 | Apache-2.0 OR MIT | <https://github.com/RustCrypto/utils> |

### MIT — 169 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `adobe-cmap-parser` | 0.4.1 | MIT | <https://github.com/jrmuizel/adobe-cmap-parser> |
| `asynchronous-codec` | 0.6.2, 0.7.0 | MIT | <https://github.com/mxinden/asynchronous-codec> |
| `auto-launch` | 0.5.0 | MIT | <https://github.com/zzzgydi/auto-launch> |
| `axum` | 0.8.9 | MIT | <https://github.com/tokio-rs/axum> |
| `axum-core` | 0.5.6 | MIT | <https://github.com/tokio-rs/axum> |
| `axum-macros` | 0.5.1 | MIT | <https://github.com/tokio-rs/axum> |
| `bitvec` | 1.1.1 | MIT | <https://github.com/bitvecto-rs/bitvec> |
| `block2` | 0.6.2 | MIT | <https://github.com/madsmtm/objc2> |
| `bson` | 2.15.0 | MIT | <https://github.com/mongodb/bson-rust> |
| `bytes` | 1.12.1 | MIT | <https://github.com/tokio-rs/bytes> |
| `calamine` | 0.36.1 | MIT | <https://github.com/tafia/calamine> |
| `cargo_metadata` | 0.19.2 | MIT | <https://github.com/oli-obk/cargo_metadata> |
| `cfb` | 0.7.3 | MIT | <https://github.com/mdsteele/rust-cfb> |
| `cfg_aliases` | 0.2.2 | MIT | <https://github.com/katharostech/cfg_aliases> |
| `color_quant` | 1.1.0 | MIT | <https://github.com/image-rs/color_quant> |
| `combine` | 4.6.7 | MIT | <https://github.com/Marwes/combine> |
| `convert_case` | 0.10.0 | MIT | <https://github.com/rutrum/convert-case> |
| `cookie-factory` | 0.3.3 | MIT | <https://github.com/rust-bakery/cookie-factory> |
| `croner` | 4.0.1 | MIT | <https://github.com/hexagon/croner-rust> |
| `crunchy` | 0.2.4 | MIT | <https://github.com/eira-fransham/crunchy> |
| `darling` | 0.20.11, 0.23.0 | MIT | <https://github.com/TedDriggs/darling> |
| `darling_core` | 0.20.11, 0.23.0 | MIT | <https://github.com/TedDriggs/darling> |
| `darling_macro` | 0.20.11, 0.23.0 | MIT | <https://github.com/TedDriggs/darling> |
| `dashmap` | 6.2.1 | MIT | <https://github.com/xacrimon/dashmap> |
| `data-encoding` | 2.11.0 | MIT | <https://github.com/ia0/data-encoding> |
| `derive_more` | 2.1.1 | MIT | <https://github.com/JelteF/derive_more> |
| `derive_more-impl` | 2.1.1 | MIT | <https://github.com/JelteF/derive_more> |
| `dom_query` | 0.27.0 | MIT | <https://github.com/niklak/dom_query> |
| `ecb` | 0.1.2 | MIT | <https://github.com/magic-akari/ecb> |
| `email_address` | 0.2.9 | MIT | <https://github.com/johnstonskj/rust-email_address> |
| `embed-resource` | 3.0.11 | MIT | <https://github.com/nabijaczleweli/rust-embed-resource> |
| `extended` | 0.1.0 | MIT | <https://github.com/depp/extended-rs> |
| `fancy-regex` | 0.19.2 | MIT | <https://github.com/fancy-regex/fancy-regex> |
| `filedescriptor` | 0.8.3 | MIT | <https://github.com/wezterm/wezterm> |
| `fluent-uri` | 0.4.1 | MIT | <https://github.com/yescallop/fluent-uri-rs> |
| `fsevent-sys` | 4.1.0 | MIT | <https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys> |
| `funty` | 2.0.0 | MIT | <https://github.com/myrrlyn/funty> |
| `generic-array` | 0.14.7 | MIT | <https://github.com/fizyk20/generic-array> |
| `h2` | 0.4.15 | MIT | <https://github.com/hyperium/h2> |
| `hostname` | 0.4.2 | MIT | <https://github.com/djc/hostname> |
| `http-body` | 1.1.0 | MIT | <https://github.com/hyperium/http-body> |
| `http-body-util` | 0.1.4 | MIT | <https://github.com/hyperium/http-body> |
| `http-range-header` | 0.4.2 | MIT | <https://github.com/MarcusGrass/parse-range-headers> |
| `hyper` | 1.11.0 | MIT | <https://github.com/hyperium/hyper> |
| `hyper-util` | 0.1.20 | MIT | <https://github.com/hyperium/hyper-util> |
| `ico` | 0.5.0 | MIT | <https://github.com/mdsteele/rust-ico> |
| `infer` | 0.19.0 | MIT | <https://github.com/bojand/infer> |
| `integer-encoding` | 4.1.0 | MIT | <https://github.com/dermesser/integer-encoding-rs> |
| `ioctl-rs` | 0.1.6 | MIT | <https://github.com/dcuddeback/ioctl-rs> |
| `jsonschema` | 0.58.5 | MIT | <https://github.com/Stranger6667/jsonschema> |
| `jsonschema-regex` | 0.58.5 | MIT | <https://github.com/Stranger6667/jsonschema> |
| `jsonschema-value` | 0.58.5 | MIT | <https://github.com/Stranger6667/jsonschema> |
| `keyed_priority_queue` | 0.4.2 | MIT | <https://github.com/AngelicosPhosphoros/keyed_priority_queue> |
| `lapin` | 4.12.0 | MIT | <https://github.com/amqp-rs/lapin> |
| `lazy-regex` | 3.6.1 | MIT | <https://github.com/Canop/lazy-regex> |
| `lazy-regex-proc_macros` | 3.6.1 | MIT | <https://github.com/Canop/lazy-regex/tree/main/src/proc_macros> |
| `lettre` | 0.11.23 | MIT | <https://github.com/lettre/lettre> |
| `libsqlite3-sys` | 0.30.1 | MIT | <https://github.com/rusqlite/rusqlite> |
| `lopdf` | 0.42.0 | MIT | <https://github.com/J-F-Liu/lopdf> |
| `lru` | 0.18.5 | MIT | <https://github.com/jeromefroe/lru-rs> |
| `lz4_flex` | 0.13.1 | MIT | <https://github.com/pseitz/lz4_flex> |
| `macro_magic` | 0.5.1 | MIT | <https://github.com/sam0x17/macro_magic> |
| `macro_magic_core` | 0.5.1 | MIT | <https://github.com/sam0x17/macro_magic> |
| `macro_magic_core_macros` | 0.5.1 | MIT | <https://github.com/sam0x17/macro_magic> |
| `macro_magic_macros` | 0.5.1 | MIT | <https://github.com/sam0x17/macro_magic> |
| `memoffset` | 0.6.5 | MIT | <https://github.com/Gilnaa/memoffset> |
| `micromap` | 0.3.0 | MIT | <https://github.com/yegor256/micromap> |
| `mime_guess` | 2.0.5 | MIT | <https://github.com/abonander/mime_guess> |
| `minisign-verify` | 0.2.5 | MIT | <https://github.com/jedisct1/rust-minisign-verify> |
| `mio` | 1.2.2 | MIT | <https://github.com/tokio-rs/mio> |
| `new_debug_unreachable` | 1.0.6 | MIT | <https://github.com/mbrubeck/rust-debug-unreachable> |
| `nix` | 0.25.1, 0.31.3 | MIT | <https://github.com/nix-rust/nix> |
| `nom` | 7.1.3, 8.0.0 | MIT | <https://github.com/Geal/nom> |
| `objc2` | 0.6.4 | MIT | <https://github.com/madsmtm/objc2> |
| `objc2-encode` | 4.1.0 | MIT | <https://github.com/madsmtm/objc2> |
| `objc2-foundation` | 0.3.2 | MIT | <https://github.com/madsmtm/objc2> |
| `open` | 5.4.0 | MIT | <https://github.com/Byron/open-rs> |
| `openssl-sys` | 0.9.117 | MIT | <https://github.com/rust-openssl/rust-openssl> |
| `ordered-float` | 2.10.1 | MIT | <https://github.com/reem/rust-ordered-float> |
| `os_info` | 3.15.0 | MIT | <https://github.com/stanislav-tkach/os_info> |
| `outref` | 0.5.2 | MIT | <https://github.com/Nugine/outref> |
| `pdf-extract` | 0.12.1 | MIT | <https://github.com/jrmuizel/pdf-extract> |
| `pem` | 4.0.0 | MIT | <https://github.com/jcreekmore/pem-rs> |
| `phf` | 0.12.1, 0.13.1 | MIT | <https://github.com/rust-phf/rust-phf> |
| `phf_codegen` | 0.13.1 | MIT | <https://github.com/rust-phf/rust-phf> |
| `phf_generator` | 0.13.1 | MIT | <https://github.com/rust-phf/rust-phf> |
| `phf_macros` | 0.13.1 | MIT | <https://github.com/rust-phf/rust-phf> |
| `phf_shared` | 0.12.1, 0.13.1 | MIT | <https://github.com/rust-phf/rust-phf> |
| `plist` | 1.10.0 | MIT | <https://github.com/ebarnard/rust-plist> |
| `pom` | 1.1.0 | MIT | <https://github.com/J-F-Liu/pom> |
| `portable-pty` | 0.8.1 | MIT | <https://github.com/wez/wezterm> |
| `precomputed-hash` | 0.1.1 | MIT | <https://github.com/emilio/precomputed-hash> |
| `pretty-hex` | 0.3.0 | MIT | <https://github.com/wolandr/pretty-hex> |
| `pulldown-cmark` | 0.13.4 | MIT | <https://github.com/raphlinus/pulldown-cmark> |
| `pulldown-cmark-escape` | 0.11.0 | MIT | <https://github.com/raphlinus/pulldown-cmark> |
| `quick-xml` | 0.41.0 | MIT | <https://github.com/tafia/quick-xml> |
| `radium` | 0.7.0 | MIT | <https://github.com/bitvecto-rs/radium> |
| `referencing` | 0.58.5 | MIT | <https://github.com/Stranger6667/jsonschema> |
| `rfd` | 0.16.0 | MIT | <https://github.com/PolyMeilex/rfd> |
| `rquickjs` | 0.14.0 | MIT | <https://github.com/DelSkayn/rquickjs> |
| `rquickjs-core` | 0.14.0 | MIT | <https://github.com/DelSkayn/rquickjs> |
| `rquickjs-sys` | 0.14.0 | MIT | <https://github.com/DelSkayn/rquickjs> |
| `rusqlite` | 0.32.1 | MIT | <https://github.com/rusqlite/rusqlite> |
| `rustc_version_runtime` | 0.3.0 | MIT | <https://github.com/seppo0010/rustc-version-runtime-rs> |
| `saturating` | 0.1.0 | MIT | <https://github.com/breeswish/saturating-rs> |
| `schannel` | 0.1.29 | MIT | <https://github.com/steffengy/schannel-rs> |
| `schemars` | 0.8.22, 0.9.0, 1.2.1 | MIT | <https://github.com/GREsau/schemars> |
| `schemars_derive` | 0.8.22 | MIT | <https://github.com/GREsau/schemars> |
| `serde-value` | 0.7.0 | MIT | <https://github.com/arcnmx/serde-value> |
| `serde_json_path` | 0.7.2 | MIT | <https://github.com/hiltontj/serde_json_path> |
| `serde_json_path_core` | 0.2.2 | MIT | <https://github.com/hiltontj/serde_json_path> |
| `serde_json_path_macros` | 0.1.6 | MIT | <https://github.com/hiltontj/serde_json_path> |
| `serde_json_path_macros_internal` | 0.1.2 | MIT | <https://github.com/hiltontj/serde_json_path> |
| `serial` | 0.4.0 | MIT | <https://github.com/dcuddeback/serial-rs> |
| `serial-core` | 0.4.0 | MIT | <https://github.com/dcuddeback/serial-rs> |
| `serial-unix` | 0.4.0 | MIT | <https://github.com/dcuddeback/serial-rs> |
| `serial-windows` | 0.4.0 | MIT | <https://github.com/dcuddeback/serial-rs> |
| `simd-adler32` | 0.3.10 | MIT | <https://github.com/mcountryman/simd-adler32> |
| `slab` | 0.4.12 | MIT | <https://github.com/tokio-rs/slab> |
| `spin` | 0.9.9 | MIT | <https://github.com/mvdnes/spin-rs> |
| `strsim` | 0.11.1 | MIT | <https://github.com/rapidfuzz/strsim-rs> |
| `strum` | 0.27.2, 0.28.0 | MIT | <https://github.com/Peternator7/strum> |
| `strum_macros` | 0.27.2, 0.28.0 | MIT | <https://github.com/Peternator7/strum> |
| `synstructure` | 0.13.2 | MIT | <https://github.com/mystor/synstructure> |
| `sysinfo` | 0.39.6 | MIT | <https://github.com/GuillaumeGomez/sysinfo> |
| `take_mut` | 0.2.2 | MIT | <https://github.com/Sgeo/take_mut> |
| `tap` | 1.0.1 | MIT | <https://github.com/myrrlyn/tap> |
| `tauri-winres` | 0.3.6 | MIT | <https://github.com/tauri-apps/winres> |
| `termios` | 0.2.2 | MIT | <https://github.com/dcuddeback/termios-rs> |
| `tokio` | 1.53.1 | MIT | <https://github.com/tokio-rs/tokio> |
| `tokio-macros` | 2.7.1 | MIT | <https://github.com/tokio-rs/tokio> |
| `tokio-postgres-rustls` | 0.14.0 | MIT | <https://github.com/jbg/tokio-postgres-rustls> |
| `tokio-stream` | 0.1.19 | MIT | <https://github.com/tokio-rs/tokio> |
| `tokio-tungstenite` | 0.29.0, 0.30.0 | MIT | <https://github.com/snapview/tokio-tungstenite> |
| `tokio-util` | 0.7.19 | MIT | <https://github.com/tokio-rs/tokio> |
| `tonic` | 0.14.6 | MIT | <https://github.com/hyperium/tonic> |
| `tonic-prost` | 0.14.6 | MIT | <https://github.com/hyperium/tonic> |
| `tower` | 0.5.3 | MIT | <https://github.com/tower-rs/tower> |
| `tower-http` | 0.6.11 | MIT | <https://github.com/tower-rs/tower-http> |
| `tower-layer` | 0.3.3 | MIT | <https://github.com/tower-rs/tower> |
| `tower-service` | 0.3.3 | MIT | <https://github.com/tower-rs/tower> |
| `tracing` | 0.1.44 | MIT | <https://github.com/tokio-rs/tracing> |
| `tracing-attributes` | 0.1.31 | MIT | <https://github.com/tokio-rs/tracing> |
| `tracing-core` | 0.1.36 | MIT | <https://github.com/tokio-rs/tracing> |
| `trash` | 5.2.6 | MIT | <https://github.com/ArturKovacs/trash> |
| `tree-sitter` | 0.25.10 | MIT | <https://github.com/tree-sitter/tree-sitter> |
| `tree-sitter-c-sharp` | 0.23.5 | MIT | <https://github.com/tree-sitter/tree-sitter-c-sharp> |
| `tree-sitter-java` | 0.23.5 | MIT | <https://github.com/tree-sitter/tree-sitter-java> |
| `tree-sitter-language` | 0.1.9 | MIT | <https://github.com/tree-sitter/tree-sitter> |
| `tree-sitter-python` | 0.23.6 | MIT | <https://github.com/tree-sitter/tree-sitter-python> |
| `tree-sitter-typescript` | 0.23.2 | MIT | <https://github.com/tree-sitter/tree-sitter-typescript> |
| `try-lock` | 0.2.5 | MIT | <https://github.com/seanmonstar/try-lock> |
| `twox-hash` | 2.1.4 | MIT | <https://github.com/shepmaster/twox-hash> |
| `type1-encoding-parser` | 0.1.1 | MIT | <https://github.com/jrmuizel/type1-encoding-parser> |
| `urlpattern` | 0.3.0 | MIT | <https://github.com/denoland/rust-urlpattern> |
| `uuid-simd` | 0.8.0 | MIT | <https://github.com/Nugine/simd> |
| `vsimd` | 0.8.0 | MIT | <https://github.com/Nugine/simd> |
| `vswhom` | 0.1.0 | MIT | <https://github.com/nabijaczleweli/vswhom.rs> |
| `vswhom-sys` | 0.1.3 | MIT | <https://github.com/nabijaczleweli/vswhom-sys.rs> |
| `want` | 0.3.1 | MIT | <https://github.com/seanmonstar/want> |
| `webview2-com` | 0.38.2 | MIT | <https://github.com/wravery/webview2-rs> |
| `webview2-com-macros` | 0.8.1 | MIT | <https://github.com/wravery/webview2-rs> |
| `webview2-com-sys` | 0.38.2 | MIT | <https://github.com/wravery/webview2-rs> |
| `winnow` | 0.7.15, 1.0.4 | MIT | <https://github.com/winnow-rs/winnow> |
| `winreg` | 0.10.1, 0.55.0 | MIT | <https://github.com/gentoo90/winreg-rs> |
| `wyz` | 0.5.1 | MIT | <https://github.com/myrrlyn/wyz> |
| `zeromq` | 0.6.0 | MIT | <https://github.com/zeromq/zmq.rs> |
| `zip` | 4.6.1, 8.6.0 | MIT | <https://github.com/zip-rs/zip2> |
| `zmij` | 1.0.23 | MIT | <https://github.com/dtolnay/zmij> |

### Apache-2.0 — 27 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `ab_glyph` | 0.2.32 | Apache-2.0 | <https://github.com/alexheretic/ab-glyph> |
| `ab_glyph_rasterizer` | 0.1.10 | Apache-2.0 | <https://github.com/alexheretic/ab-glyph> |
| `backon` | 1.6.0 | Apache-2.0 | <https://github.com/Xuanwo/backon> |
| `cpal` | 0.18.2 | Apache-2.0 | <https://github.com/RustAudio/cpal> |
| `flagset` | 0.4.7 | Apache-2.0 | <https://github.com/enarx/flagset> |
| `gethostname` | 1.1.0 | Apache-2.0 | <https://codeberg.org/swsnr/gethostname.rs> |
| `memo-map` | 0.3.4 | Apache-2.0 | <https://github.com/mitsuhiko/memo-map> |
| `miette` | 7.6.0 | Apache-2.0 | <https://github.com/zkat/miette> |
| `miette-derive` | 7.6.0 | Apache-2.0 | <https://github.com/zkat/miette> |
| `minijinja` | 2.24.0 | Apache-2.0 | <https://github.com/mitsuhiko/minijinja> |
| `mongocrypt` | 0.4.0 | Apache-2.0 | <https://github.com/mongodb/libmongocrypt-rust> |
| `mongocrypt-sys` | 0.1.6+1.18.2 | Apache-2.0 | <https://github.com/mongodb/libmongocrypt-rust> |
| `mongodb` | 3.8.0 | Apache-2.0 | <https://github.com/mongodb/mongo-rust-driver> |
| `mongodb-internal-macros` | 3.8.0 | Apache-2.0 | <https://github.com/mongodb/mongo-rust-driver> |
| `owned_ttf_parser` | 0.25.1 | Apache-2.0 | <https://github.com/alexheretic/owned-ttf-parser> |
| `prost` | 0.14.4 | Apache-2.0 | <https://github.com/tokio-rs/prost> |
| `prost-derive` | 0.14.4 | Apache-2.0 | <https://github.com/tokio-rs/prost> |
| `prost-types` | 0.14.4 | Apache-2.0 | <https://github.com/tokio-rs/prost> |
| `rumqttc` | 0.24.0 | Apache-2.0 | <https://github.com/bytebeamio/rumqtt> |
| `russh-sftp` | 2.4.0 | Apache-2.0 | <https://github.com/AspectUnk/russh-sftp> |
| `saa` | 5.6.2 | Apache-2.0 | <https://codeberg.org/wvwwvwwv/synchronous-and-asynchronous> |
| `scc` | 3.8.8 | Apache-2.0 | <https://codeberg.org/wvwwvwwv/scalable-concurrent-containers> |
| `sdd` | 4.8.11 | Apache-2.0 | <https://codeberg.org/wvwwvwwv/scalable-delayed-dealloc> |
| `sync_wrapper` | 1.0.2 | Apache-2.0 | <https://github.com/Actyx/sync_wrapper> |
| `tao` | 0.35.3 | Apache-2.0 | <https://github.com/tauri-apps/tao> |
| `unicode-general-category` | 1.1.0 | Apache-2.0 | <https://github.com/yeslogic/unicode-general-category> |
| `zopfli` | 0.8.3 | Apache-2.0 | <https://github.com/zopfli-rs/zopfli> |

### Apache-2.0 OR MIT OR Zlib — 23 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `arcstr` | 1.2.0 | Apache-2.0 OR MIT OR Zlib | <https://github.com/thomcc/arcstr> |
| `bytemuck` | 1.25.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/Lokathor/bytemuck> |
| `dispatch2` | 0.3.1 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `lru-slab` | 0.1.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/Ralith/lru-slab> |
| `miniz_oxide` | 0.8.9 | Apache-2.0 OR MIT OR Zlib | <https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide> |
| `objc2-app-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-audio-toolbox` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-core-audio` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-core-audio-types` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-core-foundation` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-core-graphics` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-exception-helper` | 0.1.1 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-io-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-io-surface` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-osa-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-quartz-core` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-system-configuration` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `objc2-web-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/madsmtm/objc2> |
| `raw-window-handle` | 0.6.2 | Apache-2.0 OR MIT OR Zlib | <https://github.com/rust-windowing/raw-window-handle> |
| `tinyvec` | 1.12.0 | Apache-2.0 OR MIT OR Zlib | <https://github.com/Lokathor/tinyvec> |
| `tinyvec_macros` | 0.1.1 | Apache-2.0 OR MIT OR Zlib | <https://github.com/Soveu/tinyvec_macros> |
| `zune-core` | 0.5.3 | Apache-2.0 OR MIT OR Zlib | <https://github.com/etemesi254/zune-image> |
| `zune-jpeg` | 0.5.15 | Apache-2.0 OR MIT OR Zlib | <https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg> |

### MPL-2.0 — 19 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `cssparser` | 0.36.0 | MPL-2.0 | <https://github.com/servo/rust-cssparser> |
| `cssparser-macros` | 0.6.1 | MPL-2.0 | <https://github.com/servo/rust-cssparser> |
| `dtoa-short` | 0.3.5 | MPL-2.0 | <https://github.com/upsuper/dtoa-short> |
| `option-ext` | 0.2.0 | MPL-2.0 | <https://github.com/soc/option-ext> |
| `selectors` | 0.36.1 | MPL-2.0 | <https://github.com/servo/stylo> |
| `symphonia` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-bundle-flac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-bundle-mp3` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-aac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-adpcm` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-alac` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-pcm` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-codec-vorbis` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-core` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-isomp4` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-ogg` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-format-riff` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-metadata` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |
| `symphonia-utils-xiph` | 0.5.5 | MPL-2.0 | <https://github.com/pdeljanov/Symphonia> |

### Unicode-3.0 — 18 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `icu_collections` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_locale_core` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_normalizer` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_normalizer_data` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_properties` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_properties_data` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `icu_provider` | 2.2.0 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `litemap` | 0.8.2 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `potential_utf` | 0.1.5 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `tinystr` | 0.8.3 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `writeable` | 0.6.3 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `yoke` | 0.8.3 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `yoke-derive` | 0.8.2 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `zerofrom` | 0.1.8 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `zerofrom-derive` | 0.1.7 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `zerotrie` | 0.2.4 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `zerovec` | 0.11.6 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |
| `zerovec-derive` | 0.11.3 | Unicode-3.0 | <https://github.com/unicode-org/icu4x> |

### MIT OR Unlicense — 9 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `aho-corasick` | 1.1.4 | MIT OR Unlicense | <https://github.com/BurntSushi/aho-corasick> |
| `byteorder` | 1.5.0 | MIT OR Unlicense | <https://github.com/BurntSushi/byteorder> |
| `byteorder-lite` | 0.1.0 | MIT OR Unlicense | <https://github.com/image-rs/byteorder-lite> |
| `globset` | 0.4.19 | MIT OR Unlicense | <https://github.com/BurntSushi/ripgrep/tree/master/crates/globset> |
| `memchr` | 2.8.3 | MIT OR Unlicense | <https://github.com/BurntSushi/memchr> |
| `same-file` | 1.0.6 | MIT OR Unlicense | <https://github.com/BurntSushi/same-file> |
| `termcolor` | 1.4.1 | MIT OR Unlicense | <https://github.com/BurntSushi/termcolor> |
| `walkdir` | 2.5.0 | MIT OR Unlicense | <https://github.com/BurntSushi/walkdir> |
| `winapi-util` | 0.1.11 | MIT OR Unlicense | <https://github.com/BurntSushi/winapi-util> |

### BSD-2-Clause — 7 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `amq-protocol` | 10.6.3 | BSD-2-Clause | <https://github.com/amqp-rs/amq-protocol> |
| `amq-protocol-tcp` | 10.6.3 | BSD-2-Clause | <https://github.com/amqp-rs/amq-protocol> |
| `amq-protocol-types` | 10.6.3 | BSD-2-Clause | <https://github.com/amqp-rs/amq-protocol> |
| `amq-protocol-uri` | 10.6.3 | BSD-2-Clause | <https://github.com/amqp-rs/amq-protocol> |
| `async-rs` | 0.8.13 | BSD-2-Clause | <https://github.com/amqp-rs/async-rs> |
| `rustls-connector` | 0.23.8 | BSD-2-Clause | <https://github.com/amqp-rs/rustls-connector> |
| `tcp-stream` | 0.34.14 | BSD-2-Clause | <https://github.com/amqp-rs/tcp-stream> |

### BSD-3-Clause — 6 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `alloc-no-stdlib` | 2.0.4 | BSD-3-Clause | <https://github.com/dropbox/rust-alloc-no-stdlib> |
| `alloc-stdlib` | 0.2.4 | BSD-3-Clause | <https://github.com/dropbox/rust-alloc-no-stdlib> |
| `curve25519-dalek` | 4.1.3 | BSD-3-Clause | <https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek> |
| `redis` | 1.6.0 | BSD-3-Clause | <https://github.com/redis-rs/redis-rs> |
| `sha1_smol` | 1.0.1 | BSD-3-Clause | <https://github.com/mitsuhiko/sha1-smol> |
| `subtle` | 2.6.1 | BSD-3-Clause | <https://github.com/dalek-cryptography/subtle> |

### Apache-2.0 OR ISC OR MIT — 5 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `hyper-rustls` | 0.27.9 | Apache-2.0 OR ISC OR MIT | <https://github.com/rustls/hyper-rustls> |
| `rustls` | 0.21.12, 0.22.4, 0.23.42 | Apache-2.0 OR ISC OR MIT | <https://github.com/rustls/rustls> |
| `rustls-native-certs` | 0.6.3, 0.7.3, 0.8.4 | Apache-2.0 OR ISC OR MIT | <https://github.com/rustls/rustls-native-certs> |
| `rustls-pemfile` | 1.0.4, 2.2.0 | Apache-2.0 OR ISC OR MIT | <https://github.com/rustls/pemfile> |
| `sct` | 0.7.1 | Apache-2.0 OR ISC OR MIT | <https://github.com/rustls/sct.rs> |

### ISC — 4 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `libloading` | 0.7.4 | ISC | <https://github.com/nagisa/rust_libloading> |
| `rustls-webpki` | 0.101.7, 0.102.8, 0.103.13 | ISC | <https://github.com/rustls/webpki> |
| `starship-battery` | 0.11.1 | ISC | <https://github.com/starship/rust-battery> |
| `untrusted` | 0.9.0 | ISC | <https://github.com/briansmith/untrusted> |

### Apache-2.0 OR BSD-2-Clause OR MIT — 2 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `mach2` | 0.6.0 | Apache-2.0 OR BSD-2-Clause OR MIT | <https://github.com/JohnTitor/mach2> |
| `zerocopy` | 0.8.55 | Apache-2.0 OR BSD-2-Clause OR MIT | <https://github.com/google/zerocopy> |

### Apache-2.0 OR BSD-3-Clause — 2 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `moxcms` | 0.8.1 | Apache-2.0 OR BSD-3-Clause | <https://github.com/awxkee/moxcms> |
| `pxfm` | 0.1.30 | Apache-2.0 OR BSD-3-Clause | <https://github.com/awxkee/pxfm> |

### Apache-2.0 OR BSD-3-Clause OR MIT — 2 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `num_enum` | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | <https://github.com/illicitonion/num_enum> |
| `num_enum_derive` | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | <https://github.com/illicitonion/num_enum> |

### CC0-1.0 — 2 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `notify` | 6.1.1 | CC0-1.0 | <https://github.com/notify-rs/notify> |
| `tiny-keccak` | 2.0.2 | CC0-1.0 | <https://github.com/debris/tiny-keccak> |

### Zlib — 2 crates

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `foldhash` | 0.2.0 | Zlib | <https://github.com/orlp/foldhash> |
| `zlib-rs` | 0.6.7 | Zlib | <https://github.com/trifectatechfoundation/zlib-rs> |

### (Apache-2.0 OR MIT) AND BSD-3-Clause — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `encoding_rs` | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | <https://github.com/hsivonen/encoding_rs> |

### (MIT OR Apache-2.0) AND Apache-2.0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `moka` | 0.12.15 | (MIT OR Apache-2.0) AND Apache-2.0 | <https://github.com/moka-rs/moka> |

### (MIT OR Apache-2.0) AND ISC — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `rqrr` | 0.11.0 | (MIT OR Apache-2.0) AND ISC | <https://github.com/WanzenBug/rqrr> |

### (MIT OR Apache-2.0) AND Unicode-3.0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `unicode-ident` | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | <https://github.com/dtolnay/unicode-ident> |

### 0BSD — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `quoted_printable` | 0.5.2 | 0BSD | <https://github.com/staktrace/quoted-printable> |

### 0BSD OR Apache-2.0 OR MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `adler2` | 2.0.1 | 0BSD OR Apache-2.0 OR MIT | <https://github.com/oyvindln/adler2> |

### Apache-2.0 AND ISC — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `ring` | 0.17.14 | Apache-2.0 AND ISC | <https://github.com/briansmith/ring> |

### Apache-2.0 AND MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | <https://github.com/rust-windowing/winit> |

### Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `rustix` | 1.1.4 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | <https://github.com/bytecodealliance/rustix> |

### Apache-2.0 OR BSL-1.0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `ryu` | 1.0.23 | Apache-2.0 OR BSL-1.0 | <https://github.com/dtolnay/ryu> |

### Apache-2.0 OR BSL-1.0 OR MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `whoami` | 2.1.2 | Apache-2.0 OR BSL-1.0 OR MIT | <https://github.com/ardaku/whoami> |

### Apache-2.0 OR CC0-1.0 OR MIT-0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `dunce` | 1.0.5 | Apache-2.0 OR CC0-1.0 OR MIT-0 | <https://gitlab.com/kornelski/dunce> |

### Apache-2.0 OR GPL-2.0-only — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `self_cell` | 1.3.0 | Apache-2.0 OR GPL-2.0-only | <https://github.com/Voultapher/self_cell> |

### BSD-3-Clause AND MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `brotli` | 8.0.4 | BSD-3-Clause AND MIT | <https://github.com/dropbox/rust-brotli> |

### BSD-3-Clause OR MIT — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `brotli-decompressor` | 5.0.3 | BSD-3-Clause OR MIT | <https://github.com/dropbox/rust-brotli-decompressor> |

### BSL-1.0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `xxhash-rust` | 0.8.18 | BSL-1.0 | <https://github.com/DoumanAsh/xxhash-rust> |

### CDLA-Permissive-2.0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `webpki-roots` | 1.0.9 | CDLA-Permissive-2.0 | <https://github.com/rustls/webpki-roots> |

### MIT AND BSD-3-Clause — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `matchit` | 0.8.4 | MIT AND BSD-3-Clause | <https://github.com/ibraheemdev/matchit> |

### MIT-0 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `borrow-or-share` | 0.2.4 | MIT-0 | <https://github.com/yescallop/borrow-or-share> |

### bzip2-1.0.6 — 1 crate

| Component | Version | Licence (SPDX) | Project |
|---|---|---|---|
| `libbz2-rs-sys` | 0.2.5 | bzip2-1.0.6 | <https://github.com/trifectatechfoundation/libbzip2-rs> |

## Notices the components carry themselves

Some components carry a notices file beside their licence, for code they took from elsewhere or
for files licensed differently from the rest. Those files are inside the published package at
the version listed, and they are the authoritative record of what they cover.

| Component | Version | Kind | File |
|---|---|---|---|
| `cfg_aliases` | 0.2.2 | crate | `NOTICES.md` |
| `es-toolkit` | 1.52.0 | npm | `NOTICE` |
| `moka` | 0.12.15 | crate | `NOTICE` |
| `monaco-editor` | 0.56.0 | npm | `ThirdPartyNotices.txt` |
| `security-framework` | 2.11.1 | crate | `THIRD_PARTY` |
| `security-framework` | 3.7.0 | crate | `THIRD_PARTY` |
| `vscode-jsonrpc` | 8.2.0 | npm | `thirdpartynotices.txt` |
| `vscode-languageserver` | 9.0.1 | npm | `thirdpartynotices.txt` |
| `vscode-languageserver-protocol` | 3.17.5 | npm | `thirdpartynotices.txt` |
| `vscode-languageserver-textdocument` | 1.0.15 | npm | `thirdpartynotices.txt` |
| `vscode-languageserver-types` | 3.17.5 | npm | `thirdpartynotices.txt` |

## Models downloaded at runtime

Not redistributed, and in no installer: if you turn on local completion, the app downloads the
model you pick into your own data directory. They are listed here because the app offers them.

The catalogue in [`src-tauri/src/localai/catalogue.rs`](src-tauri/src/localai/catalogue.rs) offers only weights under a licence the app
can point at, and a test there fails the build for any other. The conversions are published at
<https://huggingface.co/ggml-org>.

| Model | Licence (SPDX) | Published at |
|---|---|---|
| Qwen2.5-Coder 0.5B | Apache-2.0 | <https://huggingface.co/ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF> |
| Qwen2.5-Coder 1.5B | Apache-2.0 | <https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF> |
| Qwen2.5-Coder 7B | Apache-2.0 | <https://huggingface.co/ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF> |

### Speech: dictation, meetings and reading aloud

Downloaded only when dictation, meetings or a natural voice are installed from Settings, into your
own data directory, each pinned by its digest in [`src-tauri/src/dictation/mod.rs`](src-tauri/src/dictation/mod.rs),
[`src-tauri/src/meetings/mod.rs`](src-tauri/src/meetings/mod.rs) and [`src-tauri/src/speech/piper.rs`](src-tauri/src/speech/piper.rs).

| Component | Licence (SPDX) | Published at |
|---|---|---|
| whisper.cpp (the engine library) | MIT | <https://github.com/ggml-org/whisper.cpp> |
| Whisper models (ggml conversions) | MIT | <https://huggingface.co/ggerganov/whisper.cpp> |
| Silero VAD (ggml conversion) | MIT | <https://huggingface.co/ggml-org/whisper-vad> |
| sherpa-onnx (the C library) | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx> |
| ONNX Runtime (shipped inside sherpa-onnx's archive) | MIT | <https://github.com/microsoft/onnxruntime> |
| 3D-Speaker CAM++ speaker model | Apache-2.0 | <https://github.com/modelscope/3D-Speaker> |
| espeak-ng (built into sherpa-onnx's library, and its phoneme data) | GPL-3.0-or-later | <https://github.com/espeak-ng/espeak-ng> |
| Piper voice es_MX «claude» | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice es_ES «davefx» | CC0-1.0 | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice es_AR «daniela» | CC-BY-SA-4.0 | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice en_US «ljspeech» (LJ Speech recordings) | LicenseRef-PublicDomain | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice en_US «norman» (LibriVox recordings) | LicenseRef-PublicDomain | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice en_US «sam» | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice en_GB «cori» (LibriVox recordings) | LicenseRef-PublicDomain | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |
| Piper voice en_GB «northern_english_male» | CC-BY-SA-4.0 | <https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models> |

## Licence texts

Every licence named in this file is published verbatim by SPDX at
`https://spdx.org/licenses/<identifier>.html` — for example
<https://spdx.org/licenses/MPL-2.0.html>. Each npm package and each crate also carries its own
licence file inside the published artefact, and that copy is the authoritative one for that
component: it holds the copyright line these tables have no column for. The two proprietary
driver licences have no SPDX page; they are the documents named in their sections above.

## Keeping this file honest

`pnpm notices` regenerates it. `pnpm notices:check` fails when what is committed is not what the
current dependency tree would produce, which is what makes a forgotten regeneration a build
failure rather than a quiet inaccuracy. The generator refuses to run when a dependency arrives
under copyleft that no dual-licence election disarms, re-reads the licence of every C library
compiled into the binary from that library's own source, and warns when a licence identifier or
a crate that links native code turns up that has never been reviewed for this project.

What is still open is listed under *Open items* above — one item, each waiting on a decision rather than on this file.
