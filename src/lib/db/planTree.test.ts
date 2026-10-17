import { describe, expect, it } from "vitest";
import { hasActual, parsePlan, planHotspot, selfMetric, totalOf, type PlanNode } from "./planTree";

const labels = (node: PlanNode): unknown => ({ [node.label]: node.children.map(labels) });

describe("postgres", () => {
  const estimated = [
    "Hash Join  (cost=33.38..62.84 rows=1000 width=72)",
    "  Output: o.id, o.total, c.name",
    "  Hash Cond: (o.customer_id = c.id)",
    "  ->  Seq Scan on public.orders o  (cost=0.00..26.50 rows=1000 width=40)",
    "        Output: o.id, o.customer_id, o.total",
    "        Filter: (o.total > '100'::numeric)",
    "  ->  Hash  (cost=21.00..21.00 rows=990 width=36)",
    "        Output: c.name, c.id",
    "        ->  Seq Scan on public.customers c  (cost=0.00..21.00 rows=990 width=36)",
    "              Output: c.name, c.id",
  ].join("\n");

  it("nests by the column of the arrow and keeps property lines on their node", () => {
    const root = parsePlan(estimated, "postgres")!;
    expect(labels(root)).toEqual({
      "Hash Join": [{ "Seq Scan on public.orders o": [] }, { Hash: [{ "Seq Scan on public.customers c": [] }] }],
    });
    expect(root.cost).toBe(62.84);
    expect(root.startupCost).toBe(33.38);
    expect(root.rows).toBe(1000);
    expect(root.detail).toEqual(["Output: o.id, o.total, c.name", "Hash Cond: (o.customer_id = c.id)"]);
    expect(root.children[0].detail).toContain("Filter: (o.total > '100'::numeric)");
    expect(hasActual(root)).toBe(false);
  });

  it("finds the node that spends the most cost itself", () => {
    const root = parsePlan(estimated, "postgres")!;
    expect(totalOf(root)).toBe(62.84);
    // Hash Join: 62.84 - 26.5 - 21 = 15.34; orders scan 26.5; customers scan 21; Hash 0.
    expect(planHotspot(root)?.label).toBe("Seq Scan on public.orders o");
    expect(selfMetric(root.children[1], false)).toBe(0);
  });

  const analyzed = [
    "Limit  (cost=0.29..8.31 rows=1 width=40) (actual time=0.020..0.950 rows=1 loops=1)",
    "  Output: id, total",
    "  Buffers: shared hit=3",
    "  ->  Nested Loop  (cost=0.29..8.31 rows=1 width=40) (actual time=0.019..0.940 rows=1 loops=1)",
    "        ->  Index Scan using orders_pkey on public.orders  (cost=0.29..8.30 rows=1 width=40) (actual time=0.010..0.012 rows=1 loops=1)",
    "              Index Cond: (orders.id = 1)",
    "        ->  Seq Scan on public.items  (cost=0.00..1.00 rows=5 width=8) (actual time=0.004..0.090 rows=900 loops=10)",
    "              Filter: (items.order_id = 1)",
    "              Rows Removed by Filter: 12",
    "        ->  Index Scan using never_pkey on public.never  (cost=0.15..2.00 rows=1 width=8) (never executed)",
    "Planning:",
    "  Buffers: shared hit=8",
    "Planning Time: 0.120 ms",
    "Execution Time: 0.990 ms",
  ].join("\n");

  it("reads the measured figures, multiplying time by loops", () => {
    const root = parsePlan(analyzed, "postgres")!;
    expect(hasActual(root)).toBe(true);
    expect(root.actualMs).toBeCloseTo(0.95);
    const items = root.children[0].children[1];
    expect(items.actualMs).toBeCloseTo(0.9);
    expect(items.actualRows).toBe(900);
    expect(items.loops).toBe(10);
    expect(items.rows).toBe(5);
    expect(root.children[0].children[2].actualMs).toBe(0);
    expect(root.children[0].children[2].label).toBe("Index Scan using never_pkey on public.never");
  });

  it("puts the planning and execution lines on the root", () => {
    const root = parsePlan(analyzed, "postgres")!;
    expect(root.detail).toEqual([
      "Output: id, total",
      "Buffers: shared hit=3",
      "Planning:",
      "Buffers: shared hit=8",
      "Planning Time: 0.120 ms",
      "Execution Time: 0.990 ms",
    ]);
  });

  it("uses time, not cost, for the hotspot once analyzed", () => {
    const root = parsePlan(analyzed, "postgres")!;
    expect(totalOf(root)).toBeCloseTo(0.95);
    expect(planHotspot(root)?.label).toBe("Seq Scan on public.items");
  });

  it("ignores psql's header", () => {
    const root = parsePlan("                QUERY PLAN\n-----------------\n Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)\n(1 row)", "postgres")!;
    expect(root.label).toBe("Seq Scan on t");
    expect(root.children).toEqual([]);
  });
});

