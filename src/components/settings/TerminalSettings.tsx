import { useEffect, useRef, useState } from "react";
import { Plus, TerminalSquare, Trash2 } from "lucide-react";
import { getSetting, listShellProfiles, setSetting } from "../../lib/tauri/commands";
import type { ShellProfile } from "../../types/domain";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { RailSection } from "./settingsNav";

const PROFILES_KEY = "terminal_profiles";
const DEFAULT_PROFILE_KEY = "terminal_default_profile";

/** Args are edited as a single line because that's how anyone thinks of a command — split on
 * whitespace, which covers every flag a shell profile realistically needs (`--login -i`,
 * `-NoLogo`). A profile needing a quoted argument with spaces is beyond what this input is for. */
function parseArgs(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}

export function TerminalSettings() {
  const t = useT();
  // Detected shells and the user's own are kept apart: only the second list is editable, and only
  // it is persisted. `listShellProfiles` returns both, already in the order the picker shows them.
  const [builtins, setBuiltins] = useState<ShellProfile[]>([]);
  const [custom, setCustom] = useState<ShellProfile[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Args are stored parsed but edited as raw text. Rendering the input straight from
  // `args.join(" ")` would swallow the space that separates one flag from the next — the parse
  // drops the trailing empty token, so the space never survives long enough to type after it.
  const [argsDraft, setArgsDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      const [all, saved] = await Promise.all([
        listShellProfiles().catch(() => [] as ShellProfile[]),
        getSetting(DEFAULT_PROFILE_KEY).catch(() => null),
      ]);
      setBuiltins(all.filter((p) => p.builtin));
      setCustom(all.filter((p) => !p.builtin));
      setDefaultId(saved ?? "");
      setLoaded(true);
    })();
  }, []);

  // Persisting from an effect rather than from each handler is what lets every edit below use the
  // functional `setCustom` form. Handlers that read `custom` out of their closure and wrote the
  // result would drop characters when typing outruns a render.
  const persisted = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    // The first run after load would rewrite the setting with what was just read from it.
    if (!persisted.current) {
      persisted.current = true;
      return;
    }
    void setSetting(PROFILES_KEY, JSON.stringify(custom));
  }, [custom, loaded]);

  const addProfile = () =>
    setCustom((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: t("settings.terminalNewProfile"), command: "", args: [], builtin: false },
    ]);

  const updateProfile = (id: string, patch: Partial<ShellProfile>) =>
    setCustom((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const removeProfile = async (profile: ShellProfile) => {
    if (!(await confirmAction(t("settings.terminalRemoveConfirm", { name: profile.name })))) return;
    setCustom((prev) => prev.filter((p) => p.id !== profile.id));
    // A default pointing at the profile just deleted is cleared rather than left dangling. The
    // backend tolerates a stale id (it falls back to the platform default), but the dropdown
    // would show a blank until the user noticed.
    if (defaultId === profile.id) {
      setDefaultId("");
      void setSetting(DEFAULT_PROFILE_KEY, "");
    }
  };

  const chooseDefault = (id: string) => {
    setDefaultId(id);
    void setSetting(DEFAULT_PROFILE_KEY, id);
  };

  if (!loaded) return null;

  // An empty command can't launch, so it's worth flagging inline — the backend skips such a
  // profile entirely, which would otherwise look like the entry silently vanishing from the picker.
  const incomplete = custom.some((p) => !p.command.trim());

  return (
    <RailSection section="terminal" title={t("settings.terminalTitle")} hint={t("settings.terminalHint")} fallback="default">
      {(tab) => (
        <>
          {tab === "default" && (
            // Sized by its wrapper: the trigger is `w-full`, and a shell name does not need the
            // whole pane.
            <div className="max-w-sm">
              <Select
                value={defaultId}
                onChange={chooseDefault}
                ariaLabel={t("settings.terminalDefault")}
                placeholder={t("settings.terminalDefaultAuto")}
                options={[
                  { value: "", label: t("settings.terminalDefaultAuto") },
                  ...[...builtins, ...custom].map((p) => ({
                    value: p.id,
                    label: p.name,
                    disabled: !p.command.trim(),
                  })),
                ]}
              />
            </div>
          )}

          {tab === "detected" && (
            <div className="space-y-1.5">
              {builtins.map((profile) => (
                <div
                  key={profile.id}
                  className="flex min-h-9 items-center gap-2.5 rounded-lg border border-[var(--cf-border)] px-3 py-1.5 text-[13px]"
                >
                  <TerminalSquare size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="shrink-0 font-medium text-[var(--cf-text)]">{profile.name}</span>
                  <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={profile.command}>
                    {[profile.command, ...profile.args].join(" ")}
                  </span>
                </div>
              ))}
            </div>
          )}

          {tab === "custom" && (
            <>
              <div className="mb-2 flex items-center justify-end">
                <button type="button" onClick={addProfile} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  <Plus size={13} /> {t("settings.terminalAddProfile")}
                </button>
              </div>

              {custom.length === 0 ? (
                <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.terminalCustomEmpty")}</p>
              ) : (
                <div className="space-y-2">
                  {custom.map((profile) => (
                    <div key={profile.id} className="rounded-lg border border-[var(--cf-border)] p-2.5">
                      <div className="mb-2 flex items-center gap-2">
                        <input
                          value={profile.name}
                          onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                          placeholder={t("settings.terminalProfileName")}
                          className={fieldClass({ size: "sm", className: "flex-1 font-medium" })}
                        />
                        <Tooltip label={t("common.delete")}>
                          <button
                            type="button"
                            onClick={() => void removeProfile(profile)}
                            aria-label={t("common.delete")}
                            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)]"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={profile.command}
                          onChange={(e) => updateProfile(profile.id, { command: e.target.value })}
                          placeholder={t("settings.terminalProfileCommand")}
                          className={fieldClass({ size: "sm", className: "flex-[2] font-mono" })}
                        />
                        <input
                          value={argsDraft[profile.id] ?? profile.args.join(" ")}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setArgsDraft((prev) => ({ ...prev, [profile.id]: raw }));
                            updateProfile(profile.id, { args: parseArgs(raw) });
                          }}
                          placeholder={t("settings.terminalProfileArgs")}
                          className={fieldClass({ size: "sm", className: "flex-1 font-mono" })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {incomplete && <p className="mt-2 text-[11px] text-[var(--cf-warning)]">{t("settings.terminalMissingCommand")}</p>}
            </>
          )}
        </>
      )}
    </RailSection>
  );
}
