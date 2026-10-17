//! Spreadsheets and JSON on the way in and out of the database workspace.
//!
//! **Out:** a result as an `.xlsx`, typed where the text is plainly a number so a sum works in
//! Excel, and with NULL left as an empty cell (a spreadsheet has no other way to say it).
//!
//! **In:** the import is CSV-shaped from end to end — preview, column mapping, batches, savepoints —
//! and none of that cares where the rows came from. So a workbook's first sheet, or a JSON array,
//! is written out as a CSV in the temp directory and the import reads that. One import path, with
//! every rule it already has (NULL vs `""`, failures by line, all-or-nothing), instead of three.

use std::path::{Path, PathBuf};

use super::DbColumn;

/// The workbook bytes for a result.
pub fn rows_to_xlsx(columns: &[DbColumn], rows: &[Vec<Option<String>>]) -> Result<Vec<u8>, String> {
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook.add_worksheet();
    let bold = rust_xlsxwriter::Format::new().set_bold();
    for (col, column) in columns.iter().enumerate() {
        sheet.write_string_with_format(0, col as u16, &column.name, &bold).map_err(|e| e.to_string())?;
    }
    let numeric: Vec<bool> = columns.iter().map(|column| is_numeric_type(&column.type_name)).collect();
    for (index, row) in rows.iter().enumerate() {
        let r = index as u32 + 1;
        for (col, cell) in row.iter().enumerate() {
            let Some(text) = cell else { continue };
            let c = col as u16;
            // Only a numeric column's numbers become numbers: a zero-padded code in a text column
            // (`007`, a phone number) must stay the text it is.
            match text.parse::<f64>() {
                Ok(value) if numeric.get(col).copied().unwrap_or(false) && value.is_finite() => {
                    sheet.write_number(r, c, value).map_err(|e| e.to_string())?;
                }
                _ => {
                    sheet.write_string(r, c, text).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    workbook.save_to_buffer().map_err(|e| e.to_string())
}

fn is_numeric_type(type_name: &str) -> bool {
    let lower = type_name.to_ascii_lowercase();
    [
        "int", "numeric", "decimal", "float", "double", "real", "money", "number", "serial", "bigint", "smallint",
        "tinyint",
    ]
    .iter()
    .any(|word| lower.contains(word))
        && !lower.contains("interval")
        && !lower.contains("point")
}

/// What kind of file an import path is, by extension.
fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => Some("sheet"),
        "json" => Some("json"),
        _ => None,
    }
}

/// The CSV the import should read for `path`: `path` itself for a CSV, or a converted copy in the
/// temp directory for a workbook or a JSON file. The copy is named after the source's path and
/// modification time, so the preview and the import that follows it read the same conversion.
pub fn csv_source(path: &str) -> Result<String, String> {
    let source = Path::new(path);
    let Some(kind) = kind_of(source) else { return Ok(path.to_string()) };
    let target = converted_path(source)?;
    if target.exists() {
        return Ok(target.display().to_string());
    }
    let records = match kind {
        "sheet" => read_sheet(source)?,
        _ => read_json(source)?,
    };
    let mut text = String::new();
    for record in records {
        let line: Vec<String> = record.iter().map(|cell| csv_field(cell.as_deref())).collect();
        text.push_str(&line.join(","));
        text.push('\n');
    }
    std::fs::write(&target, text).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(target.display().to_string())
}

fn converted_path(source: &Path) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let modified = std::fs::metadata(source)
        .and_then(|meta| meta.modified())
        .map_err(|e| format!("{}: {e}", source.display()))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    modified.hash(&mut hasher);
    let dir = std::env::temp_dir().join("codeflow-import");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(format!("{:016x}.csv", hasher.finish())))
}

/// The CSV convention the importer reads: an unquoted empty field is NULL, `""` is an empty string.
fn csv_field(value: Option<&str>) -> String {
    match value {
        None => String::new(),
        Some(text) => format!("\"{}\"", text.replace('"', "\"\"")),
    }
}

