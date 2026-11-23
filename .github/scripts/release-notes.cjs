#!/usr/bin/env node
/**
 * Builds the body of a GitHub release.
 *
 * This isn't only for people browsing the Releases page: the updater serves the release body as
 * the `notes` field of `latest.json`, and CodeFlow shows it verbatim in its "What's new" window
 * when it finds a newer version. So this output is user-facing product copy.
 *
 * The source is `CHANGELOG.md`'s section for this version (`## 2.9.4`, `## [2.9.4]` or
 * `## v2.9.4`, optionally followed by ` — <date>`), written for users rather than developers.
 * Only when that section is missing does it fall back to the commits since the previous tag —
 * with the version-bump and CI plumbing filtered out — because a release that says something is
 * better than one that says nothing. The workflow warns when that happens.
 *
 * Reads VERSION (the version being released), PREV (previous tag, may be empty on the very first
 * release) and REPO (`owner/name`) from the environment and writes markdown to stdout.
 *
 * Run it locally to see what the next release would say:
 *   VERSION=2.9.4 PREV=v2.9.2 REPO=sorodriguezz/code-flow node .github/scripts/release-notes.cjs
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const prev = process.env.PREV || "";
const repo = process.env.REPO || "";
const version = (process.env.VERSION || "").replace(/^v/, "");

/** This version's section of CHANGELOG.md, without its heading; `null` when there is none (or it
 * is empty — an empty heading is a forgotten entry, not a release with nothing to say). */
function changelogSection() {
  if (!version) return null;
  const file = path.join(__dirname, "..", "..", "CHANGELOG.md");
  if (!fs.existsSync(file)) return null;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

const curated = changelogSection();
if (curated !== null) {
  const out = [curated];
  if (prev && repo) {
    out.push(`**Cambios completos:** [${prev}...v${version}](https://github.com/${repo}/compare/${prev}...v${version})`);
  }
  process.stdout.write(out.join("\n\n") + "\n");
  process.exit(0);
}

/** Conventional-commit prefixes, in the order they're worth reading. Anything unrecognised —
 * including commits written without a prefix at all — lands in "Other changes" rather than
 * being dropped, because a silently missing change is worse than an unsorted one. */
const GROUPS = [
  { key: "feat", title: "✨ Nuevo" },
  { key: "fix", title: "🐛 Corregido" },
  { key: "perf", title: "⚡ Rendimiento" },
  { key: "refactor", title: "♻️ Mejoras internas" },
  { key: "docs", title: "📝 Documentación" },
  { key: "other", title: "🧹 Otros cambios" },
];

/** Release plumbing: the version bump that triggers this very workflow, and CI edits. Nobody
 * reading "what's new in v1.8.0" wants to be told that v1.8.0 was numbered. */
const PLUMBING = /^(chore|ci|build)(\([^)]*\))?!?:\s*(bump|release|version|update package\.json)/i;

const SEP = "\u001f";
const range = prev ? `${prev}..HEAD` : "HEAD";
const log = execSync(`git log --no-merges --pretty=format:%s${SEP}%h ${range}`, {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
}).trim();

const buckets = new Map(GROUPS.map((g) => [g.key, []]));

for (const line of log ? log.split("\n") : []) {
  const [subject = "", hash = ""] = line.split(SEP);
  if (!subject || PLUMBING.test(subject)) continue;

  const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject);
  // "other" is a bucket, not a commit type — a subject that doesn't carry a prefix this script
  // knows keeps its whole text, prefix included, because that text is the sentence.
  const type = match && GROUPS.some((g) => g.key === match[1].toLowerCase() && g.key !== "other")
    ? match[1].toLowerCase()
    : "other";
  const scope = type === "other" ? "" : match[2] || "";
  const text = type === "other" ? subject : match[3];

  const link = repo && hash ? ` ([\`${hash}\`](https://github.com/${repo}/commit/${hash}))` : "";
  buckets.get(type).push(`- ${scope ? `**${scope}:** ` : ""}${text}${link}`);
}

const sections = GROUPS.filter((g) => buckets.get(g.key).length > 0).map(
  (g) => `### ${g.title}\n${buckets.get(g.key).join("\n")}`,
);

const out = [];
out.push(sections.length ? sections.join("\n\n") : "Versión de mantenimiento, sin cambios visibles.");
if (prev && repo) {
  const to = version ? `v${version}` : "HEAD";
  out.push(`**Cambios completos:** [${prev}...${to}](https://github.com/${repo}/compare/${prev}...${to})`);
}

process.stdout.write(out.join("\n\n") + "\n");
