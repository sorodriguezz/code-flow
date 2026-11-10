/**
 * The workspace's collection mocks, listed under its services in the Services dock (user,
 * 2026-10-23: the mock «aparece en Servicios, para arrancarlo junto con el resto del proyecto»).
 *
 * Rows of their own rather than a service kind: the supervisor's whole model is a process in a pty
 * — its Ctrl-C, its process-tree ports, its restarts — and an in-process listener has none of that
 * to supervise. So a mock here starts and stops with its own switch, and the ones marked «Arrancar
 * con los servicios» come up when a group of the workspace is started (`servicesStore.startGroup`).
 *
 * Drawn as one more group of the list, collapsed by default (user, 2026-11-09: a section of its own
 * «ocupa mucho espacio», and a mock once made could not be removed). Each row opens its collection,
 * starts or stops it, and deletes it.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CirclePlay, ExternalLink, Play, Square, Trash2 } from "lucide-react";
import { HeaderButton, RowButton } from "../services/ServiceList";
import { useApiMockStore } from "../../state/apiMockStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { mockDelete, mockWorkspace, type MockSummary } from "../../lib/tauri/mockCommands";
import { startMock, stopMock } from "./mockActions";

const COLLAPSED_KEY = "cf.services.mocksCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function MockServiceRows() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const running = useApiMockStore((s) => s.running);
  const [mocks, setMocks] = useState<MockSummary[]>([]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Bumped after a delete: removing a stopped mock changes nothing in `running`.
  const [reload, setReload] = useState(0);

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
  }, [workspaceId, running, reload]);

  if (!mocks.length) return null;

  const isLive = (mock: MockSummary) => running[mock.collectionId] ?? mock.running;
  const upCount = mocks.filter(isLive).length;

  const toggle = () => {
    setCollapsed((was) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, was ? "0" : "1");
      } catch {
        /* a private window: the choice lasts the session */
      }
      return !was;
    });
  };

  const open = (collectionId: string) => {
    useUiStore.getState().openApiWorkspace("requests");
    useApiMockStore.getState().setFocusMock(collectionId);
    useApiStore.getState().openEntityTab("collection", collectionId);
  };

  const run = (action: Promise<unknown>) => void action.catch((e: unknown) => pushErrorToast(String(e)));

  const remove = async (mock: MockSummary) => {
    if (!(await confirmAction(t("api.mock.deleteConfirm", { name: mock.name })))) return;
    try {
      await mockDelete(mock.collectionId);
      setReload((n) => n + 1);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="mb-0.5">
      <div className="group/section flex select-none items-center gap-1 px-2 pb-0.5 pt-1">
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          title={t("api.mock.servicesSection")}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium text-[var(--cf-text)]"
        >
          {collapsed ? (
            <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="truncate">{t("api.mock.groupName")}</span>
          <span
            className="shrink-0 text-[10.5px] font-normal tabular-nums"
            style={{ color: upCount > 0 ? "var(--cf-success)" : "var(--cf-text-muted)" }}
          >
            {upCount > 0 ? `${upCount}/${mocks.length}` : mocks.length}
          </span>
        </button>
        {upCount < mocks.length && (
          <HeaderButton
            onClick={() => run(Promise.all(mocks.filter((m) => !isLive(m)).map((m) => startMock(m.collectionId))))}
            label={t("api.mock.startAll")}
          >
            <CirclePlay size={11} className="text-[var(--cf-success)]" />
          </HeaderButton>
        )}
        {upCount > 0 && (
          <HeaderButton
            onClick={() => run(Promise.all(mocks.filter((m) => isLive(m)).map((m) => stopMock(m.collectionId))))}
            label={t("api.mock.stopAll")}
          >
            <Square size={10} className="text-[var(--cf-danger)]" />
          </HeaderButton>
        )}
      </div>
      {!collapsed &&
        mocks.map((mock) => {
          const live = isLive(mock);
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
                {/* Open and delete on hover, like a service row's ⋯; start/stop always drawn. */}
                <span className="flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
                  <RowButton onClick={() => open(mock.collectionId)} label={t("api.mock.open")}>
                    <ExternalLink size={10} />
                  </RowButton>
                  <RowButton onClick={() => void remove(mock)} label={t("api.mock.delete")} danger>
                    <Trash2 size={10} />
                  </RowButton>
                </span>
                <RowButton
                  onClick={() => run(live ? stopMock(mock.collectionId) : startMock(mock.collectionId))}
                  label={live ? t("api.mock.stop") : t("api.mock.start")}
                  danger={Boolean(live)}
                >
                  {live ? <Square size={9} /> : <Play size={9} />}
                </RowButton>
              </div>
            </div>
          );
        })}
    </div>
  );
}
