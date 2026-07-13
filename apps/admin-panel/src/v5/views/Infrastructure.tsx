/**
 * v5 Infraestructura — Hito 5.12 Multi-provider inventory.
 *
 * Reescrita desde cero con v5. Resuelve los problemas estructurales de la
 * versión legacy:
 *
 *   1. Antes: 9 cards planas en grid 4-col, sin jerarquía. Ahora: KPIs
 *      ejecutivos arriba + sección de "Atención requerida" + grupos
 *      semánticos (Compute / DNS / Físico).
 *   2. Antes: críticos compitiendo con OKs. Ahora: lo crítico vive en una
 *      sección aparte con borde tonal y CTA accionable.
 *   3. Antes: pills "Activo" + "live" + timestamp = redundancia.
 *      Ahora: una sola Pill de estado + timestamp relativo (no `live`).
 *   4. Antes: fila huérfana con 3 huecos. Ahora: listas densas en columna,
 *      no grid — la fila huérfana desaparece estructuralmente.
 *   5. Antes: sin agrupación por tipo. Ahora: tres secciones explícitas
 *      con SectionHead + count por grupo.
 *   6. Antes: solo "Proveedores activos · 9". Ahora: strip de 4 KPIs
 *      (ok / error / offline / planeados) con desglose por tipo.
 *   7. Antes: naming críptico. Ahora: brand primario, account label
 *      secundario, slug en mono caption.
 *
 * Disciplina v5: VARIANCE 2/5 · MOTION 1/5 · DENSITY 4/5.
 * Sin pills saturadas. Sin hover-lift. Sin shadows. Cero em-dashes.
 *
 * Wiring: la vista hace su propia query a READ_ENDPOINTS.infrastructureInventory.
 * No requiere props del shell.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  Cloud,
  KeyRound,
  PowerOff,
  ShieldAlert,
  TriangleAlert
} from "lucide-react";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { RealtimeTick, StaleBadge } from "../../shared/ui/realtime";
import { useCanvasLiveEventSubscription } from "../../features/canvas/canvas-live-client";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead,
  Stat
} from "../components/primitives";
import { PageHead } from "./_PageHead";

/* ============================================================
 * Contrato Hito 5.12 § 2.3 — mirror local.
 * ============================================================ */

type ProviderKind = "compute" | "dns" | "domain-registrar" | "physical";
type ProviderStatus = "active" | "paused" | "error" | "planned";
type ProviderFetchSourceKind = "live" | "mock";

interface InventoryItem {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  detail?: Record<string, unknown>;
}

interface Provider {
  id: string;
  displayName: string;
  kind: ProviderKind;
  status: ProviderStatus;
  statusLabel?: string;
  itemCount: number;
  lastFetched: string | null;
  fetchSourceKind: ProviderFetchSourceKind | null;
  errorReason?: string;
  capabilities: string[];
  items?: InventoryItem[];
}

interface InfrastructureInventoryResponse {
  generatedAt: string;
  itemTotal: number;
  providers: Provider[];
}

/* ============================================================
 * Hook react-query con cache sessionStorage.
 * ============================================================ */

const POLL_MS = 30_000;
const INVENTORY_CACHE_KEY = "delivrix.infrastructure.inventory.v5.last-ok";
const INVENTORY_CACHE_MAX_AGE_MS = 5 * 60_000;

type FetchState =
  | { status: "loading" }
  | { status: "ok"; payload: InfrastructureInventoryResponse; lastUpdateAt: number }
  | { status: "error"; message: string };

function readCachedInventory(): {
  payload: InfrastructureInventoryResponse;
  updatedAt: number;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(INVENTORY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      payload: InfrastructureInventoryResponse;
      updatedAt: number;
    }>;
    if (
      !parsed.payload ||
      !Array.isArray(parsed.payload.providers) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.updatedAt > INVENTORY_CACHE_MAX_AGE_MS) {
      window.sessionStorage.removeItem(INVENTORY_CACHE_KEY);
      return null;
    }
    return { payload: parsed.payload, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function writeCachedInventory(
  payload: InfrastructureInventoryResponse,
  updatedAt: number
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      INVENTORY_CACHE_KEY,
      JSON.stringify({ payload, updatedAt })
    );
  } catch {
    /* cache opcional */
  }
}

function useInventory(): FetchState {
  const cached = useMemo(readCachedInventory, []);
  const query = useQuery({
    queryKey: ["v5", "infrastructure", "inventory"],
    queryFn: () =>
      getJson<InfrastructureInventoryResponse>(READ_ENDPOINTS.infrastructureInventory),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2,
    initialData: cached?.payload,
    initialDataUpdatedAt: cached?.updatedAt
  });

  useEffect(() => {
    if (query.data) writeCachedInventory(query.data, query.dataUpdatedAt);
  }, [query.data, query.dataUpdatedAt]);

  if (query.isLoading) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      message:
        query.error instanceof Error
          ? query.error.message
          : "no se pudo obtener el inventario"
    };
  }
  if (query.data) {
    return {
      status: "ok",
      payload: query.data,
      lastUpdateAt: query.dataUpdatedAt
    };
  }
  return { status: "loading" };
}

/* ============================================================
 * PR-10 — Salud SMTP por cuenta (drill-down read-only).
 *
 * Contrato consumido (aditivo, aún no en el read-boundary estático porque
 * lleva path params):
 *   GET /v1/infrastructure/accounts/:providerId/:accountId/smtp-health
 *
 * El backend puede responder dos formas equivalentes; el normalizador tolera
 * ambas y también un endpoint aún no desplegado (404 → estado vacío):
 *   A) Envelope: { generatedAt?, dataSource?, summary?, units[], unattachedOrphans[] }
 *   B) Array simple de items { smtpHost, domain, state, since?, evidence?, suggestedFix? }
 *
 * Cada unidad se clasifica por `state` en grupos de UI (active / down / error /
 * huérfano / sin SMTP / pendiente). La `suggestedFix` del catálogo del backend
 * se renderiza como TEXTO: esta vista es read-only estricta, no dispara acciones.
 * ============================================================ */

const SMTP_HEALTH_POLL_MS = 45_000;

export interface NormalizedSmtpFix {
  text: string;
  docRef?: string;
  kind?: string;
}

export interface NormalizedSmtpIssue {
  code?: string;
  severity?: string;
  message?: string;
  fix?: NormalizedSmtpFix;
}

export interface NormalizedSmtpUnit {
  key: string;
  state: string;
  domain?: string;
  smtpHost?: string;
  serverSlug?: string;
  serverIp?: string;
  since?: string;
  credentialStatus?: string;
  tlsStatus?: string;
  evidence: string[];
  issues: NormalizedSmtpIssue[];
  fixes: NormalizedSmtpFix[];
}

export interface NormalizedSmtpHealth {
  available: boolean;
  generatedAt?: string;
  dataSource?: string;
  units: NormalizedSmtpUnit[];
  summary: Record<string, number> | null;
}

export type SmtpStateGroup =
  | "active"
  | "down"
  | "error"
  | "orphan"
  | "no_smtp"
  | "pending"
  | "other";

