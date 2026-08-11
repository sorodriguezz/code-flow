//! Azure File shares, as the file browser's seven verbs.
//!
//! **The one service in this module that is a filesystem.** Blob and S3 fake directories out of key
//! prefixes; a File share has real ones, created and deleted in their own right, and a real
//! `rename`. So most of what [`super`] says about object storage does *not* apply here, and this
//! transport is closer to [`super::super::ftp`] than to its Azure neighbour:
//!
//! - Listing a directory is `?restype=directory&comp=list`, and it returns `<Directory>` and
//!   `<File>` entries — no delimiter, no synthesised folders, no marker objects.
//! - Creating a directory is `PUT ?restype=directory`. It persists while empty, because it exists.
//! - Renaming is `PUT ?comp=rename`, server-side and atomic. Not copy-then-delete.
//!
//! **Writing is the awkward part**, and it is the service's shape rather than a choice here: a file
//! is *created at its final size* and then filled in by ranged writes, each capped at four
//! mebibytes. So an upload is one create plus ⌈size/4MiB⌉ writes, and progress is reported per
//! landed range ([`super::super::files::report`]) rather than per chunk read.

use tokio::io::AsyncReadExt as _;

use super::super::files::{
    plan_upload, pump, report, sort_entries, ListPage, Planned, RemoteFile, RemoteListing, PAGE,
};
use super::super::RemoteHostSpec;
use super::azure::{self, Credential, Service};
use super::{child_path, container_row, rfc1123_seconds, Location};
use futures_util::StreamExt as _;

/// The most one ranged write may carry. The service's own limit, not a tuning knob.
const MAX_RANGE: u64 = 4 * 1024 * 1024;

/// Nothing is held open — see [`super::s3::close`].
pub async fn close(_host_id: &str) {}

// ---------------------------------------------------------------------------
// The seven verbs
// ---------------------------------------------------------------------------

pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    page: &ListPage,
) -> Result<RemoteListing, String> {
    let at = Location::parse(path);
    let credential = azure::credential(host_id, spec).await?;

    let (mut entries, next) = if at.is_account_root() {
        shares(spec, &credential, page).await?
    } else {
        entries_of(spec, &credential, &at, page).await?
    };
    sort_entries(&mut entries);
    Ok(RemoteListing { path: at.path(), entries, next })
}

pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let files = plan_download(spec, &credential, remote_path, local_path).await?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        if let Some(parent) = std::path::Path::new(&file.local).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let url = file_url(spec, &Location::parse(&file.remote))?;
        let response = azure::send(spec, &credential, "GET", &url, &[], None).await?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("read {}", file.remote), response).await);
        }
        let stream = response.bytes_stream().map(|chunk| chunk.map_err(std::io::Error::other));
        let mut source = tokio_util::io::StreamReader::new(stream);
        let mut target = tokio::fs::File::create(&file.local)
            .await
            .map_err(|e| format!("Couldn't write {}: {e}", file.local))?;
        pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
            .await?;
        use tokio::io::AsyncWriteExt as _;
        target.flush().await.map_err(|e| format!("Couldn't finish {}: {e}", file.local))?;
    }
    Ok(())
}

pub async fn upload(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let files = plan_upload(local_path, remote_path)?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        let at = Location::parse(&file.remote);
        if at.container.is_empty() {
            return Err("Pick a share to upload into — the account root only holds shares.".into());
        }
        // Real directories, so the parents have to exist before the file does — the same order FTP
        // needs, and unlike Blob where a slash in a key creates nothing.
        ensure_parents(spec, &credential, &at).await?;

        // One create at the final size, then the bytes. A file that exists at full length with
        // nothing written yet reads as a sparse file of zeros, which is why a failed upload leaves
        // something visibly wrong rather than something subtly short.
        let url = file_url(spec, &at)?;
        let created = azure::send(
            spec,
            &credential,
            "PUT",
            &url,
            &[
                ("x-ms-type".to_string(), "file".to_string()),
                ("x-ms-content-length".to_string(), file.size.to_string()),
            ],
            None,
        )
        .await?;
        if !created.status().is_success() {
            return Err(super::explain(&format!("create {}", file.remote), created).await);
        }

        let mut handle = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;
        let mut offset = 0u64;
        while offset < file.size {
            let take = MAX_RANGE.min(file.size - offset) as usize;
            let mut chunk = vec![0u8; take];
            handle
                .read_exact(&mut chunk)
                .await
                .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;

            let mut ranged = url.clone();
            ranged.query_pairs_mut().append_pair("comp", "range");
            let headers = vec![
                ("x-ms-write".to_string(), "update".to_string()),
                (
                    "x-ms-range".to_string(),
                    format!("bytes={offset}-{}", offset + take as u64 - 1),
                ),
            ];
            let response = azure::send(
                spec,
                &credential,
                "PUT",
                &ranged,
                &headers,
                Some((reqwest::Body::from(chunk), take as u64)),
            )
            .await?;
            if !response.status().is_success() {
                return Err(super::explain(&format!("write {}", file.remote), response).await);
            }

            offset += take as u64;
            done += take as u64;
            report(app, id, &file.name, done, total, index as u64, files.len() as u64);
        }
        // A zero-byte file has no range to write, so nothing above reported it finishing.
        if file.size == 0 {
            report(app, id, &file.name, done, total, index as u64 + 1, files.len() as u64);
        }
    }
    Ok(())
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let at = Location::parse(path);
    let credential = azure::credential(host_id, spec).await?;

    // A share and a directory are both created with a PUT and differ only in `restype`, which is
    // the service being consistent rather than this code being clever.
    let (url, what) = if at.key.is_empty() {
        if at.container.is_empty() {
            return Err("A share needs a name.".into());
        }
        (share_url(spec, &at.container, "share")?, at.container.clone())
    } else {
        (directory_url(spec, &at)?, super::leaf(&at.key))
    };

    let response = azure::send(spec, &credential, "PUT", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("create {what}"), response).await)
    }
}

pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let at = Location::parse(path);
    if at.key.is_empty() {
        // See `blob::remove` — the ordinary delete never takes a whole top-level resource, and the
        // verb that does asks for the name first.
        return Err(
            "That's a share, not a file. Deleting one takes everything inside it, so it goes \
             through its own confirmation — the browser asks you to type the name."
                .into(),
        );
    }
    let credential = azure::credential(host_id, spec).await?;

    // The service refuses a non-empty directory itself, which is exactly the rule this browser
    // wants — so unlike Blob there is no count to do here first.
    let url = if is_dir { directory_url(spec, &at)? } else { file_url(spec, &at)? };
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("remove {path}"), response).await)
    }
}

/// A real rename, server-side and atomic — the only transport here that has one.
pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let source = Location::parse(from);
    let target = Location::parse(to);
    if source.key.is_empty() || target.key.is_empty() {
        return Err("A share can't be renamed — Azure has no such operation.".into());
    }
    if source.container != target.container {
        return Err("A rename can't move something between shares.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = file_url(spec, &target)?;
    url.query_pairs_mut().append_pair("comp", "rename");
    let response = azure::send(
        spec,
        &credential,
        "PUT",
        &url,
        &[(
            "x-ms-file-rename-source".to_string(),
            file_url(spec, &source)?.to_string(),
        )],
        None,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("rename {from}"), response).await)
    }
}

// ---------------------------------------------------------------------------
// URLs and listing
// ---------------------------------------------------------------------------

/// `https://account.file.core.windows.net/{share}?restype={what}`.
fn share_url(spec: &RemoteHostSpec, share: &str, restype: &str) -> Result<url::Url, String> {
    let mut url = azure::endpoint(spec, Service::File)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the share URL".to_string())?
        .pop_if_empty()
        .push(share);
    url.query_pairs_mut().append_pair("restype", restype);
    Ok(url)
}

/// The URL of a file — no `restype`, which is what distinguishes it from a directory.
fn file_url(spec: &RemoteHostSpec, at: &Location) -> Result<url::Url, String> {
    let mut url = azure::endpoint(spec, Service::File)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Couldn't build the file URL".to_string())?;
        segments.pop_if_empty();
        if !at.container.is_empty() {
            segments.push(&at.container);
        }
        for part in at.key.split('/').filter(|part| !part.is_empty()) {
            segments.push(part);
        }
    }
    Ok(url)
}

fn directory_url(spec: &RemoteHostSpec, at: &Location) -> Result<url::Url, String> {
    let mut url = file_url(spec, at)?;
    url.query_pairs_mut().append_pair("restype", "directory");
    Ok(url)
}

/// Creates every directory above `at` that isn't there yet.
///
/// Top down, because the service creates one level at a time and a `PUT` two levels deep fails
/// rather than creating the gap. An existing directory answers 409, which is a success here — an
/// upload resumed by re-running it must not fail on its own leftovers.
async fn ensure_parents(
    spec: &RemoteHostSpec,
    credential: &Credential,
    at: &Location,
) -> Result<(), String> {
    let parts: Vec<&str> = at.key.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let mut so_far = String::new();
    for part in &parts[..parts.len() - 1] {
        if !so_far.is_empty() {
            so_far.push('/');
        }
        so_far.push_str(part);
        let url = directory_url(
            spec,
            &Location { container: at.container.clone(), key: so_far.clone() },
        )?;
        let response = azure::send(spec, credential, "PUT", &url, &[], None).await?;
        if !response.status().is_success() && response.status() != reqwest::StatusCode::CONFLICT {
            return Err(super::explain(&format!("create {so_far}"), response).await);
        }
    }
    Ok(())
}

