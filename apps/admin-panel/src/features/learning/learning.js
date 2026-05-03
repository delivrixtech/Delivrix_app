import { badge, el } from "../../shared/ui/dom.js";
import { compactLabel, formatDateTime, formatNumber, stateTone } from "../../shared/lib/formatters.js";

export function renderLearning(data) {
  const plan = data.learningPlan;

  return el("section", { className: "page-stack" }, [
    el("div", { className: "page-title-row" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", text: plan.phase }),
        el("h2", { text: plan.title })
      ]),
      badge(plan.mode, "neutral")
    ]),
    el("section", { className: "notice" }, [
      el("div", {}, [
        el("h3", { text: plan.summary }),
        el("p", { text: `${plan.principle} Contrato generado ${formatDateTime(plan.generatedAt)}.` })
      ]),
      badge("Evaluacion supervisada", "success")
    ]),
    renderDataSources(plan.dataSources),
    el("section", { className: "workflow-list" }, plan.stages.map((stage) => renderStage(stage))),
    el("section", { className: "two-column" }, [
      renderGates(plan.evaluationGates),
      renderPromotionPolicy(plan.promotionPolicy)
    ]),
    renderSafety(plan.safety)
  ]);
}

function renderDataSources(dataSources) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Fuentes de aprendizaje" }),
      badge(formatNumber(dataSources.length), "neutral")
    ]),
    el("div", { className: "table-wrap" }, [
      el("table", { className: "data-table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Fuente" }),
            el("th", { text: "Estado" }),
            el("th", { text: "Evidencia" }),
            el("th", { text: "Uso" }),
            el("th", { text: "Excluido" })
          ])
        ]),
        el("tbody", {}, dataSources.map((source) => (
          el("tr", {}, [
            el("td", {}, [
              el("strong", { text: source.label }),
              el("p", { className: "workflow-reason", text: source.id })
            ]),
            el("td", {}, [badge(compactLabel(source.status), stateTone(source.status))]),
            el("td", { text: formatNumber(source.evidenceCount) }),
            el("td", { text: source.allowedFields.join(", ") }),
            el("td", { text: source.excludedFields.join(", ") })
          ])
        )))
      ])
    ])
  ]);
}

function renderStage(stage) {
  return el("article", { className: `workflow-step workflow-${stateTone(stage.status)}` }, [
    el("div", { className: "workflow-step-index", text: String(stage.order) }),
    el("div", { className: "workflow-step-body" }, [
      el("div", { className: "workflow-step-head" }, [
        el("div", {}, [
          el("h3", { text: stage.title }),
          el("p", { text: stage.goal })
        ]),
        badge(compactLabel(stage.status), stateTone(stage.status))
      ]),
      el("div", { className: "workflow-grid" }, [
        renderTokens("Evidencia", stage.evidence),
        renderTokens("Exit gate", [stage.exitGate])
      ])
    ])
  ]);
}

function renderGates(gates) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Gates de evaluacion" }),
      badge(formatNumber(gates.length), "neutral")
    ]),
    el("div", { className: "action-list" }, gates.map((gate) => (
      el("div", { className: "action-row" }, [
        badge(compactLabel(gate.status), stateTone(gate.status)),
        el("div", {}, [
          el("strong", { text: gate.label }),
          el("p", { text: gate.reason })
        ])
      ])
    )))
  ]);
}

function renderPromotionPolicy(policy) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Politica de promocion" }),
      badge(policy.requiresHumanApproval ? "human approval" : "auto", policy.requiresHumanApproval ? "warning" : "critical")
    ]),
    el("div", { className: "definition-grid" }, [
      badge(`self promote: ${String(policy.canSelfPromote)}`, policy.canSelfPromote ? "critical" : "success"),
      badge(`human approval: ${String(policy.requiresHumanApproval)}`, policy.requiresHumanApproval ? "success" : "critical")
    ]),
    el("div", { className: "token-grid token-grid-spaced" }, policy.minimumEvidence.map((item) => badge(compactLabel(item), "neutral")))
  ]);
}

function renderSafety(safety) {
  return el("section", { className: "panel" }, [
    el("div", { className: "panel-heading" }, [
      el("h3", { text: "Frontera de aprendizaje" }),
      badge("MVP", "neutral")
    ]),
    el("div", { className: "token-grid" }, Object.entries(safety).map(([key, value]) => (
      badge(`${compactLabel(key)}: ${String(value)}`, value ? "critical" : "success")
    )))
  ]);
}

function renderTokens(title, items) {
  return el("div", { className: "workflow-token-group" }, [
    el("strong", { text: title }),
    el("div", { className: "token-grid" }, items.map((item) => badge(compactLabel(item), "neutral")))
  ]);
}