export function smtpStateGroup(state: string | undefined): SmtpStateGroup {
  const value = (state ?? "").toLowerCase();
  if (value === "active") return "active";
  if (value === "down") return "down";
  if (value === "error") return "error";
  if (value.startsWith("orphan")) return "orphan";
  if (value === "no_smtp") return "no_smtp";
  if (value.startsWith("pending")) return "pending";
  return "other";
}

const SMTP_GROUP_ORDER: SmtpStateGroup[] = [
  "error",
  "down",
  "orphan",
  "pending",
  "no_smtp",
  "active",
  "other"
];

const SMTP_GROUP_LABEL: Record<SmtpStateGroup, string> = {
  active: "Activos",
  down: "Caídos",
  error: "Con error",
  orphan: "Huérfanos",
  no_smtp: "Sin SMTP",
  pending: "Registro pendiente",
  other: "Otros"
};

const SMTP_GROUP_TONE: Record<SmtpStateGroup, "success" | "warning" | "critical" | "neutral"> = {
  active: "success",
  down: "critical",
  error: "critical",
  orphan: "warning",
  no_smtp: "neutral",
  pending: "warning",
  other: "neutral"
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeSmtpFix(raw: unknown): NormalizedSmtpFix | undefined {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? { text } : undefined;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text = stringField(obj.text) ?? stringField(obj.message) ?? stringField(obj.detail);
    if (!text) return undefined;
    return {
      text,
      docRef: stringField(obj.docRef) ?? stringField(obj.runbookRef),
      kind: stringField(obj.kind)
    };
  }
  return undefined;
}

function normalizeSmtpEvidence(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) out.push(text);
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const source = stringField(obj.source);
      const detail =
        stringField(obj.detail) ??
        stringField(obj.message) ??
        stringField(obj.runStatus) ??
        stringField(obj.lastCompletedStep != null ? String(obj.lastCompletedStep) : undefined);
      const runId = stringField(obj.runId);
      const parts = [source, detail].filter(Boolean).join(": ");
      const suffix = runId ? ` (${runId})` : "";
      const text = `${parts}${suffix}`.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function normalizeSmtpIssues(raw: unknown): NormalizedSmtpIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedSmtpIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    out.push({
      code: stringField(obj.code),
      severity: stringField(obj.severity),
      message: stringField(obj.message),
      fix: normalizeSmtpFix(obj.suggestedFix ?? obj.fix)
    });
  }
  return out;
}

function normalizeSmtpUnit(raw: unknown, index: number): NormalizedSmtpUnit | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const state = stringField(obj.state) ?? "other";
  const domain = stringField(obj.domain);
  const serverSlug = stringField(obj.serverSlug);
  const issues = normalizeSmtpIssues(obj.issues);
  const fixes: NormalizedSmtpFix[] = [];
  const seenFix = new Set<string>();
  const pushFix = (fix: NormalizedSmtpFix | undefined) => {
    if (!fix) return;
    if (seenFix.has(fix.text)) return;
    seenFix.add(fix.text);
    fixes.push(fix);
  };
  pushFix(normalizeSmtpFix(obj.suggestedFix));
  for (const issue of issues) pushFix(issue.fix);
  return {
    key: [domain ?? "?", serverSlug ?? "?", state, index].join("|"),
    state,
    domain,
    smtpHost: stringField(obj.smtpHost) ?? stringField(obj.host),
    serverSlug,
    serverIp: stringField(obj.serverIp) ?? stringField(obj.ipv4),
    since: stringField(obj.since) ?? stringField(obj.observedAt),
    credentialStatus: stringField(obj.credentialStatus),
    tlsStatus: stringField(obj.tlsStatus),
    evidence: normalizeSmtpEvidence(obj.evidence),
    issues,
    fixes
  };
}

export function normalizeSmtpHealth(raw: unknown): NormalizedSmtpHealth {
  const collect = (list: unknown): NormalizedSmtpUnit[] => {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry, index) => normalizeSmtpUnit(entry, index))
      .filter((unit): unit is NormalizedSmtpUnit => unit !== null);
  };

  if (Array.isArray(raw)) {
    return { available: true, units: collect(raw), summary: null };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const units = [...collect(obj.units), ...collect(obj.unattachedOrphans)];
    const summary =
      obj.summary && typeof obj.summary === "object"
        ? (obj.summary as Record<string, number>)
        : null;
    return {
      available: true,
      generatedAt: stringField(obj.generatedAt),
      dataSource: stringField(obj.dataSource),
      units,
      summary
    };
  }
  return { available: false, units: [], summary: null };
}

/**
 * Deriva el target del endpoint smtp-health desde el provider del inventario.
 * Solo cuentas de cómputo con SMTP (Webdock / Contabo); el modelo Bedrock y los
 * registradores/DNS quedan fuera. Devuelve null cuando no aplica.
 */
export function deriveSmtpHealthTarget(
  provider: Provider
): { providerId: string; accountId: string } | null {
  if (provider.kind !== "compute") return null;
  const id = provider.id.toLowerCase();
  if (id.includes("bedrock")) return null;
  const brand = brandName(provider).toLowerCase();
  if (brand !== "webdock" && brand !== "contabo") return null;
  return { providerId: brand, accountId: provider.id };
}

async function fetchAccountSmtpHealth(
  providerId: string,
  accountId: string
): Promise<NormalizedSmtpHealth> {
  const url = `/v1/infrastructure/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(
    accountId
  )}/smtp-health`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (response.status === 404) {
    // Endpoint aún no desplegado o cuenta sin SMTP: estado vacío con gracia.
    return { available: false, units: [], summary: null };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
        ? (payload as { message: string }).message
        : `GET ${url} falló (${response.status}).`;
    throw new Error(message);
  }
  return normalizeSmtpHealth(payload);
}

/* ============================================================
 * Brand resolution — brand primario + account label sufijo.
 * ============================================================ */

function brandName(provider: Provider): string {
  const id = provider.id.toLowerCase();
  if (id.startsWith("webdock")) return "Webdock";
  if (id.startsWith("contabo")) return "Contabo";
  if (id.startsWith("namecheap")) return "Namecheap";
  if (id.startsWith("aws-")) return "AWS";
  if (id.startsWith("ionos-")) return "IONOS";
  if (id.startsWith("porkbun")) return "Porkbun";
  if (id.startsWith("physical-")) return "Servidor físico";
  const dn = provider.displayName.toLowerCase();
  if (dn.includes("webdock")) return "Webdock";
  if (dn.includes("contabo")) return "Contabo";
  if (dn.includes("namecheap")) return "Namecheap";
  if (dn.includes("aws")) return "AWS";
  if (dn.includes("ionos")) return "IONOS";
  if (dn.includes("porkbun")) return "Porkbun";
  if (dn.includes("físico") || dn.includes("fisico")) return "Servidor físico";
  return provider.displayName;
}

function accountSuffix(provider: Provider): string {
  const brand = brandName(provider);
  const dn = provider.displayName.trim();
  if (dn === brand) return "";
  if (dn.toLowerCase().startsWith(brand.toLowerCase())) {
    return humanSafeAccountLabel(
      dn.slice(brand.length).trim().replace(/^[·:\-—]+/, "").trim()
    );
  }
  return humanSafeAccountLabel(dn);
}

function humanSafeAccountLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (lower.includes("@") || lower.includes("emael")) return "cuenta operativa";
  return normalized;
}

function providerMonogram(provider: Provider): string {
  const brand = brandName(provider);
  const id = provider.id.toLowerCase();
  if (brand === "Webdock") return "WB";
  if (brand === "Contabo") return "CT";
  if (brand === "AWS") return id.includes("bedrock") ? "AI" : "AW";
  if (brand === "IONOS") return "IO";
  if (brand === "Porkbun") return "PB";
  if (brand === "Servidor físico") return "HW";
  const initials = brand
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "PV";
}

function providerRoleLabel(provider: Provider): string {
  const id = provider.id.toLowerCase();
  if (id.includes("bedrock")) return "Modelo LLM de OpenClaw";
  if (provider.kind === "compute") return "VPS de operación autorizada";
  if (provider.kind === "dns") return "DNS gestionado";
  if (provider.kind === "domain-registrar") return "Registrador de dominios";
  return "Host físico de respaldo";
}

function resourceLabel(provider: Provider): string {
  // Anti-confusion: nunca mostrar un conteo que no proviene de una lectura real.
  // Una cuenta en error (ej. 401) o en modo demo no tiene un conteo confiable;
  // mostrar "3 servidores" junto a "Credencial rechazada" es un dato fantasma.
  if (provider.status === "error") return "conteo no disponible";
  if (provider.fetchSourceKind !== "live") return "sin recursos reales";
  const count = provider.itemCount;
  const noun = providerResourceNoun(provider);
  return formatCount(count, noun.singular, noun.plural);
}

function sourceLabel(provider: Provider): string {
  if (provider.fetchSourceKind === "live") return "API real";
  if (provider.fetchSourceKind === "mock") return "modo demo";
  return "sin fuente";
}

function technicalSummary(provider: Provider): string {
  return `${provider.id} · ${provider.capabilities.join(" · ") || "sin capabilities"}`;
}

/* ============================================================
 * Estado helpers.
 * ============================================================ */

const STATUS_TONE: Record<
  ProviderStatus,
  "success" | "warning" | "critical" | "neutral"
> = {
  active: "success",
  paused: "warning",
  error: "critical",
  planned: "neutral"
};

const STATUS_LABEL_FALLBACK: Record<ProviderStatus, string> = {
  active: "activo",
  paused: "pausado",
  error: "error",
  planned: "planeado"
};

const STALE_FETCH_MS = 24 * 60 * 60 * 1000;

function statusLabelOf(p: Provider): string {
  return p.statusLabel ?? STATUS_LABEL_FALLBACK[p.status];
}

function isProviderStale(p: Provider): boolean {
  if (p.status !== "active" || p.fetchSourceKind !== "live") return false;
  if (!p.lastFetched) return true;
  const fetchedAt = new Date(p.lastFetched).getTime();
  if (Number.isNaN(fetchedAt)) return false;
  return Date.now() - fetchedAt > STALE_FETCH_MS;
}

function providerStatusTone(p: Provider): "success" | "warning" | "critical" | "neutral" {
  if (isProviderStale(p)) return "warning";
  return STATUS_TONE[p.status];
}

function providerStatusLabel(p: Provider): string {
  if (isProviderStale(p)) return "dato viejo";
  return statusLabelOf(p);
}

function itemTotalOf(providers: Provider[]): number {
  return providers.reduce((sum, provider) => sum + provider.itemCount, 0);
}

type ProviderBucket = "attention" | "connected" | "queued";

interface ProviderGroupSummary {
  totalAccounts: number;
  realResourceCount: number;
  connectedCount: number;
  attentionCount: number;
  queuedCount: number;
}

type ProviderRenderEntry =
  | { type: "group"; brand: string; monogram: string; summary: ProviderGroupSummary; providers: Provider[] }
  | { type: "rows"; providers: Provider[] };

function classifyProvider(provider: Provider): ProviderBucket {
  if (provider.status === "error" || isOfflineLike(provider)) return "attention";
  if (provider.status === "planned" || provider.fetchSourceKind === "mock") return "queued";
  if (provider.status === "active" || provider.status === "paused") {
    return "connected";
  }
  return "queued";
}

function canExpandProvider(provider: Provider): boolean {
  return (
    provider.fetchSourceKind === "live" &&
    provider.status !== "error" &&
    (provider.items?.length ?? 0) > 0
  );
}

function realResourceCount(provider: Provider): number {
  return provider.fetchSourceKind === "live" && provider.status !== "error"
    ? provider.itemCount
    : 0;
}

