import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, Settings2, TerminalSquare } from "lucide-react";
import { listShellProfiles } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import type { ShellProfile } from "../../types/domain";

/**
 * The shell picker hanging off the `+` button, VS Code style: `+` opens the default profile,
 * the caret lists every shell found on this machine plus a way into the settings section.
 *
 * Profiles are re-fetched every time the menu opens rather than held in a store — the list is
 * small, and reading it fresh means a shell installed while the app was running, or a profile
 * just added in Settings, is in the menu without a restart or any invalidation plumbing.
 */
export function ProfileMenu({ onPick, disabled }: { onPick: (profileId: string) => void; disabled: boolean }) {
  const t = useT();
  const openSettings = useUiStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);

  // The menu has to live in a portal, not beside the trigger: the dock's own container is
  // `overflow-hidden` (it animates its height open and closed), so anything positioned above the
  // toolbar gets clipped away to nothing. Same reason — and same fix — as `Select`.
  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      // Right-aligned to the trigger, growing upward: the dock sits at the bottom of the window,
      // so there is never room below it.
      right: Math.max(4, window.innerWidth - rect.right),
      bottom: window.innerHeight - rect.top + 4,
      maxHeight: Math.max(120, rect.top - 12),
    });
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
        className="flex h-5 w-4 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
      >
        <ChevronUp size={11} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", right: pos.right, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[9999] min-w-[200px] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
          >
            <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
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
