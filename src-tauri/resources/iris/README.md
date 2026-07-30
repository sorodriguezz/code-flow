# IRIS support files — generated, not checked in

Everything else in this directory is a build output of `scripts/build-iris-runtime.mjs`:

| | |
|---|---|
| `runtime/` | a `jlink`-trimmed Java runtime (~36 MB) |
| `intersystems-jdbc-<version>.jar` | the driver, from Maven Central, verified against a pinned SHA-256 |
| `iris-bridge.jar` | compiled from `src-tauri/java/` |

InterSystems IRIS has no Rust driver, so `datasource/iris.rs` drives the vendor's JDBC driver
through a small Java sidecar. Shipping the runtime is what keeps that invisible to users — they
install nothing.

## Building them

```
pnpm iris:runtime
```

Needs a JDK 17 or newer on the build machine (`javac`, `jar`, `jlink`) — once per machine:

| | |
|---|---|
| Windows | `winget install EclipseAdoptium.Temurin.17.JDK` |
| macOS | `brew install --cask temurin` |
| Linux | `sudo apt install openjdk-17-jdk` |

Nothing to configure afterwards: `JAVA_HOME` and `PATH` are both checked, as is
`/usr/libexec/java_home` on macOS.

**This is a build-time requirement only.** Nobody who *installs* CodeFlow needs Java — the runtime
below ships inside the installer.

The script is incremental, so a re-run when nothing changed costs nothing. `pnpm tauri build` runs
it automatically and **fails the build** when there is no JDK, which is what stops a broken
installer from ever being published. `pnpm tauri dev` runs the `--optional` variant, which warns
instead of failing so that work on the rest of the app isn't blocked by a missing JDK.

`jlink` cannot cross-compile — it builds a runtime for the platform it runs on — so each release
platform has to build on its own runner.

## Why this file exists

`tauri.conf.json` lists this directory under `bundle.resources`, and `tauri-build` fails the
compile when a configured resource path is missing. Without a committed file here, a fresh clone
would not even `cargo check`. So the directory's *contents* are gitignored and this README keeps
the directory itself in the repository.

Without the generated files the app still builds and runs — only IRIS connections fail, with a
message pointing at `pnpm iris:runtime`.
