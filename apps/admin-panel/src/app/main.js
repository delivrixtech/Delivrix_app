import { loadDashboardData } from "../shared/api/client.js";
import { clear, el } from "../shared/ui/dom.js";
import { renderAudit } from "../features/audit-log/audit-log.js";
import { renderFleet } from "../features/sender-nodes/sender-nodes.js";
import { renderOpenClaw } from "../features/openclaw/openclaw.js";
import { renderOverview } from "../features/overview/overview.js";
import { renderReports } from "../features/reports/reports.js";
import { renderSafety } from "../features/settings/settings.js";

const routes = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "openclaw", label: "OpenClaw", render: renderOpenClaw },
  { id: "fleet", label: "Sender nodes", render: renderFleet },
  { id: "audit", label: "Auditoria", render: renderAudit },
  { id: "reports", label: "Reportes", render: renderReports },
  { id: "safety", label: "Seguridad", render: renderSafety }
];

const state = {
  activeRouteId: "overview",
  data: undefined,
  error: undefined,
  loading: true
};

const root = document.querySelector("#app");

renderApp();
void refreshData();

function renderApp() {
  clear(root);

  const app = el("div", { className: "app-shell" }, [
    renderHeader(),
    el("div", { className: "app-body" }, [
      renderSidebar(),
      renderMain()
    ])
  ]);

  root.append(app);
}

function renderHeader() {
  const healthStatus = state.data?.health?.status ?? (state.loading ? "loading" : "offline");
  const overviewState = state.data?.overview?.state ?? "unknown";
  const killSwitchEnabled = state.data?.killSwitch?.enabled === true;

  return el("header", { className: "topbar" }, [
    el("div", { className: "brand-block" }, [
      el("div", { className: "brand-mark", text: "D" }),
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Delivrix Control Plane" }),
        el("h1", { text: "Admin Panel" })
      ])
    ]),
    el("div", { className: "topbar-status" }, [
      statusPill("Gateway", healthStatus),
      statusPill("Operacion", overviewState),
      statusPill("Kill switch", killSwitchEnabled ? "active_true" : "inactive")
    ])
  ]);
}

function renderSidebar() {
  return el("aside", { className: "sidebar" }, [
    el("nav", { className: "nav-list", attrs: { "aria-label": "Admin panel sections" } }, routes.map((route) => {
      const button = el("button", {
        className: route.id === state.activeRouteId ? "nav-item nav-item-active" : "nav-item",
        text: route.label,
        attrs: { type: "button" }
      });

      button.addEventListener("click", () => {
        state.activeRouteId = route.id;
        renderApp();
      });

      return button;
    })),
    el("div", { className: "sidebar-foot" }, [
      el("span", { className: "badge badge-neutral", text: "GET-only" }),
      el("p", { text: "Delivrix LLC - Desarrollado por JECT" })
    ])
  ]);
}

function renderMain() {
  if (state.loading) {
    return el("main", { className: "content" }, [
      renderSkeleton()
    ]);
  }

  if (state.error) {
    return el("main", { className: "content" }, [
      el("section", { className: "notice notice-critical" }, [
        el("div", {}, [
          el("h2", { text: "Gateway no disponible" }),
          el("p", { text: state.error })
        ]),
        refreshButton()
      ])
    ]);
  }

  const route = routes.find((candidate) => candidate.id === state.activeRouteId) ?? routes[0];
  return el("main", { className: "content" }, [
    route.render(state.data, { refreshButton })
  ]);
}

function renderSkeleton() {
  return el("section", { className: "skeleton-grid" }, [
    el("div", { className: "skeleton skeleton-wide" }),
    el("div", { className: "skeleton" }),
    el("div", { className: "skeleton" }),
    el("div", { className: "skeleton skeleton-table" })
  ]);
}

function refreshButton() {
  const button = el("button", {
    className: "button button-secondary",
    text: "Actualizar",
    attrs: { type: "button" }
  });

  button.addEventListener("click", () => {
    void refreshData();
  });

  return button;
}

async function refreshData() {
  state.loading = true;
  state.error = undefined;
  renderApp();

  try {
    state.data = await loadDashboardData();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "No se pudo cargar el panel.";
  } finally {
    state.loading = false;
    renderApp();
  }
}

function statusPill(label, value) {
  const tone = toneFor(value);
  return el("span", { className: `status-pill status-${tone}` }, [
    el("span", { className: "status-dot" }),
    el("span", { text: label }),
    el("strong", { text: String(value).replaceAll("_", " ") })
  ]);
}

function toneFor(value) {
  const normalized = String(value ?? "").toLowerCase();

  if (["critical", "active_true", "offline", "blocked"].includes(normalized)) {
    return "critical";
  }

  if (["warning", "loading", "needs_review"].includes(normalized)) {
    return "warning";
  }

  if (["ok", "healthy", "inactive", "ready"].includes(normalized)) {
    return "success";
  }

  return "neutral";
}
