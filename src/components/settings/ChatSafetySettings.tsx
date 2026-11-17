import { useEffect, useState } from "react";
import { Checkbox } from "../common/Checkbox";
import { fieldClass } from "../common/recipes";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

/** `ai_locks::EXCLUSIVE_SETTING`: writing chat turns exclusive per working copy. */
const EXCLUSIVE_KEY = "chat_exclusive_repo_lock";
/** `git::checkpoint::MAX_SETTING`: checkpoints each repository keeps (5–200). */
const MAX_KEY = "checkpoint_max";
/** `git::checkpoint::ENV_SETTING`: `"false"` leaves ignored `.env` files out of the snapshots. */
const ENV_KEY = "checkpoint_include_env";
const MAX_DEFAULT = 20;

/**
 * How the chats share a repository and what their undo keeps — the settings that sit under every
 * chat turn rather than in any one composer. Each is mirrored by the backend on write
 * (`set_setting`), so a change applies to the next turn.
 */
export function ChatSafetySettings() {
  const t = useT();
  const [exclusive, setExclusive] = useState<boolean | null>(null);
  const [includeEnv, setIncludeEnv] = useState(true);
  const [max, setMax] = useState(String(MAX_DEFAULT));

  useEffect(() => {
    void Promise.all([getSetting(EXCLUSIVE_KEY), getSetting(ENV_KEY), getSetting(MAX_KEY)])
      .then(([storedExclusive, storedEnv, storedMax]) => {
        setExclusive(storedExclusive === "true");
        setIncludeEnv(storedEnv !== "false");
        setMax(storedMax?.trim() || String(MAX_DEFAULT));
      })
      .catch(() => setExclusive(false));
  }, []);

  if (exclusive === null) return null;

  const save = (key: string, value: string) => void setSetting(key, value).catch((e: unknown) => pushErrorToast(String(e)));
  const commitMax = () => {
    const parsed = Number.parseInt(max, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(200, Math.max(5, parsed)) : MAX_DEFAULT;
    setMax(String(clamped));
    save(MAX_KEY, String(clamped));
  };

  return (
    <div className="mb-3 space-y-3 rounded-lg border border-[var(--cf-border)] px-2.5 py-2.5">
      <p className="text-[13px] font-medium text-[var(--cf-text)]">{t("settings.chatSafetyTitle")}</p>
      <label className="flex items-start gap-2 text-[13px]">
        <span className="mt-[2px]">
          <Checkbox
            checked={exclusive}
            onChange={(next) => {
              setExclusive(next);
              save(EXCLUSIVE_KEY, next ? "true" : "false");
            }}
          />
        </span>
        <span>
          {t("settings.chatExclusiveLabel")}
          <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.chatExclusiveHint")}</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-[13px]">
        <span className="mt-[2px]">
          <Checkbox
            checked={includeEnv}
            onChange={(next) => {
              setIncludeEnv(next);
              save(ENV_KEY, next ? "true" : "false");
            }}
          />
        </span>
        <span>
          {t("settings.checkpointEnvLabel")}
          <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.checkpointEnvHint")}</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-[13px]">
        <input
          type="number"
          min={5}
          max={200}
          value={max}
          onChange={(e) => setMax(e.target.value)}
          onBlur={commitMax}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitMax();
          }}
          className={fieldClass({ size: "sm", className: "w-16 shrink-0" })}
        />
        <span>
          {t("settings.checkpointMaxLabel")}
          <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.checkpointMaxHint")}</span>
        </span>
      </label>
    </div>
  );
}
