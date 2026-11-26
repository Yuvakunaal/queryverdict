import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface Props {
  children: ReactNode;
  /** Accessible name of the region, announced when focus moves to it after a retry. */
  label?: string;
}

interface State {
  failed: boolean;
}

/**
 * Contains rendering failures (docs/ARCHITECTURE.md §21): shows a recoverable panel and never
 * tears down anything outside React. Error details are not displayed, because later modules may
 * render user data and a message could contain it. After a successful retry, focus moves to the
 * region itself (the Try again button no longer exists), so keyboard and screen-reader users are
 * not left on <body>.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  private readonly region = createRef<HTMLDivElement>();

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // Local developer diagnostics only; nothing leaves the device.
    console.error('QueryVerdict view error', error, info.componentStack);
  }

  override componentDidUpdate(_prevProps: Props, prevState: State) {
    if (prevState.failed && !this.state.failed) this.region.current?.focus();
  }

  override render() {
    return (
      <div ref={this.region} tabIndex={-1} role="group" aria-label={this.props.label ?? 'View'} className="boundary">
        {this.state.failed ? (
          <div role="alert" className="error-panel">
            <p style={{ marginTop: 0 }}>This part of the interface stopped working. Your session is unchanged.</p>
            <Button onClick={() => this.setState({ failed: false })}>Try again</Button>
          </div>
        ) : (
          this.props.children
        )}
      </div>
    );
  }
}
