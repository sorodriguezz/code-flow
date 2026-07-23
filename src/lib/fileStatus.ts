import type { TranslationKey } from "./i18n/translations";

// git's own vocabulary ("untracked", "typechange"...) isn't very readable to anyone who
// hasn't internalized git's internals — map each raw status to a plain-language label.
const STATUS_KEYS: Record<string, TranslationKey> = {
  untracked: "fileStatus.new",
  added: "fileStatus.added",
  modified: "fileStatus.modified",
  deleted: "fileStatus.deleted",
  renamed: "fileStatus.renamed",
  copied: "fileStatus.copied",
  typechange: "fileStatus.typechange",
  conflicted: "fileStatus.conflicted",
  ignored: "fileStatus.ignored",
  unmodified: "fileStatus.unmodified",
};

export function fileStatusLabelKey(status: string): TranslationKey {
  return STATUS_KEYS[status] ?? "fileStatus.modified";
}

export function fileStatusColor(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--cf-success)";
    case "deleted":
      return "var(--cf-danger)";
    case "renamed":
    case "copied":
      return "var(--cf-accent)";
    default:
      return "var(--cf-warning)";
  }
}
