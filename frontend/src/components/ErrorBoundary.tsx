// Last line of defence: if a component crashes, show a friendly message with a
// reload button instead of a blank page, and report the crash (if Sentry is on).
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/monitoring";

interface State {
  failed: boolean;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The viewer hit an unexpected problem. Reloading the page usually fixes it.</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
