//! «Navegador»: the pages under the browser window's bar, one per tab.
//!
//! # Why a native webview and not an iframe
//!
//! The editor's previews are iframes (`WebPreview` in the frontend), and for the user's own pages —
//! a file of the repository through `crate::preview_server`, a dev server on `localhost` — that is
//! all they need. A site on the internet is different: most of the ones worth opening (GitHub, the
//! cloud consoles, any login page) refuse to be framed (`X-Frame-Options`, `frame-ancestors`), and
//! an iframe of them is a grey box. So a page from the internet gets a webview of its own — the
//! system's, the same engine the app runs in, nothing bundled — added as a **child** of the browser
//! window (`Window::add_child`, Tauri's `unstable` multiwebview), under the bar the window's own
//! webview draws. The page's origin is the site's, so the app's commands are not there for it: Tauri
//! only answers the app's own origins.
//!
//! # Tabs
//!
//! A tab is made empty by the bar's + (no webview yet: the bar's own «new tab» page shows through)
//! and gets its page with the first address written into it. Each page is one child webview, kept
//! alive while its tab is open — so a tab left in the
//! background keeps its scroll, its form and its session — and only the active one is shown. An
//! address handed over from outside (a link, the palette, an agent) opens a tab of its own, as a
//! browser does with a link; the address bar navigates the tab it belongs to. Closing the last tab
//! closes the window.
//!
//! Every command here is `async`, so none runs on the main thread: they show, hide, close and move
//! webviews, which is the event loop's work, and a command holding the main thread while it asks
//! the event loop for something is how a window stops answering.
//!
//! # The frame is kept by hand
//!
//! A child webview has a fixed frame. The bar's height is reported by the bar itself
//! ([`browser_layout`]) — it grows when it has something to say (see `BrowserWindow`'s notices),
//! and the page moves down rather than covering it. Every resize of the window ([`relayout`], called
//! from `windows::open_browser_window`) puts every tab's page back under it, full width.
//!
//! # What the agents see
//!
//! [`current`]: the tabs open here, and the last preview the editor showed (reported by the editor
//! through [`browser_seen`]) — so "look at what I am looking at" has an answer. Reading a page is not
//! done through this window: `flows::nodes::browser::read_page` renders it headless, where nothing
//! the user is doing can be disturbed.

use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

/// A tab's webview label. No `sat-` prefix: it is not a window, and nothing that walks the
/// satellites should ever take it for one.
fn page_label(id: u64) -> String {
    format!("browser-page-{id}")
}

/// The bar's height until the bar says otherwise — the tab row and the address row.
const DEFAULT_TOP: f64 = 84.0;

/// The most tabs the window holds: each is a whole webview, and a runaway agent or a page opening
/// windows in a loop must not be able to open them without end.
const MAX_TABS: usize = 24;

/// One tab, as the bar shows it.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct PageState {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
}

/// What the bar draws: the tabs, in order, and the one on screen.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct BrowserState {
    pub tabs: Vec<PageState>,
    pub active: Option<u64>,
}

#[derive(Default)]
struct State {
    /// Where the pages start, in logical pixels from the top of the window.
    top: Option<f64>,
    tabs: Vec<PageState>,
    active: Option<u64>,
    next_id: u64,
    /// The last preview the editor showed — see [`browser_seen`].
    seen: Option<PageState>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut state = STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut state)
}

fn snapshot() -> BrowserState {
    with_state(|state| BrowserState { tabs: state.tabs.clone(), active: state.active })
}

/// What was typed into an address bar, or handed over by a link or an agent, as a URL to load.
///
/// No scheme: `localhost:5173` and `127.0.0.1:8080` are the user's own servers, spoken over plain
/// HTTP; anything else is a site, and sites are HTTPS. Only `http` and `https` load — `file:` and the
/// rest are refused rather than handed to an engine that would open them.
pub fn parse_address(input: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("write an address".to_string());
    }
    let with_scheme = if text.contains("://") {
        text.to_string()
    } else {
        let host = text.split(['/', '?', '#']).next().unwrap_or_default().to_ascii_lowercase();
        let local = host == "localhost"
            || host.starts_with("localhost:")
            || host.starts_with("127.")
            || host.starts_with("0.0.0.0")
            || host.starts_with("[::1]");
        format!("{}://{text}", if local { "http" } else { "https" })
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("{text}: {e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("{other}: links are opened in the browser only over http(s)")),
    }
}

