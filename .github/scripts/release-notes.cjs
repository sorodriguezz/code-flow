#!/usr/bin/env node
/**
 * Builds the body of a GitHub release from the commits since the previous tag.
 *
 * This isn't only for people browsing the Releases page: the updater serves the release body as
 * the `notes` field of `latest.json`, and CodeFlow shows it verbatim in its "What's new" window
 * when it finds a newer version. So this output is user-facing product copy — which is why the
 * version-bump and CI plumbing commits are filtered out rather than listed as news.
 *
 * Reads PREV (previous tag, may be empty on the very first release) and REPO (`owner/name`) from
 * the environment and writes markdown to stdout.
 *
 * Run it locally to see what the next release would say:
 *   PREV=v1.6.0 REPO=sorodriguezz/code-flow node .github/scripts/release-notes.cjs
 */
const { execSync } = require("node:child_process");

const prev = process.env.PREV || "";
const repo = process.env.REPO || "";

/** Conventional-commit prefixes, in the order they're worth reading. Anything unrecognised —
 * including commits written without a prefix at all — lands in "Other changes" rather than
 * being dropped, because a silently missing change is worse than an unsorted one. */
const GROUPS = [
  { key: "feat", title: "✨ New" },
  { key: "fix", title: "🐛 Fixes" },
  { key: "perf", title: "⚡ Performance" },
  { key: "refactor", title: "♻️ Under the hood" },
  { key: "docs", title: "📝 Documentation" },
  { key: "other", title: "🧹 Other changes" },
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
out.push(sections.length ? sections.join("\n\n") : "Maintenance release — no user-facing changes.");
if (prev && repo) {
  const to = process.env.VERSION ? `v${process.env.VERSION}` : "HEAD";
  out.push(`**Full changelog:** [${prev}...${to}](https://github.com/${repo}/compare/${prev}...${to})`);
}

process.stdout.write(out.join("\n\n") + "\n");
