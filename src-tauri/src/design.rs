//! Design mode: the running app in a window of its own, with an element picker that hands what you
//! clicked to an agent.
//!
//! # What it is for
//!
//! The shortest description of a UI bug is the element it is about. Typing one into a prompt —
//! "the second card in the sidebar, the one with the truncated title" — is slower than pointing at
//! it and less precise than its markup. So this opens the dev server in a window, lets the user pick
//! an element in it, and sends the selector, the markup and the computed styles that matter back to
//! the app, where they become a turn for the agent that is editing that code.
//!
//! # Why a window and not a pane
//!
//! A webview embedded in the layout would have to be kept aligned with a box that moves whenever a
//! divider is dragged, a dock opens or the panel is resized — a stream of position writes from the
//! renderer to the platform, on two platforms whose child-webview behaviour differs. A window is one
//! object the OS already knows how to move, and it is the same feature.
//!
//! **One window, ever.** The label is fixed: a second call shows and navigates the one that is open
//! instead of building another. A preview is a whole browser engine — the cost the user is most
//! likely to notice — so it exists while it is being used and is destroyed on close, leaving nothing
//! behind on either platform.
//!
//! # How a pick gets out of the page
//!
//! The preview loads **somebody else's page** (the dev server's), so it must not be able to call
//! this app. It is given no IPC at all. Instead the injected script *navigates* to
//! `codeflow-pick:<base64>`, and [`on_navigation`] catches that, refuses the navigation and reads
//! the payload. The page can therefore only ever hand over data, never ask for anything — and there
//! is no capability to widen, no origin to trust, and nothing to poll.
//!
//! The script is an **initialization script**, so it is reinstalled by the webview on every
//! navigation and every reload of the dev server. Nothing on this side holds a listener per page.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// The one preview window. Fixed, because one is the limit — see the module note.
const LABEL: &str = "design";

/// The scheme the picker hands its payload over on. Never navigated to for real: the handler
/// refuses it.
const PICK_SCHEME: &str = "codeflow-pick:";

/// How much markup a pick may carry. An element's `outerHTML` can be the whole page — a wrapper
/// `<div>` holds everything under it — and a prompt is not improved by a megabyte of it. The script
/// trims to this before encoding; this is the second guard, against a page that sends its own.
const MAX_HTML: usize = 8_192;

/// What the picker sends back, and what the UI receives on `design:pick`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignPick {
    /// The page the element was picked on.
    pub url: String,
    /// A CSS selector that finds it again, built from ids, classes and `nth-of-type`.
    pub selector: String,
    /// Its markup, trimmed to [`MAX_HTML`].
    pub html: String,
    /// The computed styles worth reading — layout, type and colour, not all 300 of them.
    pub css: String,
    /// Where it is on screen, as `x,y,w,h` in CSS pixels, for a prompt that says "this is 4px off".
    pub rect: String,
}

/// The picker, injected into every page the preview loads.
///
/// Written as one function with no dependencies and no globals beyond the single marker it sets:
/// it runs inside somebody else's app, where a name collision is a bug in *their* page, and a second
/// injection (a navigation, a dev-server reload) must not install two sets of listeners.
///
/// Alt (⌥) is the modifier, which is what browser devtools use for "inspect without interacting".
/// Nothing is captured while it is not held, so the preview behaves exactly like the app it is.
const PICKER_JS: &str = r#"
(function () {
  if (window.__codeflowPicker) return;
  window.__codeflowPicker = true;

  var MAX_HTML = 8192;
  var box = null;

  function overlay() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #6c8cff;background:rgba(108,140,255,0.14);border-radius:2px;display:none';
    document.documentElement.appendChild(box);
    return box;
  }

  function selectorFor(el) {
    var parts = [];
    for (var node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      var part = node.tagName.toLowerCase();
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  var WANTED = ['display','position','width','height','padding','margin','gap','flex','grid-template-columns',
    'font-family','font-size','font-weight','line-height','color','background-color','border','border-radius',
    'box-shadow','opacity','overflow','z-index','text-align','align-items','justify-content'];

  function cssFor(el) {
    var style = getComputedStyle(el);
    var lines = [];
    for (var i = 0; i < WANTED.length; i++) {
      var value = style.getPropertyValue(WANTED[i]);
      if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') {
        lines.push(WANTED[i] + ': ' + value + ';');
      }
    }
    return lines.join('\n');
  }

  function send(el) {
    var rect = el.getBoundingClientRect();
    var html = el.outerHTML || '';
    var payload = {
      url: location.href,
      selector: selectorFor(el),
      html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) + '\n…' : html,
      css: cssFor(el),
      rect: Math.round(rect.x) + ',' + Math.round(rect.y) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height)
    };
    var json = JSON.stringify(payload);
    var bytes = new TextEncoder().encode(json);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    // A navigation the host refuses: the page hands over data and can ask for nothing. See the
    // module note on `design.rs`.
    location.href = 'codeflow-pick:' + btoa(binary);
  }

  function hide() {
    if (box) box.style.display = 'none';
  }

  document.addEventListener('mousemove', function (event) {
    if (!event.altKey) { hide(); return; }
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    var rect = el.getBoundingClientRect();
    var mark = overlay();
    mark.style.display = 'block';
    mark.style.left = rect.left + 'px';
    mark.style.top = rect.top + 'px';
    mark.style.width = rect.width + 'px';
    mark.style.height = rect.height + 'px';
  }, true);

  document.addEventListener('click', function (event) {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    hide();
    send(event.target);
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') hide();
  }, true);
})();
"#;

