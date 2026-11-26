import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { IconButton } from "../ui/Button";
import { Card, Divider, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import { TwoTap } from "./FlowsScreen";

/**
 * Containers, from a phone: what is up on the machine, its log, and start / stop / restart.
 *
 * The question this answers is the one Services answers one layer up — is what I left running
 * still running — for the things that run in an engine rather than in a terminal: the database the
 * API needs, the queue, the mail catcher. And the one thing worth doing about the answer from a
 * pocket is restarting what fell over.
 *
 * Everything else the desk's Containers app does — images, volumes, shells, files, building,
 * removing, Kubernetes — is arranging a machine, and stays there. The desktop sends no command
 * line and no labels for a container (`remotectl/apps.rs`), so nothing here can show one.
 *
 * # No frames, so no pretending
 *
 * An engine tells nobody when a container exits, so unlike every other list in this client this one
 * is not kept live by the socket. It is read when the view opens, after each action, and when the
 * refresh button is pressed — and it says when it was read, rather than looking live and being
 * minutes old.
 */

interface EngineRow {
  id: string;
  provider: string;
  running: boolean;
  problem: string;
}

interface ContainerRow {
  runtime: string;
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string;
  ports: string[];
  project: string;
  service: string;
}

interface Listing {
  engines: EngineRow[];
  containers: ContainerRow[];
}

function stateTone(row: ContainerRow): "success" | "danger" | "warning" | "neutral" {
  if (row.state === "running") return row.health === "unhealthy" ? "danger" : "success";
  if (row.state === "paused" || row.state === "restarting") return "warning";
  // Stopped with a failure is the one a person is looking for; stopped cleanly is just stopped.
  if (/exited \((?!0\))/i.test(row.status) || row.state === "dead") return "danger";
  return "neutral";
}

function ContainerLine({ row, onAct, busy, readOnly }: { row: ContainerRow; onAct: (row: ContainerRow, action: string) => void; busy: boolean; readOnly: boolean }) {
  const push = useNav((s) => s.push);
  const up = row.state === "running" || row.state === "restarting" || row.state === "paused";
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <button
        type="button"
        onClick={() => {
          navigated();
          push({ k: "containerLogs", runtime: row.runtime, id: row.id, name: row.name });
        }}
        className="cf-press min-w-0 flex-1 text-left"
        aria-label={t("containers.logsOf", { name: row.name })}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-md">{row.service || row.name}</span>
          <Badge tone={stateTone(row)}>{row.state}</Badge>
        </span>
        <span className="mt-0.5 block truncate text-xs text-[var(--cf-text-muted)]">
          {[row.status, row.ports.join(" "), row.image].filter(Boolean).join(" · ")}
        </span>
      </button>
      {up ? (
        <>
          <IconButton icon={<RotateCcw size={16} />} label={t("containers.restart")} disabled={busy || readOnly} onClick={() => onAct(row, "restart")} />
          {/* Two taps, like stopping a service: it takes something down that other things may be
              leaning on — the database under the API — and a pocket is a poor place to mean it. */}
          <TwoTap
            label={t("containers.stop")}
            confirmLabel={t("containers.stopConfirm")}
            icon={<Square size={15} />}
            danger
            disabled={busy || readOnly}
            onConfirm={() => onAct(row, "stop")}
          />
        </>
      ) : (
        <IconButton icon={<Play size={16} />} label={t("containers.start")} tone="accent" disabled={busy || readOnly} onClick={() => onAct(row, "start")} />
      )}
    </div>
  );
}

