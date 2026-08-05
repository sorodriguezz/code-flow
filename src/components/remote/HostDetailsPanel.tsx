import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Monitor, Plus, Server, Terminal, Trash2, Waypoints, X } from "lucide-react";
import { Field, Row } from "../api/ApiModal";
import { ResizeHandle } from "../common/ResizeHandle";
import { ForwardDiagram } from "./ForwardDiagram";
import { Select } from "../common/Select";
import { Checkbox } from "../common/Checkbox";
import { CARD, OsGlyph, Pill } from "./remoteChrome";
import { useRemoteStore } from "../../state/remoteStore";
import { useLayoutStore } from "../../state/layoutStore";
import { remoteGetPassword, remoteListKeys, remoteSetPassword } from "../../lib/tauri/remoteCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  DEFAULT_SSH_PORT,
  SCREEN_DEFAULT_PORT,
  describeForward,
  hasAddress,
  parseHostSpec,
  type ForwardKind,
  type ForwardSpec,
  type RemoteAuth,
  type RemoteHostRow,
  type RemoteHostSpec,
  type RemoteOs,
  type ScreenProtocol,
  type SshKey,
} from "../../types/remote";

type Tab = "connection" | "forwards" | "screen" | "advanced";

/**
 * The host editor, as a persistent right-hand panel.
 *
 * **Why a drawer and not a modal.** A modal is a question with an answer: you open it, decide, and
 * it goes away. Host settings are not that — you fill in an address, connect, watch it fail, change
 * the port, connect again. A modal makes every one of those a round trip through open/save/close,
 * and it covers the tree you are comparing against. The panel stays, the session stays visible
 * beside it, and Connect sits at the bottom where the loop closes.
 *
 * **Which means it has to save itself.** A persistent panel has no "OK" moment, so an explicit Save
 * would eventually be the thing someone forgets before clicking another host. Edits are written
 * after a short pause, and any pending write is flushed the instant the panel switches host or
 * closes — see `flush`.
 *
 * Four tabs, split by what a host *is* rather than by how many fields fit: Connection is the `ssh`
 * destination, Forwards is what rides on it, Screen is a different endpoint that happens to live on
 * the same machine, and Advanced is the escape hatch for everything this form doesn't model.
 *
 * **Almost every field may be left empty, and that is the design.** An empty user, port or key is
 * not a missing value — it is a deliberate deferral to `~/.ssh/config`, which `ssh` reads and this
 * app does not. A form that helpfully filled in `22` and the local username would silently override
 * a working config, so the placeholders say what will happen instead.
 */
const SAVE_DEBOUNCE_MS = 600;
/** Longer: every write here is an OS keychain call, and on an ad-hoc-signed build possibly a
 *  prompt. Typing a password should cost one write, not one per character. */
const PASSWORD_DEBOUNCE_MS = 1500;

const WIDTH_MIN = 280;
const WIDTH_MAX = 560;

