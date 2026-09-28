//! The repository's own Prettier, run over the editor's buffer.
//!
//! # Why the repository's, and never one of ours
//!
//! Same argument as `tsserver.rs`: a formatter is only right if it is the one the project checks
//! against. A bundled Prettier would disagree with the project's pinned version and ignore its
//! plugins, and every save would then produce a diff that the project's own `prettier --check`
//! rejects. So this runs what is in `node_modules` and nothing else; a repository without it gets
//! `Unavailable`, and the editor falls back to the formatter it already had.
//!
//! # How it is run
//!
//! The buffer goes in on stdin with `--stdin-filepath`, from the repository root. That one flag is
//! what makes it behave like the project's own run: Prettier picks the parser from the path,
//! resolves `.prettierrc` / `package.json#prettier` from the file's folder upwards, and — because
//! the working directory is the root — honours the root's `.prettierignore` (an ignored path comes
//! back unchanged). Nothing is written to disk here; the editor applies the answer to its buffer,
//! which is what keeps it undoable and puts it through the ordinary checked save.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

/// How long a format may take. A cold Prettier with plugins is well under two seconds on this
/// machine; ten is for a slow disk and a big file, and past it the save goes ahead unformatted
/// rather than hanging on a process that is not coming back.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// How Prettier is started for a file.
#[derive(Debug, PartialEq)]
enum Launch {
    /// `node <bin script>`, the script named by `node_modules/prettier/package.json`. Preferred: it
    /// needs no shell and is the same command on every platform.
    Node(PathBuf),
    /// The package manager's `node_modules/.bin/prettier` shim, run directly — for a layout where
    /// the package itself is not where the shim's folder says (Unix only; on Windows the shim is a
    /// `.cmd` and would need a shell).
    Shim(PathBuf),
}

/// What a format came to. `Unavailable` and `Unsupported` are not failures: they are the editor's
/// cue to use the formatter it would have used without Prettier.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Formatted { text: String },
    /// The repository has no Prettier of its own.
    Unavailable,
    /// Prettier has no parser for this file (`No parser could be inferred`).
    Unsupported,
}

/// A repo-relative path, refused when it could point anywhere else. It is only ever handed to
/// Prettier as `--stdin-filepath` — nothing reads it — but a `..` there would make Prettier resolve
/// a config from outside the repository, and an absolute path would ignore the root altogether.
fn checked_rel_path(rel_path: &str) -> Result<String, String> {
    let normalized = rel_path.replace('\\', "/");
    if normalized.trim().is_empty() {
        return Err("no file to format".to_string());
    }
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("{rel_path} is not a path inside the repository")),
        }
    }
    Ok(normalized)
}

/// The bin script a `node_modules/prettier` folder declares — `"bin": "./bin/prettier.cjs"` in
/// Prettier 3, `"bin": { "prettier": "./bin-prettier.js" }` in 2.
fn bin_script(package: &Path) -> Option<PathBuf> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?).ok()?;
    let bin = match manifest.get("bin")? {
        Value::String(path) => path.clone(),
        Value::Object(map) => map.get("prettier")?.as_str()?.to_string(),
        _ => return None,
    };
    let script = package.join(bin);
    script.is_file().then_some(script)
}

fn launch_in(dir: &Path) -> Option<Launch> {
    let modules = dir.join("node_modules");
    if let Some(script) = bin_script(&modules.join("prettier")) {
        return Some(Launch::Node(script));
    }
    if cfg!(unix) {
        let shim = modules.join(".bin").join("prettier");
        if shim.is_file() {
            return Some(Launch::Shim(shim));
        }
    }
    None
}

/// The Prettier that would format `rel_path`: the nearest `node_modules` holding one, from the
/// file's own folder up to the repository root and never past it — which is how Node resolves a
/// package, and what makes a monorepo package with its own Prettier use that one.
fn find(root: &Path, rel_path: &str) -> Option<Launch> {
    let mut dir = root.join(rel_path).parent()?.to_path_buf();
    loop {
        if !dir.starts_with(root) {
            return None;
        }
        if let Some(launch) = launch_in(&dir) {
            return Some(launch);
        }
        if dir == root || !dir.pop() {
            return None;
        }
    }
}

