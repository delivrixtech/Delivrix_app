import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatNumber, stateTone } from "../../shared/lib/formatters.js";

export function renderOpenClaw(data) {
  const health = data.health;
  const north = data.operatingNorth;
  const openClaw = health.openClaw ?? {};
  const enabledItems = Object.entries(openClaw).filter(([, value]) => value === true);
  const disabledItems = Object.entries(openClaw).filter(([, value]) => value === false);

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Operador IA" }),
        el("h2", { text: "OpenClaw" })
      ]),
      badge("Dry-run", "neutral")
    ]),
    el("section", { className: "metric-grid metric-grid-compact" }, [
      smallStat("Fase", compactLabel(north.phase), "neutral"),
      smallStat("Rol", compactLabel(north.openClawRole), "success"),
      smallStat("Acciones permitidas", formatNumber(north.allowedActions.length), "success"),
      smallStat("Acciones bloqueadas", formatNumber(north.blockedActions.length), "critical")
    ]),
    el("section", { className: "two-column" }, [
      renderActionList("Capacidades activas", enabledItems, "success"),
      renderActionList("Bloqueos live", disabledItems, "critical")
    ]),
    el("section", { className: "panel" }, [
      el("div", { className: "panel-heading" }, [
        el("h3", { text: "Gates" }),
        badge(`${north.gates.length}`, "neutral")
      ]),
      el("div", { className: "token-grid" }, north.gates.map((gate) => badge(compactLabel(gate), "neutral")))
    ])
  ]);
}

function smallStat(label, value, tone) {
  return el("article", { className: `metric-card metric-${tone}` }, [
    el("span", { className: "metric-label", text: label }),
    el("strong", { className: "metric-value metric-value-small", text: value }),
    el("span", { className: "metric-meta", text: "Backend source" })
  ]);
}

function renderActionList(title, items, tone) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: title }),
      badge(`${items.length}`, tone)
    ]),
    el("div", { className: "action-list" }, items.map(([key, value]) => (
      el("div", { className: "action-row" }, [
        badge(value ? "on" : "off", stateTone(value ? "ready" : "blocked")),
        el("span", { text: compactLabel(key) })
      ])
    )))
  ]);
}
