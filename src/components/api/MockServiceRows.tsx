/**
 * The workspace's collection mocks, listed under its services in the Services dock (user,
 * 2026-10-23: the mock «aparece en Servicios, para arrancarlo junto con el resto del proyecto»).
 *
 * Rows of their own rather than a service kind: the supervisor's whole model is a process in a pty
 * — its Ctrl-C, its process-tree ports, its restarts — and an in-process listener has none of that
 * to supervise. So a mock here starts and stops with its own switch, and the ones marked «Arrancar
 * con los servicios» come up when a group of the workspace is started (`servicesStore.startGroup`).
 */

import { useEffect, useState } from "react";
import { Play, Server, Square } from "lucide-react";
import { RowButton, SectionHeader } from "../services/ServiceList";
import { useApiMockStore } from "../../state/apiMockStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { mockWorkspace, type MockSummary } from "../../lib/tauri/mockCommands";
import { startMock, stopMock } from "./mockActions";

export function MockServiceRows() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const running = useApiMockStore((s) => s.running);
  const [mocks, setMocks] = useState<MockSummary[]>([]);

  useEffect(() => useApiMockStore.getState().ensure(), []);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void mockWorkspace(workspaceId)
      .then((list) => live && setMocks(list))
      .catch(() => live && setMocks([]));
    return () => {
      live = false;
    };
    // `running` is the trigger: every start or stop anywhere re-reads the list.
  }, [workspaceId, running]);

  if (!mocks.length) return null;

  const open = (collectionId: string) => {
    useUiStore.getState().openApiWorkspace("requests");
    useApiMockStore.getState().setFocusMock(collectionId);
    useApiStore.getState().openEntityTab("collection", collectionId);
  };

  return (
    <>
      <SectionHeader icon={Server} label={t("api.mock.servicesSection")} />
      {mocks.map((mock) => {
        const live = running[mock.collectionId] ?? mock.running;
        return (
          <div
            key={mock.collectionId}
            role="button"
            tabIndex={0}
            onClick={() => open(mock.collectionId)}
            onKeyDown={(e) => {
              if (e.key === "Enter") open(mock.collectionId);
            }}
            title={live ? live.url : t("api.mock.stopped")}
            className="group/row mx-1 flex select-none items-center gap-1.5 rounded-md py-[3px] pl-4 pr-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: live ? "var(--cf-success)" : "var(--cf-text-faint)" }}
            />
            <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{mock.name}</span>
            {live && <span className="shrink-0 font-mono text-[10.5px] tabular-nums">:{live.port}</span>}
            <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              <RowButton
                onClick={() =>
                  void (live ? stopMock(mock.collectionId) : startMock(mock.collectionId)).catch((e: unknown) =>
                    pushErrorToast(String(e)),
                  )
                }
                label={live ? t("api.mock.stop") : t("api.mock.start")}
                danger={Boolean(live)}
              >
                {live ? <Square size={9} /> : <Play size={9} />}
              </RowButton>
            </div>
          </div>
        );
      })}
    </>
  );
}
