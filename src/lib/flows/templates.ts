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
    icon: "ai.review",
    build: (t) =>
      flow(
        [
          node("opened", "trigger.pr", n(t, "prOpened"), 0, 0, { event: "opened" }),
          node("review", "ai.review", n(t, "review"), 260, 0, { diffSource: "branchDiff", base: "={{ $json.targetBranch || 'main' }}" }),
          node("comment", "files.pr", n(t, "comment"), 520, 0, { operation: "comment", prId: "={{ $('" + n(t, "prOpened") + "').item.json.id }}", body: "={{ $json.summary }}" }),
        ],
        [wire("opened", "review"), wire("review", "comment")],
      ),
  },
];
