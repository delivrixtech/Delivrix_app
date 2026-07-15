// Tipografia UNICA del sitio (decision 2026-07-14, direccion Aivora): Inter
// (variable, self-host 100% offline via @fontsource — sin Google Fonts).
// UNA sola familia en TODO el panel, sin mezcla: fuera Montserrat, JetBrains
// Mono y Satoshi. Los tokens --font-* (incluido --font-mono) apuntan todos a
// Inter en tokens.css; los numeros usan font-variant-numeric:tabular-nums.
import "@fontsource-variable/inter";

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
