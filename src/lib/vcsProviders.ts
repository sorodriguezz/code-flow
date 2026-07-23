import { Cloud, GitMerge, SquareTerminal, type LucideIcon } from "lucide-react";

export interface VcsProviderOption {
  id: "azure" | "github" | "gitlab";
  label: string;
  icon: LucideIcon;
  /** Only Azure DevOps is actually wired up (auth, PR list/review/comment) — GitHub and
   * GitLab are shown disabled with a "coming soon" badge until those are built out. */
  available: boolean;
}

export const VCS_PROVIDERS: VcsProviderOption[] = [
  { id: "azure", label: "Azure DevOps", icon: Cloud, available: true },
  { id: "github", label: "GitHub", icon: SquareTerminal, available: false },
  { id: "gitlab", label: "GitLab", icon: GitMerge, available: false },
];
