import { describe, expect, it } from "vitest";
import { visible } from "./paramVisibility";
import type { FlowParamSpec } from "../tauri/flowsCommands";

const select = (name: string, options: string[], fallback: string, showIf?: FlowParamSpec["showIf"]): FlowParamSpec => ({
  name,
  kind: { type: "select", options, raw: false },
  default: fallback,
  expr: false,
  ...(showIf ? { showIf } : {}),
});

const field = (name: string, showIf?: FlowParamSpec["showIf"], alsoIf?: FlowParamSpec["alsoIf"]): FlowParamSpec => ({
  name,
  kind: { type: "text", multiline: false, placeholder: "" },
  default: "",
  expr: true,
  ...(showIf ? { showIf } : {}),
  ...(alsoIf ? { alsoIf } : {}),
});

describe("visible", () => {
  // The Google node: a service, an operation per service, fields per operation.
  const google = [
    select("service", ["gmail", "sheets"], "gmail"),
    select("gmailOp", ["gmailSend", "gmailSearch"], "gmailSend", { param: "service", values: ["gmail"] }),
    field("to", { param: "gmailOp", values: ["gmailSend"] }),
    select("sheetsOp", ["sheetsRead", "sheetsAppend"], "sheetsRead", { param: "service", values: ["sheets"] }),
    field("header", { param: "sheetsOp", values: ["sheetsRead"] }),
  ];
  const shown = (values: Record<string, unknown>) => google.filter((spec) => visible(spec, values, google)).map((spec) => spec.name);

  it("hides a field whose operation belongs to another service", () => {
    expect(shown({})).toEqual(["service", "gmailOp", "to"]);
    // `gmailOp` still says gmailSend, but it is hidden, and so is what follows it.
    expect(shown({ service: "sheets", gmailOp: "gmailSend" })).toEqual(["service", "sheetsOp", "header"]);
    expect(shown({ service: "gmail", gmailOp: "gmailSearch" })).toEqual(["service", "gmailOp"]);
  });

  it("asks both conditions of a field that has two", () => {
    const queue = [
      select("broker", ["rabbitmq", "kafka"], "rabbitmq"),
      select("queueOp", ["queuePublish", "queueReceive"], "queuePublish"),
      field("exchange", { param: "broker", values: ["rabbitmq"] }, { param: "queueOp", values: ["queuePublish"] }),
    ];
    const has = (values: Record<string, unknown>) => visible(queue[2], values, queue);
    expect(has({})).toBe(true);
    expect(has({ queueOp: "queueReceive" })).toBe(false);
    expect(has({ broker: "kafka" })).toBe(false);
  });
});
