//! Whether this app may use the microphone — the operating system's own answer, and its own question.
//!
//! **macOS** keeps it per app (Privacy & Security › Microphone) and, unlike Windows, does not refuse a
//! denied app's input: CoreAudio hands it silence. So the state is read before a recording opens the
//! input (`AVCaptureDevice authorizationStatusForMediaType:`), a first recording asks the system's
//! own question (`requestAccessForMediaType:` — the dialog that quotes `NSMicrophoneUsageDescription`)
//! and waits for the answer, and a refusal comes back as [`super::capture::DENIED`] rather than as a
//! transcript of nothing.
//!
//! **Windows** has no per-app question for a desktop app — only the privacy switches, which WASAPI
//! enforces by refusing to open the input; that refusal is mapped to the same error in `capture`. So
//! the state here is `unknown` until a recording says otherwise.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// Only macOS reads it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Granted,
    Denied,
    /// macOS has not asked yet: the first recording will.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Undetermined,
    /// Nothing to read on this platform — the input itself will say.
    Unknown,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;

    use super::Permission;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    fn device_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    pub fn status() -> Permission {
        let Some(class) = device_class() else { return Permission::Unknown };
        // SAFETY: a class method taking an `AVMediaType` (an NSString constant AVFoundation exports)
        // and returning `AVAuthorizationStatus`, an NSInteger.
        let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio] };
        match status {
            0 => Permission::Undetermined,
            // 1 = restricted (a profile forbids it): the user cannot grant it either, so it reads as denied.
            1 | 2 => Permission::Denied,
            3 => Permission::Granted,
            _ => Permission::Unknown,
        }
    }

    /// Asks the system's question and waits for the answer. Answers at once, without a dialog,
    /// when it has been answered before.
    pub fn request() -> Permission {
        let Some(class) = device_class() else { return Permission::Unknown };
        let (tx, rx) = mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: `requestAccessForMediaType:completionHandler:` copies the block, and calls it once,
        // on a queue of its own — which is why the answer travels back over a channel.
        unsafe {
            let _: () = msg_send![class, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*handler];
        }
        match rx.recv() {
            Ok(true) => Permission::Granted,
            Ok(false) => Permission::Denied,
            Err(_) => status(),
        }
    }
}

pub fn status() -> Permission {
    #[cfg(target_os = "macos")]
    return mac::status();
    #[cfg(not(target_os = "macos"))]
    Permission::Unknown
}

/// The system's question, when it has not been asked yet; the state either way. Blocks until the
/// user answers the dialog, so it is called off the async runtime.
pub fn request() -> Permission {
    #[cfg(target_os = "macos")]
    return match mac::status() {
        Permission::Undetermined => mac::request(),
        other => other,
    };
    #[cfg(not(target_os = "macos"))]
    Permission::Unknown
}

/// Opens the system's microphone privacy page — where a refusal is undone.
pub fn open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let target = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    #[cfg(windows)]
    let target = "ms-settings:privacy-microphone";
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("not available on this system".into());
    #[cfg(any(target_os = "macos", windows))]
    open::that(target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    /// Reads, never asks: `CODEFLOW_TEST_MIC=1 cargo test --lib dictation::permission -- --ignored --nocapture`
    /// prints this machine's inputs and the microphone state — the FFI's smoke test.
    #[test]
    #[ignore]
    fn reads_the_inputs_and_the_state() {
        if std::env::var("CODEFLOW_TEST_MIC").is_err() {
            return;
        }
        #[cfg(any(target_os = "macos", windows))]
        println!("inputs: {:#?}", crate::dictation::capture::inputs());
        println!("permission: {:?}", super::status());
        // Records a moment from the default input — only where it was granted already, so this
        // never raises the system's question by itself.
        #[cfg(any(target_os = "macos", windows))]
        if super::status() != super::Permission::Denied && super::status() != super::Permission::Undetermined {
            let levels = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = levels.clone();
            let capture = crate::dictation::capture::start("", move |_| {
                counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }, || {})
            .expect("the default input opens");
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let samples = capture.stop();
            println!("samples at 16 kHz: {} · levels: {}", samples.len(), levels.load(std::sync::atomic::Ordering::Relaxed));
            assert!(samples.len() > 16_000, "about a second and a half of audio");
        }
    }
}
