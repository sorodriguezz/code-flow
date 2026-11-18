import { useEffect, useRef, useState, type ReactNode } from "react";
import { Paperclip, Plus } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * The composer's «+»: what you add to the message — files, and the MCP servers the turn may use — in
 * one place inside the box, where the paperclip and the plug used to sit among the model and mode
 * chips (user request, 2026-11-18). Dropping and pasting files still work on the box as before; this
 * is only the button.
 *
 * `mcp` is the host's `McpMenu` element; it is cloned in with `embedded`, so the switches are the
 * same ones, saved the same way. It stays mounted while the menu is shut, which is what lets the
 * button show how many servers are on.
 */
export function ComposerPlusMenu({
  onAttach,
  attachTitle,
  renderMcp,
}: {
  onAttach: () => void;
  attachTitle: string;
  /** Builds the embedded MCP section, told whether the menu is open and where to report its count. */
  renderMcp?: (visible: boolean, onActive: (n: number) => void) => ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mcpOn, setMcpOn] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        // The caret stays in the box: adding a file is part of writing the message.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={t("chat.plusMenu")}
        aria-label={t("chat.plusMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--cf-hover)] ${
          open ? "bg-[var(--cf-hover)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Plus size={15} />
        {mcpOn > 0 && (
          <span
            aria-hidden
            title={t("chat.mcpActive", { n: String(mcpOn) })}
            className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-[var(--cf-accent-fill)] px-[3px] text-[8px] font-semibold leading-none text-[var(--cf-on-accent)]"
          >
            {mcpOn}
          </span>
        )}
      </button>

      {/* Kept mounted while shut (hidden), so the MCP section can report its count to the badge. */}
      <div
        role="menu"
        hidden={!open}
        className="absolute bottom-8 left-0 z-30 w-[min(300px,80vw)] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 text-[12px] shadow-[var(--cf-shadow)]"
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onAttach();
          }}
          title={attachTitle}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[12px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
        >
          <Paperclip size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate">{t("chat.attachMenu")}</span>
        </button>
        {renderMcp && (
          <McpSection>{renderMcp(open, setMcpOn)}</McpSection>
        )}
      </div>
    </div>
  );
}

/** A hairline before the MCP switches — drawn only when the section has something in it. */
function McpSection({ children }: { children: ReactNode }) {
  return <div className="mt-1 border-t border-[var(--cf-border)] pt-1.5 empty:hidden">{children}</div>;
}
