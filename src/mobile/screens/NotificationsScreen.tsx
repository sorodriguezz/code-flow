import { useEffect } from "react";
import { Bell, CheckCircle2, Info, XCircle } from "lucide-react";
import { t } from "../i18n";
import { useMobileStore } from "../store";
import { since } from "../time";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Card, Divider, Row, Section } from "../ui/List";
import { EmptyState } from "../ui/Feedback";
import type { RemoteNotice } from "../../types/domain";

/**
 * The desktop's notification centre, read from a phone.
 *
 * The same entries the bell at the desk lists — a pipeline that broke, a review that finished, a
 * chain parked on a gate — as the desktop's main window last published them (`remotectl_publish_
 * notifications`), so already in the desk's language. Read only: marking, clearing and following an
 * entry act on the desk's own panel. Leaving this list is what clears the dot on *this* phone's bell,
 * and nothing else.
 */

function StatusIcon({ status }: { status: RemoteNotice["status"] }) {
  if (status === "success") return <CheckCircle2 size={16} className="text-[var(--cf-success-text)]" aria-hidden />;
  if (status === "error") return <XCircle size={16} className="text-[var(--cf-danger-text)]" aria-hidden />;
  return <Info size={16} className="text-[var(--cf-text-muted)]" aria-hidden />;
}

export function NotificationsScreen() {
  const notices = useMobileStore((s) => s.notices);
  const seenAt = useMobileStore((s) => s.noticesSeenAt);
  const workspaces = useMobileStore((s) => s.workspaces);
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const refresh = useMobileStore((s) => s.refreshNotices);
  const markSeen = useMobileStore((s) => s.markNoticesSeen);

  // Marked seen on the way *out*, as the desk's panel does: while the list is open, what was new
  // stays marked, so it can still be told apart from what was already read.
  useEffect(() => {
    void refresh();
    return () => markSeen();
  }, [refresh, markSeen]);

  /** The workspace an entry belongs to, named only when it is not the one this phone is on. */
  const elsewhere = (id: string | null) =>
    id && id !== workspaceId ? (workspaces.find((w) => w.id === id)?.name ?? null) : null;

  return (
    <Screen bar={<PushBar title={t("notices.title")} />} onRefresh={refresh}>
      {notices.length === 0 ? (
        <EmptyState icon={<Bell size={26} aria-hidden />} title={t("notices.none")} />
      ) : (
        <Section>
          <Card>
            {notices.map((notice, index) => (
              <div key={notice.id} className={notice.finishedAt > seenAt ? "bg-[var(--cf-accent-soft)]" : ""}>
                {index > 0 && <Divider inset />}
                <Row
                  leading={<StatusIcon status={notice.status} />}
                  title={notice.title}
                  subtitle={[notice.detail, notice.source, elsewhere(notice.workspaceId), since(notice.finishedAt / 1000)]
                    .filter(Boolean)
                    .join(" · ")}
                />
              </div>
            ))}
          </Card>
        </Section>
      )}
    </Screen>
  );
}
