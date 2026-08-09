import type { DocBlock, DocDocument, DocEntry, DocParam } from "./docs";

/**
 * The HTML rendering of a `DocDocument`: one self-contained file.
 *
 * Self-contained is the requirement everything else bends around — no stylesheet link, no font
 * request, no script from a CDN. The file gets emailed, dropped on a share and opened on a machine
 * that may have no network and certainly has no relationship with this app, and a page that renders
 * unstyled in those conditions is worse than a plain text file. So the CSS is inline, the type is
 * the system stack, and the only script is a nav filter that the page works perfectly without.
 *
 * The palette is written out in literals rather than in the app's `--cf-*` tokens on purpose: those
 * tokens are defined by the running app's theme, which this file will never be inside.
 */

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Paragraphs from plain text: blank lines split, single newlines become breaks. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function slug(text: string, seen: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9 _-]+/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  let id = base;
  let n = 1;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

/** Only the HTTP verbs get a colour; everything else is a protocol name and reads as a label. */
const METHOD_CLASS: Record<string, string> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "put",
  DELETE: "delete",
};

function methodTag(method: string): string {
  return `<span class="method ${METHOD_CLASS[method] ?? "other"}">${esc(method)}</span>`;
}

function codeOrDash(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `<code>${esc(trimmed)}</code>` : `<span class="muted">—</span>`;
}

