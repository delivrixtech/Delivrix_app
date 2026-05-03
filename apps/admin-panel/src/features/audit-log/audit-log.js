import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatDateTime, stateTone } from "../../shared/lib/formatters.js";

export function renderAudit(data) {
  const events = data.overview.recentAuditEvents;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Trazabilidad" }),
        el("h2", { text: "Auditoria reciente" })
      ]),
      badge(`${events.length}`, "neutral")
    ]),
    el("section", { className: "panel" }, [
      events.length > 0 ? renderAuditTable(events) : el("div", { className: "empty-state" }, [
        el("strong", { text: "Sin eventos recientes" }),
        el("span", { text: "El audit log no tiene eventos para mostrar en el overview." })
      ])
    ])
  ]);
}

function renderAuditTable(events) {
  return el("div", { className: "table-wrap" }, [
    el("table", { className: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Hora" }),
          el("th", { text: "Actor" }),
          el("th", { text: "Accion" }),
          el("th", { text: "Target" }),
          el("th", { text: "Riesgo" })
        ])
      ]),
      el("tbody", {}, events.map((event) => (
        el("tr", {}, [
          el("td", { text: formatDateTime(event.occurredAt) }),
          el("td", { text: `${event.actorType}:${event.actorId}` }),
          el("td", { text: compactLabel(event.action) }),
          el("td", { text: `${event.targetType}:${event.targetId}` }),
          el("td", {}, [badge(event.riskLevel, stateTone(event.riskLevel))])
        ])
      )))
    ])
  ]);
}
