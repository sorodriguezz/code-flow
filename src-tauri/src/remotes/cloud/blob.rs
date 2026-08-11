//! Azure Blob storage, as the file browser's seven verbs.
//!
//! The same shape as [`super::s3`] — stateless, one signed HTTPS request per operation, folders
//! synthesised from delimited listings — with Azure's spellings. Where they differ is worth naming:
//!
//! - The delimited listing is `?restype=container&comp=list&delimiter=/`, and the folders come back
//!   as `<BlobPrefix>` rather than `<CommonPrefixes>`.
//! - There is a real **copy** verb (`x-ms-copy-source`), and for a blob within the same account it
//!   completes synchronously, so rename is still copy-then-delete but the copy is one round trip.
//! - Listings are paged by an opaque `NextMarker` rather than a continuation token.
//! - `PUT` of a block blob needs `x-ms-blob-type: BlockBlob`, which is the header everyone forgets.

use tokio::io::AsyncWriteExt as _;

use super::super::files::{
    plan_upload, pump, sort_entries, ListPage, Planned, RemoteFile, RemoteListing, PAGE,
};
use super::super::RemoteHostSpec;
use super::azure::{self, Credential, Service};
use super::{container_row, folder_row, is_own_marker, object_row, rfc1123_seconds, Location};
use futures_util::StreamExt as _;

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
        containers(spec, &credential, page).await?
    } else {
        blobs(spec, &credential, &at, page).await?
    };
    // Within the page only. Sorting across pages would need the whole container, which is the thing
    // this no longer does — the service returns names in lexical order and that is the order shown.
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
        let at = Location::parse(&file.remote);
        let url = blob_url(spec, &at)?;
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
            return Err("Pick a container to upload into — the account root only holds containers.".into());
        }
        let url = blob_url(spec, &at)?;
        let handle = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;

        // Same pipe as S3's upload, and for the same reason: the bytes have to pass somewhere the
        // shared progress bar can count them. See `s3::upload`.
        let (reader, writer) = tokio::io::duplex(64 * 1024);
        let name = file.name.clone();
        // Bound rather than passed as a temporary: the future is held across an await, so a slice
        // of a temporary array would not outlive the call.
        let block_blob = vec![("x-ms-blob-type".to_string(), "BlockBlob".to_string())];
        let request = azure::send(
            spec,
            &credential,
            "PUT",
            &url,
            &block_blob,
            Some((
                reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(reader)),
                file.size,
            )),
        );

        let mut source = handle;
        let pumped = async {
            let mut target = writer;
            let result = pump(app, id, &mut source, &mut target, &name, &mut done, total, index as u64, files.len() as u64).await;
            let _ = target.shutdown().await;
            result
        };
        let (response, pumped) = tokio::join!(request, pumped);
        pumped?;
        let response = response?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("write {}", file.remote), response).await);
        }
    }
    Ok(())
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let at = Location::parse(path);
    let credential = azure::credential(host_id, spec).await?;

    // Unlike S3, creating a *container* is an ordinary request and a reasonable thing to do from a
    // browser — it takes no region and no policy, just a name.
    if at.key.is_empty() {
        if at.container.is_empty() {
            return Err("A container needs a name.".into());
        }
        let mut url = azure::endpoint(spec, Service::Blob)?;
        url.path_segments_mut()
            .map_err(|_| "Couldn't build the container URL".to_string())?
            .pop_if_empty()
            .push(&at.container);
        url.query_pairs_mut().append_pair("restype", "container");
        let response = azure::send(spec, &credential, "PUT", &url, &[], None).await?;
        return if response.status().is_success() {
            Ok(())
        } else {
            Err(super::explain(&format!("create {}", at.container), response).await)
        };
    }

    let marker = Location { container: at.container.clone(), key: format!("{}/", at.key) };
    let url = blob_url(spec, &marker)?;
    let response = azure::send(
        spec,
        &credential,
        "PUT",
        &url,
        &[("x-ms-blob-type".to_string(), "BlockBlob".to_string())],
        Some((reqwest::Body::from(Vec::new()), 0)),
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("create {path}"), response).await)
    }
}

pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let at = Location::parse(path);
    let credential = azure::credential(host_id, spec).await?;

    // Deleting a container *is* recursive, and unlike everything else here that is the service's
    // own semantics rather than a loop this code would be writing. It is still refused: the rule
    // this browser holds to is that deleting removes what you pointed at, and pointing at a
    // container the browser drew as a folder is not consent to delete what is inside it.
    if at.key.is_empty() {
        // Still refused *here*: `remove` is the browser's ordinary delete, reached by selecting a
        // row and pressing a key, and one keystroke must never be able to take a million blobs with
        // it. Deleting a container is a real and reasonable thing to do — it has its own verb below,
        // and its own consent.
        return Err(
            "That's a container, not a blob. Deleting one takes everything inside it, so it goes \
             through its own confirmation — the browser asks you to type the name."
                .into(),
        );
    }

    if is_dir {
        // One page is enough: the question is "is anything under here", not "how much".
        let (inside, _) = blobs(spec, &credential, &at, &ListPage::default()).await?;
        if !inside.is_empty() {
            return Err(format!(
                "\"{}\" still has {} item(s) in it. Blob storage has no recursive delete here: \
                 empty it first.",
                super::leaf(&at.key),
                inside.len()
            ));
        }
    }

    let target = Location {
        container: at.container.clone(),
        key: if is_dir { format!("{}/", at.key) } else { at.key.clone() },
    };
    let url = blob_url(spec, &target)?;
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    // 404 on a folder is not a failure: an implied folder has no marker blob to delete, and it
    // stops existing the moment the last thing under it does.
    if response.status().is_success() || (is_dir && response.status() == reqwest::StatusCode::NOT_FOUND) {
        Ok(())
    } else {
        Err(super::explain(&format!("remove {path}"), response).await)
    }
}

/// Copies one blob to another path, server-side. The bytes never come here.
///
/// **This is the half of `rename` that is worth having on its own.** Paste is a copy, and a copy
/// that went through this machine would move gigabytes over the wire twice to put a blob beside
/// itself. `x-ms-copy-source` is the service doing it internally; within one account it finishes
/// before the response comes back, which is the property `rename` leans on to know it is safe to
/// delete the source.
pub async fn copy(host_id: &str, spec: &RemoteHostSpec, from: &str, to: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let (_, _) = copy_blob(spec, &credential, from, to).await?;
    Ok(())
}

/// The copy itself, returning both URLs so `rename` can delete the source it just read.
async fn copy_blob(
    spec: &RemoteHostSpec,
    credential: &Credential,
    from: &str,
    to: &str,
) -> Result<(url::Url, url::Url), String> {
    let source = Location::parse(from);
    let target = Location::parse(to);
    if source.key.is_empty() || target.key.is_empty() {
        return Err(
            "A container isn't a blob — Azure has no operation that copies or renames one whole. \
             Make the container and move what is in it."
                .into(),
        );
    }

    let source_url = blob_url(spec, &source)?;
    let url = blob_url(spec, &target)?;
    let response = azure::send(
        spec,
        credential,
        "PUT",
        &url,
        &[("x-ms-copy-source".to_string(), source_url.to_string())],
        None,
    )
    .await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("copy {from}"), response).await);
    }
    // Within one account the copy is synchronous and the header says so. A `pending` here would
    // mean deleting a source the copy is still reading.
    let status = response
        .headers()
        .get("x-ms-copy-status")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("success")
        .to_string();
    if status != "success" {
        return Err(format!(
            "The copy of {from} came back as \"{status}\" rather than finished, so the original \
             was left alone."
        ));
    }
    Ok((source_url, url))
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let (source_url, _) = copy_blob(spec, &credential, from, to).await?;

    let response = azure::send(spec, &credential, "DELETE", &source_url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("remove {from} after copying it"), response).await)
    }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// The URL of one blob.
fn blob_url(spec: &RemoteHostSpec, at: &Location) -> Result<url::Url, String> {
    let mut url = azure::endpoint(spec, Service::Blob)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Couldn't build the blob URL".to_string())?;
        segments.pop_if_empty();
        if !at.container.is_empty() {
            segments.push(&at.container);
        }
        for part in at.key.split('/').filter(|part| !part.is_empty()) {
            segments.push(part);
        }
        if at.key.ends_with('/') {
            segments.push("");
        }
    }
    Ok(url)
}