fn emit_state(app: &AppHandle) {
    let state = snapshot();
    // The window is named after the page on screen, like any browser's.
    if let Some(window) = app.get_window(&crate::windows::browser_label()) {
        let title = state
            .active
            .and_then(|id| state.tabs.iter().find(|tab| tab.id == id))
            .map(|tab| tab.title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Navegador".to_string());
        let _ = window.set_title(&title);
    }
    let _ = app.emit("browser:state", state);
}

fn update_tab(id: u64, f: impl FnOnce(&mut PageState)) {
    with_state(|state| {
        if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
            f(tab);
        }
    });
}

/// Shows the active tab's page and hides every other one.
fn show_active(app: &AppHandle) {
    let (ids, active) = with_state(|state| (state.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(), state.active));
    for id in ids {
        if let Some(page) = app.get_webview(&page_label(id)) {
            let _ = if Some(id) == active { page.show() } else { page.hide() };
        }
    }
    match active.and_then(|id| app.get_webview(&page_label(id))) {
        Some(page) => {
            let _ = page.set_focus();
        }
        // An empty tab: the only thing to do in it is write an address.
        None => {
            if let Some(bar) = app.get_webview(&crate::windows::browser_bar_label()) {
                let _ = bar.set_focus();
            }
        }
    }
}

/// Opens `address` in the browser window, building the window if it is not there. `new_tab`: in a
/// tab of its own (a link, the palette, an agent); otherwise in the tab on screen (its address bar).
pub async fn open(app: &AppHandle, address: &str, new_tab: bool) -> Result<(), String> {
    let url = parse_address(address)?;
    let window = crate::windows::open_browser_window(app).await?;
    open_in(app, &window, url, new_tab)
}

/// [`open`], once the window is there. Not async, so a page's own `window.open` can call it from a
/// spawned task; never from the main thread, where `add_child` would wait on itself.
fn open_in(app: &AppHandle, window: &tauri::Window, url: Url, new_tab: bool) -> Result<(), String> {
    let active = with_state(|state| state.active);
    if let (false, Some(id)) = (new_tab, active) {
        if let Some(page) = app.get_webview(&page_label(id)) {
            update_tab(id, |tab| {
                tab.url = url.to_string();
                tab.loading = true;
            });
            emit_state(app);
            page.navigate(url).map_err(|e| e.to_string())?;
            let _ = page.set_focus();
            return Ok(());
        }
    }
    // The tab on screen is a new, empty one (the + button): the address fills it — its page is made
    // now — rather than opening yet another tab beside it.
    let blank = if new_tab { None } else { active.filter(|id| app.get_webview(&page_label(*id)).is_none()) };
    let id = match blank {
        Some(id) => {
            update_tab(id, |tab| {
                tab.url = url.to_string();
                tab.loading = true;
            });
            id
        }
        None => push_tab(url.as_str(), true)?,
    };
    emit_state(app);

    let top = with_state(|state| state.top.unwrap_or(DEFAULT_TOP));
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let on_load = app.clone();
    let on_title = app.clone();
    let on_popup = app.clone();
    let builder = WebviewBuilder::new(page_label(id), WebviewUrl::External(url))
        // A link to anything but a web page (`mailto:`, an app's own scheme) goes to the system, the
        // way a browser hands it to the OS; `file:` and the rest go nowhere.
        .on_navigation(move |url| match url.scheme() {
            "http" | "https" | "about" | "blob" | "data" => true,
            "mailto" | "tel" => {
                let _ = open::that(url.as_str());
                false
            }
            _ => false,
        })
        .on_page_load(move |_webview, payload| {
            let url = payload.url().to_string();
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            update_tab(id, |tab| {
                tab.url = url;
                tab.loading = loading;
            });
            emit_state(&on_load);
        })
        .on_document_title_changed(move |_webview, title| {
            update_tab(id, |tab| tab.title = title);
            emit_state(&on_title);
        })
        // `target="_blank"` and `window.open`: a tab of its own, as in a browser — never a second
        // window with no bar around it.
        .on_new_window(move |url, _features| {
            let app = on_popup.clone();
            if matches!(url.scheme(), "http" | "https") {
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_window(&crate::windows::browser_label()) {
                        let _ = open_in(&app, &window, url, true);
                    }
                });
            }
            NewWindowResponse::Deny
        });
    let added = window.add_child(builder, LogicalPosition::new(0.0, top), LogicalSize::new(size.width, (size.height - top).max(0.0)));
    if let Err(error) = added {
        forget_tab(id);
        emit_state(app);
        return Err(error.to_string());
    }
    show_active(app);
    Ok(())
}