/// A failed run as the editor should read it. "No parser" is Prettier saying the file is not one
/// of its languages; anything else — almost always a syntax error in the buffer — is the message
/// to show, cut to its first line: Prettier follows it with a code frame, one `[error]` line per
/// source line, which is for a terminal and not for a toast.
fn classify_failure(stderr: &str) -> Result<Outcome, String> {
    if stderr.contains("No parser could be inferred") {
        return Ok(Outcome::Unsupported);
    }
    let first = stderr
        .lines()
        .map(|line| line.trim().trim_start_matches("[error]").trim())
        .find(|line| !line.is_empty())
        .unwrap_or("Prettier failed without saying why");
    Err(first.chars().take(300).collect())
}

/// Formats `text` as the file at `rel_path` with the repository's Prettier.
pub async fn format(root: &str, rel_path: &str, text: &str) -> Result<Outcome, String> {
    format_within(root, rel_path, text, TIMEOUT).await
}

async fn format_within(root: &str, rel_path: &str, text: &str, timeout: Duration) -> Result<Outcome, String> {
    let rel = checked_rel_path(rel_path)?;
    let root_path = Path::new(root);
    let Some(launch) = find(root_path, &rel) else {
        return Ok(Outcome::Unavailable);
    };

    // `proc::command`, not `Command::new`: on Windows `node` is a console binary and would flash a
    // window on every format otherwise. See `proc.rs`.
    let mut command = match &launch {
        Launch::Node(script) => {
            let mut command = crate::proc::command("node");
            command.arg(script);
            command
        }
        Launch::Shim(shim) => crate::proc::command(shim),
    };
    command
        .arg("--no-color")
        // `=` form, so a path that happens to start with `-` is still read as the path.
        .arg(format!("--stdin-filepath={rel}"))
        .current_dir(root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Dropping the child on timeout is what stops it.
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Could not start Prettier: {e}"))?;

    // Written from a task of its own: a buffer larger than the pipe fills it before Prettier has
    // read anything, and writing inline while nothing drains stdout would wait forever.
    let mut stdin = child.stdin.take().ok_or("Prettier gave no stdin")?;
    let input = text.to_owned();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Prettier failed: {e}"))?,
        Err(_) => return Err(format!("Prettier did not answer within {} s", timeout.as_secs())),
    };
    let _ = writer.await;

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map(|text| Outcome::Formatted { text })
            .map_err(|_| "Prettier answered with text that is not UTF-8".to_string());
    }
    classify_failure(&String::from_utf8_lossy(&output.stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-prettier-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install(dir: &Path, bin: Value, script: &str) {
        let package = dir.join("node_modules").join("prettier");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(package.join("package.json"), serde_json::json!({ "name": "prettier", "bin": bin }).to_string())
            .unwrap();
        std::fs::write(package.join("bin").join("prettier.cjs"), script).unwrap();
    }

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Stands in for Prettier: upper-cases what it is given, unless the path asks for one of the
    /// ways a real run fails.
    const FAKE: &str = r#"
const path = process.argv.find((arg) => arg.startsWith("--stdin-filepath=")).slice(17);
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  if (path.endsWith(".unknown")) {
    process.stderr.write(`[error] No parser could be inferred for file "${path}".\n`);
    process.exit(2);
  }
  if (path.endsWith(".bad")) {
    process.stderr.write(`[error] ${path}: SyntaxError: Unexpected token (1:5)\n[error] > 1 | let = ;\n`);
    process.exit(2);
  }
  if (path.endsWith(".slow")) {
    setTimeout(() => process.stdout.write(input), 30000);
    return;
  }
  process.stdout.write(`${input.toUpperCase()}|${process.cwd()}`);
});
"#;

    #[test]
    fn a_path_that_leaves_the_repository_is_refused() {
        assert!(checked_rel_path("src/a.ts").is_ok());
        assert_eq!(checked_rel_path("src\\a.ts").unwrap(), "src/a.ts");
        for bad in ["", "../a.ts", "src/../../a.ts", "/etc/passwd"] {
            assert!(checked_rel_path(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn the_nearest_prettier_wins_and_nothing_outside_the_root_is_used() {
        let root = scratch("find");
        // None anywhere yet.
        assert_eq!(find(&root, "packages/web/src/a.ts"), None);

        // The root's, found from deep inside — the string form of `bin`.
        install(&root, Value::String("./bin/prettier.cjs".into()), "");
        let found = find(&root, "packages/web/src/a.ts");
        assert!(matches!(found, Some(Launch::Node(ref p)) if p.starts_with(root.join("node_modules"))), "{found:?}");

        // A package with its own — the object form — outranks the root's for its files only.
        let web = root.join("packages").join("web");
        install(&web, serde_json::json!({ "prettier": "./bin/prettier.cjs" }), "");
        assert!(matches!(find(&root, "packages/web/src/a.ts"), Some(Launch::Node(ref p)) if p.starts_with(web.join("node_modules"))));
        assert!(matches!(find(&root, "packages/api/a.ts"), Some(Launch::Node(ref p)) if p.starts_with(root.join("node_modules"))));

        // A repository nested inside a folder that has one does not borrow it.
        let nested = root.join("vendor").join("other-repo");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(find(&nested, "a.ts").is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn the_bin_shim_is_used_when_the_package_cannot_be_read() {
        let root = scratch("shim");
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("prettier"), "#!/bin/sh\ncat\n").unwrap();
        assert_eq!(find(&root, "a.ts"), Some(Launch::Shim(bin.join("prettier"))));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failures_are_read_as_unsupported_or_as_their_first_line() {
        assert_eq!(
            classify_failure("[error] No parser could be inferred for file \"a.rs\".\n"),
            Ok(Outcome::Unsupported)
        );
        assert_eq!(
            classify_failure("[error] a.ts: SyntaxError: ';' expected. (3:5)\n[error]   1 | const a\n"),
            Err("a.ts: SyntaxError: ';' expected. (3:5)".to_string())
        );
        assert!(classify_failure("").is_err());
    }

    #[tokio::test]
    async fn the_buffer_goes_through_the_repositorys_prettier_from_the_root() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let root = scratch("run");
        let root_str = root.to_string_lossy().into_owned();

        // No Prettier: nothing is spawned, and the editor keeps its own formatter.
        assert_eq!(format(&root_str, "src/a.ts", "x").await, Ok(Outcome::Unavailable));

        install(&root, Value::String("./bin/prettier.cjs".into()), FAKE);
        std::fs::create_dir_all(root.join("src")).unwrap();

        let Ok(Outcome::Formatted { text }) = format(&root_str, "src/a.ts", "let a = 1;\n").await else {
            panic!("expected a formatted answer");
        };
        let (formatted, cwd) = text.split_once('|').unwrap();
        assert_eq!(formatted, "LET A = 1;\n");
        // From the root, which is what makes the root's `.prettierignore` apply.
        assert_eq!(
            Path::new(cwd).canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );

        assert_eq!(format(&root_str, "notes.unknown", "x").await, Ok(Outcome::Unsupported));
        let refused = format(&root_str, "src/b.bad", "let = ;").await.unwrap_err();
        assert_eq!(refused, "src/b.bad: SyntaxError: Unexpected token (1:5)");

        // A Prettier that never answers is given up on, and killed with the child handle.
        let started = std::time::Instant::now();
        let slow = format_within(&root_str, "src/c.slow", "x", Duration::from_millis(800)).await;
        assert!(slow.unwrap_err().contains("did not answer"));
        assert!(started.elapsed() < Duration::from_secs(5));

        let _ = std::fs::remove_dir_all(&root);
    }
}
