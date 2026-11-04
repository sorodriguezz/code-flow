/**
 * Drawers for the work itself: a task's conversation (transcript, composer, review and race tabs)
 * and a chain's run (its steps and gates). Their insides are the app's conversation and chain
 * engines — what makes a task a real chat with the CLI — framed by this view. So are a race's
 * comparison, and the two authoring dialogs for fixed flows and for realizing a story.
 */
import { Suspense, lazy } from "react";
import { Drawer } from "./kit/ui";
import { useCrewStore } from "./state";

const AgentTaskDetail = lazy(() => import("../agents/AgentTaskDetail").then((m) => ({ default: m.AgentTaskDetail })));
const ChainDetail = lazy(() => import("../agents/ChainDetail").then((m) => ({ default: m.ChainDetail })));
const RacePanel = lazy(() => import("../agents/RacePanel").then((m) => ({ default: m.RacePanel })));
const NewChainModal = lazy(() => import("../agents/NewChainModal").then((m) => ({ default: m.NewChainModal })));
const StoryRealizerModal = lazy(() => import("../agents/StoryRealizerModal").then((m) => ({ default: m.StoryRealizerModal })));

export function TaskPane({ taskId }: { taskId: string }) {
  const close = useCrewStore((s) => s.close);
  return (
    <Drawer onClose={close} width={780} label="task">
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <AgentTaskDetail key={taskId} taskId={taskId} />
        </Suspense>
      </div>
    </Drawer>
  );
}

export function ChainPane({ chainId }: { chainId: string }) {
  const close = useCrewStore((s) => s.close);
  return (
    <Drawer onClose={close} width={780} label="chain">
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <ChainDetail key={chainId} chainId={chainId} />
        </Suspense>
      </div>
    </Drawer>
  );
}

export function RacePane({ batchId }: { batchId: string }) {
  const close = useCrewStore((s) => s.close);
  return (
    <Drawer onClose={close} width={1000} label="race">
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <RacePanel key={batchId} batchId={batchId} />
        </Suspense>
      </div>
    </Drawer>
  );
}

/** Where «manage agents» goes from the carried-over dialogs: the roster space. */
function toRoster() {
  const crew = useCrewStore.getState();
  crew.close();
  crew.setSpace("agentes");
}

export function ChainEditorPane({ templateId }: { templateId?: string | null }) {
  const close = useCrewStore((s) => s.close);
  return (
    <Suspense fallback={null}>
      <NewChainModal onClose={close} onManageAgents={toRoster} templateId={templateId ?? null} />
    </Suspense>
  );
}

export function StoryPane() {
  const close = useCrewStore((s) => s.close);
  return (
    <Suspense fallback={null}>
      <StoryRealizerModal onClose={close} onManageAgents={toRoster} />
    </Suspense>
  );
}
