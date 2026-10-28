import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plug } from "lucide-react";
import { chatMcpServers, chatMcpSet, type McpServerView } from "../../lib/tauri/chatCommands";
import { Checkbox } from "../common/Checkbox";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** How a server's reported state reads, and in what colour. */
const STATUS: Record<string, { key: TranslationKey; color: string }> = {
  connected: { key: "chat.mcpConnected", color: "var(--cf-success)" },
  enabled: { key: "chat.mcpConnected", color: "var(--cf-success)" },
  pending: { key: "chat.mcpPending", color: "var(--cf-warning)" },
  "needs-auth": { key: "chat.mcpNeedsAuth", color: "var(--cf-warning)" },
  failed: { key: "chat.mcpFailed", color: "var(--cf-danger)" },
  disabled: { key: "chat.mcpOffInCli", color: "var(--cf-text-muted)" },
  untrusted: { key: "chat.mcpUntrusted", color: "var(--cf-warning)" },
};

const WIDTH = 300;
/** Breathing room kept between the menu and whatever would cut it. */
const EDGE = 8;

/** The horizontal room the menu may use: the window, narrowed by every ancestor that clips it. */
function roomAround(node: HTMLElement): { left: number; right: number } {
  let left = 0;
  let right = window.innerWidth;
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX === "visible") continue;
    const rect = el.getBoundingClientRect();
    left = Math.max(left, rect.left);
    right = Math.min(right, rect.right);
  }
  return { left: left + EDGE, right: right - EDGE };
}

/**
 * The user's own MCP servers — the CLI's, not the app's — switched on or off for this conversation
 * (a free chat) or this repository (the panel's chat).
 *
 * # Why a switch at all
 *
 * Claude Code denies, in headless mode, every MCP tool nobody pre-approved: a server that is plainly
 * connected in the user's terminal could never be used from a chat. Switching one on pre-approves it
 * for turns here; switching it off also takes its tools off what the model is shown, which is context
 * a turn stops paying for. Codex runs its servers as its own config says, and a switch here can only
 * take one out. See `chat_mcp.rs`.
 *
 * Draws nothing for an engine with no servers to show, and says so — instead of offering switches —
 * when the conversation cannot use any (a read-only turn loads none). Before a conversation exists
 * (the Chat app's empty state) the switches are `held` by the caller and written onto the row the
 * first message creates.
 */
export function McpMenu({
  provider,
  scope,
  unavailableReason,
  held,
}: {
  provider: string;
  scope: {
    accountId?: string | null;
    workspaceId?: string | null;
    projectId?: string | null;
    conversationId?: string | null;
  };
  /** Set when turns here cannot use MCP at all — the switches are then shown, but not offered. */
  unavailableReason?: string;
  /** Switches for a conversation that does not exist yet, kept by the caller until it does. */
  held?: { switches: Record<string, boolean>; onSet: (server: string, enabled: boolean) => void };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const box = useRef<HTMLDivElement>(null);
  // Where the menu sits against its button: it opens from the button's left edge, but a button near
  // the right side of a narrow pane (the panel's chat) would push it past the edge and cut it.
  const [place, setPlace] = useState<{ shift: number; width: number } | null>(null);
  const { accountId = null, workspaceId = null, projectId = null, conversationId = null } = scope;
  // Switches need somewhere to live: a conversation's row, a repository's setting, or the caller's
  // hands until the conversation exists.
  const holding = !conversationId && !projectId ? held : undefined;
  const canSwitch = Boolean(conversationId || projectId || holding) && !unavailableReason;

  const reload = () =>
    void chatMcpServers(provider, { accountId, workspaceId, projectId, conversationId })
      .then(setServers)
      .catch(() => setServers([]));

  // Asked on mount and whenever what it answers for changes — and again on every open, since the
  // servers' state is the CLI's and moves on its own (a sign-in, a new server).
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, accountId, workspaceId, projectId, conversationId]);

  useEffect(() => {
    if (!open) return;
    reload();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !box.current) {
      setPlace(null);
      return;
    }
    const anchor = box.current.getBoundingClientRect();
    const room = roomAround(box.current);
    const width = Math.min(WIDTH, Math.max(0, room.right - room.left));
    const start = Math.max(room.left, Math.min(anchor.left, room.right - width));
    setPlace({ shift: start - anchor.left, width });
  }, [open]);

  // Nothing to show, or nowhere yet to keep a switch (a chat before its first message, unless the
  // caller holds them).
  if (servers.length === 0 || (!conversationId && !projectId && !holding)) return null;
  const shown = holding
    ? servers.map((server) => (server.key in holding.switches ? { ...server, enabled: holding.switches[server.key] } : server))
    : servers;
  const active = shown.filter((server) => server.enabled).length;

  const toggle = (server: McpServerView, enabled: boolean) => {
    if (holding) {
      holding.onSet(server.key, enabled);
      return;
    }
    setServers((current) => current.map((s) => (s.key === server.key ? { ...s, enabled } : s)));
    void chatMcpSet({ projectId, conversationId }, server.key, enabled).catch(() => reload());
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("chat.mcpTitle")}
        aria-label={t("chat.mcpTitle")}
        aria-expanded={open}
        className={`flex h-[26px] items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors hover:bg-[var(--cf-hover)] ${
          open || active > 0 ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Plug size={13} />
        {active > 0 && <span className="tabular-nums">{active}</span>}
      </button>

      {open && (
        <div
          style={{ left: place?.shift ?? 0, width: place?.width ?? WIDTH, visibility: place ? "visible" : "hidden" }}
          className="absolute bottom-9 z-30 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 text-[12px] shadow-[var(--cf-shadow)]">
          <p className="px-1 pb-1.5 text-[11px] font-semibold text-[var(--cf-text)]" title={t("chat.mcpHint")}>
            {t("chat.mcpHeading")}
          </p>
          {unavailableReason && (
            <p className="px-1 pb-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{unavailableReason}</p>
          )}
          <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
            {shown.map((server) => {
              const status = STATUS[server.status];
              return (
                <label
                  key={server.key}
                  className={`flex items-center gap-2 rounded-md px-1 py-1 ${
                    canSwitch && server.togglable ? "cursor-pointer hover:bg-[var(--cf-hover)]" : ""
                  }`}
                  title={status ? t(status.key) : undefined}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: status?.color ?? "var(--cf-border)" }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{server.name}</span>
                  {server.source === "app" && (
                    <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[10px] leading-[14px] text-[var(--cf-text-muted)]">
                      CodeFlow
                    </span>
                  )}
                  {server.togglable ? (
                    <Checkbox
                      checked={server.enabled}
                      disabled={!canSwitch}
                      onChange={(checked) => toggle(server, checked)}
                    />
                  ) : (
                    <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{t("chat.mcpAlwaysOn")}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
