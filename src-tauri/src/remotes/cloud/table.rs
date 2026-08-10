//! Azure Table storage.
//!
//! **Not files either, and not a relational table.** An entity is a bag of typed properties keyed by
//! a `PartitionKey` and a `RowKey`; two rows in one table may carry entirely different columns. So
//! what comes back here is deliberately *not* a fixed schema — it is a list of JSON objects plus the
//! union of the keys seen, and the panel builds its columns from that.
//!
//! **The one query that is fast is the one nobody writes.** A point read on both keys is O(1); a
//! filter on a partition is a scan of that partition; a filter on neither is a scan of the table.
//! The service will happily do the last one and bill for it, so [`query`] takes the filter verbatim
//! and the panel says which of the three a given filter is.
//!
//! This service speaks OData JSON and signs with its own canonical form — see
//! [`super::azure::sign_table`], which is where the two differences that matter are written down.

use serde::Serialize;

use super::super::RemoteHostSpec;
use super::azure::{self, Service};

/// How many entities one page asks for. The service caps a page at 1000 regardless.
const PAGE: usize = 500;

/// One table in an account.
#[derive(Debug, Clone, Serialize)]
pub struct TableSummary {
    pub name: String,
}

/// A page of entities, and how to ask for the next one.
#[derive(Debug, Clone, Serialize)]
pub struct TablePage {
    /// The union of every key seen on this page, with `PartitionKey`, `RowKey` and `Timestamp`
    /// first. The panel's columns — built from the data because there is no schema to read.
    pub columns: Vec<String>,
    /// Each entity as a JSON object, values left as the service typed them.
    pub rows: Vec<serde_json::Value>,
    /// The continuation, when the answer was cut short. Two opaque tokens rather than one, because
    /// that is how the service paginates: a partition and a row to resume from.
    pub next_partition_key: String,
    pub next_row_key: String,
}

/// The account's tables.
pub async fn tables(host_id: &str, spec: &RemoteHostSpec) -> Result<Vec<TableSummary>, String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = azure::endpoint(spec, Service::Table)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the table URL".to_string())?
        .pop_if_empty()
        .push("Tables");

    let response = azure::send_table(spec, &credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(explain("list tables", response).await);
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Couldn't read the table list: {e}"))?;

    Ok(body["value"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry["TableName"].as_str().map(|name| TableSummary { name: name.to_string() }))
                .collect()
        })
        .unwrap_or_default())
}

/// One page of entities from a table.
///
/// `filter` is an OData `$filter` expression, passed through as written — `PartitionKey eq 'eu'`,
/// `Age gt 30`. Empty means everything, which on a large table is a scan; that is the user's call
/// to make, and the panel is where it is spelled out.
pub async fn query(
    host_id: &str,
    spec: &RemoteHostSpec,
    table: &str,
    filter: &str,
    select: &str,
    from_partition: &str,
    from_row: &str,
) -> Result<TablePage, String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = azure::endpoint(spec, Service::Table)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the query URL".to_string())?
        .pop_if_empty()
        .push(&format!("{table}()"));
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("$top", &PAGE.to_string());
        if !filter.trim().is_empty() {
            query.append_pair("$filter", filter.trim());
        }
        if !select.trim().is_empty() {
            query.append_pair("$select", select.trim());
        }
        // Both halves or neither: resuming from a partition without its row restarts that partition
        // from the beginning, which silently repeats rows.
        if !from_partition.is_empty() && !from_row.is_empty() {
            query.append_pair("NextPartitionKey", from_partition);
            query.append_pair("NextRowKey", from_row);
        }
    }

    let response = azure::send_table(spec, &credential, "GET", &url, &[], None).await?;
    if !response.status().is_success() {
        return Err(explain(&format!("query {table}"), response).await);
    }

    // The continuation arrives in headers, not in the body — read before the body is consumed.
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let next_partition_key = header("x-ms-continuation-nextpartitionkey");
    let next_row_key = header("x-ms-continuation-nextrowkey");

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Couldn't read the entities: {e}"))?;
    let rows: Vec<serde_json::Value> = body["value"].as_array().cloned().unwrap_or_default();

    Ok(TablePage { columns: columns_of(&rows), rows, next_partition_key, next_row_key })
}

/// Inserts or replaces one entity. `entity` must carry `PartitionKey` and `RowKey`.
pub async fn upsert(
    host_id: &str,
    spec: &RemoteHostSpec,
    table: &str,
    entity: serde_json::Value,
) -> Result<(), String> {
    let partition = entity["PartitionKey"].as_str().unwrap_or_default().to_string();
    let row = entity["RowKey"].as_str().unwrap_or_default().to_string();
    if partition.is_empty() || row.is_empty() {
        return Err("An entity needs both a PartitionKey and a RowKey.".into());
    }
    let credential = azure::credential(host_id, spec).await?;
    let url = entity_url(spec, table, &partition, &row)?;
    let payload = serde_json::to_vec(&entity).map_err(|e| format!("Couldn't encode the entity: {e}"))?;

    // MERGE would keep properties this entity doesn't mention; PUT replaces the whole thing, which
    // is what an editor that showed you every column should do — anything else silently keeps a
    // value the user just deleted from the form.
    let response = azure::send_table(spec, &credential, "PUT", &url, &[], Some(payload)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(explain(&format!("save that entity in {table}"), response).await)
    }
}

