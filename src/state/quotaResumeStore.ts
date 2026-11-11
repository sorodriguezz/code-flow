import { create } from "zustand";
import type { QueuedChatMessage } from "./chatQueueStore";
import { isMainWindow } from "../lib/windowIdentity";
import { resolveQuotaResumeTime } from "../lib/quotaResume";

const QUOTA_RESUME_STORAGE_KEY = "cf_quota_resume";
const QUOTA_RESUME_TICK_MS = 30_000;

export type QuotaResumeSurface = "workspaceChat" | "repoChat";

export type QuotaResumeRetry = Omit<QueuedChatMessage, "id" | "queuedAt">;

export interface QuotaResumeEntry {
  queueKey: string;
  surface: QuotaResumeSurface;
  conversationId: string;
  ownerId: string;
  at: number;
  retry: QuotaResumeRetry;
}

type QuotaResumeHandler = (entry: QuotaResumeEntry) => Promise<void>;

interface QuotaResumeState {
  entries: Record<string, QuotaResumeEntry>;
}

function isEntry(value: unknown): value is QuotaResumeEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const retry = entry.retry as Record<string, unknown> | undefined;
  const hasRetryText = typeof retry?.text === "string";
  return (
    typeof entry.queueKey === "string" &&
    typeof entry.conversationId === "string" &&
    typeof entry.ownerId === "string" &&
    typeof entry.at === "number" &&
    hasRetryText
  );
}

function readStoredEntries(): Record<string, QuotaResumeEntry> {
  try {
    const stored = localStorage.getItem(QUOTA_RESUME_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    const candidates = Object.values(parsed as Record<string, unknown>);
    const valid = candidates.filter(isEntry);
    const pairs = valid.map((entry) => [entry.queueKey, entry] as const);
    return Object.fromEntries(pairs);
  } catch {
    return {};
  }
}

function writeStoredEntries(entries: Record<string, QuotaResumeEntry>): void {
  const serialized = JSON.stringify(entries);
  try {
    localStorage.setItem(QUOTA_RESUME_STORAGE_KEY, serialized);
  } catch {
    return;
  }
}

export const useQuotaResumeStore = create<QuotaResumeState>(() => ({ entries: readStoredEntries() }));

useQuotaResumeStore.subscribe((state, previous) => {
  const changed = state.entries !== previous.entries;
  if (changed) writeStoredEntries(state.entries);
});

const handlers = new Map<QuotaResumeSurface, QuotaResumeHandler>();

export function registerQuotaResumeHandler(surface: QuotaResumeSurface, handler: QuotaResumeHandler): void {
  handlers.set(surface, handler);
  startTicker();
}

export function scheduleQuotaResume(entry: QuotaResumeEntry): void {
  useQuotaResumeStore.setState((state) => ({ entries: { ...state.entries, [entry.queueKey]: entry } }));
}

export type QuotaResumeRequest = Omit<QuotaResumeEntry, "at">;

export async function scheduleQuotaResumeIfLimited(rawError: string, request: QuotaResumeRequest): Promise<void> {
  const failedAt = Date.now();
  const resumeAt = await resolveQuotaResumeTime(rawError, failedAt);
  if (resumeAt === null) return;
  const cancelledAt = lastCancelledAt.get(request.queueKey) ?? 0;
  const userMovedOn = cancelledAt > failedAt;
  if (userMovedOn) return;
  scheduleQuotaResume({ ...request, at: resumeAt });
}

const lastCancelledAt = new Map<string, number>();

export function cancelQuotaResume(queueKey: string): void {
  const cancelledAt = Date.now();
  lastCancelledAt.set(queueKey, cancelledAt);
  const exists = queueKey in useQuotaResumeStore.getState().entries;
  if (!exists) return;
  useQuotaResumeStore.setState((state) => {
    const { [queueKey]: _cancelled, ...rest } = state.entries;
    return { entries: rest };
  });
}

export function resumeQuotaNow(queueKey: string): boolean {
  const entry = useQuotaResumeStore.getState().entries[queueKey];
  if (!entry) return false;
  const handler = handlers.get(entry.surface);
  if (!handler) return false;
  cancelQuotaResume(queueKey);
  const resumed = handler(entry);
  void resumed.catch(() => undefined);
  return true;
}

export function useQuotaResumeAt(queueKey: string | null): number | null {
  return useQuotaResumeStore((state) => (queueKey ? (state.entries[queueKey]?.at ?? null) : null));
}

function runDueResumes(): void {
  const now = Date.now();
  const entries = Object.values(useQuotaResumeStore.getState().entries);
  const due = entries.filter((entry) => entry.at <= now);
  for (const entry of due) {
    const handler = handlers.get(entry.surface);
    if (!handler) continue;
    cancelQuotaResume(entry.queueKey);
    const resumed = handler(entry);
    void resumed.catch(() => undefined);
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;

function startTicker(): void {
  const isBrowser = typeof window !== "undefined";
  if (!isBrowser || ticker !== null) return;
  const ownsResumes = isMainWindow();
  if (!ownsResumes) return;
  ticker = setInterval(runDueResumes, QUOTA_RESUME_TICK_MS);
  window.addEventListener("focus", runDueResumes);
  document.addEventListener("visibilitychange", runDueResumes);
  queueMicrotask(runDueResumes);
}
