import { Cloud, GitFork, GitMerge, LayoutGrid, SquareKanban, type LucideIcon } from "lucide-react";

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

/**
 * Everything the hosting settings section connects to — the three above plus the two boards.
 *
 * Neither Jira nor monday.com is a `VcsProvider`, and deliberately neither ever becomes one:
 * nothing on the pull-request side may offer them, because they host no code. They belong on this
 * screen all the same, because this is where a user goes to connect an external account, and Azure
 * DevOps has always sat here serving boards and wikis as much as repositories.
 */
export type HostingProvider = VcsProviderOption["id"] | "jira" | "monday";

export const HOSTING_PROVIDERS: { id: HostingProvider; label: string; icon: LucideIcon; available: boolean }[] = [
  ...VCS_PROVIDERS,
  { id: "jira", label: "Jira", icon: SquareKanban, available: true },
  { id: "monday", label: "monday.com", icon: LayoutGrid, available: true },
];
