//! Milestone 4's nodes, run whole: files on disk, git in a new repository, the format conversions,
//! SQLite, a rate limit, and the network nodes against servers on a loopback port — WebSocket,
//! Server-Sent Events, GraphQL, Socket.IO and a download.
//!
//! The `#[ignore]`d tests at the end need real services, in containers on fixed ports:
//!
//! ```text
//! docker run -d --rm --name cf-pg    -p 55432:5432  -e POSTGRES_PASSWORD=flujos postgres:16
//! docker run -d --rm --name cf-mysql -p 53306:3306  -e MYSQL_ROOT_PASSWORD=flujos -e MYSQL_DATABASE=flujos mysql:8.4
//! docker run -d --rm --name cf-mongo -p 57017:27017 mongo:7
//! docker run -d --rm --name cf-redis -p 56379:6379  redis:7-alpine
//! docker run -d --rm --name cf-mqtt  -p 51883:1883  eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
//! docker run -d --rm --name cf-mail  -p 51025:1025 -p 58025:8025 axllent/mailpit
//! docker run -d --rm --name cf-grpc  -p 59000:9000  moul/grpcbin
//! ssh-keygen -q -t ed25519 -N "" -f "$KEYS/id_ed25519"
//! docker run -d --rm --name cf-ssh   -p 52222:2222  -e USER_NAME=flujos -e PASSWORD_ACCESS=false \
//!     -e "PUBLIC_KEY=$(cat "$KEYS/id_ed25519.pub")" linuxserver/openssh-server
//! CODEFLOW_TEST_SSH_KEY="$KEYS/id_ed25519" cargo test --lib flows::engine::tests::milestone4 -- --ignored --test-threads 1
//! ```
//!
//! The SSH host trusts its server's key in a `known_hosts` beside the test key, never in `~/.ssh`.

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message;

use super::*;

/// The connections the tests name: `sqlite:<path>` for a file, and the containers above.
pub(super) fn connection(id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
    let spec = if let Some(path) = id.strip_prefix("sqlite:") {
        json!({"id": id, "kind": "sqlite", "host": "", "database": path, "ssl": "disable"})
    } else {
        match id {
            "pg" => json!({"id": id, "kind": "postgres", "host": "127.0.0.1", "port": 55432, "database": "postgres", "user": "postgres", "password": "flujos", "ssl": "disable"}),
            "mysql" => json!({"id": id, "kind": "mysql", "host": "127.0.0.1", "port": 53306, "database": "flujos", "user": "root", "password": "flujos", "ssl": "disable"}),
            "mongo" => json!({"id": id, "kind": "mongodb", "host": "127.0.0.1", "port": 57017, "database": "flujos", "ssl": "disable"}),
            "redis" => json!({"id": id, "kind": "redis", "host": "127.0.0.1", "port": 56379, "ssl": "disable"}),
            _ => return Err(format!("Unknown database connection {id}")),
        }
    };
    serde_json::from_value(spec).map_err(|e| e.to_string())
}

