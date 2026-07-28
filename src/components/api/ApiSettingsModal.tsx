import { useEffect, type ReactNode } from "react";
import {
  Info,
  Network,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { ApiModal, Field, GhostButton, Row } from "./ApiModal";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { apiPickFile } from "../../lib/tauri/apiCommands";
import type { ClientCert } from "../../types/api";

const CERT_EXTENSIONS = ["p12", "pfx", "pem", "crt", "cer"];
const KEY_EXTENSIONS = ["pem", "key"];

function newCertId(): string {
  return `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <Icon size={12} />
        {title}
      </h3>
      <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">{children}</div>
    </section>
  );
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

export function ApiSettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <ApiModal icon={Settings2} title={t("api.settings.title")} width="max-w-2xl" onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ApiSettingsBody />
      </div>
    </ApiModal>
  );
}

/**
 * The settings themselves, without the modal around them, so the `api` section of the main
 * Settings window shows exactly the same controls instead of a second copy that drifts.
 */
export function ApiSettingsBody() {
  const t = useT();
  // Reachable from the Settings window before the API view has ever been opened, in which case
  // the store still holds its defaults — and writing one back would overwrite what's on disk.
  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const clearHistory = useApiStore((s) => s.clearHistory);
  const clearCookies = useApiStore((s) => s.clearCookies);
  const historyCount = useApiStore((s) => s.history.length);
  const cookieCount = useApiStore((s) => s.cookies.length);
  const pushToast = useToastStore((s) => s.pushToast);

  const number = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };

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
    <>
    <Section icon={Network} title={t("api.settings.network")}>
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
    </Section>

    <Section icon={Waypoints} title={t("api.settings.proxy")}>
      <Row label={t("api.settings.proxyEnabled")}>
        <Checkbox
          checked={settings.proxyEnabled}
          onChange={(proxyEnabled) => void updateSettings({ proxyEnabled })}
        />
      </Row>
      <Row label={t("api.settings.proxyUrl")}>
        <Field
          mono
          disabled={!settings.proxyEnabled}
          value={settings.proxyUrl}
          placeholder="http://127.0.0.1:8080"
          onChange={(proxyUrl) => void updateSettings({ proxyUrl })}
        />
      </Row>
    </Section>

    <Section icon={ShieldCheck} title={t("api.settings.certificates")}>
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
    </Section>

    <Section icon={Settings2} title={t("settings.general")}>
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
    </Section>
    </>
  );
}
