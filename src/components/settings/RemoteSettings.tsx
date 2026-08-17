import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, ShieldX, Smartphone, TerminalSquare, Trash2, X } from "lucide-react";
import qrcode from "qrcode-generator";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { usePlatform } from "../../lib/platform";
import { Checkbox } from "../common/Checkbox";
import { Actions, Group, Note, Panel, SettingsHeader, Status, Tag } from "../api/settingsChrome";
import {
  closeTerminal,
  remotectlCancelPairing,
  remotectlForgetAllRevoked,
  remotectlForgetDevice,
  remotectlListDevices,
  remotectlListTerminals,
  remotectlRevokeAll,
  remotectlRevokeDevice,
  remotectlSetAllowTerminal,
  remotectlSetEnabled,
  remotectlSetPort,
  remotectlStartPairing,
  remotectlStatus,
} from "../../lib/tauri/commands";
import type { RemoteDevice, RemoteStatus, RemoteTerminal } from "../../types/domain";

/**
 * The address, as something you can point a camera at.
 *
 * Drawn as an SVG of `<rect>` per dark module rather than through the library's own `createSvgTag`,
 * which emits a table of `<td>`s sized in ems and cannot be given a quiet zone or a radius.
 *
 * **Black on an explicit white card, and deliberately not the app's theme tokens** — the one thing
 * on this screen that ignores dark mode. A camera is the reader here, not a person: scanners key on
 * a dark-on-light grid with a light margin around it, and a QR painted in `--cf-text` on
 * `--cf-surface` is a mid-grey on a near-black that phones refuse at anything but point-blank. The
 * card is what keeps it scannable in both themes; it reads as a printed label sitting on the panel,
 * which is what it is.
 *
 * Error correction `M` rather than `L`: the extra redundancy costs a slightly denser grid and buys
 * tolerance for a phone camera at an angle across a desk, which is exactly how this gets used.
 */
function AddressQr({ url }: { url: string }) {
  const modules = useMemo(() => {
    // Type 0 is "pick the smallest version that fits". A LAN URL is ~25 characters, so this lands
    // on a small grid with large modules — the easiest kind to scan.
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();
    const cells: { x: number; y: number }[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) cells.push({ x: col, y: row });
      }
    }
    return { count, cells };
  }, [url]);

  // Four modules of quiet zone on every side — the spec's minimum, and the thing most hand-rolled
  // QR renderers leave out. Without it a scanner cannot find the finder patterns at all.
  const margin = 4;
  const size = modules.count + margin * 2;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-40 w-40 shrink-0 rounded-lg"
      role="img"
      aria-label={url}
    >
      <rect width={size} height={size} fill="#ffffff" />
      {modules.cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x + margin}
          y={cell.y + margin}
          width={1}
          height={1}
          fill="#000000"
        />
      ))}
    </svg>
  );
}

