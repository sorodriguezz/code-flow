import { useMemo } from "react";
import { SftpPanel } from "./SftpPanel";
import { ObjectBrowser } from "./ObjectBrowser";
import { useRemoteStore } from "../../state/remoteStore";
import { isCloudKind, parseHostSpec } from "../../types/remote";

/**
 * Which of the two file browsers a host gets.
 *
 * **The split is not cosmetic: the two far sides answer different questions.** A shell host has a
 * filesystem — directories arrive whole, `~` is a place you can see, and a transfer is a statement
 * about *two* machines, which is exactly what a dual pane draws. A store has none of that. There is
 * no login directory, listings arrive a page at a time, and the local half of a transfer is a file
 * picker's job, because the OS already has a better browser for this machine than this app will
 * ever have. Giving a store the dual pane spends half the window on `~` and leaves no room for the
 * columns — tier, blob type, lease — that are the reason anyone opens an object browser at all.
 *
 * One line, in one place, so a kind added later lands in the right one by saying what it is rather
 * than by being remembered.
 */
export function FileBrowser({ hostId }: { hostId: string }) {
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === hostId) ?? null);
  const spec = useMemo(() => (host ? parseHostSpec(host) : null), [host]);

  if (host && spec && isCloudKind(spec.kind)) {
    return (
      <ObjectBrowser
        hostId={hostId}
        title={host.name}
        // S3's root holds buckets. An Azure account reached through this tab rather than through
        // the account panel is on its blob leg, so its root holds containers.
        rootChild={spec.kind === "s3" ? "bucket" : "container"}
        // Snapshots, tiers and properties are Azure Blob's. S3 has storage classes and versions,
        // which are different enough that borrowing the buttons would be lying about what they do.
        blobFeatures={spec.kind !== "s3"}
      />
    );
  }
  return <SftpPanel hostId={hostId} />;
}
