import { useEffect, useState } from "react";
import {
  Link2Off,
  Package,
  Server,
  Smartphone,
  TerminalSquare,
  Wifi,
  WifiOff,
} from "lucide-react";
import { t } from "../i18n";
import { forget, hello, storedName, type Hello } from "../transport";
import { useMobileStore } from "../store";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge } from "../ui/Feedback";

/**
 * What this phone is, what it is talking to, and how to stop.
 *
 * # Why a paired device needs a screen of its own
 *
 * It had none, and the gap that mattered was the last item on it: **there was no way for a phone to
 * unpair itself**. A device that is lost, sold, or simply borrowed by somebody's kid held a token
 * for a machine on the owner's LAN and the only remedy was to walk to the desktop. Everything else
 * here — which build, which desktop, whether the shell is granted — was equally unknowable, so a
 * phone that had quietly gone stale looked identical to one that had not.
 *
 * # Forgetting is local, and says so
 *
 * `forget()` deletes this device's token and announces it, which puts the pairing screen back. It
 * does **not** revoke the device on the desktop — there is no such command in the allowlist, and
 * there should not be: a device that can delete its own row could delete it after being stolen,
 * hiding the theft from the list the owner would go and check. So the hint says plainly that the
 * desktop's list still has the row and where to remove it.
 */
export function SettingsScreen() {
  const connected = useMobileStore((s) => s.connected);
  const terminalAllowed = useMobileStore((s) => s.terminalAllowed);
  const workspace = useMobileStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name);
  const project = useMobileStore((s) => s.projects.find((p) => p.id === s.projectId)?.name);
  const [info, setInfo] = useState<Hello | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  useEffect(() => {
    let alive = true;
    void hello().then((result) => alive && setInfo(result));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Screen bar={<PushBar title={t("settings.title")} />}>
      <Section title={t("settings.connection")}>
        <Card>
          <Row
            leading={
              connected ? (
                <Wifi size={16} className="text-[var(--cf-success-text)]" aria-hidden />
              ) : (
                <WifiOff size={16} className="text-[var(--cf-warning-text)]" aria-hidden />
              )
            }
            title={connected ? t("settings.connected") : t("settings.disconnected")}
            chevron={false}
          />
          <Divider inset />
          <Row
            leading={<Server size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
            title={t("settings.address")}
            // The origin this page was served from, which is the only thing the client knows about
            // where the desktop is — and the one detail somebody needs when the answer to "why is
            // it not connecting" is that the machine changed address.
            subtitle={<span className="cf-selectable font-mono">{location.host}</span>}
            chevron={false}
          />
          <Divider inset />
          <Row
            leading={<Package size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
            title={t("settings.bundle")}
            // A content digest, not a version number: what has to be identifiable is "the files this
            // page came from", which is what decides whether a reload is owed. Truncated because the
            // whole digest is unreadable and the first characters distinguish builds perfectly well.
            subtitle={
              <span className="cf-selectable font-mono">{info?.bundle?.slice(0, 12) ?? "—"}</span>
            }
            chevron={false}
          />
        </Card>
      </Section>

      <Section title={t("settings.device")}>
        <Card>
          <Row
            leading={<Smartphone size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
            title={t("settings.deviceName")}
            subtitle={storedName() || "—"}
            chevron={false}
          />
          <Divider inset />
          <Row
            leading={
              <TerminalSquare size={16} className="text-[var(--cf-text-muted)]" aria-hidden />
            }
            title={t("settings.terminals")}
            chevron={false}
            trailing={
              <Badge tone={terminalAllowed ? "success" : "neutral"}>
                {terminalAllowed ? t("settings.terminalsOn") : t("settings.terminalsOff")}
              </Badge>
            }
          />
        </Card>
      </Section>

      <Section title={t("settings.scope")}>
        <Card>
          <Row title={t("scope.workspace")} subtitle={workspace ?? "—"} chevron={false} />
          <Divider inset />
          <Row title={t("scope.project")} subtitle={project ?? "—"} chevron={false} />
        </Card>
      </Section>

      <Section>
        {confirmUnpair ? (
          <Card padded className="border-[var(--cf-danger)]/40">
            <p className="text-base">{t("settings.unpairHint")}</p>
            <div className="mt-2.5 flex gap-2">
              <Button full size="sm" onClick={() => setConfirmUnpair(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                full
                size="sm"
                variant="danger"
                icon={<Link2Off size={14} />}
                // Reloaded rather than left to the `onUnpaired` listener, which puts up the
                // *revoked* screen — a sentence about something the desktop did, shown to somebody
                // who has just chosen to leave. A reload lands on the pairing form directly, and
                // throws away the session's in-memory state along with the token.
                onClick={() => {
                  forget();
                  location.reload();
                }}
              >
                {t("settings.unpairConfirm")}
              </Button>
            </div>
          </Card>
        ) : (
          <Button
            full
            variant="ghost"
            icon={<Link2Off size={15} />}
            onClick={() => setConfirmUnpair(true)}
            className="text-[var(--cf-danger-text)]"
          >
            {t("settings.unpair")}
          </Button>
        )}
      </Section>
    </Screen>
  );
}
