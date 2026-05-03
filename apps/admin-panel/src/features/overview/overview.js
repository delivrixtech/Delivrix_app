import { badge, el } from "../../shared/ui/dom.js";
import {
  compactLabel,
  formatDateTime,
  formatNumber,
  percent,
  stateTone
} from "../../shared/lib/formatters.js";

export function renderOverview(data, actions) {
  const overview = data.overview;
  const summary = overview.summary;
  const jobs = summary.jobsByStatus;
  const results = summary.sendResultsByStatus;
  const nodes = summary.senderNodesByStatus;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Operacion" }),
        el("h2", { text: "Overview" })
      ]),
      actions.refreshButton()
    ]),
    el("section", { className: "metric-grid" }, [
      metricCard("Estado", compactLabel(overview.state), `Generado ${formatDateTime(overview.generatedAt)}`, stateTone(overview.state)),
      metricCard("Sender nodes", formatNumber(summary.totals.senderNodes), `${formatNumber(nodes.active + nodes.warming)} disponibles`, nodes.quarantined > 0 ? "critical" : nodes.degraded > 0 ? "warning" : "success"),
      metricCard("Jobs", formatNumber(summary.totals.jobs), `${formatNumber(jobs.blocked)} bloqueados`, jobs.blocked > 0 ? "warning" : "success"),
      metricCard("Resultados", formatNumber(summary.totals.sendResults), `${formatNumber(results.complaint)} complaints`, results.complaint > 0 ? "critical" : results.bounce > 0 ? "warning" : "success")
    ]),
    renderAlerts(overview.alerts),
    el("section", { className: "two-column" }, [
      renderStatusDistribution("Jobs", jobs),
      renderStatusDistribution("Sender nodes", nodes)
    ]),
    renderResultBars(results, summary.totals.sendResults)
  ]);
}

function metricCard(label, value, meta, tone) {
  return el("article", { className: `metric-card metric-${tone}` }, [
    el("span", { className: "metric-label", text: label }),
    el("strong", { className: "metric-value", text: value }),
    el("span", { className: "metric-meta", text: meta })
  ]);
}

function renderAlerts(alerts) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Alertas" }),
      badge(`${alerts.length}`, "neutral")
    ]),
    el("div", { className: "alert-list" }, alerts.map((alert) => (
      el("article", { className: `alert-row alert-${alert.severity}` }, [
        badge(alert.severity, stateTone(alert.severity)),
        el("div", {}, [
          el("strong", { text: alert.title }),
          el("p", { text: alert.message })
        ])
      ])
    )))
  ]);
}

function renderStatusDistribution(title, counts) {
  const entries = Object.entries(counts);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);

  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: title }),
      badge(formatNumber(total), "neutral")
    ]),
    el("div", { className: "status-list" }, entries.map(([key, value]) => (
      el("div", { className: "status-row" }, [
        el("span", { text: compactLabel(key) }),
        el("div", { className: "bar-track" }, [
          el("span", {
            className: `bar-fill bar-${stateTone(key)}`,
            attrs: { style: `width:${percent(value, total)}%` }
          })
        ]),
        el("strong", { text: formatNumber(value) })
      ])
    )))
  ]);
}

function renderResultBars(results, total) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Resultados simulados" }),
      badge("SMTP real apagado", "neutral")
    ]),
    el("div", { className: "result-strip" }, Object.entries(results).map(([key, value]) => (
      el("div", { className: "result-item" }, [
        el("span", { text: compactLabel(key) }),
        el("strong", { text: `${formatNumber(value)} / ${percent(value, total)}%` })
      ])
    )))
  ]);
}