/// A tab added at the end of the strip and put on screen — `url` empty for a new, empty one.
fn push_tab(url: &str, loading: bool) -> Result<u64, String> {
    with_state(|state| {
        if state.tabs.len() >= MAX_TABS {
            return Err(format!("the browser holds {MAX_TABS} tabs at most — close one first"));
        }
        state.next_id += 1;
        let id = state.next_id;
        state.tabs.push(PageState { id, url: url.to_string(), title: String::new(), loading });
        state.active = Some(id);
        Ok(id)
    })
}

/// A new, empty tab on screen, as a browser's +: in the strip, with nothing under the bar until an
/// address is written — unless the tab on screen already is one, which is then simply kept.
fn new_blank_tab(app: &AppHandle) -> Result<(), String> {
    let already = with_state(|state| state.active.and_then(|id| state.tabs.iter().find(|tab| tab.id == id)).is_some_and(|tab| tab.url.is_empty()));
    if !already {
        push_tab("", false)?;
    }
    show_active(app);
    emit_state(app);
    Ok(())
}

/// Takes a tab out of the list and picks the one to show instead — the one to its right, else the
/// one to its left, as browsers do.
fn forget_tab(id: u64) -> Option<u64> {
    with_state(|state| {
        let index = state.tabs.iter().position(|tab| tab.id == id)?;
        state.tabs.remove(index);
        if state.active == Some(id) {
            state.active = state.tabs.get(index).or_else(|| state.tabs.last()).map(|tab| tab.id);
        }
        state.active
    })
}

/// Puts every tab's page under the bar, full width, to the bottom of the window.
pub fn relayout(app: &AppHandle) {
    let Some(window) = app.get_window(&crate::windows::browser_label()) else { return };
    let (top, ids) = with_state(|state| (state.top.unwrap_or(DEFAULT_TOP), state.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>()));
    let Ok(scale) = window.scale_factor() else { return };
    let Ok(size) = window.inner_size() else { return };
    let size = size.to_logical::<f64>(scale);
    for id in ids {
        if let Some(page) = app.get_webview(&page_label(id)) {
            let _ = page.set_position(LogicalPosition::new(0.0, top));
            let _ = page.set_size(LogicalSize::new(size.width, (size.height - top).max(0.0)));
        }
    }
}

/// The window went away, and its pages with it.
pub fn closed() {
    with_state(|state| {
        state.tabs.clear();
        state.active = None;
        state.top = None;
    });
}

/// What an agent is told the user is looking at: the browser's tabs (the one on screen first) and
/// the editor's last preview, whichever there are.
pub fn current() -> String {
    let (browser, seen) = (snapshot(), with_state(|state| state.seen.clone()));
    let name = |title: &str| if title.is_empty() { "(no title)".to_string() } else { title.to_string() };
    let mut lines = Vec::new();
    let mut tabs = browser.tabs.clone();
    tabs.sort_by_key(|tab| Some(tab.id) != browser.active);
    for tab in tabs.iter().filter(|tab| !tab.url.is_empty()) {
        let on_screen = if Some(tab.id) == browser.active { " (on screen)" } else { "" };
        lines.push(format!("Browser tab{on_screen}: {} — {}", tab.url, name(&tab.title)));
    }
    if let Some(seen) = seen.filter(|seen| !seen.url.is_empty()) {
        lines.push(format!("Editor preview: {} — {}", seen.url, name(&seen.title)));
    }
    if lines.is_empty() {
        "Nothing is open in CodeFlow's browser or in an editor preview.".to_string()
    } else {
        lines.push("Read one with browser_read (the same URL).".to_string());
        lines.join("\n")
    }
}

/// The browser window, brought forward on a new, empty tab with the caret in its address bar — the
/// rail's button and its chord: "let me open something", before there is an address.
#[tauri::command]
pub async fn browser_show(app: AppHandle) -> Result<(), String> {
    crate::windows::open_browser_window(&app).await?;
    new_blank_tab(&app)?;
    let _ = app.emit("browser:new-tab", ());
    Ok(())
}

