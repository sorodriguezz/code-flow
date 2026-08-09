import type {
  Content,
  TableCell,
  TDocumentDefinitions,
  TFontContainer,
  TVirtualFileSystem,
} from "pdfmake/interfaces";
import type { DocBlock, DocDocument, DocEntry, DocParam } from "./docs";

/**
 * The PDF rendering of a `DocDocument` — the copy that gets emailed to someone who will never open
 * a repository.
 *
 * Real text, not a screenshot of the HTML: the page is laid out by pdfmake, so the result is
 * selectable, searchable and a tenth the size of a rasterised one. The cost is that this is a
 * second layout rather than a restyling of the first, which is exactly why both read from the same
 * `DocDocument` — the two files can look different, but they cannot *say* different things.
 *
 * pdfmake and its fonts are ~2 MB and are loaded by `import()` at the moment a PDF is asked for, so
 * they stay out of the app's startup bundle. Everything below the loader assumes that has happened.
 */

/** A4 at pdfmake's default 40pt margins. Column widths are picked against this. */
const CONTENT_W = 515;

/** Same palette as the HTML document's light theme, so the two are recognisably one family. */
const COLORS = {
  text: "#1b1f24",
  muted: "#6a737d",
  line: "#e3e6ea",
  panel: "#f7f8fa",
  code: "#f4f5f7",
  accent: "#4f46e5",
  get: "#0a7d3f",
  post: "#a15c00",
  put: "#0b5fa5",
  delete: "#b3261e",
  other: "#5a6270",
};

function methodColor(method: string): string {
  switch (method) {
    case "GET":
      return COLORS.get;
    case "POST":
      return COLORS.post;
    case "PUT":
    case "PATCH":
      return COLORS.put;
    case "DELETE":
      return COLORS.delete;
    default:
      return COLORS.other;
  }
}

/**
 * Hard-wraps lines too long for the content column.
 *
 * pdfmake breaks text at spaces and nowhere else, so a single long token — a minified payload, a
 * base64 blob, a URL in a header value — runs off the right edge of the page instead of wrapping.
 * Bodies reach here pretty-printed where they are JSON, but nothing guarantees that for XML or for
 * a raw string, and an overflowing line is the one failure that makes a PDF look broken.
 *
 * The width is derived from Courier's metrics: every glyph is 0.6em, so `CONTENT_W` at `size` pt
 * fits `CONTENT_W / (0.6 * size)` characters. A couple are shaved off for the cell padding.
 */
function wrapLongLines(text: string, size: number): string {
  const limit = Math.floor(CONTENT_W / (0.6 * size)) - 3;
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= limit) return line;
      const chunks: string[] = [];
      for (let at = 0; at < line.length; at += limit) chunks.push(line.slice(at, at + limit));
      return chunks.join("\n");
    })
    .join("\n");
}

/** A shaded box for a quoted payload — pdfmake has no block element, so a one-cell table is it. */
function codeBox(text: string, doc: DocDocument, truncated: boolean): Content[] {
  const out: Content[] = [
    {
      table: { widths: ["*"], body: [[{ text: wrapLongLines(text, 7.5), style: "code" }]] },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 7,
        paddingRight: () => 7,
        paddingTop: () => 6,
        paddingBottom: () => 6,
        fillColor: () => COLORS.code,
      },
      margin: [0, 2, 0, 8],
    },
  ];
  if (truncated) out.push({ text: doc.labels.truncated, style: "note", margin: [0, -4, 0, 8] });
  return out;
}

function blocks(list: DocBlock[], doc: DocDocument): Content[] {
  return list.flatMap<Content>((item) => [
    ...(item.caption ? [{ text: item.caption, style: "note" } as Content] : []),
    ...codeBox(item.text, doc, item.truncated),
  ]);
}

/** The header row style is applied per cell: pdfmake has no "style the header row" switch. */
function headerCells(labels: string[]): TableCell[] {
  return labels.map((text) => ({ text, style: "th" }));
}

function paramTable(title: string, params: DocParam[], doc: DocDocument): Content[] {
  if (params.length === 0) return [];
  const { labels } = doc;
  return [
    { text: title, style: "h4" },
    {
      table: {
        headerRows: 1,
        widths: [110, 130, 42, "*"],
        body: [
          headerCells([labels.parameter, labels.value, labels.required, labels.description]),
          ...params.map<TableCell[]>((p) => [
            { text: p.name, style: "cellCode" },
            { text: p.value || "—", style: "cellCode" },
            { text: p.required ? labels.yes : labels.no, style: "cell" },
            { text: p.description || "—", style: "cell" },
          ]),
        ],
      },
      layout: tableLayout(),
      margin: [0, 0, 0, 10],
    },
  ];
}

