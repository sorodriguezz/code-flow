//! «Actualizar» en lote — one branch, one commit, one pull request per repository (user,
//! 2026-10-23: «un PR por repo con las versiones nuevas, que el revisor revisa solo»).
//!
//! Only ever after the confirmation dialog listed every repository, branch and change. The rules
//! that keep it from touching the user's own work:
//! - A repository with uncommitted changes to tracked files is refused, never stashed.
//! - The branch starts from the remote's default branch (fetched first) so the PR carries only the
//!   bumps; the user is put back on the branch they were on afterwards.
//! - Lockfiles are refreshed only by the ecosystem's standard package manager found on `PATH`
//!   (`pnpm`, `npm`, `yarn`, `cargo`, `dotnet`, `go`); without it the manifests are still updated and
//!   the PR says the lockfile needs a refresh.
//! - Plain push of a new branch, never a force-push. Any failure before the push undoes this run's
//!   edits on its own branch and deletes that branch.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::bump::{self, Bump, ManifestKind};
use super::{Ecosystem, LockKind, Lockfile};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItem {
    pub manifest: String,
    pub bump: Bump,
    /// The locked version before the update — what `cargo update -p name@version` names.
    #[serde(default)]
    pub resolved: Option<String>,
    /// The version the bump moves to, for the commit message.
    pub to_version: String,
    /// Advisory ids this update fixes, for the PR description.
    #[serde(default)]
    pub fixes: Vec<String>,
}

/// One lockfile refresh to run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStep {
    /// Repository-relative directory it runs in (`""` for the root).
    pub dir: String,
    pub lockfile: String,
    pub program: String,
    pub args: Vec<String>,
    /// Found on `PATH`.
    pub available: bool,
}

impl LockStep {
    pub fn display(&self) -> String {
        format!("{} {}", self.program, self.args.join(" "))
    }
}

fn dir_of(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

fn is_within(dir: &str, ancestor: &str) -> bool {
    ancestor.is_empty() || dir == ancestor || dir.starts_with(&format!("{ancestor}/"))
}

/// The lockfile refreshes the touched manifests need. Pure apart from `on_path`.
pub fn lock_steps(items: &[UpdateItem], lockfiles: &[Lockfile], repo: &Path, on_path: impl Fn(&str) -> bool) -> (Vec<LockStep>, Vec<String>) {
    let mut steps: Vec<LockStep> = Vec::new();
    let mut manual: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let mdir = dir_of(&item.manifest);
        let eco = item.bump.ecosystem;
        let kinds: &[LockKind] = match eco {
            Ecosystem::Npm => &[LockKind::PnpmLock, LockKind::NpmLock, LockKind::YarnLock],
            Ecosystem::Cargo => &[LockKind::CargoLock],
            Ecosystem::Nuget => &[LockKind::NugetLock],
            Ecosystem::Go => &[LockKind::GoSum],
            Ecosystem::Pypi => &[LockKind::PoetryLock, LockKind::UvLock, LockKind::PipfileLock],
            Ecosystem::Maven => &[],
        };
        // Nearest above the manifest; for NuGet's central props, every project lock below it.
        let mut matched: Vec<&Lockfile> = lockfiles
            .iter()
            .filter(|l| kinds.contains(&l.kind))
            .filter(|l| {
                let ldir = dir_of(&l.path);
                if eco == Ecosystem::Nuget {
                    if item.manifest.to_ascii_lowercase().ends_with("directory.packages.props") { is_within(ldir, mdir) } else { ldir == mdir }
                } else {
                    is_within(mdir, ldir)
                }
            })
            .collect();
        if eco != Ecosystem::Nuget {
            matched.sort_by_key(|l| std::cmp::Reverse(dir_of(&l.path).len()));
            matched.truncate(1);
        }
        for lock in matched {
            let ldir = dir_of(&lock.path).to_string();
            let (program, args): (&str, Vec<String>) = match lock.kind {
                LockKind::PnpmLock => ("pnpm", vec!["install".into(), "--lockfile-only".into(), "--ignore-scripts".into()]),
                LockKind::NpmLock => ("npm", vec!["install".into(), "--package-lock-only".into(), "--ignore-scripts".into(), "--no-audit".into(), "--no-fund".into()]),
                LockKind::YarnLock => {
                    if repo.join(&ldir).join(".yarnrc.yml").is_file() {
                        ("yarn", vec!["install".into(), "--mode=update-lockfile".into()])
                    } else {
                        ("yarn", vec!["install".into(), "--ignore-scripts".into(), "--non-interactive".into()])
                    }
                }
                LockKind::CargoLock => ("cargo", vec!["update".into()]),
                LockKind::NugetLock => ("dotnet", vec!["restore".into(), "--force-evaluate".into()]),
                LockKind::GoSum => ("go", vec!["mod".into(), "tidy".into()]),
                LockKind::PoetryLock | LockKind::UvLock | LockKind::PipfileLock => {
                    if !manual.contains(&lock.path) {
                        manual.push(lock.path.clone());
                    }
                    continue;
                }
            };
            if lock.kind == LockKind::CargoLock {
                // One `cargo update` per lockfile naming every bumped crate; `name@version`
                // disambiguates a crate locked at two majors.
                let spec = match &item.resolved {
                    Some(v) => format!("{}@{v}", item.bump.name),
                    None => item.bump.name.clone(),
                };
                if let Some(step) = steps.iter_mut().find(|s| s.lockfile == lock.path) {
                    if !step.args.contains(&spec) {
                        step.args.push("-p".into());
                        step.args.push(spec);
                    }
                    continue;
                }
                if seen.insert(lock.path.clone()) {
                    steps.push(LockStep {
                        dir: ldir,
                        lockfile: lock.path.clone(),
                        program: program.into(),
                        args: vec!["update".into(), "-p".into(), spec],
                        available: on_path(program),
                    });
                }
                continue;
            }
            if seen.insert(lock.path.clone()) {
                steps.push(LockStep { dir: ldir, lockfile: lock.path.clone(), program: program.into(), args, available: on_path(program) });
            }
        }
    }
    (steps, manual)
}