/// One page of the account's containers, and where the next one starts.
async fn containers(
    spec: &RemoteHostSpec,
    credential: &Credential,
    page: &ListPage,
) -> Result<(Vec<RemoteFile>, String), String> {
    let mut url = azure::endpoint(spec, Service::Blob)?;
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
        return Err(super::explain("list containers", response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the container list: {e}"))?;

    let mut rows = Vec::new();
    for container in elements(&body, "Container") {
        let Some(name) = super::xml_text(&container, "Name") else { continue };
        let modified = super::xml_text(&container, "Last-Modified").unwrap_or_default();
        let mut row = container_row(&name, rfc1123_seconds(&modified));
        // A leased container cannot be deleted, and the lease is the only thing that explains the
        // 412 that would otherwise come back naming nothing.
        row.lease_state = super::xml_text(&container, "LeaseState").unwrap_or_default();
        rows.push(row);
    }
    Ok((rows, super::xml_text(&body, "NextMarker").unwrap_or_default()))
}

async fn blobs(
    spec: &RemoteHostSpec,
    credential: &Credential,
    at: &Location,
    page: &ListPage,
) -> Result<(Vec<RemoteFile>, String), String> {
    let folder = at.prefix();
    // The search box narrows *within* the folder being listed, so it extends the folder's prefix
    // rather than replacing it. Done by the service: filtering here would mean paging through a
    // million names to show three, which is the whole failure this page-at-a-time shape prevents.
    let prefix = format!("{folder}{}", page.prefix.trim());
    let mut rows = Vec::new();

    let mut url = azure::endpoint(spec, Service::Blob)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the listing URL".to_string())?
        .pop_if_empty()
        .push(&at.container);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("restype", "container");
        query.append_pair("comp", "list");
        query.append_pair("delimiter", "/");
        query.append_pair("maxresults", &PAGE.to_string());
        if !prefix.is_empty() {
            query.append_pair("prefix", &prefix);
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

    for entry in elements(&body, "BlobPrefix") {
        if let Some(key) = super::xml_text(&entry, "Name") {
            rows.push(folder_row(at, &key));
        }
    }
    for blob in elements(&body, "Blob") {
        let Some(key) = super::xml_text(&blob, "Name") else { continue };
        // Against the *folder's* prefix, not the searched one: the marker blob belongs to the
        // directory being listed, and a search that happened to match it should still hide it.
        if is_own_marker(&key, &folder) {
            continue;
        }
        let size = super::xml_text(&blob, "Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
        let modified = super::xml_text(&blob, "Last-Modified").unwrap_or_default();
        let mut row = object_row(at, &key, size, rfc1123_seconds(&modified));
        // All four are already in the listing's `<Properties>`, so they cost nothing: no extra
        // request, no round trip per row. Two of them change what the user can *do* — an `Archive`
        // blob is unreadable until rehydrated, and a leased one refuses writes — and finding either
        // out from a failed operation is finding it out too late.
        row.content_type = super::xml_text(&blob, "Content-Type").unwrap_or_default();
        row.tier = super::xml_text(&blob, "AccessTier").unwrap_or_default();
        row.blob_type = super::xml_text(&blob, "BlobType").unwrap_or_default();
        row.lease_state = super::xml_text(&blob, "LeaseState").unwrap_or_default();
        rows.push(row);
    }
    Ok((rows, super::xml_text(&body, "NextMarker").unwrap_or_default()))
}

async fn plan_download(
    spec: &RemoteHostSpec,
    credential: &Credential,
    remote_path: &str,
    local_path: &str,
) -> Result<Vec<Planned>, String> {
    let at = Location::parse(remote_path);
    if at.container.is_empty() {
        return Err("Pick a container — the account root has nothing to download.".into());
    }

    let url = blob_url(spec, &at)?;
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

    // Undelimited: every blob under the prefix, however deep, in one walk.
    let prefix = at.prefix();
    let mut planned = Vec::new();
    let mut marker = String::new();
    loop {
        let mut url = azure::endpoint(spec, Service::Blob)?;
        url.path_segments_mut()
            .map_err(|_| "Couldn't build the listing URL".to_string())?
            .pop_if_empty()
            .push(&at.container);
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("restype", "container");
            query.append_pair("comp", "list");
            query.append_pair("maxresults", &PAGE.to_string());
            if !prefix.is_empty() {
                query.append_pair("prefix", &prefix);
            }
            if !marker.is_empty() {
                query.append_pair("marker", &marker);
            }
        }
        let response = azure::send(spec, credential, "GET", &url, &[], None).await?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("list {remote_path}"), response).await);
        }
        let body = response.text().await.map_err(|e| format!("Couldn't read the listing: {e}"))?;

        for blob in elements(&body, "Blob") {
            let Some(key) = super::xml_text(&blob, "Name") else { continue };
            if key.ends_with('/') {
                continue;
            }
            let size = super::xml_text(&blob, "Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
            let relative = key.strip_prefix(&prefix).unwrap_or(&key).to_string();
            planned.push(Planned {
                remote: Location { container: at.container.clone(), key: key.clone() }.path(),
                local: std::path::Path::new(local_path)
                    .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .to_string_lossy()
                    .to_string(),
                name: super::leaf(&key),
                size,
            });
        }
        match super::xml_text(&body, "NextMarker") {
            Some(next) if !next.is_empty() => marker = next,
            _ => break,
        }
    }

    if planned.is_empty() {
        return Err(format!("There is nothing at {remote_path} to download."));
    }
    Ok(planned)
}

/// Every `<name>…</name>` block, as raw slices. See [`super::s3`] for why this is a scan.
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
  <Blobs>
    <BlobPrefix><Name>2024/raw/</Name></BlobPrefix>
    <Blob>
      <Name>2024/</Name>
      <Properties><Last-Modified>Wed, 21 Oct 2015 07:28:00 GMT</Last-Modified><Content-Length>0</Content-Length></Properties>
    </Blob>
    <Blob>
      <Name>2024/cat.jpg</Name>
      <Properties><Last-Modified>Mon, 04 Mar 2024 10:11:12 GMT</Last-Modified><Content-Length>41234</Content-Length></Properties>
    </Blob>
  </Blobs>
  <NextMarker />
</EnumerationResults>"#;

    fn spec() -> RemoteHostSpec {
        let mut s = RemoteHostSpec { kind: RemoteKind::AzureBlob, ..Default::default() };
        s.azure.account = "contoso".into();
        s
    }

    #[test]
    fn a_delimited_listing_becomes_folders_and_files() {
        let at = Location::parse("/photos/2024");
        let prefix = at.prefix();

        let folders: Vec<_> = elements(LISTING, "BlobPrefix")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Name"))
            .map(|key| folder_row(&at, &key))
            .collect();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "raw");
        assert_eq!(folders[0].path, "/photos/2024/raw");

        let files: Vec<_> = elements(LISTING, "Blob")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Name"))
            .filter(|key| !is_own_marker(key, &prefix))
            .collect();
        assert_eq!(files, vec!["2024/cat.jpg"]);
    }

    /// Size and date live one level down in `<Properties>`, unlike S3 where they are siblings of
    /// the key — reading them off the whole `<Blob>` block is what makes that difference invisible.
    #[test]
    fn size_and_date_are_read_out_of_properties() {
        let block = &elements(LISTING, "Blob")[1];
        assert_eq!(super::super::xml_text(block, "Content-Length").unwrap(), "41234");
        assert_eq!(
            rfc1123_seconds(&super::super::xml_text(block, "Last-Modified").unwrap()),
            1709547072
        );
    }

    #[test]
    fn a_blob_url_is_the_account_endpoint_plus_container_and_key() {
        assert_eq!(
            blob_url(&spec(), &Location::parse("/photos/2024/cat.jpg")).unwrap().as_str(),
            "https://contoso.blob.core.windows.net/photos/2024/cat.jpg"
        );
        // And a folder marker keeps the trailing slash that is part of its name.
        assert_eq!(
            blob_url(&spec(), &Location { container: "photos".into(), key: "2024/".into() })
                .unwrap()
                .as_str(),
            "https://contoso.blob.core.windows.net/photos/2024/"
        );
    }
}

