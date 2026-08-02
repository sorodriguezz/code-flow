import { Cloud, GitFork, GitMerge, type LucideIcon } from "lucide-react";

export interface VcsProviderOption {
  id: "azure" | "github" | "gitlab";
  label: string;
  icon: LucideIcon;
  /** Whether the provider has a credential form and a working PR pipeline behind it. All three
   * do today; the flag stays so a fourth can be listed before it is finished, shown disabled with
   * a "coming soon" badge rather than absent. */
  available: boolean;
}

export const VCS_PROVIDERS: VcsProviderOption[] = [
  { id: "azure", label: "Azure DevOps", icon: Cloud, available: true },
  { id: "github", label: "GitHub", icon: GitFork, available: true },
  { id: "gitlab", label: "GitLab", icon: GitMerge, available: true },
];
