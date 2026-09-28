//! Writing a whole result to a file, row by row, as the driver reads it.
//!
//! The grid's own export writes what is on screen — one page — and for most of what people export
//! that is the wrong answer: "give me this table as CSV" means all of it. The rows cannot come
//! through the webview for that (a million rows is a heap the renderer should never hold, and a
//! JSON payload across IPC the size of the table), so they go straight from the driver to disk here.
//!
//! The encoding rules are `src/lib/db/resultExport.ts`'s, deliberately the same, because a file
//! exported from a page and one exported whole must read back identically: **NULL and the empty
//! string never collapse** — CSV writes NULL as an unquoted empty field and `""` as a quoted one;
//! JSON writes `null` and `""`.

use std::io::Write;

use super::DbColumn;

/// Where rows go. Sync on purpose: a buffered file write is a memcpy, and every driver's read loop
/// can call it between two awaits without the sink having to be a future itself.
pub trait RowSink: Send {
    fn columns(&mut self, columns: &[DbColumn]) -> Result<(), String>;
    fn row(&mut self, row: &[Option<String>]) -> Result<(), String>;
    /// A whole document as JSON text — MongoDB's, whose nesting a column list would flatten.
    fn document(&mut self, _json: &str, row: &[Option<String>]) -> Result<(), String> {
        self.row(row)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Json,
}

impl ExportFormat {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            other => Err(format!("{other} isn't a format rows can be exported to. Use CSV or JSON.")),
        }
    }
}

/// Encodes rows into any writer, counting them and reporting progress as it goes.
pub struct ExportWriter<W: Write + Send> {
    out: W,
    format: ExportFormat,
    /// JSON keys, made unique: `SELECT a.id, b.id` would otherwise write one `id` over the other.
    keys: Vec<String>,
    header_written: bool,
    rows: u64,
    progress: Box<dyn FnMut(u64) + Send>,
}

/// How often progress is reported, in rows. Often enough for a counter to move, rare enough that the
/// event channel is not the bottleneck.
const PROGRESS_EVERY: u64 = 2_000;

impl<W: Write + Send> ExportWriter<W> {
    pub fn new(out: W, format: ExportFormat, progress: Box<dyn FnMut(u64) + Send>) -> Self {
        Self { out, format, keys: Vec::new(), header_written: false, rows: 0, progress }
    }

    /// Closes the document — the JSON array's bracket — and flushes. Called once, after the last row.
    pub fn finish(mut self) -> Result<u64, String> {
        if self.format == ExportFormat::Json {
            let close = if self.rows == 0 { "[]\n" } else { "\n]\n" };
            // An export with no columns at all never opened its array.
            let text = if self.header_written { close.trim_start_matches('[') } else { "[]\n" };
            self.write(text)?;
        }
        self.out.flush().map_err(|e| format!("couldn't finish writing the file: {e}"))?;
        (self.progress)(self.rows);
        Ok(self.rows)
    }

    fn write(&mut self, text: &str) -> Result<(), String> {
        self.out.write_all(text.as_bytes()).map_err(|e| format!("couldn't write the file: {e}"))
    }

    fn counted(&mut self) {
        self.rows += 1;
        if self.rows % PROGRESS_EVERY == 0 {
            (self.progress)(self.rows);
        }
    }
}

impl<W: Write + Send> RowSink for ExportWriter<W> {
    fn columns(&mut self, columns: &[DbColumn]) -> Result<(), String> {
        // Only the first result set's columns count; a second call is the same shape re-announced.
        if self.header_written {
            return Ok(());
        }
        self.header_written = true;
        match self.format {
            ExportFormat::Csv => {
                let line = columns.iter().map(|c| csv_field(Some(&c.name))).collect::<Vec<_>>().join(",");
                self.write(&format!("{line}\n"))
            }
            ExportFormat::Json => {
                self.keys = unique_keys(columns);
                self.write("[")
            }
        }
    }

    fn row(&mut self, row: &[Option<String>]) -> Result<(), String> {
        let text = match self.format {
            ExportFormat::Csv => {
                format!("{}\n", row.iter().map(|cell| csv_field(cell.as_deref())).collect::<Vec<_>>().join(","))
            }
            ExportFormat::Json => {
                let mut object = String::from("{");
                for (index, key) in self.keys.iter().enumerate() {
                    if index > 0 {
                        object.push_str(", ");
                    }
                    object.push_str(&json_string(key));
                    object.push_str(": ");
                    match row.get(index).cloned().flatten() {
                        Some(value) => object.push_str(&json_string(&value)),
                        None => object.push_str("null"),
                    }
                }
                object.push('}');
                format!("{}\n  {object}", if self.rows == 0 { "" } else { "," })
            }
        };
        self.write(&text)?;
        self.counted();
        Ok(())
    }

