# JDBC bridge — generated, not checked in

Everything else in this directory is a build output of `scripts/build-jdbc-bridge.mjs`:

| | |
|---|---|
| `codeflow-jdbc-bridge.jar` | compiled from `src-tauri/java/` |

Every database CodeFlow reaches over JDBC — InterSystems IRIS and Oracle, which have dedicated
drivers on the Rust side, and the rest of the driver catalogue (`src/lib/db/driverCatalog.json`),
served by the generic one in `datasource/jdbc.rs` — runs inside one small Java sidecar: this jar.
Each session names its driver's jars when it opens, and the bridge loads them into a class loader
of their own.

**Nothing else Java ships with the app.** The Java runtime (Eclipse Temurin, from Adoptium) and the
drivers' jars (from Maven Central, or the vendor's own download) are fetched by the app the first
time a connection needs them — the connection form offers to, as DataGrip does on Test Connection —
into the app's data directory, each checked against the hash the catalogue pins
(`datasource/drivers.rs`). The drivers are the vendors' own, under their own terms, which the
Drivers panel links to; CodeFlow does not redistribute any of them.

## Building it

```
pnpm jdbc:bridge
```

Needs a JDK 17 or newer on the build machine (`javac`, `jar`) — once per machine:

| | |
|---|---|
| Windows | `winget install EclipseAdoptium.Temurin.17.JDK` |
| macOS | `brew install --cask temurin` |
| Linux | `sudo apt install openjdk-17-jdk` |

Nothing to configure afterwards: `JAVA_HOME` and `PATH` are both checked, as is
`/usr/libexec/java_home` on macOS.

**This is a build-time requirement only.** Nobody who *installs* CodeFlow needs Java.

The script is incremental, so a re-run when nothing changed costs nothing. `pnpm tauri build` runs
it automatically and **fails the build** when there is no JDK. `pnpm tauri dev` runs the
`--optional` variant, which warns instead of failing so that work on the rest of the app isn't
blocked by a missing JDK.

## Why this file exists

`tauri.conf.json` lists this directory under `bundle.resources`, and `tauri-build` fails the
compile when a configured resource path is missing. Without a committed file here, a fresh clone
would not even `cargo check`. So the directory's *contents* are gitignored and this README keeps
the directory itself in the repository.

Without the generated jar the app still builds and runs — only JDBC connections fail, with a message
pointing at `pnpm jdbc:bridge`.
