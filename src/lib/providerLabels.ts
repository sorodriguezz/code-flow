import type { VcsProvider } from "../types/domain";
import type { TranslationKey } from "./i18n/translations";

/**
 * The provider-specific copy, as lookups rather than ternaries.
 *
 * That is the whole point of the file. `provider === "github" ? viewOnGithub : viewOnAdo`
 * typechecks perfectly well after a third provider is added — and quietly labels every GitLab
 * merge request "View on Azure DevOps". A `Record<VcsProvider, …>` cannot compile with an arm
 * missing, so the next provider is a build error rather than a mislabelled button nobody notices
 * for a release.
 *
 * Azure's keys carry no provider suffix because they predate there being more than one host.
 */

/** Where a pull request lives — the label on the "open in browser" link. */
export const VIEW_ON_KEYS: Record<VcsProvider, TranslationKey> = {
  azure: "chat.viewOnAdo",
  github: "chat.viewOnGithub",
  gitlab: "chat.viewOnGitlab",
};

/** The confirmation shown before publishing a review's comments onto the host. */
export const CONFIRM_POST_KEYS: Record<VcsProvider, TranslationKey> = {
  azure: "chat.confirmPost",
  github: "chat.confirmPostGithub",
  gitlab: "chat.confirmPostGitlab",
};

/** The button's label once they landed. */
export const POSTED_KEYS: Record<VcsProvider, TranslationKey> = {
  azure: "chat.posted",
  github: "chat.postedGithub",
  gitlab: "chat.postedGitlab",
};