/// `deps/update-2026-10-23`, or `-2`, `-3`… when that name is taken here or on the remote.
pub fn branch_name(date: &str, taken: &HashSet<String>) -> String {
    let base = format!("deps/update-{date}");
    if !taken.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|b| !taken.contains(b)).unwrap_or(base)
}

pub fn commit_message(items: &[UpdateItem], refreshed: &[String], manual: &[String]) -> String {
    let mut msg = if items.len() == 1 {
        format!("chore(deps): update {} to {}\n\n", items[0].bump.name, items[0].to_version)
    } else {
        format!("chore(deps): update {} dependencies\n\n", items.len())
    };
    for item in items {
        msg.push_str(&format!("- {} {} → {} ({})\n", item.bump.name, item.bump.from, item.bump.to, item.manifest));
    }
    if !refreshed.is_empty() {
        msg.push_str(&format!("\nLockfile refreshed with: {}\n", refreshed.join("; ")));
    }
    if !manual.is_empty() {
        msg.push_str(&format!("\nLockfile not refreshed (no package manager here): {}\n", manual.join(", ")));
    }
    msg
}

pub fn pr_body(items: &[UpdateItem], refreshed: &[String], manual: &[String]) -> String {
    let mut body = String::from("Dependency updates prepared by CodeFlow («Salud de dependencias»).\n\n| Package | From | To | Manifest | Fixes |\n|---|---|---|---|---|\n");
    for item in items {
        let fixes = if item.fixes.is_empty() { String::new() } else { item.fixes.join(", ") };
        body.push_str(&format!("| `{}` | `{}` | `{}` | `{}` | {} |\n", item.bump.name, item.bump.from, item.bump.to, item.manifest, fixes));
    }
    if !refreshed.is_empty() {
        body.push_str(&format!("\nLockfiles refreshed with `{}`.\n", refreshed.join("`, `")));
    }
    if !manual.is_empty() {
        body.push_str(&format!(
            "\n**Lockfile not refreshed** — no package manager was available: {}. Run the install before merging.\n",
            manual.iter().map(|m| format!("`{m}`")).collect::<Vec<_>>().join(", ")
        ));
    }
    body
}

/// Tracked files with uncommitted changes. Untracked files are left alone and never block: a
/// checkout carries them over untouched and nothing here adds them.
pub fn dirty_files(repo: &str) -> Result<Vec<String>, String> {
    let out = crate::git::cli::run_in(repo, &["status", "--porcelain", "--untracked-files=no"], &[])?;
    if !out.success {
        return Err(out.detail());
    }
    Ok(out.stdout.lines().filter(|l| l.len() > 3).map(|l| l[3..].to_string()).collect())
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::git::cli::run_in(repo, args, &[])?;
    if out.success { Ok(out.stdout.trim().to_string()) } else { Err(format!("git {}: {}", args.join(" "), out.detail())) }
}

