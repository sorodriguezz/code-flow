//! Reading a CSV file into a table.
//!
//! The file is read here, in Rust, and never crosses into the webview whole: the dialog only ever
//! sees a preview ([`inspect`]), and the import streams the file record by record into batched
//! `INSERT`s. A CSV large enough to be worth importing is too large to be a JSON payload over IPC.
//!
//! Two rules keep a file exported by this app readable back into it unchanged: the **NULL rule**
//! (`src/lib/db/resultExport.ts` and `datasource::export` write NULL as an unquoted empty field and
//! the empty string as `""`, so that is how they are read), and a value's text is never reinterpreted
//! — it goes into the `INSERT` as a quoted literal through `sqlgen`, the way the grid's edits do, and
//! the server coerces it to the column's type.

use std::io::BufRead;

use serde::{Deserialize, Serialize};

use super::sqlgen;
use super::{DbCell, DbExecContext, DbNodeRef, Session, SqlDialect};

/// The separators worth trying, in the order a tie is broken.
const DELIMITERS: [char; 4] = [',', ';', '\t', '|'];

/// How many records the dialog's preview carries.
const PREVIEW_ROWS: usize = 50;

/// What the dialog shows before anything is imported.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CsvPreview {
    pub delimiter: String,
    pub has_header: bool,
    /// The first record — the header when there is one.
    pub first: Vec<Option<String>>,
    /// The records after it, up to [`PREVIEW_ROWS`].
    pub rows: Vec<Vec<Option<String>>>,
    /// The widest record seen in the sample.
    pub columns: usize,
}

/// One record: the line it started on (1-based, for the error report) and its fields.
pub type Record = (u64, Vec<Option<String>>);

/// A streaming RFC 4180 reader: quoted fields may hold the delimiter, doubled quotes and line breaks;
/// `\r\n` is one break; a BOM at the start is dropped.
pub struct CsvReader<R: BufRead> {
    input: R,
    delimiter: char,
    line: u64,
    pending: Vec<char>,
    started: bool,
}

impl<R: BufRead> CsvReader<R> {
    pub fn new(input: R, delimiter: char) -> Self {
        Self { input, delimiter, line: 0, pending: Vec::new(), started: false }
    }

    /// Reads one physical line into `pending`. `false` at the end of the file.
    fn fill(&mut self) -> Result<bool, String> {
        let mut text = String::new();
        let read = self.input.read_line(&mut text).map_err(|e| format!("couldn't read the file: {e}"))?;
        if read == 0 {
            return Ok(false);
        }
        if !self.started {
            self.started = true;
            if let Some(rest) = text.strip_prefix('\u{feff}') {
                text = rest.to_string();
            }
        }
        self.line += 1;
        self.pending = text.chars().collect();
        Ok(true)
    }

    /// The next record, skipping blank lines. `None` at the end of the file.
    pub fn next_record(&mut self) -> Result<Option<Record>, String> {
        loop {
            if !self.fill()? {
                return Ok(None);
            }
            let is_blank = self.pending.iter().all(|c| *c == '\n' || *c == '\r');
            if !is_blank {
                break;
            }
        }
        let start = self.line;
        let mut fields: Vec<Option<String>> = Vec::new();
        let mut field = String::new();
        let mut quoted = false;
        let mut in_quotes = false;
        let mut index = 0;
        loop {
            if index >= self.pending.len() {
                if in_quotes {
                    // A quoted field that runs past the end of the line holds a line break.
                    if !self.fill()? {
                        return Err(format!("line {start}: a quoted field is never closed."));
                    }
                    index = 0;
                    continue;
                }
                break;
            }
            let c = self.pending[index];
            index += 1;
            if in_quotes {
                if c == '"' {
                    if self.pending.get(index) == Some(&'"') {
                        field.push('"');
                        index += 1;
                    } else {
                        in_quotes = false;
                    }
                } else {
                    field.push(c);
                }
                continue;
            }
            match c {
                '"' if field.is_empty() && !quoted => {
                    quoted = true;
                    in_quotes = true;
                }
                '\r' if self.pending.get(index) == Some(&'\n') => {}
                '\n' | '\r' => break,
                _ if c == self.delimiter => {
                    fields.push(finish(&mut field, &mut quoted));
                }
                _ => field.push(c),
            }
        }
        fields.push(finish(&mut field, &mut quoted));
        Ok(Some((start, fields)))
    }
}

