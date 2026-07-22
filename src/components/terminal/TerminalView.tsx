import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSquare } from "lucide-react";
import { closeTerminal, openTerminal, resizeTerminal, writeTerminal } from "../../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../../lib/tauri/events";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";

const LIGHT_THEME = { background: "#ffffff", foreground: "#1c1c26", cursor: "#1c1c26" };
const DARK_THEME = { background: "#1e1e27", foreground: "#eceef5", cursor: "#eceef5" };

export function TerminalView() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const resolved = useThemeStore((s) => s.resolved);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!project || !containerRef.current) return;
    let disposed = false;
    let sessionId: string | null = null;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      theme: resolved === "dark" ? DARK_THEME : LIGHT_THEME,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    const dataDisposable = term.onData((data) => {
      if (sessionId) void writeTerminal(sessionId, data);
    });

    (async () => {
      const id = await openTerminal(project.local_path);
      if (disposed) {
        void closeTerminal(id);
        return;
      }
      sessionId = id;

      unlistenOutput = await onTerminalOutput((e) => {
        if (e.id === id) term.write(e.data);
      });
      unlistenExit = await onTerminalExit((e) => {
        if (e.id === id) term.write("\r\n[process exited]\r\n");
      });

      void resizeTerminal(id, term.cols, term.rows);
    })();

    const handleResize = () => {
      fitAddon.fit();
      if (sessionId) void resizeTerminal(sessionId, term.cols, term.rows);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      if (sessionId) void closeTerminal(sessionId);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.local_path]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolved === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [resolved]);

  if (!project) {
    return <EmptyState icon={TerminalSquare} title={t("terminal.noProject")} />;
  }

  return <div ref={containerRef} className="h-full w-full overflow-hidden p-2" />;
}
