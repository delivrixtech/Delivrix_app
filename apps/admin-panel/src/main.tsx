// Fonts (rebrand B/W 2026-05-28, empaquetado offline 2026-07-13):
// Montserrat (heading H1/H2, UI, body, caption + italic para HumanNote) y
// JetBrains Mono (datos/audit/code). Una sola familia de marca, servida
// 100% offline via @fontsource — sin Google Fonts ni fallback a system-ui.
import "@fontsource-variable/montserrat/index.css";
import "@fontsource-variable/montserrat/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";

import "@xyflow/react/dist/style.css";
import "./app/tokens.css";
import "./app/globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

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
      <App />
    </QueryClientProvider>
  </StrictMode>
);
