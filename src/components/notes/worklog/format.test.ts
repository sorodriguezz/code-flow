import { describe, expect, it } from "vitest";
import { commitOf, requestOf, summaryOf, toSlack, toTeamsHtml } from "./format";

const NOTE = `## Ayer

- **api-pagos**: 2 commits — «Cuotas», «Tests»
- PR abierto: [#12 Pagos en cuotas](https://example.com/pr/12) (api-pagos)

## Bloqueos

- Ninguno.

<details>
<summary>Fuentes</summary>

- [\`abcdef1\`](#cf-commit=w1:p1:abcdef1234567) Cuotas
</details>

<!-- codeflow:worklog {"period":"previousWorkday","from":null,"to":null,"format":null,"workspaceId":"w1","engine":null,"plain":false,"language":""} -->
`;

describe("a summary note read back", () => {
  it("finds its request and its summary without the sources", () => {
    expect(requestOf(NOTE)).toMatchObject({ period: "previousWorkday", workspaceId: "w1" });
    expect(requestOf("# una nota")).toBeNull();
    expect(requestOf("<!-- codeflow:worklog {roto -->")).toBeNull();
    const summary = summaryOf(NOTE);
    expect(summary.startsWith("## Ayer")).toBe(true);
    expect(summary).not.toContain("Fuentes");
    expect(summary).not.toContain("codeflow:worklog");
  });

  it("reads a commit link", () => {
    expect(commitOf("#cf-commit=w1:p1:abcdef1234567")).toEqual({ workspaceId: "w1", projectId: "p1", sha: "abcdef1234567" });
    expect(commitOf("https://example.com")).toBeNull();
  });
});

describe("copying for chat apps", () => {
  it("writes Slack's mrkdwn", () => {
    const slack = toSlack(summaryOf(NOTE));
    expect(slack).toContain("*Ayer*\n\n• *api-pagos*: 2 commits — «Cuotas», «Tests»");
    expect(slack).toContain("• PR abierto: <https://example.com/pr/12|#12 Pagos en cuotas> (api-pagos)");
    expect(slack).toContain("*Bloqueos*");
    expect(slack).not.toContain("##");
  });

  it("writes HTML Teams keeps, escaped", () => {
    const html = toTeamsHtml("## Hoy\n\n- Sigo con [#12 <x>](https://example.com/pr/12)\n- `feature/pay` **ya**\n\nFin");
    expect(html).toBe(
      '<p><b>Hoy</b></p><ul><li>Sigo con <a href="https://example.com/pr/12">#12 &lt;x&gt;</a></li><li><code>feature/pay</code> <b>ya</b></li></ul><p>Fin</p>',
    );
  });
});
