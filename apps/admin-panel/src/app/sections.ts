/**
 * Section manifest del admin panel (Fase H, 2026-05-17).
 *
 * Re-arquitectura para alinear con `Panel Front End.pen`: 5 secciones top-level
 * (era 7 antes). Canvas / Workflow / Aprendizaje se diluyen como paneles
 * dentro de Overview Dashboard. Safety se unifica con Clusters en una sola
 * pantalla con tabs internas.
 *
 * Cada entrada describe: id, label sidebar, agrupacion, icono, eyebrow,
 * title y descripcion para PageHeader, y el endpoint principal que consume.
 */

import {
  Compass,
  Cpu,
  Database,
  LayoutDashboard,
  Server,
  type LucideIcon
} from "lucide-react";
import { READ_ENDPOINTS } from "../shared/api/read-boundary.ts";

export type SectionId =
  | "overview"
  | "onboarding"
  | "hardware"
  | "collector"
  | "clusters-security";

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
    title: "Capacidad preparada, sin envios reales.",
    description:
      "Panel de control: nodos preparados, IPs en warming, reputacion observada, aprobaciones pendientes y eventos recientes. Toda lectura, sin acciones reales.",
    endpoint: READ_ENDPOINTS.adminOverview
  },
  {
    id: "onboarding",
    navLabel: "Onboarding",
    group: "operacion",
    icon: Compass,
    eyebrow: "Practica · Onboarding",
    title: "Onboarding del servidor de envio",
    description:
      "El operador captura y valida el servidor fisico, sus IPs, dominios e interfaces. OpenClaw observa y recomienda; el panel solo lee snapshots redactados.",
    endpoint: READ_ENDPOINTS.openClawOnboardingState
  },
  {
    id: "hardware",
    navLabel: "Hardware",
    group: "operacion",
    icon: Cpu,
    eyebrow: "Servidor fisico",
    title: "Hardware y telemetria",
    description:
      "Inventario y telemetria del host. Datos del snapshot read-only ingestado por el collector supervisado — sin live polling.",
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
      "Fuentes supervisadas read-only y contrato de la ingesta manual. El panel jamas postea snapshots; el endpoint manual vive en CLI fuera de la UI.",
    endpoint: READ_ENDPOINTS.collectorSupervisedPlan
  },
  {
    id: "clusters-security",
    navLabel: "Clústeres",
    group: "barandillas",
    icon: Server,
    eyebrow: "Infraestructura · Seguridad",
    title: "Clusters y nodos de envio",
    description:
      "Inventario de clusters de sender nodes, su salud y reputacion, mas la frontera operativa (kill switch, acciones permitidas, gates pendientes, roles del norte).",
    endpoint: READ_ENDPOINTS.adminClusters
  }
];

export const sectionsById: Record<SectionId, SectionDescriptor> = Object.fromEntries(
  sections.map((section) => [section.id, section])
) as Record<SectionId, SectionDescriptor>;

export const sectionGroupLabels: Record<SectionGroup, string> = {
  estado: "Estado",
  operacion: "Operacion",
  barandillas: "Barandillas"
};

export const sectionGroupOrder: SectionGroup[] = ["estado", "operacion", "barandillas"];

export function getSection(id: SectionId): SectionDescriptor {
  return sectionsById[id];
}

export function formatEndpointBadge(endpoint: string): string {
  return `GET ${endpoint}`;
}
