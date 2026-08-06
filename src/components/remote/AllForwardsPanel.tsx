import { useMemo } from "react";
import { CircleStop, Play, Waypoints } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { OsGlyph, Pill } from "./remoteChrome";
import { useRemoteStore } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import {
  describeForward,
  parseHostSpec,
  type ForwardSpec,
  type RemoteHostRow,
} from "../../types/remote";

/**
 * Every forward in the workspace, live or merely saved, across every host.
 *
 * The per-host panel answers "what does this machine have"; this answers **"what is listening on my
 * laptop right now"**, which is a question about the machine you are sitting at, not about any host.
 * It is the one you actually ask — usually as "why is 5432 busy" — and answering it by opening each
 * host's tab in turn is the wrong shape entirely.
 *
 * Ordered live-first for the same reason: a forward that is up is a fact about the present, and one
 * that is merely saved is a plan.
 */
export function AllForwardsPanel() {
  const hosts = useRemoteStore((s) => s.hosts);
  const active = useRemoteStore((s) => s.forwards);
  const startForward = useRemoteStore((s) => s.startForward);
  const stopForward = useRemoteStore((s) => s.stopForward);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const t = useT();

  /** Every saved forward, paired with the host that owns it. */
  const saved = useMemo(() => {
    const rows: { host: RemoteHostRow; forward: ForwardSpec }[] = [];
    for (const host of hosts) {
      for (const forward of parseHostSpec(host).forwards) rows.push({ host, forward });
    }
    return rows;
  }, [hosts]);

  // A forward can be live without being saved on any host we can still see — its host was deleted
  // while it ran, or it belongs to a row that changed underneath it. Listing it anyway is the
  // point: a listening port with nothing naming it is precisely what this panel is for.
  const orphans = active.filter(
    (entry) => !saved.some(({ forward }) => forward.id === entry.id),
  );

  const rows = [
    ...saved.map(({ host, forward }) => ({
      key: forward.id,
      host,
      forward,
      live: active.find((entry) => entry.id === forward.id) ?? null,
    })),
    ...orphans.map((entry) => ({
      key: entry.id,
      host: hosts.find((host) => host.id === entry.host_id) ?? null,
      forward: null,
      live: entry,
    })),
  ].sort((a, b) => Number(!!b.live) - Number(!!a.live));

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        title={t("remote.noForwardsAnywhere")}
        subtitle={t("remote.noForwardsAnywhereHint")}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-1.5">
        {rows.map(({ key, host, forward, live }, at) => {
          const auto = forward?.auto ?? false;
          const port = live?.listen_port ?? forward?.listen_port ?? 0;
          const kind = live?.kind ?? forward?.kind ?? "local";
          const spec = host ? parseHostSpec(host) : null;

          return (
            <div
              key={key}
              style={riseDelay(at)}
              className="cf-rise flex items-center gap-2.5 rounded-md border border-[var(--cf-border)] px-3 py-2"
            >
              <span
                aria-hidden
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                  live ? "bg-[var(--cf-success)]" : "border border-[var(--cf-text-muted)]/40"
                }`}
              />
              <Pill tone={live ? "accent" : "muted"}>
                {kind === "local" ? "-L" : kind === "remote" ? "-R" : "-D"}
              </Pill>

              <button
                type="button"
                onClick={() => host && openDetails(host.id)}
                disabled={!host}
                className="flex w-[140px] shrink-0 items-center gap-1.5 text-left disabled:cursor-default"
              >
                {spec && <OsGlyph os={spec.os} size={12} />}
                <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">
                  {host?.name ?? t("remote.hostGone")}
                </span>
              </button>

              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text-muted)]">
                {describeForward(
                  forward
                    ? { ...forward, listen_port: port }
                    : { ...live!, listen_port: port },
                )}
              </span>

              {auto ? (
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
                  {live ? t("remote.withSession") : t("remote.withSessionIdle")}
                </span>
              ) : live ? (
                <button
                  type="button"
                  onClick={() => void stopForward(live.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
                >
                  <CircleStop size={12} />
                  {t("remote.stop")}
                </button>
              ) : (
                forward &&
                host && (
                  <button
                    type="button"
                    onClick={() => void startForward(host.id, forward)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                  >
                    <Play size={12} />
                    {t("remote.start")}
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
