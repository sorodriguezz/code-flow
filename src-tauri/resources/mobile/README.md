# Remote-control client — generated, not checked in

Everything else in this directory is a build output of `pnpm build:mobile`
(`vite.mobile.config.ts`), from the sources in `src/mobile/`.

It is the page a paired phone or tablet loads: `remotectl/server.rs` serves this directory as the
fallback for every route that is not `/api/*`, with `index.html` behind it so the client's own
routing survives a hard refresh.

This README is the only file here that is committed. It exists so the directory does — Tauri lists
it under `bundle.resources` in `tauri.conf.json`, and `tauri-build` refuses to compile when a
configured resource path is missing, which would otherwise break `cargo check` on a fresh clone.
That is also why the build does **not** use `emptyOutDir`: it would delete this file. It clears
`assets/` instead — see the `mobileBundle` plugin in `vite.mobile.config.ts`.

Building is wired into both Tauri commands (`beforeDevCommand` and `beforeBuildCommand`), so a
normal `pnpm tauri dev` or `pnpm tauri build` produces it. Run `pnpm build:mobile` by hand when
iterating on the client alone, or `pnpm dev:mobile` for a dev server with HMR that proxies `/api`
to the running app.
