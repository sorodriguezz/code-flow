import type { ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import { defaultRequestSettings } from "../../types/api";
import type { RequestSettings } from "../../types/api";

/** Mirrors `DEFAULT_ENCODE_URL` in `lib/api/send.ts`: `encodeUrl` is the one override with no
 * counterpart in `ApiSettings`, so `null` falls back to a constant rather than to a global. */
const DEFAULT_ENCODE_URL = true;

/**
 * One override row.
 *
 * Every control here is tri-state — `null` means "whatever the app-level setting says" — and the
 * whole point of the row is that the difference is visible: a panel that renders an inherited
 * `true` and an overridden `true` identically is a panel that lies about what it will send.
 */
function SettingRow({
  label,
  overridden,
  inherited,
  onReset,
  children,
  note,
}: {
  label: string;
  overridden: boolean;
  /** The value that will actually be used while the row is inheriting. Omitted for a setting the
   * transport can't honour at all, where quoting a global would be reporting a value that has no
   * effect. */
  inherited?: string;
  onReset?: () => void;
  children: ReactNode;
  note?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--cf-border)] py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-[12px] text-[var(--cf-text)]">{label}</p>
        {(overridden || inherited !== undefined) && (
          <p className="mt-0.5 text-[11px] text-[var(--cf-text-muted)]">
            {overridden
              ? t("api.settings.perRequest")
              : t("api.settings.globalValue", { value: inherited ?? "" })}
          </p>
        )}
        {note}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {overridden && onReset && (
          <button
            type="button"
            onClick={onReset}
            title={t("api.settings.useGlobal")}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <RotateCcw size={10} />
            {t("api.settings.useGlobal")}
          </button>
        )}
      </div>
    </div>
  );
}

export function RequestSettingsPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId));
  const updateDraft = useApiStore((s) => s.updateDraft);
  const globals = useApiStore((s) => s.settings);

  const settings = tab?.draft.settings ?? defaultRequestSettings();
  const patch = (next: Partial<RequestSettings>) =>
    updateDraft(tabId, { settings: { ...settings, ...next } });

  const onOff = (value: boolean) => t(value ? "api.settings.on" : "api.settings.off");

  if (!tab) return <div className="h-full" />;

  const boolRow = (
    key: "followRedirects" | "verifySsl" | "sendCookies" | "encodeUrl",
    label: string,
    globalValue: boolean,
  ) => {
    const override = settings[key];
    const effective = override ?? globalValue;
    return (
      <SettingRow
        label={label}
        overridden={override !== null}
        inherited={onOff(globalValue)}
        onReset={() => patch({ [key]: null } as Partial<RequestSettings>)}
      >
        <Checkbox
          checked={effective}
          // Toggling off an inherited value is what creates the override — the checkbox always
          // shows what will be sent, and the reset link is the only way back to inheriting.
          onChange={(checked) => patch({ [key]: checked } as Partial<RequestSettings>)}
        />
      </SettingRow>
    );
  };

  const numberRow = (key: "maxRedirects" | "timeoutMs", label: string, globalValue: number) => {
    const override = settings[key];
    return (
      <SettingRow
        label={label}
        overridden={override !== null}
        inherited={String(globalValue)}
        onReset={() => patch({ [key]: null } as Partial<RequestSettings>)}
      >
        <input
          inputMode="numeric"
          value={override === null ? "" : String(override)}
          placeholder={String(globalValue)}
          aria-label={label}
          onChange={(e) => {
            const raw = e.target.value.trim();
            // An emptied field is the second way back to inheriting, and the one anyone who
            // selected the number and hit Delete expects.
            if (raw === "") {
              patch({ [key]: null } as Partial<RequestSettings>);
              return;
            }
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed >= 0) {
              patch({ [key]: Math.trunc(parsed) } as Partial<RequestSettings>);
            }
          }}
          className="w-24 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 text-right font-mono text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)] placeholder:text-[var(--cf-text-muted)]"
        />
      </SettingRow>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <div className="max-w-[620px]">
        {boolRow("followRedirects", t("api.settings.followRedirects"), globals.followRedirects)}
        {numberRow("maxRedirects", t("api.settings.maxRedirects"), globals.maxRedirects)}
        {boolRow("verifySsl", t("api.settings.verifySsl"), globals.verifySsl)}
        {numberRow("timeoutMs", t("api.settings.timeout"), globals.timeoutMs)}
        {boolRow("sendCookies", t("api.settings.sendCookies"), globals.sendCookies)}
        {boolRow("encodeUrl", t("api.settings.encodeUrl"), DEFAULT_ENCODE_URL)}

        {/* Not a toggle, because the backend cannot honour one: reqwest strips `Authorization`
            on every cross-host hop and exposes no opt-out. A switch that silently did nothing
            would be worse than saying so. */}
        <SettingRow
          label={t("api.settings.keepAuthOnRedirect")}
          overridden={false}
          note={
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--cf-warning)]">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>{t("api.settings.keepAuthUnavailable")}</span>
            </p>
          }
        >
          <Checkbox checked={false} disabled onChange={() => {}} />
        </SettingRow>
      </div>
    </div>
  );
}
