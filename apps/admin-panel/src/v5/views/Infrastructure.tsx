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

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  Cloud,
  Globe,
  HardDrive,
  KeyRound,
  PowerOff,
  Server,
  TriangleAlert
} from "lucide-react";
import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
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
 * Brand resolution — brand primario + account label sufijo.
 * ============================================================ */

function brandName(provider: Provider): string {
  const id = provider.id.toLowerCase();
  if (id.startsWith("webdock")) return "Webdock";
  if (id.startsWith("aws-")) return "AWS";
  if (id.startsWith("ionos-")) return "IONOS";
  if (id.startsWith("porkbun")) return "Porkbun";
  if (id.startsWith("physical-")) return "Servidor físico";
  const dn = provider.displayName.toLowerCase();
  if (dn.includes("webdock")) return "Webdock";
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
    return dn.slice(brand.length).trim().replace(/^[·:\-—]+/, "").trim();
  }
  return dn;
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

function statusLabelOf(p: Provider): string {
  return p.statusLabel ?? STATUS_LABEL_FALLBACK[p.status];
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

function isIonosDnsActuator(p: Provider): boolean {
  return (
    p.id === "ionos-cloud-dns" &&
    p.capabilities.includes("dns:write")
  );
}

/* ============================================================
 * Vista principal.
 * ============================================================ */

export function InfrastructureV5() {
  const state = useInventory();
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
          body="Webdock, AWS, IONOS, Porkbun y el servidor físico, agrupados por función. Solo lectura. Cada fetch firmado en audit chain."
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
  return <Loaded providers={state.payload.providers} />;
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

function Loaded({ providers }: { providers: Provider[] }) {
  const errors = providers.filter((p) => p.status === "error" && !isOfflineLike(p));
  const offline = providers.filter(isOfflineLike);
  const okCount = providers.filter((p) => p.status === "active").length;
  const plannedCount = providers.filter((p) => p.status === "planned").length;

  const compute = providers.filter((p) => p.kind === "compute");
  const dns = providers.filter(
    (p) => p.kind === "dns" || p.kind === "domain-registrar"
  );
  const physical = providers.filter((p) => p.kind === "physical");

  const attentionItems = [...errors, ...offline];

  return (
    <>
      <motion.section variants={staggerItem}>
        <KpiStrip
          okCount={okCount}
          errorCount={errors.length}
          offlineCount={offline.length}
          plannedCount={plannedCount}
          providers={providers}
        />
      </motion.section>

      {attentionItems.length > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="Prioridad"
            title="Atención requerida"
            caption="Proveedores con error de credencial o sin respuesta. OpenClaw puede preparar el plan de remediación."
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

      {compute.length > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="Cómputo"
            title="Compute"
            caption="Cuentas Webdock + AWS Bedrock que sostienen contenedores, agentes y planos de control."
            count={compute.length}
            countTone="neutral"
            trailing={<MonoCode>kind=compute</MonoCode>}
          />
          <ProviderList providers={compute} icon={Server} />
        </motion.section>
      ) : null}

      {dns.length > 0 ? (
        <motion.section variants={staggerItem} className="flex flex-col gap-3">
          <SectionHead
            eyebrow="DNS y dominios"
            title="DNS · Domains"
            caption="Zonas, registros y registradores. IONOS Cloud DNS ya es read+write (actuator). Compra de dominios sigue requiriendo doble aprobación humana (Fase 2)."
            count={dns.length}
            countTone="neutral"
            trailing={<MonoCode>kind=dns | domain-registrar</MonoCode>}
          />
          <ProviderList providers={dns} icon={Globe} />
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
            trailing={<MonoCode>kind=physical</MonoCode>}
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
  okCount,
  errorCount,
  offlineCount,
  plannedCount,
  providers
}: {
  okCount: number;
  errorCount: number;
  offlineCount: number;
  plannedCount: number;
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
      if (p.status === "active") map[p.kind]++;
    }
    return map;
  }, [providers]);

  const okHint = `${byKind.compute} compute · ${byKind.dns + byKind["domain-registrar"]} dns/dom · ${byKind.physical} físico`;
  const errorHint =
    errorCount === 0
      ? "Sin errores de credencial"
      : `${errorCount === 1 ? "1 proveedor" : `${errorCount} proveedores`} con fallo de auth`;
  const offlineHint =
    offlineCount === 0 ? "Todo respondiendo" : "Recurso físico sin respuesta";
  const plannedHint =
    plannedCount === 0 ? "Sin proveedores en cola" : "Esperan onboarding";

  return (
    <Card padding="relaxed">
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat
          label="Operando OK"
          value={okCount}
          unit={okCount === 1 ? "proveedor" : "proveedores"}
          tone={okCount > 0 ? "success" : "default"}
          hint={okHint}
        />
        <Stat
          label="Con error"
          value={errorCount}
          unit={errorCount === 1 ? "cuenta" : "cuentas"}
          tone={errorCount > 0 ? "critical" : "default"}
          hint={errorHint}
        />
        <Stat
          label="Offline"
          value={offlineCount}
          unit={offlineCount === 1 ? "host" : "hosts"}
          tone={offlineCount > 0 ? "warning" : "default"}
          hint={offlineHint}
        />
        <Stat
          label="Planeados"
          value={plannedCount}
          unit={plannedCount === 1 ? "proveedor" : "proveedores"}
          tone="default"
          hint={plannedHint}
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
  const borderColor =
    kind === "error" ? "var(--color-critical-border)" : "var(--color-warning-border)";
  const accent =
    kind === "error" ? "var(--color-critical)" : "var(--color-warning)";
  const accentSoft =
    kind === "error" ? "var(--color-critical-soft)" : "var(--color-warning-soft)";
  const Icon = kind === "error" ? KeyRound : PowerOff;
  const ctaLabel = kind === "error" ? "Reautenticar" : "Marcar online";
  const reasonLabel = kind === "error" ? "Credencial rechazada" : "Sin respuesta";
  return (
    <Card
      padding="default"
      className="flex items-center gap-4"
      style={{ borderColor, background: "var(--color-surface)" }}
    >
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-md"
        style={{ background: accentSoft, color: accent }}
      >
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className="font-sans text-[14px] font-semibold leading-none text-fg"
            style={{ letterSpacing: "-0.01em" }}
          >
            {brandName(provider)}
          </span>
          {accountSuffix(provider) ? (
            <Caption className="truncate">· {accountSuffix(provider)}</Caption>
          ) : null}
          <Pill tone={kind === "error" ? "critical" : "warning"} size="sm">
            {reasonLabel}
          </Pill>
        </div>
        <MonoCode className="truncate" title={provider.errorReason}>
          {provider.errorReason ?? statusLabelOf(provider)} · {provider.id}
        </MonoCode>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm">
          Ver detalle
        </Button>
        <Button variant="primary" size="sm">
          {ctaLabel}
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
      </div>
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
            Si querés, abrí el chat y te explico cada paso antes de proponer.
          </HumanNote>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
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
 * ProviderList — fila densa, no grid.
 * ============================================================ */

function ProviderList({
  providers,
  icon: Icon
}: {
  providers: Provider[];
  icon: typeof Server;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <ul className="m-0 flex list-none flex-col p-0">
        {providers.map((p, idx) => (
          <li
            key={p.id}
            className="flex items-center gap-4 px-4 py-3"
            style={{
              borderTop:
                idx === 0 ? "none" : "1px solid var(--color-border)"
            }}
          >
            <div
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
            >
              <Icon size={14} strokeWidth={1.75} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span
                  className="font-sans text-[13.5px] font-semibold leading-none text-fg"
                  style={{ letterSpacing: "-0.01em" }}
                >
                  {brandName(p)}
                </span>
                {accountSuffix(p) ? (
                  <span className="truncate font-sans text-[12.5px] text-fg-muted">
                    · {accountSuffix(p)}
                  </span>
                ) : null}
              </div>
              <MonoCode className="truncate">
                {p.id} · {p.capabilities.slice(0, 3).join(" · ") || "sin caps"}
              </MonoCode>
            </div>
            <div className="hidden shrink-0 items-center gap-1.5 md:flex">
              <Badge>{p.itemCount} items</Badge>
              <MonoData className="text-[11px] text-fg-subtle">
                {formatRelative(p.lastFetched)}
              </MonoData>
            </div>
            {isIonosDnsActuator(p) ? (
              <Pill tone="success" size="sm">
                actuator
              </Pill>
            ) : null}
            <Pill tone={STATUS_TONE[p.status]} size="sm">
              {statusLabelOf(p)}
            </Pill>
          </li>
        ))}
      </ul>
    </Card>
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
          className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted"
        >
          <HardDrive size={16} strokeWidth={1.75} />
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
          tone={offline ? "warning" : STATUS_TONE[provider.status]}
          size="sm"
        >
          {offline ? "sin respuesta" : statusLabelOf(provider)}
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
      <Button variant="link" size="sm">
        Ver docs del contrato
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
          <Button variant="outline" size="sm">
            Ver guía de onboarding
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

