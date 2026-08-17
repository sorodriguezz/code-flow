import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * The last thing between a thrown render and a white screen.
 *
 * # Why this client needs one and the desktop mostly does not
 *
 * React 19 unmounts the whole tree when nothing catches. On the desktop that is a bad afternoon; on
 * a phone across the room it is indistinguishable from the server being down, the pairing being
 * revoked, or the wifi having dropped — the three things the user will actually go and check, none
 * of which is the problem. Every report of "the app is too buggy" that ends in a blank page ends
 * here.
 *
 * The most likely throw is not a bug in a screen. It is a chunk that no longer exists: the entry
 * document names its JavaScript by content hash, so a desktop rebuilt under a phone that still has
 * the old page asks for files that are gone. `React.lazy` **memoises the rejected thenable**, so
 * re-rendering the same lazy component will never retry — which is why the recovery offered here is
 * a reload and not a "try again" that re-renders. There is nothing to retry in this process.
 */
interface Props {
  children: ReactNode;
  /** Drawn instead of the full-screen layout when this boundary wraps only part of the app. */
  compact?: boolean;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // To the browser console and nowhere else. There is no crash reporter here, and the phone's
    // console is reachable over USB debugging — which is exactly who this line is for.
    console.error("[codeflow] render failed", error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;

    return (
      <div
        className={`flex flex-col items-center justify-center gap-3 px-8 text-center ${
          this.props.compact ? "flex-1 py-10" : "min-h-full"
        }`}
      >
        <p className="text-[14px] text-[var(--cf-text)]">{t("error.crashed")}</p>
        {/* The message verbatim, small and muted. It is usually a module URL, which is the one
            detail that tells the reader this is a stale page rather than a broken feature. */}
        <p className="max-w-[22rem] break-words font-mono text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {this.state.message}
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="cf-tap rounded-lg bg-[var(--cf-accent)] px-5 text-[14px] font-medium text-white"
        >
          {t("error.reload")}
        </button>
      </div>
    );
  }
}
