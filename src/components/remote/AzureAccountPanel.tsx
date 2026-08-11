import { useEffect, useMemo, useState } from "react";
import { ObjectBrowser } from "./ObjectBrowser";
import { QueuePanel } from "./QueuePanel";
import { TablePanel } from "./TablePanel";
import { AZURE_SERVICE_ICON, AZURE_SERVICE_LABEL } from "./remoteChrome";
import { useRemoteStore, type RemoteAzureTab } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";
import {
  AZURE_SERVICES,
  azureEndpoint,
  azureServiceRoot,
  parseHostSpec,
  type AzureService,
  type RemoteHostSpec,
} from "../../types/remote";

/**
 * One Azure Storage account, with its four services down the side.
 *
 * **This is the shape the service actually has.** An account is one name and one credential, and
 * blob, file, queue and table are four endpoints on it that differ by a subdomain. CodeFlow used to
 * model each as its own host row, which meant four rows, four copies of the key in the keychain and
 * four things to fix when it rotated — and no single place that showed you what was in the account.
 * Storage Explorer has never worked that way and neither should this.
 *
 * **What is new here is only the rail.** Blob and Files are the existing dual-pane browser pointed
 * at `/blob` and `/files` — the service is the first segment of the path, so the breadcrumb, the
 * transfers and the drag-and-drop all work without knowing this panel exists (see
 * `remotes::cloud::account`). Queues and Tables are the panels that were already written for them.
 * The alternative — a bespoke tree with four kinds of node — would be a second file browser to keep
 * in step with the first.
 *
 * **A visited page stays mounted.** Switching to Queues and back should not re-list the container
 * you were three folders deep in, so pages are mounted on first visit and hidden with CSS
 * afterwards — the same rule `RemoteView` applies to terminal sessions, for the same reason.
 * Nothing is mounted before it is asked for, which is what keeps opening an account to one request
 * rather than four.
 */
export function AzureAccountPanel({ tab }: { tab: RemoteAzureTab }) {
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === tab.hostId) ?? null);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const t = useT();

  // Which pages have been opened. `service` is on the tab, so a menu entry that opens the account
  // on Queues mounts Queues and nothing else.
  const [visited, setVisited] = useState<AzureService[]>([tab.service]);
  useEffect(() => {
    setVisited((current) => (current.includes(tab.service) ? current : [...current, tab.service]));
  }, [tab.service]);

  const spec = useMemo(() => (host ? parseHostSpec(host) : null), [host]);
  if (!host || !spec) return null;

  return (
    <div className="flex h-full min-h-0">
      {/* Wide enough for the longest label in the longest language, which is not English: "Blob
          containers" fits in 168px and "Contenedores de blob" does not. A rail sized to the
          language it was written in truncates every entry in every other one. */}
      <nav className="flex w-[204px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--cf-border)] p-2">
        <p className="truncate px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {spec.azure.account.trim() || host.name}
        </p>
        {AZURE_SERVICES.map((service) => {
          const Icon = AZURE_SERVICE_ICON[service];
          const active = service === tab.service;
          return (
            <button
              key={service}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => openAzure(tab.hostId, service)}
              // The endpoint each page will actually talk to. Cheap to show and the fastest way to
              // catch a suffix typed for the wrong cloud — the request would otherwise fail with a
              // DNS error that names nothing the user typed.
              title={azureEndpoint(spec, ENDPOINT_OF[service])}
              className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                active
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.05]"
              }`}
            >
              <Icon size={13} className="shrink-0" />
              <span className="min-w-0 truncate">{t(AZURE_SERVICE_LABEL[service])}</span>
            </button>
          );
        })}
      </nav>

      <div className="relative min-w-0 flex-1">
        {visited.map((service) => (
          <div
            key={service}
            className={`absolute inset-0 ${service === tab.service ? "" : "hidden"}`}
          >
            {service === "blob" || service === "files" ? (
              <ObjectBrowser
                hostId={tab.hostId}
                root={azureServiceRoot(service)}
                title={t(AZURE_SERVICE_LABEL[service])}
                rootChild={service === "files" ? "share" : "container"}
                // Snapshots, tiers and properties are Blob's alone — a file share has none of them,
                // and a toolbar that offered them there would be offering a 400.
                blobFeatures={service === "blob"}
                linkFor={(entry) => blobUrl(spec, service, entry.path)}
              />
            ) : service === "queues" ? (
              <QueuePanel hostId={tab.hostId} />
            ) : (
              <TablePanel hostId={tab.hostId} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The address of one entry, for the browser's Copy URL.
 *
 * The path the browser holds is `/blob/container/key` — the service in front, which is this panel's
 * doing (see `remotes::cloud::account`). The URL is the service's own endpoint with that first
 * segment taken back off, and it is the thing people actually paste into a ticket, a `curl` or an
 * SDK. It is not a credential: reaching it still needs the key or a SAS.
 */
function blobUrl(spec: RemoteHostSpec, service: AzureService, path: string): string {
  const base = azureEndpoint(spec, ENDPOINT_OF[service]).replace(/\/+$/, "");
  const inner = path.replace(/^\/+/, "").split("/").slice(1).join("/");
  if (!base || !inner) return path;
  return `${base}/${inner}`;
}

/** Which endpoint a page talks to. The service names differ from the rail's ids by a plural — the
 *  wire calls it `queue`, the rail calls it Queues — and this is the one place that knows. */
const ENDPOINT_OF: Record<AzureService, "blob" | "file" | "queue" | "table"> = {
  blob: "blob",
  files: "file",
  queues: "queue",
  tables: "table",
};
