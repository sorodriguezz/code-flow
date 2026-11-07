import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../../types/domain";
import type { AgentTaskLive } from "../../state/agentsStore";
import type { ChatBubbleActions, ChatBubbleMessage } from "../chat/ChatMessageBubble";
import { splitQuestions } from "../../lib/chatQuestions";
import { QuestionCard } from "../chat/QuestionCard";

let task: AgentTask;
let live: AgentTaskLive;
let repoBusy = false;
let chainRunning = false;
let rendered: { message: ChatBubbleMessage; actions?: ChatBubbleActions }[];
const send = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../state/agentsStore", () => {
  const store = (selector: (state: unknown) => unknown) => selector({
    tasks: [task], live: { t1: live }, bounced: {}, runningInProject: () => repoBusy ? "other-task" : null,
  });
  store.getState = () => ({ send });
  store.subscribe = () => () => {};
  return { useAgentsStore: store };
});
vi.mock("../../state/chainStore", () => ({
  useChainStore: (selector: (state: unknown) => unknown) => selector({
    chains: chainRunning ? [{ id: "chain", status: "running" }] : [],
    stepsByChain: { chain: [{ task_id: "t1" }] },
  }),
}));
vi.mock("./AgentModelMenu", () => ({ AgentModelMenu: () => null }));
vi.mock("../crew/teams/TeamChatPane", () => ({ TeamChatContent: () => <div>Team chat</div> }));
// Exercise the real question card while capturing the action supplied by the task transcript.
vi.mock("../chat/ChatMessageBubble", () => ({
  ChatMessageBubble: (props: { message: ChatBubbleMessage; actions?: ChatBubbleActions }) => {
    rendered.push(props);
    const { questions } = splitQuestions(props.message.content);
    return questions.length ? <QuestionCard questions={questions} onAnswer={props.actions?.onAnswer} /> : null;
  },
}));

const { TaskConversation } = await import("./AgentTaskDetail");
const question = '```pregunta\n{"pregunta":"¿Cómo seguimos?","opciones":["Solo contrato","Contrato e implementación"]}\n```';
const render = () => renderToStaticMarkup(<TaskConversation taskId="t1" />);

beforeEach(() => {
  task = { id: "t1", workspace_id: "w1", project_id: "p1", provider: "claude", model: "sonnet", conversation_id: "conv", goal: "", turns: 1 } as AgentTask;
  live = {
    messages: [{ role: "user", content: "Crea un endpoint" }, { role: "assistant", content: question }],
    sessionId: "session", runId: null, runStartedAt: null, sending: false, loaded: true,
  };
  repoBusy = false;
  chainRunning = false;
  rendered = [];
  send.mockClear();
});

describe("agent question answers", () => {
  it("keeps a team chat coordinated when its task is opened outside the team drawer", () => {
    task.batch_id = "team-chat:team-conversation:lead";
    expect(render()).toContain('data-team-chat="team-conversation"');
    expect(rendered).toEqual([]);
  });
  it("enables the latest question and sends the selected answer to the same task", () => {
    const html = render();
    expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Solo contrato<\/button>/);
    expect(html).toMatch(/placeholder="(?:Another answer|Otra respuesta)[^"]*"/);
    rendered[rendered.length - 1]?.actions?.onAnswer?.("Solo contrato");
    expect(send).toHaveBeenCalledWith("t1", "Solo contrato");
  });

  it("keeps earlier questions read-only after the conversation moves on", () => {
    live.messages.push({ role: "user", content: "Otra cosa" }, { role: "assistant", content: question });
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Solo contrato<\/button>/);
    expect(rendered[1].actions?.onAnswer).toBeUndefined();
    expect(rendered[3].actions?.onAnswer).toBeTypeOf("function");
  });

  it.each(["sending", "repository busy", "chain running", "local execution", "loading"])("waits while %s prevents another turn", (blocked) => {
    if (blocked === "sending") live.sending = true;
    if (blocked === "repository busy") repoBusy = true;
    if (blocked === "chain running") chainRunning = true;
    if (blocked === "local execution") task.provider = "local-exec";
    if (blocked === "loading") live.loaded = false;
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Solo contrato<\/button>/);
    expect(rendered[rendered.length - 1]?.actions?.onAnswer).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
