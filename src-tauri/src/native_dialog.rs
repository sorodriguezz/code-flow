//! The operating system's own message box, for the moments the app cannot rely on its window.
//!
//! Used where the webview is the thing in doubt — a database the frontend could not be started on
//! (`boot_guard`), a frontend that never came up (the boot watchdog), an update started from the
//! tray (`updates`) — so these speak without it: no React, no stores, no translations file. Each
//! caller picks the language with `tray::spanish`, the way the tray's own labels do.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// Shows a message box and blocks until it is answered: `Some(i)` for `buttons[i]`, `None` when it
/// was dismissed some other way.
///
/// **One to three buttons**, which is what every platform's message box can hold. The last one
/// should be the harmless choice: closing the box — Escape, or the close button Windows puts on it —
/// comes back as the last button on some platforms and as `None` on others, and callers treat the
/// two alike.
///
/// **Never on the main thread.** The dialog is shown by the main thread's event loop, and this waits
/// for it; called from there, it waits for itself.
pub fn ask(
    app: &AppHandle,
    kind: MessageDialogKind,
    title: &str,
    message: &str,
    buttons: &[&str],
) -> Option<usize> {
    let set = match buttons {
        [only] => MessageDialogButtons::OkCustom(only.to_string()),
        [first, second] => MessageDialogButtons::OkCancelCustom(first.to_string(), second.to_string()),
        [first, second, third] => MessageDialogButtons::YesNoCancelCustom(
            first.to_string(),
            second.to_string(),
            third.to_string(),
        ),
        _ => return None,
    };
    let result = app
        .dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(set)
        .blocking_show_with_result();
    chosen(&result, buttons)
}

/// Which of `buttons` a result names. The plugin reports every custom button by its label, on every
/// platform; anything else is a dismissal.
fn chosen(result: &MessageDialogResult, buttons: &[&str]) -> Option<usize> {
    match result {
        MessageDialogResult::Custom(label) => buttons.iter().position(|button| button == label),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_names_the_button_by_its_label() {
        let buttons = ["Reintentar", "Más opciones…", "Salir"];
        assert_eq!(chosen(&MessageDialogResult::Custom("Salir".into()), &buttons), Some(2));
        assert_eq!(chosen(&MessageDialogResult::Custom("Reintentar".into()), &buttons), Some(0));
        assert_eq!(chosen(&MessageDialogResult::Custom("Otra".into()), &buttons), None);
        assert_eq!(chosen(&MessageDialogResult::Cancel, &buttons), None);
        assert_eq!(chosen(&MessageDialogResult::Ok, &buttons), None);
    }
}
