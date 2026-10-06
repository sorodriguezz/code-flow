import { describe, expect, it } from "vitest";
import { autoClose, complete, dropText, expressionAt, type AssistData, type AssistField, type Completion } from "./exprAssist";

const person = {
  id: 7,
  name: "Ana",
  total: 64,
  orders: [
    { amount: 45, product: { name: "lápiz", url: "https://example.com/p/1" } },
    { amount: 49, product: { name: "goma", url: "https://example.com/p/2" } },
  ],
  address: { city: "Lima" },
  "first name": "Ana",
};

const data: AssistData = {
  input: [person],
  nodes: [{ name: "HTTP", output: [{ status: 200, body: { ok: true } }] }, { name: "Sin correr" }],
  vars: { API_URL: "https://example.com" },
};

const EXPRESSION: AssistField = { dialect: "expression", expressions: true };
const JINJA: AssistField = { dialect: "jinja", expressions: false };

/** `text` with `|` marking the caret — the first `|` that is followed by nothing or a non-filter. */
function ask(marked: string, field: AssistField = EXPRESSION, with_: AssistData = data): Completion | null {
  const caret = marked.indexOf("‸");
  return complete(marked.replace("‸", ""), caret, field, with_);
}

const labels = (c: Completion | null) => c?.items.map((s) => s.label) ?? [];

/** What the text reads after picking `label`. */
function pick(marked: string, label: string, field: AssistField = EXPRESSION): string {
  const caret = marked.indexOf("‸");
  const text = marked.replace("‸", "");
  const c = complete(text, caret, field, data);
  const s = c?.items.find((item) => item.label === label);
  if (!c || !s) throw new Error(`no "${label}" in ${JSON.stringify(labels(c))}`);
  const from = s.from ?? c.from;
  const to = s.to ?? c.to;
  const out = text.slice(0, from) + s.insert + text.slice(to);
  const at = from + (s.caret ?? s.insert.length);
  return `${out.slice(0, at)}‸${out.slice(at)}`;
}

describe("expressions", () => {
  it("offers the item's fields after $json., fields first, methods after", () => {
    const c = ask("{{ $json.‸ }}");
    expect(labels(c).slice(0, 6)).toEqual(["id", "name", "total", "orders", "address", "first name"]);
    expect(labels(c)).toContain("isNotEmpty");
    expect(c?.items[0]).toMatchObject({ kind: "field", detail: "#", sample: "7" });
  });

  it("brackets a name a dot cannot reach", () => {
    expect(pick("{{ $json.‸ }}", "first name")).toBe('{{ $json["first name"]‸ }}');
  });

  it("reads lists through their first element", () => {
    expect(labels(ask("{{ $json.orders.‸ }}")).slice(0, 4)).toEqual(["[0]", "length", "first", "last"]);
    expect(pick("{{ $json.orders.‸ }}", "[0]")).toBe("{{ $json.orders[0]‸ }}");
    expect(labels(ask("{{ $json.orders[0].‸ }}")).slice(0, 2)).toEqual(["amount", "product"]);
    expect(labels(ask("{{ $json.orders.first().product.‸ }}")).slice(0, 2)).toEqual(["name", "url"]);
    expect(labels(ask("{{ $json?.address?.‸ }}"))).toContain("city");
  });

  it("knows what a value can do, and narrows by what is typed", () => {
    const c = ask("{{ $json.name.to‸ }}");
    expect(labels(c)).toContain("toUpperCase");
    expect(labels(c)).toContain("toTitleCase");
    expect(labels(c).every((label) => label.toLowerCase().includes("to"))).toBe(true);
    expect(pick("{{ $json.name.toUp‸ }}", "toUpperCase")).toBe("{{ $json.name.toUpperCase()‸ }}");
    expect(pick("{{ $json.total.ro‸ }}", "round")).toBe("{{ $json.total.round(‸) }}");
    expect(labels(ask("{{ $now.‸ }}"))).toContain("toFormat");
  });

  it("starts from $json, then the input, the nodes and the rest", () => {
    const c = ask("{{ ‸ }}");
    expect(labels(c).slice(0, 4)).toEqual(["$json", "$input", "$('HTTP')", "$('Sin correr')"]);
    expect(labels(c)).toContain("$vars");
    expect(labels(c)).toContain("$now");
    // Typing a field's own name finds it.
    expect(labels(ask("{{ na‸ }}"))).toContain("$json.name");
    expect(labels(ask("{{ $js‸ }}"))[0]).toBe("$json");
  });

  it("reads another node's output, and asks for it when it is not known", () => {
    expect(labels(ask("{{ $('HTTP').item.json.‸ }}"))).toEqual(expect.arrayContaining(["status", "body"]));
    expect(labels(ask("{{ $('HTTP').first().json.body.‸ }}"))).toContain("ok");
    expect(labels(ask('{{ $node["HTTP"].json.‸ }}'))).toContain("status");
    const unknown = ask("{{ $('Sin correr').item.json.‸ }}");
    expect(unknown?.wants).toBe("Sin correr");
    expect(pick("{{ $('H‸ }}", "HTTP")).toBe("{{ $('HTTP')‸ }}");
    expect(pick("{{ $(‸ }}", "HTTP")).toBe("{{ $('HTTP')‸ }}");
  });

  it("lists the variables", () => {
    expect(ask("{{ $vars.‸ }}")?.items[0]).toMatchObject({ label: "API_URL", sample: "https://example.com" });
  });

  it("says nothing outside the braces, after an operand, or in a string", () => {
    expect(ask("hola ‸ {{ $json.id }}")).toBeNull();
    expect(ask("{{ $json.id ‸ }}")).toBeNull();
    expect(ask("{{ 'a.‸' }}")).toBeNull();
    expect(labels(ask("{{ $json.id + ‸ }}"))[0]).toBe("$json");
  });

  it("tells when the fields are missing because nothing ran yet", () => {
    expect(ask("{{ $json.‸ }}", EXPRESSION, { ...data, input: [] })?.noInput).toBe(true);
  });

  it("finds the braces the caret is in", () => {
    expect(expressionAt("a {{ b }} c", 5)).toEqual({ start: 4, end: 7 });
    expect(expressionAt("a {{ b }} c", 10)).toBeNull();
    expect(expressionAt("a {{ b", 6)).toEqual({ start: 4, end: 6 });
    expect(expressionAt('{{ "}}" + x }}', 10)).toEqual({ start: 2, end: 12 });
  });
});