/** Hairline grid in the document's own line colour — pdfmake's built-ins are all heavier than this. */
function tableLayout() {
  return {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => COLORS.line,
    vLineColor: () => COLORS.line,
    paddingLeft: () => 5,
    paddingRight: () => 5,
    paddingTop: () => 3,
    paddingBottom: () => 3,
  };
}

function entryContent(entry: DocEntry, doc: DocDocument): Content[] {
  const { labels } = doc;
  const out: Content[] = [
    {
      // The verb and the name on one line, the verb carrying the only colour on the page. Tagged
      // `headlineLevel` so `pageBreakBefore` can keep it off the bottom of a page on its own.
      text: [
        { text: `${entry.method}  `, color: methodColor(entry.method), bold: true, font: "Courier" },
        { text: entry.name, bold: true },
      ],
      style: "h3",
      headlineLevel: 2,
    },
    { text: entry.path, style: "path" },
  ];

  out.push(
    entry.description
      ? { text: entry.description, style: "body", margin: [0, 0, 0, 6] }
      : { text: labels.noDescription, style: "note", margin: [0, 0, 0, 6] },
  );

  const facts: TableCell[][] = [
    [
      { text: labels.fullUrl, style: "factKey" },
      { text: entry.url || "—", style: "factValueCode" },
    ],
    [
      { text: labels.auth, style: "factKey" },
      { text: entry.auth, style: "factValue" },
    ],
  ];
  if (entry.folderPath) {
    facts.push([
      { text: labels.folder, style: "factKey" },
      { text: entry.folderPath, style: "factValue" },
    ]);
  }
  out.push({
    table: { widths: [70, "*"], body: facts },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 4,
      paddingTop: () => 1,
      paddingBottom: () => 1,
    },
    margin: [0, 0, 0, 8],
  });

  out.push(...paramTable(labels.pathParams, entry.pathVars, doc));
  out.push(...paramTable(labels.queryParams, entry.query, doc));
  out.push(...paramTable(labels.headers, entry.headers, doc));

  if (entry.body) {
    out.push({ text: `${labels.body} — ${entry.body.label}`, style: "h4" });
    if (entry.body.fields.length) out.push(...paramTable(labels.parameter, entry.body.fields, doc));
    out.push(...blocks(entry.body.blocks, doc));
  }

  if (entry.examples.length) {
    out.push({ text: labels.examples, style: "h4" });
    for (const example of entry.examples) {
      const status = `${example.status}${example.statusText ? ` ${example.statusText}` : ""}`;
      const tone =
        example.status >= 400 ? COLORS.delete : example.status >= 300 ? COLORS.post : COLORS.get;
      out.push({
        text: [
          { text: `${status}  `, color: tone, bold: true, font: "Courier" },
          { text: example.name },
        ],
        style: "note",
        margin: [0, 0, 0, 3],
      });
      if (example.block) out.push(...blocks([example.block], doc));
    }
  }

  return out;
}

