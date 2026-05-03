import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatDateTime, formatNumber, stateTone } from "../../shared/lib/formatters.js";

export function renderClusters(data) {
  const clusters = data.clusters;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: clusters.phase }),
        el("h2", { text: clusters.title })
      ]),
      badge(clusters.mode, "neutral")
    ]),
    el("section", { className: "notice" }, [
      el("div", {}, [
        el("h3", { text: clusters.summary }),
        el("p", { text: `Contrato generado ${formatDateTime(clusters.generatedAt)}` })
      ]),
      badge("Backend contract", "success")
    ]),
    renderClusterMetrics(clusters),
    renderManagementScope(clusters.managementScope),
    renderDelegation(clusters.openClawDelegation),
    el("section", { className: "workflow-list" }, clusters.clusters.map((cluster, index) => renderCluster(cluster, index))),
    renderNextActions(clusters.nextActions),
    renderSafety(clusters.safety)
  ]);
}

function renderClusterMetrics(clusters) {
  return el("section", { className: "metric-grid metric-grid-compact" }, [
    smallStat("Clusters", clusters.totals.clusters, "neutral"),
    smallStat("Sender nodes", clusters.totals.senderNodes, "success"),
    smallStat("Activos/warming", clusters.totals.activeOrWarmingNodes, "success"),
    smallStat("Bloqueados", clusters.totals.blockedNodes, clusters.totals.blockedNodes > 0 ? "critical" : "neutral")
  ]);
}

function renderManagementScope(scope) {
  return el("section", { className: "two-column" }, [
    renderTokenPanel("OpenClaw administra", scope.openClawOwns, "success"),
    renderTokenPanel("Humano aprueba", scope.humanOwns, "warning"),
    renderTokenPanel("Objetivo actual", [scope.currentGoal], "neutral"),
    renderTokenPanel("Fuera del MVP", scope.notInMvp, "critical")
  ]);
}

function renderDelegation(delegation) {
  return el("section", { className: "two-column" }, [
    renderTokenPanel("Puede observar", delegation.canObserve, "success"),
    renderTokenPanel("Puede proponer", delegation.canPropose, "success"),
    renderTokenPanel("Requiere aprobacion", delegation.requiresHumanApproval, "warning"),
    renderTokenPanel("Bloqueado en MVP", delegation.blockedInMvp, "critical")
  ]);
}

function renderCluster(cluster, index) {
  return el("article", { className: `workflow-step workflow-${stateTone(cluster.managementState)}` }, [
    el("div", { className: "workflow-step-index", text: String(index + 1) }),
    el("div", { className: "workflow-step-body" }, [
      el("div", { className: "workflow-step-head" }, [
        el("div", {}, [
          el("h3", { text: cluster.label }),
          el("p", { text: cluster.managementStateReason })
        ]),
        badge(compactLabel(cluster.managementState), stateTone(cluster.managementState))
      ]),
      el("div", { className: "workflow-grid" }, [
        renderTokens("Gates", cluster.readinessGates),
        renderTokens("Dry-runs", cluster.provisioningRunIds.length > 0 ? cluster.provisioningRunIds : ["sin dry-runs registrados"])
      ]),
      cluster.senderNodes.length > 0 ? renderSenderNodeTable(cluster.senderNodes) : renderEmptyState("Sin VPS/sender nodes registrados en este cluster.")
    ])
  ]);
}

function renderSenderNodeTable(nodes) {
  return el("div", { className: "table-wrap" }, [
    el("table", { className: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Nodo" }),
          el("th", { text: "Estado" }),
          el("th", { text: "Health" }),
          el("th", { text: "Limite" }),
          el("th", { text: "Host/IP" }),
          el("th", { text: "Razones" })
        ])
      ]),
      el("tbody", {}, nodes.map((node) => (
        el("tr", {}, [
          el("td", {}, [
            el("strong", { text: node.label }),
            el("p", { className: "workflow-reason", text: node.id })
          ]),
          el("td", {}, [badge(compactLabel(node.status), stateTone(node.status))]),
          el("td", {}, [badge(node.healthSeverity, stateTone(node.healthSeverity))]),
          el("td", { text: `${formatNumber(node.dailyLimit)} / dia` }),
          el("td", { text: [node.hostname, node.ipAddress].filter(Boolean).join(" / ") || "pendiente" }),
          el("td", { text: node.healthReasons.join(", ") })
        ])
      )))
    ])
  ]);
}

function renderNextActions(actions) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Siguientes acciones" }),
      badge(formatNumber(actions.length), "neutral")
    ]),
    el("div", { className: "action-list" }, actions.map((action) => (
      el("div", { className: "action-row" }, [
        badge(compactLabel(action.status), stateTone(action.status)),
        el("div", {}, [
          el("strong", { text: action.label }),
          el("p", { text: `${compactLabel(action.owner)} - ${compactLabel(action.mode)}${action.blockedInMvp ? " - bloqueado en MVP" : ""}` })
        ])
      ])
    )))
  ]);
}

function renderSafety(safety) {
  return renderTokenPanel("Frontera de seguridad", Object.entries(safety).map(([key, value]) => `${compactLabel(key)}: ${String(value)}`), "critical");
}

function renderTokenPanel(title, items, tone) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: title }),
      badge(formatNumber(items.length), tone)
    ]),
    el("div", { className: "token-grid" }, items.map((item) => badge(compactLabel(item), tone === "critical" ? "neutral" : "neutral")))
  ]);
}

function renderTokens(title, items) {
  return el("div", { className: "workflow-token-group" }, [
    el("strong", { text: title }),
    el("div", { className: "token-grid" }, items.map((item) => badge(compactLabel(item), "neutral")))
  ]);
}

function renderEmptyState(message) {
  return el("div", { className: "empty-state" }, [
    el("strong", { text: message }),
    el("span", { text: "Completa onboarding/provisioning dry-run para alimentar este contrato." })
  ]);
}

function smallStat(label, value, tone) {
  return el("article", { className: `metric-card metric-${tone}` }, [
    el("span", { className: "metric-label", text: label }),
    el("strong", { className: "metric-value", text: formatNumber(value) }),
    el("span", { className: "metric-meta", text: "Gateway source" })
  ]);
}