/// A finished field: an unquoted empty one is NULL, anything quoted is text.
fn finish(field: &mut String, quoted: &mut bool) -> Option<String> {
    let value = std::mem::take(field);
    let was_quoted = std::mem::replace(quoted, false);
    if value.is_empty() && !was_quoted {
        None
    } else {
        Some(value)
    }
}

/// Reads up to `limit` records from the start of `text`, split on `delimiter`.
fn sample(text: &str, delimiter: char, limit: usize) -> Vec<Vec<Option<String>>> {
    let mut reader = CsvReader::new(text.as_bytes(), delimiter);
    let mut records = Vec::new();
    while records.len() < limit {
        match reader.next_record() {
            Ok(Some((_, fields))) => records.push(fields),
            // A sample cut mid-record ends in an unclosed quote; what came before is still good.
            _ => break,
        }
    }
    records
}

/// The separator that splits the sample into the most consistent number of columns — more than
/// one of them.
///
/// Consistency first, because a European spreadsheet's `;`-separated rows are full of decimal
/// commas: `,` finds *more* fields on each line, but a different number on every line.
pub fn detect_delimiter(text: &str) -> char {
    let mut best = (',', 0.0f64, 0usize);
    for delimiter in DELIMITERS {
        let records = sample(text, delimiter, 30);
        if records.is_empty() {
            continue;
        }
        let widths: Vec<usize> = records.iter().map(Vec::len).collect();
        let mode = widths
            .iter()
            .copied()
            .max_by_key(|width| widths.iter().filter(|other| *other == width).count())
            .unwrap_or(1);
        if mode < 2 {
            continue;
        }
        let consistent = widths.iter().filter(|width| **width == mode).count() as f64 / widths.len() as f64;
        if consistent > best.1 + 1e-9 || (consistent >= best.1 - 1e-9 && mode > best.2) {
            best = (delimiter, consistent, mode);
        }
    }
    best.0
}

/// Whether the first record names the columns.
///
/// Said yes when most of it names columns the table has, and otherwise when every field is text
/// that doesn't look like a value — no numbers, no dates — while some column below holds numbers.
/// The dialog shows the guess as a checkbox; this only has to be right most of the time.
pub fn looks_like_header(first: &[Option<String>], rest: &[Vec<Option<String>>], table_columns: &[String]) -> bool {
    let names: Vec<String> = first.iter().map(|field| normalize(field.as_deref().unwrap_or(""))).collect();
    let known = names
        .iter()
        .filter(|name| !name.is_empty() && table_columns.iter().any(|column| normalize(column) == **name))
        .count();
    if !names.is_empty() && known * 2 >= names.len() {
        return true;
    }
    let numeric = |text: &str| {
        let text = text.trim();
        !text.is_empty() && (text.parse::<f64>().is_ok() || looks_like_date(text))
    };
    let all_labels = first
        .iter()
        .all(|field| field.as_deref().is_some_and(|text| !text.trim().is_empty() && !numeric(text)));
    if !all_labels {
        return false;
    }
    (0..first.len()).any(|column| {
        rest.iter()
            .filter_map(|row| row.get(column).cloned().flatten())
            .any(|value| numeric(&value))
    })
}

fn looks_like_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 8 && bytes[..4].iter().all(u8::is_ascii_digit) && matches!(bytes[4], b'-' | b'/')
}

/// A column name as the matcher compares it: lower case, without the separators people vary.
pub fn normalize(name: &str) -> String {
    name.trim().to_lowercase().chars().filter(|c| !matches!(c, '_' | ' ' | '-')).collect()
}

/// What the dialog shows: the separator, the header guess and the first records.
///
/// `delimiter` is the user's choice when they made one; otherwise it is detected. Only the start of
/// the file is read.
pub fn inspect(path: &str, delimiter: Option<char>, table_columns: &[String]) -> Result<CsvPreview, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut head = Vec::new();
    file.take(256 * 1024).read_to_end(&mut head).map_err(|e| format!("{path}: {e}"))?;
    let text = String::from_utf8_lossy(&head).into_owned();
    let delimiter = delimiter.unwrap_or_else(|| detect_delimiter(&text));
    let mut records = sample(&text, delimiter, PREVIEW_ROWS + 1);
    if records.is_empty() {
        return Err("That file has no rows.".to_string());
    }
    let first = records.remove(0);
    let columns = records.iter().map(Vec::len).chain([first.len()]).max().unwrap_or(0);
    Ok(CsvPreview {
        delimiter: delimiter.to_string(),
        has_header: looks_like_header(&first, &records, table_columns),
        first,
        rows: records,
        columns,
    })
}

