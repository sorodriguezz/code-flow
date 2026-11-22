//! The browser, as tools for the agents CodeFlow runs (served by `codemap::mcp`).
//!
//! - `browser_read` renders a page in a headless browser of its own and answers with what it shows:
//!   the text as Markdown, what the page reported as broken (console errors, uncaught exceptions,
//!   resources that failed to load) and, when asked, a screenshot the model can look at. A page of
//!   the internet, the user's dev server on `localhost`, or a file of the repository — served by
//!   `crate::preview_server`, so a built site or an HTML report renders as it would in a browser.
//!   Read-only: it runs nothing of the user's and touches no window.
//! - `browser_current` says what the user is looking at in CodeFlow's browser and editor previews.
//! - `browser_open`, for a run that may act: puts a page in front of the user — the window decides
//!   where, by the same rule as a link (`lib/webPreview.ts`): their own pages in an editor tab, the
//!   internet in the «Navegador» window.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::Emitter;

pub const NAMES: &[&str] = &["browser_read", "browser_current", "browser_open"];

/// Characters of a page's Markdown an answer carries.
const MAX_MARKDOWN: usize = 30_000;

pub fn is_tool(name: &str) -> bool {
    NAMES.contains(&name)
}

/// The definitions: the two that look for every run, the one that acts for a run that may.
pub fn schemas(acts: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "browser_read",
            "description": "Opens a web page in a real browser (headless, with JavaScript) and returns its text as Markdown, the errors it reported while loading (console errors, uncaught exceptions, files that failed to load) and, with screenshot, an image of it. For the user's dev server (http://localhost:5173), a page on the internet, or an HTML/PDF file of this repository by path — use it to check a UI change actually renders, to see why a page is blank, or to read documentation a plain fetch gets empty.",
            "inputSchema": {"type": "object", "properties": {
                "url": {"type": "string", "description": "The address: http(s)://…, or localhost:PORT. Give this or path."},
                "path": {"type": "string", "description": "An .html (or .pdf/.svg) file of this repository, relative to its root. Give this or url."},
                "screenshot": {"type": "boolean", "description": "Also return an image of the page (default false)"},
                "full_page": {"type": "boolean", "description": "The screenshot covers the whole page, not only the first screen (default false)"},
                "width": {"type": "integer", "description": "Viewport width in CSS pixels (default 1280; 390 for a phone)"},
                "height": {"type": "integer", "description": "Viewport height (default 800)"},
                "wait_for": {"type": "string", "description": "A CSS selector to wait for before reading. Optional."},
                "wait_ms": {"type": "integer", "description": "Extra milliseconds to wait after loading. Optional."}
            }},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true},
        }),
        json!({
            "name": "browser_current",
            "description": "What the user has open in CodeFlow's browser window and in the editor's last page preview: the addresses and titles. Call it when they say \"this page\" or \"what I'm looking at\", then read it with browser_read.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
        }),
    ];
    if acts {
        tools.push(json!({
            "name": "browser_open",
            "description": "Shows a page to the user inside CodeFlow: their own pages (localhost, a file of this repository) in an editor tab, a site on the internet in CodeFlow's browser window. To show them the result of a change, or a page you are talking about.",
            "inputSchema": {"type": "object", "properties": {
                "url": {"type": "string", "description": "The address. Give this or path."},
                "path": {"type": "string", "description": "An .html or .pdf file of this repository, relative to its root. Give this or url."}
            }},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }));
    }
    tools
}

