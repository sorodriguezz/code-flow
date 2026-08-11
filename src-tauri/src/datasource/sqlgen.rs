//! Identifier quoting, paging and the DML the data editor generates.
//!
//! One module for all three SQL dialects because the *shape* of these statements is identical and
//! only the punctuation differs — writing them out per driver would be three copies of the same
//! `UPDATE … WHERE` with the brackets changed, and the day one copy gained a fix the others
//! wouldn't.
//!
//! **On literals.** The generated DML interpolates values as quoted literals rather than binding
//! parameters, and every statement it produces is shown to the user before it runs. Two reasons.
//! One is that the engines here have no parameter channel in the paths this driver layer uses —
//! IRIS arrives as a REST payload and Postgres/T-SQL go through the simple query protocol, chosen
//! so that values come back as the server's own text (see `datasource::mod`). The other is that a
//! data editor which shows you SQL and then sends something else is a data editor you can't check.
//!
//! That makes [`quote_literal`] the most safety-critical function in this module. It doubles every
//! quote and refuses a value carrying a NUL byte, the one character no dialect can escape inside a
//! literal. Its test is the one to keep passing.

use super::{DbCell, DbNodeRef, DbRowEdit, DbRowEditKind, DbSortKey, SqlDialect};

/// Wraps an identifier so a name that is a keyword, mixed-case or contains a space still resolves.
///
/// Postgres and IRIS use `"…"`; T-SQL uses `[…]`. In each, the closer is escaped by doubling it.
pub fn quote_ident(name: &str, dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::TSql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// A value as a SQL literal. `None` becomes the keyword `NULL`, never the string `'NULL'`.
///
/// Numbers and booleans are still emitted quoted and left to the engine to coerce: `'42'` into an
/// integer column is fine everywhere here, while trying to decide *which* values are safe to emit
/// bare would mean re-implementing three type systems.
pub fn quote_literal(value: Option<&str>) -> Result<String, String> {
    let Some(value) = value else { return Ok("NULL".to_string()) };
    if value.contains('\0') {
        return Err(
            "A value contains a NUL byte, which no SQL literal can carry. Remove it, or write the \
             row with an explicit statement in the console."
                .to_string(),
        );
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

/// `schema.table`, both quoted, with the schema left off when there isn't one.
pub fn qualify(node: &DbNodeRef, dialect: SqlDialect) -> Result<String, String> {
    let name = node.name()?;
    Ok(match node.schema() {
        Some(schema) => format!("{}.{}", quote_ident(schema, dialect), quote_ident(name, dialect)),
        None => quote_ident(name, dialect),
    })
}

/// `SELECT * FROM t [WHERE …] [ORDER BY …]` plus one page of rows.
///
/// The page is expressed the way each dialect can: `LIMIT/OFFSET` for Postgres, `OFFSET … FETCH
/// NEXT` for T-SQL (which needs an `ORDER BY` to be legal, so one is invented from the first
/// column when the caller didn't ask for one), and `TOP` for IRIS — where a non-zero offset has to
/// be paged over with `%VID`, since `TOP` alone can only take a prefix.
pub fn select_page(
    node: &DbNodeRef,
    dialect: SqlDialect,
    filter: &str,
    sort: &[DbSortKey],
    offset: u32,
    limit: u32,
) -> Result<String, String> {
    let target = qualify(node, dialect)?;
    let where_clause = if filter.trim().is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", filter.trim())
    };
    // Every key is quoted and given its own direction, in the order the grid collected them: the
    // first is the sort, the rest break its ties.
    let keys: Vec<String> = sort
        .iter()
        .filter(|key| !key.column.trim().is_empty())
        .map(|key| {
            format!(
                "{}{}",
                quote_ident(&key.column, dialect),
                if key.descending { " DESC" } else { " ASC" }
            )
        })
        .collect();
    let order = (!keys.is_empty()).then(|| format!(" ORDER BY {}", keys.join(", ")));

    Ok(match dialect {
        SqlDialect::Postgres => format!(
            "SELECT * FROM {target}{where_clause}{}{}",
            order.unwrap_or_default(),
            format_args!(" LIMIT {limit} OFFSET {offset}"),
        ),
        SqlDialect::TSql => {
            // `OFFSET … FETCH` is only valid after an `ORDER BY`; ordering by the first column of
            // the projection is the standard stand-in and is stable enough to page over.
            let order = order.unwrap_or_else(|| " ORDER BY 1".to_string());
            format!("SELECT * FROM {target}{where_clause}{order} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
        }
        SqlDialect::Iris => {
            if offset == 0 {
                format!(
                    "SELECT TOP {limit} * FROM {target}{where_clause}{}",
                    order.unwrap_or_default()
                )
            } else {
                // IRIS has no OFFSET. `%VID` numbers the rows of a subquery's result, which is the
                // documented way to take a window out of the middle of one. Both derived tables are
                // aliased — an unaliased one is a syntax error in most dialects and not worth
                // relying on being tolerated in this one.
                let inner_order = order.unwrap_or_default();
                format!(
                    "SELECT * FROM (SELECT TOP {} %VID AS cf_vid, src.* FROM (SELECT * FROM {target}{where_clause}{inner_order}) src) paged \
                     WHERE cf_vid > {offset}",
                    offset.saturating_add(limit),
                )
            }
        }
    })
}

pub fn count_rows(node: &DbNodeRef, dialect: SqlDialect, filter: &str) -> Result<String, String> {
    let target = qualify(node, dialect)?;
    let where_clause = if filter.trim().is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", filter.trim())
    };
    Ok(format!("SELECT COUNT(*) FROM {target}{where_clause}"))
}

/// The `WHERE` that identifies one row from its key cells.
///
/// A NULL key compares with `IS NULL`, not `= NULL` — which matters, because a table without a
/// primary key is identified by *every* original value of the row, and a nullable column among
/// them would otherwise match nothing and silently update zero rows.
fn identity_clause(keys: &[DbCell], dialect: SqlDialect) -> Result<String, String> {
    if keys.is_empty() {
        return Err(
            "This row can't be identified: the table has no primary key and the original values \
             weren't captured. Edit it with an explicit statement in the console."
                .to_string(),
        );
    }
    let mut parts = Vec::with_capacity(keys.len());
    for key in keys {
        let column = quote_ident(&key.column, dialect);
        match &key.value {
            None => parts.push(format!("{column} IS NULL")),
            Some(value) => parts.push(format!("{column} = {}", quote_literal(Some(value))?)),
        }
    }
    Ok(parts.join(" AND "))
}

/// One row edit as a statement.
///
/// Deletes and updates always carry a `WHERE` built from [`identity_clause`], so a row the grid
/// couldn't identify fails loudly here rather than becoming an unqualified `DELETE FROM t`.
pub fn edit_statement(
    node: &DbNodeRef,
    dialect: SqlDialect,
    edit: &DbRowEdit,
) -> Result<String, String> {
    let target = qualify(node, dialect)?;
    // A document edit has no SQL spelling — see `DbRowEdit::document`. It only ever comes from the
    // Mongo document views, so reaching a SQL dialect with one means something is routed wrong, and
    // saying so beats writing a statement out of the cells it deliberately left empty.
    if edit.document.is_some() {
        return Err("This engine edits rows and columns, not whole documents.".to_string());
    }
    match edit.kind {
        DbRowEditKind::Insert => {
            if edit.values.is_empty() {
                return Err("There is nothing to insert — every column was left empty.".to_string());
            }
            let columns: Vec<String> =
                edit.values.iter().map(|cell| quote_ident(&cell.column, dialect)).collect();
            let mut values = Vec::with_capacity(edit.values.len());
            for cell in &edit.values {
                values.push(quote_literal(cell.value.as_deref())?);
            }
            Ok(format!(
                "INSERT INTO {target} ({}) VALUES ({})",
                columns.join(", "),
                values.join(", ")
            ))
        }
        DbRowEditKind::Update => {
            if edit.values.is_empty() {
                return Err("There is nothing to update — no cell was changed.".to_string());
            }
            let mut assignments = Vec::with_capacity(edit.values.len());
            for cell in &edit.values {
                assignments.push(format!(
                    "{} = {}",
                    quote_ident(&cell.column, dialect),
                    quote_literal(cell.value.as_deref())?
                ));
            }
            Ok(format!(
                "UPDATE {target} SET {} WHERE {}",
                assignments.join(", "),
                identity_clause(&edit.keys, dialect)?
            ))
        }
        DbRowEditKind::Delete => Ok(format!(
            "DELETE FROM {target} WHERE {}",
            identity_clause(&edit.keys, dialect)?
        )),
    }
}

/// `CREATE TABLE` reconstructed from the column list, for the DDL tab.
///
/// Not the server's own definition — no engine here hands one out in a form all three could share,
/// and IRIS doesn't have one at all (its tables are projections of classes). What it is, is an
/// honest rendering of what introspection saw: columns, types, nullability and the primary key.
/// Indexes and foreign keys are appended by the caller, which has them from the same walk.
pub fn create_table_ddl(
    node: &DbNodeRef,
    dialect: SqlDialect,
    columns: &[(String, String, bool, Option<String>)],
    primary_key: &[String],
) -> Result<String, String> {
    let target = qualify(node, dialect)?;
    let mut lines: Vec<String> = Vec::with_capacity(columns.len() + 1);
    for (name, data_type, nullable, default) in columns {
        let mut line = format!("    {} {data_type}", quote_ident(name, dialect));
        if let Some(default) = default.as_deref().filter(|d| !d.is_empty()) {
            line.push_str(&format!(" DEFAULT {default}"));
        }
        if !nullable {
            line.push_str(" NOT NULL");
        }
        lines.push(line);
    }
    if !primary_key.is_empty() {
        let key: Vec<String> =
            primary_key.iter().map(|column| quote_ident(column, dialect)).collect();
        lines.push(format!("    PRIMARY KEY ({})", key.join(", ")));
    }
    Ok(format!("CREATE TABLE {target} (\n{}\n);", lines.join(",\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::DbNodeKind;

    fn cell(column: &str, value: Option<&str>) -> DbCell {
        DbCell {
            column: column.to_string(),
            value: value.map(str::to_string),
            type_name: String::new(),
        }
    }

    fn node() -> DbNodeRef {
        DbNodeRef {
            kind: DbNodeKind::Table,
            database: Some("app".into()),
            schema: Some("public".into()),
            name: Some("users".into()),
        }
    }

    /// The single most important test in this module: a value carrying a quote must not be able to
    /// end the literal it sits in.
    #[test]
    fn a_quote_in_a_value_cannot_escape_its_literal() {
        assert_eq!(quote_literal(Some("O'Brien")).unwrap(), "'O''Brien'");
        assert_eq!(quote_literal(Some("'; DROP TABLE users --")).unwrap(), "'''; DROP TABLE users --'");
        assert_eq!(quote_literal(None).unwrap(), "NULL");
        assert!(quote_literal(Some("a\0b")).is_err());
    }

    #[test]
    fn identifiers_are_quoted_per_dialect() {
        assert_eq!(quote_ident("select", SqlDialect::Postgres), "\"select\"");
        assert_eq!(quote_ident("my table", SqlDialect::TSql), "[my table]");
        assert_eq!(quote_ident("a\"b", SqlDialect::Iris), "\"a\"\"b\"");
        assert_eq!(quote_ident("a]b", SqlDialect::TSql), "[a]]b]");
    }

    /// A row identified by a nullable column has to compare with `IS NULL`, or the update finds
    /// nothing and the user is told "0 rows" for an edit they can see on screen.
    #[test]
    fn a_null_key_compares_with_is_null() {
        let edit = DbRowEdit {
            kind: DbRowEditKind::Update,
            values: vec![cell("name", Some("Ana"))],
            keys: vec![cell("id", Some("7")), cell("deleted_at", None)],
            document: None,
        };
        let sql = edit_statement(&node(), SqlDialect::Postgres, &edit).unwrap();
        assert!(sql.contains("\"deleted_at\" IS NULL"), "{sql}");
        assert!(sql.contains("\"id\" = '7'"), "{sql}");
    }

    /// No identity means no statement. An `UPDATE`/`DELETE` that lost its `WHERE` would hit the
    /// whole table.
    #[test]
    fn an_unidentifiable_row_is_refused_rather_than_widened() {
        for kind in [DbRowEditKind::Update, DbRowEditKind::Delete] {
            let edit =
                DbRowEdit { kind, values: vec![cell("name", Some("x"))], keys: Vec::new(), document: None };
            assert!(edit_statement(&node(), SqlDialect::Postgres, &edit).is_err());
        }
    }

    /// T-SQL rejects `OFFSET` without `ORDER BY`, so paging a table the user hasn't sorted still
    /// has to produce legal SQL.
    #[test]
    fn tsql_paging_always_has_an_order_by() {
        let sql = select_page(&node(), SqlDialect::TSql, "", &[], 100, 50).unwrap();
        assert!(sql.contains("ORDER BY 1"), "{sql}");
        assert!(sql.contains("OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY"), "{sql}");
    }

    /// Several keys keep their order and their own directions — the tie-breaker is the point.
    #[test]
    fn a_multi_column_sort_keeps_its_order() {
        let sort = vec![
            DbSortKey { column: "created_at".into(), descending: true },
            DbSortKey { column: "name".into(), descending: false },
        ];
        let sql = select_page(&node(), SqlDialect::Postgres, "", &sort, 0, 50).unwrap();
        assert!(sql.contains(r#"ORDER BY "created_at" DESC, "name" ASC"#), "{sql}");
    }

    #[test]
    fn iris_pages_with_top_and_vid() {
        let first = select_page(&node(), SqlDialect::Iris, "", &[], 0, 50).unwrap();
        assert!(first.starts_with("SELECT TOP 50"), "{first}");
        let later = select_page(&node(), SqlDialect::Iris, "", &[], 50, 50).unwrap();
        assert!(later.contains("%VID"), "{later}");
        assert!(later.contains("TOP 100"), "{later}");
        assert!(later.contains("cf_vid > 50"), "{later}");
    }
}
