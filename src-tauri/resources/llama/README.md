# Local completion engine — generated, not checked in

Everything else in this directory is a build output of `scripts/build-llama-runtime.mjs`: a pinned
[llama.cpp](https://github.com/ggml-org/llama.cpp) release, verified against a SHA-256 and trimmed
to `llama-server` plus the libraries that binary actually resolves.

| | |
|---|---|
| macOS arm64 | 12 files, ~22.5 MB |
| Windows x64 | 23 files, ~38.4 MB |

For scale, the Java runtime next door is 36 MB.

## The weights are not here

They never will be. `localai/catalogue.rs` describes three Qwen2.5-Coder models and the app
downloads whichever one the user chooses, at runtime, into `paths::models_dir()`. A user who never
turns on AI completion pays for the engine in this directory and nothing else.

## Building it

```
pnpm llama:runtime
```

Nothing to install first — unlike the IRIS runtime, this needs no toolchain, only a network
connection and `tar` (Windows has shipped bsdtar since Windows 10 1803).

The script is incremental: a `.build` stamp records the pinned tag and platform, so a re-run when
nothing changed costs nothing. `--force` re-fetches.

`pnpm tauri build` runs it automatically and **fails the build** if it cannot complete, which is
what stops an installer shipping without an engine. `pnpm tauri dev` runs the `--optional` variant,
which warns instead — work on the rest of the app is never blocked by a download.

## What is not trimmed away, and why

The keep-list in the script is not a guess. On macOS it is the `otool -L` closure of
`llama-server`; on Windows it is the PE import table closure. That is why `ggml-rpc` is kept on one
platform and not the other — the macOS build links it and the Windows build does not.

Windows also keeps all fourteen `ggml-cpu-*.dll` files, which are *not* imported: ggml's backend
loader opens them at runtime and picks the best match for the CPU it finds. They cost 16.5 MB and
they are the difference between an AVX-512 build and a baseline one on the machines that have it.
On Windows this engine has no GPU backend, so that is the whole of the feature's speed.

## Bumping the pinned build

Change `BUILD` in the script, run `pnpm llama:runtime --force`, paste the hashes it prints into
`ASSETS`, and try a completion. The script fails loudly if the release no longer contains a file
the keep-list names, which is what catches an upstream rename before it reaches an installer.

## Why this file exists

`tauri.conf.json` lists this directory under `bundle.resources`, and `tauri-build` fails the
compile when a configured resource path is missing. Without a committed file here, a fresh clone
would not even `cargo check`. So the directory's *contents* are gitignored and this README keeps
the directory itself in the repository.

Without the generated files the app still builds and runs — only inline completion is unavailable,
and `localai::engine::locate` says so with a message pointing at `pnpm llama:runtime`.