/// Keyboard focus to the bar's webview. Clicking a webview on macOS does not always take the first
/// responder from the page beside it, and the caret then blinks in the address bar while the keys go
/// to the page — so the bar asks for it whenever it is pressed or wants to be typed into.
#[tauri::command]
pub async fn browser_focus_bar(app: AppHandle) {
    if let Some(bar) = app.get_webview(&crate::windows::browser_bar_label()) {
        let _ = bar.set_focus();
    }
}

/// Opens an address: in a tab of its own unless `new_tab` is `false` (the address bar's own tab).
#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, new_tab: Option<bool>) -> Result<(), String> {
    open(&app, &url, new_tab.unwrap_or(true)).await
}

/// The bar's +: a new, empty tab.
#[tauri::command]
pub async fn browser_tab_new(app: AppHandle) -> Result<(), String> {
    new_blank_tab(&app)
}

/// Puts a tab on screen.
#[tauri::command]
pub async fn browser_tab_select(app: AppHandle, id: u64) {
    let known = with_state(|state| {
        let known = state.tabs.iter().any(|tab| tab.id == id);
        if known {
            state.active = Some(id);
        }
        known
    });
    if known {
        show_active(&app);
        emit_state(&app);
    }
}

/// Closes a tab — and the window with its last one.
#[tauri::command]
pub async fn browser_tab_close(app: AppHandle, id: u64) {
    if let Some(page) = app.get_webview(&page_label(id)) {
        let _ = page.close();
    }
    forget_tab(id);
    if with_state(|state| state.tabs.is_empty()) {
        if let Some(window) = app.get_window(&crate::windows::browser_label()) {
            let _ = window.close();
        }
        return;
    }
    show_active(&app);
    emit_state(&app);
}

/// The bar's back, forward, reload and stop, on the tab on screen.
#[tauri::command]
pub async fn browser_go(app: AppHandle, action: String) -> Result<(), String> {
    let id = with_state(|state| state.active).ok_or("no page is open")?;
    let page = app.get_webview(&page_label(id)).ok_or("no page is open")?;
    match action.as_str() {
        "back" => page.eval("history.back()"),
        "forward" => page.eval("history.forward()"),
        "reload" => page.reload(),
        "stop" => page.eval("window.stop()"),
        other => return Err(format!("unknown action: {other}")),
    }
    .map_err(|e| e.to_string())
}

/// Where the bar ends, measured by the bar — the pages start there.
#[tauri::command]
pub async fn browser_layout(app: AppHandle, top: f64) {
    if top.is_finite() && top >= 0.0 {
        with_state(|state| state.top = Some(top));
        relayout(&app);
    }
}

/// The tabs as the bar shows them, for a bar that has just loaded.
#[tauri::command]
pub async fn browser_state() -> BrowserState {
    snapshot()
}

/// The editor showed a preview — see [`current`]. An empty `url` forgets it.
#[tauri::command]
pub async fn browser_seen(url: String, title: String) {
    with_state(|state| {
        state.seen = (!url.trim().is_empty()).then(|| PageState { id: 0, url, title, loading: false });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_gets_the_scheme_its_host_speaks() {
        assert_eq!(parse_address("localhost:5173").unwrap().as_str(), "http://localhost:5173/");
        assert_eq!(parse_address("127.0.0.1:8080/x").unwrap().as_str(), "http://127.0.0.1:8080/x");
        assert_eq!(parse_address("example.com/docs").unwrap().as_str(), "https://example.com/docs");
        assert_eq!(parse_address(" https://a.dev ").unwrap().as_str(), "https://a.dev/");
        assert!(parse_address("file:///etc/passwd").is_err());
        assert!(parse_address("javascript://x").is_err());
        assert!(parse_address("  ").is_err());
    }

    #[test]
    fn closing_a_tab_puts_its_neighbour_on_screen() {
        with_state(|state| {
            *state = State::default();
            for id in 1..=3 {
                state.tabs.push(PageState { id, ..PageState::default() });
            }
            state.active = Some(2);
        });
        // The one to its right…
        assert_eq!(forget_tab(2), Some(3));
        // …and, for the last one, the one to its left.
        assert_eq!(forget_tab(3), Some(1));
        // A background tab closing leaves the one on screen alone.
        with_state(|state| state.tabs.push(PageState { id: 4, ..PageState::default() }));
        assert_eq!(forget_tab(4), Some(1));
        assert_eq!(forget_tab(1), None);
        closed();
    }
}
