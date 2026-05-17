/**
 * Section manifest del admin panel.
 *
 * Cada entrada describe una pantalla: id, label de sidebar, icono, agrupacion,
 * y la metadata que consume PageHeader (eyebrow / title / description / endpoint).
 *
 * `endpoint` se referencia desde READ_ENDPOINTS para mantener single source of
 * truth con la frontera de lectura. Si el endpoint cambia, el badge se actualiza
 * solo.
 *
 * Las descripciones aqui son UX (explican que ve el operador). Cuando el backend
 * exponga descripciones operacionales, los `description` deberian leer de payload.
 */

import {
  Activity,
  Boxes,
  BrainCircuit,
  Cpu,
  GitBranch,
  ShieldCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { READ_ENDPOINTS } from "../shared/api/read-boundary.ts";

export type SectionId =
  | "canvas"
  | "hardware"
  | "collector"
  | "workflow"
  | "clusters"
  | "learning"
  | "safety";

export type SectionGroup = "live" | "process" | "guardrails";

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
    id: "canvas",
    navLabel: "Canvas",
    group: "live",
    icon: GitBranch,
    eyebrow: "OpenClaw",
    title: "Canvas vivo",
    description:
      "Topologia del control plane. Cada nodo expone su estado, dependencias y bloqueos. Seleccionar un nodo abre el inspector lateral con metricas, entrantes y salientes.",
    endpoint: READ_ENDPOINTS.openClawLiveCanvas
  },
  {
    id: "hardware",
    navLabel: "Hardware",
    group: "live",
    icon: Cpu,
    eyebrow: "Servidor fisico",
    title: "Hardware y telemetria",
    description:
      "Inventario y telemetria del host fisico. Los datos provienen del snapshot read-only ingestado por el collector supervisado, no de live polling.",
    endpoint: READ_ENDPOINTS.hardwarePhysicalHost
  },
  {
    id: "collector",
    navLabel: "Collector",
    group: "live",
    icon: Activity,
    eyebrow: "DevOps",
    title: "Collector supervisado",
    description:
      "El collector observa el host fisico, Proxmox y Prometheus en modo read-only y propone los siguientes pasos seguros sin escribir nada. El panel solo lee el contrato; no inicia colecciones ni postea snapshots.",
    endpoint: READ_ENDPOINTS.collectorSupervisedPlan
  },
  {
    id: "workflow",
    navLabel: "Ruta",
    group: "process",
    icon: Workflow,
    eyebrow: "Ruta",
    title: "Workflow operacional",
    description:
      "Secuencia de pasos que el operador humano debe seguir para diagnosticar el control plane. Cada paso describe la pregunta a contestar, las fuentes de datos y la evidencia esperada.",
    endpoint: READ_ENDPOINTS.adminWorkflow
  },
  {
    id: "clusters",
    navLabel: "Clusters",
    group: "process",
    icon: Boxes,
    eyebrow: "Infraestructura",
    title: "Clusters y VPS",
    description:
      "Inventario de clusters de sender nodes gobernados por Delivrix. Cada cluster agrupa VPS/LXC por proveedor y muestra los nodos vivos con su estado operacional.",
    endpoint: READ_ENDPOINTS.adminClusters
  },
  {
    id: "learning",
    navLabel: "Aprendizaje",
    group: "process",
    icon: BrainCircuit,
    eyebrow: "OpenClaw",
    title: "Aprendizaje supervisado",
    description:
      "OpenClaw aprende por evidencia curada, no se auto-promueve y depende de aprobacion humana. Esta pantalla expone los signals de readiness y los stages del plan de aprendizaje.",
    endpoint: READ_ENDPOINTS.openClawLearningPlan
  },
  {
    id: "safety",
    navLabel: "Seguridad",
    group: "guardrails",
    icon: ShieldCheck,
    eyebrow: "Barandillas",
    title: "Seguridad operacional",
    description:
      "Las cuatro fronteras del norte operativo y la lista de acciones permitidas / bloqueadas / gates pendientes. El panel no ejecuta acciones reales.",
    endpoint: READ_ENDPOINTS.operatingNorth
  }
];

export const sectionsById: Record<SectionId, SectionDescriptor> = Object.fromEntries(
  sections.map((section) => [section.id, section])
) as Record<SectionId, SectionDescriptor>;

export const sectionGroupLabels: Record<SectionGroup, string> = {
  live: "Estado vivo",
  process: "Procesos",
  guardrails: "Barandillas"
};

export const sectionGroupOrder: SectionGroup[] = ["live", "process", "guardrails"];

export function getSection(id: SectionId): SectionDescriptor {
  return sectionsById[id];
}

export function formatEndpointBadge(endpoint: string): string {
  return `GET ${endpoint}`;
}
