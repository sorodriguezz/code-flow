//! «Base de datos» (`data.database`) run whole against a SQLite file: tables and columns listed,
//! rows inserted from items with the fields that are not columns left out, read back by conditions
//! and counted, upserted, updated and deleted by key — and a batch with one row that is not there
//! saving none of the others.

use super::*;

fn temp_db(name: &str) -> (PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("cf-dbnode-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    // The console opens an existing file and never creates one; an empty file is an empty database.
    std::fs::write(dir.join("flujos.db"), b"").unwrap();
    let id = format!("sqlite:{}", dir.join("flujos.db").to_string_lossy());
    (dir, id)
}

fn chain(nodes: Vec<FlowNode>) -> FlowSpec {
    let ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let connections = ids.windows(2).map(|pair| wire(&pair[0], 0, &pair[1], 0)).collect();
    flow(nodes, connections)
}

fn succeeded(ran: &Ran) {
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
}

fn db(id: &str, connection: &str, params: Value) -> FlowNode {
    let mut all = json!({"connection": connection});
    for (key, value) in params.as_object().cloned().unwrap_or_default() {
        all[key] = value;
    }
    node(id, "data.database", all)
}

fn setup(connection: &str) -> FlowNode {
    node(
        "setup",
        "data.sql",
        json!({
            "connection": connection,
            "queryText": "CREATE TABLE pedidos (id INTEGER PRIMARY KEY, cliente TEXT NOT NULL, total REAL, pagado BOOLEAN)",
            "runFor": "once",
        }),
    )
}

fn ids(rows: &[Value]) -> Vec<i64> {
    rows.iter().map(|row| row["id"].as_i64().unwrap_or(-1)).collect()
}

#[tokio::test]
async fn rows_are_written_and_read_without_sql() {
    let (dir, connection) = temp_db("read");
    let spec = chain(vec![
        node("start", "trigger.manual", json!({})),
        setup(&connection),
        code(
            "rows",
            r#"return [
                {id: 1, cliente: "O'Brien", total: 10.5, pagado: true, nota: "no es columna"},
                {id: 2, cliente: "Ana", total: 3, pagado: false},
                {id: 3, cliente: "50%_off", total: 7, pagado: false},
            ];"#,
        ),
        db("insert", &connection, json!({"dbOp": "dbInsert", "dbTable": "pedidos"})),
        db(
            "read",
            &connection,
            json!({
                "dbOp": "dbRead",
                "dbTable": "pedidos",
                "dbFilters": {"combinator": "and", "conditions": [{"column": "total", "op": "gte", "value": "5"}]},
                "dbSort": [{"field": "id", "order": "desc"}],
                "runFor": "once",
            }),
        ),
        db(
            "like",
            &connection,
            json!({
                "dbOp": "dbRead",
                "dbTable": "pedidos",
                "dbFilters": {"conditions": [{"column": "cliente", "op": "contains", "value": "%_"}]},
                "runFor": "once",
            }),
        ),
        db(
            "unpaid",
            &connection,
            json!({
                "dbOp": "dbCount",
                "dbTable": "pedidos",
                "dbFilters": {"conditions": [{"column": "pagado", "op": "equals", "value": "={{ false }}"}]},
                "runFor": "once",
            }),
        ),
        db("tables", &connection, json!({"dbOp": "dbTables"})),
        db("columns", &connection, json!({"dbOp": "dbColumns", "dbTable": "pedidos"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("insert", 0).len(), 3, "the items go on as they came");
    assert!(logs_of(&ran, "insert").iter().any(|line| line.contains("left out: nota")), "{:?}", logs_of(&ran, "insert"));
    let read = ran.output("read", 0);
    assert_eq!(ids(&read), vec![3, 1]);
    assert_eq!(read[1]["cliente"], "O'Brien");
    assert_eq!(read[1]["pagado"], true, "a boolean reads back as one");
    // `%` and `_` in a value are text, not wildcards.
    assert_eq!(ids(&ran.output("like", 0)), vec![3]);
    assert_eq!(ran.output("unpaid", 0), vec![json!({"table": "pedidos", "count": 2})]);
    assert!(ran.output("tables", 0).iter().any(|t| t["name"] == "pedidos" && t["kind"] == "table"));
    let columns = ran.output("columns", 0);
    assert_eq!(columns.iter().map(|c| c["name"].as_str().unwrap_or("")).collect::<Vec<_>>(), vec!["id", "cliente", "total", "pagado"]);
    assert_eq!(columns[0]["primaryKey"], true);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn upsert_update_and_delete_find_rows_by_key() {
    let (dir, connection) = temp_db("write");
    let spec = chain(vec![
        node("start", "trigger.manual", json!({})),
        setup(&connection),
        code("seed", r#"return [{id: 1, cliente: "Ana", total: 1}, {id: 2, cliente: "Bruno", total: 2}, {id: 3, cliente: "Carla", total: 3}];"#),
        db("insert", &connection, json!({"dbOp": "dbInsert", "dbTable": "pedidos"})),
        code("changes", r#"return [{id: 2, total: 20}, {id: 4, cliente: "Dora", total: 4}];"#),
        // The key is the table's primary key when none is named.
        db("upsert", &connection, json!({"dbOp": "dbUpsert", "dbTable": "pedidos"})),
        code("renames", r#"return [{cliente: "Carla", total: 30, ignored: true}];"#),
        db("update", &connection, json!({"dbOp": "dbUpdate", "dbTable": "pedidos", "dbKeys": ["cliente"], "dbFields": ["total"]})),
        code("gone", r#"return [{id: 1}];"#),
        db("delete", &connection, json!({"dbOp": "dbDelete", "dbTable": "pedidos"})),
        db("all", &connection, json!({"dbOp": "dbRead", "dbTable": "pedidos", "dbSort": [{"field": "id", "order": "asc"}], "runFor": "once"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert!(logs_of(&ran, "upsert").iter().any(|line| line.contains("1 inserted, 1 updated")), "{:?}", logs_of(&ran, "upsert"));
    let all = ran.output("all", 0);
    assert_eq!(ids(&all), vec![2, 3, 4]);
    assert_eq!(all[0]["total"], 20.0);
    assert_eq!(all[0]["cliente"], "Bruno", "an upsert sets only what the item carries");
    assert_eq!(all[1]["total"], 30.0);
    assert_eq!(all[2]["cliente"], "Dora");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_row_that_is_not_there_saves_nothing_of_the_batch() {
    let (dir, connection) = temp_db("rollback");
    let seed = chain(vec![
        node("start", "trigger.manual", json!({})),
        setup(&connection),
        code("seed", r#"return [{id: 1, cliente: "Ana", total: 1}];"#),
        db("insert", &connection, json!({"dbOp": "dbInsert", "dbTable": "pedidos"})),
    ]);
    succeeded(&run(seed).await);
    let failing = chain(vec![
        node("start", "trigger.manual", json!({})),
        code("changes", r#"return [{id: 1, total: 100}, {id: 99, total: 1}];"#),
        db("update", &connection, json!({"dbOp": "dbUpdate", "dbTable": "pedidos"})),
    ]);
    let ran = run(failing).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("rolled back"), "{:?}", ran.outcome.error);
    let check = chain(vec![
        node("start", "trigger.manual", json!({})),
        db("all", &connection, json!({"dbOp": "dbRead", "dbTable": "pedidos", "runFor": "once"})),
    ]);
    let ran = run(check).await;
    succeeded(&ran);
    assert_eq!(ran.output("all", 0)[0]["total"], 1.0, "the first change was rolled back with the second");
    let _ = std::fs::remove_dir_all(&dir);
}

/// "Probar paso" on a node nothing is wired into yet: it runs once, on its own, rather than being
/// refused for having no input.
#[tokio::test]
async fn a_lone_node_can_be_tried_by_itself() {
    let (dir, connection) = temp_db("alone");
    let seed = chain(vec![node("start", "trigger.manual", json!({})), setup(&connection)]);
    succeeded(&run(seed).await);
    let lone = flow(vec![db("tables", &connection, json!({"dbOp": "dbTables"}))], vec![]);
    let ran = run_with(lone, RunMode::Step { node: "tables".into() }, HashMap::new(), CancellationToken::new()).await;
    succeeded(&ran);
    assert!(ran.output("tables", 0).iter().any(|t| t["name"] == "pedidos"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_table_without_a_key_asks_for_one() {
    let (dir, connection) = temp_db("nokey");
    let spec = chain(vec![
        node("start", "trigger.manual", json!({})),
        node("setup", "data.sql", json!({"connection": connection, "queryText": "CREATE TABLE notas (texto TEXT)", "runFor": "once"})),
        code("rows", r#"return [{texto: "a"}];"#),
        db("update", &connection, json!({"dbOp": "dbUpdate", "dbTable": "notas"})),
    ]);
    let ran = run(spec).await;
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("no primary key"), "{:?}", ran.outcome.error);
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------- live, in containers
//
// The containers of `milestone4` (`cf-pg` on 55432, `cf-mongo` on 57017):
// cargo test --lib flows::engine::tests::database_node -- --ignored --test-threads 1

#[tokio::test]
#[ignore]
async fn postgres_in_a_schema_with_typed_values() {
    let spec = chain(vec![
        node("start", "trigger.manual", json!({})),
        node(
            "setup",
            "data.sql",
            json!({
                "connection": "pg",
                "queryText": "CREATE SCHEMA IF NOT EXISTS tienda; DROP TABLE IF EXISTS tienda.pedidos; \
                              CREATE TABLE tienda.pedidos (id serial PRIMARY KEY, cliente text NOT NULL, total numeric(10,2), pagado boolean, datos jsonb)",
                "runFor": "once",
            }),
        ),
        code("rows", r#"return [{cliente: "O'Brien", total: 10.5, pagado: true, datos: {a: 1}}, {cliente: "Ana", total: 3, pagado: false, datos: null}];"#),
        db("insert", "pg", json!({"dbOp": "dbInsert", "dbTable": "tienda.pedidos"})),
        db(
            "read",
            "pg",
            json!({
                "dbOp": "dbRead",
                "schema": "tienda",
                "dbTable": "pedidos",
                "dbFilters": {"combinator": "or", "conditions": [{"column": "pagado", "op": "equals", "value": "={{ true }}"}, {"column": "total", "op": "lt", "value": "4"}]},
                "dbSort": [{"field": "id", "order": "asc"}],
                "runFor": "once",
            }),
        ),
        code("changes", r#"return [{id: 2, pagado: true}, {id: 3, cliente: "Nueva", total: 1}];"#),
        db("upsert", "pg", json!({"dbOp": "dbUpsert", "dbTable": "tienda.pedidos"})),
        db("count", "pg", json!({"dbOp": "dbCount", "dbTable": "tienda.pedidos", "dbFilters": {"conditions": [{"column": "pagado", "op": "equals", "value": "={{ true }}"}]}, "runFor": "once"})),
        db("tables", "pg", json!({"dbOp": "dbTables", "schema": "tienda"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let read = ran.output("read", 0);
    assert_eq!(ids(&read), vec![1, 2]);
    assert_eq!(read[0]["total"], 10.5);
    assert_eq!(read[0]["pagado"], true);
    assert_eq!(read[0]["datos"], json!({"a": 1}));
    assert_eq!(ran.output("count", 0)[0]["count"], 2);
    assert_eq!(ran.output("tables", 0).iter().map(|t| t["name"].clone()).collect::<Vec<_>>(), vec![json!("pedidos")]);
}

#[tokio::test]
#[ignore]
async fn mongo_documents_by_their_object_id() {
    let spec = chain(vec![
        node("start", "trigger.manual", json!({})),
        node("drop", "data.mongo", json!({"connection": "mongo", "queryText": "db.pedidos_db.drop()", "runFor": "once"})),
        code("rows", r#"return [{cliente: "Ana", total: 3, tags: ["a", "b"], meta: {vip: true}}, {cliente: "Bruno", total: 12}];"#),
        db("insert", "mongo", json!({"dbOp": "dbInsert", "dbTable": "pedidos_db"})),
        db("first", "mongo", json!({"dbOp": "dbRead", "dbTable": "pedidos_db", "dbFilters": {"conditions": [{"column": "total", "op": "lt", "value": "5"}]}, "runFor": "once"})),
        code("change", r#"return [{_id: $input.all()[0].json._id, total: 30}];"#),
        db("update", "mongo", json!({"dbOp": "dbUpdate", "dbTable": "pedidos_db"})),
        db(
            "again",
            "mongo",
            json!({"dbOp": "dbRead", "dbTable": "pedidos_db", "dbFilters": {"conditions": [{"column": "_id", "op": "equals", "value": "={{ $json._id }}"}]}}),
        ),
        db("count", "mongo", json!({"dbOp": "dbCount", "dbTable": "pedidos_db", "dbFilters": {"conditions": [{"column": "total", "op": "gte", "value": "12"}]}, "runFor": "once"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let first = ran.output("first", 0);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["tags"], json!(["a", "b"]), "a document keeps its nesting");
    assert_eq!(first[0]["meta"], json!({"vip": true}));
    let again = ran.output("again", 0);
    assert_eq!(again.len(), 1, "the hex of an ObjectId finds its document");
    assert_eq!(again[0]["total"], 30);
    assert_eq!(again[0]["cliente"], "Ana", "an update sets, it does not replace");
    assert_eq!(ran.output("count", 0)[0]["count"], 2);
}