async fn shares(
    spec: &RemoteHostSpec,
    credential: &Credential,
    page: &ListPage,
) -> Result<(Vec<RemoteFile>, String), String> {
    let mut url = azure::endpoint(spec, Service::File)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("comp", "list");
        query.append_pair("maxresults", &PAGE.to_string());
        let prefix = page.prefix.trim();
        if !prefix.is_empty() {
            query.append_pair("prefix", prefix);
        }
        if !page.marker.is_empty() {
            query.append_pair("marker", &page.marker);
        }
    }
    let response = azure::send(spec, credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain("list shares", response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the share list: {e}"))?;

    let mut rows = Vec::new();
    for share in elements(&body, "Share") {
        let Some(name) = super::xml_text(&share, "Name") else { continue };
        let modified = super::xml_text(&share, "Last-Modified").unwrap_or_default();
        rows.push(container_row(&name, rfc1123_seconds(&modified)));
    }
    Ok((rows, super::xml_text(&body, "NextMarker").unwrap_or_default()))
}

/// One directory's contents. Real entries, so no prefix arithmetic.
async fn entries_of(
    spec: &RemoteHostSpec,
    credential: &Credential,
    at: &Location,
    page: &ListPage,
) -> Result<(Vec<RemoteFile>, String), String> {
    let mut rows = Vec::new();
    {
        let mut url = directory_url(spec, at)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("comp", "list");
            query.append_pair("maxresults", &PAGE.to_string());
            // A share is a real directory, so the prefix is a name filter within it rather than a
            // key prefix — which is exactly what the service's own `prefix` does here.
            let prefix = page.prefix.trim();
            if !prefix.is_empty() {
                query.append_pair("prefix", prefix);
            }
            if !page.marker.is_empty() {
                query.append_pair("marker", &page.marker);
            }
        }
        let response = azure::send(spec, credential, "GET", &url, &[], None).await?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("list {}", at.path()), response).await);
        }
        let body = response.text().await.map_err(|e| format!("Couldn't read the listing: {e}"))?;

        for directory in elements(&body, "Directory") {
            let Some(name) = super::xml_text(&directory, "Name") else { continue };
            rows.push(RemoteFile {
                path: child_path(at, &name),
                name,
                is_dir: true,
                is_link: false,
                size: 0,
                modified: super::xml_text(&directory, "Last-Modified")
                    .map(|value| rfc1123_seconds(&value))
                    .unwrap_or(0),
                permissions: String::new(),
                ..Default::default()
            });
        }
        for file in elements(&body, "File") {
            let Some(name) = super::xml_text(&file, "Name") else { continue };
            rows.push(RemoteFile {
                path: child_path(at, &name),
                name,
                is_dir: false,
                is_link: false,
                size: super::xml_text(&file, "Content-Length")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                modified: super::xml_text(&file, "Last-Modified")
                    .map(|value| rfc1123_seconds(&value))
                    .unwrap_or(0),
                permissions: String::new(),
                // A share is a real filesystem: `Content-Type` is not in its listing, and asking
                // per file would be one round trip per row.
                content_type: String::new(),
                ..Default::default()
            });
        }
        Ok((rows, super::xml_text(&body, "NextMarker").unwrap_or_default()))
    }
}