/// Deletes one entity.
pub async fn delete_entity(
    host_id: &str,
    spec: &RemoteHostSpec,
    table: &str,
    partition: &str,
    row: &str,
) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let url = entity_url(spec, table, partition, row)?;
    // `*` is "whatever version is there". The alternative is reading the ETag first and refusing on
    // a mismatch, which is the right behaviour for a form the user has been editing — but this is
    // a delete of a row they are pointing at, and a concurrent change does not make them want it
    // less.
    let response = azure::send_table(
        spec,
        &credential,
        "DELETE",
        &url,
        &[("if-match".to_string(), "*".to_string())],
        None,
    )
    .await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(explain("delete that entity", response).await)
    }
}

/// Creates a table.
pub async fn create(host_id: &str, spec: &RemoteHostSpec, name: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = azure::endpoint(spec, Service::Table)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the table URL".to_string())?
        .pop_if_empty()
        .push("Tables");
    let payload = serde_json::to_vec(&serde_json::json!({ "TableName": name }))
        .map_err(|e| format!("Couldn't encode the request: {e}"))?;
    let response = azure::send_table(spec, &credential, "POST", &url, &[], Some(payload)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(explain(&format!("create {name}"), response).await)
    }
}

/// Deletes a table and every entity in it.
pub async fn remove(host_id: &str, spec: &RemoteHostSpec, name: &str) -> Result<(), String> {
    let credential = azure::credential(host_id, spec).await?;
    let mut url = azure::endpoint(spec, Service::Table)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the table URL".to_string())?
        .pop_if_empty()
        .push(&format!("Tables('{name}')"));
    let response = azure::send_table(spec, &credential, "DELETE", &url, &[], None).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(explain(&format!("delete {name}"), response).await)
    }
}

/// `.../Table(PartitionKey='p',RowKey='r')`, with the quoting the service's own syntax needs.
fn entity_url(
    spec: &RemoteHostSpec,
    table: &str,
    partition: &str,
    row: &str,
) -> Result<url::Url, String> {
    let mut url = azure::endpoint(spec, Service::Table)?;
    url.path_segments_mut()
        .map_err(|_| "Couldn't build the entity URL".to_string())?
        .pop_if_empty()
        .push(&format!(
            "{table}(PartitionKey='{}',RowKey='{}')",
            odata_quote(partition),
            odata_quote(row)
        ));
    Ok(url)
}

/// A single quote inside an OData literal is written twice — SQL's rule, not URL escaping, and
/// percent-encoding it instead produces a key that silently does not match.
fn odata_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// The union of the keys across a page, with the three the service always supplies first.
///
/// Order is what makes the grid readable: a schemaless table's columns would otherwise come out in
/// whatever order the first row happened to serialise in, and change between pages.
fn columns_of(rows: &[serde_json::Value]) -> Vec<String> {
    let mut columns: Vec<String> = vec!["PartitionKey".into(), "RowKey".into(), "Timestamp".into()];
    for row in rows {
        let Some(object) = row.as_object() else { continue };
        for key in object.keys() {
            // `odata.*` are the service's annotations, not the user's data.
            if key.starts_with("odata.") || columns.iter().any(|existing| existing == key) {
                continue;
            }
            columns.push(key.clone());
        }
    }
    columns
}

/// The Table service answers errors in JSON rather than XML, so [`super::explain`] would find
/// nothing to quote.
async fn explain(operation: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|parsed| {
            parsed["odata.error"]["message"]["value"]
                .as_str()
                .or_else(|| parsed["odata.error"]["code"].as_str())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    if detail.trim().is_empty() {
        format!("Couldn't {operation}: {status}")
    } else {
        // The service puts a request id and a timestamp after a newline in every message; the first
        // line is the sentence a human wrote.
        format!("Couldn't {operation}: {status} — {}", detail.lines().next().unwrap_or("").trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_the_union_of_the_page_with_the_keys_first() {
        let rows = vec![
            serde_json::json!({ "PartitionKey": "eu", "RowKey": "1", "Name": "a", "odata.etag": "W/\"x\"" }),
            serde_json::json!({ "PartitionKey": "eu", "RowKey": "2", "Age": 30 }),
        ];
        assert_eq!(
            columns_of(&rows),
            vec!["PartitionKey", "RowKey", "Timestamp", "Name", "Age"]
        );
    }

    /// Two entities with different shapes is the normal case here, not an error to reject.
    #[test]
    fn a_schemaless_page_keeps_every_column_it_saw() {
        let rows = vec![serde_json::json!({ "RowKey": "1", "Only": true })];
        assert!(columns_of(&rows).contains(&"Only".to_string()));
    }

    /// A key with an apostrophe in it — `O'Brien` — addresses nothing at all unless it is doubled.
    #[test]
    fn an_apostrophe_in_a_key_is_doubled_rather_than_escaped() {
        assert_eq!(odata_quote("O'Brien"), "O''Brien");
        assert_eq!(odata_quote("plain"), "plain");
    }
}