/** The Agents tab's containers view. */
export function ContainersView() {
  const run = useMobileStore((s) => s.run);
  const readOnly = useMobileStore((s) => s.readOnly);
  const busy = useBusy("containers");
  const [listing, setListing] = useState<Listing | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [reading, setReading] = useState(false);

  const load = useCallback(async () => {
    setReading(true);
    try {
      setListing(await rpc<Listing>("containers_phone_list"));
      setReadAt(new Date());
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState((current) => (current === "ready" ? "ready" : "error"));
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = (row: ContainerRow, action: string) =>
    void run(
      async () => {
        await rpc("containers_phone_act", { runtime: row.runtime, id: row.id, action });
        await load();
      },
      "containers",
      t(action === "start" ? "toast.containerStarted" : action === "stop" ? "toast.containerStopped" : "toast.containerRestarted"),
    );

  if (state === "loading") {
    return (
      <Section>
        <SkeletonList rows={3} />
      </Section>
    );
  }
  if (state === "error" || !listing) {
    return <ErrorState title={t("containers.failed")} detail={failure} onRetry={() => void load()} />;
  }
  if (listing.engines.length === 0) {
    return <EmptyState icon={<Box size={26} aria-hidden />} title={t("containers.noEngine")} hint={t("containers.noEngineHint")} />;
  }

  // By Compose project, the way they were brought up together; the ones made by hand last.
  const groups = new Map<string, ContainerRow[]>();
  for (const row of listing.containers) {
    const key = row.project || "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const stopped = listing.engines.filter((engine) => !engine.running || engine.problem);

  return (
    <>
      <Section
        action={
          <span className="flex items-center gap-1 text-xs text-[var(--cf-text-muted)]">
            {readAt && t("containers.readAt", { time: readAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })}
            <IconButton
              icon={<RefreshCw size={15} className={reading ? "animate-spin" : ""} />}
              label={t("common.refresh")}
              disabled={reading}
              onClick={() => void load()}
            />
          </span>
        }
      >
        {stopped.map((engine) => (
          <p key={engine.id} className="mb-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 text-xs text-[var(--cf-text-muted)]">
            {engine.running
              ? `${engine.provider || engine.id}: ${engine.problem}`
              : t("containers.engineDown", { name: engine.provider || engine.id })}
          </p>
        ))}
        {listing.containers.length === 0 && stopped.length < listing.engines.length && (
          <EmptyState icon={<Box size={26} aria-hidden />} title={t("containers.none")} />
        )}
      </Section>

      {ordered.map(([project, rows]) => (
        <Section key={project || "-"} title={project || t("containers.loose")}>
          <Card>
            {rows.map((row, index) => (
              <div key={`${row.runtime}:${row.id}`}>
                {index > 0 && <Divider />}
                <ContainerLine row={row} onAct={act} busy={busy} readOnly={readOnly} />
              </div>
            ))}
          </Card>
        </Section>
      ))}
    </>
  );
}

/**
 * The tail of one container's log.
 *
 * The last two hundred lines, read once and again on request — not followed. Following is a stream
 * of every line a busy container prints, to a phone that is mostly in a pocket; the tail is what
 * answers "why did it stop", which is the question the screen is opened for.
 */
export function ContainerLogsScreen({ runtime, id, name }: { runtime: string; id: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const end = useRef<HTMLSpanElement>(null);

  const load = useCallback(async () => {
    setReading(true);
    try {
      setText(await rpc<string>("containers_phone_logs", { runtime, id, lines: 200 }));
      setFailure(null);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }, [runtime, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // To the newest line, which is the one that says what happened last.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [text]);

  return (
    <Screen
      bare
      onRefresh={() => load()}
      bar={
        <PushBar
          title={name}
          subtitle={t("containers.logs")}
          actions={
            <IconButton
              icon={<RefreshCw size={16} className={reading ? "animate-spin" : ""} />}
              label={t("common.refresh")}
              disabled={reading}
              onClick={() => void load()}
            />
          }
        />
      }
    >
      {text === null && failure ? (
        <ErrorState title={t("containers.logsFailed")} detail={failure} onRetry={() => void load()} />
      ) : text === null ? (
        <div className="px-3 pt-3">
          <SkeletonList rows={5} />
        </div>
      ) : text.trim() === "" ? (
        <p className="px-6 pt-10 text-center text-base text-[var(--cf-text-muted)]">{t("containers.logsEmpty")}</p>
      ) : (
        <pre className="cf-log cf-selectable whitespace-pre-wrap break-words px-3 py-3 text-[var(--cf-text)]">
          {text}
          <span ref={end} />
        </pre>
      )}
    </Screen>
  );
}
