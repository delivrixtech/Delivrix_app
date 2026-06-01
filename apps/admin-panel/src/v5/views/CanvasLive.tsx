/**
 * v5 Canvas Live — vista hero del demo.
 *
 * Layout: full-bleed split 2-pane (sin chrome extra v5).
 * El propio CanvasV4 ya monta su header "OpenClaw · Live · agent feed", su
 * tab bar (Live / Lecturas / Terminal / Diff / Topología) y la barra de
 * filtros. El header v5 que estaba aquí duplicaba esa información — se
 * eliminó para evitar la barra "Sesión OpenClaw · live · chat/actions/...".
 *
 * Reusa el CanvasV4 internamente (mantiene WSS + state), pero ahora monta
 * sin envoltorio extra para que el breadcrumb del shell ("Operación ›
 * Canvas Live") + AgentPulse vivo en topbar sean los únicos indicadores
 * de sesión.
 */
import { lazy, Suspense } from "react";
import { motion } from "framer-motion";
import { durations, easeOutExpo } from "../lib/motion";
import { PendingApprovalsPanel } from "../components/PendingApprovalsPanel";

const CanvasV4 = lazy(async () => ({
  default: (await import("../../features/canvas/canvas-v4")).CanvasV4
}));

export function CanvasLiveV5() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: durations.page, ease: easeOutExpo }}
      className="flex h-[calc(100vh-52px-36px)] min-h-0 flex-col"
    >
      {/* Contenedor relativo: el PendingApprovalsPanel se posiciona absoluto
          sticky-bottom dentro de este wrapper para flotar sobre el Canvas
          sin alterar el layout del split 2-pane.
          Wiring (cambio norte 2026-05-29): ApprovalGate vive aquí cuando el
          agente emite `oc.proposal.submitted` con requiresApproval=true. */}
      <div className="relative flex min-h-0 flex-1">
        <Suspense fallback={<div className="p-6 text-fg-subtle text-[12px]">Cargando Canvas Live…</div>}>
          <CanvasV4 />
        </Suspense>
        <PendingApprovalsPanel />
      </div>
    </motion.div>
  );
}
