//! Commits carried between machines as `git bundle`s, through the session's blobs.
//!
//! A shared «Equipo» run lives on its owner's machine. A seat taken by someone else runs on theirs,
//! so two things must cross:
//!
//! - **To the guest**, where the task starts: the integration branch as the owner's agents left it,
//!   or the branch under review. Usually that is ahead of anything pushed.
//! - **Back to the owner**, the guest agent's commit on top of it.
//!
//! A bundle carries exactly the commits the other side lacks. That needs a commit both sides already
//! have (the *basis*), which is the run's target branch as the shared remote has it. The guest never
//! needs push rights to the remote, and nothing is pushed anywhere until the owner lands the run.
//!
//! An empty range (the start *is* the basis) needs no bundle at all: [`Pack::Nothing`].

use std::path::{Path, PathBuf};

use crate::git::cli;

fn git(cwd: &str, args: &[&str]) -> Result<cli::Output, String> {
    cli::run_in(cwd, args, &[])
}

fn git_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if out.success {
        Ok(out.stdout.trim().to_string())
    } else {
        Err(format!("git {}: {}", args.first().copied().unwrap_or(""), out.detail()))
    }
}

fn scratch(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("cf-bundle-{}-{name}", uuid::Uuid::new_v4()))
}

/// What travels for one commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pack {
    /// The commit is the basis itself: the other side has it.
    Nothing,
    /// The bundle's bytes, holding `tip` and what it needs beyond the basis.
    Bundle(Vec<u8>),
}

/// The newest commit of `tip`'s history that the shared remote has on `target`, fetched first so it
/// is current. What both machines can be expected to hold.
pub fn basis(repo: &str, tip: &str, target: &str) -> Result<String, String> {
    let remote = crate::git::remotes::default_remote(repo).unwrap_or_else(|_| "origin".to_string());
    let _ = git(repo, &["fetch", "--quiet", &remote, target]);
    let tracking = format!("refs/remotes/{remote}/{target}");
    if git(repo, &["rev-parse", "--verify", "--quiet", &tracking]).map(|o| o.success).unwrap_or(false) {
        return git_ok(repo, &["merge-base", tip, &tracking])
            .map_err(|_| format!("la rama {target} del remoto no comparte historia con la corrida"));
    }
    Err(format!("la rama {target} no está en el remoto {remote}: súbela antes de compartir la corrida"))
}

/// Packs `tip` for a machine that has `basis`.
pub fn create(repo: &str, tip: &str, basis: &str) -> Result<Pack, String> {
    let tip = git_ok(repo, &["rev-parse", "--verify", &format!("{tip}^{{commit}}")])?;
    let basis = git_ok(repo, &["rev-parse", "--verify", &format!("{basis}^{{commit}}")])?;
    if tip == basis {
        return Ok(Pack::Nothing);
    }
    // A bundle is made of refs: a temporary one names the tip, and goes again right after.
    let name = format!("refs/codeflow/bundle/{}", uuid::Uuid::new_v4());
    git_ok(repo, &["update-ref", &name, &tip])?;
    let file = scratch("out.bundle");
    let file_str = file.to_string_lossy().to_string();
    let made = git_ok(repo, &["bundle", "create", &file_str, &name, &format!("^{basis}")]);
    let _ = git(repo, &["update-ref", "-d", &name]);
    made?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&file);
    Ok(Pack::Bundle(bytes?))
}

/// Takes a bundle into `repo` and returns the commit it carries, kept reachable under
/// `refs/codeflow/incoming/<name>` until [`forget`] lets it go. Refuses a bundle whose tip is not
/// `expected` (when given): what was recorded and what arrived must be the same commit.
pub fn receive(repo: &str, bytes: &[u8], name: &str, expected: Option<&str>) -> Result<String, String> {
    let file = scratch("in.bundle");
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let file_str = file.to_string_lossy().to_string();
    let result = (|| {
        git_ok(repo, &["bundle", "verify", "--quiet", &file_str]).map_err(|e| {
            if e.contains("prerequisite") || e.contains("lacks") {
                "falta la base común en este clon: haz fetch de la rama destino y reintenta".to_string()
            } else {
                e
            }
        })?;
        let heads = git_ok(repo, &["bundle", "list-heads", &file_str])?;
        let (sha, head) = heads
            .lines()
            .filter_map(|l| l.split_once(' '))
            .next()
            .ok_or("el paquete no trae ningún commit")?;
        if expected.is_some_and(|e| !e.is_empty() && e != sha) {
            return Err("el paquete no trae el commit anunciado".to_string());
        }
        let local = incoming_ref(name);
        git_ok(repo, &["fetch", "--quiet", &file_str, &format!("+{head}:{local}")])?;
        Ok(sha.to_string())
    })();
    let _ = std::fs::remove_file(&file);
    result
}

fn incoming_ref(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    format!("refs/codeflow/incoming/{clean}")
}

/// Drops the ref [`receive`] kept. The commits stay wherever a branch holds them.
pub fn forget(repo: &str, name: &str) {
    let _ = git(repo, &["update-ref", "-d", &incoming_ref(name)]);
}

