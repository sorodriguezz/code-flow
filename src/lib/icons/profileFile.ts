import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFileBytes } from "../tauri/commands";
import { apiReadTextFile } from "../tauri/apiCommands";
import { safeFileName } from "../diagrams/exportFile";
import { knownIconIds } from "./catalog";
import { newRuleId, parseIconRules, type IconRule } from "./rules";
import { uniqueProfileName, type IconProfile } from "./profiles";
import type { TranslationKey } from "../i18n/translations";

/**
 * An icon profile as a file, so one can be handed to somebody else.
 *
 * A profile is a couple of hours of somebody deciding what a `*.gateway.ts` should look like, and
 * until now that work could not leave the machine it was done on. The obvious way to share it is a
 * file: it goes in the team chat, or next to the code it draws in the repository, and it arrives
 * without either end having to agree on a sync service.
 *
 * # Why there is an envelope and not just the profile
 *
 * The file lands here from somewhere with no memory of where it came from — a chat attachment, a
 * repository, a version of this app that does not exist yet. Two things follow from that. Without a
 * discriminator, any object with a `name` and an array would import: a `package.json` picked by
 * mistake would become a profile, and the failure would show up as junk in the profile picker
 * rather than as an error at the moment of the mistake. And without a version, a file written by a
 * later build would be read with this build's assumptions — the one failure mode where being
 * strict is kinder than being tolerant, because "update CodeFlow" is a thing the reader can act on
 * and a silently half-imported profile is not.
 *
 * The same envelope `lib/api/exporters.ts` puts round a native collection (`format: "codeflow-api",
 * version: 1`), for the same reasons and read the same way.
 *
 * # Why this module returns translation keys
 *
 * Every failure below answers with a `TranslationKey`, never a sentence. Same argument as
 * `iconPatternDescription` in `rules.ts`: the panel is the thing that holds `useT`, and a string
 * built here would be built in whichever language the store happened to be in — and would have to
 * be re-plumbed the day these messages want interpolation the panel is already able to do.
 *
 * Neither half of this touches Rust. `save`/`writeFileBytes` and `open`/`apiReadTextFile` are the
 * two paths the remote table export and the collection import already take.
 */

export const ICON_PROFILE_FORMAT = "codeflow-icon-profile";
export const ICON_PROFILE_VERSION = 1;

/**
 * What is written, and what is expected back.
 *
 * **No profile `id`.** It is a local key, not a property of the iconography: a file carrying
 * `id: "angular"` would, on import, make `shippedProfile` answer for somebody else's rules — so the
 * panel would offer "restore the factory rules" over a profile that has no factory version, and
 * quietly replace it. It would also put two profiles with one id in the list, where `profileById`
 * returns the first and the second becomes unreachable. `importProfile` mints a fresh one.
 *
 * **No `exportedAt`.** These files end up committed beside the code they draw; a timestamp would
 * turn every re-export of an unchanged profile into a diff nobody reads. Without one the export is
 * reproducible, which is the property that makes it reviewable.
 *
 * **Rule ids do travel.** They only have to be unique *within* a profile — the same reasoning
 * `duplicateProfile` writes down when it clones them — and keeping them is what lets two exports of
 * the same profile be diffed line for line.
 */
export interface IconProfileFile {
  format: typeof ICON_PROFILE_FORMAT;
  version: number;
  profile: { name: string; defaultFolderIcon: string | null; rules: IconRule[] };
}

const FILTER = { name: "CodeFlow icon profile", extensions: ["json"] };

/**
 * Writes the profile to a file the user picks. The path on success, `null` if they dismissed the
 * dialog.
 *
 * Write failures are left to propagate: the panel turns them into a toast, which is the only place
 * that knows how to say so in the reader's language.
 *
 * Indented and newline-terminated because this file's whole purpose is to be looked at by a second
 * person before they trust it — and because a JSON blob on one line makes a useless diff in the
 * repository it will be committed to.
 */
