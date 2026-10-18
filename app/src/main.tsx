import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

createRoot(document.getElementById("root")!).render(
<StrictMode>
<ErrorBoundary>
<App />
</ErrorBoundary>
</StrictMode>
);

// --- PWA: register service worker for installability + offline shell ---
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => { // v21.1.1 [audit D9]: base-relative (subpath deploys pe /sw.js 404)
      console.warn("SW registration failed:", err);
    });
  });
}
