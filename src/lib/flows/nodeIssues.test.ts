import { describe, expect, it } from "vitest";
import type { FlowConnector } from "../tauri/flowsCommands";
import { nodeIssues, type Translate } from "./nodeIssues";
import type { FlowNodeSpec } from "./spec";

const linear: FlowConnector = {
  id: "linear",
  name: "Linear",
  group: "appsProjects",
  auth: "headers",
  authOptional: false,
  authHint: { es: "", en: "" },
  siteField: null,
  operations: [
    {
      id: "createIssue",
      name: { es: "Crear", en: "Create" },
      method: "POST",
      fields: [
        { name: "teamId", label: { es: "Equipo", en: "Team" }, placeholder: "", required: true, multiline: false, json: false },
        { name: "title", label: { es: "Título", en: "Title" }, placeholder: "", required: true, multiline: false, json: false },
        { name: "description", label: { es: "Descripción", en: "Description" }, placeholder: "", required: false, multiline: true, json: false },
      ],
    },
  ],
};
const ntfy: FlowConnector = { ...linear, id: "ntfy", name: "ntfy", auth: "bearer", authOptional: true, operations: [] };

const t: Translate = (key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`;
const say = (label: { es: string; en: string }) => label.es;
const node = (type: string, params: Record<string, unknown>, disabled = false): FlowNodeSpec => ({ id: "n", type, name: "n", pos: [0, 0], params, settings: {}, disabled });

describe("nodeIssues", () => {
  it("names what a Conector lacks: the credential and the required fields, not an expression", () => {
    const call = { connector: "linear", operation: "createIssue", fields: { teamId: "", title: "={{ $json.title }}" } };
    expect(nodeIssues(node("net.connector", { call }), [linear], new Set(), say, t)).toEqual([
      'flows.issue.credential {"service":"Linear"}',
      'flows.issue.field {"field":"Equipo"}',
    ]);
    const done = { connector: "linear", operation: "createIssue", fields: { teamId: "t1", title: "x" } };
    expect(nodeIssues(node("net.connector", { call: done, credential: "c1" }), [linear], new Set(["c1"]), say, t)).toEqual([]);
  });

  it("knows a credential that is gone once the list is loaded, and none while it loads", () => {
    const call = { connector: "linear", operation: "createIssue", fields: { teamId: "t1", title: "x" } };
    expect(nodeIssues(node("net.connector", { call, credential: "old" }), [linear], new Set(["c1"]), say, t)).toEqual(["flows.issue.credentialGone"]);
    expect(nodeIssues(node("net.connector", { call, credential: "old" }), [linear], new Set(), say, t)).toEqual([]);
  });

  it("asks an account node for its account, and leaves the rest alone", () => {
    expect(nodeIssues(node("net.microsoft", {}), [], new Set(), say, t)).toEqual(['flows.issue.credential {"service":"Microsoft 365"}']);
    expect(nodeIssues(node("trigger.google", { credential: "g" }), [], new Set(["g"]), say, t)).toEqual([]);
    expect(nodeIssues(node("net.http", {}), [linear], new Set(), say, t)).toEqual([]);
    expect(nodeIssues(node("net.microsoft", {}, true), [], new Set(), say, t)).toEqual([]);
  });

  it("says nothing before the connectors load, and needs no credential where it is optional", () => {
    expect(nodeIssues(node("net.connector", { call: { connector: "linear" } }), [], new Set(), say, t)).toEqual([]);
    expect(nodeIssues(node("net.connector", { call: { connector: "nope" } }), [linear], new Set(), say, t)).toEqual(["flows.issue.service"]);
    expect(nodeIssues(node("net.connector", { call: { connector: "ntfy", operation: "x", fields: {} } }), [ntfy], new Set(), say, t)).toEqual([]);
  });
});
