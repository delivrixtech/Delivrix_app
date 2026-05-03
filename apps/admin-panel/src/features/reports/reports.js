import { badge, el } from "../../shared/ui/dom.js";

export function renderReports(data) {
  const north = data.operatingNorth;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Evidencia" }),
        el("h2", { text: "Reportes" })
      ]),
      badge("GET-only", "neutral")
    ]),
    el("section", { className: "notice notice-warning" }, [
      el("div", {}, [
        el("h3", { text: "Reporte final MVP" }),
        el("p", { text: "not_generated_from_ui" })
      ]),
      badge("POST bloqueado", "critical")
    ]),
    el("section", { className: "panel" }, [
      el("div", { className: "panel-heading" }, [
        el("h3", { text: "Gates hacia produccion limitada" }),
        badge(`${north.gates.length}`, "neutral")
      ]),
      el("div", { className: "token-grid" }, north.gates.slice(0, 12).map((gate) => badge(gate.replaceAll("_", " "), "neutral")))
    ])
  ]);
}