/** A timestamp as something a person reads, falling back to the raw value rather than to nothing. */
function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function RemoteSettings() {
  const t = useT();
  const platform = usePlatform();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [terminals, setTerminals] = useState<RemoteTerminal[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held separately from `status.port` so typing "8" on the way to "8080" does not immediately try
  // to bind port 8. Committed on blur and on Enter.
  const [portDraft, setPortDraft] = useState("");

  const reload = useCallback(async () => {
    const [next, list, shells] = await Promise.all([
      remotectlStatus().catch(() => null),
      remotectlListDevices().catch(() => [] as RemoteDevice[]),
      remotectlListTerminals().catch(() => [] as RemoteTerminal[]),
    ]);
    if (next) {
      setStatus(next);
      setPortDraft(String(next.port));
      // The backend is the authority on whether a code is still live — it expires on its own after
      // three minutes and dies after five wrong guesses, neither of which this screen would
      // otherwise notice. Clearing on `!next.pairing` is what stops a dead code staying on display.
      if (!next.pairing) setCode(null);
    }
    setDevices(list);
    setTerminals(shells);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Polled whenever this section is open, not only while a pairing code is up.
  //
  // The pairing window is the thing with a deadline, so it gets the tighter interval. But gating
  // the poll on it entirely meant the device list froze the moment the code was redeemed: a phone
  // could pair, connect and start driving the machine, and this panel — the one screen whose job
  // is to say who has access — went on showing whatever it had read when it mounted. "Visto por
  // última vez" would sit at the pairing timestamp indefinitely, which reads as a device that
  // connected once and went away.
  useEffect(() => {
    const id = setInterval(() => void reload(), code ? 10_000 : 20_000);
    return () => clearInterval(id);
  }, [code, reload]);

  // A code outstanding when the user walks away from this section is a credential nobody is
  // watching. Closing it on unmount matches what the panel shows: no code visible, no code valid.
  useEffect(() => {
    return () => {
      void remotectlCancelPairing().catch(() => {});
    };
  }, []);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) =>
    guard(async () => {
      const next = await remotectlSetEnabled(enabled);
      setStatus(next);
      if (!enabled) setCode(null);
    });

  const commitPort = () =>
    guard(async () => {
      const port = Number(portDraft);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        setPortDraft(String(status?.port ?? 8787));
        return;
      }
      if (port === status?.port) return;
      setStatus(await remotectlSetPort(port));
    });

  const startPairing = () =>
    guard(async () => {
      setCode(await remotectlStartPairing());
      setStatus(await remotectlStatus());
    });

  const cancelPairing = () =>
    guard(async () => {
      await remotectlCancelPairing();
      setCode(null);
    });

  const live = status?.running ?? false;
  const active = devices.filter((d) => !d.revoked);

  // The device's own name when this panel still knows it, and the raw id when it does not — a
  // session whose device was forgotten is still a real process on this machine, and calling it
  // "unknown" would hide which of two phones left it running.
  const ownerLabel = (owner: string | null) => devices.find((d) => d.id === owner)?.name ?? owner ?? "";

  return (
    // The frame every other settings section wears: a plain `<section>` filling the pane it is
    // given, and the shared header on top of it. This used to be a 640px column centred with
    // `mx-auto` inside a ~950px pane, which is the one shape the settings column deliberately does
    // not have — see the note in `SettingsView` on why the per-section caps were removed. Arriving
    // here from Backup or Git moved every control several centimetres sideways, which reads as the
    // window resettling rather than as a different page of the same window.
    <section>
      {/* The badge again on the heading, not only in the nav. The nav row is easy to arrive past —
          from the command palette, from a deep link, from a tooltip in another screen — and this is
          the one place every route into the section goes through. `aside` is the header's slot for
          a mark belonging to the whole section, which is exactly what this is. */}
      <SettingsHeader
        title={t("remote.title")}
        hint={t("remote.subtitle")}
        aside={<Tag tone="warning">{t("settings.alpha")}</Tag>}
      />

      {/* Above the panel rather than inside it: it is about the section, not about any group in
          it. `warning` rather than the section's own amber paragraph — this is the tone the app
          keeps for "this can cost you something", and opening a port on the machine qualifies. */}
      <Note tone="warning">{t("remote.alphaNote")}</Note>

      {/* One panel of groups, the same surface the AI, backup and integrations sections are built
          from. It replaced five separately bordered cards stacked down the column — a shape used
          nowhere else in settings, and one that turned a section of five short blocks into five
          boxes to parse. */}
      <Panel>
        <Group title={t("remote.groupServer")}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={status?.enabled ?? false}
              onChange={(next) => void toggle(next)}
              disabled={busy || !status}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[13px] text-[var(--cf-text)]">
                {t("remote.enable")}
                {/* The shared dot-and-a-word, not a pill of its own: "running" has to mean the
                    same thing here as it does in the API and collaboration panels. */}
                <Status tone={live ? "success" : "muted"}>
                  {live ? t("remote.running") : t("remote.stopped")}
                </Status>
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("remote.enableHint")}
              </span>
            </span>
          </label>

          {/* The step that has no equivalent on macOS or Linux, and the one that makes this feature
              look broken when it is skipped: binding `0.0.0.0` raises a Defender Firewall prompt,
              and a dismissed prompt leaves a server that is genuinely listening and genuinely
              unreachable. Said before the address rather than after, because by the time somebody is
              typing a URL into a phone they have already formed the wrong theory about why. */}
          {platform === "windows" && (
            <div className="mt-2.5">
              <Note>{t("remote.firewallWindows")}</Note>
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[13px] text-[var(--cf-text)]">{t("remote.port")}</span>
            <input
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
              onBlur={() => void commitPort()}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={busy}
              inputMode="numeric"
              className="w-20 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] tabular-nums outline-none focus:border-[var(--cf-accent)]"
            />
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("remote.portHint")}
            </span>
          </div>

          {/* The one disagreement worth surfacing: the setting says on, nothing is bound. */}
          {status?.enabled && !live && (
            <div className="mt-2">
              <Note tone="warning">{t("remote.enabledButNotRunning")}</Note>
            </div>
          )}
        </Group>

        {live && (
          <Group title={t("remote.groupPairing")}>
            <p className="mb-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("remote.openOnPhone")}
            </p>
            {status?.url ? (
              <div className="flex items-start gap-3">
                <AddressQr url={status.url} />
                <div className="min-w-0 flex-1">
                  {/* `inline-block`, so the box is the width of the address rather than of the
                      pane: a 25-character LAN URL stretched across a full-width panel reads as an
                      empty field somebody forgot to fill in. */}
                  <code className="inline-block max-w-full break-all rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text)]">
                    {status.url}
                  </code>
                  <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {t("remote.scanHint")}
                  </p>

                  {code ? (
                    <div className="mt-3">
                      <p className="text-[11px] text-[var(--cf-text-muted)]">{t("remote.pairCodeLabel")}</p>
                      <p className="mt-0.5 font-mono text-[26px] font-semibold tracking-[0.18em] text-[var(--cf-accent)]">
                        {code}
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                        {t("remote.pairCodeHint")}
                      </p>
                      <button
                        type="button"
                        onClick={() => void cancelPairing()}
                        disabled={busy}
                        className="mt-2 text-[11.5px] text-[var(--cf-text-muted)] hover:underline"
                      >
                        {t("remote.pairCancel")}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-3">
                      <Actions>
                        <button
                          type="button"
                          onClick={() => void startPairing()}
                          disabled={busy}
                          className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] disabled:opacity-40"
                        >
                          <Smartphone size={13} />
                          {active.length ? t("remote.pairAgain") : t("remote.pair")}
                        </button>
                      </Actions>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                {t("remote.noAddress")}
              </p>
            )}
          </Group>
        )}

        <Group title={t("remote.devices")}>
          {devices.length === 0 ? (
            <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("remote.devicesEmpty")}
            </p>
          ) : (
            <>
              {/* Ruled rows rather than a stack of individually bordered ones — the same list shape
                  the backup section's contents use, and the reason a list of three devices no
                  longer looks like three separate settings. */}
              <ul className="divide-y divide-[var(--cf-border)] border-y border-[var(--cf-border)]">
                {devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-2 py-2">
                    <Smartphone
                      size={14}
                      className={device.revoked ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-accent)]"}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[13px] ${
                          device.revoked
                            ? "text-[var(--cf-text-muted)] line-through"
                            : "text-[var(--cf-text)]"
                        }`}
                      >
                        {device.name}
                      </span>
                      {/* "Conectado ahora" outranks any timestamp, and it is the line this panel
                          was missing: a phone with an open socket writes `last_seen_at` once, at
                          the moment it connected, so this row used to say "visto a las 13:04" about
                          a device that was driving the machine as you read it. The shared dot, so
                          "connected" looks the same here as running does above. */}
                      {device.connected ? (
                        <Status tone="success">{t("remote.connected")}</Status>
                      ) : (
                        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                          {device.revoked
                            ? t("remote.revoked")
                            : device.last_seen_at
                              ? t("remote.lastSeen", { when: whenLabel(device.last_seen_at) })
                              : t("remote.neverSeen")}
                        </span>
                      )}
                    </span>
                    {/* A live device gets a cut-off button; a revoked one gets a remove-from-list
                        button. The same slot, because a row only ever has one next step. */}
                    {device.revoked ? (
                      <button
                        type="button"
                        title={t("remote.forget")}
                        onClick={() =>
                          void guard(async () => {
                            setDevices(await remotectlForgetDevice(device.id));
                          })
                        }
                        disabled={busy}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                      >
                        <X size={13} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        title={t("remote.revoke")}
                        onClick={() =>
                          void guard(async () => {
                            setDevices(await remotectlRevokeDevice(device.id));
                          })
                        }
                        disabled={busy}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {/* Under the list rather than beside the heading, which a `Group` has no slot for —
                  and it is the better place anyway: both act on everything above them. Clearing
                  revoked rows and revoking live ones stay different verbs and different hovers,
                  because one tidies a list and the other cuts somebody off. */}
              <div className="mt-2">
                <Actions>
                  {devices.some((device) => device.revoked) && (
                    <button
                      type="button"
                      onClick={() =>
                        void guard(async () => {
                          setDevices(await remotectlForgetAllRevoked());
                        })
                      }
                      disabled={busy}
                      className="text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-40"
                    >
                      {t("remote.forgetAllRevoked")}
                    </button>
                  )}
                  {active.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        void guard(async () => {
                          setDevices(await remotectlRevokeAll());
                        })
                      }
                      disabled={busy}
                      className="text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-40"
                    >
                      {t("remote.revokeAll")}
                    </button>
                  )}
                </Actions>
              </div>
            </>
          )}
        </Group>

        {/* Its own group rather than a row inside the server's, because it is its own decision and
            the layout should say so. Shown even when the server is off so it can be set ahead of
            time, and so its state is never a surprise discovered later. The amber border this used
            to grow when switched on is gone with the card it was drawn on; the warning below says
            the same thing in the tone the rest of the app says warnings in. */}
        <Group title={t("remote.groupTerminal")}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={status?.allow_terminal ?? false}
              onChange={(next) =>
                void guard(async () => {
                  setStatus(await remotectlSetAllowTerminal(next));
                })
              }
              disabled={busy || !status}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13px] text-[var(--cf-text)]">
                <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                {t("remote.terminal")}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("remote.terminalHint")}
              </span>
            </span>
          </label>
          {status?.allow_terminal && (
            <div className="mt-2">
              <Note tone="warning">{t("remote.terminalOnWarning")}</Note>
            </div>
          )}

          {/* What is actually running, under the switch that permits it.

              Shown whenever there is something to show, even with the switch since turned off — a
              session that outlived the grant is exactly the one worth seeing, and hiding it behind
              the flag would mean the only case with no other trace anywhere is the one case this
              list refuses to draw. (It cannot normally happen: withdrawing the grant reaps them.
              A stale poll can still catch one mid-flight.) */}
          {(status?.allow_terminal || terminals.length > 0) && (
            <div className="mt-3">
              <p className="text-[11.5px] font-medium text-[var(--cf-text)]">
                {t("remote.liveTerminals")}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("remote.liveTerminalsHint")}
              </p>
              {terminals.length === 0 ? (
                <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                  {t("remote.liveTerminalsNone")}
                </p>
              ) : (
                <ul className="mt-1.5 divide-y divide-[var(--cf-border)] border-y border-[var(--cf-border)]">
                  {terminals.map((shell) => (
                    <li key={shell.id} className="flex items-center gap-2 py-2">
                      <TerminalSquare size={14} className="shrink-0 text-[var(--cf-accent)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-[var(--cf-text)]">
                          {ownerLabel(shell.owner)}
                        </span>
                        {/* The shell and where it is. Joined rather than templated because a
                            session opened with no directory has none to name, and " · " with
                            nothing after it reads as a value that failed to load. */}
                        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                          {[shell.profile, shell.cwd].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <button
                        type="button"
                        title={t("remote.killTerminal")}
                        onClick={() =>
                          void guard(async () => {
                            await closeTerminal(shell.id);
                            await reload();
                          })
                        }
                        disabled={busy}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Group>

        {/* What this actually grants, spelled out rather than left to the reader's imagination. The
            user is about to open a port on their machine, and "what can somebody with this token
            do" is the only question that matters — answering it vaguely is how a feature like this
            gets turned on by someone who would not have, had they known. */}
        <Group title={t("remote.groupAccess")}>
          <p className="mb-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("remote.safety")}
          </p>
          <p className="flex gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <ShieldCheck size={13} className="mt-px shrink-0 text-[var(--cf-success)]" />
            <span>{t("remote.safetyAllowed")}</span>
          </p>
          <p className="mt-1.5 flex gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <ShieldX size={13} className="mt-px shrink-0 text-[var(--cf-danger)]" />
            <span>{t("remote.safetyDenied")}</span>
          </p>
        </Group>
      </Panel>
    </section>
  );
}
