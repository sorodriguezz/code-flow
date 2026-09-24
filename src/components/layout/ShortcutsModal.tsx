import { useEffect } from "react";
import { Keyboard, Settings, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useShortcutsStore, bindingFor } from "../../state/shortcutsStore";
import { SHORTCUT_COMMANDS, SHORTCUT_GROUP_LABELS, type ShortcutGroup } from "../../lib/shortcuts";
import { chordKeycaps } from "../../lib/keys";
import { buttonClass, iconButtonClass } from "../common/Button";

const GROUP_ORDER: ShortcutGroup[] = [
  "general",
  "panels",
  "views",
  "editor",
  "database",
  "navigation",
  "workspace",
  "git",
];

export function Keycap({ children }: { children: string }) {
  return (
    <kbd className="cf-kbd">
      {children}
    </kbd>
  );
}

function Row({ label, chord }: { label: string; chord: string | null }) {
  const t = useT();
  return (
    <div className="flex min-h-[26px] items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--cf-text)]">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {chord ? (
          chordKeycaps(chord).map((key, i) => <Keycap key={`${key}-${i}`}>{key}</Keycap>)
        ) : (
          <span className="text-[12px] italic text-[var(--cf-text-faint)]">{t("shortcuts.unbound")}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The cheat sheet. App actions are read live from the user's bindings, so it always reflects what
 * the keyboard actually does; the editor group below is fixed because half of it comes from
 * Monaco itself rather than from this app — which is exactly why it's worth writing down.
 *
 * `shortcutsModalGroups` narrows it. Opened from the editor's own keyboard button the question is
 * "what can I press *here*", and the answer is one section — not six with the one you asked about
 * fourth. Unscoped (⌘⌥K, the command palette) it still lists everything.
 */
export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const overrides = useShortcutsStore((s) => s.overrides);
  const openSettings = useUiStore((s) => s.openSettings);
  const scope = useUiStore((s) => s.shortcutsModalGroups);
  const groups = scope ?? GROUP_ORDER;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex min-h-[52px] items-center gap-2.5 border-b border-[var(--cf-border)] py-2 pl-4 pr-3">
          <Keyboard size={15} className="text-[var(--cf-accent)]" />
          <h2 className="text-[15px] font-semibold">{t("shortcuts.title")}</h2>
          <button
            onClick={() => {
              openSettings("keybindings");
              onClose();
            }}
            className={buttonClass({ variant: "ghost", size: "sm", className: "ml-auto" })}
          >
            <Settings size={13} />
            {t("shortcuts.customize")}
          </button>
          <button onClick={onClose} aria-label={t("common.close")} className={iconButtonClass({ size: "sm" })}>
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {GROUP_ORDER.filter((group) => groups.includes(group)).map((group) => {
            const commands = SHORTCUT_COMMANDS.filter((c) => c.group === group);
            if (commands.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t(SHORTCUT_GROUP_LABELS[group])}
                </p>
                <div className="space-y-1">
                  {commands.map((command) => (
                    <Row
                      key={command.id}
                      label={t(command.labelKey)}
                      chord={bindingFor(command.id, overrides)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

        </div>
      </div>
    </div>
  );
}
