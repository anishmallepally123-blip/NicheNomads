import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import App from "./App";
import NicheChat from "./chat/NicheChat";
import Home from "./home/Home";
import ErrorBoundary from "./components/ErrorBoundary";
import { initMonitoring, reportError } from "./lib/monitoring";
import "./styles.css";

initMonitoring().catch((err) => console.warn("Error reporting is off:", err));
window.addEventListener("unhandledrejection", (e) => {
  if ((e.reason as Error | undefined)?.name !== "AbortError") reportError(e.reason);
});

// The homepage shows only on a bare address. Any link with a position (or an
// embed) opens the viewer directly, so shared links keep working.
const homeContext = () => ({ page: "homepage: search box for a sky position or object name, list of challenge targets" });

const Space3D = lazy(() => import("./space3d/Space3D"));
const wants3d = () => new URLSearchParams(window.location.search).get("view") === "3d";

const wantsViewer = () => {
  const p = new URLSearchParams(window.location.search);
  return p.has("ra") || p.has("dec") || p.has("embed");
};

function Root() {
  const [viewer, setViewer] = useState(wantsViewer);
  useEffect(() => {
    const onPop = () => setViewer(wantsViewer());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  if (viewer) return <App />;
  if (wants3d()) return <Suspense fallback={null}><Space3D /></Suspense>;
  return (
    <>
    <NicheChat context={homeContext} />
    <Home
      onGo={({ ra, dec, band }) => {
        const p = new URLSearchParams({ ra: ra.toFixed(6), dec: dec.toFixed(6) });
        if (band) p.set("band", String(band));
        window.history.pushState(null, "", `${window.location.pathname}?${p}`);
        window.scrollTo(0, 0);
        setViewer(true);
      }}
    />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
