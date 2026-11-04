# Chats: artifacts, cross-chat references, chat islands, subchats

Asked 2026-11-03. Built on top of the uncommitted work on `main`; nothing is committed.

## User decisions (2026-11-03)

- **Artifact** = what Claude generates on claude.ai: a named, self-contained deliverable (HTML page,
  Markdown document, diagram, SVG, a component or script) rendered in its own viewer, not a bubble.
- A chat can reference another chat by **name or id** ("test", `conv-…`): the model gets a
  **summary + on-demand full read**, and it can also **write to that chat** so the chat continues there.
- A panel chat (repo or workspace) can become an **island** (its own window), several at once,
  **not counted against the island limit**. Detaching **moves** the tab (it leaves the panel while the
  window is open and comes back on close), like every other island.
- Panel chats get **«Nuevo subchat»** (an icon): a fresh conversation on the same repo/workspace,
  nested under the parent. **«Bifurcar»** also produces a subchat, carrying the context up to the fork
  point. Subchats show nested in **all three places**: the Inbox's Recientes list, the tab strip, and
  inside the chat (a row of its subchats; in a subchat, a link to the parent).

## Design

### Lineage (subchats)
- Table `chat_lineage(conversation_id PK, surface TEXT 'panel'|'ws', parent_id TEXT, kind TEXT
  'new'|'branch', scope_id TEXT /*project id or workspace id*/, branched_turn INTEGER NULL,
  created_at TEXT)`. One table for both surfaces; neither `activity_log` nor `chat_conversations` changes.
- Created by: «Nuevo subchat» (kind new), `branch_chat_conversation` and the workspace chat's
  `branchAt` (kind branch). Deleting a parent re-parents its children to the grandparent (or root).
- Trees can nest; UI indents to depth 3 and flattens below that.

### Chat islands
- New `SatelliteKind::Chat`, `ref_id = "panel:<projectId>:<conversationId>"` or
  `"ws:<workspaceId>:<conversationId>"`. Utility-like for the user's ceiling (not counted), with its
  own backstop (e.g. 12) so a bug cannot open windows without end.
- The island renders `PanelChat` / `WorkspaceChat` alone. Detach is refused while a turn is running.
- Main hides the tab while the island is open (`windows:satellites` diff, `islandSync`-style release /
  reload of that conversation in `chatStore` / `workspaceChatStore`) and restores it when it closes.

### Artifacts
- Protocol (every engine, like `pregunta`): appended to `ai::chat_turn_rules`, an `ARTIFACT_RULES`
  note: a deliverable meant to be kept goes in a fence of **four backticks** with info string
  `artefacto` and a one-line JSON header: `{"name":"kebab-name","type":"html|markdown|mermaid|svg|code","title":"…","language":"ts"}`
  then the content. Re-emitting a name makes a new **version**.
- Table `chat_artifacts(id, workspace_id, surface, conversation_id, project_id NULL, name, title,
  kind, language, content, version, turn, created_at)`, unique `(workspace_id, name, version)`. Names are
  unique per workspace so another chat can reference them.
- Extracted on the backend when the answer is stored (repo `send_chat_message`, workspace `chat_send`),
  so no frontend has to remember to save it. The bubble shows a card instead of the block (name,
  type, version, open). Viewer: HTML in a sandboxed iframe (`srcdoc`, no same-origin), Markdown with
  the app's renderer, Mermaid/SVG drawn, code highlighted; copy, download, save into the repo, versions.
- Artifacts of a chat are listed in the chat; artifacts of the workspace in the Inbox.

### References
- Mentions `@chat:<name|id>` and `@artefacto:<name>` (`@artifact:` too) in both panel composers'
  MentionMenu. Resolved on the backend next to `ai::special_mentions`:
  - chat → a short note: title, surface, repo(s), turns, files changed, last question/answer trimmed,
    its artifacts, and that the full conversation can be read with the `chat_read` tool.
  - artifact → its latest version's content (capped 40k).
- MCP tools on `codeflow_map` (`codemap/mcp.rs`): `chat_list`, `chat_read` (read-only),
  `artifact_list`, `artifact_read` (read-only), `chat_send` (acts): asks another chat to continue.
- `chat_send` flow: backend emits `chat:delegate {requestId, target, message, from}`; the window that
  holds the conversation (its island, else main) sends it as a normal visible turn, then calls
  `chat_delegate_settle(requestId, reply|error)`; the backend awaits it (10 min). A delegated turn
  cannot delegate again (depth 1). Refused while the target is busy.

## Status

See the bottom of this file, updated by whoever builds each half.

## Status — A (subchats + chat islands), 2026-11-03

Built, uncommitted on main. Not run in the live app.

- Backend: `src-tauri/src/chat_lineage.rs` (table `chat_lineage`, `link` refuses cycles/self/unknown
  surface, `forget` re-parents children to the grandparent, startup `sweep` of links older than 2 days
  whose conversation never got a turn; commands `chat_lineage_list/link/forget`). Migration hooked at the
  end of `db/migrations.rs`. `branch_chat_conversation` (activity_cmd) and the workspace chat's
  `branch_conversation` (chat_cmd, only when `workspace_scope`) link the fork as kind `branch`; both
  delete commands call `forget`. `chat_lineage` added to `backup/snapshot.rs` (TABLES + conversations group).
