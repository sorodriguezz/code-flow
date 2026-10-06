//! n8n workflows into flows.
//!
//! **The core nodes, mapped; everything else kept and said.** A webhook, a schedule, an HTTP
//! request, Code, Set, IF, Switch (every output), Merge (every input), Wait, Loop over items, Filter,
//! Sort, Execute Command, Respond to Webhook become their counterparts here, parameters and all — so
//! do the integrations this app has its own node or connector for (Telegram, Slack, Discord, GitHub,
//! GitLab, Twilio, Gmail, Sheets, Outlook, Excel, RSS, queues, databases, forms) and LangChain's
//! agent, classifier, extractor and summarizer. A node with no counterpart stays in place as a
//! switched-off pass-through named as it was, so the shape of the workflow survives and the user can
//! see what to rebuild; the import lists them.
//!
//! **Expressions pass through.** n8n writes `={{ $json.x }}`, `$('Node').item.json` and
//! `$node["Node"].json` — the same language this engine evaluates. Credentials do not: they are
//! n8n's, and the user picks theirs.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::spec::{self, Connection, FlowNode, FlowSpec, StickyNote};

/// What a conversion gave and what it could not map.
pub struct Converted {
    pub spec: FlowSpec,
    pub name: String,
    /// `Name (type)` of every node kept as a placeholder.
    pub unmapped: Vec<String>,
}

/// Whether `value` is an n8n workflow export.
pub fn is_n8n(value: &Value) -> bool {
    let typed = value.get("nodes").and_then(Value::as_array).is_some_and(|nodes| {
        nodes.iter().any(|node| {
            node.get("type").and_then(Value::as_str).is_some_and(|t| t.starts_with("n8n-nodes-base.") || t.starts_with("@n8n/"))
        })
    });
    typed && value.get("connections").is_some_and(Value::is_object)
}

fn text(params: &Value, key: &str) -> String {
    match params.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn pairs(list: Option<&Value>) -> Value {
    let rows: Vec<Value> = list
        .and_then(Value::as_array)
        .map(|rows| rows.iter().map(|row| json!({"name": text(row, "name"), "value": text(row, "value")})).collect())
        .unwrap_or_default();
    Value::Array(rows)
}

/// A resource-locator parameter (`{ __rl: true, value, mode }`, n8n ≥ 1.0) or a plain one, as text.
fn locator(params: &Value, key: &str) -> String {
    match params.get(key) {
        Some(Value::Object(map)) => map.get("value").map(|v| text(&json!({"v": v}), "v")).unwrap_or_default(),
        _ => text(params, key),
    }
}

/// A connector call (`net.connector`) with its fields.
fn call(connector: &str, operation: &str, fields: Value) -> (&'static str, Value) {
    ("net.connector", json!({"call": {"connector": connector, "operation": operation, "fields": fields}}))
}

/// n8n's condition operators, by their v1 and v2 names, as this engine's.
fn operator(name: &str) -> &'static str {
    match name {
        "equal" | "equals" | "is" => "equals",
        "notEqual" | "notEquals" | "isNot" => "notEquals",
        "contains" => "contains",
        "notContains" => "notContains",
        "startsWith" => "startsWith",
        "notStartsWith" => "notStartsWith",
        "endsWith" => "endsWith",
        "notEndsWith" => "notEndsWith",
        "regex" => "regex",
        "notRegex" => "notRegex",
        "larger" | "gt" | "after" => "gt",
        "largerEqual" | "gte" | "afterOrEquals" => "gte",
        "smaller" | "lt" | "before" => "lt",
        "smallerEqual" | "lte" | "beforeOrEquals" => "lte",
        "isEmpty" | "empty" => "empty",
        "isNotEmpty" | "notEmpty" => "notEmpty",
        "exists" => "exists",
        "notExists" => "notExists",
        "true" => "isTrue",
        "false" => "isFalse",
        "lengthEquals" => "lengthEquals",
        "lengthGt" => "lengthGt",
        "lengthLt" => "lengthLt",
        _ => "equals",
    }
}

/// An IF/Filter condition block of either generation as `{ combinator, ignoreCase, conditions }`.
fn conditions(params: &Value) -> Value {
    let mut rows = Vec::new();
    let mut combinator = "and";
    if let Some(v2) = params.get("conditions").and_then(|c| c.get("conditions")).and_then(Value::as_array) {
        // IF v2: `{ conditions: [{ leftValue, rightValue, operator: { operation } }], combinator }`.
        for row in v2 {
            let op = row.get("operator").and_then(|o| o.get("operation")).and_then(Value::as_str).unwrap_or("equals");
            rows.push(json!({"left": text(row, "leftValue"), "op": operator(op), "right": text(row, "rightValue")}));
        }
        if params.get("conditions").and_then(|c| c.get("combinator")).and_then(Value::as_str) == Some("or") {
            combinator = "or";
        }
    } else if let Some(v1) = params.get("conditions").and_then(Value::as_object) {
        // IF v1: `{ string: [...], number: [...], boolean: [...] }` with `combineOperation`.
        for list in v1.values().filter_map(Value::as_array) {
            for row in list {
                rows.push(json!({"left": text(row, "value1"), "op": operator(&text(row, "operation")), "right": text(row, "value2")}));
            }
        }
        if text(params, "combineOperation") == "any" {
            combinator = "or";
        }
    }
    json!({"combinator": combinator, "ignoreCase": false, "conditions": rows})
}

