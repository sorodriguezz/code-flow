import { Cloud, HardDrive, type LucideIcon } from "lucide-react";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { HelpLink, Note } from "../api/settingsChrome";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { backupRevealFolder } from "../../lib/tauri/backupCommands";
import { pushErrorToast } from "../../state/toastStore";

/**
 * How to get the backup into each cloud, spelled out.
 *
 * Every destination is bring-your-own — Google Drive because the OAuth client is the user's own
 * Google Cloud project, OneDrive because the app registration is their own Entra tenant, iCloud
 * because Apple gives third-party apps no service API at all and the only way in is the folder its
 * sync daemon watches. None of that is discoverable from a field labelled "client ID" or a folder
 * picker, so the steps are here rather than in documentation nobody opens.
 *
 * The guides are collapsed by default and platform-aware: the iCloud one shows the Windows path
 * only on Windows, because sending a Mac user to `%USERPROFILE%\iCloudDrive` is worse than saying
 * nothing.
 */

const GOOGLE_URLS = {
  driveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  credentials: "https://console.cloud.google.com/apis/credentials",
  desktopAppDocs: "https://developers.google.com/identity/protocols/oauth2/native-app",
  icloudWindows: "https://support.apple.com/en-us/HT204283",
} as const;

const MICROSOFT_URLS = {
  registrations:
    "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  nativeAppDocs: "https://learn.microsoft.com/entra/identity-platform/scenario-desktop-overview",
} as const;

/** One numbered step. The number is drawn rather than a list marker so it survives wrapping. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="mb-1.5 flex gap-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
      <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-semibold text-[var(--cf-text)] dark:bg-white/[0.09]">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Guide({
  icon,
  title,
  steps,
  children,
}: {
  icon: LucideIcon;
  title: string;
  steps: TranslationKey[];
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <CollapsibleSection icon={icon} title={title}>
      <ol className="mb-1 mt-1">
        {steps.map((key, index) => (
          <Step key={key} n={index + 1}>
            {t(key)}
          </Step>
        ))}
      </ol>
      {children}
    </CollapsibleSection>
  );
}

/** The Google Cloud setup, in the order it actually has to happen. */
export function DriveGuide() {
  const t = useT();
  return (
    <Guide
      icon={Cloud}
      title={t("backup.guide.driveTitle")}
      steps={[
        "backup.guide.driveStep1",
        "backup.guide.driveStep2",
        "backup.guide.driveStep3",
        "backup.guide.driveStep4",
        "backup.guide.driveStep5",
      ]}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <HelpLink url={GOOGLE_URLS.driveApi}>{t("backup.guide.driveLinkEnable")}</HelpLink>
        <HelpLink url={GOOGLE_URLS.credentials}>{t("backup.guide.driveLinkCreate")}</HelpLink>
        <HelpLink url={GOOGLE_URLS.desktopAppDocs}>{t("backup.guide.driveLinkDocs")}</HelpLink>
      </div>
      <Note>{t("backup.guide.driveScope")}</Note>
    </Guide>
  );
}

/**
 * The Entra ID registration, in the order the portal actually asks for it.
 *
 * Shorter than the Google one by a whole step, and not by accident: a public client has no secret
 * to create, copy or paste, because PKCE does that job. The two details worth stating outright are
 * the ones the portal makes easy to get wrong — the platform must be "Mobile and desktop
 * applications" (a "Web" redirect would demand a secret this app deliberately doesn't have), and
 * the redirect must be spelled `http://localhost`, which the portal accepts while refusing
 * `http://127.0.0.1` outright. The port is left off on purpose: Microsoft ignores it when matching
 * a loopback redirect, so the one entry covers every port CodeFlow ever binds.
 */
export function OneDriveGuide() {
  const t = useT();
  return (
    <Guide
      icon={Cloud}
      title={t("backup.guide.onedriveTitle")}
      steps={[
        "backup.guide.onedriveStep1",
        "backup.guide.onedriveStep2",
        "backup.guide.onedriveStep3",
        "backup.guide.onedriveStep4",
      ]}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <HelpLink url={MICROSOFT_URLS.registrations}>
          {t("backup.guide.onedriveLinkRegister")}
        </HelpLink>
        <HelpLink url={MICROSOFT_URLS.nativeAppDocs}>{t("backup.guide.driveLinkDocs")}</HelpLink>
      </div>
      <Note>{t("backup.guide.onedriveScope")}</Note>
    </Guide>
  );
}

/**
 * iCloud, which needs no credentials at all because iCloud Drive is a directory.
 *
 * `folder` is the one found on this machine, or empty when iCloud isn't set up — and that
 * difference is the whole point of the guide: the steps that follow are either "here it is" or
 * "here is how to turn it on".
 */
export function ICloudGuide({
  platform,
  folder,
}: {
  platform: "windows" | "macos" | "linux";
  folder: string;
}) {
  const t = useT();
  const steps: TranslationKey[] =
    platform === "macos"
      ? ["backup.guide.icloudMac1", "backup.guide.icloudMac2", "backup.guide.icloudMac3"]
      : ["backup.guide.icloudWin1", "backup.guide.icloudWin2", "backup.guide.icloudWin3"];

  return (
    <Guide icon={HardDrive} title={t("backup.guide.icloudTitle")} steps={steps}>
      {platform === "windows" && (
        <div className="mb-1.5">
          <HelpLink url={GOOGLE_URLS.icloudWindows}>{t("backup.guide.icloudLinkWindows")}</HelpLink>
        </div>
      )}
      {folder === "" ? (
        <Note tone="warning">{t("backup.guide.icloudNotFound")}</Note>
      ) : (
        <button
          type="button"
          onClick={() => void backupRevealFolder(folder).catch((e: unknown) => pushErrorToast(String(e)))}
          title={folder}
          className="mb-1 block w-full truncate rounded border border-[var(--cf-border)] bg-black/[0.02] px-1.5 py-1 text-left font-mono text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] dark:bg-white/[0.03]"
        >
          {folder}
        </button>
      )}
      {/* Linux has no iCloud client at all, and saying so is better than an option that silently
          never appears. */}
      {platform === "linux" && <Note tone="warning">{t("backup.guide.icloudNoLinux")}</Note>}
      {/* "Why is this the only destination without a Connect button?" is the first thing anyone
          asks here, and the answer — Apple ships no API for it — is not something a user can be
          expected to know. Answered where the question occurs, with the destination that does what
          they were reaching for. */}
      <Note>{t("backup.guide.icloudNoApi")}</Note>
    </Guide>
  );
}

/** OneDrive, Dropbox and friends need no guide beyond the one sentence that explains them. */
export function SyncedFolderGuide() {
  const t = useT();
  return (
    <Guide
      icon={HardDrive}
      title={t("backup.guide.folderTitle")}
      steps={["backup.guide.folderStep1", "backup.guide.folderStep2", "backup.guide.folderStep3"]}
    />
  );
}