describe("templates (Jinja)", () => {
  it("knows the variable of the for around the caret, and its fields", () => {
    const text = "{% for s in $json.orders %}{{ s.‸ }}{% endfor %}";
    expect(labels(ask(text, JINJA))).toEqual(["amount", "product"]);
    const roots = ask("{% for s in $json.orders %}{{ ‸ }}", JINJA);
    expect(labels(roots).slice(0, 3)).toEqual(["s", "loop", "$json"]);
    expect(roots?.items[0]).toMatchObject({ doc: "flows.assist.loopVar", docArgs: { list: "$json.orders" } });
    expect(labels(ask("{% for s in $json.orders %}{{ loop.‸ }}", JINJA))).toContain("last");
    // Closed, the loop is gone.
    expect(labels(ask("{% for s in $json.orders %}{% endfor %}{{ ‸ }}", JINJA))[0]).toBe("$json");
  });

  it("reads json with or without the $, and $items", () => {
    expect(labels(ask("{{ json.‸ }}", JINJA))).toContain("orders");
    expect(labels(ask("{{ $json.‸ }}", JINJA))).not.toContain("isEmpty");
    expect(labels(ask("{% for i in $items %}{{ i.‸ }}", JINJA))).toContain("total");
    expect(labels(ask("{% set p = $json.address %}{{ p.‸ }}", JINJA))).toEqual(["city"]);
    expect(labels(ask("{% for k, v in $json.address|items %}{{ ‸", JINJA)).slice(0, 2)).toEqual(["k", "v"]);
  });

  it("offers filters after |, and the words a statement starts with", () => {
    expect(pick("{{ $json.name|up‸ }}", "upper", JINJA)).toBe("{{ $json.name|upper‸ }}");
    expect(pick("{{ $json.orders|jo‸ }}", "join", JINJA)).toBe('{{ $json.orders|join(", ")‸ }}');
    expect(pick("{{ $json.x|def‸ }}", "default", JINJA)).toBe('{{ $json.x|default("‸") }}');
    expect(labels(ask("{% ‸ %}", JINJA)).slice(0, 2)).toEqual(["for … in …", "if …"]);
    expect(labels(ask("{% for s in $json.orders %}{% e‸ %}", JINJA))[0]).toBe("endfor");
    expect(labels(ask("{% for s in ‸ %}", JINJA))[0]).toBe("$json");
    expect(labels(ask("{% if $json.‸ %}", JINJA))).toContain("total");
  });

  it("offers the three tags after a lone brace, swallowing the one the editor closed", () => {
    const c = ask("Hola {‸}", JINJA);
    expect(labels(c)).toEqual(["{{ … }}", "{% for … %}", "{% if … %}"]);
    expect(pick("Hola {‸}", "{{ … }}", JINJA)).toBe("Hola {{ ‸ }}");
    expect(ask("{# $json.‸ #}", JINJA)).toBeNull();
    expect(ask("plain ‸ text", JINJA)).toBeNull();
  });
});