export function HostDetailsPanel() {
  const hostId = useRemoteStore((s) => s.detailsHostId);
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === hostId) ?? null);
  const saveHost = useRemoteStore((s) => s.saveHost);
  const closeDetails = useRemoteStore((s) => s.closeDetails);
  const openSession = useRemoteStore((s) => s.openSession);
  const width = useLayoutStore((s) => s.sizes.remoteDetailsWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  const [tab, setTab] = useState<Tab>("connection");
  const [spec, setSpec] = useState<RemoteHostSpec | null>(null);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [color, setColor] = useState("");
  const [password, setPassword] = useState("");
  const [passwordLoaded, setPasswordLoaded] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  /** What a flush would write. A ref so the flush on unmount sees the last edit rather than the
   *  values captured when the effect was set up. */
  const latest = useRef<{ row: RemoteHostRow; spec: RemoteHostSpec } | null>(null);
  const dirty = useRef(false);
  const passwordDirty = useRef(false);

  const flush = () => {
    const pending = latest.current;
    if (dirty.current && pending) {
      dirty.current = false;
      void saveHost(pending.row, pending.spec);
    }
    if (passwordDirty.current && pending) {
      passwordDirty.current = false;
      void remoteSetPassword(pending.row.id, passwordRef.current).catch((error) =>
        pushErrorToast(String(error)),
      );
    }
  };
  const passwordRef = useRef("");
  passwordRef.current = password;

  // Switching host: write out whatever the last one had pending *before* adopting the new one, or
  // the edit would be lost to a debounce that never fired.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (!host || loadedId.current === host.id) return;
    if (loadedId.current !== null) flush();
    loadedId.current = host.id;
    dirty.current = false;
    passwordDirty.current = false;
    setSpec(parseHostSpec(host));
    setName(host.name);
    setGroup(host.group_name);
    setColor(host.color);
    setPassword("");
    setPasswordLoaded(false);
    setTab("connection");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id]);

  // Flush on the way out — closing the panel is the other way an edit can be left in the air.
  useEffect(() => () => flush(), []);

  // The stored credential is read once, on open, rather than with the row: it is a keychain hit
  // (and on an ad-hoc-signed build, possibly an OS prompt), and paying that to render a tree of
  // twenty hosts would be twenty prompts for a value nineteen of them don't show.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void remoteGetPassword(host.id)
      .then((value) => {
        if (!cancelled) {
          setPassword(value ?? "");
          setPasswordLoaded(true);
        }
      })
      .catch(() => setPasswordLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [host?.id]);

  const row: RemoteHostRow | null = host
    ? { ...host, name: name.trim() || host.name, group_name: group.trim(), color }
    : null;
  if (row && spec) latest.current = { row, spec };

  useEffect(() => {
    if (!dirty.current || !row || !spec) return;
    const timer = window.setTimeout(() => {
      dirty.current = false;
      void saveHost(row, spec);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, name, group, color]);

  useEffect(() => {
    if (!passwordDirty.current || !host) return;
    const timer = window.setTimeout(() => {
      passwordDirty.current = false;
      void remoteSetPassword(host.id, password).catch((error) => pushErrorToast(String(error)));
    }, PASSWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  if (!host || !spec) return null;

  const patch = (changes: Partial<RemoteHostSpec>) => {
    dirty.current = true;
    setSpec({ ...spec, ...changes });
  };
  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    dirty.current = true;
    setter(value);
  };

  const TABS: { id: Tab; label: string; icon: typeof Server }[] = [
    { id: "connection", label: t("remote.tabConnection"), icon: Server },
    { id: "forwards", label: t("remote.tabForwards"), icon: Waypoints },
    { id: "screen", label: t("remote.tabScreen"), icon: Monitor },
    { id: "advanced", label: t("remote.tabAdvanced"), icon: Terminal },
  ];

  return (
    <>
      {/* `invert`, because the handle sits to the *left* of what it resizes — dragging toward the
          panel has to grow it, not shrink it. */}
      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        invert
        onChange={(value) => setSize("remoteDetailsWidth", value)}
        onCommit={(value) => void commitSize("remoteDetailsWidth", value)}
      />
      <div
        style={{ width }}
        className={`flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] ${CARD}`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <OsGlyph os={spec.os} size={14} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--cf-text)]">
            {name || host.name}
          </span>
          <button
            type="button"
            onClick={closeDetails}
            aria-label={t("common.close")}
            className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              title={label}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium transition-colors ${
                tab === id
                  ? "border-[var(--cf-accent)] text-[var(--cf-accent)]"
                  : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {tab === "connection" && (
            <ConnectionTab
              name={name}
              group={group}
              color={color}
              spec={spec}
              password={password}
              showPassword={showPassword}
              onName={edit(setName)}
              onGroup={edit(setGroup)}
              onColor={edit(setColor)}
              onPatch={patch}
              onPassword={(value) => {
                passwordDirty.current = true;
                setPassword(value);
              }}
              onToggleShowPassword={() => setShowPassword((value) => !value)}
            />
          )}
          {tab === "forwards" && <ForwardsTab spec={spec} onPatch={patch} />}
          {tab === "screen" && <ScreenTab spec={spec} onPatch={patch} />}
          {tab === "advanced" && <AdvancedTab spec={spec} onPatch={patch} />}
        </div>

        {/* Pinned, and the reason the panel beats the modal: the fill-in / connect / fix loop never
            leaves this column. */}
        <div className="shrink-0 border-t border-[var(--cf-border)] p-2">
          <button
            type="button"
            onClick={() => {
              flush();
              void openSession(host.id);
            }}
            disabled={!hasAddress(spec)}
            className="w-full rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:brightness-110 disabled:opacity-40"
          >
            {hasAddress(spec) ? t("remote.connect") : t("remote.needsAddress")}
          </button>
          {passwordLoaded && spec.auth === "password" && (
            <p className="pt-1.5 text-center text-[10px] text-[var(--cf-text-muted)]">
              {t("remote.authPasswordHint")}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function ConnectionTab({
  name,
  group,
  color,
  spec,
  password,
  showPassword,
  onName,
  onGroup,
  onColor,
  onPatch,
  onPassword,
  onToggleShowPassword,
}: {
  name: string;
  group: string;
  color: string;
  spec: RemoteHostSpec;
  password: string;
  showPassword: boolean;
  onName: (value: string) => void;
  onGroup: (value: string) => void;
  onColor: (value: string) => void;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
  onPassword: (value: string) => void;
  onToggleShowPassword: () => void;
}) {
  // Selected raw and derived with `useMemo`, never derived *inside* the selector. A zustand
  // selector runs on every store read and is compared by reference, so one that builds a fresh
  // array each time never equals the last — the component re-renders, which re-runs the selector,
  // which returns another new array. React calls that out as "getSnapshot should be cached" and
  // then kills it with "Maximum update depth exceeded".
  const hosts = useRemoteStore((s) => s.hosts);
  const groups = useMemo(
    () => [...new Set(hosts.map((host) => host.group_name.trim()).filter(Boolean))].sort(),
    [hosts],
  );
  const t = useT();

  const AUTH: { value: RemoteAuth; label: string; hint: string }[] = [
    { value: "agent", label: t("remote.authAgent"), hint: t("remote.authAgentHint") },
    { value: "key", label: t("remote.authKey"), hint: t("remote.authKeyHint") },
    { value: "password", label: t("remote.authPassword"), hint: t("remote.authPasswordHint") },
  ];

  const OS: { value: RemoteOs; label: string }[] = [
    { value: "linux", label: "Linux" },
    { value: "macos", label: "macOS" },
    { value: "windows", label: "Windows" },
    { value: "other", label: t("remote.osOther") },
  ];

  return (
    <div className="space-y-1">
      <Row label={t("remote.fieldName")}>
        <Field value={name} onChange={onName} />
      </Row>
      <Row label={t("remote.fieldGroup")} hint={t("remote.fieldGroupHint")}>
        <input
          value={group}
          list="remote-groups"
          onChange={(e) => onGroup(e.target.value)}
          className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
        <datalist id="remote-groups">
          {groups.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>
      </Row>

      <Row label={t("remote.fieldHost")} hint={t("remote.fieldHostHint")} wide>
        <Field value={spec.host} onChange={(host) => onPatch({ host })} mono placeholder="web-01.example.com" />
      </Row>
      <Row label={t("remote.fieldPort")}>
        <Field
          type="number"
          value={spec.port === 0 ? "" : String(spec.port)}
          onChange={(value) => onPatch({ port: Number(value) || 0 })}
          placeholder={String(DEFAULT_SSH_PORT)}
        />
      </Row>
      <Row label={t("remote.fieldUser")} hint={t("remote.fieldUserHint")}>
        <Field value={spec.user} onChange={(user) => onPatch({ user })} mono placeholder="—" />
      </Row>

      <Row label={t("remote.fieldAuth")} hint={AUTH.find((a) => a.value === spec.auth)?.hint}>
        <Select
          value={spec.auth}
          onChange={(value) => onPatch({ auth: value as RemoteAuth })}
          options={AUTH.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      {spec.auth === "key" && <KeyPicker spec={spec} onPatch={onPatch} />}

      {spec.auth === "password" && (
        <Row label={t("remote.fieldPassword")} hint={t("remote.fieldPasswordHint")} wide>
          <div className="flex w-full items-center gap-1">
            <Field
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={onPassword}
              mono
            />
            <button
              type="button"
              onClick={onToggleShowPassword}
              aria-label={showPassword ? t("remote.hide") : t("remote.show")}
              className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </Row>
      )}

      <Row label={t("remote.fieldJump")} hint={t("remote.fieldJumpHint")} wide>
        <Field value={spec.jump} onChange={(jump) => onPatch({ jump })} mono placeholder="bastion.example.com" />
      </Row>

      <label className="flex items-start gap-2 py-1">
        <Checkbox
          checked={spec.agent_forward}
          onChange={(agent_forward) => onPatch({ agent_forward })}
          className="mt-px"
        />
        <span className="min-w-0">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.fieldAgentForward")}</span>
          <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("remote.fieldAgentForwardHint")}
          </span>
        </span>
      </label>

      <Row label={t("remote.fieldTags")} hint={t("remote.fieldTagsHint")} wide>
        {/* Edited as text rather than as chips: a comma-separated line is faster to retype than a
            chip editor is to click through, and it is what the user would have written anyway. The
            chips are how tags are *read* — on the cards and in the filter row. */}
        <Field
          value={spec.tags.join(", ")}
          onChange={(value) =>
            onPatch({ tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) })
          }
          placeholder="postgres, prod"
        />
      </Row>

      <Row label={t("remote.fieldOs")} hint={t("remote.fieldOsHint")}>
        <Select
          value={spec.os}
          onChange={(value) => onPatch({ os: value as RemoteOs })}
          options={OS.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      <Row label={t("remote.fieldColor")} hint={t("remote.fieldColorHint")}>
        <div className="flex w-full items-center gap-1.5">
          <input
            type="color"
            value={color || "#6366f1"}
            onChange={(e) => onColor(e.target.value)}
            className="h-7 w-10 shrink-0 cursor-pointer rounded border border-[var(--cf-border)] bg-transparent"
          />
          {color && (
            <button
              type="button"
              onClick={() => onColor("")}
              className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {t("remote.clear")}
            </button>
          )}
        </div>
      </Row>
    </div>
  );
}

/**
 * The key field, as a list of the keys you actually have.
 *
 * Discovery, not a vault — see `remotes::keys` for why CodeFlow deliberately owns no key store. The
 * field stays free text underneath, because a key outside `~/.ssh` is legitimate and a picker that
 * couldn't express one would be a downgrade from typing the path.
 *
 * `in_agent` is the column worth reading: a key the agent already holds needs no `-i` at all, so
 * choosing it is usually unnecessary — and a key the agent *doesn't* hold is why a connection keeps
 * asking for a passphrase.
 */
function KeyPicker({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    void remoteListKeys()
      .then((found) => !cancelled && setKeys(found))
      .catch(() => !cancelled && setKeys([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // Only keys with a file can be passed to `-i`; an agent-only identity has nothing to name.
  const usable = (keys ?? []).filter((key) => key.path);

  return (
    <>
      <Row label={t("remote.fieldKeyFile")} wide>
        <Field
          value={spec.key_file}
          onChange={(key_file) => onPatch({ key_file })}
          mono
          placeholder="~/.ssh/id_ed25519"
        />
      </Row>
      {usable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 py-1 pl-1">
          <span className="text-[11px] text-[var(--cf-text-muted)]">{t("remote.keysFound")}</span>
          {usable.map((key) => (
            <button
              key={key.path}
              type="button"
              title={`${key.kind}${key.comment ? ` · ${key.comment}` : ""}`}
              onClick={() => onPatch({ key_file: key.path })}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[11px] transition-colors ${
                spec.key_file === key.path
                  ? "bg-[var(--cf-accent)] text-white"
                  : "bg-black/[0.05] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] dark:bg-white/[0.07]"
              }`}
            >
              {key.in_agent && (
                <span
                  aria-label={t("remote.keyInAgent")}
                  title={t("remote.keyInAgent")}
                  className="h-[5px] w-[5px] rounded-full bg-[var(--cf-success)]"
                />
              )}
              {key.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

function ForwardsTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const t = useT();

  const KINDS: { value: ForwardKind; label: string }[] = [
    { value: "local", label: t("remote.forwardLocal") },
    { value: "remote", label: t("remote.forwardRemote") },
    { value: "dynamic", label: t("remote.forwardDynamic") },
  ];

  const update = (id: string, changes: Partial<ForwardSpec>) =>
    onPatch({
      forwards: spec.forwards.map((forward) =>
        forward.id === id ? { ...forward, ...changes } : forward,
      ),
    });

  const add = () =>
    onPatch({
      forwards: [
        ...spec.forwards,
        {
          id: `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "local",
          listen_port: 0,
          target_host: "",
          target_port: 0,
          auto: false,
          label: "",
        },
      ],
    });

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.forwardsHelp")}
      </p>

      {spec.forwards.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
          {t("remote.noForwards")}
        </p>
      ) : (
        spec.forwards.map((forward) => (
          <div
            key={forward.id}
            className="space-y-2 rounded-md border border-[var(--cf-border)] p-2.5"
          >
            <div className="flex items-center gap-2">
              <div className="w-[150px] shrink-0">
                <Select
                  value={forward.kind}
                  onChange={(value) => update(forward.id, { kind: value as ForwardKind })}
                  options={KINDS.map(({ value, label }) => ({ value, label }))}
                />
              </div>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                {describeForward(forward)}
              </span>
              <button
                type="button"
                onClick={() =>
                  onPatch({ forwards: spec.forwards.filter((entry) => entry.id !== forward.id) })
                }
                aria-label={t("common.delete")}
                className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* Right under the chooser, because the direction is what is being chosen and no
                wording untangles local from remote — see `ForwardDiagram`. */}
            <ForwardDiagram kind={forward.kind} />

            <div className="grid grid-cols-[110px_1fr_110px] gap-2">
              <Field
                type="number"
                value={forward.listen_port === 0 ? "" : String(forward.listen_port)}
                onChange={(value) => update(forward.id, { listen_port: Number(value) || 0 })}
                placeholder={forward.kind === "remote" ? t("remote.required") : t("remote.autoPort")}
                mono
              />
              {forward.kind === "dynamic" ? (
                <span className="flex items-center text-[11px] text-[var(--cf-text-muted)]">
                  {t("remote.dynamicHint")}
                </span>
              ) : (
                <>
                  <Field
                    value={forward.target_host}
                    onChange={(target_host) => update(forward.id, { target_host })}
                    placeholder="localhost"
                    mono
                  />
                  <Field
                    type="number"
                    value={forward.target_port === 0 ? "" : String(forward.target_port)}
                    onChange={(value) => update(forward.id, { target_port: Number(value) || 0 })}
                    placeholder={t("remote.targetPort")}
                    mono
                  />
                </>
              )}
            </div>

            <label className="flex items-start gap-2">
              <Checkbox
                checked={forward.auto}
                onChange={(auto) => update(forward.id, { auto })}
                className="mt-px"
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--cf-text)]">
                  {t("remote.forwardAuto")}
                </span>
                <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                  {t("remote.forwardAutoHint")}
                </span>
              </span>
            </label>
          </div>
        ))
      )}

      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={13} />
        {t("remote.addForward")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function ScreenTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const t = useT();
  const screen = spec.screen;
  const patchScreen = (changes: Partial<RemoteHostSpec["screen"]>) =>
    onPatch({ screen: { ...screen, ...changes } });

  const PROTOCOLS: { value: ScreenProtocol; label: string }[] = [
    { value: "none", label: t("remote.screenNone") },
    { value: "vnc", label: "VNC" },
    { value: "rdp", label: "RDP" },
  ];

  const effectiveTarget = useMemo(() => {
    const host = screen.host.trim() || spec.host.trim() || "—";
    const port = screen.port || SCREEN_DEFAULT_PORT[screen.protocol];
    return `${host}:${port}`;
  }, [screen.host, screen.port, screen.protocol, spec.host]);

  return (
    <div className="space-y-1">
      <p className="pb-2 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.screenHelp")}
      </p>

      <Row label={t("remote.fieldProtocol")}>
        <Select
          value={screen.protocol}
          onChange={(value) => patchScreen({ protocol: value as ScreenProtocol })}
          options={PROTOCOLS.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      {screen.protocol !== "none" && (
        <>
          <Row label={t("remote.fieldScreenHost")} hint={t("remote.fieldScreenHostHint")} wide>
            <Field
              value={screen.host}
              onChange={(host) => patchScreen({ host })}
              mono
              placeholder={spec.host || "—"}
            />
          </Row>
          <Row label={t("remote.fieldScreenPort")}>
            <Field
              type="number"
              value={screen.port === 0 ? "" : String(screen.port)}
              onChange={(value) => patchScreen({ port: Number(value) || 0 })}
              placeholder={String(SCREEN_DEFAULT_PORT[screen.protocol])}
            />
          </Row>
          <Row label={t("remote.fieldScreenUser")}>
            <Field value={screen.user} onChange={(user) => patchScreen({ user })} mono placeholder="—" />
          </Row>

          <div className="my-2 rounded-md border border-[var(--cf-border)] p-2.5">
            <label className="flex items-center gap-2">
              <Checkbox checked={screen.tunnel} onChange={(tunnel) => patchScreen({ tunnel })} />
              <span className="text-[12px] text-[var(--cf-text)]">{t("remote.screenTunnel")}</span>
            </label>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.screenTunnelHint")}
            </p>
            {screen.tunnel && (
              <p className="mt-1.5 flex items-center gap-1.5 pl-6 font-mono text-[11px] text-[var(--cf-text-muted)]">
                <Pill tone="accent">ssh -L</Pill>
                127.0.0.1:auto → {effectiveTarget}
              </p>
            )}
          </div>

          {screen.protocol === "vnc" && (
            <div className="my-2 rounded-md border border-[var(--cf-border)] p-2.5">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={screen.embedded}
                  onChange={(embedded) => patchScreen({ embedded })}
                />
                <span className="text-[12px] text-[var(--cf-text)]">
                  {t("remote.screenEmbedded")}
                </span>
              </label>
              <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("remote.screenEmbeddedHint")}
              </p>
            </div>
          )}

          <Row label={t("remote.fieldViewer")} hint={t("remote.fieldViewerHint")} wide>
            <Field
              value={screen.viewer}
              onChange={(viewer) => patchScreen({ viewer })}
              mono
              placeholder={t("remote.viewerPlaceholder")}
            />
          </Row>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

function AdvancedTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const snippets = useRemoteStore((s) => s.snippets);
  const t = useT();

  return (
    <div className="space-y-1">
      <Row label={t("remote.fieldCommand")} hint={t("remote.fieldCommandHint")} wide>
        <Field
          value={spec.command}
          onChange={(command) => onPatch({ command })}
          mono
          placeholder="docker compose logs -f"
        />
      </Row>
      <Row label={t("remote.fieldStartupSnippet")} hint={t("remote.fieldStartupSnippetHint")} wide>
        <Select
          value={spec.startup_snippet_id}
          onChange={(startup_snippet_id) => onPatch({ startup_snippet_id })}
          options={[
            { value: "", label: t("remote.screenNone") },
            ...snippets.map((snippet) => ({ value: snippet.id, label: snippet.name })),
          ]}
        />
      </Row>

      <Row label={t("remote.fieldDirectory")} hint={t("remote.fieldDirectoryHint")} wide>
        <Field
          value={spec.directory}
          onChange={(directory) => onPatch({ directory })}
          mono
          placeholder="/srv/app"
        />
      </Row>

      <div className="pt-3">
        <p className="text-[12px] text-[var(--cf-text)]">{t("remote.fieldOptions")}</p>
        <p className="pb-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.fieldOptionsHint")}
        </p>
        <textarea
          value={spec.options.join("\n")}
          rows={5}
          onChange={(e) =>
            onPatch({ options: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })
          }
          placeholder={"Compression=yes\nPreferredAuthentications=publickey"}
          className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
        />
      </div>

      <div className="pt-3">
        <p className="pb-1.5 text-[12px] text-[var(--cf-text)]">{t("remote.fieldNotes")}</p>
        <textarea
          value={spec.notes}
          rows={4}
          onChange={(e) => onPatch({ notes: e.target.value })}
          placeholder={t("remote.notesPlaceholder")}
          className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
      </div>
    </div>
  );
}
