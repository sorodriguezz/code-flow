import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FolderGit2, Loader2, MessageSquarePlus, Rocket, SendHorizontal, Square, UsersRound } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { onInvalidate } from "../invalidate";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { sinceIso } from "../time";
import { toastError } from "../toast";
import { PushBar } from "../ui/AppBar";
import { BottomBar } from "../ui/BottomBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { ConfirmAction } from "../ui/ConfirmAction";
import { Card, Divider, Section } from "../ui/List";
import { EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import { Markdown } from "../ui/Markdown";
import { FileSection, pathOf } from "./CommitScreen";
import { UnifiedDiffText } from "./DiffView";
import type { FileDiffInfo } from "../../types/domain";

/**
 * The three things about a team that are a screen of their own: giving it a task, talking to it,
 * and reading what a decision would bring in.
 *
 * All three were "at the desk" until the user asked for them here (2026-11-26). What makes that
 * reasonable from a phone is the same in each: the phone names things and the desk resolves them.
 * A run is a team, a goal and repositories — its members, engines, budget and approvals are the
 * team's own, as saved at the desk. A message is text. A diff is a run and one of its tasks. No
 * path, branch, prompt or policy is ever written on this side.
 */

// ---------------------------------------------------------------- starting a run

/**
 * Giving a team a task.
 *
 * Two fields, because that is all a phone decides: what to do and where. The branch is whichever
 * each repository has checked out — the desk's dialog lets you pick another, and a branch picker
 * per repository on a phone is a form nobody finishes; anybody who needs a different base is at a
 * desk already.
 *
 * It takes two taps. Of everything this client can do, this is the one act that spends money on a
 * plan nobody is watching, so it is the one that must not happen from a pocket.
 */
export function TeamStartScreen({ workspaceId, teamId, teamName }: { workspaceId: string; teamId: string; teamName: string }) {
  const projects = useMobileStore((s) => s.projects);
  const current = useMobileStore((s) => s.projectId);
  const run = useMobileStore((s) => s.run);
  const refreshTeams = useMobileStore((s) => s.refreshTeams);
  const readOnly = useMobileStore((s) => s.readOnly);
  const busy = useBusy("teams");
  const replace = useNav((s) => s.replace);
  const [goal, setGoal] = useState(() => readDraft("teamGoal", teamId));
  // The repository the phone is on, to begin with: it is the one the person was just looking at.
  const [picked, setPicked] = useState<string[]>(() => (current ? [current] : []));

  const toggle = (id: string) => setPicked((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));

  const start = () =>
    void run(
      async () => {
        const view = await rpc<{ run: { id: string; title: string } }>("team_start", {
          workspaceId,
          teamId,
          goal: goal.trim(),
          // No branch named: each repository's own, as it stands at the desk.
          repos: picked.map((projectId) => ({ projectId, targetBranch: "" })),
        });
        clearDraft("teamGoal", teamId);
        void refreshTeams();
        // The form becomes the run it started. Going back from the run must not land on a form
        // that would start a second one.
        replace({ k: "teamRun", workspaceId, runId: view.run.id, title: view.run.title });
      },
      "teams",
      t("toast.teamStarted"),
    );

  return (
    <Screen bar={<PushBar title={t("teams.start.title")} subtitle={teamName} />}>
      <Section title={t("teams.start.goal")}>
        <Card padded>
          <textarea
            aria-label={t("teams.start.goal")}
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              writeDraft("teamGoal", teamId, e.target.value);
            }}
            placeholder={t("teams.start.goalPlaceholder")}
            rows={5}
            className="w-full resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
          />
        </Card>
      </Section>

      <Section title={t("teams.start.repos")}>
        <Card>
          {projects.map((project, index) => {
            const on = picked.includes(project.id);
            return (
              <div key={project.id}>
                {index > 0 && <Divider />}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(project.id)}
                  className="cf-press-row flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      on ? "border-[var(--cf-accent)] bg-[var(--cf-accent-strong)] text-[var(--cf-accent-contrast)]" : "border-[var(--cf-field-border)]"
                    }`}
                    aria-hidden
                  >
                    {on && <Check size={13} />}
                  </span>
                  <FolderGit2 size={15} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-md">{project.name}</span>
                </button>
              </div>
            );
          })}
        </Card>
        <p className="mt-2 px-1 text-xs text-[var(--cf-text-muted)]">{t("teams.start.branchHint")}</p>
      </Section>

      <Section>
        <p className="mb-2 px-1 text-xs text-[var(--cf-text-muted)]">{t("teams.start.policyHint")}</p>
        <div className="flex">
          <ConfirmAction
            label={t("teams.start.go")}
            confirmLabel={t("teams.start.goConfirm")}
            icon={<Rocket size={15} />}
            variant="primary"
            disabled={busy || readOnly || goal.trim().length === 0 || picked.length === 0}
            onConfirm={start}
          />
        </div>
      </Section>
    </Screen>
  );
}

// ---------------------------------------------------------------- a team's conversation

interface ChatMessage {
  id: string;
  role: string;
  member: string;
  content: string;
  provider: string;
  model: string;
  createdAt: string;
}

interface ChatView {
  id: string;
  teamId: string;
  teamName: string;
  status: string;
  activeMember: string;
  error: string;
  messages: ChatMessage[];
  earlier: number;
}

interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  messages: number;
}

/**
 * A conversation with a team — the same one the desk's floating window holds.
 *
 * The answer is not the reply to the request that sent the message: the desk files the message,
 * answers at once, and the lead (and whoever it delegates to) take their turns after. Each change
 * arrives as a frame naming the chat, and the transcript is re-read. So this screen never waits on
 * a call for as long as a model takes, and a phone that locks mid-answer comes back to the answer.
 *
 * Opened on the team's latest conversation. A read-only device reads it and cannot open a new one
 * or write in it; the desk refuses those, and the composer is not offered.
 */
export function TeamChatScreen({ teamId, teamName }: { teamId: string; teamName: string }) {
  const projectId = useMobileStore((s) => s.projectId);
  const readOnly = useMobileStore((s) => s.readOnly);
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("teams");
  const [chat, setChat] = useState<ChatView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => readDraft("teamChat", teamId));
  const scroller = useRef<HTMLDivElement>(null);
  /** The chat this screen is on, for the frame listener — which must not re-subscribe per message. */
  const chatId = useRef<string | null>(null);

  const show = (view: ChatView) => {
    chatId.current = view.id;
    setChat(view);
    setState("ready");
  };

  const open = useCallback(
    async (fresh: boolean) => {
      try {
        if (readOnly) {
          // Opening is a write — it makes a conversation when the team has none, or when the team
          // changed since the last one — so a device that may only look finds the latest by
          // reading, and reads it.
          const past = await rpc<ChatSummary[]>("team_chat_history", { teamId });
          if (past.length === 0) {
            setState("none");
            return;
          }
          show(await rpc<ChatView>("team_chat_state", { chatId: past[0].id }));
          return;
        }
        // The desk's own rule for which conversation that is: the latest one made with the team as
        // it is now, or a new one.
        show(await rpc<ChatView>("team_chat_open", { teamId, projectId, fresh }));
      } catch (e) {
        setFailure(e instanceof Error ? e.message : String(e));
        setState((current) => (current === "ready" ? "ready" : "error"));
      }
    },
    [teamId, projectId, readOnly],
  );

  useEffect(() => {
    void open(false);
  }, [open]);

  // The conversation moved: a message filed, a member started or finished answering.
  useEffect(
    () =>
      onInvalidate("teamChat", null, (detail) => {
        const id = chatId.current;
        if (!id || (detail.chat && detail.chat !== id)) return;
        void rpc<ChatView>("team_chat_state", { chatId: id })
          .then(show)
          .catch(() => undefined);
      }),
    [],
  );

  // Kept at the bottom as the transcript grows, which is where a conversation is read from.
  const count = chat?.messages.length ?? 0;
  const answering = chat?.status === "running" || chat?.status === "cancelling";
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [count, answering]);

  const send = () => {
    const message = draft.trim();
    if (!chat || !message) return;
    void run(
      async () => {
        show(await rpc<ChatView>("team_chat_send", { chatId: chat.id, message }));
        setDraft("");
        clearDraft("teamChat", teamId);
      },
      "teams",
    );
  };

  const stop = () => {
    if (!chat) return;
    // Outside `run`: stopping must work while a send holds the `teams` flag, and it reports only
    // its own failure — the transcript says the rest.
    void rpc("team_chat_cancel", { chatId: chat.id }).catch((e: unknown) =>
      toastError(t("error.actionFailed"), e instanceof Error ? e.message : String(e)),
    );
  };

  const bar = (
    <PushBar
      title={teamName}
      subtitle={t("teams.chat.subtitle")}
      actions={
        // A new conversation. Nothing is deleted: the old one stays in the team's history at the desk.
        !readOnly && chat && chat.messages.length > 0 ? (
          <IconButton icon={<MessageSquarePlus size={18} />} label={t("teams.chat.new")} disabled={busy || answering} onClick={() => void open(true)} />
        ) : undefined
      }
    />
  );

  if (state === "loading") {
    return (
      <Screen bar={bar}>
        <Section>
          <SkeletonList rows={3} />
        </Section>
      </Screen>
    );
  }
  if (state === "error" || state === "none" || !chat) {
    return (
      <Screen bar={bar}>
        {state === "none" ? (
          <EmptyState icon={<UsersRound size={26} aria-hidden />} title={t("teams.chat.noneYet")} />
        ) : (
          <ErrorState title={t("teams.chat.failed")} detail={failure} onRetry={() => void open(false)} />
        )}
      </Screen>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--cf-bg)]">
      {bar}
      <div ref={scroller} className="cf-scroll min-h-0 flex-1 px-3 pb-3">
        {chat.earlier > 0 && (
          <p className="mt-3 text-center text-xs text-[var(--cf-text-muted)]">{t("teams.chat.earlier", { n: chat.earlier })}</p>
        )}
        {chat.messages.length === 0 && !answering && (
          <EmptyState icon={<UsersRound size={26} aria-hidden />} title={t("teams.chat.empty")} hint={t("teams.chat.emptyHint")} />
        )}
        {chat.messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="cf-rise mt-3 flex justify-end">
              <p className="cf-selectable max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--cf-accent-strong)] px-3 py-2 text-base text-[var(--cf-accent-contrast)]">
                {message.content}
              </p>
            </div>
          ) : (
            <div key={message.id} className="cf-rise mt-3">
              {/* Who is speaking, above what they said: a team's transcript is several voices, and
                  the name is what tells the lead's summary from a member's finding. */}
              <p className="mb-1 text-xs font-semibold text-[var(--cf-text-muted)]">{message.member || teamName}</p>
              <div className="max-w-[94%] rounded-2xl rounded-tl-sm border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2">
                <Markdown text={message.content} />
              </div>
              <p className="mt-1 text-2xs text-[var(--cf-text-faint)]">
                {[message.model, sinceIso(message.createdAt)].filter(Boolean).join(" · ")}
              </p>
            </div>
          ),
        )}
        {answering && (
          <div className="mt-3 flex justify-start">
            <p className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-base text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              {chat.status === "cancelling"
                ? t("teams.chat.stopping")
                : chat.activeMember
                  ? t("teams.chat.answering", { name: chat.activeMember })
                  : t("teams.chat.thinking")}
            </p>
          </div>
        )}
        {chat.error && !answering && (
          <p className="cf-selectable mt-3 whitespace-pre-wrap rounded-lg bg-[var(--cf-danger-soft)] px-3 py-2 text-xs text-[var(--cf-danger-text)]">
            {chat.error}
          </p>
        )}
      </div>

      {!readOnly && (
        <BottomBar className="p-2">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                writeDraft("teamChat", teamId, e.target.value);
              }}
              placeholder={t("teams.chat.placeholder")}
              aria-label={t("teams.chat.placeholder")}
              rows={1}
              className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
            />
            {answering ? (
              <Button variant="danger" onClick={stop} disabled={chat.status === "cancelling"} ariaLabel={t("teams.chat.stop")} icon={<Square size={16} />} />
            ) : (
              <Button
                variant="primary"
                onClick={send}
                loading={busy}
                disabled={busy || draft.trim().length === 0}
                ariaLabel={t("teams.chat.send")}
                icon={busy ? undefined : <SendHorizontal size={17} />}
              />
            )}
          </div>
        </BottomBar>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- what a decision brings in

interface TeamDiff {
  base: string;
  head: string;
  files: FileDiffInfo[];
  more: number;
  text: string;
}

/**
 * The changes behind a decision: one task's, or everything a repository's integration would bring
 * into its branch.
 *
 * The screen the gate card used to apologise for not having ("the full diff is read on the
 * desktop"). Approving a merge, an impact or a failed review without being able to read the change
 * is approving on faith, and the phone is where those gates get answered.
 */
export function TeamDiffScreen({ runId, itemId, projectOf, title }: { runId: string; itemId?: string; projectOf?: string; title: string }) {
  const [diff, setDiff] = useState<TeamDiff | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setDiff(await rpc<TeamDiff>("team_phone_diff", { runId, itemId: itemId ?? null, projectId: projectOf ?? null }));
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [runId, itemId, projectOf]);

  useEffect(() => {
    void load();
  }, [load]);

  const bar = (
    <PushBar
      title={title}
      subtitle={
        diff && (diff.base || diff.head) ? (
          <span className="font-mono">
            {diff.base} ← {diff.head}
          </span>
        ) : (
          t("teams.diff.subtitle")
        )
      }
    />
  );

  if (state === "loading") {
    return (
      <Screen bar={bar}>
        <Section>
          <SkeletonList rows={4} />
        </Section>
      </Screen>
    );
  }
  if (state === "error" || !diff) {
    return (
      <Screen bar={bar}>
        <ErrorState title={t("diff.failed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }
  if (diff.files.length === 0 && !diff.text) {
    return (
      <Screen bar={bar} onRefresh={() => load()}>
        <p className="px-6 pt-10 text-center text-base text-[var(--cf-text-muted)]">{t("teams.diff.empty")}</p>
      </Screen>
    );
  }

  return (
    <Screen bar={bar} onRefresh={() => load()}>
      {diff.text ? (
        <Card className="mt-3 py-2">
          <UnifiedDiffText text={diff.text} />
        </Card>
      ) : (
        <Section title={t("commits.files", { n: diff.files.length })}>
          <Card>
            {diff.files.map((file, index) => (
              <FileSection key={`${pathOf(file)}-${index}`} file={file} />
            ))}
          </Card>
        </Section>
      )}
      {diff.more > 0 && <p className="mt-3 px-1 text-xs text-[var(--cf-text-muted)]">{t("teams.diff.more", { n: diff.more })}</p>}
    </Screen>
  );
}