/// The Remote hosts the tests name: the OpenSSH container above, as an SSH host and as an SFTP one.
pub(super) fn remote(id: &str) -> Result<crate::remotes::RemoteHostSpec, String> {
    let kind = match id {
        "ssh-test" => "ssh",
        "sftp-test" => "sftp",
        _ => return Err(format!("Unknown remote host {id}")),
    };
    let key = std::env::var("CODEFLOW_TEST_SSH_KEY").map_err(|_| "Set CODEFLOW_TEST_SSH_KEY to the test key".to_string())?;
    let known_hosts = std::path::Path::new(&key).with_file_name("known_hosts");
    serde_json::from_value(json!({
        "kind": kind,
        "host": "127.0.0.1",
        "port": 52222,
        "user": "flujos",
        "auth": "key",
        "key_file": key,
        "options": [format!("UserKnownHostsFile={}", known_hosts.display()), "StrictHostKeyChecking=accept-new"],
    }))
    .map_err(|e| e.to_string())
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cf-m4-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Nodes wired one after the other, each from the previous one's first output.
fn chain(nodes: Vec<FlowNode>) -> FlowSpec {
    let ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let connections = ids.windows(2).map(|pair| wire(&pair[0], 0, &pair[1], 0)).collect();
    flow(nodes, connections)
}

fn start() -> FlowNode {
    node("start", "trigger.manual", json!({}))
}

fn succeeded(ran: &Ran) {
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
}

// ------------------------------------------------------------------------------------------ files

#[tokio::test]
async fn files_are_written_whole_appended_read_moved_and_listed() {
    let dir = temp_dir("files");
    let d = dir.to_string_lossy().to_string();
    let notes = format!("{d}/a/notas.txt");
    std::fs::create_dir_all(dir.join("b")).unwrap();
    let spec = chain(vec![
        start(),
        node("write", "files.file", json!({"operation": "write", "path": notes, "content": "uno\n", "writeAs": "text", "createFolders": true})),
        node("append", "files.file", json!({"operation": "addToEnd", "path": notes, "content": "dos\n", "writeAs": "text", "createFolders": false})),
        node("read", "files.file", json!({"operation": "read", "path": notes, "readAs": "lines", "target": "lines"})),
        // Into an existing folder; then a rename; then to a folder that is only named, by its slash.
        node("copy", "files.move", json!({"operation": "copy", "source": notes, "destPath": format!("{d}/b")})),
        node("rename", "files.move", json!({"operation": "rename", "source": format!("{d}/b/notas.txt"), "newName": "copia.txt"})),
        node("move", "files.move", json!({"operation": "move", "source": format!("{d}/b/copia.txt"), "destPath": format!("{d}/c/")})),
        node("list", "files.list", json!({"folder": d, "pattern": "*.txt", "recursive": true, "entryKinds": "files", "sortBy": "name"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("read", 0)[0]["lines"], json!(["uno", "dos"]));
    assert_eq!(std::fs::read_to_string(dir.join("c/copia.txt")).unwrap(), "uno\ndos\n");
    assert!(!dir.join("b/copia.txt").exists(), "a move leaves nothing behind");
    let listed: Vec<String> = ran.output("list", 0).iter().map(|f| f["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(listed, vec!["notas.txt", "copia.txt"], "sorted by path: a/notas.txt, then c/copia.txt");
    // Writes never leave their temporary sibling behind.
    assert!(std::fs::read_dir(dir.join("a")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with('.')));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_relative_path_is_refused() {
    let spec = chain(vec![start(), node("write", "files.file", json!({"operation": "write", "path": "notas.txt", "content": "x"}))]);
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("not an absolute path"));
}

// -------------------------------------------------------------------------------------------- git

#[tokio::test]
async fn git_commits_switches_branch_tags_and_reads_the_log() {
    let dir = temp_dir("git");
    let hooks = dir.join(".no-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Flujos"),
        ("user.email", "flujos@example.com"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.hooksPath", hooks.to_str().unwrap()),
    ] {
        git(&["config", key, value]);
    }
    std::fs::write(dir.join("a.txt"), "hola\n").unwrap();
    std::fs::write(dir.join(".gitignore"), ".no-hooks/\n").unwrap();
    let repo = dir.to_string_lossy().to_string();
    let spec = chain(vec![
        start(),
        node("commit", "files.git", json!({"repoPath": repo, "operation": "makeCommit", "message": "Primer commit", "stageAll": true})),
        node("branch", "files.git", json!({"repoPath": repo, "operation": "checkout", "branch": "feature/x", "create": true})),
        node("tag", "files.git", json!({"repoPath": repo, "operation": "createTag", "tag": "v1.0.0", "message": "Versión 1"})),
        node("status", "files.git", json!({"repoPath": repo, "operation": "status"})),
        node("log", "files.git", json!({"repoPath": repo, "operation": "log", "maxCount": 5})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let sha = ran.output("commit", 0)[0]["sha"].as_str().unwrap().to_string();
    assert_eq!(sha, git(&["rev-parse", "HEAD"]));
    let status = &ran.output("status", 0)[0];
    assert_eq!(status["branch"], "feature/x");
    assert_eq!(status["clean"], true, "{status}");
    assert_eq!(status["repository"], json!(repo));
    let log = ran.output("log", 0);
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["subject"], "Primer commit");
    assert_eq!(log[0]["email"], "flujos@example.com");
    assert_eq!(git(&["tag", "-l", "-n1"]).split_whitespace().collect::<Vec<_>>(), vec!["v1.0.0", "Versión", "1"]);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------------------- formats

#[tokio::test]
async fn items_go_through_csv_xml_yaml_and_json_text_and_come_back() {
    let spec = chain(vec![
        start(),
        code("rows", r#"return [{id: 1, nombre: "Ana", nota: 'dice "hola"'}, {id: 2, nombre: "Bruno, J.", nota: "x"}];"#),
        node("csv", "transform.convert", json!({"operation": "toCsv", "allItems": true, "header": true, "delimiter": ","})),
        node("back", "transform.convert", json!({"operation": "fromCsv", "inputField": "csv", "header": true, "delimiter": ","})),
        node("xml", "transform.convert", json!({"operation": "toXml", "inputField": "", "xmlRoot": "pedido", "target": "xml"})),
        node("parsed", "transform.convert", json!({"operation": "fromXml", "inputField": "xml", "target": "parsed"})),
        node("yaml", "transform.convert", json!({"operation": "toYaml", "inputField": "parsed", "target": "yaml"})),
        node("again", "transform.convert", json!({"operation": "fromYaml", "inputField": "yaml", "target": "again"})),
        node("text", "transform.convert", json!({"operation": "toJsonText", "inputField": "again", "target": "json"})),
        node("copy", "transform.convert", json!({"operation": "fromJsonText", "inputField": "json", "target": "copy"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let csv = ran.output("csv", 0);
    assert_eq!(csv.len(), 1, "all items make one table");
    // RFC 4180: CRLF between records.
    assert_eq!(csv[0]["csv"], "id,nombre,nota\r\n1,Ana,\"dice \"\"hola\"\"\"\r\n2,\"Bruno, J.\",x\r\n");
    assert_eq!(
        ran.output("back", 0),
        vec![json!({"id": "1", "nombre": "Ana", "nota": "dice \"hola\""}), json!({"id": "2", "nombre": "Bruno, J.", "nota": "x"})]
    );
    let last = ran.output("copy", 0);
    assert_eq!(last.len(), 2);
    assert_eq!(last[1]["parsed"]["pedido"]["nombre"], "Bruno, J.");
    assert_eq!(last[1]["parsed"], last[1]["again"]);
    assert_eq!(last[1]["again"], last[1]["copy"]);
}

#[tokio::test]
async fn hashes_macs_and_base64_match_known_vectors() {
    let spec = chain(vec![
        start(),
        node("hash", "transform.crypto", json!({"operation": "hash", "value": "abc", "algorithm": "sha256", "encoding": "hex"})),
        node(
            "mac",
            "transform.crypto",
            json!({"operation": "hmac", "value": "The quick brown fox jumps over the lazy dog", "algorithm": "sha256", "credential": "signing", "encoding": "hex"}),
        ),
        node("encode", "transform.crypto", json!({"operation": "base64Encode", "value": "hola"})),
        node("decode", "transform.crypto", json!({"operation": "base64Decode", "value": "={{ $json.base64 }}"})),
        node("id", "transform.crypto", json!({"operation": "uuid"})),
        node("noise", "transform.crypto", json!({"operation": "random", "length": 8, "encoding": "hex"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let item = &ran.output("noise", 0)[0];
    assert_eq!(item["hash"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(item["hmac"], "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    assert_eq!(item["base64"], "aG9sYQ==");
    assert_eq!(item["text"], "hola");
    assert_eq!(item["uuid"].as_str().unwrap().len(), 36);
    assert_eq!(item["random"].as_str().unwrap().len(), 16);
}

#[tokio::test]
async fn a_comparison_sorts_items_into_four_outputs() {
    let spec = flow(
        vec![
            start(),
            code("before", "return [{id: 1, n: 'a'}, {id: 2, n: 'b'}, {id: 3, n: 'c'}];"),
            code("after", "return [{id: 2, n: 'b'}, {id: 3, n: 'C'}, {id: 4, n: 'd'}];"),
            node("diff", "transform.compare", json!({"keyA": "id", "keyB": "", "fields": []})),
        ],
        vec![wire("start", 0, "before", 0), wire("start", 0, "after", 0), wire("before", 0, "diff", 0), wire("after", 0, "diff", 1)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("diff", 0), vec![json!({"id": 1, "n": "a"})]);
    assert_eq!(ran.output("diff", 1), vec![json!({"id": 2, "n": "b"})]);
    assert_eq!(
        ran.output("diff", 2),
        vec![json!({"a": {"id": 3, "n": "c"}, "b": {"id": 3, "n": "C"}, "different": {"n": {"a": "c", "b": "C"}}})]
    );
    assert_eq!(ran.output("diff", 3), vec![json!({"id": 4, "n": "d"})]);
}

#[tokio::test]
async fn archives_pack_and_unpack() {
    let dir = temp_dir("compress");
    let d = dir.to_string_lossy().to_string();
    std::fs::create_dir_all(dir.join("src/sub")).unwrap();
    std::fs::write(dir.join("src/a.txt"), "alfa").unwrap();
    std::fs::write(dir.join("src/sub/b.txt"), "beta").unwrap();
    std::fs::write(dir.join("c.txt"), "gamma").unwrap();
    std::fs::create_dir_all(dir.join("out")).unwrap();
    let spec = chain(vec![
        start(),
        node("zip", "transform.compress", json!({"operation": "zip", "source": format!("{d}/src"), "sources": [format!("{d}/c.txt")], "destPath": format!("{d}/out/paquete.zip")})),
        node("unzip", "transform.compress", json!({"operation": "unzip", "source": "={{ $json.file.path }}", "destPath": format!("{d}/unzipped")})),
        node("tar", "transform.compress", json!({"operation": "tarGz", "source": format!("{d}/src"), "destPath": format!("{d}/out/paquete.tar.gz")})),
        node("untar", "transform.compress", json!({"operation": "untarGz", "source": "={{ $json.file.path }}", "destPath": format!("{d}/untarred")})),
        node("gz", "transform.compress", json!({"operation": "gzip", "source": format!("{d}/c.txt"), "destPath": format!("{d}/out/c.txt.gz")})),
        node("gunzip", "transform.compress", json!({"operation": "gunzip", "source": "={{ $json.file.path }}", "destPath": format!("{d}/out/c-again.txt")})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(std::fs::read_to_string(dir.join("unzipped/src/sub/b.txt")).unwrap(), "beta");
    assert_eq!(std::fs::read_to_string(dir.join("unzipped/c.txt")).unwrap(), "gamma");
    assert_eq!(ran.output("unzip", 0)[0]["files"].as_array().unwrap().len(), 3);
    assert_eq!(std::fs::read_to_string(dir.join("untarred/src/a.txt")).unwrap(), "alfa");
    assert_eq!(std::fs::read_to_string(dir.join("out/c-again.txt")).unwrap(), "gamma");
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------- data: sheet + SQL

#[tokio::test]
async fn spreadsheets_round_trip_through_xlsx_and_csv() {
    let dir = temp_dir("sheet");
    let d = dir.to_string_lossy().to_string();
    let rows = "return [{id: 1, cliente: 'Ana', total: 10.5, pagado: true}, {id: 2, cliente: 'Bruno', total: 3, pagado: false}];";
    let spec = flow(
        vec![
            start(),
            code("rows", rows),
            node("xlsx", "data.sheet", json!({"operation": "write", "path": format!("{d}/libros/pedidos.xlsx"), "fileFormat": "auto", "sheet": "Pedidos", "header": true, "createFolders": true})),
            node("readXlsx", "data.sheet", json!({"operation": "read", "path": format!("{d}/libros/pedidos.xlsx"), "fileFormat": "auto", "sheet": "Pedidos", "header": true})),
            node("csv", "data.sheet", json!({"operation": "write", "path": format!("{d}/pedidos.csv"), "fileFormat": "csv", "header": true, "delimiter": ";", "createFolders": true})),
            node("readCsv", "data.sheet", json!({"operation": "read", "path": format!("{d}/pedidos.csv"), "fileFormat": "csv", "header": true, "delimiter": ";", "limit": 1})),
        ],
        vec![
            wire("start", 0, "rows", 0),
            wire("rows", 0, "xlsx", 0),
            wire("xlsx", 0, "readXlsx", 0),
            wire("rows", 0, "csv", 0),
            wire("csv", 0, "readCsv", 0),
        ],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("xlsx", 0)[0]["rows"], 2);
    assert_eq!(
        ran.output("readXlsx", 0),
        vec![json!({"id": 1, "cliente": "Ana", "total": 10.5, "pagado": true}), json!({"id": 2, "cliente": "Bruno", "total": 3, "pagado": false})]
    );
    assert_eq!(std::fs::read_to_string(dir.join("pedidos.csv")).unwrap(), "id;cliente;total;pagado\r\n1;Ana;10.5;true\r\n2;Bruno;3;false\r\n");
    assert_eq!(ran.output("readCsv", 0), vec![json!({"id": "1", "cliente": "Ana", "total": "10.5", "pagado": "true"})]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// One SQL flow against a connection: a table, a row per item with values bound as literals, and
/// a query that reads them back with a quote in the value.
fn sql_flow(connection: &str, create: &str, drop: &str) -> FlowSpec {
    chain(vec![
        start(),
        node("drop", "data.sql", json!({"connection": connection, "queryText": drop, "runFor": "once"})),
        node("create", "data.sql", json!({"connection": connection, "queryText": create, "runFor": "once"})),
        code("rows", r#"return [{id: 1, cliente: "O'Brien", total: 10.5, pagado: true}, {id: 2, cliente: "Ana", total: 3, pagado: false}];"#),
        node(
            "insert",
            "data.sql",
            json!({
                "connection": connection,
                "queryText": "INSERT INTO flujos_pedidos (id, cliente, total, pagado) VALUES ($1, $2, $3, $4)",
                "queryParams": ["={{ $json.id }}", "={{ $json.cliente }}", "={{ $json.total }}", "={{ $json.pagado }}"],
            }),
        ),
        node(
            "select",
            "data.sql",
            json!({
                "connection": connection,
                "queryText": "SELECT id, cliente, total, pagado FROM flujos_pedidos WHERE cliente = $1 OR id = $2 ORDER BY id",
                "queryParams": ["O'Brien", "2"],
                "runFor": "once",
            }),
        ),
    ])
}

#[tokio::test]
async fn sql_runs_on_sqlite_with_bound_values() {
    let dir = temp_dir("sqlite");
    // The console opens an existing file and never creates one; an empty file is an empty database.
    std::fs::write(dir.join("flujos.db"), b"").unwrap();
    let id = format!("sqlite:{}", dir.join("flujos.db").to_string_lossy());
    let spec = sql_flow(
        &id,
        "CREATE TABLE flujos_pedidos (id INTEGER PRIMARY KEY, cliente TEXT, total REAL, pagado BOOLEAN)",
        "DROP TABLE IF EXISTS flujos_pedidos",
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("insert", 0).len(), 2, "one summary per inserted item");
    // A REAL column reads back as a float even when it holds a whole number.
    assert_eq!(
        ran.output("select", 0),
        vec![json!({"id": 1, "cliente": "O'Brien", "total": 10.5, "pagado": true}), json!({"id": 2, "cliente": "Ana", "total": 3.0, "pagado": false})]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------------------ logic

#[tokio::test]
async fn a_rate_limit_spaces_items_or_drops_the_extra() {
    let spec = flow(
        vec![
            start(),
            code("five", "return [1, 2, 3, 4, 5].map((n) => ({ n }));"),
            node("paced", "logic.ratelimit", json!({"amount": 2, "per": "second", "overflow": "queue"})),
            node("dropped", "logic.ratelimit", json!({"amount": 2, "per": "second", "overflow": "drop"})),
        ],
        vec![wire("start", 0, "five", 0), wire("five", 0, "paced", 0), wire("five", 0, "dropped", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("paced", 0).len(), 5);
    assert_eq!(ran.output("dropped", 0), vec![json!({"n": 1}), json!({"n": 2})]);
    // Two at once, then one every half second.
    assert!(ran.elapsed >= Duration::from_millis(1400), "{:?}", ran.elapsed);
}

// ---------------------------------------------------------------------------- network, on loopback

/// Reads one HTTP/1.1 request: its head, and a body as long as `Content-Length` says.
async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut read = 0;
    loop {
        let n = socket.read(&mut buffer[read..]).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        read += n;
        let text = String::from_utf8_lossy(&buffer[..read]).to_string();
        if let Some(head_end) = text.find("\r\n\r\n") {
            let length = text
                .lines()
                .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                .unwrap_or(0);
            if read >= head_end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buffer[..read]).to_string()
}

type Answer = Arc<dyn Fn(&str) -> (String, Vec<u8>) + Send + Sync>;

/// A server that answers every request with `answer(request)`: a full head (status line and
/// headers, without the blank line) and a body, then closes.
async fn http_server(answer: Answer) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let answer = answer.clone();
            tokio::spawn(async move {
                let request = read_request(&mut socket).await;
                let (head, body) = answer(&request);
                let _ = socket.write_all(format!("{head}\r\nConnection: close\r\n\r\n").as_bytes()).await;
                let _ = socket.write_all(&body).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

fn header_of<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

#[tokio::test]
async fn graphql_sends_variables_and_reads_a_schema() {
    let port = http_server(Arc::new(|request: &str| {
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap_or("{}")).unwrap_or(Value::Null);
        let query = body["query"].as_str().unwrap_or_default();
        let answer = if query.contains("__schema") {
            json!({"data": {"__schema": {
                "queryType": {"name": "Query"}, "mutationType": null, "subscriptionType": null,
                "types": [
                    {"kind": "OBJECT", "name": "Query", "description": null, "fields": [
                        {"name": "pedidos", "type": {"kind": "NON_NULL", "name": null, "ofType": {"kind": "LIST", "name": null, "ofType": {"kind": "OBJECT", "name": "Pedido", "ofType": null}}}}
                    ]},
                    {"kind": "OBJECT", "name": "__Type", "description": null, "fields": []}
                ]
            }}})
        } else if query.contains("roto") {
            json!({"data": null, "errors": [{"message": "No existe el campo roto"}]})
        } else {
            json!({"data": {"echo": {
                "variables": body["variables"],
                "operationName": body["operationName"],
                "auth": header_of(request, "authorization"),
            }}})
        };
        let body = answer.to_string().into_bytes();
        (format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}", body.len()), body)
    }))
    .await;
    let url = format!("http://127.0.0.1:{port}/graphql");
    let spec = chain(vec![
        start(),
        node(
            "ask",
            "net.graphql",
            json!({
                "url": url,
                "credential": "token",
                "operation": "query",
                "queryText": "query P($e: String) { pedidos(estado: $e) { id } }",
                "variables": "{\"e\": \"abierto\"}",
                "operationName": "P",
            }),
        ),
        node("schema", "net.graphql", json!({"url": url, "operation": "introspect"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(
        ran.output("ask", 0),
        vec![json!({"data": {"echo": {"variables": {"e": "abierto"}, "operationName": "P", "auth": "Bearer s3cret"}}})]
    );
    let schema = &ran.output("schema", 0)[0];
    assert_eq!(schema["queryType"], "Query");
    assert_eq!(schema["types"], json!([{"name": "Query", "kind": "OBJECT", "description": null, "fields": [{"name": "pedidos", "type": "[Pedido]!"}]}]));

    let broken = chain(vec![start(), node("ask", "net.graphql", json!({"url": url, "operation": "query", "queryText": "{ roto }"}))]);
    let ran = run(broken).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("No existe el campo roto"));
}

#[tokio::test]
async fn sse_keeps_the_named_events_and_stops_at_the_last_one() {
    let port = http_server(Arc::new(|_request: &str| {
        let stream = "event: tick\ndata: {\"n\":1}\nid: 1\n\n\
                      event: otro\ndata: nada\n\n\
                      event: tick\ndata: {\"n\":2}\nid: 2\n\n\
                      event: done\ndata: fin\n\n\
                      event: tick\ndata: {\"n\":3}\n\n";
        ("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream".to_string(), stream.as_bytes().to_vec())
    }))
    .await;
    let spec = chain(vec![
        start(),
        node(
            "events",
            "net.sse",
            json!({"url": format!("http://127.0.0.1:{port}/events"), "eventName": "tick", "untilEvent": "done", "maxMessages": 0, "timeoutSec": 5}),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(
        ran.output("events", 0),
        vec![json!({"event": "tick", "data": {"n": 1}, "id": "1"}), json!({"event": "tick", "data": {"n": 2}, "id": "2"})]
    );
}

#[tokio::test]
async fn a_download_lands_whole_under_the_servers_name() {
    let port = http_server(Arc::new(|_request: &str| {
        let body = b"a,b\n1,2\n".to_vec();
        (
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename=\"reporte.csv\"\r\nContent-Length: {}", body.len()),
            body,
        )
    }))
    .await;
    let dir = temp_dir("download");
    let spec = chain(vec![
        start(),
        node("get", "net.download", json!({"url": format!("http://127.0.0.1:{port}/export?id=7"), "folder": dir.to_string_lossy()})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let got = &ran.output("get", 0)[0];
    assert_eq!(got["file"]["name"], "reporte.csv");
    assert_eq!(got["contentType"], "text/csv");
    assert_eq!(std::fs::read_to_string(dir.join("reporte.csv")).unwrap(), "a,b\n1,2\n");
    // A second run into the same folder refuses to replace it unless told to.
    let again = chain(vec![
        start(),
        node("get", "net.download", json!({"url": format!("http://127.0.0.1:{port}/export"), "folder": dir.to_string_lossy()})),
    ]);
    let ran = run(again).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("already exists"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A WebSocket server that echoes each text message as `{"echo": …}` and says `done` after `fin`.
async fn echo_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(socket).await else { return };
                while let Some(Ok(message)) = ws.next().await {
                    if let Message::Text(text) = message {
                        let _ = ws.send(Message::text(json!({"echo": text.as_str()}).to_string())).await;
                        if text.as_str() == "fin" {
                            let _ = ws.send(Message::text("done")).await;
                        }
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_websocket_conversation_ends_at_the_awaited_message() {
    let port = echo_server().await;
    let spec = chain(vec![
        start(),
        node(
            "talk",
            "net.websocket",
            json!({"url": format!("ws://127.0.0.1:{port}"), "messages": ["uno", "fin"], "maxMessages": 0, "untilContains": "done", "timeoutSec": 5}),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let data: Vec<Value> = ran.output("talk", 0).iter().map(|m| m["data"].clone()).collect();
    assert_eq!(data, vec![json!({"echo": "uno"}), json!({"echo": "fin"}), json!("done")]);
}

/// Enough of a Socket.IO v4 server (WebSocket transport) for one exchange: it opens, accepts the
/// namespace, acknowledges an event and then emits three — two of them the awaited one.
async fn socketio_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(socket).await else { return };
                let open = r#"0{"sid":"s1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#;
                let _ = ws.send(Message::text(open)).await;
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let text = text.as_str();
                    if text.starts_with("40") {
                        let _ = ws.send(Message::text(r#"40{"sid":"n1"}"#)).await;
                    } else if let Some(rest) = text.strip_prefix("42") {
                        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                        let args: Value = serde_json::from_str(&rest[digits.len()..]).unwrap_or(Value::Null);
                        if !digits.is_empty() {
                            let ack = json!([{"ok": true, "got": args[1]}]);
                            let _ = ws.send(Message::text(format!("43{digits}{ack}"))).await;
                        }
                        for event in [r#"42["pedido:estado",{"n":1}]"#, r#"42["otro",{}]"#, r#"42["pedido:estado",{"n":2}]"#] {
                            let _ = ws.send(Message::text(event)).await;
                        }
                    } else if text.starts_with("41") {
                        break;
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn socketio_emits_waits_for_the_ack_and_collects_the_named_events() {
    let port = socketio_server().await;
    let spec = chain(vec![
        start(),
        node(
            "io",
            "net.socketio",
            json!({
                "url": format!("http://127.0.0.1:{port}"),
                "socketPath": "/socket.io",
                "namespace": "/",
                "version": "v4",
                "event": "pedido:nuevo",
                "payload": "{\"id\": 7}",
                "waitAck": true,
                "listen": "pedido:estado",
                "maxMessages": 2,
                "timeoutSec": 5,
            }),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(
        ran.output("io", 0),
        vec![
            json!({"ack": [{"ok": true, "got": {"id": 7}}]}),
            json!({"event": "pedido:estado", "data": {"n": 1}}),
            json!({"event": "pedido:estado", "data": {"n": 2}}),
        ]
    );
}

// ----------------------------------------------------------------------- live: needs the containers

#[tokio::test]
#[ignore = "needs the Postgres and MySQL containers (see the module docs)"]
async fn live_sql_on_postgres_and_mysql() {
    let pg = sql_flow(
        "pg",
        "CREATE TABLE flujos_pedidos (id INT PRIMARY KEY, cliente TEXT, total NUMERIC(10,2), pagado BOOLEAN)",
        "DROP TABLE IF EXISTS flujos_pedidos",
    );
    let ran = run(pg).await;
    succeeded(&ran);
    // Typed from the server's description of the statement: the text protocol carries no types.
    assert_eq!(
        ran.output("select", 0),
        vec![json!({"id": 1, "cliente": "O'Brien", "total": 10.5, "pagado": true}), json!({"id": 2, "cliente": "Ana", "total": 3.0, "pagado": false})]
    );
    let mysql = sql_flow(
        "mysql",
        "CREATE TABLE flujos_pedidos (id INT PRIMARY KEY, cliente VARCHAR(80), total DECIMAL(10,2), pagado BOOLEAN)",
        "DROP TABLE IF EXISTS flujos_pedidos",
    );
    let ran = run(mysql).await;
    succeeded(&ran);
    // MySQL's BOOLEAN is a TINYINT(1): it reads back as the number it is.
    assert_eq!(
        ran.output("select", 0),
        vec![json!({"id": 1, "cliente": "O'Brien", "total": 10.5, "pagado": 1}), json!({"id": 2, "cliente": "Ana", "total": 3.0, "pagado": 0})]
    );
}

#[tokio::test]
#[ignore = "needs the MongoDB and Redis containers (see the module docs)"]
async fn live_mongo_and_redis() {
    let spec = chain(vec![
        start(),
        node("clear", "data.mongo", json!({"connection": "mongo", "queryText": "db.pedidos.deleteMany({})"})),
        node("insert", "data.mongo", json!({"connection": "mongo", "queryText": "db.pedidos.insertOne({cliente: 'Ana', total: 10})"})),
        node("find", "data.mongo", json!({"connection": "mongo", "queryText": "db.pedidos.find({cliente: 'Ana'})"})),
        node("set", "data.redis", json!({"connection": "redis", "queryText": "SET flujos:clave hola"})),
        node("get", "data.redis", json!({"connection": "redis", "queryText": "GET flujos:clave"})),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let found = ran.output("find", 0);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["cliente"], "Ana", "{found:?}");
    assert_eq!(found[0]["total"], 10);
    let got = serde_json::to_string(&ran.output("get", 0)).unwrap();
    assert!(got.contains("hola"), "{got}");
}

#[tokio::test]
#[ignore = "needs the MQTT broker container (see the module docs)"]
async fn live_mqtt_publish_reaches_a_subscriber() {
    let topic = format!("flujos/prueba/{}", uuid::Uuid::new_v4().simple());
    let spec = flow(
        vec![
            start(),
            node("listen", "net.mqtt", json!({"url": "mqtt://127.0.0.1:51883", "operation": "subscribe", "topic": topic, "maxMessages": 1, "timeoutSec": 10})),
            node("pause", "code.shell", json!({"shell": "auto", "script": "sleep 1", "output": "text"})),
            node("say", "net.mqtt", json!({"url": "mqtt://127.0.0.1:51883", "operation": "publish", "topic": topic, "payload": "{\"t\": 21.5}", "qos": 1})),
        ],
        vec![wire("start", 0, "listen", 0), wire("start", 0, "pause", 0), wire("pause", 0, "say", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("say", 0), vec![json!({"published": true, "topic": topic, "qos": 1})]);
    let heard = ran.output("listen", 0);
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0]["data"], json!({"t": 21.5}));
}

#[tokio::test]
#[ignore = "needs the Mailpit container (see the module docs)"]
async fn live_email_reaches_the_smtp_server() {
    let dir = temp_dir("mail");
    let attachment = dir.join("informe.txt");
    std::fs::write(&attachment, "adjunto").unwrap();
    let subject = format!("Prueba de Flujos {}", uuid::Uuid::new_v4().simple());
    let spec = chain(vec![
        start(),
        node(
            "mail",
            "net.email",
            json!({
                "credential": "mail",
                "to": "equipo@example.com, ana@example.com",
                "cc": "jefa@example.com",
                "subject": subject,
                "body": "<p>Hola <b>equipo</b></p>",
                "html": true,
                "attachments": [attachment.to_string_lossy()],
            }),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("mail", 0)[0]["to"], json!(["equipo@example.com", "ana@example.com"]));
    let listing: Value = reqwest::get("http://127.0.0.1:58025/api/v1/messages").await.unwrap().json().await.unwrap();
    let message = listing["messages"].as_array().unwrap().iter().find(|m| m["Subject"] == json!(subject)).cloned().expect("the email arrived");
    assert_eq!(message["From"]["Address"], "flujos@example.com");
    assert_eq!(message["Attachments"], 1);
    assert_eq!(message["Cc"][0]["Address"], "jefa@example.com");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "needs the grpcbin container (see the module docs)"]
async fn live_grpc_through_server_reflection() {
    let spec = chain(vec![
        start(),
        node(
            "call",
            "net.grpc",
            json!({
                "endpoint": "http://127.0.0.1:59000",
                "source": "reflection",
                "service": "grpcbin.GRPCBin",
                "method": "DummyUnary",
                "message": "{\"f_string\": \"hola\", \"f_int32\": 7}",
                "tls": false,
            }),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let answer = &ran.output("call", 0)[0];
    let text = answer.get("fString").or_else(|| answer.get("f_string")).cloned();
    assert_eq!(text, Some(json!("hola")), "{answer}");
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn live_docker_runs_a_container() {
    let spec = chain(vec![
        start(),
        node(
            "box",
            "code.docker",
            json!({"mode": "runImage", "image": "alpine:3", "args": ["echo", "hola desde docker"], "remove": true, "output": "text"}),
        ),
    ]);
    let ran = run(spec).await;
    succeeded(&ran);
    let out = serde_json::to_string(&ran.output("box", 0)).unwrap();
    assert!(out.contains("hola desde docker"), "{out}");
}

#[tokio::test]
#[ignore = "needs the OpenSSH container and CODEFLOW_TEST_SSH_KEY (see the module docs)"]
async fn live_ssh_runs_a_command_and_sftp_manages_files() {
    let folder = format!("/config/flujos-{}", uuid::Uuid::new_v4().simple());
    // The command on a branch of its own: its output is one item per line, and a file node runs
    // once per item it is given.
    let spec = flow(
        vec![
            start(),
            node("run", "code.ssh", json!({"host": "ssh-test", "command": "echo hola-$((20+1)); uname -s", "output": "lines"})),
            node("mkdir", "net.transfer", json!({"host": "sftp-test", "operation": "mkdir", "remotePath": folder})),
            node("rename", "net.transfer", json!({"host": "sftp-test", "operation": "rename", "remotePath": folder, "newPath": format!("{folder}-b")})),
            node("list", "net.transfer", json!({"host": "sftp-test", "operation": "list", "remotePath": "/config", "prefix": "flujos-"})),
            node("delete", "net.transfer", json!({"host": "sftp-test", "operation": "delete", "remotePath": format!("{folder}-b"), "isFolder": true})),
        ],
        vec![
            wire("start", 0, "run", 0),
            wire("start", 0, "mkdir", 0),
            wire("mkdir", 0, "rename", 0),
            wire("rename", 0, "list", 0),
            wire("list", 0, "delete", 0),
        ],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    let lines = serde_json::to_string(&ran.output("run", 0)).unwrap();
    assert!(lines.contains("hola-21") && lines.contains("Linux"), "{lines}");
    let listed: Vec<String> = ran.output("list", 0).iter().map(|e| e["path"].as_str().unwrap_or_default().to_string()).collect();
    assert!(listed.contains(&format!("{folder}-b")), "{listed:?}");
    assert!(!listed.contains(&folder), "{listed:?}");
    assert_eq!(ran.output("delete", 0), vec![json!({"deleted": format!("{folder}-b")})]);

    // A storage node refuses a file host, and says which node to use.
    let wrong = chain(vec![start(), node("s3", "net.storage", json!({"host": "sftp-test", "operation": "list", "remotePath": "/"}))]);
    let ran = run(wrong).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("SFTP · FTP · SMB"));
}
