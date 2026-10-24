import { create } from "zustand";
import {
  mockClearLog,
  mockList,
  mockLog,
  mockStart,
  mockStop,
  onMockChanged,
  onMockLog,
  type MockLogEntry,
  type MockStatus,
} from "../lib/tauri/mockCommands";
import { LOG_LIMIT } from "../lib/api/mock";

/**
 * Which collection mocks are up, and what each has served.
 *
 * The truth is the backend's registry (`api::mock`); this mirrors it from `api-mock:changed` and
 * `api-mock:log`, so the collection row, the Mock panel and the Services dock agree without each
 * polling. Wired on first use rather than at app start: most sessions never open a mock.
 */
interface ApiMockState {
  running: Record<string, MockStatus>;
  logs: Record<string, MockLogEntry[]>;
  /** A collection whose settings should open on the Mock panel — set by the Services dock. */
  focusMock: string | null;
  ensure: () => void;
  refresh: () => Promise<void>;
  start: (collectionId: string) => Promise<MockStatus>;
  stop: (collectionId: string) => Promise<void>;
  loadLog: (collectionId: string) => Promise<void>;
  clearLog: (collectionId: string) => Promise<void>;
  setFocusMock: (collectionId: string | null) => void;
}

let wired = false;

export const useApiMockStore = create<ApiMockState>((set, get) => ({
  running: {},
  logs: {},
  focusMock: null,

  ensure: () => {
    if (wired) return;
    wired = true;
    void onMockChanged(() => void get().refresh());
    void onMockLog((collectionId, entry) =>
      set((s) => {
        const next = [...(s.logs[collectionId] ?? []), entry];
        return { logs: { ...s.logs, [collectionId]: next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next } };
      }),
    );
    void get().refresh();
  },

  refresh: async () => {
    const list = await mockList().catch(() => [] as MockStatus[]);
    set({ running: Object.fromEntries(list.map((m) => [m.collectionId, m])) });
  },

  start: async (collectionId) => {
    get().ensure();
    const status = await mockStart(collectionId);
    set((s) => ({ running: { ...s.running, [collectionId]: status }, logs: { ...s.logs, [collectionId]: [] } }));
    return status;
  },

  stop: async (collectionId) => {
    await mockStop(collectionId);
    set((s) => {
      const running = { ...s.running };
      delete running[collectionId];
      return { running };
    });
  },

  loadLog: async (collectionId) => {
    get().ensure();
    const entries = await mockLog(collectionId).catch(() => [] as MockLogEntry[]);
    set((s) => ({ logs: { ...s.logs, [collectionId]: entries } }));
  },

  clearLog: async (collectionId) => {
    await mockClearLog(collectionId);
    set((s) => ({ logs: { ...s.logs, [collectionId]: [] } }));
  },

  setFocusMock: (focusMock) => set({ focusMock }),
}));