/// Deletes a container and everything in it.
///
/// **Separate from [`remove`] on purpose, and not because Azure needs it to be.** `DELETE
/// ?restype=container` is one first-class request — unlike a *folder*, which is a prefix that
/// storage has no recursive delete for. What makes this its own verb is the blast radius: `remove`
/// is what a selected row and the Delete key reach, and no keystroke should be able to take a
/// million blobs. A caller has to mean this one specifically, and the browser makes the user type
/// the name before it does.
///
/// The service reports the delete as accepted and then does the work; the container stops appearing
/// in listings immediately but the name is not reusable until the deletion finishes.
pub async fn remove_container(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        return Err("Which container?".into());
    }
    if !at.key.is_empty() {
        return Err("That is a blob inside a container, not the container itself.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = azure::endpoint(spec, Service::Blob)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the container URL".to_string())?
        .pop_if_empty()
        .push(&at.container);
    url.query_pairs_mut().append_pair("restype", "container");
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("delete the container {}", at.container), response).await)
    }
}

// ---------------------------------------------------------------------------
// Beyond the seven verbs: properties and snapshots
// ---------------------------------------------------------------------------

/// Everything the service will say about one blob or one container, flattened.
///
/// **Deliberately a list of pairs rather than a struct.** A container answers with a public access
/// level and a lease; a blob answers with a type, a tier, an ETag, a content type and a dozen
/// `x-ms-*` fields that differ by account feature. A struct would either be mostly `None` or would
/// need a new field every time Azure adds a header — and the panel that draws this only ever renders
/// name/value rows anyway.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Properties {
    pub path: String,
    /// The URL the thing is reachable at. Not a credential: reaching it still needs a key or a SAS.
    pub url: String,
    pub rows: Vec<(String, String)>,
}