function buildDefinition(doc: DocDocument): TDocumentDefinitions {
  const { labels } = doc;

  const counts = [
    `${doc.counts.requests} ${labels.requests}`,
    `${doc.counts.folders} ${labels.folders}`,
    ...(doc.counts.undocumented ? [`${doc.counts.undocumented} ${labels.undocumented}`] : []),
  ].join("  ·  ");

  // The cover. Pushed down with a margin rather than centred, because pdfmake has no vertical
  // centring and a fixed offset is stable across title lengths in a way a computed one is not.
  const content: Content[] = [
    { text: doc.title, style: "coverTitle", margin: [0, 170, 0, 0] },
    ...(doc.description ? [{ text: doc.description, style: "coverLede" } as Content] : []),
    { text: counts, style: "coverMeta", margin: [0, 18, 0, 0] },
    ...(doc.baseUrl
      ? [{ text: `${labels.baseUrl}: ${doc.baseUrl}`, style: "coverMeta" } as Content]
      : []),
    { text: `${labels.auth}: ${doc.auth}`, style: "coverMeta" },
    { text: `${labels.generatedBy} — ${doc.generatedAt}`, style: "coverFoot", margin: [0, 26, 0, 0] },
  ];

  content.push({ text: labels.summary, style: "h1", pageBreak: "before" });
  content.push({
    table: {
      headerRows: 1,
      widths: [46, 100, 108, 70, "*"],
      body: [
        headerCells([labels.method, labels.name, labels.path, labels.folder, labels.description]),
        ...doc.entries.map<TableCell[]>((entry) => [
          { text: entry.method, style: "cellCode", color: methodColor(entry.method), bold: true },
          { text: entry.name, style: "cell" },
          { text: entry.path, style: "cellCode" },
          { text: entry.folderPath || labels.root, style: "cell" },
          { text: entry.description || labels.noDescription, style: "cell" },
        ]),
      ],
    },
    layout: tableLayout(),
    margin: [0, 0, 0, 10],
  });

  for (const [at, section] of doc.sections.entries()) {
    if (section.title) {
      content.push({
        text: section.title,
        style: "h2",
        headlineLevel: 1,
        // Every top-level folder opens a page; deeper ones flow, so a collection of many small
        // subfolders doesn't turn into a document of many nearly-empty pages. The first section
        // is exempt — the summary table just broke to this page and is usually still half empty.
        ...(section.depth <= 1 && at > 0 ? { pageBreak: "before" as const } : {}),
      });
      if (section.description) {
        content.push({ text: section.description, style: "body", margin: [0, 0, 0, 8] });
      }
    }
    for (const entry of section.entries) content.push(...entryContent(entry, doc));
  }

  return {
    info: { title: doc.title, creator: "CodeFlow", producer: "CodeFlow" },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 44],
    content,
    // The cover carries its own credit line, so the running footer starts on page two.
    footer: (currentPage: number, pageCount: number) =>
      currentPage === 1
        ? ""
        : {
            columns: [
              { text: doc.title, style: "footer" },
              {
                text: `${labels.page} ${currentPage} ${labels.of} ${pageCount}`,
                style: "footer",
                alignment: "right",
              },
            ],
            margin: [40, 12, 40, 0],
          },
    /**
     * Keeps a heading from being the last thing on a page.
     *
     * pdfmake asks this for every node; answering `true` moves the node to the next page. A heading
     * with nothing after it on the page is a heading the reader has to turn over to act on, which
     * is the one break a document like this can't afford — the name of the endpoint and the table
     * describing it have to be visible together.
     */
    pageBreakBefore: (current, queries) =>
      current.headlineLevel !== undefined && queries.getFollowingNodesOnPage().length === 0,
    defaultStyle: { font: "Roboto", fontSize: 9, color: COLORS.text, lineHeight: 1.25 },
    styles: {
      coverTitle: { fontSize: 30, bold: true },
      coverLede: { fontSize: 12, color: COLORS.muted, margin: [0, 10, 0, 0] },
      coverMeta: { fontSize: 9.5, color: COLORS.muted, margin: [0, 2, 0, 0] },
      coverFoot: { fontSize: 8.5, color: COLORS.muted },
      h1: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] },
      h2: { fontSize: 15, bold: true, margin: [0, 0, 0, 10], color: COLORS.accent },
      h3: { fontSize: 12, margin: [0, 10, 0, 2] },
      h4: {
        fontSize: 8,
        bold: true,
        characterSpacing: 0.4,
        color: COLORS.muted,
        margin: [0, 6, 0, 3],
      },
      body: { fontSize: 9 },
      path: { font: "Courier", fontSize: 9, color: COLORS.muted, margin: [0, 0, 0, 5] },
      note: { fontSize: 8, color: COLORS.muted },
      th: { fontSize: 7.5, bold: true, color: COLORS.muted, fillColor: COLORS.panel },
      cell: { fontSize: 8 },
      cellCode: { font: "Courier", fontSize: 7.5 },
      code: { font: "Courier", fontSize: 7.5, lineHeight: 1.15 },
      factKey: { fontSize: 8, color: COLORS.muted },
      factValue: { fontSize: 8 },
      factValueCode: { font: "Courier", fontSize: 7.5 },
      footer: { fontSize: 7.5, color: COLORS.muted },
    },
  };
}

/**
 * Pulls in pdfmake, its Roboto virtual filesystem and the Courier metrics.
 *
 * The two font modules self-register when a global `pdfMake` already exists, which it does not
 * here, so both are wired explicitly. `default ?? module` covers the interop: these are UMD builds,
 * and whether the namespace or its `default` is the callable object depends on the bundler.
 */
async function loadPdfMake() {
  const [core, vfsMod, courierMod] = await Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
    import("pdfmake/build/standard-fonts/Courier"),
  ]);
  type Core = typeof core;
  const unwrap = <T,>(mod: unknown): T => (mod as { default?: T }).default ?? (mod as T);
  const pdfMake = unwrap<Core>(core);
  pdfMake.addVirtualFileSystem(unwrap<TVirtualFileSystem>(vfsMod));
  pdfMake.addFontContainer(unwrap<TFontContainer>(courierMod));
  return pdfMake;
}

/** The finished PDF as base64, ready for `apiSaveBinaryFile`. */
export async function renderDocPdf(doc: DocDocument): Promise<string> {
  const pdfMake = await loadPdfMake();
  return pdfMake.createPdf(buildDefinition(doc)).getBase64();
}
