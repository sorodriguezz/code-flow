import type { EditorGroup } from "./editorGroups";

/**
 * What a project switch does to the editor — as pure functions over its state, because the rule it
 * replaces ("empty the editor") lost unsaved work silently, and the one that replaces it has to be
 * checked directly rather than by switching projects in the app.
 *
 * A project left with unsaved tabs is **parked**: its whole editor — tabs, groups, which one had
 * focus — set aside under its path, exactly as it was. A project coming back gets its parked editor
 * back. A project left with nothing unsaved is simply emptied, as before: parking every project ever
 * visited would keep every buffer ever opened.
 */

/** The part of a tab these rules look at. */
export interface BufferState {
  loading: boolean;
  content: string;
  originalContent: string;
}

/** Unsaved edits a save would write. A tab still loading holds nothing of the user's yet. */
export function isDirtyBuffer(tab: BufferState): boolean {
  return !tab.loading && tab.content !== tab.originalContent;
}

/** One window's editor: every open file, and the groups showing them. */
export interface EditorSlice<Tab> {
  tabs: Tab[];
  groups: EditorGroup[];
  activeGroupId: string;
}

/** An editor set aside with the project it belongs to. */
export interface ParkedEditor<Tab, P> extends EditorSlice<Tab> {
  project: P;
}

export type Parked<Tab, P> = Record<string, ParkedEditor<Tab, P>>;

/**
 * The parked editors after a switch from `left` to the project at `next`: `left` parked when it has
 * unsaved tabs, and `next` taken out — it is about to be the editor on screen again.
 */
export function parkedAfterSwitch<Tab extends BufferState, P extends { local_path: string }>(
  parked: Parked<Tab, P>,
  current: EditorSlice<Tab>,
  left: P | null,
  next: string | null,
): Parked<Tab, P> {
  const leaving = left !== null && current.tabs.some(isDirtyBuffer);
  const returning = next !== null && next in parked;
  if (!leaving && !returning) return parked;
  const updated = { ...parked };
  if (leaving) updated[left.local_path] = { ...current, project: left };
  if (next !== null) delete updated[next];
  return updated;
}

/** The editor the window shows after switching to `next`: its parked editor if it has one, else an
 *  empty one — `restored` says which. */
export function editorAfterSwitch<Tab, P>(
  parked: Parked<Tab, P>,
  next: string | null,
  freshGroup: () => EditorGroup,
): { editor: EditorSlice<Tab>; restored: boolean } {
  const back = next !== null ? parked[next] : undefined;
  if (back) return { editor: { tabs: back.tabs, groups: back.groups, activeGroupId: back.activeGroupId }, restored: true };
  const group = freshGroup();
  return { editor: { tabs: [], groups: [group], activeGroupId: group.id }, restored: false };
}
