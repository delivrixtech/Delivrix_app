/**
 * Section manifest del admin panel — 8 secciones alineadas con Pencil
 * (`Panel Front End.pen` sidebar).
 *
 * Items en orden: Vista general / Onboarding / Canvas / Hardware / Recolector /
 * Clústeres / Aprendizaje / Seguridad.
 */

import {
  Compass,
  Cpu,
  Database,
  GraduationCap,
  LayoutDashboard,
  Server,
  ShieldCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { READ_ENDPOINTS } from "../shared/api/read-boundary.ts";

export type SectionId =
  | "overview"
  | "onboarding"
  | "canvas"
  | "hardware"
  | "collector"
  | "clusters"
  | "learning"
  | "safety";

export type SectionGroup = "estado" | "operacion" | "barandillas";

export interface SectionDescriptor {
  id: SectionId;
  navLabel: string;
  group: SectionGroup;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  endpoint: string;
}

export const sections: SectionDescriptor[] = [
  {
    id: "overview",
    navLabel: "Vista general",
    group: "estado",
    icon: LayoutDashboard,
    eyebrow: "Inicio operativo",
    title: "Capacidad preparada, sin envíos reales.",
    description:
      "Delivrix gobierna infraestructura de correo autorizada en modo solo lectura. OpenClaw observa, valida y propone — los humanos aprueban cada acción real.",
    endpoint: READ_ENDPOINTS.adminOverview
  },
  {
    id: "onboarding",
    navLabel: "Onboarding",
    group: "operacion",
    icon: Compass,
    eyebrow: "Práctica · Onboarding",
    title: "Onboarding del servidor de envío",
    description:
      "El asistente captura y valida el servidor físico, sus IPs, dominios, DNS, límites y permisos antes de pedir el visto bueno humano. OpenClaw observa la evidencia y recomienda.",
    endpoint: READ_ENDPOINTS.openClawOnboardingState
  },
  {
    id: "canvas",
    navLabel: "Canvas",
    group: "operacion",
    icon: Workflow,
    eyebrow: "OpenClaw · Canvas",
    title: "Topología en vivo",
    description:
      "Grafo del control plane: nodos OpenClaw, dependencias, blockedBy por categoría y timeline reciente. El panel sólo lee snapshots redactados.",
    endpoint: READ_ENDPOINTS.openClawLiveCanvas
  },
  {
    id: "hardware",
    navLabel: "Hardware",
    group: "operacion",
    icon: Cpu,
    eyebrow: "Servidor físico",
    title: "Hardware y telemetría",
    description:
      "Inventario y telemetría del host físico ingestado por el collector supervisado. Sin live polling — todo viene de snapshots auditados.",
    endpoint: READ_ENDPOINTS.hardwarePhysicalHost
  },
  {
    id: "collector",
    navLabel: "Recolector",
    group: "operacion",
    icon: Database,
    eyebrow: "DevOps",
    title: "Recolector y captura manual",
    description:
      "Fuentes supervisadas read-only y contrato de la ingesta manual. El panel jamás postea snapshots; el endpoint manual vive en CLI fuera de la UI.",
    endpoint: READ_ENDPOINTS.collectorSupervisedPlan
  },
  {
    id: "clusters",
    navLabel: "Clústeres",
    group: "barandillas",
    icon: Server,
    eyebrow: "Infraestructura",
    title: "Clústeres y nodos de envío",
    description:
      "Inventario de clústeres de sender nodes, su salud y reputación. Plan dry-run y acciones siguientes salen directo del contrato.",
    endpoint: READ_ENDPOINTS.adminClusters
  },
  {
    id: "learning",
    navLabel: "Aprendizaje",
    group: "barandillas",
    icon: GraduationCap,
    eyebrow: "OpenClaw · Aprendizaje supervisado",
    title: "Plan de aprendizaje y readiness",
    description:
      "Stages del plan de aprendizaje supervisado, signals de readiness por capacidad y gobierno del modelo. Promoción y entrenamientos requieren aprobación humana.",
    endpoint: READ_ENDPOINTS.openClawLearningPlan
  },
  {
    id: "safety",
    navLabel: "Seguridad",
    group: "barandillas",
    icon: ShieldCheck,
    eyebrow: "Norte operativo · Barandillas",
    title: "Seguridad y frontera operativa",
    description:
      "Kill switch, acciones permitidas y bloqueadas, gates pendientes y roles del norte. Todo lectura desde el contrato del operating-north.",
    endpoint: READ_ENDPOINTS.operatingNorth
  }
];

export const sectionsById: Record<SectionId, SectionDescriptor> = Object.fromEntries(
  sections.map((section) => [section.id, section])
) as Record<SectionId, SectionDescriptor>;

export const sectionGroupLabels: Record<SectionGroup, string> = {
  estado: "Estado",
  operacion: "Operación",
  barandillas: "Barandillas"
};

export const sectionGroupOrder: SectionGroup[] = ["estado", "operacion", "barandillas"];

export function getSection(id: SectionId): SectionDescriptor {
  return sectionsById[id];
}

export function formatEndpointBadge(endpoint: string): string {
  return `GET ${endpoint}`;
}
