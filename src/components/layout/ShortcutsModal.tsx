import { useEffect } from "react";
import { Keyboard, Settings, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useShortcutsStore, bindingFor } from "../../state/shortcutsStore";
import { SHORTCUT_COMMANDS, SHORTCUT_GROUP_LABELS, EDITOR_RESERVED, type ShortcutGroup } from "../../lib/shortcuts";
import { chordKeycaps } from "../../lib/keys";

const GROUP_ORDER: ShortcutGroup[] = ["general", "panels", "views", "editor", "navigation", "workspace", "git"];

export function Keycap({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--cf-text)]">
      {children}
    </kbd>
  );
}

function Row({ label, chord }: { label: string; chord: string | null }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {chord ? (
          chordKeycaps(chord).map((key, i) => <Keycap key={`${key}-${i}`}>{key}</Keycap>)
        ) : (
          <span className="text-[11px] italic text-[var(--cf-text-muted)]">{t("shortcuts.unbound")}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The cheat sheet. App actions are read live from the user's bindings, so it always reflects what
 * the keyboard actually does; the editor group below is fixed because half of it comes from
 * Monaco itself rather than from this app — which is exactly why it's worth writing down.
 */
export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const overrides = useShortcutsStore((s) => s.overrides);
  const openSettings = useUiStore((s) => s.openSettings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <Keyboard size={14} className="text-[var(--cf-accent)]" />
          <h2 className="text-[13px] font-semibold">{t("shortcuts.title")}</h2>
          <button
            onClick={() => {
              openSettings("keybindings");
              onClose();
            }}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <Settings size={12} />
            {t("shortcuts.customize")}
          </button>
          <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {GROUP_ORDER.map((group) => {
            const commands = SHORTCUT_COMMANDS.filter((c) => c.group === group);
            if (commands.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
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

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("shortcuts.groupEditorBuiltIn")}
            </p>
            <p className="mb-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("shortcuts.editorFixedHint")}</p>
            <div className="space-y-1">
              {EDITOR_RESERVED.map((entry) => (
                <Row key={entry.chord} label={t(entry.labelKey)} chord={entry.chord} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
