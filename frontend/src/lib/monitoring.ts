// Optional error reporting with Sentry. Does nothing unless VITE_SENTRY_DSN is
// set at build time, so local development and forks need no account.
import type { ErrorInfo } from "react";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

type SentryModule = typeof import("@sentry/react");
let sentry: SentryModule | null = null;

export async function initMonitoring() {
  if (!DSN) return;
  // Loaded on demand so the SDK is not in the main bundle when unused.
  sentry = await import("@sentry/react");
  sentry.init({
    dsn: DSN,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Aborted requests happen every time the user moves the view; not errors.
    ignoreErrors: ["AbortError", "The user aborted a request", "signal is aborted"],
  });
}

export function reportError(error: unknown, info?: ErrorInfo) {
  console.error(error);
  sentry?.captureException(error, info ? { extra: { componentStack: info.componentStack } } : undefined);
}
