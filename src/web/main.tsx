import { initializeOffline, getSyncStatus, subscribeSync } from "./offline";
import { SyncPanel } from "./SyncPanel";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { ThemeProvider } from "./theme";

class ErrorBoundary extends React.Component<{
  children: React.ReactNode
}, {
  error: Error | null
}> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[OpenOutliner] Render error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: "#dc2626", fontFamily: "monospace" }}>
          <h2 style={{ margin: "0 0 16px" }}>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{this.state.error.message}\n\n{this.state.error.stack}</pre>
          <button
            style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}
            onClick={() => this.setState({ error: null })}
          >Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <OfflineApp />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

function OfflineApp() {
  const ready = React.useSyncExternalStore(subscribeSync, () => getSyncStatus().ready);
  return <><SyncPanel />{ready && <App />}</>;
}
void initializeOffline().catch(error => console.error("Offline initialization failed", error));
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then(async () => {
      const registration = await navigator.serviceWorker.ready;
      const cacheVisitedAssets = () => registration.active?.postMessage({
        type: "CACHE_VISITED_ASSETS",
        urls: performance.getEntriesByType("resource").map(entry => entry.name)
      });
      cacheVisitedAssets();
      await document.fonts.ready;
      cacheVisitedAssets();
    }).catch(error => console.error("Offline page cache failed", error));
  });
}