/// A multi-row `INSERT` for one batch: `INSERT INTO t (a, b) VALUES (…), (…)`.
///
/// Each value goes through `sqlgen`'s literal rules for its column — the same path, and the same
/// safety, as a cell edited in the grid. `types` are the target columns' types, which decide how a
/// binary value is written back.
pub fn insert_statement(
    node: &DbNodeRef,
    dialect: SqlDialect,
    columns: &[String],
    types: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<String, String> {
    let target = sqlgen::qualify(node, dialect)?;
    let names: Vec<String> = columns.iter().map(|column| sqlgen::quote_ident(column, dialect)).collect();
    let mut tuples = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let cell = DbCell {
                column: column.clone(),
                value: row.get(index).cloned().flatten(),
                type_name: types.get(index).cloned().unwrap_or_default(),
            };
            values.push(sqlgen::cell_literal(&cell, dialect)?);
        }
        tuples.push(format!("({})", values.join(", ")));
    }
    Ok(format!("INSERT INTO {target} ({}) VALUES {}", names.join(", "), tuples.join(", ")))
}

/// Whether an engine takes several rows in one `VALUES`. IRIS and Oracle don't (Oracle's `INSERT
/// ALL` is a different statement), so they get one row per statement.
pub fn multi_row_values(dialect: SqlDialect) -> bool {
    !matches!(dialect, SqlDialect::Iris | SqlDialect::Oracle)
}

/// The engine's savepoint statements, for rolling back one batch without losing the rest: set, roll
/// back to, and release (`None` where the engine has no release).
pub fn savepoint_statements(dialect: SqlDialect) -> (&'static str, &'static str, Option<&'static str>) {
    match dialect {
        SqlDialect::TSql => ("SAVE TRANSACTION cf_import", "ROLLBACK TRANSACTION cf_import", None),
        SqlDialect::Oracle | SqlDialect::Iris => {
            ("SAVEPOINT cf_import", "ROLLBACK TO SAVEPOINT cf_import", None)
        }
        _ => ("SAVEPOINT cf_import", "ROLLBACK TO SAVEPOINT cf_import", Some("RELEASE SAVEPOINT cf_import")),
    }
}

/// How the engine opens a transaction. `None` for the JVM engines, whose transaction is the JDBC
/// connection's autocommit being off.
pub fn begin_statement(dialect: SqlDialect) -> Option<&'static str> {
    match dialect {
        SqlDialect::TSql => Some("BEGIN TRANSACTION"),
        SqlDialect::MySql { .. } => Some("START TRANSACTION"),
        SqlDialect::Oracle | SqlDialect::Iris => None,
        _ => Some("BEGIN"),
    }
}

/// What to import, as the dialog settled it.
#[derive(Debug, Clone, Deserialize)]
pub struct ImportRequest {
    pub node: DbNodeRef,
    pub path: String,
    pub delimiter: String,
    pub has_header: bool,
    /// Per CSV column, the table column it goes into — `None` leaves that column out.
    pub mapping: Vec<Option<String>>,
    /// The target columns' types, in the same order as `mapping`: what decides how a binary value
    /// is written back (see `sqlgen::cell_literal`).
    #[serde(default)]
    pub types: Vec<String>,
    /// Keep the rows that went in even when some failed. Off, one failure rolls the whole import
    /// back — the default, because a table left holding "most of the file" is a table nobody can
    /// reason about.
    #[serde(default)]
    pub skip_errors: bool,
}

/// One row that didn't go in: the line it starts on, and what the server said.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportFailure {
    pub line: u64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    /// Rows written — and kept only when `committed`.
    pub inserted: u64,
    pub failures: Vec<ImportFailure>,
    /// Whether the transaction was committed: every row went in, or failures were being skipped.
    pub committed: bool,
    /// Data rows read from the file, header excluded.
    pub read: u64,
    /// The report stopped listing failures at [`MAX_FAILURES`] and the import stopped reading.
    pub failures_truncated: bool,
}

/// Rows per `INSERT`. SQL Server takes at most 1000 in one `VALUES`; a few hundred keeps each
/// statement a size every engine's parser is comfortable with.
const BATCH: usize = 200;

/// How many failures are worth listing before the import gives up reading the rest of the file.
pub const MAX_FAILURES: usize = 200;

