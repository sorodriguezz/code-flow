//! A whole Azure Storage account, as the file browser sees it.
//!
//! **The problem this solves.** An account is one name and one key with four services behind it,
//! and the older kinds made each service its own host row — four rows, four copies of the key, four
//! things to fix when it rotates. [`RemoteKind::Azure`](super::super::RemoteKind::Azure) is the
//! account itself. Queues and tables needed nothing for that: their commands read the account out
//! of [`AzureSpec`](super::super::AzureSpec) and never cared which kind the row was. Files did,
//! because the browser has one path per request and there are two filesystems under an account.
//!
//! **Every Azure kind comes through here**, the four legacy ones included: their credential is the
//! account's too, and the kind they were saved as decides only which page the panel opens on.
//!
//! **So the service is the first path segment.** `/blob/photos/cat.jpg` is a blob, `/files/share/
//! report.xlsx` is on a file share, and `/` lists the two as folders — which means the existing
//! browser, breadcrumb and transfer planner reach both without learning a new concept. Everything
//! here is that translation and nothing else: strip the segment on the way in, put it back on every
//! path on the way out, and hand the middle to [`super::blob`] or [`super::share`] unchanged.
//!
//! The two services really are different filesystems, which is why crossing them is refused rather
//! than emulated: [`rename`] between `/blob/…` and `/files/…` would have to download and re-upload,
//! and a "rename" that moves bytes across the internet is not the operation the user asked for.
//! Dragging between the panes still works — that is a transfer, and it says so.

use super::super::files::{RemoteFile, RemoteListing};
use super::super::RemoteHostSpec;

/// The path segment that means blob storage.
pub const BLOB: &str = "blob";
/// The path segment that means file shares.
pub const FILES: &str = "files";

/// Which of the two file services a path is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leg {
    Blob,
    Files,
}

impl Leg {
    fn segment(self) -> &'static str {
        match self {
            Self::Blob => BLOB,
            Self::Files => FILES,
        }
    }

    fn of(segment: &str) -> Option<Self> {
        match segment {
            BLOB => Some(Self::Blob),
            FILES => Some(Self::Files),
            _ => None,
        }
    }
}

/// Whether a path is the account root — the one listing that has no service yet.
fn is_root(path: &str) -> bool {
    matches!(path.trim().trim_matches('/'), "")
}

/// Splits `/blob/photos/cat.jpg` into the service and `/photos/cat.jpg`.
fn split(path: &str) -> Result<(Leg, String), String> {
    let trimmed = path.trim().trim_start_matches('/');
    let (head, rest) = trimmed.split_once('/').unwrap_or((trimmed, ""));
    let leg = Leg::of(head).ok_or_else(|| {
        format!(
            "\"{path}\" doesn't name a service. An Azure account's files live under /{BLOB} \
             (containers) or /{FILES} (shares)."
        )
    })?;
    Ok((leg, format!("/{rest}")))
}

/// Puts the service back on a path the transport answered with.
fn rejoin(leg: Leg, path: &str) -> String {
    let inner = path.trim().trim_start_matches('/').trim_end_matches('/');
    if inner.is_empty() {
        format!("/{}", leg.segment())
    } else {
        format!("/{}/{inner}", leg.segment())
    }
}

/// The account root: the two file services, drawn as folders.
///
/// Folders because that is what they behave like from here — you open one and there are containers
/// inside — and because it means the browser needs no second kind of row. Queues and tables are
/// deliberately absent: neither is a file, and a folder that opened into something the file browser
/// cannot draw would be worse than not being there. They have their own panels.
fn root() -> RemoteListing {
    let folder = |name: &str| RemoteFile {
        name: name.to_string(),
        path: format!("/{name}"),
        is_dir: true,
        is_link: false,
        size: 0,
        // No timestamp: a service is not an object, and inventing one would put a date in a column
        // nothing here can justify.
        modified: 0,
        permissions: String::new(),
    };
    RemoteListing { path: "/".to_string(), entries: vec![folder(BLOB), folder(FILES)] }
}

pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<RemoteListing, String> {
    if is_root(path) {
        return Ok(root());
    }
    let (leg, inner) = split(path)?;
    let mut listing = match leg {
        Leg::Blob => super::blob::list(host_id, spec, &inner).await?,
        Leg::Files => super::share::list(host_id, spec, &inner).await?,
    };
    listing.path = rejoin(leg, &listing.path);
    for entry in &mut listing.entries {
        entry.path = rejoin(leg, &entry.path);
    }
    Ok(listing)
}

pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let (leg, inner) = split(remote_path)?;
    match leg {
        Leg::Blob => super::blob::download(app, id, host_id, spec, &inner, local_path).await,
        Leg::Files => super::share::download(app, id, host_id, spec, &inner, local_path).await,
    }
}

pub async fn upload(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let (leg, inner) = split(remote_path)?;
    match leg {
        Leg::Blob => super::blob::upload(app, id, host_id, spec, local_path, &inner).await,
        Leg::Files => super::share::upload(app, id, host_id, spec, local_path, &inner).await,
    }
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let (leg, inner) = split(path)?;
    match leg {
        Leg::Blob => super::blob::make_dir(host_id, spec, &inner).await,
        Leg::Files => super::share::make_dir(host_id, spec, &inner).await,
    }
}

pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let (leg, inner) = split(path)?;
    match leg {
        Leg::Blob => super::blob::remove(host_id, spec, &inner, is_dir).await,
        Leg::Files => super::share::remove(host_id, spec, &inner, is_dir).await,
    }
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let (from_leg, from_inner) = split(from)?;
    let (to_leg, to_inner) = split(to)?;
    // See the module comment: a cross-service move is a transfer, and calling it a rename would
    // hide that every byte comes through this machine.
    if from_leg != to_leg {
        return Err(
            "Blob storage and file shares are different services — copy between them with the \
             transfer arrows instead of renaming."
                .to_string(),
        );
    }
    match from_leg {
        Leg::Blob => super::blob::rename(host_id, spec, &from_inner, &to_inner).await,
        Leg::Files => super::share::rename(host_id, spec, &from_inner, &to_inner).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_segment_is_the_service_and_the_rest_is_the_path() {
        assert_eq!(split("/blob/photos/cat.jpg").unwrap(), (Leg::Blob, "/photos/cat.jpg".into()));
        assert_eq!(split("/files/share").unwrap(), (Leg::Files, "/share".into()));
        // A service with nothing after it is that service's root — the container or share list.
        assert_eq!(split("/blob").unwrap(), (Leg::Blob, "/".into()));
        assert_eq!(split("blob/").unwrap(), (Leg::Blob, "/".into()));
    }

    #[test]
    fn a_path_that_names_no_service_says_which_two_exist() {
        let message = split("/queues/orders").unwrap_err();
        assert!(message.contains("/blob"), "{message}");
        assert!(message.contains("/files"), "{message}");
    }

    #[test]
    fn a_path_survives_the_round_trip_it_takes_through_a_transport() {
        for path in ["/blob", "/blob/photos", "/blob/photos/2024/cat.jpg", "/files/share/report.xlsx"] {
            let (leg, inner) = split(path).unwrap();
            assert_eq!(rejoin(leg, &inner), path);
        }
    }

    #[test]
    fn the_account_root_is_the_two_file_services() {
        let listing = root();
        assert_eq!(listing.path, "/");
        let names: Vec<&str> = listing.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, [BLOB, FILES]);
        assert!(listing.entries.iter().all(|entry| entry.is_dir));
        assert!(is_root("/") && is_root("") && !is_root("/blob"));
    }
}
