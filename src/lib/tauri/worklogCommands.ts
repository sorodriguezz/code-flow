import { invoke } from "@tauri-apps/api/core";
import type { NoteMetaRow } from "../../types/notes";

/**
 * IPC for «Resumen de tu trabajo» — the daily standup / weekly report (`src-tauri/src/worklog`).
 * Mirrors the Rust types field for field (serde camelCase).
 */

export type WorklogPeriodKind = "previousWorkday" | "today" | "thisWeek" | "lastWeek" | "custom";
export type WorklogFormat = "daily" | "weekly";

export interface WorklogRequest {
  period: WorklogPeriodKind;
  /** `YYYY-MM-DD`, for a custom range. */
  from?: string | null;
  to?: string | null;
  /** `null`: what the period reads as (a week is a report). */
  format?: WorklogFormat | null;
  /** `null`: every workspace. */
  workspaceId?: string | null;
  /** `{ provider, model, account }`; `null` for the Notes row's engine. */
  engine?: { provider: string; model?: string; account?: string } | null;
  /** The plain list, no model. */
  plain?: boolean;
  /** `es` · `en`; empty for the app's language. */
  language?: string;
}

export interface WorklogCommit {
  sha: string;
  branch: string;
  subject: string;
  time: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface WorklogPr {
  id: number;
  title: string;
  url: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  createdAt: string;
  failingChecks: string[];
}

export interface WorklogReview {
  runId: string;
  prId: number;
  prTitle: string;
  url: string;
  author: string;
  level: string;
  findings: number;
  at: string;
}

export interface WorklogRepo {
  projectId: string;
  repo: string;
  workspaceId: string;
  workspace: string;
  commits: WorklogCommit[];
  prsOpened: WorklogPr[];
  prsMerged: WorklogPr[];
  prsReviewed: WorklogPr[];
  prsInProgress: WorklogPr[];
  prsAwaitingMyReview: WorklogPr[];
  reviews: WorklogReview[];
  openBranches: string[];
}

export interface WorklogMeeting {
  meetingId: string;
  noteId: string;
  title: string;
  startedAt: string;
  minutes: number;
  summary: string;
}

export interface WorklogTicket {
  key: string;
  title: string;
  state: string;
  branch: string;
  url: string;
  at: string;
}

export interface WorkLog {
  period: { kind: WorklogPeriodKind; from: string; to: string; start: number; end: number };
  format: WorklogFormat;
  identity: string[];
  repos: WorklogRepo[];
  meetings: WorklogMeeting[];
  tickets: WorklogTicket[];
  notices: string[];
}

export interface WorklogOutcome {
  title: string;
  /** The summary alone — what the copy buttons copy. */
  markdown: string;
  /** The note's whole body. */
  body: string;
  log: WorkLog;
  /** The provider that wrote it, or `none` for the deterministic text. */
  engine: string;
  fallbackReason: string | null;
  language: string;
  request: WorklogRequest;
  note: NoteMetaRow | null;
}

/** Collects and writes; with `save`, keeps it as a note of `workspaceId` (over `noteId` to regenerate). */
export const worklogGenerate = (request: WorklogRequest, workspaceId: string, save: boolean, noteId: string | null = null) =>
  invoke<WorklogOutcome>("worklog_generate", { request, workspaceId, save, noteId });