/// The headers worth showing, in the order they read best. Anything else the service returns is
/// appended after these, so a feature we have never heard of still shows up.
const SHOWN: [(&str, &str); 10] = [
    ("x-ms-blob-type", "Blob type"),
    ("content-type", "Content type"),
    ("content-length", "Size"),
    ("x-ms-access-tier", "Access tier"),
    ("x-ms-blob-public-access", "Public access"),
    ("x-ms-lease-state", "Lease state"),
    ("x-ms-lease-status", "Lease status"),
    ("last-modified", "Last modified"),
    ("etag", "ETag"),
    ("x-ms-creation-time", "Created"),
];

/// `HEAD` against a blob, or against a container with `?restype=container`.
///
/// A HEAD rather than a GET: every one of these values arrives as a response header, and a GET would
/// pull the blob's bytes down to read them.
pub async fn properties(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<Properties, String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        return Err("Pick a container or a blob — the account root has no properties of its own.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = blob_url(spec, &at)?;
    if at.key.is_empty() {
        url.query_pairs_mut().append_pair("restype", "container");
    }
    let response = azure::send(spec, &credential, "HEAD", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("read the properties of {path}"), response).await);
    }

    let headers = response.headers().clone();
    let read = |name: &str| {
        headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or_default().to_string()
    };
    let mut rows: Vec<(String, String)> = SHOWN
        .iter()
        .map(|(header, label)| ((*label).to_string(), read(header)))
        .filter(|(_, value)| !value.is_empty())
        .collect();
    // Everything else the service chose to say. Kept because the interesting header is often the one
    // this list was written too early to know about — immutability, versioning, encryption scope.
    let known: Vec<&str> = SHOWN.iter().map(|(header, _)| *header).collect();
    for (name, value) in headers.iter() {
        let name = name.as_str();
        if !name.starts_with("x-ms-") || known.contains(&name) || name == "x-ms-request-id" {
            continue;
        }
        if let Ok(value) = value.to_str() {
            rows.push((name.to_string(), value.to_string()));
        }
    }

    let mut shown = blob_url(spec, &at)?;
    shown.set_query(None);
    Ok(Properties { path: path.to_string(), url: shown.to_string(), rows })
}