export async function exportProfileFile(profile: IconProfile): Promise<string | null> {
  const doc: IconProfileFile = {
    format: ICON_PROFILE_FORMAT,
    version: ICON_PROFILE_VERSION,
    profile: {
      name: profile.name,
      defaultFolderIcon: profile.defaultFolderIcon,
      rules: profile.rules.map((rule) => ({ ...rule })),
    },
  };
  const path = await save({
    defaultPath: `${safeFileName(profile.name, "profile")}.icons.json`,
    filters: [FILTER],
  });
  if (!path) return null;
  await writeFileBytes(path, new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`));
  return path;
}

/**
 * What came out of a file: a profile ready to be added, or the one reason it cannot be.
 *
 * The counts are not diagnostics — they are the report the user is shown before deciding, so they
 * are carried out of here rather than logged. A file that arrived missing a third of its rules
 * still imports; the number is the only way anyone would know it did.
 */
export type IconProfileImport =
  | {
      ok: true;
      profile: { name: string; rules: IconRule[]; defaultFolderIcon: string | null };
      /** The name the file asked for, when the list already had it. `null` when nothing moved. */
      renamedFrom: string | null;
      /** Rules naming a glyph this build has no icon for. */
      droppedIcons: number;
      /** Entries that were not usable rules at all. */
      droppedInvalid: number;
      droppedFolderIcon: boolean;
    }
  | { ok: false; error: TranslationKey; params?: Record<string, string | number> };

/**
 * Reads a profile out of a file the user picks. `null` if they dismissed the dialog.
 *
 * `existing` is read, never written: the only thing it is for is choosing a name that is not
 * already in the list. Nothing here mutates any store — the caller confirms first, and the store
 * action is what writes.
 *
 * The checks run in a fixed order, and the order is the point. `format` is asked about before
 * `version`, because a file that is not ours has no version worth judging and "that file isn't an
 * exported icon profile" is the sentence that describes what happened. `version` too high is its
 * own answer rather than being folded into "unreadable", because updating the app is an action and
 * "the file is damaged" is not.
 */
export async function importProfileFile(
  existing: IconProfile[],
): Promise<IconProfileImport | null> {
  const picked = await open({ multiple: false, filters: [FILTER] });
  // The same guard `openDrawioFile` uses: `open` is typed as possibly answering an array, and a
  // dismissed dialog answers `null`. Both are "nothing to do".
  if (typeof picked !== "string") return null;
  // Left to propagate, like the write above: a file that is not UTF-8, or that the process cannot
  // read, is a toast and not a validation result.
  const text = await apiReadTextFile(picked);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "icons.importInvalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "icons.importInvalid" };
  }

  const doc = parsed as Partial<IconProfileFile>;
  // The guard that makes picking the wrong file fail as picking the wrong file.
  if (doc.format !== ICON_PROFILE_FORMAT) return { ok: false, error: "icons.importNotProfile" };
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 1) {
    return { ok: false, error: "icons.importInvalid" };
  }
  if (doc.version > ICON_PROFILE_VERSION) {
    return {
      ok: false,
      error: "icons.importTooNew",
      params: { version: doc.version, supported: ICON_PROFILE_VERSION },
    };
  }

  const body = doc.profile as Partial<IconProfileFile["profile"]> | undefined;
  if (!body || typeof body !== "object" || typeof body.name !== "string" || !Array.isArray(body.rules)) {
    return { ok: false, error: "icons.importInvalid" };
  }

  // The same filter everything read off disk goes through — including the `extension` migration, so
  // a profile exported by a build old enough to have those rules still imports whole. See
  // `parseIconRules`.
  const declared = body.rules;
  const rules = parseIconRules(declared) ?? [];
  const droppedInvalid = declared.length - rules.length;
  const folderIcon =
    typeof body.defaultFolderIcon === "string" && body.defaultFolderIcon.trim()
      ? body.defaultFolderIcon
      : null;

  /**
   * Then the catalogue. A rule whose icon this build does not ship is *dropped*, not kept: a rule
   * with no glyph does not draw nothing, it draws the default Lucide icon — which is exactly what a
   * file with no rule at all looks like. Kept, it would read as a rule of theirs that is broken;
   * dropped and counted, it reads as an icon this version does not have, which is what happened.
   *
   * `null` from `knownIconIds` means the sets could not be read (offline, a failed fetch), and the
   * answer to that is to filter nothing at all. Validating against a catalogue that never arrived
   * would throw away every rule in a perfectly good file and say so in the confirmation.
   */
  const known = await knownIconIds([
    ...rules.map((rule) => rule.icon),
    ...(folderIcon ? [folderIcon] : []),
  ]);
  const kept = known ? rules.filter((rule) => known.has(rule.icon)) : rules;
  const droppedIcons = rules.length - kept.length;
  const droppedFolderIcon = known !== null && folderIcon !== null && !known.has(folderIcon);

  // A profile with no rules is legal — `addProfile` makes them. A profile that arrived with twelve
  // and kept none is not an empty profile, it is a file this build cannot draw, and adding it
  // silently would be precisely the corruption the envelope exists to prevent.
  if (declared.length > 0 && kept.length === 0) {
    return { ok: false, error: "icons.importAllDropped", params: { n: declared.length } };
  }

  const wanted = body.name.trim() || "Profile";
  const name = uniqueProfileName(existing, wanted);
  return {
    ok: true,
    profile: {
      name,
      rules: withFreshIds(kept),
      defaultFolderIcon: droppedFolderIcon ? null : folderIcon,
    },
    renamedFrom: name === wanted ? null : wanted,
    droppedIcons,
    droppedInvalid,
    droppedFolderIcon,
  };
}

/**
 * Rule ids the panel can rely on being unique.
 *
 * The file's ids are kept where they can be — they make two exports of one profile diffable, which
 * is why they are written at all — but a hand-edited or concatenated file can repeat one, and the
 * list is drawn with `key={rule.id}` and marks its search winner by comparing ids. A duplicate
 * there is two highlighted rows and a React key warning, so anything repeated (or not a usable
 * string) is re-minted here instead of at the moment it goes wrong.
 */
function withFreshIds(rules: IconRule[]): IconRule[] {
  const seen = new Set<string>();
  return rules.map((rule) => {
    let id = typeof rule.id === "string" && rule.id.trim() ? rule.id : "";
    // Minted in a loop, not once. `newRuleId` is a millisecond plus four random base-36 digits, and
    // a file with twenty repeated ids re-mints all twenty inside the same millisecond — where the
    // only thing keeping them apart is that number, which collides about one time in ten thousand.
    // Re-minting until the id is free is a few characters and makes the guarantee real.
    while (!id || seen.has(id)) id = newRuleId();
    seen.add(id);
    return { ...rule, id };
  });
}
