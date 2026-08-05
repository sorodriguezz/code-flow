import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Info,
  Network,
  Plus,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { motion } from "framer-motion";
import { ActivePill } from "../common/ActivePill";
import { Field, GhostButton, Row } from "./ApiModal";
import { Panel, SettingsHeader } from "./settingsChrome";
import { CollaborationPanel } from "./CollaborationPanel";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useUiStore } from "../../state/uiStore";
import type { ApiSettingsTab } from "../../state/apiModalStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import type { ClientCert } from "../../types/api";
import type { TranslationKey } from "../../lib/i18n/translations";

const CERT_EXTENSIONS = ["p12", "pfx", "pem", "crt", "cer"];
const KEY_EXTENSIONS = ["pem", "key"];

function newCertId(): string {
  return `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Every numeric field here is a non-negative integer, and a half-typed one must not clear it. */
function number(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** A path field with a native picker beside it, used by all four certificate slots. */
function PathField({
  value,
  extensions,
  placeholder,
  onChange,
}: {
  value: string;
  extensions: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const browse = async () => {
    const path = await apiPickFile(extensions).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (path) onChange(path);
  };
  return (
    <div className="flex items-center gap-1.5">
      <Field mono value={value} placeholder={placeholder} onChange={onChange} />
      <GhostButton onClick={() => void browse()}>{t("api.settings.browse")}</GhostButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panels, one per tab
// ---------------------------------------------------------------------------

function NetworkPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  return (
    <Panel>
      <Row label={t("api.settings.timeout")}>
        <Field
          type="number"
          value={String(settings.timeoutMs)}
          onChange={(value) => void updateSettings({ timeoutMs: number(value, settings.timeoutMs) })}
        />
      </Row>
      <Row label={t("api.settings.followRedirects")}>
        <Checkbox
          checked={settings.followRedirects}
          onChange={(followRedirects) => void updateSettings({ followRedirects })}
        />
      </Row>
      <Row label={t("api.settings.maxRedirects")}>
        <Field
          type="number"
          disabled={!settings.followRedirects}
          value={String(settings.maxRedirects)}
          onChange={(value) =>
            void updateSettings({ maxRedirects: number(value, settings.maxRedirects) })
          }
        />
      </Row>
      <Row label={t("api.settings.verifySsl")}>
        <Checkbox
          checked={settings.verifySsl}
          onChange={(verifySsl) => void updateSettings({ verifySsl })}
        />
      </Row>

      {/* Shown rather than hidden: the field exists in `ApiSettings` and in the per-request
          overrides, so leaving it out entirely would read as an oversight instead of a limit. */}
      <div className="flex items-center gap-3 py-1 opacity-60">
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] text-[var(--cf-text)]">
            {t("api.settings.keepAuthOnRedirect")}
          </span>
          <span className="flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <Info size={11} className="mt-[2px] shrink-0" />
            {t("api.settings.keepAuthUnavailable")}
          </span>
        </span>
        <span className="flex w-[180px] shrink-0 justify-end">
          <Checkbox checked={false} disabled onChange={() => {}} />
        </span>
      </div>

      <Row label={t("api.settings.sendCookies")}>
        <Checkbox
          checked={settings.sendCookies}
          onChange={(sendCookies) => void updateSettings({ sendCookies })}
        />
      </Row>
    </Panel>
  );
}

function ProxyPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  return (
    <Panel>
      <Row label={t("api.settings.proxyEnabled")}>
        <Checkbox
          checked={settings.proxyEnabled}
          onChange={(proxyEnabled) => void updateSettings({ proxyEnabled })}
        />
      </Row>
      <Row label={t("api.settings.proxyUrl")} wide>
        <Field
          mono
          disabled={!settings.proxyEnabled}
          value={settings.proxyUrl}
          placeholder="http://127.0.0.1:8080"
          onChange={(proxyUrl) => void updateSettings({ proxyUrl })}
        />
      </Row>
    </Panel>
  );
}

function CertificatesPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  const patchCert = (id: string, patch: Partial<ClientCert>) =>
    void updateSettings({
      clientCerts: settings.clientCerts.map((cert) => (cert.id === id ? { ...cert, ...patch } : cert)),
    });

  const addCert = () =>
    void updateSettings({
      clientCerts: [
        ...settings.clientCerts,
        { id: newCertId(), host: "", certPath: "", keyPath: "", passphrase: "" },
      ],
    });

  const removeCert = (id: string) =>
    void updateSettings({ clientCerts: settings.clientCerts.filter((cert) => cert.id !== id) });

  return (
    <Panel>
      <div className="mb-2">
        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.settings.caCert")}
        </label>
        <PathField
          value={settings.caCertPath}
          extensions={["pem", "crt", "cer"]}
          placeholder="ca-bundle.pem"
          onChange={(caCertPath) => void updateSettings({ caCertPath })}
        />
      </div>

      <div className="mb-1 flex items-center">
        <span className="mr-auto text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.settings.clientCerts")}
        </span>
        <GhostButton onClick={addCert}>
          <Plus size={12} />
          {t("api.settings.addCert")}
        </GhostButton>
      </div>

      {settings.clientCerts.length === 0 ? (
        <p className="py-1 text-[11px] text-[var(--cf-text-muted)]">{t("api.settings.noCerts")}</p>
      ) : (
        settings.clientCerts.map((cert) => (
          <div key={cert.id} className="mb-2 rounded-md border border-[var(--cf-border)] p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <Field
                mono
                value={cert.host}
                placeholder={t("api.settings.certHost")}
                onChange={(host) => patchCert(cert.id, { host })}
              />
              <button
                onClick={() => removeCert(cert.id)}
                title={t("api.settings.removeCert")}
                className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="mb-1.5">
              <PathField
                value={cert.certPath}
                extensions={CERT_EXTENSIONS}
                placeholder={t("api.settings.certFile")}
                onChange={(certPath) => patchCert(cert.id, { certPath })}
              />
            </div>
            <div className="mb-1.5">
              <PathField
                value={cert.keyPath}
                extensions={KEY_EXTENSIONS}
                placeholder={t("api.settings.keyFile")}
                onChange={(keyPath) => patchCert(cert.id, { keyPath })}
              />
            </div>
            <Field
              type="password"
              value={cert.passphrase}
              placeholder={t("api.settings.passphrase")}
              onChange={(passphrase) => patchCert(cert.id, { passphrase })}
            />
          </div>
        ))
      )}
    </Panel>
  );
}

function GeneralPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const clearHistory = useApiStore((s) => s.clearHistory);
  const clearCookies = useApiStore((s) => s.clearCookies);
  const historyCount = useApiStore((s) => s.history.length);
  const cookieCount = useApiStore((s) => s.cookies.length);
  const pushToast = useToastStore((s) => s.pushToast);

  const wipeHistory = async () => {
    if (!(await confirmAction(t("api.settings.clearHistoryConfirm")))) return;
    await clearHistory();
  };

  const wipeCookies = async () => {
    if (!(await confirmAction(t("api.cookie.clearAllConfirm")))) return;
    await clearCookies();
    pushToast(t("api.toast.cookieCleared"), "success");
  };

  return (
    <Panel>
      <Row label={t("api.settings.maxResponse")}>
        <Field
          type="number"
          value={String(settings.maxResponseBytes)}
          onChange={(value) =>
            void updateSettings({ maxResponseBytes: number(value, settings.maxResponseBytes) })
          }
        />
      </Row>
      <Row label={t("api.settings.prettyPrint")}>
        <Checkbox
          checked={settings.prettyPrint}
          onChange={(prettyPrint) => void updateSettings({ prettyPrint })}
        />
      </Row>
      <Row label={t("api.settings.saveHistory")}>
        <Checkbox
          checked={settings.saveHistory}
          onChange={(saveHistory) => void updateSettings({ saveHistory })}
        />
      </Row>
      <Row label={t("api.settings.historyLimit")}>
        <Field
          type="number"
          disabled={!settings.saveHistory}
          value={String(settings.historyLimit)}
          onChange={(value) =>
            void updateSettings({ historyLimit: number(value, settings.historyLimit) })
          }
        />
      </Row>

      {/* Every control above is stored under the one global `api_settings` key; the two buttons
          below empty only the current workspace's history and jar — as do the counts that
          disable them. Saying so is cheaper than the support question. */}
      <div className="mt-2 border-t border-[var(--cf-border)] pt-2">
        <p className="mb-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <Info size={11} className="mt-[2px] shrink-0" />
          {t("api.settings.workspaceScope")}
        </p>
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void wipeHistory()} disabled={historyCount === 0}>
            <Trash2 size={12} />
            {t("api.settings.clearHistory")}
          </GhostButton>
          <GhostButton onClick={() => void wipeCookies()} disabled={cookieCount === 0}>
            <Trash2 size={12} />
            {t("api.settings.clearCookies")}
          </GhostButton>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

const TABS: { id: ApiSettingsTab; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "network", labelKey: "api.settings.network", icon: Network },
  { id: "proxy", labelKey: "api.settings.proxy", icon: Waypoints },
  { id: "certificates", labelKey: "api.settings.certificates", icon: ShieldCheck },
  { id: "general", labelKey: "settings.general", icon: Settings2 },
  { id: "collab", labelKey: "api.collab.title", icon: Share2 },
];

/**
 * The settings themselves, without the modal around them, so the `api` section of the main
 * Settings window shows exactly the same controls instead of a second copy that drifts.
 *
 * Behind sub-tabs rather than stacked: several groups down one scroll put the ones a new user has
 * to find below three screens of transport tuning nobody edits twice.
 *
 * The backup tab used to live here and no longer does — it grew from "this workspace's requests"
 * into the whole install, credentials included, which is not a property of the API client. It is
 * now its own section of Settings (`components/settings/BackupSettings.tsx`).
 */
export function ApiSettingsBody() {
  const t = useT();
  // Which sub-tab to land on comes from whoever opened the window: "share this collection" asks for
  // the collaboration one, and anything that just wants "settings" asks for nothing and gets the
  // first tab.
  const initialTab = useUiStore((s) => s.apiSettingsTab);
  // Reachable from the Settings window before the API view has ever been opened, in which case
  // the store still holds its defaults — and writing one back would overwrite what's on disk.
  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const [tab, setTab] = useState<ApiSettingsTab>(initialTab ?? "network");

  // Initial state alone would only be read on mount, and a caller that asks for a tab while this
  // is already on screen would be silently ignored.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // This pane scrolls itself rather than riding the settings column's scrollbar, which is what
  // keeps the heading and the rail still: with the whole section scrolling, reading to the bottom
  // of Collaboration took the title and every sub-tab off the top of the window, so the way back to
  // another tab was to scroll up first. Only the pane beside the rail moves now. Same arrangement,
  // and the same reason, as the AI assistant's and the backup section's.
  //
  // The panes are also nowhere near the same height, so switching from a tall one that had been
  // scrolled down handed the next a viewport starting somewhere in its middle. Back to the top on
  // every switch, in a layout effect so it lands before the frame is painted rather than as a
  // visible correction after it.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    // A heading of its own, which this pane went without for as long as it has existed: it was the
    // only settings section that opened straight onto a rail, so arriving here from any other one
    // dropped the first row a line and a half up the pane.
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("api.settings.title")} hint={t("api.settings.hint")} />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
      {/* A rail rather than a strip across the top.
          Six sub-tabs with Spanish labels in a 576px column already wrapped, and the wrap put
          "Colaboración" — the one most used right now — alone on a second line; a "beta" badge was
          all it took to tip it over. Down the side there is nothing to wrap: a seventh tab, a
          longer translation or another badge all just make the list one row taller. It is also the
          shape the settings window around it already uses, which is why a nested nav reads as part
          of the same furniture instead of as a second idea. */}
      {/* `layoutRoot`, and it has to be a `motion.nav` to carry it.
          The pill inside is a shared-layout animation: framer measures where it was, measures where
          it lands, and tweens between the two. Those measurements are taken against the page unless
          something says otherwise — and the rail used to be `sticky`, which made its own offset
          depend on a scroll position the arriving pane had just changed underneath it, so the slide
          arrived as a jump. The rail no longer moves at all now that the pane beside it does the
          scrolling, but `layoutRoot` stays: it makes this element the frame of reference, which is
          what the tween should have been measured against all along. */}
      <motion.nav layoutRoot className="w-[168px] shrink-0 self-start">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            title={t(labelKey)}
            // Colour and the pill carry the selection; no weight change, for the same reason the
            // outer nav avoids one — bolding re-measures the label and reflows the row.
            className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
              tab === id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
            }`}
          >
            {tab === id && <ActivePill layoutId="cf-api-settings-pill" />}
            {/* Above the pill, which covers the whole button. */}
            <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
              <Icon size={13} className="shrink-0" />
              <span className="truncate">{t(labelKey)}</span>
            </span>
          </button>
        ))}
      </motion.nav>

        {/* `overflow-y-scroll`, not `auto`: the app styles its scrollbars, so one is a real 10px of
            layout rather than an overlay. Letting it come and go as a pane grows past the height
            narrows the content and shifts every row sideways, then shifts them back. `pb-6` because
            the pane ends where the dialog does, and a last row flush against that edge reads as cut
            off rather than as the end of the list. */}
        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          {tab === "network" && <NetworkPanel />}
          {tab === "proxy" && <ProxyPanel />}
          {tab === "certificates" && <CertificatesPanel />}
          {tab === "general" && <GeneralPanel />}
          {tab === "collab" && <CollaborationPanel />}
        </div>
      </div>
    </section>
  );
}
