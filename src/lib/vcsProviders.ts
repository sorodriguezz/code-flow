import { Cloud, GitFork, GitMerge, type LucideIcon } from "lucide-react";

export interface VcsProviderOption {
  id: "azure" | "github" | "gitlab";
  label: string;
  icon: LucideIcon;
  /** Azure DevOps and GitHub are fully wired up (auth, PR list/review/comment); GitLab is
   * shown disabled with a "coming soon" badge until it's built out. */
  available: boolean;
}

export const VCS_PROVIDERS: VcsProviderOption[] = [
  { id: "azure", label: "Azure DevOps", icon: Cloud, available: true },
  { id: "github", label: "GitHub", icon: GitFork, available: true },
  { id: "gitlab", label: "GitLab", icon: GitMerge, available: false },
];
