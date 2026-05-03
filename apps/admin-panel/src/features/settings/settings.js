import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatDateTime, stateTone } from "../../shared/lib/formatters.js";

export function renderSafety(data) {
  const killSwitch = data.killSwitch;
  const north = data.operatingNorth;
  const health = data.health;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Safety" }),
        el("h2", { text: "Seguridad operacional" })
      ]),
      badge("Sin mutaciones", "neutral")
    ]),
    el("section", { className: "metric-grid metric-grid-compact" }, [
      statusCard("Kill switch", killSwitch.enabled ? "active" : "inactive", killSwitch.reason ?? "N/A", killSwitch.enabled ? "critical" : "success"),
      statusCard("Email real", String(north.delivrixSendsRealEmail), "Delivrix", north.delivrixSendsRealEmail ? "critical" : "success"),
      statusCard("Infra live", String(north.liveInfrastructureWritesEnabled), "Proxmox/DNS/SSH", north.liveInfrastructureWritesEnabled ? "critical" : "success"),
      statusCard("NFC writes", String(north.nfcProductionWritesEnabled), "Bridge futuro", north.nfcProductionWritesEnabled ? "critical" : "success")
    ]),
    el("section", { className: "panel" }, [
      el("div", { className: "panel-heading" }, [
        el("h3", { text: "Estado actual" }),
        badge(compactLabel(health.phase), "neutral")
      ]),
      el("div", { className: "definition-grid" }, [
        term("Gateway", health.status),
        term("Queue", health.queue),
        term("Audit log", health.auditLog),
        term("Kill switch updated", formatDateTime(killSwitch.updatedAt)),
        term("Updated by", killSwitch.updatedBy),
        term("NFC bridge", compactLabel(health.nfcBridge?.mode ?? "mock"))
      ])
    ])
  ]);
}

function statusCard(label, value, meta, tone) {
  return el("article", { className: `metric-card metric-${tone}` }, [
    el("span", { className: "metric-label", text: label }),
    el("strong", { className: "metric-value metric-value-small", text: compactLabel(value) }),
    el("span", { className: "metric-meta", text: meta })
  ]);
}

function term(label, value) {
  return el("div", { className: "definition-row" }, [
    el("span", { text: label }),
    badge(compactLabel(value), stateTone(value))
  ]);
}
