import type { DocBlock, DocDocument, DocEntry, DocParam } from "./docs";

/**
 * The Markdown rendering of a `DocDocument` — the one meant to be committed.
 *
 * Written for a diff as much as for a reader: one endpoint is one `###` section with its tables
 * under it, so adding a request to a collection adds a contiguous block to the file rather than
 * renumbering the rest of it. That is the whole reason this format exists next to the HTML one.
 */

/** Escapes the characters that would otherwise turn a value into markup mid-table. */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** A value printed as code, or an em dash when there is nothing to print. */
function code(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `\`${cell(trimmed)}\`` : "—";
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

/**
 * A GitHub-style anchor for a heading, so the summary table can link into the document.
 *
 * The rule GitHub applies: lowercase, punctuation dropped, spaces to hyphens. Collisions get a
 * numeric suffix, which is why the caller passes a `seen` set rather than calling this in isolation
 * — two requests called "Create user" in different folders are common and must not share a link.
 */
function anchor(text: string, seen: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  let id = base;
  let n = 1;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

function paramTable(doc: DocDocument, title: string, params: DocParam[]): string[] {
  if (params.length === 0) return [];
  const { labels } = doc;
  return [
    `**${title}**`,
    "",
    ...table(
      [labels.parameter, labels.value, labels.required, labels.description],
      params.map((p) => [
        code(p.name),
        code(p.value),
        p.required ? labels.yes : labels.no,
        cell(p.description) || "—",
      ]),
    ),
  ];
}

function fence(doc: DocDocument, blocks: DocBlock[]): string[] {
  const out: string[] = [];
  for (const item of blocks) {
    if (item.caption) out.push(`*${cell(item.caption)}*`, "");
    // A fence long enough to survive a payload that contains one itself.
    const ticks = "```";
    out.push(`${ticks}${item.language}`, item.text, ticks, "");
    if (item.truncated) out.push(`*${doc.labels.truncated}*`, "");
  }
  return out;
}

function entryBlock(doc: DocDocument, entry: DocEntry, heading: string): string[] {
  const { labels } = doc;
  const out: string[] = [`${heading} ${entry.name}`, ""];

  out.push(`\`${entry.method}\` \`${cell(entry.path)}\``, "");
  if (entry.description) out.push(entry.description, "");
  else out.push(`*${labels.noDescription}*`, "");

  out.push(`- **${labels.fullUrl}:** ${code(entry.url)}`);
  out.push(`- **${labels.auth}:** ${cell(entry.auth)}`);
  if (entry.folderPath) out.push(`- **${labels.folder}:** ${cell(entry.folderPath)}`);
  out.push("");

  out.push(...paramTable(doc, labels.pathParams, entry.pathVars));
  out.push(...paramTable(doc, labels.queryParams, entry.query));
  out.push(...paramTable(doc, labels.headers, entry.headers));

  if (entry.body) {
    out.push(`**${labels.body}** — ${cell(entry.body.label)}`, "");
    if (entry.body.fields.length) {
      out.push(
        ...table(
          [labels.parameter, labels.value, labels.required, labels.description],
          entry.body.fields.map((f) => [
            code(f.name),
            code(f.value),
            f.required ? labels.yes : labels.no,
            cell(f.description) || "—",
          ]),
        ),
      );
    }
    out.push(...fence(doc, entry.body.blocks));
  }

  if (entry.examples.length) {
    out.push(`**${labels.examples}**`, "");
    for (const example of entry.examples) {
      const status = `${example.status}${example.statusText ? ` ${example.statusText}` : ""}`;
      out.push(`*${cell(example.name)} — ${labels.status} ${cell(status)}*`, "");
      if (example.block) out.push(...fence(doc, [example.block]));
    }
  }

  return out;
}

export function renderDocMarkdown(doc: DocDocument): string {
  const { labels } = doc;
  const lines: string[] = [`# ${doc.title}`, ""];

  if (doc.description) lines.push(doc.description, "");

  // The overview is a definition list rather than a table: it is three or four facts, and a table
  // of three rows costs more lines than it saves anyone reading the raw file.
  lines.push(`## ${labels.overview}`, "");
  if (doc.baseUrl) lines.push(`- **${labels.baseUrl}:** ${code(doc.baseUrl)}`);
  lines.push(`- **${labels.auth}:** ${cell(doc.auth)}`);
  lines.push(
    `- **${labels.summary}:** ${doc.counts.requests} ${labels.requests}, ${doc.counts.folders} ${labels.folders}`,
  );
  if (doc.counts.undocumented) {
    lines.push(`- **${doc.counts.undocumented}** ${labels.undocumented}`);
  }
  lines.push(`- **${labels.generatedAt}:** ${doc.generatedAt}`, "");

  if (doc.variables.length) {
    lines.push(`### ${labels.variables}`, "");
    lines.push(
      ...table(
        [labels.variable, labels.value, labels.description],
        doc.variables.map((v) => [
          code(v.key),
          v.withheld ? `*${labels.withheld}*` : code(v.value),
          cell(v.description) || "—",
        ]),
      ),
    );
  }

  /**
   * Anchors are assigned in the same order the headings are written below, so the summary table's
   * links and the sections they point at cannot drift apart — both walk `doc.sections`.
   */
  const seen = new Set<string>();
  const anchors = new Map<string, string>();
  for (const section of doc.sections) {
    if (section.title) anchor(section.title, seen);
    for (const entry of section.entries) anchors.set(entry.id, anchor(entry.name, seen));
  }

  lines.push(`## ${labels.summary}`, "");
  lines.push(
    ...table(
      [labels.method, labels.name, labels.path, labels.folder, labels.description],
      doc.entries.map((entry) => [
        `\`${entry.method}\``,
        `[${cell(entry.name)}](#${anchors.get(entry.id) ?? ""})`,
        code(entry.path),
        cell(entry.folderPath) || labels.root,
        cell(entry.description) || `*${labels.noDescription}*`,
      ]),
    ),
  );

  // Every section is `##` and every endpoint `###`, regardless of how deep the folder is.
  // `section.title` is already the full path ("user / admin"), so it carries the nesting on its
  // own; mirroring that in the heading level as well would push a fourth-level folder's endpoints
  // past `######`, which has no level below it to put them on.
  for (const section of doc.sections) {
    if (section.title) {
      lines.push(`## ${section.title}`, "");
      if (section.description) lines.push(section.description, "");
    }
    for (const entry of section.entries) lines.push(...entryBlock(doc, entry, "###"));
  }

  lines.push("---", "", `*${labels.generatedBy} — ${doc.generatedAt}*`, "");
  return lines.join("\n");
}
