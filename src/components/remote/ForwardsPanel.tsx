import { useMemo } from "react";
import { CircleStop, Play, Settings2, Waypoints } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { Pill } from "./remoteChrome";
import { useRemoteStore, type RemoteForwardsTab } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";
import { describeForward, parseHostSpec, type ForwardSpec } from "../../types/remote";

/**
 * One host's port forwards: what it has saved, and which of those are up.
 *
 * The distinction the panel exists to make is between a forward that is *configured* and one that
 * is *listening*. A row in the host's spec is an intention; a row in the store's `forwards` array
 * is an `ssh -N` child with a bound port. They are shown as one list with a state, rather than two
 * lists, because "did I open that one?" is the question and two lists answer it by making you
 * cross-reference.
 *
 * Auto forwards are the exception, and they say so. They ride on the session's own `ssh` rather
 * than on a process of their own, so they cannot be started or stopped here — they came up with the
 * terminal and they go when it does, which is what marking one auto asked for.
 */
export function ForwardsPanel({ tab }: { tab: RemoteForwardsTab }) {
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === tab.hostId) ?? null);
  const active = useRemoteStore((s) => s.forwards);
  const hasSession = useRemoteStore((s) =>
    s.tabs.some((entry) => entry.kind === "session" && entry.hostId === tab.hostId && !entry.exited),
  );
  const startForward = useRemoteStore((s) => s.startForward);
  const stopForward = useRemoteStore((s) => s.stopForward);
  const t = useT();

  const spec = useMemo(() => (host ? parseHostSpec(host) : null), [host]);

  if (!host || !spec) {
    return <EmptyState icon={Waypoints} title={t("remote.hostGone")} />;
  }

  if (spec.forwards.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        title={t("remote.noForwards")}
        subtitle={t("remote.noForwardsHint")}
      />
    );
  }

  const isUp = (forward: ForwardSpec) => active.some((entry) => entry.id === forward.id);
  const resolvedPort = (forward: ForwardSpec) =>
    active.find((entry) => entry.id === forward.id)?.listen_port ?? forward.listen_port;

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-1.5">
        {spec.forwards.map((forward) => {
          const up = isUp(forward);
          const port = resolvedPort(forward);
          return (
            <div
              key={forward.id}
              className="flex items-center gap-2.5 rounded-md border border-[var(--cf-border)] px-3 py-2"
            >
              <span
                aria-hidden
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                  forward.auto
                    ? hasSession
                      ? "bg-[var(--cf-success)]"
                      : "border border-[var(--cf-text-muted)]/40"
                    : up
                      ? "bg-[var(--cf-success)]"
                      : "border border-[var(--cf-text-muted)]/40"
                }`}
              />

              <Pill tone={up || (forward.auto && hasSession) ? "accent" : "muted"}>
                {forward.kind === "local" ? "-L" : forward.kind === "remote" ? "-R" : "-D"}
              </Pill>

              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                {describeForward({ ...forward, listen_port: port })}
              </span>

              {forward.auto ? (
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
                  {hasSession ? t("remote.withSession") : t("remote.withSessionIdle")}
                </span>
              ) : up ? (
                <button
                  type="button"
                  onClick={() => void stopForward(forward.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
                >
                  <CircleStop size={12} />
                  {t("remote.stop")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startForward(tab.hostId, forward)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                >
                  <Play size={12} />
                  {t("remote.start")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="flex items-center gap-1.5 px-1 pt-3 text-[11px] text-[var(--cf-text-muted)]">
        <Settings2 size={12} />
        {t("remote.forwardsEditHint")}
      </p>
    </div>
  );
}