/// Opens the preview on `url`, or points the one that is already open at it.
///
/// `http`/`https` only: this builds a window around a URL the renderer asked for, and `file:` or a
/// custom scheme there would be a way to read the disk through a window that has no IPC but does
/// have the user's session.
#[tauri::command]
pub async fn design_open(app: AppHandle, url: String) -> Result<(), String> {
    let target = url.trim().to_string();
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err("design mode opens http(s) addresses only".into());
    }
    let parsed: tauri::Url = target.parse().map_err(|_| "not an address".to_string())?;

    if let Some(existing) = app.get_webview_window(LABEL) {
        // Navigating the open one rather than building a second: the window is the expensive part.
        existing.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    crate::applog::info(&format!("window: design_open {target}"));
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(parsed))
        .title("Design")
        .inner_size(1_024.0, 768.0)
        .min_inner_size(420.0, 320.0)
        // Reinstalled by the webview on every navigation and reload, which is what makes the picker
        // survive a dev server restarting under it.
        .initialization_script(PICKER_JS)
        .on_navigation(move |url| {
            let text = url.as_str();
            let Some(encoded) = text.strip_prefix(PICK_SCHEME) else {
                // Anything else is the page navigating itself — a link, a router, a reload — and is
                // none of this handler's business.
                return true;
            };
            if let Some(pick) = decode_pick(encoded) {
                // Emitted to every window, because the console that will use it is in the main one
                // and this closure has no handle of its own worth keeping.
                if let Some(main) = APP.get() {
                    let _ = main.emit("design:pick", pick);
                }
            }
            // Refused, always: there is nothing at this address and a failed navigation would
            // replace the page the user is picking from with an error.
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Closes the preview, if it is open. The window is a whole browser engine: it goes when the user is
/// done with it, and nothing of it is kept.
#[tauri::command]
pub fn design_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the preview is open — what the button in the UI reads to say "close" instead of "open".
#[tauri::command]
pub fn design_is_open(app: AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// The app handle, for the navigation closure.
///
/// The closure is given to the builder and outlives the call that made it, so it cannot borrow the
/// handle that came in as an argument. Set once at startup — see [`remember`] — rather than cloned
/// into every window, because there is only ever one app.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Called once from `setup`.
pub fn remember(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// A payload off the picker's URL, or `None` for anything that is not one.
///
/// Every failure here is a page that sent something else: refused quietly, because the alternative
/// is an error dialog raised by a page the user did not write.
fn decode_pick(encoded: &str) -> Option<DesignPick> {
    let bytes = BASE64.decode(encoded.trim()).ok()?;
    let json = String::from_utf8(bytes).ok()?;
    let mut pick: DesignPick = serde_json::from_str(&json).ok()?;
    if pick.html.len() > MAX_HTML {
        pick.html.truncate(MAX_HTML);
    }
    Some(pick)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(json: &str) -> String {
        BASE64.encode(json.as_bytes())
    }

    #[test]
    fn reads_a_pick_off_the_url() {
        let pick = decode_pick(&encode(
            r#"{"url":"http://localhost:1420/","selector":"div.card","html":"<div>x</div>","css":"display: flex;","rect":"1,2,3,4"}"#,
        ))
        .expect("a pick");
        assert_eq!(pick.selector, "div.card");
        assert_eq!(pick.rect, "1,2,3,4");
    }

    /// A page can navigate anywhere it likes; only its own payload is read, and nothing else may
    /// reach the app as one.
    #[test]
    fn refuses_anything_that_is_not_a_pick() {
        assert!(decode_pick("not base64 !!").is_none());
        assert!(decode_pick(&encode("[1,2,3]")).is_none());
        assert!(decode_pick(&encode(r#"{"selector":"div"}"#)).is_none());
    }

    /// The second guard, against a page that sends its own oversized markup rather than the
    /// script's trimmed copy.
    #[test]
    fn caps_the_markup_whatever_the_page_sent() {
        let html = "x".repeat(MAX_HTML * 2);
        let json = serde_json::json!({
            "url": "http://localhost:1420/",
            "selector": "div",
            "html": html,
            "css": "",
            "rect": "0,0,0,0"
        })
        .to_string();
        let pick = decode_pick(&encode(&json)).expect("a pick");
        assert_eq!(pick.html.len(), MAX_HTML);
    }
}