/// One snapshot of a blob, as a row.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Snapshot {
    /// The timestamp that identifies it — this *is* the identifier, passed back as `?snapshot=`.
    pub stamp: String,
    pub size: u64,
    pub modified: u64,
}

/// Freezes the blob as it is now.
///
/// A snapshot is read-only and shares storage with the blob until one of them changes, which is why
/// this is cheap and why it is the thing to do before an overwrite you are not sure about.
pub async fn snapshot(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<String, String> {
    let at = Location::parse(path);
    if at.key.is_empty() {
        return Err("Only a blob can be snapshotted — a container has no such operation.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = blob_url(spec, &at)?;
    url.query_pairs_mut().append_pair("comp", "snapshot");
    let response = azure::send(spec, &credential, "PUT", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("snapshot {path}"), response).await);
    }
    Ok(response
        .headers()
        .get("x-ms-snapshot")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string())
}

/// Every snapshot of one blob, newest first.
///
/// Listed rather than fetched one by one because there is no "get the snapshots of this blob" call:
/// the container listing includes them when asked, and they arrive as ordinary `<Blob>` entries
/// carrying a `<Snapshot>` stamp. Filtering by exact key is what makes it about one blob.
pub async fn snapshots(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<Vec<Snapshot>, String> {
    let at = Location::parse(path);
    if at.key.is_empty() {
        return Err("Only a blob has snapshots.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = azure::endpoint(spec, Service::Blob)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the listing URL".to_string())?
        .pop_if_empty()
        .push(&at.container);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("restype", "container");
        query.append_pair("comp", "list");
        query.append_pair("include", "snapshots");
        query.append_pair("prefix", &at.key);
    }
    let response = azure::send(spec, &credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("list the snapshots of {path}"), response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the listing: {e}"))?;

    let mut rows = Vec::new();
    for blob in elements(&body, "Blob") {
        // The prefix matches longer names too — `photo.png` also returns `photo.png.bak` — so the
        // key has to match exactly or the panel would show another blob's history.
        if super::xml_text(&blob, "Name").as_deref() != Some(at.key.as_str()) {
            continue;
        }
        let Some(stamp) = super::xml_text(&blob, "Snapshot") else { continue };
        rows.push(Snapshot {
            stamp,
            size: super::xml_text(&blob, "Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0),
            modified: rfc1123_seconds(&super::xml_text(&blob, "Last-Modified").unwrap_or_default()),
        });
    }
    rows.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    Ok(rows)
}

/// Deletes one snapshot, leaving the blob and its other snapshots alone.
pub async fn delete_snapshot(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    stamp: &str,
) -> Result<(), String> {
    let at = Location::parse(path);
    if at.key.is_empty() || stamp.trim().is_empty() {
        return Err("A snapshot is identified by a blob and a timestamp.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let mut url = blob_url(spec, &at)?;
    url.query_pairs_mut().append_pair("snapshot", stamp.trim());
    let response = azure::send(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("delete the snapshot {stamp}"), response).await)
    }
}

/// Puts a snapshot's bytes back over the blob it came from.
///
/// A copy, not a "restore": Azure has no restore verb. The blob keeps its own snapshots — including
/// one taken of the state being replaced, if the caller took one — because a copy over a blob does
/// not touch its history.
pub async fn restore_snapshot(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    stamp: &str,
) -> Result<(), String> {
    let at = Location::parse(path);
    if at.key.is_empty() || stamp.trim().is_empty() {
        return Err("A snapshot is identified by a blob and a timestamp.".into());
    }
    let credential = azure::credential(host_id, spec).await?;

    let url = blob_url(spec, &at)?;
    let mut source = url.clone();
    source.query_pairs_mut().append_pair("snapshot", stamp.trim());
    let response = azure::send(
        spec,
        &credential,
        "PUT",
        &url,
        &[("x-ms-copy-source".to_string(), source.to_string())],
        None,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("restore the snapshot {stamp}"), response).await)
    }
}
