import { useRepoStore } from "../state/repoStore";
import { restartAutoFetchCountdown } from "./gitActions";

/**
 * The fetch nobody asked for.
 *
 * "Behind by 3" in the status bar is only as true as the last fetch. Between fetches it is a
 * claim about the past, and the moments it is most likely to be read are exactly the moments the
 * user has just arrived somewhere: the app opening, a repository being picked in the sidebar, a
 * tool being opened from the rail, the window coming back to the front after they were off in a
 * browser. So those arrivals are what this hangs off — see the effects in `App`.
 *
 * Two things make it background rather than merely automatic. It is silent: `fetchSilently` files
 * no notification and raises no toast, so a day of clicking around leaves the bell holding what
 * the user actually did rather than a hundred rows saying the network still works. And it is
 * rate-limited here rather than at the call sites, because the call sites are clicks — a run down
 * the app rail is four arrivals in two seconds, and four `git fetch`es is not what "keep it up to
 * date" means.
 */

/**
 * How long a repository is left alone after a background fetch starts.
 *
 * Chosen against the floor the app already imposes on the *timed* auto-fetch
 * (`MIN_AUTO_FETCH_SECONDS`, 10s): a user clicking through menus should not be able to hit a
 * remote harder than someone who deliberately set the interval as low as the settings screen
 * allows. Comfortably short enough that switching to a repository still feels like it fetches on
 * arrival, which is the point of the whole thing.
 */
const MIN_INTERVAL_MS = 15_000;

/**
 * When each repository was last fetched this way, keyed by path.
 *
 * Per repository rather than one timestamp for the app, because the interval is about being kind
 * to a *remote*: bouncing between two repositories is two remotes, and making the second wait out
 * the first's turn would mean the repository you just switched to is the one that doesn't refresh.
 * Module scope so it survives the remounts that a view switch causes.
 */
const lastStartedAt = new Map<string, number>();

/**
 * How long to wait before trying again when an arrival found the remote busy.
 *
 * Short, because the thing being waited out is another `git` command finishing, and the arrival
 * this rescues is the one that matters most — switching repository while the *previous*
 * repository's fetch is still running, which without a retry would leave the repository you
 * actually landed on unfetched until you happened to click something else.
 */
const RETRY_MS = 2_000;

/** At most one retry pending, so bursts of arrivals don't each queue their own. */
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fetch the active repository, quietly, unless one just happened.
 *
 * Fire-and-forget by design — callers are event handlers and effects, and there is nothing useful
 * for them to await or to do about a failure.
 */
export function backgroundFetch(): void {
  attempt(true);
}

function attempt(mayRetry: boolean): void {
  const { repoPath, remoteOp } = useRepoStore.getState();
  if (!repoPath) return;

  const now = Date.now();
  const last = lastStartedAt.get(repoPath);
  if (last !== undefined && now - last < MIN_INTERVAL_MS) return;

  // Something is already talking to this repository: a pull the user started, or the background
  // fetch belonging to the repository they have just left. Nothing is stamped — no fetch happened,
  // and the next arrival should get a real try rather than sit out an interval on the strength of
  // one that didn't run.
  //
  // Retried rather than dropped, because the arrival most likely to land here is also the one that
  // needs this most: switching repository *is* what starts the fetch that then blocks it. Once
  // only, and back through this same function, so a genuinely long operation is waited out by the
  // user's next click instead of by a timer that keeps re-arming behind them.
  if (remoteOp) {
    if (mayRetry && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attempt(false);
      }, RETRY_MS);
    }
    return;
  }

  // Stamped on the way *out*, not on the way back, and whether or not the fetch succeeds. A
  // remote that is unreachable — no network, VPN down — is precisely the case where retrying on
  // every click costs the most and gains the least.
  lastStartedAt.set(repoPath, now);

  void useRepoStore.getState().fetchSilently();
  // The timed fetch and this one are asking the same question of the same remote, so the pending
  // one is now redundant; same reasoning as an explicit fetch from the status bar.
  restartAutoFetchCountdown();
}
