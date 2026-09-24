import { DEFAULT_ICON_RULES, type IconRule } from "./rules";
import { SHIPPED_PACKS } from "./packs";

/**
 * Named sets of icon rules, one of which is active per repository.
 *
 * # Why one list of rules was not enough
 *
 * `*.service.ts` is an Angular service. It is also a NestJS provider. `*.module.ts` is an
 * `NgModule`, and it is also a Nest module. `*.controller.ts` means nothing in Angular and is the
 * centre of a Nest app. These are not edge cases — they are the two most common TypeScript backends
 * and frontends in the same language, using the same suffixes for different things, and a single
 * global list has to pick one and be wrong in the other repository.
 *
 * Order cannot resolve it either, because the disambiguator is not the filename: it is *which
 * repository you are in*. So the rule set becomes the thing you switch, and what switches it is the
 * checkout — the granularity the collision actually lives at. Not the workspace: the Angular app and
 * the API it talks to are routinely two repos in one workspace, and scoping it a level up would put
 * them back in the argument this feature exists to settle.
 *
 * # What is global and what is not
 *
 * A profile is a **theme**: "in Nest projects, `*.service.ts` looks like this" is a fact about how
 * this person reads code, so the profiles themselves live in `app_settings` with the accent and the
 * keybindings, and travel in the backup. Only the *selection* is per repository — one small key per
 * repo saying which of them is on. That way defining Nest once serves every Nest checkout, and a
 * repo opened for the first time inherits nothing it has to be told about.
 */
export interface IconProfile {
  id: string;
  name: string;
  /** Ordered, first match wins — the same list the panel has always edited. */
  rules: IconRule[];
  /** Catalogue id for every folder no rule claims, or `null` for the app's own Lucide folder. Part
   * of the profile because it is part of the look: a Nest profile wanting a red default folder and
   * an Angular one wanting the plain glyph is the same kind of choice as any rule in the list. */
  defaultFolderIcon: string | null;
}

/**
 * The profile a repository falls back to when it has no choice of its own and its stack is not
 * recognised (see `detectProfile.ts`).
 *
 * General, now that General is a whole icon theme rather than seven rules. It used to be Angular,
 * kept for the sake of installs that never opened the panel — but a React or Spring checkout drawn
 * with Angular's reading of `*.service.ts` was the wrong answer for everybody who was not writing
 * Angular, and the repositories that *are* Angular now get Angular by detection instead of by luck.
 */
export const DEFAULT_PROFILE_ID = "base";

/**
 * What the app ships: General and one pack per framework, each complete on its own (see `packs.ts`
 * for how they are built and why each one repeats the base).
 *
 * This was three profiles for a long time, on the argument that a profile is only worth shipping
 * where the same filename means different things in different stacks. That argument is still why
 * profiles are per repository; what changed is what a profile is *for*. The user asked for packs
 * that make each stack look like itself out of the box — Spring's controllers and repositories,
 * .NET's `appsettings`, FastAPI's `schemas.py` — and for General to stop looking empty.
 */
export const BUILT_IN_PROFILES: IconProfile[] = SHIPPED_PACKS.map((shipped) => ({
  id: shipped.id,
  name: shipped.name,
  rules: shipped.rules,
  defaultFolderIcon: null,
}));

/**
 * The version of a profile this app ships, if it ships one.
 *
 * What makes "restore" answerable for Angular and not for a profile the user wrote: there is a set
 * of rules to go back *to*. Matched on the id rather than the name, so restoring still works after
 * somebody renames Angular to "Front".
 */
export function shippedProfile(id: string): IconProfile | null {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id) ?? null;
}

/** A profile by id, falling back to the first one — a repository can hold the id of a profile that
 * has since been deleted, and an explorer with no icons at all is a worse answer than the wrong
 * ones. */
export function profileById(profiles: IconProfile[], id: string | null): IconProfile | null {
  if (profiles.length === 0) return null;
  return profiles.find((profile) => profile.id === id) ?? profiles[0];
}

/**
 * A name no profile in the list is already using.
 *
 * Not a uniqueness guarantee — the `id` is the key, and `renameProfile` will happily give two
 * profiles the same name if that is what somebody types. This exists for one gesture: sharing a
 * profile means receiving it twice, and importing the same file a second time would otherwise leave
 * the bar's `Select` showing two identical labels with no way to tell which is which. Suffixing at
 * import is cheaper than making the picker explain itself.
 *
 * The ` 2` suffix is the one `duplicateProfile` already proposes, so both ways of ending up with a
 * second copy read the same in the list. Compared trimmed and lowercased because "Nest" and "nest "
 * are the same profile to everyone except `===`.
 *
 * Untranslated fallback, exactly as `addProfile` has it: a profile name is the user's data, not the
 * app's copy, and one that changed language under them would look like a different profile.
 */
export function uniqueProfileName(profiles: IconProfile[], wanted: string): string {
  const base = wanted.trim() || "Profile";
  const taken = new Set(profiles.map((profile) => profile.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  // The bound is proved, not guessed: `taken` holds at most `profiles.length` names, so among the
  // `profiles.length + 1` candidates tried here at least one is free. The loop always finds it and
  // needs no escape hatch; the return below is there for the type checker.
  for (let n = 2; n <= profiles.length + 2; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${profiles.length + 3}`;
}

/** Deep-equal against the rules this app shipped before profiles existed. Decides whether a stored
 * rule list is a customisation worth preserving as a profile of its own, or just the old defaults
 * sitting where `save` left them. */
export function isUntouchedLegacyRules(rules: IconRule[]): boolean {
  if (rules.length !== DEFAULT_ICON_RULES.length) return false;
  return rules.every((rule, index) => {
    const shipped = DEFAULT_ICON_RULES[index];
    return (
      shipped !== undefined &&
      rule.target === shipped.target &&
      rule.match === shipped.match &&
      rule.pattern === shipped.pattern &&
      rule.icon === shipped.icon &&
      rule.enabled === shipped.enabled
    );
  });
}
