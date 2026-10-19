# `cf`

The command an agent runs inside one of CodeFlow's shells to reach the window it is working in —
`cf notify`, `cf ask`, `cf status`, `cf review`. Its source is `src-tauri/src/bin/cf.rs`; see
`src-tauri/src/agentcli.rs` for the endpoint it talks to.

This directory is **filled by a build step**, not by the repository: `pnpm cf:sidecar` (or
`tauri build`/`tauri dev`, which run it) compiles the binary and copies it here, and the bundle ships
it as a resource. Only this README is committed, so that the path exists in a fresh clone —
`tauri-build` refuses a resource path that is not there.
