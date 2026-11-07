import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TeamChatState } from "../../../types/team";
import { defaultPolicy, emptyMember } from "../../../types/team";
import type { AgentTask } from "../../../types/domain";
import type { ChatBubbleActions, ChatBubbleMessage } from "../../chat/ChatMessageBubble";
import { QuestionCard } from "../../chat/QuestionCard";
import { splitQuestions } from "../../../lib/chatQuestions";

let state: TeamChatState;
let actions: ChatBubbleActions | undefined;
let composer: { busy?: boolean; showModel?: boolean };
const send = vi.fn(() => true);
let convert: (() => void) | undefined;
const open = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => command === "team_chat_draft"
  ? { teamId: "team", projectId: "repo", goal: "Agreed scope", attachments: [{ id: "file" }] } : null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../../state/teamChatStore", () => {
  const store = (selector: (s: unknown) => unknown) => selector({ states: { chat: state } });
  store.getState = () => ({ send, cancel: async () => {}, refresh: async () => {} });
  return { useTeamChatStore: store, teamChatBusy: (s: TeamChatState) => s.chat.status === "running" || s.chat.status === "cancelling" };
});
vi.mock("../state", () => {
  const store = (selector: (s: unknown) => unknown) => selector({ close: () => {} });
  store.getState = () => ({ open });
  return { useL: () => (_es: string, en: string) => en, lNow: (_es: string, en: string) => en, useCrewStore: store };
});
vi.mock("../kit/ui", () => ({
  Drawer: ({ children }: { children: ReactNode }) => <>{children}</>,
  Btn: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) => {
    if (children === "Convert to task" && !disabled) convert = onClick;
    return <button disabled={disabled}>{children}</button>;
  },
}));
vi.mock("../../agents/AgentTaskDetail", () => ({ AgentComposer: (props: typeof composer) => { composer = props; return <div>Composer</div>; } }));
vi.mock("../../chat/ChatMessageBubble", () => ({
  ChatMessageBubble: (props: { message: ChatBubbleMessage; actions?: ChatBubbleActions }) => {
    actions = props.actions;
    const { questions } = splitQuestions(props.message.content);
    return questions.length ? <QuestionCard questions={questions} onAnswer={props.actions?.onAnswer} /> : <p>{props.message.content}</p>;
  },
}));

const { TeamChatPane } = await import("./TeamChatPane");
const render = () => renderToStaticMarkup(<TeamChatPane chatId="chat" />);

beforeEach(() => {
  send.mockClear();
  open.mockClear();
  convert = undefined;
  actions = undefined;
  state = {
    chat: {
      id: "chat", workspaceId: "ws", projectId: "repo", projectName: "API", teamId: "team", teamName: "Equipo API", teamUpdatedAt: "", leadId: "lead", taskId: "task",
      members: [{ ...emptyMember(), id: "lead", name: "Arquitecto", provider: "claude", model: "sonnet", prompt: "", effort: "" }], policy: defaultPolicy(), status: "idle", activeMemberId: "", activeRunId: "", error: "", revision: 1, createdAt: "2026-11-06",
    }, task: { id: "task" } as AgentTask, messages: [],
  };
});

describe("team chat pane", () => {
  it("shows which team, lead and repository the conversation works in", () => {
    const html = render();
    expect(html).toContain("Equipo API");
    expect(html).toContain("Led by Arquitecto");
    expect(html).toContain("write and edit in API");
    expect(composer.showModel).toBe(false);
  });

  it("identifies the member and sends question answers back through the team coordinator", () => {
    state.messages = [{ id: "message", role: "assistant", memberId: "lead", memberName: "Arquitecto", content: '```pregunta\n{"pregunta":"¿Cómo seguimos?","opciones":["Implementar"]}\n```', provider: "claude", model: "sonnet", traceId: null, responseTimeMs: 1, createdAt: "2026-11-06" }];
    const html = render();
    expect(html).toContain("Arquitecto");
    expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Implementar<\/button>/);
    actions?.onAnswer?.("Implementar");
    expect(send).toHaveBeenCalledWith("chat", "Implementar", undefined);
  });

  it("waits for the current exchange before accepting a question answer", () => {
    state.chat.status = "running";
    state.chat.activeMemberId = "lead";
    expect(render()).toContain("Arquitecto is working");
    expect(composer.busy).toBe(true);
    expect(actions?.onAnswer).toBeUndefined();
  });

  it("opens the normal team launcher with the original repository and attachments", async () => {
    state.messages = [{ id: "user", role: "user", memberId: "", memberName: "", content: "Build the endpoint",
      provider: "", model: "", traceId: null, responseTimeMs: 0, createdAt: "2026-11-06" }];
    expect(render()).toContain("Convert to task");
    convert?.();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith({
      kind: "launch", goal: "Agreed scope", assignee: { kind: "team", id: "team" },
      projectId: "repo", attachments: [{ id: "file" }],
    }));
  });
});
