import type { SkillDescriptor } from "../../types.js";

export const descriptor: SkillDescriptor = {
  slug: "delivrix-report-ops",
  displayName: "Delivrix · Reporte diario operativo",
  description:
    "Genera reporte ejecutivo del dia: send_results, ip_reputation, stuck_jobs, sender_nodes, audit_events. Responde en chat. Side-effect Notion omitido si NOTION_API_KEY ausente.",
  triggerPhrases: [
    "correr report-ops",
    "reporte diario",
    "daily report",
    "resumen del dia",
    "como va la operacion hoy"
  ],
  declaredActions: ["generate_daily_report"],
  schemaVersion: "2026-05-18.v1",
  modelHint: "us.anthropic.claude-sonnet-4-6"
};