/// One n8n node as `(type, params)` here, or `None` when there is no counterpart.
fn map_node(kind: &str, version: f64, params: &Value) -> Option<(&'static str, Value)> {
    let short = kind.rsplit('.').next().unwrap_or(kind);
    Some(match short {
        "manualTrigger" => ("trigger.manual", json!({})),
        "scheduleTrigger" | "cron" => {
            let rule = params.get("rule").and_then(|r| r.get("interval")).and_then(Value::as_array).and_then(|list| list.first());
            match rule {
                Some(rule) if text(rule, "field") == "cronExpression" => {
                    ("trigger.schedule", json!({"mode": "cron", "cron": text(rule, "expression")}))
                }
                Some(rule) => {
                    let field = text(rule, "field");
                    let (unit, key) = match field.as_str() {
                        "hours" => ("hours", "hoursInterval"),
                        "days" => ("days", "daysInterval"),
                        "seconds" | "minutes" => ("minutes", "minutesInterval"),
                        _ => ("minutes", "minutesInterval"),
                    };
                    let every = rule.get(key).and_then(Value::as_f64).unwrap_or(1.0).max(1.0);
                    ("trigger.schedule", json!({"mode": "interval", "every": every, "unit": unit}))
                }
                None => ("trigger.schedule", json!({"mode": "interval", "every": 15, "unit": "minutes"})),
            }
        }
        "webhook" => {
            let respond = match text(params, "responseMode").as_str() {
                "lastNode" => "lastNode",
                "responseNode" => "respondNode",
                _ => "immediately",
            };
            let method = text(params, "httpMethod");
            (
                "trigger.webhook",
                json!({"method": if method.is_empty() { "GET".to_string() } else { method }, "hookPath": text(params, "path"), "auth": "none", "respond": respond}),
            )
        }
        "respondToWebhook" => {
            let body = match text(params, "respondWith").as_str() {
                "text" => text(params, "responseBody"),
                "json" => text(params, "responseBody"),
                _ => "={{ JSON.stringify($json) }}".to_string(),
            };
            ("net.respond", json!({"status": params.get("options").and_then(|o| o.get("responseCode")).cloned().unwrap_or(json!(200)), "body": body}))
        }
        "httpRequest" => {
            let method = {
                let m = text(params, "method");
                if m.is_empty() {
                    let older = text(params, "requestMethod");
                    if older.is_empty() { "GET".to_string() } else { older }
                } else {
                    m
                }
            };
            let query = pairs(params.get("queryParameters").and_then(|q| q.get("parameters")));
            let headers = pairs(params.get("headerParameters").and_then(|q| q.get("parameters")));
            let mut out = json!({"method": method, "url": text(params, "url"), "query": query, "headers": headers, "body": "none"});
            if params.get("sendBody").and_then(Value::as_bool) == Some(true) {
                if text(params, "specifyBody") == "json" {
                    out["body"] = json!("json");
                    out["bodyJson"] = json!(text(params, "jsonBody"));
                } else if text(params, "contentType") == "form-urlencoded" {
                    out["body"] = json!("form");
                    out["bodyForm"] = pairs(params.get("bodyParameters").and_then(|b| b.get("parameters")));
                } else {
                    let fields: Map<String, Value> = params
                        .get("bodyParameters")
                        .and_then(|b| b.get("parameters"))
                        .and_then(Value::as_array)
                        .map(|rows| rows.iter().map(|row| (text(row, "name"), json!(text(row, "value")))).collect())
                        .unwrap_or_default();
                    out["body"] = json!("json");
                    out["bodyJson"] = json!(Value::Object(fields).to_string());
                }
            }
            ("net.http", out)
        }
        "code" => {
            let each = text(params, "mode") == "runOnceForEachItem";
            let code = text(params, "jsCode");
            ("code.js", json!({"mode": if each { "each" } else { "all" }, "code": if code.is_empty() { "return $input.all();".to_string() } else { code }}))
        }
        "function" => ("code.js", json!({"mode": "all", "code": text(params, "functionCode")})),
        "functionItem" => ("code.js", json!({"mode": "each", "code": text(params, "functionCode")})),
        "set" => {
            let mut assignments = Vec::new();
            let include;
            if let Some(list) = params.get("assignments").and_then(|a| a.get("assignments")).and_then(Value::as_array) {
                for row in list {
                    assignments.push(json!({"name": text(row, "name"), "type": text(row, "type"), "value": row.get("value").cloned().unwrap_or(Value::Null)}));
                }
                include = if params.get("includeOtherFields").and_then(Value::as_bool) == Some(true) { "all" } else { "none" };
            } else {
                for (kind, rows) in params.get("values").and_then(Value::as_object).into_iter().flatten() {
                    for row in rows.as_array().into_iter().flatten() {
                        assignments.push(json!({"name": text(row, "name"), "type": if kind == "boolean" { "boolean" } else if kind == "number" { "number" } else { "string" }, "value": row.get("value").cloned().unwrap_or(Value::Null)}));
                    }
                }
                include = if params.get("keepOnlySet").and_then(Value::as_bool) == Some(true) { "none" } else { "all" };
            }
            ("transform.set", json!({"mode": "manual", "assignments": assignments, "include": include}))
        }
        "if" => ("logic.if", json!({"conditions": conditions(params)})),
        "filter" => ("transform.filter", json!({"conditions": conditions(params)})),
        "switch" => {
            // Every output kept: the cases become as many ports, n8n's fallback the "other" one.
            if text(params, "mode") == "expression" {
                let outputs = params.get("numberOutputs").and_then(Value::as_f64).unwrap_or(4.0).clamp(1.0, 20.0);
                return Some(("logic.switch", json!({"mode": "expression", "output": text(params, "output"), "caseCount": outputs})));
            }
            let mut rules = Vec::new();
            if let Some(values) = params.get("rules").and_then(|r| r.get("values")).and_then(Value::as_array) {
                // v3: a condition block per output.
                for (index, rule) in values.iter().enumerate() {
                    let block = conditions(rule);
                    if let Some(first) = block["conditions"].get(0) {
                        rules.push(json!({"output": index, "left": first["left"], "op": first["op"], "right": first["right"]}));
                    }
                }
            } else if let Some(old) = params.get("rules").and_then(|r| r.get("rules")).and_then(Value::as_array) {
                // v1/v2: one value compared against each rule, which names its output.
                let left = text(params, "value1");
                for row in old {
                    let output = row.get("output").and_then(Value::as_u64).unwrap_or(0);
                    rules.push(json!({"output": output, "left": left, "op": operator(&text(row, "operation")), "right": text(row, "value2")}));
                }
            }
            let cases = rules.iter().filter_map(|rule| rule["output"].as_u64()).max().map_or(1, |last| last + 1).clamp(1, 20);
            ("logic.switch", json!({"mode": "rules", "rules": rules, "caseCount": cases}))
        }
        "merge" => {
            let mode = match text(params, "mode").as_str() {
                "combine" => match (text(params, "combinationMode").as_str(), text(params, "combineBy").as_str()) {
                    ("mergeByPosition", _) | (_, "combineByPosition") => "position",
                    _ => "field",
                },
                "mergeByKey" | "combineByFields" => "field",
                "mergeByIndex" | "combineByPosition" => "position",
                "chooseBranch" => "choose",
                _ => "append",
            };
            let inputs = params.get("numberInputs").and_then(Value::as_f64).unwrap_or(2.0).clamp(2.0, 10.0);
            let mut out = json!({"mode": mode, "inputCount": inputs});
            match mode {
                "choose" => {
                    let chosen = params.get("useDataOfInput").and_then(Value::as_u64).unwrap_or_else(|| if text(params, "output") == "input2" { 2 } else { 1 });
                    out["choose"] = json!(format!("input{}", chosen.clamp(1, 10)));
                }
                "field" => {
                    let pair = params
                        .get("mergeByFields")
                        .and_then(|m| m.get("values"))
                        .and_then(Value::as_array)
                        .and_then(|rows| rows.first())
                        .map(|row| (text(row, "field1"), text(row, "field2")));
                    let (first, second) = match pair {
                        Some(pair) => pair,
                        None if !text(params, "fieldsToMatchString").is_empty() => {
                            let field = text(params, "fieldsToMatchString").split(',').next().unwrap_or_default().trim().to_string();
                            (field.clone(), field)
                        }
                        None => (text(params, "propertyName1"), text(params, "propertyName2")),
                    };
                    out["field1"] = json!(first);
                    out["field2"] = json!(second);
                    out["join"] = json!(match text(params, "joinMode").as_str() {
                        "keepEverything" => "outer",
                        "enrichInput1" => "left",
                        _ => "inner",
                    });
                }
                _ => {}
            }
            ("logic.merge", out)
        }
        "wait" => match text(params, "resume").as_str() {
            "webhook" => ("logic.wait", json!({"mode": "webhook"})),
            "specificTime" => ("logic.wait", json!({"mode": "until", "until": text(params, "dateTime")})),
            _ => {
                let unit = match text(params, "unit").as_str() {
                    "minutes" => "minutes",
                    "hours" => "hours",
                    "days" => "days",
                    _ => "seconds",
                };
                ("logic.wait", json!({"mode": "duration", "amount": params.get("amount").cloned().unwrap_or(json!(1)), "unit": unit}))
            }
        },
        "splitInBatches" => ("logic.loop", json!({"batchSize": params.get("batchSize").cloned().unwrap_or(json!(10))})),
        "sort" => {
            let keys: Vec<Value> = params
                .get("sortFieldsUi")
                .and_then(|s| s.get("sortField"))
                .and_then(Value::as_array)
                .map(|rows| rows.iter().map(|row| json!({"field": text(row, "fieldName"), "order": if text(row, "order") == "descending" { "desc" } else { "asc" }})).collect())
                .unwrap_or_default();
            ("transform.sort", json!({"mode": "fields", "keys": keys}))
        }
        "removeDuplicates" => ("transform.dedupe", json!({})),
        "splitOut" | "itemLists" => ("transform.split", json!({"field": text(params, "fieldToSplitOut")})),
        "aggregate" => ("transform.aggregate", json!({})),
        "noOp" => ("transform.set", json!({})),
        "stopAndError" => ("logic.stop", json!({"message": text(params, "errorMessage")})),
        "executeCommand" => ("code.shell", json!({"shell": "auto", "script": text(params, "command"), "output": "auto"})),
        "executeWorkflow" => ("logic.subflow", json!({"flow": "", "mode": "wait"})),
        "executeWorkflowTrigger" => ("trigger.subflow", json!({})),
        "errorTrigger" => ("trigger.error", json!({})),
        "emailSend" => (
            "net.email",
            json!({"to": text(params, "toEmail"), "from": text(params, "fromEmail"), "subject": text(params, "subject"), "body": text(params, "text")}),
        ),
        "readWriteFile" => {
            let write = text(params, "operation") == "write";
            ("files.file", json!({"operation": if write { "write" } else { "read" }, "path": text(params, "fileName")}))
        }
        "formTrigger" => {
            // n8n's form fields as the manual trigger's: what a run asks for before it starts.
            let fields: Vec<Value> = params
                .get("formFields")
                .and_then(|f| f.get("values"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, field)| {
                    let label = text(field, "fieldLabel");
                    let kind = match text(field, "fieldType").as_str() {
                        "number" => "number",
                        "textarea" => "longText",
                        "date" => "date",
                        "dropdown" => "select",
                        "checkbox" => "boolean",
                        _ => "text",
                    };
                    let options: Vec<String> =
                        field.get("fieldOptions").and_then(|o| o.get("values")).and_then(Value::as_array).into_iter().flatten().map(|o| text(o, "option")).collect();
                    let name: String = label.chars().filter(|c| c.is_alphanumeric()).collect();
                    json!({
                        "name": if name.is_empty() { format!("campo{}", index + 1) } else { name },
                        "label": label,
                        "type": kind,
                        "required": field.get("requiredField").and_then(Value::as_bool).unwrap_or(false),
                        "options": options.join(", "),
                    })
                })
                .collect();
            ("trigger.manual", json!({"fields": fields}))
        }
        "rssFeedRead" => ("net.feed", json!({"feedUrl": text(params, "url"), "entryLimit": 20})),
        "rssFeedReadTrigger" => ("trigger.feed", json!({"feedUrl": text(params, "feedUrl"), "intervalMin": 15})),
        "telegramTrigger" => ("trigger.bot", json!({"platform": "botTelegram", "chats": "", "textFilter": "", "commandsOnly": false})),
        "slackTrigger" => ("trigger.bot", json!({"platform": "botSlack", "chats": locator(params, "channelId"), "textFilter": "", "commandsOnly": false})),
        "localFileTrigger" => {
            let events: Vec<&str> = params
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|event| match event {
                    "change" => "modified",
                    "unlink" | "unlinkDir" => "deleted",
                    _ => "created",
                })
                .collect();
            ("trigger.file", json!({"watchPath": text(params, "path"), "events": if events.is_empty() { vec!["created"] } else { events }}))
        }
        "rabbitmqTrigger" => ("trigger.queue", json!({"broker": "rabbitmq", "queueName": text(params, "queue")})),
        "kafkaTrigger" => ("trigger.queue", json!({"broker": "kafka", "topic": text(params, "topic")})),
        "awsSqsTrigger" => ("trigger.queue", json!({"broker": "sqs", "queueUrl": text(params, "queue")})),
        "postgresTrigger" => match text(params, "triggerMode").as_str() {
            "listenTrigger" => ("trigger.db", json!({"dbEvent": "pgNotify", "channels": text(params, "channelName")})),
            _ => ("trigger.db", json!({"dbEvent": "newRow", "table": locator(params, "tableName"), "watermark": "id"})),
        },
        "redisTrigger" => ("trigger.db", json!({"dbEvent": "redisChannel", "channels": text(params, "channels")})),
        "ssh" => ("code.ssh", json!({"command": text(params, "command")})),
        "postgres" | "mySql" | "microsoftSql" if matches!(text(params, "operation").as_str(), "executeQuery" | "") => {
            ("data.sql", json!({"queryText": text(params, "query")}))
        }
        "mongoDb" if matches!(text(params, "operation").as_str(), "find" | "") => {
            let query = text(params, "query");
            ("data.mongo", json!({"queryText": format!("db.{}.find({})", text(params, "collection"), if query.trim().is_empty() { "{}" } else { query.trim() })}))
        }
        "crypto" if matches!(text(params, "action").as_str(), "hash" | "hmac" | "") => (
            "transform.crypto",
            json!({"operation": if text(params, "action") == "hmac" { "hmac" } else { "hash" }, "value": text(params, "value"), "algorithm": text(params, "type").to_ascii_lowercase().replace("sha-", "sha")}),
        ),
        // Integrations this app has a connector for: the common action of each.
        "telegram" if matches!(text(params, "operation").as_str(), "sendMessage" | "") => {
            call("telegram", "sendMessage", json!({"chat_id": text(params, "chatId"), "text": text(params, "text")}))
        }
        "slack" if matches!(text(params, "operation").as_str(), "post" | "") => {
            let channel = if params.get("channelId").is_some() { locator(params, "channelId") } else { text(params, "channel") };
            call("slack", "postMessage", json!({"channel": channel, "text": text(params, "text")}))
        }
        "discord" => call("discord", "webhookMessage", json!({"content": text(params, "content"), "username": text(params, "username")})),
        "mattermost" if matches!(text(params, "operation").as_str(), "post" | "") => {
            call("mattermost", "sendMessage", json!({"text": text(params, "message"), "channel": text(params, "channelId")}))
        }
        "github" if matches!(text(params, "operation").as_str(), "create" | "") && matches!(text(params, "resource").as_str(), "issue" | "") => call(
            "github",
            "createIssue",
            json!({"owner": locator(params, "owner"), "repo": locator(params, "repository"), "title": text(params, "title"), "body": text(params, "body")}),
        ),
        "gitlab" if matches!(text(params, "operation").as_str(), "create" | "") && matches!(text(params, "resource").as_str(), "issue" | "") => call(
            "gitlab",
            "createIssue",
            json!({"project": format!("{}/{}", text(params, "owner"), text(params, "repository")), "title": text(params, "title"), "description": text(params, "body")}),
        ),
        "twilio" => {
            let whatsapp = params.get("toWhatsapp").and_then(Value::as_bool) == Some(true);
            call(
                "twilio",
                if whatsapp { "sendWhatsApp" } else { "sendSms" },
                json!({"from": text(params, "from"), "to": text(params, "to"), "body": text(params, "message")}),
            )
        }
        "pushover" => call("pushover", "send", json!({"message": text(params, "message"), "priority": text(params, "priority")})),
        "gmail" => match text(params, "operation").as_str() {
            "getAll" => ("net.google", json!({"service": "gmail", "gmailOp": "gmailSearch", "gmailQuery": params.get("filters").map(|f| text(f, "q")).unwrap_or_default()})),
            "get" => ("net.google", json!({"service": "gmail", "gmailOp": "gmailGet", "messageId": text(params, "messageId")})),
            "markAsRead" => ("net.google", json!({"service": "gmail", "gmailOp": "gmailMarkRead", "messageId": text(params, "messageId")})),
            _ => ("net.google", json!({"service": "gmail", "gmailOp": "gmailSend", "to": text(params, "sendTo"), "subject": text(params, "subject"), "body": text(params, "message")})),
        },
        "googleSheets" => {
            let op = match text(params, "operation").as_str() {
                "append" => "sheetsAppend",
                "update" | "appendOrUpdate" => "sheetsUpdate",
                _ => "sheetsRead",
            };
            let mut out = json!({"service": "sheets", "sheetsOp": op, "spreadsheetId": locator(params, "documentId"), "sheetRange": locator(params, "sheetName")});
            if op == "sheetsUpdate" {
                out["matchColumn"] = json!(text(params, "columnToMatchOn"));
                out["ifMissing"] = json!(if text(params, "operation") == "appendOrUpdate" { "appendRow" } else { "skipRow" });
            }
            ("net.google", out)
        }
        "microsoftOutlook" => match text(params, "operation").as_str() {
            "getAll" => ("net.microsoft", json!({"service": "outlook", "outlookOp": "outlookSearch"})),
            "get" => ("net.microsoft", json!({"service": "outlook", "outlookOp": "outlookGet", "messageId": locator(params, "messageId")})),
            "move" => ("net.microsoft", json!({"service": "outlook", "outlookOp": "outlookMove", "messageId": locator(params, "messageId"), "targetMailbox": locator(params, "folderId")})),
            _ => (
                "net.microsoft",
                json!({"service": "outlook", "outlookOp": "outlookSend", "to": text(params, "toRecipients"), "subject": text(params, "subject"), "body": text(params, "bodyContent")}),
            ),
        },
        "microsoftExcel" => {
            let op = match text(params, "operation").as_str() {
                "append" | "addTable" => "excelAppend",
                "update" | "upsert" => "excelUpdate",
                _ => "excelRead",
            };
            ("net.microsoft", json!({"service": "excel", "excelOp": op, "workbook": locator(params, "workbook"), "worksheet": locator(params, "worksheet")}))
        }
        // LangChain's nodes that stand alone: their language model sub-node becomes the engine picker.
        "agent" | "chainLlm" => {
            let prompt = text(params, "text");
            ("ai.agent", json!({"prompt": if prompt.is_empty() { "={{ $json.chatInput }}".to_string() } else { prompt }}))
        }
        "chainSummarization" => ("ai.summarize", json!({})),
        "textClassifier" => {
            let categories: Vec<Value> = params
                .get("categories")
                .and_then(|c| c.get("categories"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|c| json!({"name": text(c, "category"), "description": text(c, "description")}))
                .collect();
            ("ai.classify", json!({"text": text(params, "inputText"), "categories": categories, "routing": "routeBranch", "allowOther": params.get("options").and_then(|o| o.get("fallback")).and_then(Value::as_str) == Some("other")}))
        }
        "informationExtractor" => {
            let fields: Vec<Value> = params
                .get("attributes")
                .and_then(|a| a.get("attributes"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|a| {
                    let kind = text(a, "type");
                    let kind = if kind.is_empty() { "string".to_string() } else { kind };
                    json!({"name": text(a, "name"), "type": kind, "description": text(a, "description"), "required": a.get("required").and_then(Value::as_bool).unwrap_or(false)})
                })
                .collect();
            ("ai.extract", json!({"text": text(params, "text"), "schemaFields": fields}))
        }
        "sentimentAnalysis" => (
            "ai.classify",
            json!({"text": text(params, "inputText"), "categories": [{"name": "Positive", "description": ""}, {"name": "Neutral", "description": ""}, {"name": "Negative", "description": ""}]}),
        ),
        _ => {
            let _ = version;
            return None;
        }
    })
}

/// A node id that is valid here and unique: n8n's own when it has one, a counter otherwise.
/// n8n's seven sticky colours (`parameters.color`; 1, or none, is its yellow) as the nearest of the
/// app's palette — its yellow is the default here too.
fn sticky_colour(params: &Value) -> &'static str {
    match params.get("color").and_then(Value::as_u64) {
        Some(2) => "#f97316",
        Some(3) => "#ef4444",
        Some(4) => "#22c55e",
        Some(5) => "#3b82f6",
        Some(6) => "#8b5cf6",
        Some(7) => "#64748b",
        _ => "",
    }
}

