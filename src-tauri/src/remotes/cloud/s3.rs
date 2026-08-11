//! S3, as the file browser's seven verbs.
//!
//! Amazon's, or anything that speaks the same API — the endpoint is a field, so MinIO, Cloudflare
//! R2, Wasabi and Ceph are the same transport with a different host.
//!
//! **Stateless, unlike the other two.** SFTP holds an `ssh` subprocess and FTP holds a control
//! connection, so both keep a session map keyed by host and both need [`close`] to mean something.
//! Here every verb is one or more signed HTTPS requests over a shared connection pool
//! ([`super::http`]), and there is nothing to hold open. [`close`] exists to satisfy the dispatch
//! and does nothing, which is the honest implementation rather than a missing one.
//!
//! Everything about how objects are made to look like a tree is in [`super`] — read that first.

use tokio::io::AsyncWriteExt as _;

use super::super::files::{
    plan_upload, pump, sort_entries, ListPage, Planned, RemoteFile, RemoteListing, PAGE,
};
use super::super::RemoteHostSpec;
use super::aws::{self, Body, Credentials};
use super::{
    container_row, folder_row, is_own_marker, iso8601_seconds, object_row, Location,
};

/// How many keys one listing request asks for.
///
/// The service's own maximum. Fewer requests for a large prefix, and the browser shows the whole

/// Nothing is held open, so there is nothing to close. See the module comment.
pub async fn close(_host_id: &str) {}

// ---------------------------------------------------------------------------
// The seven verbs
// ---------------------------------------------------------------------------

/// Lists a bucket prefix — or, at the account root, the buckets themselves.
pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    page: &ListPage,
) -> Result<RemoteListing, String> {
    let at = Location::parse(path);
    let creds = aws::credentials(host_id, spec).await?;

    let (mut entries, next) = if at.is_account_root() {
        // `ListBuckets` has no paging and no prefix of its own — an account's buckets are tens, not
        // millions — so the prefix is applied here and there is never a second page.
        (buckets(spec, &creds, page).await?, String::new())
    } else {
        objects(spec, &creds, &at, page).await?
    };
    sort_entries(&mut entries);
    Ok(RemoteListing { path: at.path(), entries, next })
}

/// One object, or one whole prefix, from the bucket to here.
pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let creds = aws::credentials(host_id, spec).await?;
    let files = plan_download(spec, &creds, remote_path, local_path).await?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        if let Some(parent) = std::path::Path::new(&file.local).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let at = Location::parse(&file.remote);
        let url = aws::url(spec, &at.container, &at.key)?;
        let response = aws::send(spec, &creds, "GET", &url, &[], Body::Empty).await?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("read {}", file.remote), response).await);
        }

        // reqwest hands back a stream of chunks; `pump` — and therefore the one progress bar every
        // transport shares — is written against `AsyncRead`. `StreamReader` is the adapter, and
        // using it is what keeps a download from S3 reporting progress the same way one from SFTP
        // does.
        let stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other));
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

/// One file, or one whole folder, from here to the bucket.
pub async fn upload(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let creds = aws::credentials(host_id, spec).await?;
    let files = plan_upload(local_path, remote_path)?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        let at = Location::parse(&file.remote);
        if at.container.is_empty() {
            return Err("Pick a bucket to upload into — the account root only holds buckets.".into());
        }
        // No parent to create, unlike SFTP and FTP: a key's slashes are part of its name, and the
        // folder it appears to be in comes into existence with it.
        let url = aws::url(spec, &at.container, &at.key)?;
        let handle = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;

        // The progress bar wants to watch the bytes go past, and a body handed straight to reqwest
        // would move them where nothing can count them. So the file is pumped into a pipe, the pipe
        // is the request body, and `pump` sees every chunk exactly as it does for the other
        // transports. `Content-Length` is set from the size on disk, since a streamed body has none
        // and S3 refuses a chunked PUT that isn't its own chunked-signing format.
        let (reader, writer) = tokio::io::duplex(64 * 1024);
        let name = file.name.clone();
        let size = file.size;
        // Bound rather than passed as a temporary: the future is held across an await, so a slice
        // of a temporary array would not outlive the call.
        let length = vec![("content-length".to_string(), size.to_string())];
        let request = aws::send(
            spec,
            &creds,
            "PUT",
            &url,
            &length,
            Body::Streamed(reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(reader))),
        );

        let mut source = handle;
        // Both halves at once: the send only completes once the body is consumed, and the pump only
        // completes once the reader takes it, so awaiting either alone deadlocks.
        let pumped = async {
            let mut target = writer;
            let result = pump(app, id, &mut source, &mut target, &name, &mut done, total, index as u64, files.len() as u64).await;
            // Shutting the writer is what ends the body — without it the request never finishes.
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

/// Makes a folder persist, by writing the zero-byte marker object the convention calls for.
pub async fn make_dir(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<(), String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        return Err(
            "Creating a bucket isn't something this browser does — make it in the AWS console, \
             where its region and its access policy are decided."
                .into(),
        );
    }
    let creds = aws::credentials(host_id, spec).await?;
    let url = aws::url(spec, &at.container, &format!("{}/", at.key))?;
    let response = aws::send(
        spec,
        &creds,
        "PUT",
        &url,
        &[("content-length".to_string(), "0".to_string())],
        Body::Bytes(Vec::new()),
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("create {path}"), response).await)
    }
}

