/**
 * Choosing one keyring entry, from a form that needs what is in it.
 *
 * The shared half of "fill this from the keyring": the database dialog, the remote host panel and
 * the API client's auth form all open this, and all three get back the same thing — one entry's
 * decrypted payload. The mapping from that payload into their own fields is theirs, in
 * `lib/vault/fill.ts`; what is here is finding the entry and getting the vault open enough to read
 * it.
 *
 * **The list is behind the lock, and that is not an oversight.** `keyvault_load_tree` is gated on
 * the vault being open even though it carries no ciphertext, because *what is in the keyring* is
 * itself something a locked app should not answer. So this dialog asks for the master password
 * before it can show anything — and it asks **here**, rather than sending the user to the keyring
 * app and back, which is the entire point of the feature.
 *
 * **It does not touch the keyring app's own state.** No `openItem`, no `activeId`: the payload is
 * fetched straight through `keyvaultGetItem` and kept local, so filling a form cannot leave the
 * vault view showing an entry the user never opened — or, worse, discard an edit in progress there.
 * The one piece of shared state it does write is the unlock itself, which is the point.
 *
 * The payload is handed to the caller and never rendered. This dialog shows titles.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Lock, Search } from "lucide-react";

import { ApiModal } from "../api/ApiModal";
import { keyvaultGetItem } from "../../lib/tauri/keyvaultCommands";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { ensureVaultStoreLoaded, useVaultStore } from "../../state/vaultStore";
import type { VaultItem, VaultItemKind, VaultSecret } from "../../types/vault";
import { BUTTON, INPUT, ROW, ROW_ACTIVE, ROW_IDLE, kindIcon } from "./vaultChrome";

export function VaultPicker({
  kinds,
  onPick,
  onClose,
}: {
  /** The kinds this form actually wants, listed first. **Not a filter** — an entry holding database
   *  credentials may well have been saved as a key or a note long before the database kind existed,
   *  and a picker that hid it would be a picker that could not find the credential the user knows
   *  is in there. */
  kinds: VaultItemKind[];
  onPick: (secret: VaultSecret, item: VaultItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const initialised = useVaultStore((s) => s.initialised);
  const unlocked = useVaultStore((s) => s.unlocked);
  const unlocking = useVaultStore((s) => s.unlocking);
  const unlockError = useVaultStore((s) => s.unlockError);
  const items = useVaultStore((s) => s.items);

  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  /** Whether the status check has been slow enough to be worth explaining. See below. */
  const [slow, setSlow] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // **Load-bearing.** `initialised` starts as `null` and only ever leaves it when something calls
  // this — and until now the only caller was `VaultView`, the keyring app itself. So opening this
  // dialog without having visited the keyring first left it on "Checking…" for ever: nothing was
  // checking. It is guarded to run once per app session, so calling it from here as well is free.
  useEffect(() => {
    ensureVaultStoreLoaded();
  }, []);

  // The status read asks the OS credential store whether this machine remembers the master
  // password, and on macOS the first such read pops a system permission dialog that can open
  // *behind* this window. A spinner with no explanation is indistinguishable from a hang — which is
  // exactly what it looked like — so after a moment it says where to look.
  useEffect(() => {
    if (initialised !== null) return;
    const timer = window.setTimeout(() => setSlow(true), 1200);
    return () => window.clearTimeout(timer);
  }, [initialised]);

  // The list is only as fresh as the last time something loaded it, and this dialog is often the
  // first thing to want it in a session.
  useEffect(() => {
    if (unlocked) void useVaultStore.getState().refresh();
  }, [unlocked]);

  useEffect(() => {
    if (unlocked) searchRef.current?.focus();
    else passwordRef.current?.focus();
  }, [unlocked, initialised]);

  const ranked = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = items.filter((item) => {
      if (item.deleted_at) return false;
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.subtitle.toLowerCase().includes(needle) ||
        item.site.toLowerCase().includes(needle) ||
        item.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
    // Preferred kinds first, each group keeping the order the store already put them in.
    const wanted = matches.filter((item) => kinds.includes(item.kind));
    const rest = matches.filter((item) => !kinds.includes(item.kind));
    return [...wanted, ...rest];
  }, [items, query, kinds]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const choose = async (item: VaultItem) => {
    setLoading(true);
    try {
      const row = await keyvaultGetItem(item.id);
      if (!row) {
        pushErrorToast(t("vault.pick.gone"));
        return;
      }
      onPick(row.secret, item);
      onClose();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setLoading(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await useVaultStore.getState().unlock(password, false);
    if (ok) setPassword("");
  };

  const onSearchKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((at) => Math.min(at + 1, ranked.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = ranked[cursor];
      if (item) void choose(item);
    }
  };

  return (
    <ApiModal
      icon={KeyRound}
      title={t("vault.pick.title")}
      subtitle={unlocked ? t("vault.pick.body") : undefined}
      width="max-w-md"
      // Opened from inside the connection dialog, which is itself a modal. Without this it lands
      // behind the form it was opened from.
      raised
      busy={loading}
      dismissOnBackdrop={!loading}
      onClose={onClose}
    >
      {/* One padded body per state rather than a wrapper around all four: the unlocked branch is a
          flex column whose list does its own scrolling, and a scrolling parent around a scrolling
          child is how a list ends up with two scrollbars and no bottom. `min-h` keeps the dialog
          from resizing under the pointer as it moves between states. */}
      {initialised === null ? (
        <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-4 py-6">
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("vault.checking")}</p>
          {slow && (
            <p className="max-w-xs text-center text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("vault.pick.checkingSlow")}
            </p>
          )}
        </div>
      ) : !initialised ? (
        // Nothing to pick from and no way to make one from here: creating a keyring means choosing a
        // master password, and that decision belongs on the screen that carries the warning about
        // not being able to recover it — not in a dialog opened to fill in a host name.
        <p className="flex min-h-[180px] items-center justify-center px-6 text-center text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("vault.pick.noVault")}
        </p>
      ) : !unlocked ? (
        <form
          onSubmit={(event) => void unlock(event)}
          className="flex min-h-[180px] flex-col gap-2 px-4 py-3"
        >
          <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
            <Lock size={13} className="text-[var(--cf-text-muted)]" />
            {t("vault.pick.locked")}
          </p>
          <input
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("vault.masterPassword")}
            autoComplete="current-password"
            className={INPUT}
          />
          {unlockError && <p className="text-[11.5px] text-[var(--cf-danger)]">{unlockError}</p>}
          <button
            type="submit"
            disabled={password.length === 0 || unlocking}
            className={`${BUTTON} self-start`}
          >
            {unlocking ? t("vault.unlocking") : t("vault.unlock")}
          </button>
        </form>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
          <div className="flex shrink-0 items-center gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2.5">
            <Search size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              placeholder={t("vault.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] text-[var(--cf-text)] outline-none"
            />
          </div>

          <div className="min-h-[140px] flex-1 overflow-y-auto">
            {ranked.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
                {items.length === 0 ? t("vault.empty") : t("vault.noMatches")}
              </p>
            ) : (
              ranked.map((item, at) => {
                const Glyph = kindIcon(item.kind);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void choose(item)}
                    onMouseEnter={() => setCursor(at)}
                    disabled={loading}
                    className={`${ROW} ${at === cursor ? ROW_ACTIVE : ROW_IDLE}`}
                  >
                    <Glyph size={13} className="shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
                    {item.subtitle && (
                      <span className="min-w-0 max-w-[40%] shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">
                        {item.subtitle}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </ApiModal>
  );
}
