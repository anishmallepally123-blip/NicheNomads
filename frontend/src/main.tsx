import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { initMonitoring, reportError } from "./lib/monitoring";
import "./styles.css";

initMonitoring().catch((err) => console.warn("Error reporting is off:", err));
window.addEventListener("unhandledrejection", (e) => {
  if ((e.reason as Error | undefined)?.name !== "AbortError") reportError(e.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
