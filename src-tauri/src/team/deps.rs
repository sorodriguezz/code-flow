//! A worktree's dependencies, before a check runs in it.
//!
//! Every tree a team works in is a fresh `git worktree`: the member's, the integration one, and the
//! detached copy of the base a failing check is compared against. None of them has what the
//! repository's `.gitignore` keeps out — `node_modules` above all — so `pnpm test` in one fails with
//! "vitest: not found" before it tests anything. In the base copy that hid every regression (the base
//! "failed" too, so nothing could be told apart); in the member's tree it sent work back for a
//! missing install the member was never asked to do.
//!
//! So, before a check: install what the lockfile says, offline-first and never rewriting the
//! lockfile, and only when the tree has no `node_modules` yet. Rust gets the reverse treatment: its
//! dependencies are shared through `CARGO_TARGET_DIR` instead of being rebuilt from nothing in a
//! base copy that lives for one comparison.

use std::path::Path;

/// How long an install may take. A cold `npm ci` on a large tree is minutes; past this it is hung.
pub const INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// The command that installs `root`'s JavaScript dependencies exactly as its lockfile pins them, or
/// `None` when there is nothing to install (no `package.json`, or `node_modules` already there).
pub fn install_command(root: &Path) -> Option<String> {
    if !root.join("package.json").is_file() || root.join("node_modules").exists() {
        return None;
    }
    let exists = |name: &str| root.join(name).exists();
    let declared = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|package| package["packageManager"].as_str().and_then(|v| v.split('@').next()).map(str::to_string));
    let manager = declared.unwrap_or_else(|| {
        if exists("pnpm-lock.yaml") {
            "pnpm"
        } else if exists("yarn.lock") {
            "yarn"
        } else if exists("bun.lock") || exists("bun.lockb") {
            "bun"
        } else {
            "npm"
        }
        .to_string()
    });
    Some(
        match manager.as_str() {
            "pnpm" if exists("pnpm-lock.yaml") => "pnpm install --frozen-lockfile --prefer-offline",
            "pnpm" => "pnpm install --prefer-offline",
            // Berry (a `.yarnrc.yml`) spells the frozen install differently from classic.
            "yarn" if exists(".yarnrc.yml") => "yarn install --immutable",
            "yarn" => "yarn install --frozen-lockfile --prefer-offline",
            "bun" => "bun install --frozen-lockfile",
            _ if exists("package-lock.json") || exists("npm-shrinkwrap.json") => "npm ci --prefer-offline --no-audit --no-fund",
            _ => "npm install --prefer-offline --no-audit --no-fund",
        }
        .to_string(),
    )
}

/// The environment a check in the disposable copy at `copy` runs with, borrowing what the tree it is
/// compared with (`reference`) already built: a Rust base copy compiles into the reference's
/// `target`, so only the workspace's own crates build again, not every dependency. Cargo keeps
/// artifacts of the same crate at two paths apart, so the two trees do not overwrite each other's.
pub fn shared_build_env(copy: &Path, reference: &Path) -> Vec<(String, String)> {
    let target = reference.join("target");
    if copy.join("Cargo.toml").is_file() && target.is_dir() && std::env::var_os("CARGO_TARGET_DIR").is_none() {
        return vec![("CARGO_TARGET_DIR".into(), target.to_string_lossy().into_owned())];
    }
    Vec::new()
}

/// Installs `root`'s dependencies when it has none. `Ok(None)` when nothing had to be done,
/// `Ok(Some(command))` when it installed, `Err(output)` when the install failed — the check still
/// runs then, and its failure carries this as the reason.
pub async fn ensure(root: &str) -> Result<Option<String>, String> {
    let Some(command) = install_command(Path::new(root)) else { return Ok(None) };
    let (ok, output) = crate::commands::agents_cmd::run_shell_check_with(&command, root, INSTALL_TIMEOUT, &[]).await;
    if ok {
        Ok(Some(command))
    } else {
        let tail: String = output.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        Err(format!("`{command}` falló:\n{tail}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree(std::path::PathBuf);

    impl Tree {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tree(files: &[(&str, &str)]) -> Tree {
        let dir = Tree(std::env::temp_dir().join(format!("cf-deps-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(dir.path()).unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    #[test]
    fn installs_only_a_javascript_tree_without_node_modules() {
        assert_eq!(install_command(tree(&[("Cargo.toml", "")]).path()), None);
        let done = tree(&[("package.json", "{}"), ("pnpm-lock.yaml", ""), ("node_modules/.keep", "")]);
        assert_eq!(install_command(done.path()), None, "already installed");
    }

    #[test]
    fn installs_as_the_lockfile_pins_it() {
        let cases = [
            (vec![("package.json", "{}"), ("pnpm-lock.yaml", "")], "pnpm install --frozen-lockfile --prefer-offline"),
            (vec![("package.json", "{}"), ("yarn.lock", "")], "yarn install --frozen-lockfile --prefer-offline"),
            (vec![("package.json", "{}"), ("yarn.lock", ""), (".yarnrc.yml", "")], "yarn install --immutable"),
            (vec![("package.json", "{}"), ("bun.lockb", "")], "bun install --frozen-lockfile"),
            (vec![("package.json", "{}"), ("package-lock.json", "{}")], "npm ci --prefer-offline --no-audit --no-fund"),
            (vec![("package.json", "{}")], "npm install --prefer-offline --no-audit --no-fund"),
            (vec![("package.json", r#"{"packageManager":"pnpm@9.1.0"}"#), ("pnpm-lock.yaml", "")], "pnpm install --frozen-lockfile --prefer-offline"),
        ];
        for (files, expected) in cases {
            assert_eq!(install_command(tree(&files).path()).as_deref(), Some(expected), "{files:?}");
        }
    }

    #[test]
    fn a_rust_base_copy_builds_into_the_reference_target() {
        let copy = tree(&[("Cargo.toml", "")]);
        let reference = tree(&[("Cargo.toml", ""), ("target/.keep", "")]);
        if std::env::var_os("CARGO_TARGET_DIR").is_some() {
            return;
        }
        let env = shared_build_env(copy.path(), reference.path());
        assert_eq!(env, vec![("CARGO_TARGET_DIR".to_string(), reference.path().join("target").to_string_lossy().into_owned())]);
        assert!(shared_build_env(tree(&[("package.json", "{}")]).path(), reference.path()).is_empty());
    }
}
