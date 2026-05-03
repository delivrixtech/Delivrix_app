import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatNumber, stateTone } from "../../shared/lib/formatters.js";

export function renderFleet(data) {
  const health = data.overview.health;
  const summary = data.overview.summary;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Fleet" }),
        el("h2", { text: "Sender nodes" })
      ]),
      badge("Read-only", "neutral")
    ]),
    el("section", { className: "panel" }, [
      el("div", { className: "panel-heading" }, [
        el("h3", { text: "Estado por nodo" }),
        badge(`${health.length}`, "neutral")
      ]),
      health.length > 0 ? renderHealthTable(health) : renderEmptyState("Sin sender nodes en el overview.")
    ]),
    el("section", { className: "panel" }, [
      el("div", { className: "panel-heading" }, [
        el("h3", { text: "Capacidad por estado" }),
        badge(formatNumber(summary.totals.senderNodes), "neutral")
      ]),
      el("div", { className: "token-grid" }, Object.entries(summary.senderNodesByStatus).map(([status, count]) => (
        badge(`${compactLabel(status)}: ${formatNumber(count)}`, stateTone(status))
      )))
    ])
  ]);
}

function renderHealthTable(health) {
  return el("div", { className: "table-wrap" }, [
    el("table", { className: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Sender node" }),
          el("th", { text: "Actual" }),
          el("th", { text: "Recomendado" }),
          el("th", { text: "Severidad" }),
          el("th", { text: "Metricas" }),
          el("th", { text: "Razones" })
        ])
      ]),
      el("tbody", {}, health.map((decision) => (
        el("tr", {}, [
          el("td", { text: decision.senderNodeId }),
          el("td", {}, [badge(compactLabel(decision.currentStatus), stateTone(decision.currentStatus))]),
          el("td", {}, [badge(compactLabel(decision.recommendedStatus), stateTone(decision.recommendedStatus))]),
          el("td", {}, [badge(decision.severity, stateTone(decision.severity))]),
          el("td", { text: metricText(decision.metrics) }),
          el("td", { text: decision.reasons.join(", ") || "none" })
        ])
      )))
    ])
  ]);
}

function metricText(metrics) {
  return [
    `sent ${metrics.sent}`,
    `bounce ${metrics.bounce}`,
    `complaint ${metrics.complaint}`,
    `deferred ${metrics.deferred}`,
    `failed ${metrics.failed}`
  ].join(" / ");
}

function renderEmptyState(message) {
  return el("div", { className: "empty-state" }, [
    el("strong", { text: message }),
    el("span", { text: "El Gateway no expuso nodos para lectura en este momento." })
  ]);
}
