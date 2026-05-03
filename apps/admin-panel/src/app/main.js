import { loadDashboardData } from "../shared/api/client.js";
import { clear, el } from "../shared/ui/dom.js";
import { renderAudit } from "../features/audit-log/audit-log.js";
import { renderClusters } from "../features/clusters/clusters.js";
import { renderLearning } from "../features/learning/learning.js";
import { renderFleet } from "../features/sender-nodes/sender-nodes.js";
import { renderOpenClaw } from "../features/openclaw/openclaw.js";
import { renderOverview } from "../features/overview/overview.js";
import { renderReports } from "../features/reports/reports.js";
import { renderSafety } from "../features/settings/settings.js";
import { renderWorkflow } from "../features/workflow/workflow.js";

const routeRenderers = {
  workflow: renderWorkflow,
  overview: renderOverview,
  openclaw: renderOpenClaw,
  clusters: renderClusters,
  fleet: renderFleet,
  audit: renderAudit,
  learning: renderLearning,
  reports: renderReports,
  safety: renderSafety
};

const fallbackSteps = [
  { id: "workflow", navLabel: "Ruta", status: "ready" },
  { id: "overview", navLabel: "Overview", status: "ready" },
  { id: "openclaw", navLabel: "OpenClaw", status: "ready" },
  { id: "clusters", navLabel: "Clusters", status: "ready" },
  { id: "fleet", navLabel: "Sender nodes", status: "ready" },
  { id: "audit", navLabel: "Auditoria", status: "ready" },
  { id: "learning", navLabel: "Aprendizaje", status: "needs_review" },
  { id: "reports", navLabel: "Reportes", status: "needs_review" },
  { id: "safety", navLabel: "Seguridad", status: "ready" }
];

const state = {
  activeRouteId: "workflow",
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
  const steps = navigationSteps();

  return el("aside", { className: "sidebar" }, [
    el("nav", { className: "nav-list", attrs: { "aria-label": "Admin panel sections" } }, steps.map((route) => {
      const button = el("button", {
        className: route.id === state.activeRouteId ? "nav-item nav-item-active" : "nav-item",
        attrs: { type: "button" }
      }, [
        el("span", { text: route.navLabel }),
        el("span", { className: `nav-status nav-status-${toneFor(route.status)}` })
      ]);

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

  const steps = navigationSteps();
  const route = steps.find((candidate) => candidate.id === state.activeRouteId) ?? steps[0];
  const renderer = routeRenderers[route.id] ?? renderWorkflow;
  return el("main", { className: "content" }, [
    renderer(state.data, { refreshButton, step: route })
  ]);
}

function navigationSteps() {
  return state.data?.workflow?.steps ?? fallbackSteps;
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
