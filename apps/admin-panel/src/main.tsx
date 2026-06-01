// Fonts (consolidación 2026-05-24): Funnel Sans (display H1/H2 ≥24px),
// Geist (body + UI + caption con tracking-wider), IBM Plex Mono (data/code).
// Inter eliminado para evitar 3-sans-stack que se sentía AI-generated.
// Offline-first via @fontsource.
import "@fontsource/funnel-sans/400.css";
import "@fontsource/funnel-sans/500.css";
import "@fontsource/funnel-sans/600.css";
import "@fontsource/funnel-sans/700.css";
import "@fontsource-variable/geist/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import "@xyflow/react/dist/style.css";
import "./app/tokens.css";
import "./app/globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppV5 } from "./v5/App.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
});

const rootElement = document.querySelector("#app");

if (!rootElement) {
  throw new Error("Admin panel root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppV5 />
    </QueryClientProvider>
  </StrictMode>
);
