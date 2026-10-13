import { describe, expect, it } from "vitest";
import { parseArchify } from "./ir";
import { convertMermaid, isMermaid } from "./mermaid";

function converted(source: string) {
  const result = convertMermaid(source);
  if (!result.ok) throw new Error(result.reason);
  const parsed = parseArchify(JSON.stringify(result.doc), "From Mermaid");
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.ir;
}

describe("Mermaid flowcharts", () => {
  const ir = converted(`flowchart LR
    %% a comment
    A[Client] -->|POST /orders| B(API)
    B --> C[(Orders DB)]
    B -.->|enqueue| Q{{Queue}}
    Q ==> W[Worker] & X([Mailer])
    subgraph Backend [Back office]
      W
    end
    C -- cached --> B`);

  it("becomes a workflow, one node per id, with the shapes' words", () => {
    expect(ir.diagram_type).toBe("workflow");
    if (ir.diagram_type !== "workflow") return;
    expect(ir.nodes.map((n) => n.id)).toEqual(["A", "B", "C", "Q", "W", "X"]);
    expect(ir.nodes.find((n) => n.id === "B")!.label).toBe("API");
    expect(ir.nodes.find((n) => n.id === "C")!.type).toBe("database");
    expect(ir.nodes.find((n) => n.id === "X")!.type).toBe("external");
  });

  it("keeps every arrow, its label and its weight", () => {
    if (ir.diagram_type !== "workflow") return;
    const edge = (from: string, to: string) => ir.edges.find((e) => e.from === from && e.to === to)!;
    expect(edge("A", "B").label).toBe("POST /orders");
    expect(edge("B", "Q").role).toBe("async");
    expect(edge("Q", "W").role).toBe("main");
    expect(edge("Q", "X")).toBeTruthy();
    expect(edge("C", "B").label).toBe("cached");
  });

  it("turns a subgraph into a lane the node stands in", () => {
    if (ir.diagram_type !== "workflow") return;
    expect(ir.lanes.map((l) => l.label)).toEqual(["Flow", "Back office"]);
    expect(ir.nodes.find((n) => n.id === "W")!.lane).toBe("Backend");
  });
});

describe("Mermaid sequence diagrams", () => {
  const ir = converted(`sequenceDiagram
    actor U as User
    participant API
    U->>API: POST /orders
    activate API
    API->>DB: INSERT
    DB-->>API: id
    loop every minute
      API-)Queue: poll
    end
    Note over API,DB: single transaction
    API-->>U: 201`);

  it("becomes a sequence with the participants it declares and the ones it meets", () => {
    expect(ir.diagram_type).toBe("sequence");
    if (ir.diagram_type !== "sequence") return;
    expect(ir.participants.map((p) => p.label)).toEqual(["User", "API", "DB", "Queue"]);
    expect(ir.participants[0].type).toBe("external");
  });

  it("keeps the order, the replies, the async ones, the notes and the blocks", () => {
    if (ir.diagram_type !== "sequence") return;
    expect(ir.messages.map((m) => m.label)).toEqual(["POST /orders", "INSERT", "id", "poll", "201"]);
    expect(ir.messages[2].variant).toBe("return");
    expect(ir.messages[3].variant).toBe("dashed");
    expect(ir.messages[3].note).toBe("single transaction");
    expect(ir.phases).toEqual([{ label: "loop every minute", from: 3, to: 3 }]);
  });
});

describe("Mermaid state diagrams", () => {
  const ir = converted(`stateDiagram-v2
    [*] --> Pending
    Pending --> Running: start
    Running --> Failed: error
    Running --> Done
    Done --> [*]
    Pending : waiting for a slot`);

  it("becomes a lifecycle: [*] is the start and the end, the words pick the types", () => {
    expect(ir.diagram_type).toBe("lifecycle");
    if (ir.diagram_type !== "lifecycle") return;
    const type = (id: string) => ir.states.find((s) => s.id === id)!.type;
    expect(type("start")).toBe("start");
    expect(type("end")).toBe("success");
    expect(type("Failed")).toBe("failure");
    expect(type("Pending")).toBe("waiting");
    expect(type("Running")).toBe("active");
    expect(ir.states.find((s) => s.id === "Pending")!.sublabel).toBe("waiting for a slot");
    expect(ir.transitions.find((t) => t.from === "Pending" && t.to === "Running")!.label).toBe("start");
  });
});

describe("what it refuses", () => {
  it("names the diagrams it does not convert", () => {
    expect(isMermaid("pie title Pets\n  \"Dogs\" : 3")).toBe(false);
    expect(convertMermaid("pie title Pets")).toEqual({ ok: false, reason: "unsupported" });
    expect(convertMermaid("flowchart TD")).toEqual({ ok: false, reason: "empty" });
    expect(convertMermaid("")).toEqual({ ok: false, reason: "empty" });
  });
});
