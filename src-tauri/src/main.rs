// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// On Windows, link.exe reports "Creating library codeflow.lib and object codeflow.exp" every time
// it links this binary, and rustc relays that as a `linker_messages` warning. The exe does export
// symbols: libgit2's `GIT_EXTERN` is `__declspec(dllexport)` under MSVC with no static-build
// switch, so the libgit2 that `libgit2-sys` compiles into us marks its nine hundred `git_*`
// functions for export, and the linker dutifully writes an import library nothing will ever use.
// Harmless, not ours to fix, and not worth a warning on every build.
#![cfg_attr(windows, allow(linker_messages))]

fn main() {
    codeflow_lib::run()
}
