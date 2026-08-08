import { DEFAULT_ICON_RULES, type IconRule } from "./rules";

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

/** The folder rules and the test-file rules — everything that means the same thing in every
 * TypeScript project, and therefore belongs in all three shipped profiles. */
const COMMON: IconRule[] = [
  { id: "d-spec", target: "file", match: "suffix", pattern: ".spec.ts", icon: "vscode-icons:file-type-testts", enabled: true },
  { id: "d-test", target: "file", match: "suffix", pattern: ".test.ts", icon: "vscode-icons:file-type-testts", enabled: true },
  { id: "d-src", target: "folder", match: "name", pattern: "src", icon: "vscode-icons:folder-type-src", enabled: true },
  { id: "d-components", target: "folder", match: "name", pattern: "components", icon: "vscode-icons:folder-type-component", enabled: true },
  { id: "d-tests", target: "folder", match: "name", pattern: "tests", icon: "vscode-icons:folder-type-test", enabled: true },
  { id: "d-node-modules", target: "folder", match: "name", pattern: "node_modules", icon: "vscode-icons:folder-type-node", enabled: true },
  { id: "d-git", target: "folder", match: "name", pattern: ".git", icon: "vscode-icons:folder-type-git", enabled: true },
];

/**
 * The profile a fresh install starts on.
 *
 * Angular rather than the neutral set, because that is what this app has always shipped — changing
 * the default would move the icons of every existing install that never opened the panel, to fix a
 * problem those installs may not have. The switch is one click away and the other profiles are
 * already written; that is the fix.
 */
export const DEFAULT_PROFILE_ID = "angular";

/**
 * What the app ships with.
 *
 * Three, not thirty. A profile is only worth shipping where the *same* filename means different
 * things in different stacks, and that is overwhelmingly the Angular/Nest collision — everything
 * else (`.vue`, `.svelte`, `.rs`) is already answered by the extension, which the built-in Lucide
 * table and the catalogue cover without a rule. The rest is for the user to write, which is what
 * the profile list is for.
 */
export const BUILT_IN_PROFILES: IconProfile[] = [
  {
    id: "angular",
    name: "Angular",
    defaultFolderIcon: null,
    rules: [
      { id: "a-component", target: "file", match: "suffix", pattern: ".component.ts", icon: "vscode-icons:file-type-ng-component-ts", enabled: true },
      { id: "a-service", target: "file", match: "suffix", pattern: ".service.ts", icon: "vscode-icons:file-type-ng-service-ts", enabled: true },
      // Above `.module.ts`, because a routing module ends in it too and the list is first-match-wins.
      { id: "a-routing", target: "file", match: "suffix", pattern: "-routing.module.ts", icon: "vscode-icons:file-type-ng-routing-ts", enabled: true },
      { id: "a-module", target: "file", match: "suffix", pattern: ".module.ts", icon: "vscode-icons:file-type-ng-module-ts", enabled: true },
      { id: "a-directive", target: "file", match: "suffix", pattern: ".directive.ts", icon: "vscode-icons:file-type-ng-directive-ts", enabled: true },
      { id: "a-pipe", target: "file", match: "suffix", pattern: ".pipe.ts", icon: "vscode-icons:file-type-ng-pipe-ts", enabled: true },
      { id: "a-guard", target: "file", match: "suffix", pattern: ".guard.ts", icon: "vscode-icons:file-type-ng-guard-ts", enabled: true },
      { id: "a-interceptor", target: "file", match: "suffix", pattern: ".interceptor.ts", icon: "vscode-icons:file-type-ng-interceptor-ts", enabled: true },
      ...COMMON,
    ],
  },
  {
    id: "nestjs",
    name: "NestJS",
    defaultFolderIcon: null,
    rules: [
      { id: "n-controller", target: "file", match: "suffix", pattern: ".controller.ts", icon: "vscode-icons:file-type-nest-controller-ts", enabled: true },
      { id: "n-service", target: "file", match: "suffix", pattern: ".service.ts", icon: "vscode-icons:file-type-nest-service-ts", enabled: true },
      { id: "n-module", target: "file", match: "suffix", pattern: ".module.ts", icon: "vscode-icons:file-type-nest-module-ts", enabled: true },
      { id: "n-guard", target: "file", match: "suffix", pattern: ".guard.ts", icon: "vscode-icons:file-type-nest-guard-ts", enabled: true },
      { id: "n-pipe", target: "file", match: "suffix", pattern: ".pipe.ts", icon: "vscode-icons:file-type-nest-pipe-ts", enabled: true },
      { id: "n-filter", target: "file", match: "suffix", pattern: ".filter.ts", icon: "vscode-icons:file-type-nest-filter-ts", enabled: true },
      { id: "n-interceptor", target: "file", match: "suffix", pattern: ".interceptor.ts", icon: "vscode-icons:file-type-nest-interceptor-ts", enabled: true },
      { id: "n-middleware", target: "file", match: "suffix", pattern: ".middleware.ts", icon: "vscode-icons:file-type-nest-middleware-ts", enabled: true },
      { id: "n-gateway", target: "file", match: "suffix", pattern: ".gateway.ts", icon: "vscode-icons:file-type-nest-gateway-ts", enabled: true },
      { id: "n-decorator", target: "file", match: "suffix", pattern: ".decorator.ts", icon: "vscode-icons:file-type-nest-decorator-ts", enabled: true },
      ...COMMON,
    ],
  },
  {
    // The one to pick when a repository is neither, or is both: the suffixes that mean different
    // things in different stacks are simply left to the plain TypeScript icon.
    id: "base",
    name: "General",
    defaultFolderIcon: null,
    rules: COMMON,
  },
];

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
