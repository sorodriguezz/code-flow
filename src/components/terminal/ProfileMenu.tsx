import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Settings2, TerminalSquare } from "lucide-react";
import { listShellProfiles } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { providerDisplayLabel } from "../../lib/aiProviders";
import type { AiAccount } from "../../lib/tauri/accountCommands";
import type { ShellProfile } from "../../types/domain";
import { ProviderGlyph } from "../ai/ProviderGlyph";

/**
 * The shell picker hanging off the `+` button, VS Code style: `+` opens the default profile,
 * the caret lists every shell found on this machine plus a way into the settings section.
 *
 * Profiles are re-fetched every time the menu opens rather than held in a store — the list is
 * small, and reading it fresh means a shell installed while the app was running, or a profile
 * just added in Settings, is in the menu without a restart or any invalidation plumbing.
 */
export function ProfileMenu({
  onPick,
  onPickAccount,
  disabled,
}: {
  onPick: (profileId: string) => void;
  /** Opens a shell *as* one AI account: every `claude`/`codex`/… typed into it runs as that
   *  account. Listed only when accounts have been added; see `lib/aiAccounts.ts`. */
  onPickAccount?: (account: AiAccount, title: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  const accounts = useAiAccountsStore((s) => s.accounts);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const openSettings = useUiStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  // The menu has to live in a portal, not beside the trigger: the dock's own container is
  // `overflow-hidden` (it animates its height open and closed), so anything positioned above the
  // toolbar gets clipped away to nothing. Same reason — and same fix — as `Select`.
  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Right-aligned to the trigger. Downward when it fits: the trigger heads the terminals in the
    // dock's list now, not a tab strip on the dock's bottom edge, so there is usually room below —
    // and a menu that opens away from its caret reads as the wrong control. Upward when the dock is
    // too short for it.
    const right = Math.max(4, window.innerWidth - rect.right);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    if (below >= 240 || below >= above) {
      setPos({ right, top: rect.bottom + 4, maxHeight: Math.max(120, below) });
    } else {
      setPos({ right, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(120, above) });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    void listShellProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    if (onPickAccount) void ensureAccounts();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Both nodes, since the menu is no longer a descendant of the trigger's wrapper.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={t("terminal.selectProfile")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-5 w-4 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40"
      >
        {/* Down, as every "more ways to do this" caret beside a button is. Up read as "collapse
            this section", which is what an up-chevron at the end of a heading means everywhere
            else in the app. */}
        <ChevronDown size={11} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", right: pos.right, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[9999] min-w-[200px] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
          >
            <p className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("terminal.profilesHeading")}
            </p>
            {profiles.map((profile) => (
              <button
                key={profile.id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(profile.id);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
              >
                <TerminalSquare size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate">{profile.name}</span>
              </button>
            ))}
            {onPickAccount && accounts.length > 0 && (
              <>
                <div className="my-1 border-t border-[var(--cf-border)]" />
                <p className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("accounts.terminalHeading")}
                </p>
                {accounts.map((account) => {
                  const title = `${providerDisplayLabel(account.provider, t)} · ${account.label}`;
                  return (
                    <button
                      key={account.id}
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        onPickAccount(account, title);
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
                    >
                      <ProviderGlyph providerId={account.provider} size={12} />
                      <span className="truncate">{title}</span>
                    </button>
                  );
                })}
              </>
            )}
            <div className="my-1 border-t border-[var(--cf-border)]" />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openSettings("terminal");
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] hover:text-[var(--cf-text)]"
            >
              <Settings2 size={12} className="shrink-0" />
              <span className="truncate">{t("terminal.configureProfiles")}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