fn text(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// A file of the run's folder, by a path relative to it (or absolute inside it). Never outside it.
fn file_in(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    let candidate = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    let real = std::fs::canonicalize(&candidate).map_err(|_| format!("no such file: {path}"))?;
    if !real.starts_with(&root) {
        return Err(format!("{path} is outside this repository"));
    }
    if !real.is_file() {
        return Err(format!("{path} is not a file"));
    }
    Ok(real)
}

/// The URL `args` names: `url` checked to be http(s), or `path` served from the repository.
async fn address(root: &str, args: &Value) -> Result<String, String> {
    let url = text(args, "url");
    let path = text(args, "path");
    match (url.is_empty(), path.is_empty()) {
        (false, _) => {
            let url = crate::browser_window::parse_address(&url)?.to_string();
            // A preview the user opened elsewhere carries its folder's key: from another repository
            // it would read files this run was never given. Its own repository's go by `path`.
            if let Some(served) = crate::preview_server::root_of_url(&url) {
                let own = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
                if served.as_os_str().is_empty() || !served.starts_with(&own) {
                    return Err("that preview is of a folder outside this repository — give a file of this one as path".to_string());
                }
            }
            Ok(url)
        }
        (true, false) => {
            let file = file_in(root, &path)?;
            let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
            let relative = file.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            crate::preview_server::url_for(&root, &relative).await
        }
        (true, true) => Err("give url or path".to_string()),
    }
}

fn clip(markdown: &str) -> String {
    if markdown.len() <= MAX_MARKDOWN {
        return markdown.to_string();
    }
    let mut cut = MAX_MARKDOWN;
    while !markdown.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n\n[… the page goes on: {} more characters]", &markdown[..cut], markdown.len() - cut)
}

/// One call, answered as MCP content blocks — text, and an image when a screenshot was asked for.
pub async fn call(root: &str, acts: bool, name: &str, args: &Value) -> Result<Vec<Value>, String> {
    match name {
        "browser_current" => Ok(vec![json!({"type": "text", "text": crate::browser_window::current()})]),
        "browser_read" => {
            let url = address(root, args).await?;
            let number = |key: &str, default: u64| args.get(key).and_then(Value::as_u64).unwrap_or(default);
            let flag = |key: &str| args.get(key).and_then(Value::as_bool).unwrap_or(false);
            let page = crate::flows::nodes::browser::read_page(crate::flows::nodes::browser::ReadOptions {
                url,
                width: number("width", 1280) as u32,
                height: number("height", 800) as u32,
                wait_for: text(args, "wait_for"),
                wait_ms: number("wait_ms", 0),
                screenshot: flag("screenshot"),
                full_page: flag("full_page"),
                timeout: Duration::from_secs(45),
            })
            .await?;
            let mut summary = format!("# {}\n{}\n", if page.title.is_empty() { "(no title)" } else { &page.title }, page.url);
            if page.errors.is_empty() {
                summary.push_str("\nNo errors reported while loading.\n");
            } else {
                summary.push_str(&format!("\n## Errors reported while loading ({})\n", page.errors.len()));
                for error in &page.errors {
                    summary.push_str(&format!("- {error}\n"));
                }
            }
            summary.push_str("\n## Page\n\n");
            summary.push_str(&clip(&page.markdown));
            let mut content = vec![json!({"type": "text", "text": summary})];
            if let Some(png) = page.screenshot {
                // Checked rather than trusted: a block that is not an image breaks the whole answer.
                if base64::engine::general_purpose::STANDARD.decode(&png).is_ok() {
                    content.push(json!({"type": "image", "data": png, "mimeType": "image/png"}));
                }
            }
            Ok(content)
        }
        "browser_open" => {
            if !acts {
                return Err("browser_open is not available to a read-only run".to_string());
            }
            let url = address(root, args).await?;
            let app = crate::ai_usage::app().ok_or("CodeFlow is not ready yet")?;
            crate::agentcli::raise(app);
            let _ = app.emit("browser:show", json!({"url": url}));
            Ok(vec![json!({"type": "text", "text": format!("Shown to the user: {url}")})])
        }
        other => Err(format!("unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_action_is_only_offered_to_a_run_that_may_act() {
        let names = |acts| schemas(acts).iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(false), vec!["browser_read", "browser_current"]);
        assert!(names(true).contains(&"browser_open".to_string()));
        for tool in schemas(false) {
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
        }
    }

    #[test]
    fn a_path_stays_inside_the_repository() {
        let dir = std::env::temp_dir().join(format!("cf-browse-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(dir.join("site/index.html"), "<p>hi</p>").unwrap();
        let root = dir.to_string_lossy().to_string();
        assert!(file_in(&root, "site/index.html").is_ok());
        assert!(file_in(&root, "../../etc/hosts").is_err());
        assert!(file_in(&root, "site").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