describe("code", () => {
  const JS: AssistField = { dialect: "js", expressions: false };
  const PY: AssistField = { dialect: "python", expressions: true };
  const NODE: AssistField = { dialect: "node", expressions: true };
  const SQL: AssistField = { dialect: "sql", expressions: false };

  it("the Code node reads $input, items and item", () => {
    expect(labels(ask("return ‸", JS)).slice(0, 4)).toEqual(["$input", "$json", "items", "item"]);
    expect(labels(ask("const a = $input.first().json.‸", JS))).toContain("orders");
    expect(labels(ask("return items[0].json.‸", JS))).toContain("address");
    expect(labels(ask("// $json.‸", JS))).toEqual([]);
  });

  it("Python reads a dict by its keys, through loops too", () => {
    expect(pick("print(item.‸)", "name", PY)).toBe('print(item["name"]‸)');
    expect(pick('print(item["na‸', "name", PY)).toBe('print(item["name"]‸');
    expect(pick("x = item[‸]", "name", PY)).toBe('x = item["name"‸]');
    expect(labels(ask('for o in item["orders"]:\n    print(o["‸', PY))).toEqual(["amount", "product"]);
    expect(labels(ask("total = sum(o for o in ‸", PY)).slice(0, 2)).toEqual(["item", "items"]);
    // In braces, an expression, as the engine resolves them first.
    expect(labels(ask("x = {{ $json.‸ }}", PY))).toContain("orders");
  });

  it("a Node script reads plain items", () => {
    expect(labels(ask("console.log(item.‸)", NODE))).toContain("orders");
    expect(labels(ask("items[0].address.‸", NODE))).toEqual(["city"]);
  });

  it("SQL offers the table and a column per field", () => {
    expect(labels(ask("SELECT ‸ FROM items", SQL)).slice(0, 3)).toEqual(["items", "id", "name"]);
    expect(pick("SELECT fir‸", "first name", SQL)).toBe('SELECT "first name"‸');
    expect(ask("SELECT '‸", SQL)).toBeNull();
  });
});

describe("drops", () => {
  const path = ["orders", 0, "amount"];
  it("write the path the way the field reads it", () => {
    expect(dropText(path, EXPRESSION, "Total: ", 7)).toEqual({ insert: "{{ $json.orders[0].amount }}", expression: true });
    expect(dropText(path, EXPRESSION, "{{  }}", 3)).toEqual({ insert: "$json.orders[0].amount", expression: false });
    expect(dropText(["first name"], EXPRESSION, "", 0)?.insert).toBe('{{ $json["first name"] }}');
    expect(dropText(path, { dialect: "js", expressions: false }, "return ", 7)?.insert).toBe("$json.orders[0].amount");
    expect(dropText(path, { dialect: "node", expressions: true }, "", 0)?.insert).toBe("item.orders[0].amount");
    expect(dropText(path, { dialect: "python", expressions: true }, "", 0)?.insert).toBe('item["orders"][0]["amount"]');
    expect(dropText(path, { dialect: "sql", expressions: false }, "", 0)?.insert).toBe("json_extract(orders, '$[0].amount')");
    expect(dropText(["total"], { dialect: "sql", expressions: false }, "", 0)?.insert).toBe("total");
  });

  it("in a template, through the variable of the loop that walks the list", () => {
    const text = "{% for s in $json.orders %}\n{% endfor %}";
    expect(dropText(path, JINJA, text, 28)?.insert).toBe("{{ s.amount }}");
    expect(dropText(["id"], JINJA, text, 28)?.insert).toBe("{{ $json.id }}");
    expect(dropText(["orders"], JINJA, "{% for s in  %}", 12)?.insert).toBe("$json.orders");
    expect(dropText(["name"], JINJA, "{% for i in $items %}", 21)?.insert).toBe("{{ i.name }}");
  });
});

describe("typing {{", () => {
  it("closes the braces around the caret", () => {
    expect(autoClose("Hola {{", 7)).toEqual({ text: "Hola {{  }}", caret: 8 });
    expect(autoClose("{{ }}", 2)).toBeNull();
    expect(autoClose("{{{", 3)).toBeNull();
  });
});