/// Moves a worktree's branch forward onto `sha`, which must descend from what it has: the guest's
/// commit on top of the start it was handed. Anything else is refused rather than overwritten.
pub fn fast_forward(worktree: &str, sha: &str) -> Result<(), String> {
    let head = git_ok(worktree, &["rev-parse", "HEAD"])?;
    if head == sha {
        return Ok(());
    }
    if !git(worktree, &["merge-base", "--is-ancestor", &head, sha]).map(|o| o.success).unwrap_or(false) {
        return Err("el commit recibido no parte de donde empezó la tarea".into());
    }
    git_ok(worktree, &["merge", "--ff-only", "--quiet", sha]).map(|_| ())
}

/// Whether `path` exists as a directory with a git checkout in it.
pub fn is_checkout(path: &str) -> bool {
    Path::new(path).join(".git").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn commit(dir: &Path, file: &str, text: &str, message: &str) -> String {
        fs::write(dir.join(file), text).unwrap();
        let d = dir.to_string_lossy().to_string();
        git_ok(&d, &["add", "-A"]).unwrap();
        git_ok(&d, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", message]).unwrap();
        git_ok(&d, &["rev-parse", "HEAD"]).unwrap()
    }

    /// A bare "remote", the owner's clone and the guest's clone, all at one commit on `main`.
    fn three() -> (PathBuf, PathBuf, PathBuf, String) {
        let root = std::env::temp_dir().join(format!("cf-bundle-test-{}", uuid::Uuid::new_v4()));
        let (remote, owner, guest) = (root.join("remote.git"), root.join("owner"), root.join("guest"));
        fs::create_dir_all(&owner).unwrap();
        let o = owner.to_string_lossy().to_string();
        git_ok(&o, &["init", "-q", "-b", "main"]).unwrap();
        git_ok(&o, &["config", "core.autocrlf", "false"]).unwrap();
        let base = commit(&owner, "a.txt", "one\n", "base");
        git_ok(root.to_str().unwrap(), &["clone", "-q", "--bare", &o, remote.to_str().unwrap()]).unwrap();
        git_ok(&o, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        git_ok(&o, &["fetch", "-q", "origin"]).unwrap();
        git_ok(root.to_str().unwrap(), &["clone", "-q", "-c", "core.autocrlf=false", remote.to_str().unwrap(), guest.to_str().unwrap()]).unwrap();
        (owner, guest, remote, base)
    }

    #[test]
    fn a_commit_travels_there_and_its_follow_up_comes_back() {
        let (owner, guest, _remote, base) = three();
        let (o, g) = (owner.to_string_lossy().to_string(), guest.to_string_lossy().to_string());

        // The owner's agents moved the integration branch on, unpushed.
        let start = commit(&owner, "a.txt", "one\ntwo\n", "owner's agent");
        let shared = basis(&o, &start, "main").unwrap();
        assert_eq!(shared, base);
        let Pack::Bundle(out) = create(&o, &start, &shared).unwrap() else { panic!("expected a bundle") };

        // The guest takes it, works on top and sends back only its own commit.
        let got = receive(&g, &out, "item-1", Some(&start)).unwrap();
        assert_eq!(got, start);
        git_ok(&g, &["checkout", "-q", "-b", "work", &got]).unwrap();
        let theirs = commit(&guest, "b.txt", "guest\n", "guest's agent");
        let Pack::Bundle(back) = create(&g, &theirs, &start).unwrap() else { panic!("expected a bundle") };

        // The owner fast-forwards the task's branch onto it.
        let landed = receive(&o, &back, "item-1-result", Some(&theirs)).unwrap();
        fast_forward(&o, &landed).unwrap();
        assert_eq!(fs::read_to_string(owner.join("b.txt")).unwrap(), "guest\n");
        forget(&o, "item-1-result");
        forget(&g, "item-1");
    }

    #[test]
    fn nothing_to_send_when_the_start_is_the_basis() {
        let (owner, _guest, _remote, base) = three();
        assert_eq!(create(owner.to_str().unwrap(), &base, &base).unwrap(), Pack::Nothing);
    }

    #[test]
    fn a_bundle_with_another_commit_than_announced_is_refused() {
        let (owner, guest, _remote, base) = three();
        let start = commit(&owner, "a.txt", "x\n", "x");
        let Pack::Bundle(out) = create(owner.to_str().unwrap(), &start, &base).unwrap() else { panic!() };
        let err = receive(guest.to_str().unwrap(), &out, "i", Some(&base)).unwrap_err();
        assert!(err.contains("no trae el commit anunciado"), "{err}");
    }

    #[test]
    fn a_result_that_does_not_build_on_the_start_is_not_applied() {
        let (owner, _guest, _remote, base) = three();
        let o = owner.to_string_lossy().to_string();
        let ahead = commit(&owner, "a.txt", "mine\n", "mine");
        git_ok(&o, &["checkout", "-q", "-b", "other", &base]).unwrap();
        let elsewhere = commit(&owner, "c.txt", "c\n", "elsewhere");
        git_ok(&o, &["checkout", "-q", &ahead]).unwrap();
        assert!(fast_forward(&o, &elsewhere).is_err());
    }

    #[test]
    fn an_unpushed_target_is_named() {
        let (owner, _guest, _remote, base) = three();
        let err = basis(owner.to_str().unwrap(), &base, "develop").unwrap_err();
        assert!(err.contains("develop"), "{err}");
    }
}