/// Everything under `remote_path`, flattened.
///
/// Recursive by walking, unlike Blob's one undelimited listing: real directories mean there is no
/// flat keyspace to ask for, so this is a breadth-first walk of the tree — one request per
/// directory, which is what having real directories costs.
async fn plan_download(
    spec: &RemoteHostSpec,
    credential: &Credential,
    remote_path: &str,
    local_path: &str,
) -> Result<Vec<Planned>, String> {
    let at = Location::parse(remote_path);
    if at.container.is_empty() {
        return Err("Pick a share — the account root has nothing to download.".into());
    }

    let url = file_url(spec, &at)?;
    let head = azure::send(spec, credential, "HEAD", &url, &[], None).await?;
    if head.status().is_success() {
        let size = head
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        return Ok(vec![Planned {
            remote: remote_path.to_string(),
            local: local_path.to_string(),
            name: super::leaf(&at.key),
            size,
        }]);
    }

    let mut planned = Vec::new();
    let mut queue = vec![(at.clone(), std::path::PathBuf::from(local_path))];
    while let Some((directory, into)) = queue.pop() {
        // Every page, not one: a download of a directory is a statement about all of it, which is
        // the opposite of what the browser wants and the reason paging is a parameter rather than a
        // policy baked into the listing.
        let mut walked = Vec::new();
        let mut marker = String::new();
        loop {
            let page = ListPage { prefix: String::new(), marker: marker.clone() };
            let (rows, next) = entries_of(spec, credential, &directory, &page).await?;
            walked.extend(rows);
            if next.is_empty() {
                break;
            }
            marker = next;
        }
        for entry in walked {
            let child = Location::parse(&entry.path);
            let local = into.join(&entry.name);
            if entry.is_dir {
                queue.push((child, local));
            } else {
                planned.push(Planned {
                    remote: entry.path.clone(),
                    local: local.to_string_lossy().to_string(),
                    name: entry.name.clone(),
                    size: entry.size,
                });
            }
        }
    }

    if planned.is_empty() {
        return Err(format!("There is nothing at {remote_path} to download."));
    }
    Ok(planned)
}

/// Every `<name>…</name>` block. See [`super::s3`] for why this is a scan.
fn elements(document: &str, name: &str) -> Vec<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = document;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        found.push(after[..end].to_string());
        rest = &after[end + close.len()..];
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::RemoteKind;

    const LISTING: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults>
  <Entries>
    <Directory><Name>logs</Name></Directory>
    <File>
      <Name>report.pdf</Name>
      <Properties>
        <Content-Length>2048</Content-Length>
        <Last-Modified>Mon, 04 Mar 2024 10:11:12 GMT</Last-Modified>
      </Properties>
    </File>
  </Entries>
  <NextMarker />
</EnumerationResults>"#;

    fn spec() -> RemoteHostSpec {
        let mut s = RemoteHostSpec { kind: RemoteKind::AzureFiles, ..Default::default() };
        s.azure.account = "contoso".into();
        s
    }

    /// Real entries, so a directory is a `<Directory>` rather than a prefix inferred from a key.
    #[test]
    fn a_listing_has_real_directories_and_files() {
        let dirs: Vec<_> = elements(LISTING, "Directory")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Name"))
            .collect();
        let files: Vec<_> = elements(LISTING, "File")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Name"))
            .collect();
        assert_eq!(dirs, vec!["logs"]);
        assert_eq!(files, vec!["report.pdf"]);
        assert_eq!(
            super::super::xml_text(&elements(LISTING, "File")[0], "Content-Length").unwrap(),
            "2048"
        );
    }

    /// A file and a directory at the same path differ only by `restype`, and getting that wrong is
    /// a delete that hits the wrong thing.
    #[test]
    fn a_directory_url_is_a_file_url_plus_restype() {
        let at = Location::parse("/share/logs/app");
        assert_eq!(
            file_url(&spec(), &at).unwrap().as_str(),
            "https://contoso.file.core.windows.net/share/logs/app"
        );
        assert_eq!(
            directory_url(&spec(), &at).unwrap().as_str(),
            "https://contoso.file.core.windows.net/share/logs/app?restype=directory"
        );
    }

    #[test]
    fn a_share_is_addressed_at_the_root_of_the_account() {
        assert_eq!(
            share_url(&spec(), "backups", "share").unwrap().as_str(),
            "https://contoso.file.core.windows.net/backups?restype=share"
        );
    }

    /// The write cap is the service's, so a 10 MiB file is three ranges and the last one is short.
    #[test]
    fn a_file_is_written_in_ranges_of_at_most_four_mebibytes() {
        let size = 10 * 1024 * 1024u64;
        let mut offset = 0u64;
        let mut ranges = Vec::new();
        while offset < size {
            let take = MAX_RANGE.min(size - offset);
            ranges.push(format!("bytes={offset}-{}", offset + take - 1));
            offset += take;
        }
        assert_eq!(
            ranges,
            vec![
                "bytes=0-4194303".to_string(),
                "bytes=4194304-8388607".to_string(),
                "bytes=8388608-10485759".to_string(),
            ]
        );
    }
}

/// Deletes a share and everything in it. Separate from [`remove`] for the reason
/// [`super::blob::remove_container`] is: the blast radius, not the API.
pub async fn remove_share(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        return Err("Which share?".into());
    }
    if !at.key.is_empty() {
        return Err("That is a file inside a share, not the share itself.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let url = share_url(spec, &at.container, "share")?;
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("delete the share {}", at.container), response).await)
    }
}