describe("mysql", () => {
  const tree = [
    "-> Nested loop inner join  (cost=4.70 rows=10)",
    "    -> Filter: (o.total > 100)  (cost=1.25 rows=3)",
    "        -> Table scan on o  (cost=1.25 rows=10)",
    "    -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.35 rows=1)",
  ].join("\n");

  it("reads the tree format", () => {
    const root = parsePlan(tree, "mysql")!;
    expect(labels(root)).toEqual({
      "Nested loop inner join": [
        { "Filter: (o.total > 100)": [{ "Table scan on o": [] }] },
        { "Single-row index lookup on c using PRIMARY (id=o.customer_id)": [] },
      ],
    });
    expect(root.cost).toBe(4.7);
    expect(root.startupCost).toBeNull();
    expect(root.children[0].children[0].rows).toBe(10);
  });

  const analyze = [
    "-- EXPLAIN ANALYZE needs MySQL 8.0.18 or later (8.0.17); showing the estimated plan.",
    "-> Limit: 10 row(s)  (cost=1.25 rows=10) (actual time=0.0412..0.0611 rows=10 loops=1)",
    "    -> Table scan on orders  (cost=1.25 rows=10) (actual time=0.0398..0.0560 rows=10 loops=1)",
  ].join("\n");

  it("reads EXPLAIN ANALYZE and keeps the backend's note", () => {
    const root = parsePlan(analyze, "mysql")!;
    expect(root.label).toBe("Limit: 10 row(s)");
    expect(root.actualMs).toBeCloseTo(0.0611);
    expect(root.children[0].actualRows).toBe(10);
    expect(root.detail[0]).toMatch(/needs MySQL 8.0.18/);
  });

  it("gives up on MariaDB's JSON", () => {
    expect(parsePlan('{\n  "query_block": {\n    "select_id": 1\n  }\n}', "mysql")).toBeNull();
  });
});

describe("sqlite", () => {
  it("nests the backend's two-space indentation", () => {
    const text = [
      "SEARCH orders USING INDEX orders_customer (customer_id=?)",
      "SCAN items",
      "  CORRELATED SCALAR SUBQUERY 1",
      "    SEARCH t USING INTEGER PRIMARY KEY (rowid=?)",
    ].join("\n");
    const root = parsePlan(text, "sqlite")!;
    expect(labels(root)).toEqual({
      "Query plan": [
        { "SEARCH orders USING INDEX orders_customer (customer_id=?)": [] },
        { "SCAN items": [{ "CORRELATED SCALAR SUBQUERY 1": [{ "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)": [] }] }] },
      ],
    });
    expect(totalOf(root)).toBeNull();
    expect(planHotspot(root)).toBeNull();
  });

  it("answers a single line as the root itself", () => {
    expect(parsePlan("SCAN orders", "sqlite")?.label).toBe("SCAN orders");
  });
});