/// Deletes one object, or one empty folder's marker. Not recursive — see [`super::super::files::remove`].
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        // See `blob::remove` — the ordinary delete never takes a whole top-level namespace, and the
        // verb that does asks for the name first.
        return Err(
            "That's a bucket, not an object. Deleting one goes through its own confirmation — the \
             browser asks you to type the name."
                .into(),
        );
    }
    let creds = aws::credentials(host_id, spec).await?;

    if is_dir {
        // A prefix is not a thing that can be deleted; what can is the marker, and only once
        // nothing is under it. Checking first turns "the folder is still there" — which is what
        // deleting only the marker looks like — into a sentence saying why.
        // One page is enough: the question is "is anything under here", not "how much".
        let (listing, _) = objects(spec, &creds, &at, &ListPage::default()).await?;
        if !listing.is_empty() {
            return Err(format!(
                "\"{}\" still has {} item(s) in it. Object storage has no recursive delete here: \
                 empty it first.",
                super::leaf(&at.key),
                listing.len()
            ));
        }
    }

    let key = if is_dir { format!("{}/", at.key) } else { at.key.clone() };
    let url = aws::url(spec, &at.container, &key)?;
    let response = aws::send(spec, &creds, "DELETE", &url, &[], Body::Empty).await?;
    // 204 for a delete that removed something, and 204 again for one that had nothing to remove:
    // S3 delete is idempotent and does not distinguish. An empty folder that was never given a
    // marker therefore disappears from the browser without an error, which is right — it was only
    // ever the absence of anything under a prefix.
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("remove {path}"), response).await)
    }
}

/// Renames by copying server-side and deleting the original.
///
/// Only objects. Renaming a folder means copying every key under a prefix, which is an unbounded
/// number of billable operations behind a gesture that looks instant — and is a partial rename if
/// anything fails halfway. It is refused rather than half-implemented.
pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let source = Location::parse(from);
    let target = Location::parse(to);
    if source.container.is_empty() || target.container.is_empty() {
        return Err("A bucket can't be renamed from here.".into());
    }
    let creds = aws::credentials(host_id, spec).await?;

    let url = aws::url(spec, &target.container, &target.key)?;
    // The copy source is `/bucket/key`, percent-encoded, and it is a *header* — so a key with a
    // space in it has to arrive encoded or the header is unparseable.
    let copy_source = format!(
        "/{}/{}",
        source.container,
        percent_encoding::utf8_percent_encode(&source.key, percent_encoding::NON_ALPHANUMERIC)
            .to_string()
            .replace("%2F", "/")
    );
    let response = aws::send(
        spec,
        &creds,
        "PUT",
        &url,
        &[("x-amz-copy-source".to_string(), copy_source)],
        Body::Empty,
    )
    .await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("copy {from}"), response).await);
    }
    // S3 reports a failed copy *inside a 200 body* when it fails after the headers went out, so the
    // status alone is not proof. An error document here means the copy did not happen, and deleting
    // the source now would lose the object.
    let body = response.text().await.unwrap_or_default();
    if body.contains("<Error") {
        let detail = super::xml_text(&body, "Message").unwrap_or_else(|| "the copy failed".into());
        return Err(format!("Couldn't copy {from}: {detail}"));
    }

    let url = aws::url(spec, &source.container, &source.key)?;
    let response = aws::send(spec, &creds, "DELETE", &url, &[], Body::Empty).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("remove {from} after copying it"), response).await)
    }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// The account's buckets, as folders.
