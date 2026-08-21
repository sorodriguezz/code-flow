/**
 * Turning the keyring's backend errors into the user's language.
 *
 * Everywhere else in this app a backend error is shown as it comes, and that is right: those are
 * mostly a *server's* own words — Postgres's, Redis's, an HTTP status — and translating someone
 * else's error into Spanish would make it un-searchable without making it clearer.
 *
 * The keyring is the exception, because its failures are this app's own sentences. "Wrong master
 * password" is not Postgres talking; it is CodeFlow talking, and CodeFlow is translated. So the
 * handful of failures a person actually meets cross the bridge as codes (`cf-keyvault/…`, minted in
 * `keyvault::crypto`) and are mapped here.
 *
 * Anything without that prefix is left alone — an OS error opening the keychain, a disk that is
 * full — because those are the cases where the original wording is the useful part.
 */

import type { TranslationKey } from "../i18n/translations";

const MESSAGES: Record<string, TranslationKey> = {
  "cf-keyvault/wrong-password": "vault.error.wrongPassword",
  "cf-keyvault/locked": "vault.error.locked",
  "cf-keyvault/not-initialised": "vault.error.notInitialised",
  "cf-keyvault/already-initialised": "vault.error.alreadyInitialised",
  "cf-keyvault/too-short": "vault.error.tooShort",
};

/**
 * The translation key for a raw backend error, or `null` when it is not one of ours.
 *
 * The raw value is matched after trimming Tauri's own wrapping — an `invoke` rejection arrives as
 * the string it was given, but a `String(error)` upstream can put `Error: ` in front of it.
 */
export function vaultErrorKey(raw: unknown): TranslationKey | null {
  const text = String(raw ?? "").trim();
  for (const [code, key] of Object.entries(MESSAGES)) {
    if (text === code || text.endsWith(code)) return key;
  }
  return null;
}