describe("mssql", () => {
  it("nests the |-- operators under the statement", () => {
    const text = [
      "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1",
      "  |--Nested Loops(Inner Join)",
      "       |--Clustered Index Seek(OBJECT:([shop].[dbo].[orders].[PK_orders] AS [o]), SEEK:([o].[id]=(1)) ORDERED FORWARD)",
      "       |--Clustered Index Seek(OBJECT:([shop].[dbo].[customers].[PK_customers] AS [c]), SEEK:([c].[id]=[o].[customer_id]) ORDERED FORWARD)",
    ].join("\n");
    const root = parsePlan(text, "mssql")!;
    expect(labels(root)).toEqual({
      "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1": [
        { "Nested Loops": [{ "Clustered Index Seek": [] }, { "Clustered Index Seek": [] }] },
      ],
    });
    expect(root.children[0].detail).toEqual(["Inner Join"]);
    expect(root.children[0].children[0].detail[0]).toMatch(/^OBJECT:\(\[shop\]/);
  });

  it("gives up without operators", () => {
    expect(parsePlan("just text", "mssql")).toBeNull();
  });
});

describe("oracle", () => {
  const text = [
    "Plan hash value: 1830264412",
    "",
    "--------------------------------------------------------------------------------------------",
    "| Id  | Operation                    | Name        | Rows  | Bytes | Cost (%CPU)| Time     |",
    "--------------------------------------------------------------------------------------------",
    "|   0 | SELECT STATEMENT             |             |    12K|   480K|   206   (2)| 00:00:01 |",
    "|*  1 |  HASH JOIN                   |             |    12K|   480K|   206   (2)| 00:00:01 |",
    "|   2 |   TABLE ACCESS FULL          | CUSTOMERS   |   990 | 19800 |     5   (0)| 00:00:01 |",
    "|*  3 |   TABLE ACCESS BY INDEX ROWID| ORDERS      |    12K|   240K|   200   (2)| 00:00:01 |",
    "|*  4 |    INDEX RANGE SCAN          | ORDERS_TOTAL|  1200 |       |     3   (0)| 00:00:01 |",
    "--------------------------------------------------------------------------------------------",
    "",
    "Predicate Information (identified by operation id):",
    "---------------------------------------------------",
    "",
    '   1 - access("O"."CUSTOMER_ID"="C"."ID")',
    '   3 - filter("O"."STATUS"=\'OPEN\' AND',
    '              "O"."REGION"=\'EU\')',
    '   4 - access("O"."TOTAL">100)',
    "",
    "Note",
    "-----",
    "   - dynamic statistics used: dynamic sampling (level=2)",
  ].join("\n");

  it("reads the table, nesting by the operation's leading spaces", () => {
    const root = parsePlan(text, "oracle")!;
    expect(labels(root)).toEqual({
      "SELECT STATEMENT": [
        { "HASH JOIN": [{ "TABLE ACCESS FULL CUSTOMERS": [] }, { "TABLE ACCESS BY INDEX ROWID ORDERS": [{ "INDEX RANGE SCAN ORDERS_TOTAL": [] }] }] },
      ],
    });
    expect(root.rows).toBe(12_000);
    expect(root.cost).toBe(206);
    expect(root.children[0].children[0].detail).toEqual(["Bytes: 19800"]);
  });

  it("hangs each predicate on its operation and the rest on the root", () => {
    const root = parsePlan(text, "oracle")!;
    const orders = root.children[0].children[1];
    expect(orders.detail).toEqual(["Bytes: 240K", 'filter("O"."STATUS"=\'OPEN\' AND', '"O"."REGION"=\'EU\')']);
    expect(orders.children[0].detail).toEqual(['access("O"."TOTAL">100)']);
    expect(root.detail).toEqual([
      "Plan hash value: 1830264412",
      "Bytes: 480K",
      "Note",
      "- dynamic statistics used: dynamic sampling (level=2)",
    ]);
    expect(planHotspot(root)?.label).toBe("TABLE ACCESS BY INDEX ROWID ORDERS");
  });

  it("gives up without the table", () => {
    expect(parsePlan("Plan hash value: 1\nno plan", "oracle")).toBeNull();
  });
});

describe("other", () => {
  it("tries the Postgres shape only when it sees arrows", () => {
    expect(parsePlan("QUERY PLAN\nsomething", "other")).toBeNull();
    expect(parsePlan("Scan  (cost=0.00..1.00 rows=1 width=4)\n  ->  Index Scan on t  (cost=0.00..0.50 rows=1 width=4)", "other")?.children).toHaveLength(1);
  });

  it("answers null for empty text", () => {
    expect(parsePlan("   ", "postgres")).toBeNull();
  });
});
