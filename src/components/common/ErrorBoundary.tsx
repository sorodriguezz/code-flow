import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { translate } from "../../state/languageStore";

/**
 * The last thing between a thrown render and a blank window.
 *
 * React unmounts the entire tree when a render throws and nothing catches it — not the subtree, the
 * *whole* tree. Without a boundary anywhere, one bad value in one component left this app as an
 * empty white rectangle with a title bar, and the only way out was to quit and relaunch. That is
 * the "se crashea mal hasta cerrarla" half of the report, and it is a class component because an
 * error boundary is the one thing hooks still cannot express.
 *
 * Two levels are mounted, on purpose:
 *
 *  - one around each **view**, so a broken screen is a recoverable panel inside a window whose
 *    sidebar, tab bar and status bar all still work — you can walk away to another view;
 *  - one around the **whole app**, which catches a throw in the shell itself, where there is
 *    nowhere left to walk to and reloading the webview is the honest offer.
 *
 * `resetKey` is what makes "try again" mean anything for the inner ones: changing it clears the
 * error, so navigating to another view and back gives the subtree a genuinely fresh mount rather
 * than re-rendering the same state that just threw.
 */
interface Props {
  children: ReactNode;
  /** Changing this clears a caught error — see the note above. */
  resetKey?: string;
  /** `true` for the outermost boundary, which offers a reload instead of a retry. */
  fatal?: boolean;
  /** Names the thing that broke, for the message. Defaults to the generic wording. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    // A new subtree deserves a fresh chance; the old error described the old one.
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place this can go that survives the render being torn down. A toast
    // would need a working React tree, which is exactly what we do not have.
    console.error("[codeflow] render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const detail = `${error.message || String(error)}`;

    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 overflow-auto bg-[var(--cf-bg)] p-6 text-center">
        <TriangleAlert size={22} className="shrink-0 text-[var(--cf-danger)]" />
        <p className="text-[13px] font-medium text-[var(--cf-text)]">
          {this.props.label
            ? translate("error.boundaryTitleNamed", { name: this.props.label })
            : translate("error.boundaryTitle")}
        </p>
        <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {this.props.fatal
            ? translate("error.boundaryFatalHint")
            : translate("error.boundaryViewHint")}
        </p>

        {/* Selectable, unlike the rest of the app's chrome: this is the one string worth pasting
            into a bug report, and `user-select: none` on the body would otherwise prevent it. */}
        <pre className="max-h-40 max-w-full select-text overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-left font-mono text-[11px] text-[var(--cf-text-muted)]">
          {detail}
        </pre>

        <div className="flex items-center gap-2">
          {!this.props.fatal && (
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={12} />
              {translate("error.boundaryRetry")}
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            <RefreshCw size={12} />
            {translate("error.boundaryReload")}
          </button>
        </div>
      </div>
    );
  }
}
