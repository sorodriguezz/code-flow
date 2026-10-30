/**
 * App windows whose app is not scoped to a workspace (`WorkspaceApp.global` in `railApps`). Kept
 * here, as the title bar's `appMeta` is, because `railApps` reaches shell stores a satellite must
 * not load; `satelliteGlobalApps.test.ts` fails if the two lists drift.
 */
export const GLOBAL_APP_REFS: readonly string[] = ["vault", "chat", "toolbox"];
