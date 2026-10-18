//! Touch ID / Windows Hello in front of the remembered master password.
//!
//! "Remember on this machine" puts the master password in the OS credential store, so anyone at the
//! unlocked computer opens the keyring with no question asked. With this switched on, the remembered
//! password is only used after the system's own check of who is there: Touch ID (or the Mac's login
//! password when there is no sensor) through LocalAuthentication, Windows Hello (face, fingerprint or
//! PIN) through `UserConsentVerifier`. A refused or unavailable check never falls back to opening the
//! vault: the lock screen asks for the master password instead.
//!
//! Both calls block until the person answers, so they run off the async runtime.

/// Whether this machine can run the check at all — a sensor, a Hello PIN, or a Mac login password.
pub fn available() -> bool {
    platform::available()
}

/// Asks the person to confirm it is them. `reason` is shown in the system's dialog; `window` is the
/// window it belongs to (Windows only, so the dialog opens over it rather than behind).
pub fn verify(reason: &str, window: Option<isize>) -> bool {
    platform::verify(reason, window)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    /// `LAPolicyDeviceOwnerAuthentication`: Touch ID or Apple Watch, falling back to the login
    /// password — so a Mac without a sensor still gets a real check rather than none.
    const POLICY: isize = 2;

    fn context() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"LAContext")?;
        // SAFETY: `+new` on LAContext returns a retained, initialised context.
        unsafe { msg_send![class, new] }
    }

    pub fn available() -> bool {
        let Some(context) = context() else { return false };
        // SAFETY: `canEvaluatePolicy:error:` takes the policy and an optional NSError out-pointer.
        let ok: Bool = unsafe {
            msg_send![&*context, canEvaluatePolicy: POLICY, error: std::ptr::null_mut::<*mut AnyObject>()]
        };
        ok.as_bool()
    }

    pub fn verify(reason: &str, _window: Option<isize>) -> bool {
        let Some(context) = context() else { return false };
        let (tx, rx) = mpsc::channel::<bool>();
        let reply = RcBlock::new(move |success: Bool, _error: *mut AnyObject| {
            let _ = tx.send(success.as_bool());
        });
        let reason = NSString::from_str(reason);
        // SAFETY: `evaluatePolicy:localizedReason:reply:` copies the block and calls it once, on a
        // private queue — hence the channel. The context outlives the wait below.
        unsafe {
            let _: () = msg_send![&*context, evaluatePolicy: POLICY, localizedReason: &*reason, reply: &*reply];
        }
        // Generous: a person may take a while to find the sensor. The system ends its own dialog well
        // before this.
        rx.recv_timeout(Duration::from_secs(300)).unwrap_or(false)
    }
}

#[cfg(windows)]
mod platform {
    use windows::core::{factory, HSTRING};
    use windows_future::IAsyncOperation;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.get())
            .map(|availability| availability == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    pub fn verify(reason: &str, window: Option<isize>) -> bool {
        let message = HSTRING::from(reason);
        let operation: windows::core::Result<IAsyncOperation<UserConsentVerificationResult>> = match window {
            // A desktop app's dialog has to be told its owner window, or it opens behind it.
            Some(hwnd) => factory::<UserConsentVerifier, IUserConsentVerifierInterop>().and_then(|interop| {
                // SAFETY: `hwnd` is the app's own live top-level window.
                unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut _), &message) }
            }),
            None => UserConsentVerifier::RequestVerificationAsync(&message),
        };
        operation
            .and_then(|operation| operation.get())
            .map(|result| result == UserConsentVerificationResult::Verified)
            .unwrap_or(false)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn available() -> bool {
        false
    }

    pub fn verify(_reason: &str, _window: Option<isize>) -> bool {
        false
    }
}