function providerResourceNoun(provider: Provider): { singular: string; plural: string } {
  if (provider.id.toLowerCase().includes("bedrock")) {
    return { singular: "modelo", plural: "modelos" };
  }
  if (provider.kind === "compute") {
    return { singular: "servidor", plural: "servidores" };
  }
  if (provider.kind === "dns") {
    return { singular: "zona DNS", plural: "zonas DNS" };
  }
  if (provider.kind === "domain-registrar") {
    return { singular: "dominio", plural: "dominios" };
  }
  if (provider.kind === "physical") {
    return { singular: "host", plural: "hosts" };
  }
  return { singular: "recurso", plural: "recursos" };
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildProviderGroupSummary(brand: string, allProviders: Provider[]): ProviderGroupSummary {
  const brandProviders = allProviders.filter((provider) => brandName(provider) === brand);
  return {
    totalAccounts: brandProviders.length,
    realResourceCount: brandProviders.reduce((sum, provider) => sum + realResourceCount(provider), 0),
    connectedCount: brandProviders.filter((provider) => classifyProvider(provider) === "connected").length,
    attentionCount: brandProviders.filter((provider) => classifyProvider(provider) === "attention").length,
    queuedCount: brandProviders.filter((provider) => classifyProvider(provider) === "queued").length
  };
}

function buildProviderRenderEntries(
  connectedProviders: Provider[],
  allProviders: Provider[]
): ProviderRenderEntry[] {
  const byBrand = new Map<string, Provider[]>();
  for (const provider of connectedProviders) {
    const brand = brandName(provider);
    byBrand.set(brand, [...(byBrand.get(brand) ?? []), provider]);
  }

  const entries: ProviderRenderEntry[] = [];
  let rowBuffer: Provider[] = [];
  const renderedBrands = new Set<string>();

  const flushRows = () => {
    if (rowBuffer.length === 0) return;
    entries.push({ type: "rows", providers: rowBuffer });
    rowBuffer = [];
  };

  for (const provider of connectedProviders) {
    const brand = brandName(provider);
    const brandProviders = byBrand.get(brand) ?? [];
    if (brandProviders.length < 2) {
      rowBuffer.push(provider);
      continue;
    }
    if (renderedBrands.has(brand)) continue;
    flushRows();
    renderedBrands.add(brand);
    entries.push({
      type: "group",
      brand,
      monogram: providerMonogram(provider),
      summary: buildProviderGroupSummary(brand, allProviders),
      providers: brandProviders
    });
  }

  flushRows();
  return entries;
}

/* ============================================================
 * Helpers de tiempo.
 * ============================================================ */

function formatRelative(iso: string | null): string {
  if (!iso) return "sin fetch";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return new Date(iso).toLocaleString("es-CO");
  if (diffMs < 60_000) return `hace ${Math.round(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `hace ${Math.round(diffMs / 60_000)} min`;
  if (diffMs < 86_400_000) return `hace ${Math.round(diffMs / 3_600_000)} h`;
  if (diffMs < 86_400_000 * 30) return `hace ${Math.round(diffMs / 86_400_000)} d`;
  return new Date(iso).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short"
  });
}

/* ============================================================
 * Detección semántica de "offline" vs "error de credencial".
 *
 * "Offline" = recurso físico/servidor que no respondió todavía
 * (errorReason típico: not_online_yet, offline, unreachable).
 * "Error" = todo lo demás (401, 403, timeout en cloud APIs).
 *
 * Esto permite separar CTAs:
 *   - error  → Reautenticar (cambiar API key)
 *   - offline → Marcar online / verificar conexión física
 * ============================================================ */

function isOfflineLike(p: Provider): boolean {
  if (p.kind !== "physical") return false;
  const reason = (p.errorReason ?? "").toLowerCase();
  if (!reason) return p.status === "error";
  return (
    reason.includes("offline") ||
    reason.includes("not_online") ||
    reason.includes("unreachable") ||
    reason.includes("no responde")
  );
}

/* ============================================================
 * Hito 5.12 — pill "actuator" para IONOS Cloud DNS write-mode.
 * Solo se muestra cuando el provider tiene capability "dns:write" porque
 * marca el salto cualitativo "lectura → escritura aprobada".
 * ============================================================ */

function isIonosDnsActuator(p: Provider | undefined): boolean {
  return (
    p?.id === "ionos-cloud-dns" &&
    p.capabilities.includes("dns:write")
  );
}

/* ============================================================
 * PR-08 — Realtime push-to-pull.
 *
 * El WSS del hub Canvas Live solo AVISA que cambió el inventario; el fetch
 * auditado sigue siendo el endpoint. Al recibir el evento invalidamos la query
 * y react-query refetchea sin recargar la página.
 * ============================================================ */

function useInfrastructureLiveInvalidation(): void {
  const queryClient = useQueryClient();
  const onEvent = useCallback(
    ({ type }: { type: string }) => {
      if (type === "infra.inventory.updated") {
        void queryClient.invalidateQueries({ queryKey: ["v5", "infrastructure", "inventory"] });
        // El drill-down de salud SMTP también depende del inventario live.
        void queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "v5" &&
            query.queryKey[1] === "infrastructure" &&
            query.queryKey[2] === "smtp-health"
        });
      } else if (type === "infra.smtp_health.updated") {
        void queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "v5" &&
            query.queryKey[1] === "infrastructure" &&
            query.queryKey[2] === "smtp-health"
        });
      } else if (type === "senderpool.inventory.updated") {
        // La vista Sender Pool comparte el mismo QueryClient de la app.
        void queryClient.invalidateQueries({ queryKey: ["sender-pool", "status"] });
      }
    },
    [queryClient]
  );
  useCanvasLiveEventSubscription(
    ["infra.inventory.updated", "infra.smtp_health.updated", "senderpool.inventory.updated"],
    onEvent
  );
}

/* ============================================================
 * Vista principal.
 * ============================================================ */

export function InfrastructureV5() {
  const state = useInventory();
  useInfrastructureLiveInvalidation();
  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Inventario multi-proveedor"
          meta="Solo lectura"
          title="Toda tu infraestructura, en una sola vista."
          body="Proveedores VPS, DNS, dominios, LLM y hardware agrupados por función. Solo lectura. Cada fetch firmado en audit chain."
          trailing={
            <LivePollSide
              lastUpdateAt={
                state.status === "ok" ? state.lastUpdateAt : null
              }
              isError={state.status === "error"}
            />
          }
        />
      </motion.div>

      <Body state={state} />
    </motion.div>
  );
}

function Body({ state }: { state: FetchState }) {
  if (state.status === "loading") {
    return (
      <motion.div variants={staggerItem}>
        <LoadingBlock />
      </motion.div>
    );
  }
  if (state.status === "error") {
    return (
      <motion.div variants={staggerItem}>
        <BackendUnavailable message={state.message} />
      </motion.div>
    );
  }
  if (state.payload.providers.length === 0) {
    return (
      <motion.div variants={staggerItem}>
        <RegistryEmpty />
      </motion.div>
    );
  }
  return <Loaded payload={state.payload} />;
}

/* ============================================================
 * Trailing del PageHead — pulso vivo + intervalo.
 * ============================================================ */

function LivePollSide({
  lastUpdateAt,
  isError
}: {
  lastUpdateAt: number | null;
  isError: boolean;
}) {
  const relative = lastUpdateAt
    ? formatRelative(new Date(lastUpdateAt).toISOString())
    : "sin datos";
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Pill tone={isError ? "critical" : "success"} size="sm">
        {isError ? "fallo" : "en vivo"}
      </Pill>
      <Caption className="text-[11px]">poll {POLL_MS / 1000}s · {relative}</Caption>
    </div>
  );
}

/* ============================================================
 * Loaded — estructura principal.
 * ============================================================ */

function Loaded({ payload }: { payload: InfrastructureInventoryResponse }) {
  const providers = payload.providers;
  const errors = providers.filter((p) => p.status === "error" && !isOfflineLike(p));
  const offline = providers.filter(isOfflineLike);
  const okCount = providers.filter((p) => p.status === "active").length;
  const plannedCount = providers.filter((p) => p.status === "planned").length;
  const staleCount = providers.filter(isProviderStale).length;
  const mockCount = providers.filter((p) => p.fetchSourceKind === "mock").length;

  const attentionItems = [...errors, ...offline];
  const connectedProviders = providers.filter((provider) => classifyProvider(provider) === "connected");
  const queuedProviders = providers.filter((provider) => classifyProvider(provider) === "queued");
  const visibleProviders = providers.filter((provider) => classifyProvider(provider) !== "attention");
  const connectedCompute = connectedProviders.filter((p) => p.kind === "compute");
  const queuedCompute = queuedProviders.filter((p) => p.kind === "compute");
  const connectedDns = connectedProviders.filter(
    (p) => p.kind === "dns" || p.kind === "domain-registrar"
  );
  const queuedDns = queuedProviders.filter(
    (p) => p.kind === "dns" || p.kind === "domain-registrar"
  );
  const physical = visibleProviders.filter((p) => p.kind === "physical");
  const computeCount = connectedCompute.length + queuedCompute.length;
  const dnsCount = connectedDns.length + queuedDns.length;
  const ionosDnsProvider = providers.find((p) => p.id === "ionos-cloud-dns");
  const dnsCaption = isIonosDnsActuator(ionosDnsProvider)
    ? "Zonas, registros y registradores. IONOS Cloud DNS expone escritura aprobada por contrato; compra de dominios exige doble aprobación humana."
    : "Zonas, registros y registradores en lectura. Los cambios reales siguen bloqueados hasta contrato auditado y aprobación humana.";

  const attentionSummary =
    attentionItems.length === 0
      ? "Inventario sin proveedores en atención."
      : `${attentionItems.length} proveedor${attentionItems.length === 1 ? "" : "es"} requieren atención.`;

  return (
    <>
      <motion.section variants={staggerItem}>
        <KpiStrip
          itemTotal={payload.itemTotal ?? itemTotalOf(providers)}
          okCount={okCount}
          attentionCount={attentionItems.length}
          plannedCount={plannedCount}
          staleOrMockCount={staleCount + mockCount}
          providers={providers}
        />
      </motion.section>

      {attentionItems.length > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {attentionSummary}
          </span>
          <SectionHead
            eyebrow="Prioridad"
            title="Atención requerida"
            caption="Proveedores con error de credencial o sin respuesta. Cualquier remediación real queda pendiente de contrato auditado."
            count={attentionItems.length}
            countTone="critical"
          />
          <div className="flex flex-col gap-2">
            {errors.map((p) => (
              <AttentionRow key={p.id} provider={p} kind="error" />
            ))}
            {offline.map((p) => (
              <AttentionRow key={p.id} provider={p} kind="offline" />
            ))}
          </div>
          <BannerOpenClawV2 errorCount={errors.length} offlineCount={offline.length} />
        </motion.section>
      ) : null}

      {computeCount > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="Cómputo"
            title="Compute"
            caption="Cuentas VPS y modelo Bedrock que sostienen operación, agentes y planos de control."
            count={computeCount}
            countTone="neutral"
          />
          <ProviderSectionInventory
            allProviders={providers}
            connectedProviders={connectedCompute}
            queuedProviders={queuedCompute}
          />
        </motion.section>
      ) : null}

      {dnsCount > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="DNS y dominios"
            title="DNS · Domains"
            caption={dnsCaption}
            count={dnsCount}
            countTone="neutral"
          />
          <ProviderSectionInventory
            allProviders={providers}
            connectedProviders={connectedDns}
            queuedProviders={queuedDns}
          />
        </motion.section>
      ) : null}

      {physical.length > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="Hardware"
            title="Servidor físico"
            caption="IBM System x 2U en Medellín. Garantía vencida; rol de respaldo y laboratorio."
            count={physical.length}
            countTone="neutral"
          />
          <div className="flex flex-col gap-2">
            {physical.map((p) => (
              <PhysicalCard key={p.id} provider={p} />
            ))}
          </div>
        </motion.section>
      ) : null}

      <motion.div variants={staggerItem}>
        <FooterMeta providers={providers} />
      </motion.div>
    </>
  );
}

/* ============================================================
 * KPI Strip — 4 stats ejecutivos.
 * ============================================================ */

function KpiStrip({
  itemTotal,
  okCount,
  attentionCount,
  plannedCount,
  staleOrMockCount,
  providers
}: {
  itemTotal: number;
  okCount: number;
  attentionCount: number;
  plannedCount: number;
  staleOrMockCount: number;
  providers: Provider[];
}) {
  const byKind = useMemo(() => {
    const map: Record<ProviderKind, number> = {
      compute: 0,
      dns: 0,
      "domain-registrar": 0,
      physical: 0
    };
    for (const p of providers) {
      // Solo contamos recursos de lecturas reales (live) y no en error: los
      // conteos mock/401 son fantasmas y no deben inflar el inventario.
      if (p.fetchSourceKind === "live" && p.status !== "error") {
        map[p.kind] += p.itemCount;
      }
    }
    return map;
  }, [providers]);

  const realTotal =
    byKind.compute + byKind.dns + byKind["domain-registrar"] + byKind.physical;
  const okHint = `${byKind.compute} compute · ${byKind.dns + byKind["domain-registrar"]} dns/dom · de ${itemTotal} configurados`;
  const attentionHint =
    attentionCount === 0
      ? "Sin proveedores bloqueados"
      : `${attentionCount === 1 ? "1 proveedor" : `${attentionCount} proveedores`} requiere acción`;
  const plannedHint =
    plannedCount === 0 ? "Sin proveedores en cola" : "Esperan onboarding";
  const staleHint =
    staleOrMockCount === 0
      ? "Lecturas frescas"
      : `${staleOrMockCount === 1 ? "1 fuente" : `${staleOrMockCount} fuentes`} con mock o dato viejo`;
  const freshnessHint = plannedCount > 0
    ? `${staleHint} · ${plannedHint}`
    : staleHint;

  return (
    <Card padding="relaxed">
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat
          label="Recursos reales"
          value={realTotal}
          unit={realTotal === 1 ? "recurso" : "recursos"}
          tone={realTotal > 0 ? "success" : "default"}
          hint={okHint}
        />
        <Stat
          label="Proveedores conectados"
          value={okCount}
          unit={okCount === 1 ? "proveedor" : "proveedores"}
          tone={okCount > 0 ? "success" : "default"}
          hint={`${okCount} activos · ${plannedCount} en cola`}
        />
        <Stat
          label="Atención"
          value={attentionCount}
          unit={attentionCount === 1 ? "caso" : "casos"}
          tone={attentionCount > 0 ? "critical" : "default"}
          hint={attentionHint}
        />
        <Stat
          label="Datos viejos/mock"
          value={staleOrMockCount}
          unit={staleOrMockCount === 1 ? "fuente" : "fuentes"}
          tone={staleOrMockCount > 0 ? "warning" : "default"}
          hint={freshnessHint}
        />
      </div>
    </Card>
  );
}

/* ============================================================
 * AttentionRow — fila accionable para error/offline.
 * ============================================================ */

function AttentionRow({
  provider,
  kind
}: {
  provider: Provider;
  kind: "error" | "offline";
}) {
  const [expanded, setExpanded] = useState(false);
  const borderColor =
    kind === "error" ? "var(--color-critical-border)" : "var(--color-warning-border)";
  const accent =
    kind === "error" ? "var(--color-critical)" : "var(--color-warning)";
  const accentSoft =
    kind === "error" ? "var(--color-critical-soft)" : "var(--color-warning-soft)";
  const Icon = kind === "error" ? KeyRound : PowerOff;
  const ctaLabel = kind === "error" ? "Reautenticar" : "Marcar online";
  const reasonLabel = kind === "error" ? "Credencial rechazada" : "Sin respuesta";
  const detailsId = `attention-detail-${provider.id}`;
  const canExpand = canExpandProvider(provider);
  return (
    <Card
      padding="default"
      className="flex flex-col gap-3"
      style={{ borderColor, background: "var(--color-surface)" }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <div
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-md"
          style={{ background: accentSoft, color: accent }}
        >
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-sans text-[14px] font-semibold leading-none text-fg">
              {brandName(provider)}
            </span>
            {accountSuffix(provider) ? (
              <Caption className="truncate">· {accountSuffix(provider)}</Caption>
            ) : null}
            <Pill tone={kind === "error" ? "critical" : "warning"} size="sm">
              {reasonLabel}
            </Pill>
          </div>
          <Caption className="truncate" title={technicalSummary(provider)}>
            {providerRoleLabel(provider)} · {resourceLabel(provider)}
          </Caption>
          <MonoCode className="truncate" title={provider.errorReason}>
            {provider.errorReason ?? statusLabelOf(provider)}
          </MonoCode>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start md:self-auto">
          {canExpand ? (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Ocultar" : "Ver detalle"}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled
            title="Requiere contrato de ejecución, approval gate y rollback verificado."
          >
            {ctaLabel}
            <ArrowRight size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </div>
      {canExpand && expanded ? <ProviderDetail provider={provider} id={detailsId} /> : null}
    </Card>
  );
}

/* ============================================================
 * BannerOpenClawV2 — superficie always-dark.
 * ============================================================ */

function BannerOpenClawV2({
  errorCount,
  offlineCount
}: {
  errorCount: number;
  offlineCount: number;
}) {
  const total = errorCount + offlineCount;
  const summary =
    errorCount > 0 && offlineCount > 0
      ? `${errorCount} error de credencial · ${offlineCount} sin respuesta`
      : errorCount > 0
      ? `${errorCount === 1 ? "1 cuenta" : `${errorCount} cuentas`} requieren reautenticación`
      : `${offlineCount === 1 ? "1 host" : `${offlineCount} hosts`} sin respuesta`;
  return (
    <div
      className="rounded-[10px] p-5"
      style={{
        background: "var(--color-always-dark-bg)",
        border: "1px solid var(--color-always-dark-border)",
        color: "var(--color-on-dark-strong)"
      }}
    >
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-md"
          style={{
            background: "var(--color-always-dark-raised)",
            color: "var(--color-on-dark-strong)",
            border: "1px solid var(--color-always-dark-border-strong)"
          }}
        >
          <TriangleAlert size={16} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-[10px] font-semibold uppercase leading-none"
              style={{
                letterSpacing: "0.14em",
                color: "var(--color-on-dark-medium)"
              }}
            >
              OpenClaw propone
            </span>
            <span
              aria-hidden="true"
              className="inline-block size-[3px] rounded-full"
              style={{ background: "var(--color-on-dark-faint)" }}
            />
            <span
              className="font-mono text-[10px] leading-none"
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              dry-run
            </span>
          </div>
          <h3
            className="m-0 font-heading text-[13px] font-semibold leading-[1.3]"
            style={{ color: "var(--color-on-dark-strong)" }}
          >
            Coordinar la remediación de {total === 1 ? "1 proveedor" : `${total} proveedores`}
          </h3>
          <p
            className="m-0 font-sans text-[13px] leading-[1.5]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            {summary}. Puedo preparar el plan con human-in-the-loop: rotar la
            API key, revalidar el endpoint o agendar reinicio físico. Nada se
            ejecuta sin tu firma.
          </p>
          <HumanNote
            className="mt-1"
            style={{ color: "var(--color-on-dark-soft)" }}
          >
            Plan de remediación pendiente de contrato de ejecución aprobado.
          </HumanNote>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled
              title="Pendiente de approval gate, audit log y rollback verificado."
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-fg)"
              }}
            >
              Preparar plan
              <ArrowRight size={11} strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="El chat operativo no está conectado desde esta vista."
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              Abrir chat
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * ProviderSectionInventory — grupos conectados + cola plegada.
 * ============================================================ */

function ProviderSectionInventory({
  allProviders,
  connectedProviders,
  queuedProviders
}: {
  allProviders: Provider[];
  connectedProviders: Provider[];
  queuedProviders: Provider[];
}) {
  const entries = buildProviderRenderEntries(connectedProviders, allProviders);
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) =>
        entry.type === "group" ? (
          <ProviderGroup
            key={`group-${entry.brand}`}
            brand={entry.brand}
            monogram={entry.monogram}
            summary={entry.summary}
            providers={entry.providers}
          />
        ) : (
          <ProviderList
            key={`rows-${entry.providers.map((provider) => provider.id).join("-")}`}
            providers={entry.providers}
          />
        )
      )}
      {queuedProviders.length > 0 ? (
        <CollapsibleSection
          title="En cola / sin conectar"
          count={queuedProviders.length}
          defaultOpen={false}
        >
          <ProviderList providers={queuedProviders} />
        </CollapsibleSection>
      ) : null}
    </div>
  );
}

function ProviderGroup({
  brand,
  monogram,
  summary,
  providers
}: {
  brand: string;
  monogram: string;
  summary: ProviderGroupSummary;
  providers: Provider[];
}) {
  const noun = providers[0] ? providerResourceNoun(providers[0]) : { singular: "recurso", plural: "recursos" };
  const statusParts = [
    summary.connectedCount > 0 ? `${summary.connectedCount} conectada${summary.connectedCount === 1 ? "" : "s"}` : null,
    summary.attentionCount > 0 ? `${summary.attentionCount} en atención ↑` : null,
    summary.queuedCount > 0 ? `${summary.queuedCount} en cola ↓` : null
  ].filter(Boolean);

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-md border border-border-strong bg-surface-sunken font-mono text-[11px] font-semibold text-fg"
          >
            {monogram}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-2">
              <span className="truncate font-sans text-[13.5px] font-semibold leading-none text-fg">
                {brand}
              </span>
              <Caption>
                {summary.totalAccounts > 1
                  ? `${summary.totalAccounts} cuentas distintas`
                  : formatCount(summary.totalAccounts, "cuenta", "cuentas")}{" "}
                ·{" "}
                {formatCount(summary.realResourceCount, `${noun.singular} real`, `${noun.plural} reales`)}
              </Caption>
            </div>
            {statusParts.length > 0 ? (
              <Caption>{statusParts.join(" · ")}</Caption>
            ) : null}
          </div>
        </div>
        <Pill tone="success" size="sm">
          grupo
        </Pill>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {providers.map((provider, index) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            index={index}
            accountPosition={{ index: index + 1, total: providers.length }}
          />
        ))}
      </ul>
    </Card>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen,
  children
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const sectionId = `infra-collapsible-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={sectionId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors duration-150 hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-sans text-[12.5px] font-semibold text-fg">{title}</span>
          <Pill tone="neutral" size="sm">
            {count}
          </Pill>
        </span>
        <MonoData className="text-[11px] text-fg-subtle">{open ? "ocultar" : "mostrar"}</MonoData>
      </button>
      {open ? (
        <div id={sectionId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * ProviderList / ProviderRow — fila densa con drill-down real.
 * ============================================================ */

function ProviderList({ providers }: { providers: Provider[] }) {
  return (
    <Card padding="none" className="overflow-hidden">
      <ul className="m-0 flex list-none flex-col p-0">
        {providers.map((provider, index) => (
          <ProviderRow key={provider.id} provider={provider} index={index} />
        ))}
      </ul>
    </Card>
  );
}

function ProviderRow({
  provider,
  index,
  accountPosition
}: {
  provider: Provider;
  index: number;
  /**
   * Posición de la cuenta dentro de un grupo de marca con MÚLTIPLES cuentas reales distintas
   * (ej. Contabo "Host Latam" vs "infravps"). Cuando total > 1 mostramos "cuenta N de M" para que
   * dos cuentas legítimas no se lean como un duplicado.
   */
  accountPosition?: { index: number; total: number };
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = canExpandProvider(provider);
  const detailsId = `provider-detail-${provider.id}`;
  const showAccountPosition = accountPosition !== undefined && accountPosition.total > 1;
  return (
    <li
      className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:grid-cols-[36px_minmax(160px,1.15fr)_minmax(140px,0.9fr)_auto_auto_auto_auto_auto]"
      style={{
        borderTop: index === 0 ? "none" : "1px solid var(--color-border)"
      }}
    >
      <div
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-md border border-border-strong bg-surface-sunken font-mono text-[11px] font-semibold text-fg"
      >
        {providerMonogram(provider)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-sans text-[13.5px] font-semibold leading-none text-fg">
            {brandName(provider)}
          </span>
          {accountSuffix(provider) ? (
            <span className="truncate font-sans text-[12.5px] text-fg-muted">
              · {accountSuffix(provider)}
            </span>
          ) : null}
          {showAccountPosition ? (
            <Pill
              tone="neutral"
              size="sm"
              className="shrink-0"
              title={`Cuenta real distinta ${accountPosition.index} de ${accountPosition.total} · ${provider.id}`}
            >
              cuenta {accountPosition.index} de {accountPosition.total}
            </Pill>
          ) : null}
        </div>
        <Caption className="truncate md:hidden" title={technicalSummary(provider)}>
          {provider.kind !== "compute" || provider.id.toLowerCase().includes("bedrock")
            ? `${providerRoleLabel(provider)} · ${resourceLabel(provider)}`
            : resourceLabel(provider)}
        </Caption>
      </div>
      <Caption className="hidden truncate md:block" title={technicalSummary(provider)}>
        {provider.kind !== "compute" || provider.id.toLowerCase().includes("bedrock")
          ? providerRoleLabel(provider)
          : ""}
      </Caption>
      <Badge className="hidden justify-self-start md:inline-flex">
        {resourceLabel(provider)}
      </Badge>
      <div className="hidden min-w-[92px] flex-col items-start gap-0.5 lg:flex">
        <MonoData className="text-[11px] text-fg-subtle" title={provider.lastFetched ?? undefined}>
          {formatRelative(provider.lastFetched)}
        </MonoData>
        <Caption className="text-[10.5px]">{sourceLabel(provider)}</Caption>
      </div>
      {isIonosDnsActuator(provider) ? (
        <Pill tone="success" size="sm" className="hidden md:inline-flex">
          actuator
        </Pill>
      ) : null}
      <Pill tone={providerStatusTone(provider)} size="sm">
        {providerStatusLabel(provider)}
      </Pill>
      {canExpand ? (
        <Button
          variant="outline"
          size="sm"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
          className="col-span-3 justify-self-start md:col-span-1 md:justify-self-end"
        >
          {expanded ? "Ocultar" : "Ver detalle"}
        </Button>
      ) : null}
      {canExpand && expanded ? (
        <ProviderDetail
          provider={provider}
          id={detailsId}
          className="col-span-full"
        />
      ) : null}
    </li>
  );
}

function ProviderDetail({
  provider,
  id,
  className
}: {
  provider: Provider;
  id: string;
  className?: string;
}) {
  const smtpTarget = deriveSmtpHealthTarget(provider);
  return (
    <div
      id={id}
      className={[
        "flex flex-col gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2",
        className ?? ""
      ].join(" ")}
    >
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Eyebrow>Detalle read-only</Eyebrow>
          <Badge>{sourceLabel(provider)}</Badge>
        </div>
        {provider.items && provider.items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {provider.items.map((item) => (
              <li
                key={item.id}
                className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_auto] gap-3"
              >
                <MonoData className="truncate text-[11px] text-fg-subtle">{item.id}</MonoData>
                <Caption className="truncate">{item.displayName}</Caption>
                <MonoData className="text-[11px] text-fg-subtle">{item.status}</MonoData>
              </li>
            ))}
          </ul>
        ) : (
          <Caption>Sin recursos reportados en este fetch.</Caption>
        )}
      </div>
      {smtpTarget ? (
        <AccountSmtpHealthDetail
          providerId={smtpTarget.providerId}
          accountId={smtpTarget.accountId}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
 * PR-10 — AccountSmtpHealthDetail (drill-down salud SMTP, read-only).
 * ============================================================ */

function AccountSmtpHealthDetail({
  providerId,
  accountId
}: {
  providerId: string;
  accountId: string;
}) {
  const query = useQuery({
    queryKey: ["v5", "infrastructure", "smtp-health", providerId, accountId],
    queryFn: () => fetchAccountSmtpHealth(providerId, accountId),
    refetchInterval: SMTP_HEALTH_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: SMTP_HEALTH_POLL_MS / 2
  });

  const groups = useMemo(() => groupSmtpUnits(query.data?.units ?? []), [query.data]);
  const staleMinutes = query.dataUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - query.dataUpdatedAt) / 60_000))
    : 0;

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert size={13} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
          <Eyebrow>Salud SMTP de la cuenta</Eyebrow>
          <RealtimeTick active={query.isFetching} />
        </div>
        <div className="flex items-center gap-2">
          {query.dataUpdatedAt ? <StaleBadge minutesAgo={staleMinutes} /> : null}
          <MonoCode className="text-[10.5px] text-fg-subtle">
            {providerId}/{accountId}
          </MonoCode>
        </div>
      </div>

      {query.isLoading ? (
        <Caption>Consultando salud SMTP…</Caption>
      ) : query.isError ? (
        <div className="flex flex-col gap-1">
          <Caption>No se pudo leer la salud SMTP de esta cuenta.</Caption>
          <MonoCode className="break-all text-[10.5px] text-fg-subtle">
            {query.error instanceof Error ? query.error.message : "error desconocido"}
          </MonoCode>
        </div>
      ) : !query.data || query.data.units.length === 0 ? (
        <Caption>
          {query.data && !query.data.available
            ? "Endpoint smtp-health aún no disponible para esta cuenta."
            : "Sin SMTPs reportados para esta cuenta en este fetch."}
        </Caption>
      ) : (
        <div className="flex flex-col gap-3">
          <SmtpHealthSummary groups={groups} />
          {SMTP_GROUP_ORDER.map((group) => {
            const units = groups[group];
            if (!units || units.length === 0) return null;
            return <SmtpHealthGroup key={group} group={group} units={units} />;
          })}
        </div>
      )}
    </div>
  );
}

function groupSmtpUnits(units: NormalizedSmtpUnit[]): Record<SmtpStateGroup, NormalizedSmtpUnit[]> {
  const out: Record<SmtpStateGroup, NormalizedSmtpUnit[]> = {
    active: [],
    down: [],
    error: [],
    orphan: [],
    no_smtp: [],
    pending: [],
    other: []
  };
  for (const unit of units) out[smtpStateGroup(unit.state)].push(unit);
  return out;
}

function SmtpHealthSummary({
  groups
}: {
  groups: Record<SmtpStateGroup, NormalizedSmtpUnit[]>;
}) {
  const chips = SMTP_GROUP_ORDER.map((group) => ({
    group,
    count: groups[group]?.length ?? 0
  })).filter((chip) => chip.count > 0);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Pill key={chip.group} tone={SMTP_GROUP_TONE[chip.group]} size="sm">
          {SMTP_GROUP_LABEL[chip.group]} {chip.count}
        </Pill>
      ))}
    </div>
  );
}

function SmtpHealthGroup({
  group,
  units
}: {
  group: SmtpStateGroup;
  units: NormalizedSmtpUnit[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Pill tone={SMTP_GROUP_TONE[group]} size="sm">
          {SMTP_GROUP_LABEL[group]}
        </Pill>
        <Caption>{units.length}</Caption>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {units.map((unit) => (
          <SmtpHealthUnitRow key={unit.key} unit={unit} tone={SMTP_GROUP_TONE[group]} />
        ))}
      </ul>
    </div>
  );
}

function SmtpHealthUnitRow({
  unit,
  tone
}: {
  unit: NormalizedSmtpUnit;
  tone: "success" | "warning" | "critical" | "neutral";
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `smtp-unit-${unit.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const hasDetail = unit.evidence.length > 0 || unit.issues.length > 0 || unit.fixes.length > 0;
  const label = unit.domain ?? unit.smtpHost ?? unit.serverSlug ?? "SMTP sin dominio";
  return (
    <li className="rounded-md border border-border bg-surface-sunken px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-sans text-[12.5px] font-medium text-fg">
          {label}
        </span>
        <Pill tone={tone} size="sm">
          {unit.state}
        </Pill>
        {unit.tlsStatus ? (
          <Caption className="text-[10.5px]">tls {unit.tlsStatus}</Caption>
        ) : null}
        {hasDetail ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            className="ml-auto"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Ocultar" : "Evidencia"}
          </Button>
        ) : null}
      </div>
      {unit.smtpHost || unit.serverSlug || unit.serverIp ? (
        <MonoData className="mt-1 block truncate text-[10.5px] text-fg-subtle">
          {[unit.smtpHost, unit.serverSlug, unit.serverIp].filter(Boolean).join(" · ")}
        </MonoData>
      ) : null}
      {open && hasDetail ? (
        <div id={detailsId} className="mt-2 flex flex-col gap-2">
          {unit.evidence.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Eyebrow>Evidencia</Eyebrow>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {unit.evidence.map((line, index) => (
                  <li key={index}>
                    <MonoData className="text-[10.5px] text-fg-subtle">{line}</MonoData>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unit.fixes.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Eyebrow>Solución sugerida</Eyebrow>
              {unit.fixes.map((fix, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <BodySm>{fix.text}</BodySm>
                  {fix.docRef ? (
                    <Caption className="text-[10.5px]">ref: {fix.docRef}</Caption>
                  ) : null}
                </div>
              ))}
              <div className="mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title="Read-only: la remediación exige contrato de ejecución, approval gate y rollback. Firmá desde el chat de OpenClaw."
                >
                  Requiere approval gate
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ============================================================
 * PhysicalCard — card propia con detail extendido.
 * ============================================================ */

function PhysicalCard({ provider }: { provider: Provider }) {
  const offline = isOfflineLike(provider);
  const detail = (provider.items?.[0]?.detail ?? {}) as Record<string, unknown>;
  const model = stringOrDash(detail.model);
  const location = stringOrDash(detail.location);
  const role = stringOrDash(detail.role);
  return (
    <Card padding="relaxed" className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-md border border-border-strong bg-surface-sunken font-mono text-[11px] font-semibold text-fg"
        >
          {providerMonogram(provider)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <H3>{brandName(provider)}</H3>
            {accountSuffix(provider) ? (
              <Caption className="truncate">· {accountSuffix(provider)}</Caption>
            ) : null}
          </div>
          <BodySm>
            Recurso de respaldo on-premise. No participa de send paths en
            producción.
          </BodySm>
        </div>
        <Pill
          tone={offline ? "warning" : providerStatusTone(provider)}
          size="sm"
        >
          {offline ? "sin respuesta" : providerStatusLabel(provider)}
        </Pill>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetaField label="Modelo" value={model} />
        <MetaField label="Ubicación" value={location} />
        <MetaField label="Rol" value={role} />
        <MetaField label="Último fetch" value={formatRelative(provider.lastFetched)} />
      </div>
    </Card>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow>{label}</Eyebrow>
      <MonoData className="text-[12.5px] text-fg">{value}</MonoData>
    </div>
  );
}

/* ============================================================
 * Footer compacto.
 * ============================================================ */

function FooterMeta({ providers }: { providers: Provider[] }) {
  const liveCount = providers.filter((p) => p.fetchSourceKind === "live").length;
  const mockCount = providers.filter((p) => p.fetchSourceKind === "mock").length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <MonoCode>GET /v1/infrastructure/inventory</MonoCode>
        <span
          aria-hidden="true"
          className="inline-block size-[3px] rounded-full bg-border-strong"
        />
        <Caption>
          {liveCount} live · {mockCount} mock
        </Caption>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled
        title="Pendiente de enlace interno a documentación versionada."
      >
        Docs pendientes
        <ArrowRight size={11} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

/* ============================================================
 * Estados de carga / error / vacío.
 * ============================================================ */

function LoadingBlock() {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <Eyebrow>Cargando</Eyebrow>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div
              className="h-3 w-20 rounded bg-surface-sunken"
              aria-hidden="true"
            />
            <div
              className="h-8 w-16 rounded bg-surface-sunken"
              aria-hidden="true"
            />
          </div>
        ))}
      </div>
      <span className="sr-only">Cargando inventario multi-proveedor…</span>
    </Card>
  );
}

function BackendUnavailable({ message }: { message: string }) {
  return (
    <Card padding="relaxed" className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning"
      >
        <AlertCircle size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <H3>Endpoint /v1/infrastructure/inventory no responde</H3>
        <BodySm>
          El backend todavía no expuso el endpoint unificado. Cuando esté
          disponible, esta vista se llena sin redeploy.
        </BodySm>
        <MonoCode className="break-all">{message}</MonoCode>
      </div>
    </Card>
  );
}

function RegistryEmpty() {
  return (
    <Card padding="relaxed" className="flex items-start gap-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <Cloud size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <H3>Registry vacío</H3>
        <BodySm>
          Sin proveedores configurados. Agregá una API key (Webdock, AWS,
          IONOS o Porkbun) en{" "}
          <MonoCode>/etc/openclaw/skills.env</MonoCode> y recargá.
        </BodySm>
        <div className="mt-1">
          <Button
            variant="outline"
            size="sm"
            disabled
            title="Pendiente de ruta de onboarding conectada desde esta vista."
          >
            Guía pendiente
            <ArrowRight size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * Util.
 * ============================================================ */

function stringOrDash(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "sin dato";
}