- `windows.rs`: `SatelliteKind::Chat` — desk (parked/restored with it), `counts_against_ceiling()` false,
  own backstop `MAX_CHAT_SATELLITES = 12`, label digested like `File`, opens 560×760.
- Frontend: `lib/tauri/chatLineage.ts`, `state/chatLineageStore.ts` (+ pure `nestByLineage`),
  `lib/chatIslandSync.ts` (ref format, handler registry), `lib/chatIslands.ts` (held tabs, open
  interceptor, island → main `panel-open` bus message, island draft envelope `ai_panel_island_draft:<tab>`
  taken back on return, reconcile/ensureLoaded on return + tab focused), `components/ai/ChatLineage.tsx`
  («Nuevo subchat» + «Abrir en una isla» header buttons, subchat row with parent link and child chips).
  Wired into PanelChat/WorkspaceChat headers, AiPanel (held tabs hidden), PanelTabStrip (`nestTabs`,
  ↳ marker), AssistantInbox Recientes (nested, foldable, count chip), SatelliteApp (`ChatWindow`),
  SatelliteTitleBar (`ChatCrumb`, keep-on-top, «Volver al panel»), windowStore (chat not counted, no limit
  check), windowIdentity (`chat` kind), aiPanelStore (`fresh` on targets, `registerOpenInterceptor`,
  `disablePanelPersistence`, `flushDrafts`, unwritten subchat's link forgotten on close), Codi actions.
- A ws subchat inherits the parent's repository narrowing (`setScope`). Engine/model are not inherited.
- Tests: `chat_lineage` (4), `windows::chat_islands_are_desk_but_not_counted`; vitest
  `chatLineageStore.test.ts` (nesting + refs), windowStore/windowIdentity/aiPanelStore cases added.
- Follow-up (same day): a chat tab dragged out past the window's edge opens as an island where it was
  let go (`useTearOut` in PanelTabStrip, pointer events like `EditorTabs`, `screenX/Y` logical px; the
  drop-point physical-px trap is the OS drag-drop event's, not this). Same rule as the button:
  `chatTabDetachable` (on disk, no turn running, nothing queued); otherwise a toast says why.
- Island drafts: no timer any more. Every change goes to the envelope at once through
  `lib/latestWriter` (one write in flight, newest value next), and `onCloseRequested` awaits
  `writer.flush()` — Tauri holds the close until it resolves, so «Volver al panel», the red button and
  the OS close all land the last keystroke before the main window reads it on return. Tests:
  `latestWriter.test.ts`, `outsideViewport` in `chatLineageStore.test.ts`.
- Unverified: the island window and the tear-out in a real build (bundle, title bar, placement, return
  focus); a tray put-away that destroys windows without a close request relies on the per-change writes.

## Status — B (artifacts + references), 2026-11-03, uncommitted

- Backend `src-tauri/src/chat_refs/`: `artifacts.rs` (table `chat_artifacts`, parser — 4-backtick fence,
  nested fences by info string, header JSON or `key="v"` on the line or the next, unclosed runs to the end —
  versioning by name per workspace, identical content is not a new version; `ARTIFACT_RULES`), `refs.rs`
  (one list over repo chats + workspace chats + Chat-app threads; resolve by id / folded title / unique part,
  ambiguity is an error; `summary_note`, `transcript` (60k, `from_turn`), `@chat:` / `@artefacto:` /
  `@artifact:` mention notes), `delegate.rs` (`chat:delegate` → accept within 20 s → answer within 10 min;
  depth-1, self, busy-lease and Chat-app refusals; run→conversation marks), `mod.rs` (MCP tools
  `chat_list`/`chat_read`/`artifact_list`/`artifact_read` read-only, `chat_send` acts; `chat:artifacts` event).
- Hooks: rules in `ai::chat_turn_rules`; mention notes + run marks + filing in `claude_cmd::send_chat_message`
  (surface `panel`) and `chat_cmd::chat_send` (surface `ws` or `chat`); tools on `codeflow_map` for every token
  but grounding/Codi (`Access.run` captured at grant); `agentcli::place` made `pub(crate)`; commands in
  `commands/chat_refs_cmd.rs`; migration + backup (`chat_artifacts`, conversations group).
- Frontend: `lib/chatArtifacts.ts` (mirror parser), `components/chat/ArtifactViewer.tsx` (HTML/SVG in a
  no-same-origin frame with a no-network CSP, scripts only behind «Ejecutar scripts»; Markdown; Mermaid;
  code; versions; copy/download/save in repo), `ArtifactCards.tsx` (bubble cards, per-chat strip, Inbox
  section with delete), `state/chatArtifactsStore.ts`, `lib/tauri/chatRefsCommands.ts`, MentionMenu rows,
  `lib/chatDelegate.ts` (installed in main and chat islands). The bubble is shared, so the Chat app gets
  the cards too (its versions are looked up in the active workspace).
- Unverified: a live model emitting the block; `chat_send` end to end in the app (Claude's MCP tool timeout
  vs the 10-min wait); agy/Grok get only the read tools (file-held tokens never act).