function paramTable(doc: DocDocument, title: string, params: DocParam[]): string {
  if (params.length === 0) return "";
  const { labels } = doc;
  const rows = params
    .map(
      (p) => `<tr>
        <td>${codeOrDash(p.name)}</td>
        <td>${codeOrDash(p.value)}</td>
        <td>${p.required ? `<span class="pill yes">${esc(labels.yes)}</span>` : `<span class="pill no">${esc(labels.no)}</span>`}</td>
        <td>${p.description ? esc(p.description) : `<span class="muted">—</span>`}</td>
      </tr>`,
    )
    .join("");
  return `<h4>${esc(title)}</h4>
    <div class="scroll"><table>
      <thead><tr>
        <th>${esc(labels.parameter)}</th><th>${esc(labels.value)}</th>
        <th>${esc(labels.required)}</th><th>${esc(labels.description)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function blocks(doc: DocDocument, list: DocBlock[]): string {
  return list
    .map(
      (item) =>
        `${item.caption ? `<p class="caption">${esc(item.caption)}</p>` : ""}` +
        `<pre><code>${esc(item.text)}</code></pre>` +
        `${item.truncated ? `<p class="muted small">${esc(doc.labels.truncated)}</p>` : ""}`,
    )
    .join("");
}

function entryArticle(doc: DocDocument, entry: DocEntry, id: string): string {
  const { labels } = doc;
  const parts: string[] = [
    `<article class="endpoint" id="${esc(id)}">`,
    `<h3>${methodTag(entry.method)}<span>${esc(entry.name)}</span></h3>`,
    `<p class="path"><code>${esc(entry.path)}</code></p>`,
    entry.description
      ? `<div class="desc">${paragraphs(entry.description)}</div>`
      : `<p class="muted">${esc(labels.noDescription)}</p>`,
    `<dl class="facts">
      <dt>${esc(labels.fullUrl)}</dt><dd>${codeOrDash(entry.url)}</dd>
      <dt>${esc(labels.auth)}</dt><dd>${esc(entry.auth)}</dd>
      ${entry.folderPath ? `<dt>${esc(labels.folder)}</dt><dd>${esc(entry.folderPath)}</dd>` : ""}
    </dl>`,
    paramTable(doc, labels.pathParams, entry.pathVars),
    paramTable(doc, labels.queryParams, entry.query),
    paramTable(doc, labels.headers, entry.headers),
  ];

  if (entry.body) {
    parts.push(`<h4>${esc(labels.body)} <span class="tag">${esc(entry.body.label)}</span></h4>`);
    if (entry.body.fields.length) parts.push(paramTable(doc, labels.parameter, entry.body.fields));
    parts.push(blocks(doc, entry.body.blocks));
  }

  if (entry.examples.length) {
    parts.push(`<h4>${esc(labels.examples)}</h4>`);
    for (const example of entry.examples) {
      const status = `${example.status}${example.statusText ? ` ${example.statusText}` : ""}`;
      const tone = example.status >= 400 ? "bad" : example.status >= 300 ? "warn" : "ok";
      parts.push(
        `<p class="example"><span class="status ${tone}">${esc(status)}</span>${esc(example.name)}</p>`,
      );
      if (example.block) parts.push(blocks(doc, [example.block]));
    }
  }

  parts.push("</article>");
  return parts.join("");
}

/**
 * The stylesheet, inline.
 *
 * Both themes are written out because the reader's machine decides, not the author's — and the
 * print rules matter as much as the screen ones, since "open the HTML and hit Ctrl+P" is what
 * anyone without the PDF will do. Printing forces the light palette (a dark page prints as a solid
 * block of toner), drops the navigation, and keeps an endpoint from being split across a page.
 */
const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#ffffff; --panel:#f7f8fa; --text:#1b1f24; --muted:#6a737d; --line:#e3e6ea;
  --accent:#4f46e5; --code-bg:#f4f5f7;
  --get:#0a7d3f; --post:#a15c00; --put:#0b5fa5; --delete:#b3261e; --other:#5a6270;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0f1115; --panel:#161a21; --text:#e6e8ec; --muted:#9099a6; --line:#262c36;
    --accent:#8b85ff; --code-bg:#171b22;
    --get:#4ade80; --post:#fbbf24; --delete:#f87171; --put:#7dd3fc; --other:#98a2b3;
  }
}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--text); line-height:1.6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;
}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.layout{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto;gap:32px;padding:0 24px}
.nav{
  position:sticky; top:0; width:250px; flex:0 0 250px; max-height:100vh; overflow-y:auto;
  padding:28px 0; border-right:1px solid var(--line);
}
.nav h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:20px 0 8px}
.nav ul{list-style:none;margin:0;padding:0}
.nav li{margin:1px 0}
.nav a{display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-radius:6px;color:var(--text);font-size:13px}
.nav a:hover{background:var(--panel);text-decoration:none}
.nav .method{font-size:9px;min-width:38px}
.nav .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#navFilter{
  width:100%;padding:6px 9px;margin-bottom:6px;font:inherit;font-size:13px;
  border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);
}
main{flex:1 1 auto;min-width:0;padding:28px 0 64px}
h1{font-size:30px;line-height:1.25;margin:0 0 8px}
h2{font-size:20px;margin:40px 0 12px;padding-top:8px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:28px 0 6px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
h4{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:20px 0 8px}
p{margin:0 0 10px}
.lede{color:var(--muted);font-size:16px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0;padding:0;list-style:none}
.meta li{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;color:var(--muted)}
.meta strong{color:var(--text);font-weight:600}
.method{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--other);
}
.method.get{color:var(--get)} .method.post{color:var(--post)}
.method.put{color:var(--put)} .method.delete{color:var(--delete)}
.endpoint{
  border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 14px;background:var(--panel);
}
.endpoint h3{margin-top:0}
.path code{font-size:13px;word-break:break-all}
.desc{margin-bottom:10px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:10px 0 4px;font-size:13px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;min-width:0;word-break:break-all}
.scroll{overflow-x:auto;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:var(--bg);font-weight:600;font-size:12px;color:var(--muted);white-space:nowrap}
code{background:var(--code-bg);border-radius:4px;padding:1px 5px;font-size:.9em}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;margin:0 0 12px}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.5}
.muted{color:var(--muted)}
.small{font-size:12px}
.caption{font-size:12px;color:var(--muted);margin-bottom:4px}
.tag{font-size:11px;background:var(--code-bg);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--muted);letter-spacing:0;text-transform:none}
.pill{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--line);white-space:nowrap}
.pill.yes{color:var(--get)} .pill.no{color:var(--muted)}
.example{display:flex;gap:8px;align-items:baseline;font-size:13px;margin-bottom:6px}
.status{font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
.status.ok{color:var(--get)} .status.warn{color:var(--post)} .status.bad{color:var(--delete)}
.summary td:first-child{white-space:nowrap}
footer{margin-top:48px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:860px){
  .layout{display:block;padding:0 18px}
  .nav{position:static;width:auto;max-height:none;border-right:0;border-bottom:1px solid var(--line);padding-bottom:16px}
  main{padding-top:20px}
}
@media print{
  :root{
    --bg:#fff;--panel:#fff;--text:#000;--muted:#444;--line:#bbb;--code-bg:#f4f4f4;
    --get:#0a7d3f;--post:#8a4f00;--put:#0b5fa5;--delete:#b3261e;--other:#444;
  }
  .nav{display:none}
  .layout{display:block;max-width:none;padding:0}
  body{font-size:11pt}
  .endpoint{break-inside:avoid;page-break-inside:avoid;background:none}
  h2{break-after:avoid;page-break-after:avoid}
  pre{white-space:pre-wrap;word-break:break-word}
  a{color:#000;text-decoration:none}
}
`;

/**
 * Filters the sidebar by substring. Progressive enhancement in the strict sense: the page is
 * complete without it, the input is the only thing that stops working, and nothing else on the
 * page depends on the script having run.
 */
const SCRIPT = `
(function(){
  var input=document.getElementById('navFilter');
  if(!input)return;
  var items=[].slice.call(document.querySelectorAll('[data-nav-item]'));
  var groups=[].slice.call(document.querySelectorAll('[data-nav-group]'));
  input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();
    items.forEach(function(li){
      li.style.display=!q||li.getAttribute('data-nav-item').indexOf(q)>=0?'':'none';
    });
    groups.forEach(function(g){
      var list=g.nextElementSibling;
      var any=list?[].slice.call(list.children).some(function(li){return li.style.display!=='none'}):false;
      g.style.display=any?'':'none';
      if(list)list.style.display=any?'':'none';
    });
  });
})();
`;

export function renderDocHtml(doc: DocDocument): string {
  const { labels } = doc;
  const seen = new Set(["overview", "summary"]);
  /** Assigned once, up front, so the nav, the summary table and the sections all agree. */
  const ids = new Map<string, string>();
  const sectionIds = new Map<string, string>();
  for (const section of doc.sections) {
    if (section.title) sectionIds.set(section.id, slug(section.title, seen));
    for (const entry of section.entries) ids.set(entry.id, slug(`${entry.method}-${entry.name}`, seen));
  }

  const nav = doc.sections
    .map((section) => {
      const heading = section.title
        ? `<h2 data-nav-group id="${esc(sectionIds.get(section.id) ?? "")}">${esc(section.title)}</h2>`
        : "";
      const items = section.entries
        .map(
          (entry) =>
            `<li data-nav-item="${esc(`${entry.name} ${entry.path} ${entry.method}`.toLowerCase())}">
              <a href="#${esc(ids.get(entry.id) ?? "")}">${methodTag(entry.method)}<span class="label">${esc(entry.name)}</span></a>
            </li>`,
        )
        .join("");
      return `${heading}<ul>${items}</ul>`;
    })
    .join("");

  const summaryRows = doc.entries
    .map(
      (entry) => `<tr>
        <td>${methodTag(entry.method)}</td>
        <td><a href="#${esc(ids.get(entry.id) ?? "")}">${esc(entry.name)}</a></td>
        <td>${codeOrDash(entry.path)}</td>
        <td>${entry.folderPath ? esc(entry.folderPath) : `<span class="muted">${esc(labels.root)}</span>`}</td>
        <td>${entry.description ? esc(entry.description) : `<span class="muted">${esc(labels.noDescription)}</span>`}</td>
      </tr>`,
    )
    .join("");

  const sections = doc.sections
    .map((section) => {
      const heading = section.title
        ? `<h2 id="${esc(sectionIds.get(section.id) ?? "")}">${esc(section.title)}</h2>` +
          (section.description ? `<div class="desc">${paragraphs(section.description)}</div>` : "")
        : "";
      const body = section.entries
        .map((entry) => entryArticle(doc, entry, ids.get(entry.id) ?? ""))
        .join("");
      return heading + body;
    })
    .join("");

  const variables = doc.variables.length
    ? `<h3>${esc(labels.variables)}</h3>
       <div class="scroll"><table>
         <thead><tr><th>${esc(labels.variable)}</th><th>${esc(labels.value)}</th><th>${esc(labels.description)}</th></tr></thead>
         <tbody>${doc.variables
           .map(
             (v) => `<tr>
               <td>${codeOrDash(v.key)}</td>
               <td>${v.withheld ? `<span class="muted">${esc(labels.withheld)}</span>` : codeOrDash(v.value)}</td>
               <td>${v.description ? esc(v.description) : `<span class="muted">—</span>`}</td>
             </tr>`,
           )
           .join("")}</tbody>
       </table></div>`
    : "";

  return `<!doctype html>
<html lang="${esc(doc.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="CodeFlow">
<title>${esc(doc.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
  <aside class="nav">
    <input id="navFilter" type="search" placeholder="${esc(labels.filterPlaceholder)}" aria-label="${esc(labels.filterPlaceholder)}">
    <ul>
      <li><a href="#overview"><span class="label">${esc(labels.overview)}</span></a></li>
      <li><a href="#summary"><span class="label">${esc(labels.summary)}</span></a></li>
    </ul>
    ${nav}
  </aside>
  <main>
    <h1>${esc(doc.title)}</h1>
    ${doc.description ? `<div class="lede">${paragraphs(doc.description)}</div>` : ""}
    <ul class="meta">
      <li><strong>${doc.counts.requests}</strong> ${esc(labels.requests)}</li>
      <li><strong>${doc.counts.folders}</strong> ${esc(labels.folders)}</li>
      ${doc.counts.undocumented ? `<li><strong>${doc.counts.undocumented}</strong> ${esc(labels.undocumented)}</li>` : ""}
      <li>${esc(labels.generatedAt)} ${esc(doc.generatedAt)}</li>
    </ul>

    <h2 id="overview">${esc(labels.overview)}</h2>
    <dl class="facts">
      ${doc.baseUrl ? `<dt>${esc(labels.baseUrl)}</dt><dd>${codeOrDash(doc.baseUrl)}</dd>` : ""}
      <dt>${esc(labels.auth)}</dt><dd>${esc(doc.auth)}</dd>
    </dl>
    ${variables}

    <h2 id="summary">${esc(labels.summary)}</h2>
    <div class="scroll"><table class="summary">
      <thead><tr>
        <th>${esc(labels.method)}</th><th>${esc(labels.name)}</th><th>${esc(labels.path)}</th>
        <th>${esc(labels.folder)}</th><th>${esc(labels.description)}</th>
      </tr></thead>
      <tbody>${summaryRows}</tbody>
    </table></div>

    ${sections}

    <footer>${esc(labels.generatedBy)} — ${esc(doc.generatedAt)}</footer>
  </main>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
