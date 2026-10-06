import type { TranslationKey } from "../i18n/translations";
import type { FlowConnection, FlowNodeSpec, FlowSpec } from "./spec";

/**
 * Flows to start from — each one a working shape the user fills in (a URL, a repository, a table)
 * rather than an empty canvas. Built when used, so node names come out in the language of the moment.
 *
 * Like an import, a template that runs code arrives **not reviewed**: it is the app's text, but the
 * point of the review is that nothing runs a command nobody looked at.
 */
export interface FlowTemplate {
  id: string;
  /** The node type whose glyph stands for the template. */
  icon: string;
  build: (t: (key: TranslationKey) => string) => FlowSpec;
}

type Translate = (key: TranslationKey) => string;

function node(id: string, type: string, name: string, x: number, y: number, params: Record<string, unknown> = {}): FlowNodeSpec {
  return { id, type, name, pos: [x, y], params, settings: {}, disabled: false };
}

function wire(from: string, to: string, out = 0, input = 0): FlowConnection {
  return { from, out, to, in: input };
}

function flow(nodes: FlowNodeSpec[], connections: FlowConnection[]): FlowSpec {
  return { schema: 1, nodes, connections, notes: [], settings: {} };
}

const n = (t: Translate, key: string) => t(`flows.tpl.node.${key}` as TranslationKey);

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "webhookNotify",
    icon: "trigger.webhook",
    build: (t) =>
      flow(
        [
          node("hook", "trigger.webhook", n(t, "webhook"), 0, 0, { method: "POST", hookPath: "avisos", auth: "none", respond: "immediately" }),
          node("notify", "app.notify", n(t, "notify"), 260, 0, { title: "={{ $json.body.title || 'Aviso' }}", body: "={{ $json.body.message }}" }),
        ],
        [wire("hook", "notify")],
      ),
  },
  {
    id: "hourlyCheck",
    icon: "net.http",
    build: (t) =>
      flow(
        [
          node("every", "trigger.schedule", n(t, "everyHour"), 0, 0, { mode: "interval", every: 1, unit: "hours" }),
          node("status", "net.http", n(t, "status"), 260, 0, { method: "GET", url: "https://api.example.com/status" }),
          node("down", "logic.if", n(t, "notOk"), 520, 0, {
            conditions: { combinator: "and", ignoreCase: false, conditions: [{ left: "={{ $json.status }}", op: "notEquals", right: "ok" }] },
          }),
          node("notify", "app.notify", n(t, "notify"), 780, -60, { title: n(t, "apiDown"), body: "={{ JSON.stringify($json) }}" }),
        ],
        [wire("every", "status"), wire("status", "down"), wire("down", "notify", 0)],
      ),
  },
  {
    id: "commitSummary",
    icon: "ai.summarize",
    build: (t) =>
      flow(
        [
          node("evening", "trigger.schedule", n(t, "weekdays18"), 0, 0, { mode: "times", at: ["18:00"], days: ["mon", "tue", "wed", "thu", "fri"] }),
          node("log", "files.git", n(t, "todaysCommits"), 260, 0, { operation: "log", maxCount: 50 }),
          node("join", "transform.aggregate", n(t, "together"), 520, 0, {}),
          node("summary", "ai.summarize", n(t, "summary"), 780, 0, { text: "={{ JSON.stringify($json) }}", summaryStyle: "bullets" }),
          node("note", "app.note", n(t, "toNote"), 1040, 0, { operation: "create", title: "={{ 'Commits ' + $now.toFormat('yyyy-LL-dd') }}", content: "={{ $json.summary }}" }),
        ],
        [wire("evening", "log"), wire("log", "join"), wire("join", "summary"), wire("summary", "note")],
      ),
  },
  {
    id: "csvBatches",
    icon: "logic.loop",
    build: (t) =>
      flow(
        [
          node("start", "trigger.manual", n(t, "manual"), 0, 0),
          node("sheet", "data.sheet", n(t, "readCsv"), 260, 0, { operation: "read", path: "~/Documentos/pedidos.csv", header: true }),
          node("batches", "logic.loop", n(t, "batches"), 520, 0, { batchSize: 50 }),
          node("send", "net.http", n(t, "sendBatch"), 780, -40, {
            method: "POST",
            url: "https://api.example.com/import",
            body: "json",
            bodyJson: "={{ JSON.stringify($input.all().map((it) => it.json)) }}",
          }),
          node("done", "app.notify", n(t, "notify"), 780, 120, { title: n(t, "imported"), body: "={{ $input.all().length + ' items' }}" }),
        ],
        [wire("start", "sheet"), wire("sheet", "batches"), wire("batches", "send", 0), wire("send", "batches"), wire("batches", "done", 1)],
      ),
  },
  {
    id: "approveDeploy",
    icon: "logic.approval",
    build: (t) =>
      flow(
        [
          node("start", "trigger.manual", n(t, "manual"), 0, 0),
          node("ask", "logic.approval", n(t, "approve"), 260, 0, { message: n(t, "approveMessage"), timeoutHours: 4, onTimeout: "reject" }),
          node("deploy", "code.shell", n(t, "deploy"), 520, -60, { shell: "auto", script: "echo \"deploy\"", output: "auto" }),
          node("rejected", "app.notify", n(t, "notify"), 520, 100, { title: n(t, "rejected"), body: "={{ $json.approval.comment }}" }),
        ],
        [wire("start", "ask"), wire("ask", "deploy", 0), wire("ask", "rejected", 1)],
      ),
  },
  {
    id: "tableBackup",
    icon: "data.sql",
    build: (t) =>
      flow(
        [
          node("night", "trigger.schedule", n(t, "nightly"), 0, 0, { mode: "times", at: ["03:00"], days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }),
          node("rows", "data.sql", n(t, "readTable"), 260, 0, { queryText: "SELECT * FROM pedidos", runFor: "once" }),
          node("csv", "transform.convert", n(t, "toCsv"), 520, 0, { operation: "toCsv", allItems: true, header: true }),
          node("write", "files.file", n(t, "writeFile"), 780, 0, {
            operation: "write",
            path: "={{ '~/Respaldos/pedidos-' + $now.toFormat('yyyy-LL-dd') + '.csv' }}",
            content: "={{ $json.csv }}",
            createFolders: true,
          }),
        ],
        [wire("night", "rows"), wire("rows", "csv"), wire("csv", "write")],
      ),
  },
  {
    id: "prReview",
    icon: "ai.prReview",
    build: (t) =>
      flow(
        [
          node("opened", "trigger.pr", n(t, "prOpened"), 0, 0, { event: "opened", intervalSec: 120 }),
          // CodeFlow's own PR analyzer: its findings published on the PR, its summary as a comment.
          node("review", "ai.prReview", n(t, "review"), 260, 0, { source: "project", prId: "={{ $json.id }}", level: "completo", publish: "findingsAndSummary", minSeverity: "warning" }),
        ],
        [wire("opened", "review")],
      ),
  },
  {
    id: "rereviewOnPush",
    icon: "trigger.pr",
    build: (t) =>
      flow(
        [
          node("pushed", "trigger.pr", n(t, "newCommits"), 0, 0, { event: "prUpdated", intervalSec: 120 }),
          node("review", "ai.prReview", n(t, "review"), 260, 0, { source: "project", prId: "={{ $json.id }}", level: "completo", force: true, publish: "findings", minSeverity: "warning" }),
          node("notify", "app.notify", n(t, "notify"), 520, 0, { title: n(t, "reviewed"), body: "={{ $('" + n(t, "newCommits") + "').item.json.title }}" }),
        ],
        [wire("pushed", "review"), wire("review", "notify")],
      ),
  },
  {
    id: "telegramBot",
    icon: "trigger.bot",
    build: (t) =>
      flow(
        [
          node("bot", "trigger.bot", n(t, "bot"), 0, 0, { platform: "botTelegram", chats: "", textFilter: "", commandsOnly: false }),
          node("answer", "ai.agent", n(t, "answer"), 260, 0, { prompt: "={{ $json.text }}", workIn: "temp", access: "readOnly", output: "text" }),
          node("reply", "net.connector", n(t, "reply"), 520, 0, {
            call: { connector: "telegram", operation: "sendMessage", fields: { chat_id: "={{ $('" + n(t, "bot") + "').item.json.chat }}", text: "={{ $json.text }}" } },
          }),
        ],
        [wire("bot", "answer"), wire("answer", "reply")],
      ),
  },
  {
    id: "dailyDigest",
    icon: "data.state",
    build: (t) =>
      flow(
        [
          node("event", "trigger.webhook", n(t, "webhook"), 0, 0, { method: "POST", hookPath: "eventos", auth: "none", respond: "immediately" }),
          node("keep", "data.state", n(t, "collect"), 260, 0, { operation: "collect", key: "digest", value: "={{ $json.body }}", keepAtMost: 500 }),
          node("evening", "trigger.schedule", n(t, "weekdays18"), 0, 220, { mode: "times", at: ["18:00"], days: ["mon", "tue", "wed", "thu", "fri"] }),
          node("all", "data.state", n(t, "takeAll"), 260, 220, { operation: "takeAll", key: "digest", target: "events" }),
          node("summary", "ai.summarize", n(t, "summary"), 520, 220, { text: "={{ JSON.stringify($json.events) }}", summaryStyle: "bullets" }),
          node("notify", "app.notify", n(t, "notify"), 780, 220, { title: n(t, "digest"), body: "={{ $json.summary }}" }),
        ],
        [wire("event", "keep"), wire("evening", "all"), wire("all", "summary"), wire("summary", "notify")],
      ),
  },
  {
    id: "invoiceOcr",
    icon: "ai.vision",
    build: (t) =>
      flow(
        [
          node("arrived", "trigger.file", n(t, "newInvoice"), 0, 0, { watchPath: "~/Documentos/Facturas", events: ["created"], pattern: "*.pdf" }),
          node("read", "ai.vision", n(t, "readInvoice"), 260, 0, {
            imagePath: "={{ $json.path }}",
            visionTask: "visionExtract",
            schemaFields: [
              { name: "proveedor", type: "string", description: "", required: true },
              { name: "total", type: "number", description: "", required: true },
              { name: "fecha", type: "string", description: "AAAA-MM-DD", required: false },
            ],
            visionEngine: "visionCli",
            target: "factura",
          }),
          node("save", "data.sheet", n(t, "toSheet"), 520, 0, { operation: "write", path: "~/Documentos/Facturas/facturas.csv", header: true }),
        ],
        [wire("arrived", "read"), wire("read", "save")],
      ),
  },
  {
    id: "meetingNotes",
    icon: "ai.transcribe",
    build: (t) =>
      flow(
        [
          node("recorded", "trigger.file", n(t, "newRecording"), 0, 0, { watchPath: "~/Grabaciones", events: ["created"], pattern: "*.m4a" }),
          node("transcribe", "ai.transcribe", n(t, "transcribe"), 260, 0, { audioPath: "={{ $json.path }}", transcribeEngine: "openaiApi", audioLanguage: "es", target: "transcript" }),
          node("summary", "ai.summarize", n(t, "summary"), 520, 0, { text: "={{ $json.transcript }}", summaryLength: "standard", summaryStyle: "bullets" }),
          node("note", "app.note", n(t, "toNote"), 780, 0, { operation: "create", title: "={{ 'Reunión ' + $now.toFormat('yyyy-LL-dd HH:mm') }}", content: "={{ $json.summary + '\\n\\n---\\n\\n' + $json.transcript }}" }),
        ],
        [wire("recorded", "transcribe"), wire("transcribe", "summary"), wire("summary", "note")],
      ),
  },
  {
    id: "feedToSlack",
    icon: "trigger.feed",
    build: (t) =>
      flow(
        [
          node("feed", "trigger.feed", n(t, "newPost"), 0, 0, { feedUrl: "https://example.com/feed.xml", intervalMin: 30 }),
          node("post", "net.connector", n(t, "toSlack"), 260, 0, {
            call: { connector: "slack", operation: "postMessage", fields: { channel: "#novedades", text: "={{ $json.title + ' — ' + $json.link }}" } },
          }),
        ],
        [wire("feed", "post")],
      ),
  },
  {
    id: "supportTriage",
    icon: "transform.redact",
    build: (t) =>
      flow(
        [
          node("mail", "trigger.email", n(t, "supportMail"), 0, 0, { mailbox: "INBOX", imapCriteria: "UNSEEN", intervalSec: 120 }),
          // What reaches the model has no emails, phones, RUTs, cards or keys in it.
          node("hide", "transform.redact", n(t, "hide"), 260, 0, { detect: ["piiEmail", "piiPhone", "piiRut", "piiCard", "piiSecret"], redactMode: "redactPlaceholder", reportField: "_redacted" }),
          node("kind", "ai.classify", n(t, "classify"), 520, 0, {
            text: "={{ $json.subject + '\\n\\n' + $json.text }}",
            categories: [
              { name: "bug", description: n(t, "bugDesc") },
              { name: "cobros", description: n(t, "billingDesc") },
            ],
            routing: "routeBranch",
            allowOther: true,
          }),
          node("issue", "net.connector", n(t, "openIssue"), 800, -100, {
            call: { connector: "github", operation: "createIssue", fields: { owner: "acme", repo: "app", title: "={{ $json.subject }}", body: "={{ $json.text }}" } },
          }),
          node("billing", "app.notify", n(t, "notify"), 800, 40, { title: n(t, "billingMail"), body: "={{ $json.subject }}" }),
        ],
        [wire("mail", "hide"), wire("hide", "kind"), wire("kind", "issue", 0), wire("kind", "billing", 1)],
      ),
  },
  {
    id: "mcpTool",
    icon: "trigger.tool",
    build: (t) =>
      flow(
        [
          node("tool", "trigger.tool", n(t, "tool"), 0, 0, {
            toolName: "buscar_pedido",
            toolDescription: n(t, "toolDesc"),
            fields: [{ name: "id", label: "id", type: "text", required: true }],
          }),
          node("find", "data.sql", n(t, "readTable"), 260, 0, { queryText: "SELECT * FROM pedidos WHERE id = $1", queryParams: ["={{ $json.id }}"] }),
        ],
        [wire("tool", "find")],
      ),
  },
  {
    id: "pushToPhone",
    icon: "trigger.app",
    build: (t) =>
      flow(
        [
          node("pushed", "trigger.app", n(t, "pushedMain"), 0, 0, { event: "gitPushed", branch: "main" }),
          node("ntfy", "net.connector", n(t, "toPhone"), 260, 0, {
            call: { connector: "ntfy", operation: "publish", fields: { topic: "mis-deploys", title: n(t, "pushed"), message: "={{ ($json.project || '') + ' → ' + ($json.branch || 'main') }}", tags: "[\"rocket\"]" } },
          }),
        ],
        [wire("pushed", "ntfy")],
      ),
  },
];
