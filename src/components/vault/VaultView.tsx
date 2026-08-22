/**
 * The keyring's shell: the lock screen, or the explorer and whatever is open beside it.
 *
 * **This is the one app on the rail that is not scoped to a workspace**, and the code says so in
 * two places: there is no `useWorkspaceStore.subscribe` in `vaultStore` (its closing comment
 * explains why), and nothing here reacts to a workspace switch beyond refreshing which entries the
 * list shows. A password is not a property of the workspace it was typed in.
 *
 * The idle heartbeat lives here rather than in the store, because this is the component that knows
 * the user is *looking at the keyring*. It is throttled in the store to one call every 30 seconds.
 */

import { useEffect } from "react";
import { KeyRound, Lock, Settings2, Trash2 } from "lucide-react";

import { ResizeHandle } from "../common/ResizeHandle";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { confirmAction } from "../../state/confirmStore";
import { ensureVaultStoreLoaded, useVaultStore } from "../../state/vaultStore";
import { useVaultModalStore } from "../../state/vaultModalStore";
import { VaultExplorer } from "./VaultExplorer";
import { VaultImportModal } from "./VaultImportModal";
import { VaultSettingsModal } from "./VaultSettingsModal";
import { VaultGallery, VaultItemDetail } from "./VaultItemDetail";
import { VaultLockScreen } from "./VaultLockScreen";
import { BUTTON_QUIET, CARD, ICON_BUTTON } from "./vaultChrome";

export function VaultView() {
  const unlocked = useVaultStore((s) => s.unlocked);
  const resuming = useVaultStore((s) => s.resuming);
  const activeId = useVaultStore((s) => s.activeId);
  const items = useVaultStore((s) => s.items);
  const trashOpen = useVaultStore((s) => s.trashOpen);
  const modal = useVaultModalStore((s) => s.modal);
  const sidebarWidth = useLayoutStore((s) => s.sizes.vaultSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  useEffect(() => {
    ensureVaultStoreLoaded();
  }, []);

  // Real activity keeps the vault open. Attached to the window rather than to this subtree so a
  // click anywhere in the app counts — the user reading a diff with the keyring open is still
  // using the app, and a keyring that locks while they work is a keyring they turn the timer off on.
  useEffect(() => {
    if (!unlocked) return;
    const touch = () => useVaultStore.getState().touch();
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [unlocked]);

  // The dialogs are rendered in *both* branches, and that is not tidiness: the lock screen's
  // "I have lost my master password" link opens the settings dialog, and a dialog rendered only
  // inside the unlocked branch would open into nothing — which is exactly the state a person with a
  // forgotten password is in.
  const dialogs = (
    <>
      {modal?.kind === "import" && (
        <VaultImportModal onClose={() => useVaultModalStore.getState().closeVaultModal()} />
      )}
      {modal?.kind === "settings" && (
        <VaultSettingsModal onClose={() => useVaultModalStore.getState().closeVaultModal()} />
      )}
    </>
  );

  // `resuming` as well as `!unlocked`, and it is the lock screen that gets to draw it: the keyring
  // opening itself with the remembered password is still the front door being answered, and this
  // side of the swap must not appear until the tree behind it is loaded. Without it the explorer
  // arrived first and empty, which is the same startled second as the lock screen flashing.
  if (!unlocked || resuming) {
    return (
      <div className={`flex h-full min-h-0 ${CARD}`} data-tour="vault-view">
        <VaultLockScreen />
        {dialogs}
      </div>
    );
  }

  const active = items.find((item) => item.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0" data-tour="vault-view">
      <div
        className={`flex min-h-0 shrink-0 flex-col border-r border-[var(--cf-border)] ${CARD}`}
        style={{ width: sidebarWidth }}
        data-tour="vault-tree"
      >
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--cf-text)]">
            <KeyRound size={13} className="text-[var(--cf-text-muted)]" />
            {t("tabbar.vault")}
          </span>
          {/* Their own group. As three loose children of a `justify-between` row the two buttons
              were spread across the header — settings stranded in the middle, between the title and
              the lock — which read as an unrelated control rather than as this panel's toolbar. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              title={t("vault.lockNow")}
              aria-label={t("vault.lockNow")}
              onClick={() => void useVaultStore.getState().lock()}
              className={ICON_BUTTON}
              data-tour="vault-lock-button"
            >
              <Lock size={13} />
            </button>
            <button
              type="button"
              title={t("vault.settings")}
              aria-label={t("vault.settings")}
              onClick={() => useVaultModalStore.getState().openVaultModal({ kind: "settings" })}
              className={ICON_BUTTON}
            >
              <Settings2 size={13} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <VaultExplorer />
        </div>
      </div>

      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={220}
        max={480}
        onChange={(value) => setSize("vaultSidebarWidth", value)}
        onCommit={(value) => commitSize("vaultSidebarWidth", value)}
      />

      <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${CARD}`} data-tour="vault-item">
        {trashOpen ? (
          <TrashPanel />
        ) : active ? (
          <VaultItemDetail item={active} />
        ) : (
          <VaultGallery />
        )}
      </div>

      {dialogs}
    </div>
  );
}

/** The trash: what was deleted, with the two things that can be done about it. */
function TrashPanel() {
  const trash = useVaultStore((s) => s.trash);
  const t = useT();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--cf-text)]">
          <Trash2 size={13} className="text-[var(--cf-text-muted)]" />
          {t("vault.trash")}
        </span>
        {trash.length > 0 && (
          <button
            type="button"
            onClick={() => {
              void confirmAction(t("vault.emptyTrashConfirm"), true).then(
                (ok) => ok && void useVaultStore.getState().emptyTrash(),
              );
            }}
            className={BUTTON_QUIET}
          >
            {t("vault.emptyTrash")}
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {trash.length === 0 ? (
          <p className="text-[11.5px] italic text-[var(--cf-text-muted)]">{t("vault.noMatches")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {trash.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{item.title}</span>
                <button
                  type="button"
                  onClick={() => void useVaultStore.getState().restoreItem(item.id)}
                  className="text-[11px] text-[var(--cf-accent)] hover:underline"
                >
                  {t("vault.restore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void confirmAction(
                      t("vault.deleteForeverConfirm", { name: item.title }),
                      true,
                    ).then((ok) => ok && void useVaultStore.getState().purgeItem(item.id));
                  }}
                  className="text-[11px] text-[var(--cf-danger)] hover:underline"
                >
                  {t("vault.deleteForever")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