    fn document(&mut self, json: &str, row: &[Option<String>]) -> Result<(), String> {
        if self.format == ExportFormat::Csv {
            return self.row(row);
        }
        let text = format!("{}\n  {}", if self.rows == 0 { "" } else { "," }, json.trim());
        self.write(&text)?;
        self.counted();
        Ok(())
    }
}

/// RFC 4180, with the one extension CSV needs to carry both NULL and `""`: an unquoted empty field
/// is NULL, a quoted one is the empty string.
pub fn csv_field(value: Option<&str>) -> String {
    match value {
        None => String::new(),
        Some("") => "\"\"".to_string(),
        Some(text) if text.contains([',', '"', '\n', '\r']) => format!("\"{}\"", text.replace('"', "\"\"")),
        Some(text) => text.to_string(),
    }
}

fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// Column names as JSON keys, with repeats numbered rather than overwritten.
fn unique_keys(columns: &[DbColumn]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(columns.len());
    for column in columns {
        let mut key = column.name.clone();
        let mut n = 2;
        while keys.contains(&key) {
            key = format!("{} ({n})", column.name);
            n += 1;
        }
        keys.push(key);
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn columns(names: &[&str]) -> Vec<DbColumn> {
        names.iter().map(|name| DbColumn::new(*name, "")).collect()
    }

    fn write_all(format: ExportFormat, cols: &[&str], rows: &[Vec<Option<&str>>]) -> String {
        let mut buffer = Vec::new();
        {
            let mut writer = ExportWriter::new(&mut buffer, format, Box::new(|_| {}));
            writer.columns(&columns(cols)).unwrap();
            for row in rows {
                let row: Vec<Option<String>> = row.iter().map(|cell| cell.map(str::to_string)).collect();
                writer.row(&row).unwrap();
            }
            writer.finish().unwrap();
        }
        String::from_utf8(buffer).unwrap()
    }

    /// The rule the whole format hangs on, and the one `resultExport.ts` follows too.
    #[test]
    fn csv_keeps_null_and_the_empty_string_apart() {
        let csv = write_all(ExportFormat::Csv, &["id", "note"], &[vec![Some("1"), None], vec![Some("2"), Some("")]]);
        assert_eq!(csv, "id,note\n1,\n2,\"\"\n");
    }

    #[test]
    fn csv_quotes_what_would_break_a_line() {
        assert_eq!(csv_field(Some("a,b")), "\"a,b\"");
        assert_eq!(csv_field(Some("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field(Some("two\nlines")), "\"two\nlines\"");
        assert_eq!(csv_field(Some("plain")), "plain");
    }

    #[test]
    fn json_writes_nulls_as_null_and_numbers_its_repeated_columns() {
        let json = write_all(ExportFormat::Json, &["id", "id", "name"], &[vec![Some("1"), Some("7"), None]]);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect(&json);
        assert_eq!(parsed[0]["id"], "1");
        assert_eq!(parsed[0]["id (2)"], "7");
        assert!(parsed[0]["name"].is_null());
    }

    #[test]
    fn an_empty_result_is_still_a_valid_file() {
        let json = write_all(ExportFormat::Json, &["id"], &[]);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&json).unwrap(), serde_json::json!([]));
        assert_eq!(write_all(ExportFormat::Csv, &["id"], &[]), "id\n");
    }

    #[test]
    fn documents_keep_their_own_json_and_progress_is_reported() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let mut buffer = Vec::new();
        {
            let mut writer =
                ExportWriter::new(&mut buffer, ExportFormat::Json, Box::new(move |n| log.lock().unwrap().push(n)));
            writer.columns(&columns(&["_id"])).unwrap();
            writer.document("{\"_id\": 1, \"a\": {\"b\": [1, 2]}}", &[Some("1".into())]).unwrap();
            assert_eq!(writer.finish().unwrap(), 1);
        }
        let parsed: serde_json::Value = serde_json::from_slice(&buffer).unwrap();
        assert_eq!(parsed[0]["a"]["b"][1], 2);
        assert_eq!(*seen.lock().unwrap(), vec![1]);
    }
}