fn node_id(raw: Option<&str>, taken: &mut HashSet<String>, counter: &mut usize) -> String {
    let base: String = raw.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(36).collect();
    let mut id = if base.is_empty() {
        *counter += 1;
        format!("n{counter}")
    } else {
        base
    };
    while !taken.insert(id.clone()) {
        *counter += 1;
        id = format!("n{counter}");
    }
    id
}

pub fn convert(value: &Value) -> Result<Converted, String> {
    let name = value.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut nodes = Vec::new();
    let mut notes = Vec::new();
    let mut unmapped = Vec::new();
    let mut by_name: HashMap<String, (String, &'static str, f64)> = HashMap::new();
    let mut taken = HashSet::new();
    let mut counter = 0usize;
    for raw in value.get("nodes").and_then(Value::as_array).into_iter().flatten() {
        let kind = raw.get("type").and_then(Value::as_str).unwrap_or_default();
        let params = raw.get("parameters").cloned().unwrap_or_else(|| json!({}));
        let position = raw.get("position").and_then(Value::as_array);
        let pos = [
            position.and_then(|p| p.first()).and_then(Value::as_f64).unwrap_or(0.0),
            position.and_then(|p| p.get(1)).and_then(Value::as_f64).unwrap_or(0.0),
        ];
        let node_name = raw.get("name").and_then(Value::as_str).unwrap_or("Nodo").to_string();
        if kind.ends_with(".stickyNote") {
            let width = params.get("width").and_then(Value::as_f64).unwrap_or(240.0);
            let height = params.get("height").and_then(Value::as_f64).unwrap_or(120.0);
            notes.push(StickyNote {
                id: format!("note{}", notes.len() + 1),
                pos,
                size: [width, height],
                text: text(&params, "content"),
                color: sticky_colour(&params).to_string(),
            });
            continue;
        }
        let version = raw.get("typeVersion").and_then(Value::as_f64).unwrap_or(1.0);
        let id = node_id(raw.get("id").and_then(Value::as_str), &mut taken, &mut counter);
        let (type_id, mapped, disabled) = match map_node(kind, version, &params) {
            Some((type_id, mapped)) => (type_id, mapped, raw.get("disabled").and_then(Value::as_bool).unwrap_or(false)),
            None => {
                unmapped.push(format!("{node_name} ({kind})"));
                // Kept in place, switched off: a switched-off node passes its items through.
                ("transform.set", json!({}), true)
            }
        };
        by_name.insert(node_name.clone(), (id.clone(), type_id, version));
        nodes.push(FlowNode { id, type_id: type_id.to_string(), name: node_name, pos, params: mapped, settings: json!({}), disabled });
    }
    let mut connections = Vec::new();
    for (from_name, outputs) in value.get("connections").and_then(Value::as_object).into_iter().flatten() {
        let Some((from, from_type, version)) = by_name.get(from_name).cloned() else { continue };
        for (out, targets) in outputs.get("main").and_then(Value::as_array).into_iter().flatten().enumerate() {
            // n8n's "Loop Over Items" (v3) puts "done" first and "loop" second; here it is the other way.
            let out = if from_type == "logic.loop" && version >= 3.0 { 1 - out.min(1) } else { out };
            for target in targets.as_array().into_iter().flatten() {
                let Some((to, ..)) = target.get("node").and_then(Value::as_str).and_then(|n| by_name.get(n)) else { continue };
                let input = target.get("index").and_then(Value::as_u64).unwrap_or(0);
                connections.push(Connection { from: from.clone(), out: out as u8, to: to.clone(), input: input as u8 });
            }
        }
    }
    // Wires to ports a counterpart does not have (a fifth Switch output) are dropped rather than refused.
    connections.retain(|wire| {
        let outputs = nodes.iter().find(|n| n.id == wire.from).map(super::run::output_count).unwrap_or(1);
        wire.out < outputs
    });
    let spec = FlowSpec { schema: 1, nodes, connections, notes, settings: json!({}) };
    spec::validate(&spec)?;
    Ok(Converted { spec, name, unmapped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow() -> Value {
        json!({
            "name": "Pedidos a Slack",
            "nodes": [
                {"id": "a1", "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 0],
                 "parameters": {"httpMethod": "POST", "path": "pedidos", "responseMode": "lastNode"}},
                {"id": "a2", "name": "Grandes", "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [200, 0],
                 "parameters": {"conditions": {"combinator": "and", "conditions": [{"leftValue": "={{ $json.body.total }}", "rightValue": 100, "operator": {"type": "number", "operation": "gt"}}]}}},
                {"id": "a3", "name": "Marcar", "type": "n8n-nodes-base.set", "typeVersion": 3.4, "position": [400, 0],
                 "parameters": {"assignments": {"assignments": [{"id": "x", "name": "grande", "value": true, "type": "boolean"}]}, "includeOtherFields": true}},
                {"id": "a4", "name": "HubSpot", "type": "n8n-nodes-base.hubspot", "typeVersion": 2, "position": [600, 0], "parameters": {"resource": "deal"}},
                {"id": "a5", "name": "Lotes", "type": "n8n-nodes-base.splitInBatches", "typeVersion": 3, "position": [400, 200], "parameters": {"batchSize": 5}},
                {"id": "a6", "name": "Llamar", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [600, 200],
                 "parameters": {"method": "POST", "url": "https://api.example.com/x", "sendBody": true, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json) }}"}},
                {"id": "a7", "name": "Nota", "type": "n8n-nodes-base.stickyNote", "position": [0, 300], "parameters": {"content": "Hola", "width": 300, "height": 100, "color": 5}},
            ],
            "connections": {
                "Webhook": {"main": [[{"node": "Grandes", "type": "main", "index": 0}]]},
                "Grandes": {"main": [[{"node": "Marcar", "type": "main", "index": 0}], [{"node": "Lotes", "type": "main", "index": 0}]]},
                "Marcar": {"main": [[{"node": "HubSpot", "type": "main", "index": 0}]]},
                "Lotes": {"main": [[], [{"node": "Llamar", "type": "main", "index": 0}]]},
                "Llamar": {"main": [[{"node": "Lotes", "type": "main", "index": 0}]]},
            },
        })
    }

    #[test]
    fn core_nodes_map_and_the_rest_are_kept_switched_off() {
        let value = workflow();
        assert!(is_n8n(&value));
        let converted = convert(&value).unwrap();
        assert_eq!(converted.name, "Pedidos a Slack");
        assert_eq!(converted.unmapped, vec!["HubSpot (n8n-nodes-base.hubspot)"]);
        let node = |name: &str| converted.spec.nodes.iter().find(|n| n.name == name).unwrap().clone();
        assert_eq!(node("Webhook").type_id, "trigger.webhook");
        assert_eq!(node("Webhook").params["respond"], "lastNode");
        assert_eq!(node("Grandes").params["conditions"]["conditions"][0], json!({"left": "={{ $json.body.total }}", "op": "gt", "right": "100"}));
        assert_eq!(node("Marcar").params["include"], "all");
        assert!(node("HubSpot").disabled);
        assert_eq!(node("Lotes").type_id, "logic.loop");
        assert_eq!(node("Llamar").params["bodyJson"], "={{ JSON.stringify($json) }}");
        assert_eq!(converted.spec.notes.len(), 1);
        assert_eq!(converted.spec.notes[0].color, "#3b82f6", "n8n's blue sticky stays blue");
        // The loop's "loop" output is its first here, n8n's second.
        let wire = converted.spec.connections.iter().find(|w| w.from == node("Lotes").id).unwrap();
        assert_eq!((wire.out, wire.to.clone()), (0, node("Llamar").id));
    }

    #[test]
    fn every_switch_output_and_merge_input_survives_and_integrations_find_their_node() {
        let value = json!({
            "name": "Rutas",
            "nodes": [
                {"id": "t", "name": "Form", "type": "n8n-nodes-base.formTrigger", "typeVersion": 2, "position": [0, 0],
                 "parameters": {"formFields": {"values": [{"fieldLabel": "Cliente", "requiredField": true}, {"fieldLabel": "Prioridad", "fieldType": "dropdown", "fieldOptions": {"values": [{"option": "alta"}, {"option": "baja"}]}}]}}},
                {"id": "s", "name": "Ruteo", "type": "n8n-nodes-base.switch", "typeVersion": 3, "position": [200, 0],
                 "parameters": {"rules": {"values": [
                     {"conditions": {"conditions": [{"leftValue": "={{ $json.p }}", "rightValue": "a", "operator": {"operation": "equals"}}]}},
                     {"conditions": {"conditions": [{"leftValue": "={{ $json.p }}", "rightValue": "b", "operator": {"operation": "equals"}}]}},
                     {"conditions": {"conditions": [{"leftValue": "={{ $json.p }}", "rightValue": "c", "operator": {"operation": "equals"}}]}},
                     {"conditions": {"conditions": [{"leftValue": "={{ $json.p }}", "rightValue": "d", "operator": {"operation": "equals"}}]}},
                     {"conditions": {"conditions": [{"leftValue": "={{ $json.p }}", "rightValue": "e", "operator": {"operation": "equals"}}]}}
                 ]}, "options": {"fallbackOutput": "extra"}}},
                {"id": "m", "name": "Junta", "type": "n8n-nodes-base.merge", "typeVersion": 3, "position": [400, 0], "parameters": {"numberInputs": 3}},
                {"id": "tg", "name": "Avisar", "type": "n8n-nodes-base.telegram", "typeVersion": 1.2, "position": [600, 0], "parameters": {"chatId": "123", "text": "={{ $json.p }}"}},
                {"id": "gh", "name": "Issue", "type": "n8n-nodes-base.github", "typeVersion": 1.1, "position": [600, 200],
                 "parameters": {"owner": {"__rl": true, "value": "acme", "mode": "name"}, "repository": {"__rl": true, "value": "app", "mode": "name"}, "title": "Falla"}},
                {"id": "cl", "name": "Clasificar", "type": "@n8n/n8n-nodes-langchain.textClassifier", "typeVersion": 1, "position": [800, 0],
                 "parameters": {"inputText": "={{ $json.text }}", "categories": {"categories": [{"category": "cobros", "description": "pagos"}, {"category": "errores"}]}}}
            ],
            "connections": {
                "Form": {"main": [[{"node": "Ruteo", "type": "main", "index": 0}]]},
                "Ruteo": {"main": [[{"node": "Junta", "type": "main", "index": 0}], [{"node": "Junta", "type": "main", "index": 1}], [], [], [{"node": "Junta", "type": "main", "index": 2}], [{"node": "Avisar", "type": "main", "index": 0}]]},
                "Junta": {"main": [[{"node": "Issue", "type": "main", "index": 0}]]}
            }
        });
        let converted = convert(&value).unwrap();
        assert!(converted.unmapped.is_empty(), "{:?}", converted.unmapped);
        let node = |name: &str| converted.spec.nodes.iter().find(|n| n.name == name).unwrap().clone();
        assert_eq!(node("Form").params["fields"][1], json!({"name": "Prioridad", "label": "Prioridad", "type": "select", "required": false, "options": "alta, baja"}));
        assert_eq!(node("Ruteo").params["caseCount"], 5);
        assert_eq!(node("Junta").params["inputCount"], 3.0);
        assert_eq!(node("Avisar").params["call"], json!({"connector": "telegram", "operation": "sendMessage", "fields": {"chat_id": "123", "text": "={{ $json.p }}"}}));
        assert_eq!(node("Issue").params["call"]["fields"]["owner"], "acme", "a resource locator reads as its value");
        assert_eq!(node("Clasificar").type_id, "ai.classify");
        assert_eq!(node("Clasificar").params["categories"][0], json!({"name": "cobros", "description": "pagos"}));
        let wires = |from: &str| converted.spec.connections.iter().filter(|w| w.from == node(from).id).map(|w| (w.out, w.input)).collect::<Vec<_>>();
        assert_eq!(wires("Ruteo"), vec![(0, 0), (1, 1), (4, 2), (5, 0)], "the fifth case and the fallback keep their wires");
    }

    #[test]
    fn anything_else_is_not_n8n() {
        assert!(!is_n8n(&json!({"schema": 1, "nodes": []})));
        assert!(!is_n8n(&json!({"nodes": [{"type": "n8n-nodes-base.set"}]})), "no connections object");
    }
}