/// The remote's default branch (`main`), from `origin/HEAD`, else `None`.
pub fn default_branch(repo: &str) -> Option<String> {
    let remote = crate::git::remotes::default_remote(repo).ok()?;
    let head = git(repo, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]).ok()?;
    head.strip_prefix(&format!("{remote}/")).map(str::to_string)
}

fn taken_branches(repo: &str) -> HashSet<String> {
    let mut taken = HashSet::new();
    if let Ok(list) = git(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads/deps/", "refs/remotes/"]) {
        for name in list.lines() {
            let short = name.split_once('/').filter(|_| !name.starts_with("deps/")).map(|(_, b)| b).unwrap_or(name);
            taken.insert(short.to_string());
        }
    }
    taken
}

/// What the dialog shows before anything is touched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub branch: String,
    /// The branch the PR targets.
    pub target: String,
    pub current_branch: String,
    pub dirty: Vec<String>,
    pub files: BTreeMap<String, Vec<Bump>>,
    pub lock_steps: Vec<LockStep>,
    pub manual_locks: Vec<String>,
}

pub fn on_path(program: &str) -> bool {
    std::env::var("PATH").ok().is_some_and(|p| crate::scaffold::tools::which_in(&p, program).is_some())
}

pub fn plan(repo: &str, items: &[UpdateItem], lockfiles: &[Lockfile]) -> Result<Plan, String> {
    let current_branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let target = default_branch(repo).unwrap_or_else(|| current_branch.clone());
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let branch = branch_name(&date, &taken_branches(repo));
    let mut files: BTreeMap<String, Vec<Bump>> = BTreeMap::new();
    for item in items {
        files.entry(item.manifest.clone()).or_default().push(item.bump.clone());
    }
    let (lock_steps, manual_locks) = lock_steps(items, lockfiles, Path::new(repo), on_path);
    Ok(Plan { branch, target, current_branch, dirty: dirty_files(repo)?, files, lock_steps, manual_locks })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockRun {
    pub command: String,
    pub dir: String,
    pub ok: bool,
    /// The last lines of its output.
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub branch: String,
    pub target: String,
    pub commit: String,
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
    pub lock_runs: Vec<LockRun>,
    pub manual_locks: Vec<String>,
    pub pr_title: String,
    pub pr_body: String,
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

async fn run_lock(repo: &Path, step: &LockStep) -> LockRun {
    let command = step.display();
    let Some(program) = std::env::var("PATH").ok().and_then(|p| crate::scaffold::tools::which_in(&p, &step.program)) else {
        return LockRun { command, dir: step.dir.clone(), ok: false, output: format!("{} is not installed", step.program) };
    };
    let mut cmd = crate::proc::command(program);
    cmd.args(&step.args)
        .current_dir(repo.join(&step.dir))
        .env("CI", "true")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(600), cmd.output()).await {
        Ok(Ok(out)) => {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            LockRun { command, dir: step.dir.clone(), ok: out.status.success(), output: tail(&text, 30) }
        }
        Ok(Err(e)) => LockRun { command, dir: step.dir.clone(), ok: false, output: e.to_string() },
        Err(_) => LockRun { command, dir: step.dir.clone(), ok: false, output: "timed out after 10 minutes".into() },
    }
}

/// Puts the repository back: this run's edits undone on its own branch, the user's branch checked
/// out again, the new branch deleted. The tree was clean when it started, so the only changes to
/// tracked files here are ours.
fn rollback(repo: &str, touched: &[String], back_to: &str, branch: &str) {
    if !touched.is_empty() {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend(touched.iter().map(String::as_str));
        let _ = crate::git::cli::run_in(repo, &args, &[]);
    }
    let _ = crate::git::cli::run_in(repo, &["checkout", back_to], &[]);
    let _ = crate::git::cli::run_in(repo, &["branch", "-D", branch], &[]);
}

/// Runs the confirmed update for one repository. `log` receives a line per step for the dialog.
pub async fn apply(app: tauri::AppHandle, repo: &str, items: &[UpdateItem], lockfiles: &[Lockfile], branch: &str, log: impl Fn(String)) -> Result<Outcome, String> {
    let dirty = dirty_files(repo)?;
    if !dirty.is_empty() {
        return Err(format!("dirty:{}", dirty.join(", ")));
    }
    let head = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let back_to = if head == "HEAD" { git(repo, &["rev-parse", "HEAD"])? } else { head.clone() };
    log("git fetch".into());
    let _ = crate::remote::fetch(app.clone(), repo.to_string(), None).await;
    let remote = crate::git::remotes::default_remote(repo).unwrap_or_else(|_| "origin".into());
    let target = default_branch(repo).unwrap_or_else(|| head.clone());
    let start = format!("{remote}/{target}");
    let start = if git(repo, &["rev-parse", "--verify", "--quiet", &start]).is_ok() { start } else { "HEAD".into() };
    log(format!("git checkout -b {branch} {start}"));
    git(repo, &["checkout", "-b", branch, &start])?;

    let mut touched: Vec<String> = Vec::new();
    let result = async {
        let mut by_file: BTreeMap<String, Vec<&UpdateItem>> = BTreeMap::new();
        for item in items {
            by_file.entry(item.manifest.clone()).or_default().push(item);
        }
        let (mut applied, mut skipped, mut done_items) = (Vec::new(), Vec::new(), Vec::new());
        for (manifest, group) in &by_file {
            let path: PathBuf = Path::new(repo).join(manifest);
            let kind = ManifestKind::of(manifest).ok_or_else(|| format!("{manifest}: not a manifest this can edit"))?;
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{manifest}: {e}"))?;
            let bumps: Vec<Bump> = group.iter().map(|i| i.bump.clone()).collect();
            let (new_text, ok) = bump::apply(kind, &text, &bumps);
            for (item, ok) in group.iter().zip(ok) {
                let label = format!("{} {} → {}", item.bump.name, item.bump.from, item.bump.to);
                if ok {
                    applied.push(label);
                    done_items.push((*item).clone());
                } else {
                    skipped.push(format!("{label} ({manifest})"));
                }
            }
            if new_text != text {
                std::fs::write(&path, new_text).map_err(|e| format!("{manifest}: {e}"))?;
                touched.push(manifest.clone());
                log(format!("edited {manifest}"));
            }
        }
        if done_items.is_empty() {
            return Err("nothing to update: every manifest changed since the analysis".to_string());
        }
        let (steps, mut manual) = lock_steps(&done_items, lockfiles, Path::new(repo), on_path);
        let mut lock_runs = Vec::new();
        let mut refreshed = Vec::new();
        for step in &steps {
            if !step.available {
                manual.push(step.lockfile.clone());
                continue;
            }
            log(format!("{}$ {}", if step.dir.is_empty() { String::new() } else { format!("{} ", step.dir) }, step.display()));
            let run = run_lock(Path::new(repo), step).await;
            log(run.output.clone());
            if run.ok {
                refreshed.push(run.command.clone());
            } else {
                manual.push(step.lockfile.clone());
            }
            lock_runs.push(run);
        }
        // Every lockfile the steps were about, whether or not it changed: `git add` of an unchanged
        // file is a no-op, and the tool may have written one next to it (`go.sum` beside `go.mod`).
        for step in &steps {
            if Path::new(repo).join(&step.lockfile).is_file() {
                touched.push(step.lockfile.clone());
            }
        }
        touched.sort();
        touched.dedup();
        let mut add = vec!["add", "--"];
        add.extend(touched.iter().map(String::as_str));
        git(repo, &add)?;
        let message = commit_message(&done_items, &refreshed, &manual);
        log("git commit".into());
        git(repo, &["commit", "-m", &message])?;
        let commit = git(repo, &["rev-parse", "--short", "HEAD"])?;
        let pr_title = message.lines().next().unwrap_or("chore(deps): update dependencies").to_string();
        let pr_body = pr_body(&done_items, &refreshed, &manual);
        Ok((applied, skipped, lock_runs, manual, commit, pr_title, pr_body))
    }
    .await;

    let (applied, skipped, lock_runs, manual_locks, commit, pr_title, pr_body) = match result {
        Ok(v) => v,
        Err(e) => {
            rollback(repo, &touched, &back_to, branch);
            return Err(e);
        }
    };
    log(format!("git push -u {remote} {branch}"));
    let pushed = crate::remote::push_branch(app, repo.to_string(), branch.to_string()).await;
    // Back where the user was, pushed or not: the commit is safe on its branch either way.
    let _ = crate::git::cli::run_in(repo, &["checkout", &back_to], &[]);
    pushed.map_err(|e| format!("pushfail:{e}"))?;
    Ok(Outcome { branch: branch.to_string(), target, commit, applied, skipped, lock_runs, manual_locks, pr_title, pr_body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(eco: Ecosystem, manifest: &str, name: &str, resolved: Option<&str>) -> UpdateItem {
        UpdateItem {
            manifest: manifest.into(),
            bump: Bump { ecosystem: eco, name: name.into(), key: name.into(), section: "dependencies".into(), from: "^1.0.0".into(), to: "^1.2.0".into(), property: None },
            resolved: resolved.map(str::to_string),
            to_version: "1.2.0".into(),
            fixes: vec![],
        }
    }

    fn lock(path: &str, kind: LockKind) -> Lockfile {
        Lockfile { path: path.into(), kind }
    }

    #[test]
    fn plans_one_refresh_per_lockfile_with_the_nearest_lock() {
        let locks = vec![
            lock("pnpm-lock.yaml", LockKind::PnpmLock),
            lock("Cargo.lock", LockKind::CargoLock),
            lock("svc/go.sum", LockKind::GoSum),
            lock("py/poetry.lock", LockKind::PoetryLock),
            lock("src/A/packages.lock.json", LockKind::NugetLock),
            lock("src/B/packages.lock.json", LockKind::NugetLock),
        ];
        let items = vec![
            item(Ecosystem::Npm, "apps/web/package.json", "react", None),
            item(Ecosystem::Npm, "package.json", "vite", None),
            item(Ecosystem::Cargo, "crates/a/Cargo.toml", "syn", Some("2.0.39")),
            item(Ecosystem::Cargo, "Cargo.toml", "serde", None),
            item(Ecosystem::Go, "svc/go.mod", "golang.org/x/net", None),
            item(Ecosystem::Pypi, "py/pyproject.toml", "httpx", None),
            item(Ecosystem::Nuget, "Directory.Packages.props", "Dapper", None),
        ];
        let (steps, manual) = lock_steps(&items, &locks, Path::new("/nonexistent"), |p| p != "go");
        let shown: Vec<_> = steps.iter().map(|s| (s.lockfile.as_str(), s.display(), s.available)).collect();
        assert_eq!(
            shown,
            vec![
                ("pnpm-lock.yaml", "pnpm install --lockfile-only --ignore-scripts".to_string(), true),
                ("Cargo.lock", "cargo update -p syn@2.0.39 -p serde".to_string(), true),
                ("svc/go.sum", "go mod tidy".to_string(), false),
                ("src/A/packages.lock.json", "dotnet restore --force-evaluate".to_string(), true),
                ("src/B/packages.lock.json", "dotnet restore --force-evaluate".to_string(), true),
            ]
        );
        assert_eq!(steps[3].dir, "src/A");
        assert_eq!(manual, vec!["py/poetry.lock"]);
    }

    #[test]
    fn names_the_branch_by_date_and_avoids_taken_names() {
        let mut taken = HashSet::new();
        assert_eq!(branch_name("2026-10-23", &taken), "deps/update-2026-10-23");
        taken.insert("deps/update-2026-10-23".to_string());
        taken.insert("deps/update-2026-10-23-2".to_string());
        assert_eq!(branch_name("2026-10-23", &taken), "deps/update-2026-10-23-3");
    }

    #[test]
    fn writes_a_commit_message_and_a_pr_body() {
        let mut one = item(Ecosystem::Npm, "package.json", "lodash", None);
        one.fixes = vec!["GHSA-35jh-r3h4-6jhm".into()];
        let msg = commit_message(&[one.clone()], &["pnpm install --lockfile-only".into()], &[]);
        assert!(msg.starts_with("chore(deps): update lodash to 1.2.0\n\n- lodash ^1.0.0 → ^1.2.0 (package.json)\n"));
        assert!(msg.contains("Lockfile refreshed with: pnpm install --lockfile-only"));
        let body = pr_body(&[one], &[], &["yarn.lock".into()]);
        assert!(body.contains("| `lodash` | `^1.0.0` | `^1.2.0` | `package.json` | GHSA-35jh-r3h4-6jhm |"));
        assert!(body.contains("**Lockfile not refreshed**"));
    }
}
