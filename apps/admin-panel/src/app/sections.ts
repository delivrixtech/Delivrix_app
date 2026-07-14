/**
 * Section manifest del admin panel — reorg A13/A14 (2026-07-13).
 *
 * De 13 entradas planas a 5 entradas de nav agrupadas por trabajo del operador:
 *   1. Vista general (overview)      — standalone
 *   2. Canvas (canvas)               — standalone (cockpit en vivo)
 *   3. Envío (envio)                 — tabs: Sender Pool · Dominios · Warmup · Nodos · Reputación
 *   4. Infraestructura (infraestructura) — tabs: Inventario · Alta de servidor · Captura manual
 *   5. Gobierno (gobierno)           — tabs: Seguridad · Aprendizaje
 *
 * A14: Hardware queda FUERA del nav (mock que duplica la card de Infraestructura);
 * el componente se conserva en el repo pero no se enruta salvo redirect legacy.
 *
 * Las vistas de cada tab siguen siendo las mismas de `v5/views/*` y `features/*`
 * envueltas en contenedores con `shared/ui/tabs.tsx`. Los ids viejos (leaf ids)
 * se preservan como deep-links vía `leafRedirect`.
 */

import {
  Cloud,
  LayoutDashboard,
  SendHorizontal,
  ShieldCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";

/** Entradas reales del sidebar (5). */
export type NavSectionId =
  | "overview"
  | "canvas"
  | "envio"
  | "infraestructura"
  | "gobierno";

/**
 * Ids "hoja": lo que el operador puede alcanzar por deep-link, command palette
 * o intent de OpenClaw. Incluye los 13 ids históricos (menos `hardware`, que sale
 * del nav pero mantiene redirect) más los 2 standalone.
 */
export type LeafId =
  | "overview"
  | "canvas"
  | "domains"
  | "sender-pool"
  | "warmup"
  | "clusters"
  | "mxtoolbox"
  | "infrastructure"
  | "onboarding"
  | "collector"
  | "safety"
  | "learning";

export interface NavDescriptor {
  id: NavSectionId;
  navLabel: string;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
}

/**
 * Descriptor de una pestaña dentro de un grupo. Solo `id` + `label`: cada vista
 * envuelta ya renderiza su propio header (eyebrow/title/description), así que
 * mantener copias aquí solo genera drift silencioso.
 */
export interface TabDescriptor {
  /** Id histórico de la sección; se usa como valor de la pestaña y como deep-link. */
  id: Exclude<LeafId, "overview" | "canvas">;
  label: string;
}

export const navSections: NavDescriptor[] = [
  {
    id: "overview",
    navLabel: "Vista general",
    icon: LayoutDashboard,
    eyebrow: "Inicio operativo",
    title: "Capacidad preparada, sin envíos reales.",
    description:
      "Delivrix gobierna infraestructura de correo autorizada en modo solo lectura. OpenClaw observa, valida y propone — los humanos aprueban cada acción real."
  },
  {
    id: "canvas",
    navLabel: "Canvas",
    icon: Workflow,
    eyebrow: "OpenClaw · Canvas",
    title: "Topología en vivo",
    description:
      "Grafo del control plane: nodos OpenClaw, dependencias, blockedBy por categoría y timeline reciente. El panel sólo lee snapshots redactados."
  },
  {
    id: "envio",
    navLabel: "Envío",
    icon: SendHorizontal,
    eyebrow: "Pipeline de envío",
    title: "Envío de punta a punta",
    description:
      "El trabajo completo del operador en un solo lugar: provisionar el sender pool y su SMTP, adquirir dominios, calentar (warmup), operar la flota de nodos e IPs y verificar reputación/blacklist. Todo read-only auditado; las acciones reales pasan por aprobación humana."
  },
  {
    id: "infraestructura",
    navLabel: "Infraestructura",
    icon: Cloud,
    eyebrow: "Servidores y hosts",
    title: "Inventario e ingesta de infraestructura",
    description:
      "Gestión de los servidores/hosts subyacentes: inventario multi-proveedor, alta de un nuevo servidor de envío y captura manual de snapshots supervisados. Lectura unificada y auditada."
  },
  {
    id: "gobierno",
    navLabel: "Gobierno",
    icon: ShieldCheck,
    eyebrow: "Autonomía OpenClaw",
    title: "Gobierno de la autonomía",
    description:
      "Hasta dónde dejamos actuar al agente y con qué barandillas: kill switch, gates, roles y auditoría (Seguridad), y el plan de aprendizaje supervisado y readiness del modelo (Aprendizaje)."
  }
];

export const navSectionsById: Record<NavSectionId, NavDescriptor> = Object.fromEntries(
  navSections.map((section) => [section.id, section])
) as Record<NavSectionId, NavDescriptor>;

/**
 * Grupos de tabs por sección-contenedora. La primera pestaña es la más usada.
 * El label es lo único que se renderiza (TabsTrigger); el header de cada tab lo
 * aporta la vista envuelta.
 */
export const envioTabs: TabDescriptor[] = [
  { id: "sender-pool", label: "Sender Pool" },
  { id: "domains", label: "Dominios" },
  { id: "warmup", label: "Warmup" },
  { id: "clusters", label: "Nodos" },
  { id: "mxtoolbox", label: "Reputación" }
];

export const infraestructuraTabs: TabDescriptor[] = [
  { id: "infrastructure", label: "Inventario" },
  { id: "onboarding", label: "Alta de servidor" },
  { id: "collector", label: "Captura manual" }
];

export const gobiernoTabs: TabDescriptor[] = [
  { id: "safety", label: "Seguridad" },
  { id: "learning", label: "Aprendizaje" }
];

export const groupTabs: Record<Exclude<NavSectionId, "overview" | "canvas">, TabDescriptor[]> = {
  envio: envioTabs,
  infraestructura: infraestructuraTabs,
  gobierno: gobiernoTabs
};

export type GroupSectionId = keyof typeof groupTabs;

export function isGroupSection(id: NavSectionId): id is GroupSectionId {
  return id === "envio" || id === "infraestructura" || id === "gobierno";
}

/**
 * Redirect de ids viejos (leaf) → sección-contenedora + pestaña.
 * Preserva deep-links, command palette e intents de OpenClaw tras la reorg.
 * `hardware` sale del nav (A14) pero conserva redirect para no romper links viejos.
 */
export const leafRedirect: Record<string, { section: NavSectionId; tab?: string }> = {
  // standalone
  overview: { section: "overview" },
  canvas: { section: "canvas" },
  // envío
  "sender-pool": { section: "envio", tab: "sender-pool" },
  domains: { section: "envio", tab: "domains" },
  warmup: { section: "envio", tab: "warmup" },
  clusters: { section: "envio", tab: "clusters" },
  mxtoolbox: { section: "envio", tab: "mxtoolbox" },
  // infraestructura
  infrastructure: { section: "infraestructura", tab: "infrastructure" },
  onboarding: { section: "infraestructura", tab: "onboarding" },
  collector: { section: "infraestructura", tab: "collector" },
  // hardware desactivado del nav → cae en Inventario (donde vive su card real)
  hardware: { section: "infraestructura", tab: "infrastructure" },
  // gobierno
  safety: { section: "gobierno", tab: "safety" },
  learning: { section: "gobierno", tab: "learning" }
};

export interface NavGroupDef {
  id: string;
  label: string;
  items: NavSectionId[];
}

/**
 * Agrupación mínima del sidebar. Con 5 entradas no hace falta el mapa
 * conceptual viejo (estado/operacion/barandillas); basta separar "lo que se
 * observa" de "lo que se opera".
 */
export const navGroups: NavGroupDef[] = [
  { id: "vista", label: "Vista", items: ["overview", "canvas"] },
  { id: "operacion", label: "Operación", items: ["envio", "infraestructura", "gobierno"] }
];

export function navGroupLabelFor(section: NavSectionId): string {
  const group = navGroups.find((g) => g.items.includes(section));
  return group?.label ?? "Panel";
}

/**
 * Resuelve un target arbitrario (id de nav, id viejo de sección, o slug de URL)
 * a la sección-contenedora + pestaña opcional. Fallback seguro a overview.
 */
export function resolveTarget(target: string): { section: NavSectionId; tab: string | null } {
  if (target in navSectionsById) {
    return { section: target as NavSectionId, tab: null };
  }
  const redirect = leafRedirect[target];
  if (redirect) {
    return { section: redirect.section, tab: redirect.tab ?? null };
  }
  return { section: "overview", tab: null };
}
