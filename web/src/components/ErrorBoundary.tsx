import { Component, type ReactNode } from 'react';

/** Keeps a rendering bug from blanking the whole app; offers a reload instead. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-screen place-items-center p-6 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
          <p className="text-sm text-muted">The page hit an unexpected error. Your saved pipelines are safe; reload to continue.</p>
          <pre className="overflow-auto rounded bg-surface p-2 text-left text-xs text-muted">{this.state.error.message}</pre>
          <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
