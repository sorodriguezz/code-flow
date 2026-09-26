import type { IconRule } from "./rules";
import { BUILT_IN_PROFILES, type IconProfile } from "./profiles";

/**
 * Bringing an existing install's profiles up to the packs this version ships.
 *
 * Profiles are copied into the user's settings the first time the app runs (see `iconRulesStore`),
 * which is what makes them editable — and also what would keep an install on the old packs forever:
 * the list it reads back is its own copy, and a new pack in the code never reaches it. Two things
 * are done about that, and nothing else:
 *
 * - **A shipped pack still exactly as it was shipped is replaced by the new one.** "Exactly" is
 *   compared rule by rule against the version that install was given (`SHIPPED_V1` below). One
 *   edited rule — a toggle, a reorder, an icon — and the copy is the user's, left alone; the panel's
 *   restore button is how they take the new pack when they want it. The name is kept either way.
 * - **A shipped pack missing from the list is added**, at the end of it — unless the user deleted
 *   it. That is known only from `removed`, the record `removeProfile` writes, and never inferred
 *   from absence. Absence used to be read against `offered` ("given before and gone now means
 *   deleted on purpose"), and it lied: v2.0.0, opened after a newer build, could not read the
 *   newer list, rewrote it with its own three packs, and every later launch read the eight it had
 *   dropped as deleted by the user — so they never came back (2026-09-24). A pack an older build
 *   drops now returns on the next launch of this one.
 *
 * Pure, so it can be tested without a settings store, and idempotent: run on its own output it
 * changes nothing, which matters because the store runs it every time the profiles row is re-read.
 */

/** The ids every install before packs was given. On an install that predates both records, one of
 * these missing is the one deletion that can be taken as deliberate — nothing but the user removed
 * profiles then — so a user who deleted NestJS does not get it back. */
export const V1_OFFERED_IDS = ["angular", "nestjs", "base"] as const;

type V1Rule = Pick<IconRule, "target" | "match" | "pattern" | "icon" | "enabled">;

const file = (match: IconRule["match"], pattern: string, icon: string): V1Rule => ({
  target: "file",
  match,
  pattern,
  icon: `vscode-icons:${icon}`,
  enabled: true,
});
const folder = (pattern: string, icon: string): V1Rule => ({
  target: "folder",
  match: "name",
  pattern,
  icon: `vscode-icons:${icon}`,
  enabled: true,
});

const V1_COMMON: V1Rule[] = [
  file("suffix", ".spec.ts", "file-type-testts"),
  file("suffix", ".test.ts", "file-type-testts"),
  folder("src", "folder-type-src"),
  folder("components", "folder-type-component"),
  folder("tests", "folder-type-test"),
  folder("node_modules", "folder-type-node"),
  folder(".git", "folder-type-git"),
];

/** The three packs as the previous version shipped them, rule for rule. Only ever compared against. */
const SHIPPED_V1: Record<string, V1Rule[]> = {
  angular: [
    file("suffix", ".component.ts", "file-type-ng-component-ts"),
    file("suffix", ".service.ts", "file-type-ng-service-ts"),
    file("suffix", "-routing.module.ts", "file-type-ng-routing-ts"),
    file("suffix", ".module.ts", "file-type-ng-module-ts"),
    file("suffix", ".directive.ts", "file-type-ng-directive-ts"),
    file("suffix", ".pipe.ts", "file-type-ng-pipe-ts"),
    file("suffix", ".guard.ts", "file-type-ng-guard-ts"),
    file("suffix", ".interceptor.ts", "file-type-ng-interceptor-ts"),
    ...V1_COMMON,
  ],
  nestjs: [
    file("suffix", ".controller.ts", "file-type-nest-controller-ts"),
    file("suffix", ".service.ts", "file-type-nest-service-ts"),
    file("suffix", ".module.ts", "file-type-nest-module-ts"),
    file("suffix", ".guard.ts", "file-type-nest-guard-ts"),
    file("suffix", ".pipe.ts", "file-type-nest-pipe-ts"),
    file("suffix", ".filter.ts", "file-type-nest-filter-ts"),
    file("suffix", ".interceptor.ts", "file-type-nest-interceptor-ts"),
    file("suffix", ".middleware.ts", "file-type-nest-middleware-ts"),
    file("suffix", ".gateway.ts", "file-type-nest-gateway-ts"),
    file("suffix", ".decorator.ts", "file-type-nest-decorator-ts"),
    ...V1_COMMON,
  ],
  base: V1_COMMON,
};

function sameRules(rules: IconRule[], shipped: V1Rule[]): boolean {
  return (
    rules.length === shipped.length &&
    rules.every((rule, index) => {
      const expected = shipped[index];
      return (
        rule.target === expected.target &&
        rule.match === expected.match &&
        rule.pattern === expected.pattern &&
        rule.icon === expected.icon &&
        rule.enabled === expected.enabled
      );
    })
  );
}

function copy(profile: IconProfile): IconProfile {
  return { ...profile, rules: profile.rules.map((rule) => ({ ...rule })) };
}

export interface ProfileUpgrade {
  profiles: IconProfile[];
  /** Every shipped id this install has now been offered. No longer decides anything here; kept
   * current because v2.0.1–2.0.3 still read it, and to them a pack absent and offered is deleted. */
  offered: string[];
  /** The shipped packs the user deleted that are still gone. */
  removed: string[];
  /** Whether `profiles` differs from what was stored, and so has to be written back. */
  changed: boolean;
  /** Whether `offered` differs from what was stored. */
  offeredChanged: boolean;
  /** Whether `removed` differs from what was stored. */
  removedChanged: boolean;
}

/**
 * `offered` and `removed` are the stored records, each `null` for an install that predates it.
 *
 * With no `removed` record yet, nothing counts as deleted except a V1 pack missing from an install
 * that also predates `offered` — see `V1_OFFERED_IDS`. The price: a pack deliberately deleted on
 * v2.0.1–2.0.3 comes back once. That is the right way round: the other reading is what kept eight
 * packs away for good from a user who had deleted none of them.
 */
export function upgradeShippedProfiles(
  stored: IconProfile[],
  offered: string[] | null,
  removed: string[] | null,
): ProfileUpgrade {
  const known = new Set<string>(offered ?? V1_OFFERED_IDS);
  const present = (id: string) => stored.some((profile) => profile.id === id);
  // Still gone, and only those: a pack the user brought back (an import under its id) is no longer
  // deleted, and the record is trimmed to say so.
  const deleted = [...new Set(removed ?? (offered === null ? V1_OFFERED_IDS : []))].filter((id) => !present(id));
  let changed = false;

  const profiles = stored.map((profile) => {
    const previous = SHIPPED_V1[profile.id];
    const current = BUILT_IN_PROFILES.find((shipped) => shipped.id === profile.id);
    if (!previous || !current || profile.defaultFolderIcon !== null || !sameRules(profile.rules, previous)) {
      return profile;
    }
    changed = true;
    return { ...copy(current), name: profile.name };
  });

  for (const shipped of BUILT_IN_PROFILES) {
    known.add(shipped.id);
    if (deleted.includes(shipped.id) || profiles.some((profile) => profile.id === shipped.id)) continue;
    profiles.push(copy(shipped));
    changed = true;
  }

  const nextOffered = [...known];
  return {
    profiles,
    offered: nextOffered,
    removed: deleted,
    changed,
    offeredChanged: offered === null || nextOffered.length !== offered.length,
    removedChanged: removed === null || deleted.length !== removed.length,
  };
}