fn read_sheet(path: &Path) -> Result<Vec<Vec<Option<String>>>, String> {
    use calamine::{Data, Reader};
    crate::flows::nodes::data::check_workbook(path)?;
    let mut workbook =
        calamine::open_workbook_auto(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let name = workbook.sheet_names().first().cloned().ok_or_else(|| "The workbook has no sheets".to_string())?;
    let range = workbook.worksheet_range(&name).map_err(|e| format!("Could not read the sheet “{name}”: {e}"))?;
    Ok(range
        .rows()
        .filter(|row| row.iter().any(|cell| !matches!(cell, Data::Empty)))
        .map(|row| {
            row.iter()
                .map(|cell| match cell {
                    Data::Empty => None,
                    Data::String(text) => Some(text.clone()),
                    Data::Int(n) => Some(n.to_string()),
                    Data::Float(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Some((*f as i64).to_string()),
                    Data::Float(f) => Some(f.to_string()),
                    Data::Bool(b) => Some(b.to_string()),
                    Data::DateTime(date) => Some(
                        date.as_datetime()
                            .map_or_else(|| date.as_f64().to_string(), |dt| dt.format("%Y-%m-%d %H:%M:%S").to_string()),
                    ),
                    Data::DateTimeIso(text) | Data::DurationIso(text) => Some(text.clone()),
                    Data::Error(error) => Some(format!("#{error:?}")),
                })
                .collect()
        })
        .collect())
}

/// A JSON array of objects (one row each, columns in the order keys first appear, header row
/// written) or of arrays (rows as they are, no header).
fn read_json(path: &Path) -> Result<Vec<Vec<Option<String>>>, String> {
    use serde_json::Value;
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    let items = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => return Err("A JSON import needs an array of objects or of arrays.".to_string()),
    };
    let cell = |value: &Value| match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    };
    if items.iter().all(Value::is_array) {
        return Ok(items.iter().map(|row| row.as_array().map(|r| r.iter().map(cell).collect()).unwrap_or_default()).collect());
    }
    let mut keys: Vec<String> = Vec::new();
    for item in &items {
        let Some(object) = item.as_object() else {
            return Err("Every element of the JSON array has to be an object (or every one an array).".to_string());
        };
        for key in object.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    let mut rows = vec![keys.iter().map(|key| Some(key.clone())).collect::<Vec<_>>()];
    for item in &items {
        let object = item.as_object().expect("checked above");
        rows.push(keys.iter().map(|key| object.get(key).and_then(cell)).collect());
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_array_of_objects_becomes_a_header_and_rows() {
        let dir = std::env::temp_dir().join(format!("cf-tabular-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rows.json");
        std::fs::write(&path, r#"[{"id":1,"name":"a"},{"id":2,"note":null,"name":"b\"c"}]"#).unwrap();
        let rows = read_json(&path).unwrap();
        assert_eq!(rows[0], vec![Some("id".into()), Some("name".into()), Some("note".into())]);
        assert_eq!(rows[2], vec![Some("2".into()), Some("b\"c".into()), None]);
        let csv = csv_source(path.to_str().unwrap()).unwrap();
        let text = std::fs::read_to_string(csv).unwrap();
        assert!(text.contains("\"2\",\"b\"\"c\",\n"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_csv_is_read_where_it_is() {
        assert_eq!(csv_source("/tmp/x.csv").unwrap(), "/tmp/x.csv");
    }

    #[test]
    fn only_numeric_columns_write_numbers() {
        assert!(is_numeric_type("int4"));
        assert!(is_numeric_type("NUMERIC(10,2)"));
        assert!(!is_numeric_type("varchar"));
        assert!(!is_numeric_type("interval"));
        let bytes = rows_to_xlsx(
            &[DbColumn::new("id", "int4"), DbColumn::new("code", "text")],
            &[vec![Some("1".into()), Some("007".into())], vec![None, None]],
        )
        .unwrap();
        assert!(bytes.starts_with(b"PK"));
    }
}
