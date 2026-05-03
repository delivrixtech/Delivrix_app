import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatDateTime, stateTone } from "../../shared/lib/formatters.js";

export function renderWorkflow(data) {
  const workflow = data.workflow;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: "Ruta" }),
        el("h2", { text: workflow.title })
      ]),
      badge(workflow.mode, "neutral")
    ]),
    el("section", { className: "notice" }, [
      el("div", {}, [
        el("h3", { text: workflow.summary }),
        el("p", { text: `Contrato generado ${formatDateTime(workflow.generatedAt)}` })
      ]),
      badge("Backend contract", "success")
    ]),
    renderReadBoundary(workflow),
    el("section", { className: "workflow-list" }, workflow.steps.map((step) => renderStep(step)))
  ]);
}

function renderReadBoundary(workflow) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Frontera del panel" }),
      badge("GET-only", "success")
    ]),
    el("div", { className: "definition-grid" }, [
      badge(`Permitidos: ${workflow.readBoundary.allowedMethods.join(", ")}`, "success"),
      badge(`Bloqueados: ${workflow.readBoundary.blockedMethods.join(", ")}`, "critical")
    ]),
    el("div", { className: "token-grid token-grid-spaced" }, workflow.readBoundary.allowedEndpoints.map((endpoint) => (
      badge(endpoint, "neutral")
    )))
  ]);
}

function renderStep(step) {
  return el("article", { className: `workflow-step workflow-${stateTone(step.status)}` }, [
    el("div", { className: "workflow-step-index", text: String(step.order) }),
    el("div", { className: "workflow-step-body" }, [
      el("div", { className: "workflow-step-head" }, [
        el("div", {}, [
          el("h3", { text: step.title }),
          el("p", { text: step.operatorQuestion })
        ]),
        badge(compactLabel(step.status), stateTone(step.status))
      ]),
      el("p", { className: "workflow-purpose", text: step.purpose }),
      el("div", { className: "workflow-grid" }, [
        renderTokens("Datos", step.dataSources),
        renderTokens("Evidencia", step.evidenceToShow)
      ]),
      el("p", { className: "workflow-reason", text: step.statusReason })
    ])
  ]);
}

function renderTokens(title, items) {
  return el("div", { className: "workflow-token-group" }, [
    el("strong", { text: title }),
    el("div", { className: "token-grid" }, items.map((item) => badge(compactLabel(item), "neutral")))
  ]);
}
