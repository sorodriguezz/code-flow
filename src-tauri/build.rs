use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    // On Windows the application manifest is the linker's job, not the resource file's — see
    // `app_manifest` for why the default would leave every test binary unable to start.
    let windows = WindowsAttributes::new_without_app_manifest();
    if let Err(error) = tauri_build::try_build(Attributes::new().windows_attributes(windows)) {
        panic!("failed to run tauri-build: {error:#}");
    }
    app_manifest();
    main_thread_stack();
    quiet_eh_frame_warning();
}

/// Keeps the Apple linker's "__eh_frame section too large" note out of every dev build's output.
///
/// The unoptimised binary carries 25 MB of DWARF unwind info (measured 2026-10-06, a third of it
/// this crate's own code), and the compact unwind table can only point 16 MB into it: past that, a
/// panic unwinding through those functions finds their entries the slow way. Nothing in this app
/// unwinds but a panic, so the cost is nil — `ld`'s own manual advises `-no_warn_eh_frame_too_large`
/// for debug builds — while rustc turns the linker's stderr into a warning on every link. Release
/// builds are optimised and far under the limit; they keep the warning, should they ever reach it.
///
/// Probed first: a linker that does not know an option refuses the whole link.
fn quiet_eh_frame_warning() {
    let vendor = std::env::var("CARGO_CFG_TARGET_VENDOR").unwrap_or_default();
    if vendor != "apple" || std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let known = std::process::Command::new("ld")
        .args(["-no_warn_eh_frame_too_large", "-v"])
        .output()
        .is_ok_and(|out| out.status.success());
    if known {
        println!("cargo:rustc-link-arg=-Wl,-no_warn_eh_frame_too_large");
    }
}

/// Gives the app's main thread on Windows the stack it has everywhere else.
///
/// Windows starts a process with a 1 MB main thread; macOS and Linux give it 8 MB. The main thread
/// is where this app's IPC lands — every `#[tauri::command]` the window invokes runs through the one
/// closure `generate_handler!` builds, and that closure is a `match` with nine hundred arms. A debug
/// build does not overlap the arms' stack slots the way an optimized one does, so entering the
/// closure reserves the sum of them, and the first command the window sent after start-up was enough
/// for `thread 'main' has overflowed its stack` (`STATUS_STACK_OVERFLOW`, 0xc00000fd) — reliably,
/// as soon as the frontend connected, and never when the binary was started without one.
///
/// `/STACK` sets the reservation in the executable's header. It is address space, not memory:
/// pages are committed as they are touched, so a release build pays nothing for it. 16 MB rather
/// than 8 to leave room for the list of commands to go on growing. Binaries only — the test harness
/// runs its tests on threads whose size is libtest's business — and MSVC only, as for the manifest.
fn main_thread_stack() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os != "windows" || env != "msvc" {
        return;
    }
    println!("cargo:rustc-link-arg-bins=/STACK:16777216");
}

/// Embeds the Windows application manifest — Common Controls v6 — into **every** executable this
/// package links, the test harnesses included, instead of only the app binary.
///
/// By default `tauri_build` puts that manifest into a compiled resource file alongside the icon and
/// the version info, and links it with `cargo:rustc-link-arg-bins`: the `codeflow` binary gets it,
/// and nothing built in test mode does. That was fatal rather than cosmetic. Something in the
/// dependency tree (the dialog plugin) imports `comctl32!TaskDialogIndirect`, which exists only in
/// the v6 side-by-side assembly a manifest opts into, so the loader bound the test executable to the
/// v5 `comctl32.dll` in `System32`, failed to find the import, and refused to start it at all —
/// `cargo test --lib` died with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) before running a single
/// test, on every Windows machine.
///
/// `cargo:rustc-link-arg-tests` would be the obvious fix and is the wrong one: cargo applies it to
/// `[[test]]` targets only, and refuses it outright in a package that has none. `cargo:rustc-link-arg`
/// reaches every unit the package links — the binary, the library's unit tests, the binary's own
/// harness, the Android `cdylib` — so the manifest moves there, and the resource file is built
/// without one (`new_without_app_manifest`) so the binary is not handed the same manifest twice,
/// which the linker treats as an error. The content is tauri-build's own default, verbatim.
///
/// MSVC only: the GNU toolchain's linker takes neither flag, and nobody builds this app with it.
fn app_manifest() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os != "windows" || env != "msvc" {
        return;
    }
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set for build scripts"));
    let manifest = out_dir.join("app.manifest");
    std::fs::write(
        &manifest,
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .expect("the manifest is written next to the other build outputs");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