/// Imports a CSV file into a table, in one transaction.
///
/// Rows go in batches — one multi-row `INSERT` where the engine takes it, each under a savepoint.
/// A batch that fails is rolled back to its savepoint and replayed a row at a time, each row under
/// its own savepoint, so a bad row is found and *named* (by its line in the file) while the good
/// ones around it still go in. At the end the transaction commits when nothing failed or when
/// failures were being skipped, and rolls back otherwise.
///
/// `session` is the import's own, never a registry session: cancelling closes it, and closing a
/// connection mid-transaction is how every engine here is told to roll it back.
pub async fn run(
    session: &Session,
    dialect: SqlDialect,
    request: &ImportRequest,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<ImportOutcome, String> {
    let delimiter = request.delimiter.chars().next().unwrap_or(',');
    let targets: Vec<(usize, String, String)> = request
        .mapping
        .iter()
        .enumerate()
        .filter_map(|(index, target)| {
            let name = target.as_deref()?.trim();
            (!name.is_empty()).then(|| (index, name.to_string(), request.types.get(index).cloned().unwrap_or_default()))
        })
        .collect();
    if targets.is_empty() {
        return Err("Choose a table column for at least one column of the file.".to_string());
    }
    for (position, (_, name, _)) in targets.iter().enumerate() {
        if targets[..position].iter().any(|(_, other, _)| other.eq_ignore_ascii_case(name)) {
            return Err(format!("Two columns of the file go into {name}. Each table column can take one."));
        }
    }
    let columns: Vec<String> = targets.iter().map(|(_, name, _)| name.clone()).collect();
    let types: Vec<String> = targets.iter().map(|(_, _, kind)| kind.clone()).collect();

    let file = std::fs::File::open(&request.path).map_err(|e| format!("{}: {e}", request.path))?;
    let mut reader = CsvReader::new(std::io::BufReader::new(file), delimiter);
    if request.has_header {
        reader.next_record()?;
    }

    let ctx = DbExecContext { database: None, schema: None, max_rows: 0 };
    let exec = |sql: String| {
        let ctx = ctx.clone();
        async move {
            let result = session.execute(&sql, &ctx).await?;
            match result.results.into_iter().find_map(|statement| statement.error) {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    };

    session.set_autocommit(false).await?;
    if let Some(begin) = begin_statement(dialect) {
        if let Err(error) = exec(begin.to_string()).await {
            let _ = session.set_autocommit(true).await;
            return Err(error);
        }
    }

    let mut outcome =
        ImportOutcome { inserted: 0, failures: Vec::new(), committed: false, read: 0, failures_truncated: false };
    let body = async {
        let (set_point, back_to_point, release_point) = savepoint_statements(dialect);
        let width = request.mapping.len();
        let mut batch: Vec<Record> = Vec::with_capacity(BATCH);
        let mut done = false;
        while !done {
            match reader.next_record() {
                Ok(Some((line, fields))) => {
                    outcome.read += 1;
                    if fields.len() != width {
                        outcome.failures.push(ImportFailure {
                            line,
                            error: format!("has {} fields; the file's other rows have {width}.", fields.len()),
                        });
                    } else {
                        let row = targets.iter().map(|(index, _, _)| fields.get(*index).cloned().flatten()).collect();
                        batch.push((line, row));
                    }
                }
                Ok(None) => done = true,
                // A malformed file (an unclosed quote) can't be read past; everything before it can.
                Err(error) => {
                    outcome.failures.push(ImportFailure { line: reader.line, error });
                    done = true;
                }
            }
            if batch.len() < BATCH && !(done && !batch.is_empty()) {
                if outcome.failures.len() >= MAX_FAILURES {
                    outcome.failures_truncated = true;
                    break;
                }
                continue;
            }

            // The fast path: the whole batch under one savepoint.
            exec(set_point.to_string()).await?;
            let rows: Vec<Vec<Option<String>>> = batch.iter().map(|(_, row)| row.clone()).collect();
            let fast = if multi_row_values(dialect) {
                exec(insert_statement(&request.node, dialect, &columns, &types, &rows)?).await
            } else {
                let mut all = Ok(());
                for row in &rows {
                    all = exec(insert_statement(&request.node, dialect, &columns, &types, std::slice::from_ref(row))?).await;
                    if all.is_err() {
                        break;
                    }
                }
                all
            };
            match fast {
                Ok(()) => {
                    if let Some(release) = release_point {
                        exec(release.to_string()).await?;
                    }
                    outcome.inserted += batch.len() as u64;
                }
                Err(_) => {
                    // Something in the batch failed: undo it and find out which rows, one at a time.
                    exec(back_to_point.to_string()).await?;
                    for (line, row) in &batch {
                        exec(set_point.to_string()).await?;
                        let single = insert_statement(&request.node, dialect, &columns, &types, std::slice::from_ref(row))?;
                        match exec(single).await {
                            Ok(()) => {
                                if let Some(release) = release_point {
                                    exec(release.to_string()).await?;
                                }
                                outcome.inserted += 1;
                            }
                            Err(error) => {
                                exec(back_to_point.to_string()).await?;
                                outcome.failures.push(ImportFailure { line: *line, error });
                            }
                        }
                    }
                }
            }
            batch.clear();
            progress(outcome.inserted);
            if outcome.failures.len() >= MAX_FAILURES {
                outcome.failures_truncated = true;
                break;
            }
        }
        Ok::<(), String>(())
    }
    .await;

    let keep = body.is_ok() && (outcome.failures.is_empty() || request.skip_errors);
    let end = exec(if keep { "COMMIT" } else { "ROLLBACK" }.to_string()).await;
    let _ = session.set_autocommit(true).await;
    body?;
    end?;
    outcome.committed = keep;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::DbNodeKind;

    fn records(text: &str, delimiter: char) -> Vec<Record> {
        let mut reader = CsvReader::new(text.as_bytes(), delimiter);
        let mut out = Vec::new();
        while let Some(record) = reader.next_record().unwrap() {
            out.push(record);
        }
        out
    }

    fn s(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    /// The export's NULL rule, read back: unquoted empty is NULL, `""` is the empty string.
    #[test]
    fn an_exported_file_reads_back_with_null_and_empty_apart() {
        let read = records("id,note\n1,\n2,\"\"\n", ',');
        assert_eq!(read[1].1, vec![s("1"), None]);
        assert_eq!(read[2].1, vec![s("2"), s("")]);
    }

    #[test]
    fn quoted_fields_keep_delimiters_quotes_and_line_breaks() {
        let read = records("a,b\r\n\"x,y\",\"say \"\"hi\"\"\"\n\"two\nlines\",z\n", ',');
        assert_eq!(read.len(), 3);
        assert_eq!(read[1].1, vec![s("x,y"), s("say \"hi\"")]);
        assert_eq!(read[2].1, vec![s("two\nlines"), s("z")]);
        // The record's own line, for the error report — not the line it ended on.
        assert_eq!(read[2].0, 3);
    }

    #[test]
    fn a_bom_and_blank_lines_are_not_data() {
        let read = records("\u{feff}id;name\n\n1;Ana\n", ';');
        assert_eq!(read[0].1, vec![s("id"), s("name")]);
        assert_eq!(read[1].1, vec![s("1"), s("Ana")]);
        assert_eq!(read[1].0, 3);
    }

    #[test]
    fn an_unclosed_quote_is_an_error_naming_its_line() {
        let mut reader = CsvReader::new("a\n\"open\n".as_bytes(), ',');
        reader.next_record().unwrap();
        let error = reader.next_record().unwrap_err();
        assert!(error.contains("line 2"), "{error}");
    }

    #[test]
    fn the_delimiter_is_the_one_that_splits_consistently() {
        assert_eq!(detect_delimiter("nombre;precio;cantidad\nmanzana;1,5;10\npera;2,25;3\n"), ';');
        assert_eq!(detect_delimiter("id,city\n1,\"Santiago; Chile\"\n2,\"Lima; Peru\"\n"), ',');
        assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3\n"), '\t');
        assert_eq!(detect_delimiter("a|b\n1|2\n"), '|');
    }

    #[test]
    fn a_header_is_recognised_by_its_names_or_by_its_shape() {
        let columns = vec!["id".to_string(), "full_name".to_string()];
        assert!(looks_like_header(&[s("ID"), s("Full Name")], &[], &columns));
        assert!(looks_like_header(&[s("sku"), s("price")], &[vec![s("A1"), s("9.99")]], &[]));
        assert!(!looks_like_header(&[s("1"), s("Ana")], &[vec![s("2"), s("Luis")]], &columns));
        assert!(!looks_like_header(&[s("red"), s("blue")], &[vec![s("green"), s("pink")]], &[]));
    }

    fn table() -> DbNodeRef {
        DbNodeRef {
            kind: DbNodeKind::Table,
            database: Some("app".into()),
            schema: Some("public".into()),
            name: Some("people".into()),
        }
    }

    /// Values go through the same literal rules as a grid edit — a quote can't end its literal.
    #[test]
    fn a_batch_becomes_one_safe_insert() {
        let sql = insert_statement(
            &table(),
            SqlDialect::Postgres,
            &["id".into(), "name".into()],
            &["integer".into(), "text".into()],
            &[vec![s("1"), s("O'Brien")], vec![s("2"), None]],
        )
        .unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"public\".\"people\" (\"id\", \"name\") VALUES ('1', 'O''Brien'), ('2', NULL)"
        );
        let mysql = SqlDialect::MySql { backslash_escapes: true };
        let sql = insert_statement(&table(), mysql, &["name".into()], &[String::new()], &[vec![s("a\\")]]).unwrap();
        assert!(sql.ends_with("VALUES ('a\\\\')"), "{sql}");
    }

    /// A SQLite file is a real engine in-process, so the whole import — transaction, savepoints,
    /// the per-row replay and the report — is exercised here without a server.
    #[tokio::test]
    async fn an_import_goes_in_whole_or_not_at_all_and_names_its_bad_rows() {
        let dir = std::env::temp_dir().join(format!("cf-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("app.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)")
            .unwrap();
        let csv = dir.join("people.csv");
        // Line 4 has no name, which the table refuses; line 5 has one field too many.
        std::fs::write(&csv, "id,name,note\n1,Ana,\n2,Luis,\"\"\n3,,x\n4,Eva,y,extra\n5,Rosa,z\n").unwrap();

        let mut config = crate::datasource::tests_support::config(crate::datasource::DbKind::Sqlite);
        config.host = String::new();
        config.database = db.to_string_lossy().into_owned();
        let session = Session::open(&config, None).await.unwrap();
        let node = DbNodeRef {
            kind: DbNodeKind::Table,
            database: Some("app.db".into()),
            schema: Some("main".into()),
            name: Some("people".into()),
        };
        let mut request = ImportRequest {
            node,
            path: csv.to_string_lossy().into_owned(),
            delimiter: ",".into(),
            has_header: true,
            mapping: vec![Some("id".into()), Some("name".into()), Some("note".into())],
            types: Vec::new(),
            skip_errors: false,
        };
        async fn count(session: &Session) -> String {
            let ctx = DbExecContext { database: None, schema: None, max_rows: 10 };
            let run = session.execute("SELECT COUNT(*) FROM people", &ctx).await.unwrap();
            run.results[0].rows[0][0].clone().unwrap()
        }

        let mut seen = Vec::new();
        let outcome = run(&session, SqlDialect::Sqlite, &request, &mut |n| seen.push(n)).await.unwrap();
        assert!(!outcome.committed);
        assert_eq!(outcome.read, 5);
        assert_eq!(outcome.failures.iter().map(|f| f.line).collect::<Vec<_>>(), vec![5, 4]);
        assert!(outcome.failures.iter().any(|f| f.error.contains("NOT NULL")), "{:?}", outcome.failures);
        assert_eq!(count(&session).await, "0", "nothing is kept when a row failed");

        request.skip_errors = true;
        let outcome = run(&session, SqlDialect::Sqlite, &request, &mut |_| {}).await.unwrap();
        assert!(outcome.committed);
        assert_eq!(outcome.inserted, 3);
        assert_eq!(count(&session).await, "3");
        // The NULL rule survived the trip: an unquoted empty field is NULL, `""` is the empty string.
        let ctx = DbExecContext { database: None, schema: None, max_rows: 10 };
        let notes = session.execute("SELECT note IS NULL, note FROM people ORDER BY id", &ctx).await.unwrap();
        assert_eq!(notes.results[0].rows[0][0].as_deref(), Some("1"));
        assert_eq!(notes.results[0].rows[1][1].as_deref(), Some(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_engine_gets_its_own_transaction_words() {
        assert_eq!(begin_statement(SqlDialect::TSql), Some("BEGIN TRANSACTION"));
        assert_eq!(begin_statement(SqlDialect::Oracle), None);
        assert_eq!(savepoint_statements(SqlDialect::TSql).2, None);
        assert_eq!(savepoint_statements(SqlDialect::Postgres).2, Some("RELEASE SAVEPOINT cf_import"));
        assert!(!multi_row_values(SqlDialect::Iris));
        assert!(multi_row_values(SqlDialect::Sqlite));
    }
}
