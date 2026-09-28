import { Archive, ArrowUpFromLine, Undo2 } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { toastInfo } from "../toast";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Card, Divider, Section } from "../ui/List";
import { EmptyState } from "../ui/Feedback";
import { ConfirmAction } from "../ui/ConfirmAction";
import type { StashInfo } from "../../types/domain";

/**
 * The stash, and the two ways of bringing work back out of it.
 *
 * Apply and pop, each behind a confirmation: both write the working tree under whoever is at the
 * desk, and a pop also takes the entry off the list. Dropping an entry — the one verb that throws
 * work away — is not here, nor in the server's allowlist.
 *
 * Each call names the stash by position *and* by commit: the desktop refuses when `stash@{n}` is no
 * longer the entry this list showed (a stash pushed at the desk since shifts every index), and the
 * screen re-reads instead of acting on a neighbour. See `stash_apply` in `remotectl/dispatch.rs`.
 */

/** What the desktop answers when the list moved under this screen. Mirrors `STASH_MOVED`. */
const STASH_MOVED = "stash_moved";

function StashItem({ repoPath, stash }: { repoPath: string; stash: StashInfo }) {
  const run = useMobileStore((s) => s.run);
  const refreshRepo = useMobileStore((s) => s.refreshRepo);
  // `repo`, like everything else that writes the working tree: a pop racing a commit is exactly the
  // pair of actions that must wait for each other.
  const busy = useBusy("repo");

  const act = (cmd: "stash_apply" | "stash_pop", success: string) =>
    void run(
      async () => {
        try {
          await rpc<void>(cmd, { repoPath, index: stash.index, oid: stash.oid });
        } catch (e) {
          if (e instanceof Error && e.message === STASH_MOVED) {
            toastInfo(t("stash.moved"));
            await refreshRepo();
            return;
          }
          throw e;
        }
        await refreshRepo();
      },
      "repo",
      success,
    );

  return (
    <div className="px-3 py-2.5">
      <p className="text-md leading-snug">{stash.message}</p>
      <p className="mt-0.5 font-mono text-2xs text-[var(--cf-text-faint)]">
        {`stash@{${stash.index}}`} · {stash.oid.slice(0, 7)}
      </p>
      <div className="mt-2 flex gap-2">
        <ConfirmAction
          label={t("stash.apply")}
          confirmLabel={t("stash.applyConfirm")}
          icon={<Undo2 size={13} />}
          variant="primary"
          disabled={busy}
          onConfirm={() => act("stash_apply", t("toast.stashApplied"))}
        />
        <ConfirmAction
          label={t("stash.pop")}
          confirmLabel={t("stash.popConfirm")}
          icon={<ArrowUpFromLine size={13} />}
          variant="secondary"
          disabled={busy}
          onConfirm={() => act("stash_pop", t("toast.stashPopped"))}
        />
      </div>
    </div>
  );
}

export function StashScreen({ repoPath }: { repoPath: string }) {
  const stashes = useMobileStore((s) => s.stashes);
  const refreshRepo = useMobileStore((s) => s.refreshRepo);

  return (
    <Screen bar={<PushBar title={t("stash.title")} />} onRefresh={() => refreshRepo()}>
      {stashes.length === 0 ? (
        <EmptyState icon={<Archive size={26} aria-hidden />} title={t("stash.none")} />
      ) : (
        <Section>
          <Card>
            {stashes.map((stash, index) => (
              <div key={stash.oid}>
                {index > 0 && <Divider />}
                <StashItem repoPath={repoPath} stash={stash} />
              </div>
            ))}
          </Card>
        </Section>
      )}
    </Screen>
  );
}
