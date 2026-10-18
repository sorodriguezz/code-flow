import type { StoryBatch, StoryDraft } from "../../types/domain";

/**
 * A batch of stories as files to hand on: Markdown to read (a heading per story, its narrative,
 * description and numbered criteria) and CSV to import into a board this app does not publish to —
 * one row per story, the criteria joined into one cell.
 */

function criteriaOf(story: StoryDraft): string[] {
  try {
    const parsed: unknown = JSON.parse(story.acceptance_criteria || "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string" && c.trim() !== "") : [];
  } catch {
    return [];
  }
}

export function storiesMarkdown(batch: Pick<StoryBatch, "title">, stories: StoryDraft[], labels: { criteria: string; points: string; tags: string }): string {
  const parts: string[] = [`# ${batch.title.trim() || "Historias"}`];
  for (const story of stories) {
    const lines: string[] = [`## ${story.title.trim()}`];
    if (story.work_item_url) lines.push(`[${story.work_item_key || `#${story.work_item_id}`}](${story.work_item_url})`);
    if (story.narrative.trim()) lines.push(`**${story.narrative.trim()}**`);
    if (story.description.trim()) lines.push(story.description.trim());
    const criteria = criteriaOf(story);
    if (criteria.length > 0) {
      lines.push(`### ${labels.criteria}`);
      lines.push(
        criteria
          .map((criterion, index) => {
            const [first, ...rest] = criterion.trim().split("\n");
            return [`${index + 1}. ${first}`, ...rest.map((line) => `   ${line}`)].join("\n");
          })
          .join("\n"),
      );
    }
    const meta = [story.story_points > 0 ? `${labels.points}: ${story.story_points}` : "", story.tags.trim() ? `${labels.tags}: ${story.tags.trim()}` : ""].filter(Boolean);
    if (meta.length > 0) lines.push(`_${meta.join(" · ")}_`);
    parts.push(lines.join("\n\n"));
  }
  return parts.join("\n\n") + "\n";
}

/** One CSV cell: quoted when it holds a comma, a quote or a line break, quotes doubled. */
function cell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_HEADER = ["Title", "Narrative", "Description", "Acceptance criteria", "Priority", "Story points", "Tags", "Work item", "State"];

export function storiesCsv(stories: StoryDraft[]): string {
  const rows = stories.map((story) =>
    [
      story.title.trim(),
      story.narrative.trim(),
      story.description.trim(),
      criteriaOf(story).map((c, i) => `${i + 1}. ${c.trim()}`).join("\n"),
      story.priority || "",
      story.story_points || "",
      story.tags.trim(),
      story.work_item_url || "",
      story.board_state ?? "",
    ]
      .map(cell)
      .join(","),
  );
  // A byte-order mark so Excel reads the accents as UTF-8.
  return `﻿${[CSV_HEADER.join(","), ...rows].join("\r\n")}\r\n`;
}
