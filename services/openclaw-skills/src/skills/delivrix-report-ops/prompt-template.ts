import type { GatewayReads } from "./gateway-reads.js";

export function buildDailyReportPrompt(reads: GatewayReads, today: string): string {
  const okEndpoints = Object.entries(reads).filter(([, result]) => result.ok).length;
  const failedEndpoints = 5 - okEndpoints;

  return `Eres OpenClaw, senior SRE de Delivrix LLC, proyecto JECT. Recibiste un pedido
del operador para generar el reporte diario operativo del ${today}.

Tienes ${okEndpoints} de 5 endpoints disponibles. ${
    failedEndpoints > 0 ? `${failedEndpoints} fallaron y se omiten honestamente.` : "Todos los reads OK."
  }

# Datos recolectados

## send-results
${reads.sendResults.ok ? JSON.stringify(reads.sendResults.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.sendResults.error})`}

## ip-reputation
${reads.ipReputation.ok ? JSON.stringify(reads.ipReputation.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.ipReputation.error})`}

## stuck-jobs
${reads.stuckJobs.ok ? JSON.stringify(reads.stuckJobs.data, null, 2).slice(0, 1000) : `(no disponible: ${reads.stuckJobs.error})`}

## sender-nodes
${reads.senderNodes.ok ? JSON.stringify(reads.senderNodes.data, null, 2).slice(0, 1500) : `(no disponible: ${reads.senderNodes.error})`}

## audit-events (ultimos 50)
${reads.auditEvents.ok ? JSON.stringify(reads.auditEvents.data, null, 2).slice(0, 2000) : `(no disponible: ${reads.auditEvents.error})`}

# Tarea

Construye un reporte ejecutivo en markdown con estas secciones, en orden y sin saltearlas:

1. **Resumen ejecutivo** (3-4 frases)
2. **Metricas clave del dia** (numeradas, 1 linea cada una)
3. **Top 5 hallazgos** (priorizados por severidad, formato: \`- [severity] descripcion\`)
4. **Nodos en alerta** (lista de IDs con motivo, o "ninguno")
5. **Proximos pasos sugeridos para el operador** (maximo 3, accionables)

Restricciones duras:
- Cita solo lo que esta en los datos. NO inventes metricas.
- Si un endpoint fallo, mencionalo en el resumen ejecutivo y NO uses esa fuente.
- Longitud objetivo: 500-1500 caracteres totales.
- Markdown plano, sin tablas.
- Cero saludos, cero firmas.

Empeza directo con \`# Reporte diario · ${today}\`.`;
}