async fn buckets(
    spec: &RemoteHostSpec,
    creds: &Credentials,
    page: &ListPage,
) -> Result<Vec<RemoteFile>, String> {
    let url = aws::url(spec, "", "")?;
    let response = aws::send(spec, creds, "GET", &url, &[], Body::Empty).await?;
    if !response.status().is_success() {
        return Err(super::explain("list buckets", response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the bucket list: {e}"))?;

    let filter = page.prefix.trim().to_lowercase();
    let mut rows = Vec::new();
    for bucket in elements(&body, "Bucket") {
        let Some(name) = super::xml_text(&bucket, "Name") else { continue };
        if !filter.is_empty() && !name.to_lowercase().starts_with(&filter) {
            continue;
        }
        let created = super::xml_text(&bucket, "CreationDate").unwrap_or_default();
        rows.push(container_row(&name, iso8601_seconds(&created)));
    }
    Ok(rows)
}

/// One page, and the token the next one starts from.
async fn objects(
    spec: &RemoteHostSpec,
    creds: &Credentials,
    at: &Location,
    page: &ListPage,
) -> Result<(Vec<RemoteFile>, String), String> {
    let folder = at.prefix();
    // The search narrows *within* this folder, so it extends the prefix rather than replacing it.
    let prefix = format!("{folder}{}", page.prefix.trim());
    let mut rows = Vec::new();

    let mut url = aws::url(spec, &at.container, "")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("list-type", "2");
        // The delimiter is what turns a flat keyspace into one level of a tree: everything sharing
        // a prefix up to the next `/` collapses into one `CommonPrefixes` entry instead of arriving
        // as a thousand keys the browser would have to group itself.
        query.append_pair("delimiter", "/");
        query.append_pair("max-keys", &PAGE.to_string());
        if !prefix.is_empty() {
            query.append_pair("prefix", &prefix);
        }
        if !page.marker.is_empty() {
            query.append_pair("continuation-token", &page.marker);
        }
    }

    let response = aws::send(spec, creds, "GET", &url, &[], Body::Empty).await?;
    if !response.status().is_success() {
        return Err(super::explain(&format!("list {}", at.path()), response).await);
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the listing: {e}"))?;

    for entry in elements(&body, "CommonPrefixes") {
        if let Some(key) = super::xml_text(&entry, "Prefix") {
            rows.push(folder_row(at, &key));
        }
    }
    for object in elements(&body, "Contents") {
        let Some(key) = super::xml_text(&object, "Key") else { continue };
        // Against the folder's own prefix, not the searched one: the marker object belongs to the
        // directory being listed, and a search that happened to match it should still hide it.
        if is_own_marker(&key, &folder) {
            continue;
        }
        let size = super::xml_text(&object, "Size").and_then(|s| s.parse().ok()).unwrap_or(0);
        let modified = super::xml_text(&object, "LastModified").unwrap_or_default();
        rows.push(object_row(at, &key, size, iso8601_seconds(&modified)));
    }

    // `IsTruncated` and a token, or this was the whole listing.
    Ok((rows, super::xml_text(&body, "NextContinuationToken").unwrap_or_default()))
}

/// Everything under `remote_path`, flattened into one file per object.
///
/// Recursive for a folder, which is the one place object storage's flat keyspace helps: a listing
/// with no delimiter returns every key under the prefix in one walk, so a deep tree costs the same
/// number of requests as a shallow one.
async fn plan_download(
    spec: &RemoteHostSpec,
    creds: &Credentials,
    remote_path: &str,
    local_path: &str,
) -> Result<Vec<Planned>, String> {
    let at = Location::parse(remote_path);
    if at.container.is_empty() {
        return Err("Pick a bucket — the account root has nothing to download.".into());
    }

    // A HEAD that answers is an object; anything else is treated as a prefix. Cheaper and more
    // reliable than guessing from the name, since a key may legitimately have no extension and a
    // folder may legitimately look like one.
    let url = aws::url(spec, &at.container, &at.key)?;
    let head = aws::send(spec, creds, "HEAD", &url, &[], Body::Empty).await?;
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

    let prefix = at.prefix();
    let mut planned = Vec::new();
    let mut token = String::new();
    loop {
        let mut url = aws::url(spec, &at.container, "")?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("list-type", "2");
            query.append_pair("max-keys", &PAGE.to_string());
            if !prefix.is_empty() {
                query.append_pair("prefix", &prefix);
            }
            if !token.is_empty() {
                query.append_pair("continuation-token", &token);
            }
        }
        let response = aws::send(spec, creds, "GET", &url, &[], Body::Empty).await?;
        if !response.status().is_success() {
            return Err(super::explain(&format!("list {remote_path}"), response).await);
        }
        let body = response.text().await.map_err(|e| format!("Couldn't read the listing: {e}"))?;

        for object in elements(&body, "Contents") {
            let Some(key) = super::xml_text(&object, "Key") else { continue };
            // Folder markers are structure, not content: recreating them as empty files on this
            // side would litter the download with zero-byte entries named after their own folder.
            if key.ends_with('/') {
                continue;
            }
            let size = super::xml_text(&object, "Size").and_then(|s| s.parse().ok()).unwrap_or(0);
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
        match super::xml_text(&body, "NextContinuationToken") {
            Some(next) if !next.is_empty() => token = next,
            _ => break,
        }
    }

    if planned.is_empty() {
        return Err(format!("There is nothing at {remote_path} to download."));
    }
    Ok(planned)
}

/// Every `<name>…</name>` block in a document, as raw slices.
///
/// A scan rather than a pull parser, and worth justifying: the two listings this reads have a flat
/// shape — a repeated element with leaf children — and the inner fields are then read with
/// [`super::xml_text`], which is the same function the error path uses. What a real parser would
/// buy is nesting and namespace handling, neither of which appears in `ListObjectsV2` or
/// `ListAllMyBuckets`. What it would cost is a second way of reading XML in this module.
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

use futures_util::StreamExt as _;

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>photos</Name>
  <Prefix>2024/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>2024/</Key>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <Size>0</Size>
  </Contents>
  <Contents>
    <Key>2024/cat.jpg</Key>
    <LastModified>2024-03-04T10:11:12.000Z</LastModified>
    <Size>41234</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>2024/raw/</Prefix>
  </CommonPrefixes>
</ListBucketResult>"#;

    #[test]
    fn a_delimited_listing_becomes_folders_and_files() {
        let at = Location::parse("/photos/2024");
        let prefix = at.prefix();

        let folders: Vec<_> = elements(LISTING, "CommonPrefixes")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Prefix"))
            .map(|key| folder_row(&at, &key))
            .collect();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "raw");
        assert!(folders[0].is_dir);
        assert_eq!(folders[0].path, "/photos/2024/raw");

        let files: Vec<_> = elements(LISTING, "Contents")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Key"))
            .filter(|key| !is_own_marker(key, &prefix))
            .collect();
        // The `2024/` marker is the folder being listed, not a row inside it.
        assert_eq!(files, vec!["2024/cat.jpg"]);
    }

    #[test]
    fn an_object_row_carries_its_size_and_date() {
        let at = Location::parse("/photos/2024");
        let block = &elements(LISTING, "Contents")[1];
        let row = object_row(
            &at,
            &super::super::xml_text(block, "Key").unwrap(),
            super::super::xml_text(block, "Size").unwrap().parse().unwrap(),
            iso8601_seconds(&super::super::xml_text(block, "LastModified").unwrap()),
        );
        assert_eq!(row.name, "cat.jpg");
        assert_eq!(row.path, "/photos/2024/cat.jpg");
        assert_eq!(row.size, 41234);
        assert_eq!(row.modified, 1709547072);
        assert!(!row.is_dir);
    }

    #[test]
    fn buckets_are_read_out_of_the_account_listing() {
        let body = r#"<ListAllMyBucketsResult><Buckets>
            <Bucket><Name>photos</Name><CreationDate>2020-05-01T00:00:00.000Z</CreationDate></Bucket>
            <Bucket><Name>backups</Name><CreationDate>2021-06-02T00:00:00.000Z</CreationDate></Bucket>
        </Buckets></ListAllMyBucketsResult>"#;
        let names: Vec<_> = elements(body, "Bucket")
            .iter()
            .filter_map(|block| super::super::xml_text(block, "Name"))
            .collect();
        assert_eq!(names, vec!["photos", "backups"]);
    }

    /// A key with an `&` in it arrives escaped, and a row named `a&amp;b.txt` would be wrong on
    /// screen and wrong in the URL built from it.
    #[test]
    fn escaped_characters_in_a_key_come_back_as_themselves() {
        let body = "<Contents><Key>a &amp; b/c&lt;d&gt;.txt</Key><Size>1</Size></Contents>";
        let key = super::super::xml_text(&elements(body, "Contents")[0], "Key").unwrap();
        assert_eq!(key, "a & b/c<d>.txt");
    }
}

/// Deletes a bucket.
///
/// **Unlike Azure's container delete, this one is not recursive and cannot be.** S3 refuses to
/// delete a bucket that still has objects in it, and that refusal is the service's own — so this is
/// the rare destructive verb where the far side, not this browser, is the thing standing between a
/// click and a mistake. The typed confirmation in front of it is still worth having: a bucket name
/// is global to AWS, and deleting one gives it back to whoever asks for it next.
pub async fn remove_bucket(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let at = Location::parse(path);
    if at.container.is_empty() {
        return Err("Which bucket?".into());
    }
    if !at.key.is_empty() {
        return Err("That is an object inside a bucket, not the bucket itself.".into());
    }
    let creds = aws::credentials(host_id, spec).await?;

    let url = aws::url(spec, &at.container, "")?;
    let response = aws::send(spec, &creds, "DELETE", &url, &[], Body::Empty).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(super::explain(&format!("delete the bucket {}", at.container), response).await)
    }
}
