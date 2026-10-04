import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/index.css";

// `npm run dev:mock` only: fake the Rust side so the UI runs in a plain browser.
// MODE is replaced at build time, so this branch (and its chunk) is dropped from real builds;
// scripts/check-bundle.mjs fails the build if it ever leaks.
if (import.meta.env.MODE === "mock") {
  await import("@/dev/mock-ipc");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
