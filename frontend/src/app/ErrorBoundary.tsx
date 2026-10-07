import { Component, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  label: string;
  resetKey?: string;
  renderFallback?: (error: Error, retry: () => void) => ReactNode;
};
type State = { error: Error | null };

// Compact fallback for narrow panel boundaries. States which panel failed and
// that the rest of the board is unaffected, so a scoped retry is trustworthy.
export function PanelError({ id, title, message, onRetry }: { id?: string; title: string; message: string; onRetry: () => void }) {
  return (
    <div id={id} className="panel" role="alert" aria-label={title}>
      <h2>{title}</h2>
      <p>This panel hit an unexpected error. The rest of the board is unaffected.</p>
      <p className="empty-copy">{message}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Message emission before a crashed unhandled state: keep the error
    // visible in devtools even when the fallback UI is showing.
    console.error(`maia-board crashed view [${this.props.label}]:`, error);
  }

  componentDidUpdate(prevProps: Props) {
    // Narrow boundaries recover on navigation: new content deserves a fresh
    // render attempt instead of a stale fallback. Same-content failures stay
    // behind the manual retry; nothing re-renders in a loop by itself.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = () => this.setState({ error: null });

  private reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.renderFallback) return this.props.renderFallback(this.state.error, this.reset);
    return (
      <div className="app-shell">
        <main>
          <section className="panel" role="alert" aria-label="Application error">
            <h1>Something went wrong</h1>
            <p>The board hit an unexpected error instead of its normal message. Your saved games stay on this device and on the server.</p>
            <p className="empty-copy">{this.state.error.message || 'Unknown rendering error.'}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={this.reset}>Try again</button>
              <button type="button" onClick={this.reload}>Reload page</button>
            </div>
          </section>
        </main>
      </div>
    );
  }
}
