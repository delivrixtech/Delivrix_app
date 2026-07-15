/**
 * v5 Domains — Fase 1 discover/propose (Hito 5.12).
 *
 * Restyle al MOLDE oficial "Aivora" (src/shared/ui/aivora): mismos primitivos
 * que el demo aprobado (features/overview/TravigueOverviewProto) — Card radius
 * 18 + hairline, KpiCard tile+número tabular, StateBadge dot+icono, SectionHead
 * eyebrow+h1 light, AdvisorCard para OpenClaw. Colores 100% desde tokens
 * (var(--color-*)); cero hex hardcodeado.
 *
 * Disciplina de DATOS:
 *   - Cap mensual $50 USD (config real hardcoded); el consumo del mes es REAL,
 *     derivado del audit chain vía `computeWalletTransactions` (mismo cálculo
 *     que el Wallet de Sender Pool). Cero gasto inventado.
 *   - Compra real bloqueada (`PURCHASE_ENABLED=false`, config real) · la UI lo
 *     muestra semánticamente en el strip de guardrails y en cada CTA.
 *   - WHOIS privacy config real hardcoded true.
 *   - Precio real de Route53 por TLD; sin comparativas fabricadas.
 *   - Sin scoring fabricado: el heurístico anterior (scoreFor) se eliminó por no
 *     reflejar dato real. Los KPIs y gráficas sólo muestran series/valores reales.
 *   - Una sola `HumanNote` (en el AdvisorCard OpenClaw).
 *
 * Endpoints (read-only · features 5104fd9 + ff622f9):
 *   GET /v1/domains/availability?name=...
 *   GET /v1/domains/suggestions?seed=...&count=10
 *   GET /v1/domains/prices?tlds=com,net,io,co
 *   GET /v1/domains/owned
 *   GET /v1/audit-events  (consumo real del cap mensual)
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe,
  Lock,
  Rocket,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  TriangleAlert
} from "lucide-react";
import { getJson, getJsonWithQuery, type AuditEventsPayload } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { computeWalletTransactions } from "./sender-pool-wallet";
import { useOpenClawIntent } from "../../shared/ui/v2";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  AdvisorCard,
  aivoraGradient,
  Button,
  Caption,
  Card,
  Eyebrow,
  KpiCard,
  Pill,
  SectionHead,
  StateBadge
} from "../../shared/ui/aivora";

/* ============================================================
 * Text primitives locales — el molde Aivora no exporta las piezas de texto
 * de párrafo/mono, así que se definen acá con la MISMA tipografía del demo
 * pero 100% por tokens var(--color-*) (cero clases B/N de primitives.tsx).
 * ============================================================ */

function Body({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--color-text-secondary)", ...style }}>
      {children}
    </p>
  );
}

function BodySm({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", ...style }}>
      {children}
    </p>
  );
}

function MonoData({ children, style, title }: { children: ReactNode; style?: CSSProperties; title?: string }) {
  return (
    <span
      title={title}
      style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--color-text-primary)", ...style }}
    >
      {children}
    </span>
  );
}

function MonoCode({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", ...style }}>
      {children}
    </span>
  );
}

/** HumanNote — voz suave de OpenClaw (rationale). Máximo 1 por vista. Sans
 * italic, tono secundario: diferencia tonal sin salir del registro. */
function HumanNote({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontStyle: "italic", fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", ...style }}>
      {children}
    </span>
  );
}

/* ============================================================
 * Constants — guardrails de config REAL para la Fase 1.
 * ============================================================ */

const MONTHLY_CAP_USD = 50;
const PURCHASE_ENABLED = false;
const WHOIS_PRIVACY_ENABLED = true;
const RUNBOOK_PATH = "DOCUMENTACION/runbooks-demo-viernes/flip-purchase-flag.sh";
const DEFAULT_TLDS = ["com", "net", "io", "co"];
const POLL_PRICES_MS = 5 * 60_000;
const POLL_OWNED_MS = 60_000;
const POLL_WALLET_MS = 30_000;

/* ============================================================
 * Contract types — mirror del paquete @delivrix/domain.
 * ============================================================ */

type DomainAvailabilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "RESERVED"
  | "DONT_KNOW"
  | "PENDING";

interface DomainSuggestion {
  domain: string;
  availability: DomainAvailabilityStatus | null;
}

interface DomainPrice {
  tld: string;
  registration: number | null;
  renewal: number | null;
  currency: string | null;
}

interface AvailabilityResponse {
  domain: string;
  availability: DomainAvailabilityStatus;
  available: boolean;
  checkedAt: string;
}

interface SuggestionsResponse {
  seed: string;
  suggestions: DomainSuggestion[];
}

interface PricesResponse {
  prices: DomainPrice[];
}

/* ============================================================
 * Hooks
 * ============================================================ */

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function usePrices() {
  return useQuery({
    queryKey: ["v5", "domains", "prices", DEFAULT_TLDS.join(",")],
    queryFn: () =>
      getJsonWithQuery<PricesResponse>(READ_ENDPOINTS.domainPrices, {
        tlds: DEFAULT_TLDS.join(",")
      }),
    refetchInterval: POLL_PRICES_MS,
    staleTime: POLL_PRICES_MS / 2,
    retry: false
  });
}

function useOwnedCount() {
  return useQuery({
    queryKey: ["v5", "domains", "owned"],
    queryFn: () => getJson<{ domains: unknown[] }>(READ_ENDPOINTS.ownedDomains),
    refetchInterval: POLL_OWNED_MS,
    staleTime: POLL_OWNED_MS / 2,
    retry: false
  });
}

/**
 * Consumo REAL del cap mensual: suma `costUsd` de los eventos de registro de
 * dominio del mes en curso (mismo cálculo que el Wallet de Sender Pool). Si no
 * hay eventos de compra, el gasto es 0 real (Fase 1 no ejecuta compras).
 */
function useMonthlySpent() {
  const query = useQuery({
    queryKey: ["v5", "domains", "wallet"],
    queryFn: () =>
      getJsonWithQuery<AuditEventsPayload>(READ_ENDPOINTS.auditEvents, { limit: 50 }),
    refetchInterval: POLL_WALLET_MS,
    staleTime: POLL_WALLET_MS / 2,
    retry: 1
  });
  const spent = computeWalletTransactions(query.data?.events ?? []).reduce(
    (sum, t) => sum + t.amount,
    0
  );
  // `isLoading` = primera carga sin dato; `isError` = tras `retry:1` la query cayó.
  // En ambos casos el `spent=0` NO está confirmado y el consumidor debe tratarlo
  // como "sin dato" en vez de renderizarlo como gasto real $0 / cap saludable.
  return { spent, isLoading: query.isLoading, isError: query.isError };
}

function useAvailability(query: string) {
  const debounced = useDebounced(query.trim().toLowerCase(), 350);
  const valid = isPlausibleDomain(debounced);
  return useQuery({
    queryKey: ["v5", "domains", "availability", debounced],
    queryFn: () =>
      getJsonWithQuery<AvailabilityResponse>(READ_ENDPOINTS.domainAvailability, {
        name: debounced
      }),
    enabled: valid,
    staleTime: 30_000,
    retry: false
  });
}

function useSuggestions(seed: string) {
  const debounced = useDebounced(seed.trim().toLowerCase(), 500);
  const valid = debounced.length >= 3 && /^[a-z0-9-]+$/.test(debounced);
  return useQuery({
    queryKey: ["v5", "domains", "suggestions", debounced],
    queryFn: () =>
      getJsonWithQuery<SuggestionsResponse>(READ_ENDPOINTS.domainSuggestions, {
        seed: debounced,
        count: 10
      }),
    enabled: valid,
    staleTime: 60_000,
    retry: false
  });
}

/* ============================================================
 * CardHead — cabecera interna de card, calcada del demo (título 15/500 +
 * subtítulo tertiary + slot derecho). No es un primitivo Aivora (SectionHead es
 * el h1 de página), así que se define local para no duplicar estilos ad-hoc.
 * ============================================================ */

function CardHead({
  title,
  subtitle,
  right
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 12.5, color: "var(--color-text-tertiary)", marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </div>
      {right ? <div style={{ flex: "none" }}>{right}</div> : null}
    </div>
  );
}

/* ============================================================
 * <DomainsV5> — root
 * ============================================================ */

export function DomainsV5() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");

  const seed = useMemo(() => seedFromQuery(submitted), [submitted]);
  const availability = useAvailability(submitted);
  const suggestions = useSuggestions(seed);
  const prices = usePrices();
  const owned = useOwnedCount();
  const {
    spent: spentThisMonth,
    isLoading: walletLoading,
    isError: walletError
  } = useMonthlySpent();
  // El gasto solo es dato real cuando la query resolvió sin error. Mientras carga
  // o si el audit chain cayó, `spentThisMonth` (=0) NO está confirmado.
  const spentKnown = !walletLoading && !walletError;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = input.trim().toLowerCase();
    setSubmitted(trimmed);
  };

  const proposals = buildProposals({
    submitted,
    availability: availability.data,
    suggestions: suggestions.data?.suggestions ?? [],
    prices: prices.data?.prices ?? []
  });

  const ownedCount = Array.isArray(owned.data?.domains) ? owned.data!.domains.length : 0;
  const availableCount = proposals.filter((p) => p.availability === "AVAILABLE").length;
  const spentRemaining = spentKnown ? MONTHLY_CAP_USD - spentThisMonth : null;
  const capPct = spentKnown ? (spentThisMonth / MONTHLY_CAP_USD) * 100 : null;
  const proposalsError = availability.isError || suggestions.isError;
  // `prefers-reduced-motion`: al arrancar en el estado final (`initial={false}`) los
  // hijos heredan animate sin entrada escalonada → nada de fade/slide. (§8 doc, DoD F).
  const reduce = useReducedMotion();

  return (
    <motion.div
      variants={staggerContainer}
      initial={reduce ? false : "initial"}
      animate="animate"
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <motion.div variants={staggerItem}>
        <SectionHead
          eyebrow="DISCOVER & PROPOSE"
          title="Buscar, valorar y proponer dominios."
          subtitle="Discover/propose vía AWS Route53 Domains con precio real por TLD · sin compra real (Fase 2 tras doble aprobación humana)."
          right={
            <Card ink style={{ padding: "10px 14px", textAlign: "right" }}>
              <Eyebrow>Cap restante</Eyebrow>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {spentRemaining != null ? `$${spentRemaining.toFixed(0)} USD` : "—"}
              </div>
              <Caption style={walletError ? { color: "var(--color-critical)" } : undefined}>
                {walletError ? "audit chain sin datos" : walletLoading ? "cargando consumo…" : `de $${MONTHLY_CAP_USD} mensual`}
              </Caption>
            </Card>
          }
        />
      </motion.div>

      {/* KPI row — métricas REALES (sin delta ni sparkline: no hay serie real). */}
      <motion.section
        variants={staggerItem}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 20 }}
      >
        <KpiCard
          label="Cap consumido"
          value={spentKnown ? `$${spentThisMonth.toFixed(0)}` : "—"}
          suffix={` / $${MONTHLY_CAP_USD}`}
          icon={ShieldCheck}
        />
        <KpiCard label="Dominios en cartera" value={ownedCount} icon={Globe} />
        <KpiCard label="Propuestas" value={proposals.length} icon={Sparkles} />
        <KpiCard label="Disponibles ahora" value={availableCount} icon={CheckCircle2} />
      </motion.section>

      {/* Guardrails — CONFIG REAL, etiquetada como tal. */}
      <motion.section variants={staggerItem}>
        <GuardrailStrip capPct={capPct} walletError={walletError} />
      </motion.section>

      {/* Discover */}
      <motion.section variants={staggerItem}>
        <DiscoverForm
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          submitted={submitted}
          availability={availability}
          suggestionsFetching={suggestions.isFetching}
        />
      </motion.section>

      {/* Propuestas */}
      <motion.section variants={staggerItem} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <CardHead
          title="Resultados sugeridos"
          subtitle={
            proposals.length === 0
              ? "Submit una búsqueda para ver propuestas"
              : "Cada candidato muestra disponibilidad y precio real de Route53"
          }
          right={
            proposals.length > 0 ? (
              <Pill tone="neutral">{`${proposals.length} candidato${proposals.length === 1 ? "" : "s"}`}</Pill>
            ) : null
          }
        />
        <ProposalsList
          proposals={proposals}
          loading={availability.isFetching || suggestions.isFetching}
          error={proposalsError}
          onRetry={() => {
            void availability.refetch();
            void suggestions.refetch();
          }}
          submitted={submitted}
        />
      </motion.section>

      {availableCount > 0 ? (
        <motion.div variants={staggerItem}>
          <AdvisorOpenClaw count={availableCount} />
        </motion.div>
      ) : null}

      <motion.footer variants={staggerItem}>
        <FooterStrip />
      </motion.footer>
    </motion.div>
  );
}

/* ============================================================
 * GuardrailStrip — config real (topes / flags) mostrada con StateBadge.
 * ============================================================ */

function GuardrailStrip({ capPct, walletError }: { capPct: number | null; walletError: boolean }) {
  // El cap NO es un estado de warmup: no reusar el molde StateBadge para una caución
  // de PRESUPUESTO. `paused` traería ámbar + glifo Pause (§3/§9 ámbar = SOLO PAUSED;
  // §4/§8 el ícono es señal redundante de estado → "pausa" se lee mal si nada está
  // pausado) y `quarantined` prestaría ShieldAlert (glifo de cuarentena). Los umbrales
  // van como Pill semántico con ícono propio de budget (TrendingUp = trepando al tope,
  // TriangleAlert = tope cruzado). Los no-umbral (saludable/sin dato/cargando) sí son
  // estados legítimos y se quedan en StateBadge neutro/verde.
  const capBadge: ReactNode = walletError ? (
    <StateBadge status="retired" label="Sin datos" /> // neutral: unknown ≠ warning
  ) : capPct == null ? (
    <StateBadge status="READY" label="Cargando…" />
  ) : capPct >= 95 ? (
    <Pill tone="critical">
      <TriangleAlert size={12.5} strokeWidth={2} />
      Excedido
    </Pill>
  ) : capPct >= 80 ? (
    <Pill tone="critical">
      <TrendingUp size={12.5} strokeWidth={2} />
      Vigilar
    </Pill>
  ) : (
    <StateBadge status="active" label="Saludable" />
  );

  return (
    <Card ink style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <CardHead
        title="Guardrails"
        subtitle="Configuración real de la Fase 1 · no editable desde el panel"
        right={<Eyebrow>config</Eyebrow>}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: 12,
          borderTop: "1px solid var(--color-border)",
          paddingTop: 16
        }}
      >
        <GuardrailItem
          label="Cap mensual"
          value={`$${MONTHLY_CAP_USD} USD`}
          badge={capBadge}
        />
        <GuardrailItem
          label="WHOIS privacy"
          value={WHOIS_PRIVACY_ENABLED ? "Activada" : "Desactivada"}
          badge={<StateBadge status={WHOIS_PRIVACY_ENABLED ? "active" : "quarantined"} label="Forzado" />}
        />
        <GuardrailItem
          label="Aprobación"
          value="1 firma operador"
          badge={<StateBadge status="active" label="Exigido" />}
        />
        <GuardrailItem
          label="Compra real"
          value={PURCHASE_ENABLED ? "Habilitada" : "Bloqueada"}
          badge={
            <StateBadge
              status={PURCHASE_ENABLED ? "paused" : "BLOCKED"}
              label={PURCHASE_ENABLED ? "Demo on" : "Bloqueada"}
            />
          }
        />
      </div>
    </Card>
  );
}

function GuardrailItem({
  label,
  value,
  badge
}: {
  label: string;
  value: string;
  badge: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div>{badge}</div>
    </div>
  );
}

/* ============================================================
 * DiscoverForm — input principal + CTA "Sugerir con OpenClaw".
 * ============================================================ */

function DiscoverForm({
  input,
  onInputChange,
  onSubmit,
  submitted,
  availability,
  suggestionsFetching
}: {
  input: string;
  onInputChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  submitted: string;
  availability: ReturnType<typeof useAvailability>;
  suggestionsFetching: boolean;
}) {
  const trimmed = input.trim().toLowerCase();
  const plausible = isPlausibleDomain(trimmed) || trimmed.length >= 3;
  const fetching = availability.isFetching || suggestionsFetching;

  return (
    <Card style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <CardHead
        title="Sugerir con OpenClaw"
        subtitle="Escribe un dominio completo o una keyword · cada consulta queda firmada en audit chain"
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <label
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            gap: 12,
            borderRadius: 12,
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface)",
            padding: "0 14px"
          }}
        >
          <Search size={16} strokeWidth={1.75} style={{ flex: "none", color: "var(--color-text-tertiary)" }} aria-hidden="true" />
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="delivrix-mail.com  ·  o una keyword: delivrix"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              height: 48,
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: "var(--color-text-primary)"
            }}
            aria-label="Dominio o keyword a explorar"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!plausible || fetching}
          className="w-full sm:w-auto sm:min-w-[220px]"
        >
          <Sparkles size={13} strokeWidth={1.75} />
          Sugerir con OpenClaw
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      </form>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          borderTop: "1px solid var(--color-border)",
          paddingTop: 12
        }}
      >
        <Caption>
          {submitted ? (
            <>
              Última búsqueda: <MonoCode>{submitted}</MonoCode>
            </>
          ) : (
            "Sin búsquedas en esta sesión."
          )}
        </Caption>
        <span style={{ flex: 1 }} aria-hidden="true" />
        <MetaTag>cache 5 min</MetaTag>
        <MetaTag>read-only</MetaTag>
      </div>
    </Card>
  );
}

function MetaTag({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        background: "var(--color-neutral-soft)",
        color: "var(--color-text-secondary)",
        fontSize: 11.5,
        padding: "3px 9px"
      }}
    >
      {children}
    </span>
  );
}

/* ============================================================
 * ProposalsList — cards de candidatos.
 * ============================================================ */

interface ProposalRow {
  domain: string;
  tld: string;
  availability: DomainAvailabilityStatus | null;
  route53Price: DomainPrice | undefined;
  source: "submitted" | "suggestion";
}

function ProposalsList({
  proposals,
  loading,
  error,
  onRetry,
  submitted
}: {
  proposals: ProposalRow[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  submitted: string;
}) {
  if (proposals.length === 0) {
    if (loading) {
      return (
        <Card style={{ padding: 24, display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-text-tertiary)" }}
            className="animate-pulse"
          />
          <Caption>Consultando Route53 …</Caption>
        </Card>
      );
    }
    // Error de red/endpoint tras un submit: NO es un empty-state. Se muestra
    // explícito (icono crítico + reintentar) para no leer un 500 como "no hay
    // resultados".
    if (error && submitted) {
      return (
        <Card style={{ padding: 24, display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div
            style={{
              width: 38,
              height: 38,
              flex: "none",
              display: "grid",
              placeItems: "center",
              borderRadius: 12,
              background: "var(--color-critical-soft)",
              color: "var(--color-critical)"
            }}
          >
            <TriangleAlert size={16} strokeWidth={1.75} />
          </div>
          <div style={{ display: "flex", minWidth: 0, flex: 1, flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
              No se pudo consultar Route53
            </div>
            <BodySm>
              La búsqueda de disponibilidad o sugerencias para <MonoCode>{submitted}</MonoCode> falló
              (error de red o del endpoint). Esto no significa que no haya candidatos.
            </BodySm>
            <div style={{ marginTop: 4 }}>
              <Button variant="ghost" size="sm" onClick={onRetry}>
                <RotateCw size={12} strokeWidth={1.75} />
                Reintentar
              </Button>
            </div>
          </div>
        </Card>
      );
    }
    return (
      <Card style={{ padding: 24, display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div
          style={{
            width: 38,
            height: 38,
            flex: "none",
            display: "grid",
            placeItems: "center",
            borderRadius: 12,
            background: "var(--color-neutral-soft)",
            color: "var(--color-text-tertiary)"
          }}
        >
          <Search size={16} strokeWidth={1.75} />
        </div>
        <div style={{ display: "flex", minWidth: 0, flex: 1, flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
            {submitted ? "Sin candidatos para esta búsqueda" : "Empieza con una búsqueda"}
          </div>
          <BodySm>
            {submitted ? (
              <>
                OpenClaw no encontró sugerencias para <MonoCode>{submitted}</MonoCode>. Prueba un seed
                más específico de 3 o más caracteres alfanuméricos.
              </>
            ) : (
              "Escribe un dominio completo o una keyword. OpenClaw propondrá hasta 10 alternativas comparando precio y disponibilidad."
            )}
          </BodySm>
        </div>
      </Card>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
        gap: 12
      }}
    >
      {proposals.map((p) => (
        <ProposalCard key={p.domain} proposal={p} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalRow }) {
  const { sendIntent } = useOpenClawIntent();
  const badge = availabilityBadge(proposal.availability);

  const registrationLabel = formatUsd(proposal.route53Price?.registration);
  const renewalLabel = formatUsd(proposal.route53Price?.renewal);
  const currency = proposal.route53Price?.currency ?? "USD";
  const available = proposal.availability === "AVAILABLE";

  const requestApproval = () =>
    sendIntent(
      `Prepará la propuesta de registro de ${proposal.domain} en Route53 (WHOIS privacy activada, cap mensual $${MONTHLY_CAP_USD}). No ejecutes la compra: dejala firmada en el ApprovalGate para revisión humana.`,
      `domains:request-approval:${proposal.domain}`
    );

  return (
    <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <MonoData style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={proposal.domain}>
            {proposal.domain}
          </MonoData>
          <Caption>{proposal.source === "submitted" ? "Búsqueda directa" : "Sugerido por OpenClaw"}</Caption>
        </div>
        <StateBadge status={badge.status} label={badge.label} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          borderTop: "1px solid var(--color-border)",
          paddingTop: 14
        }}
      >
        <PriceColumn
          label="Registro Route53"
          value={registrationLabel}
          hint={proposal.route53Price ? currency : "sin precio publicado"}
        />
        <PriceColumn
          label="Renovación Route53"
          value={renewalLabel}
          hint={proposal.route53Price?.renewal != null ? `${currency}/año` : "sin precio publicado"}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          variant={available ? "primary" : "ghost"}
          size="sm"
          disabled={!available}
          onClick={available ? requestApproval : undefined}
          aria-label={`Solicitar aprobación para ${proposal.domain}`}
        >
          <Lock size={11} strokeWidth={1.75} />
          Solicitar aprobación
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
        <span style={{ flex: 1 }} aria-hidden="true" />
        <Caption>No ejecuta compra · gate Fase 2</Caption>
      </div>
    </Card>
  );
}

function PriceColumn({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {hint ? <Caption>{hint}</Caption> : null}
    </div>
  );
}

/* ============================================================
 * AdvisorOpenClaw — única superficie con gradiente/sparkle (patrón demo).
 * Contiene la única HumanNote de la vista.
 * ============================================================ */

function AdvisorOpenClaw({ count }: { count: number }) {
  const { sendIntent, navigateTo } = useOpenClawIntent();
  return (
    <AdvisorCard>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: aivoraGradient, display: "grid", placeItems: "center" }}>
            <Sparkles size={16} color="#fff" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--color-text-primary)" }}>Advisor · OpenClaw</div>
          <span style={{ marginLeft: "auto" }}>
            <StateBadge status="retired_pending_approval" label="1 firma operador" />
          </span>
        </div>

        <div style={{ borderLeft: "2px solid transparent", borderImage: `${aivoraGradient} 1`, paddingLeft: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>
            {count === 1
              ? "1 propuesta espera aprobación humana"
              : `${count} propuestas esperan aprobación humana`}
          </div>
          <Body>
            La compra real queda detrás de ApprovalGate con una firma humana. Cuando firmes la
            propuesta, OpenClaw ejecuta sólo dentro del flujo auditado visible en Canvas Live.
          </Body>
          <HumanNote style={{ maxWidth: 560 }}>
            Si quieres revisamos cada candidata antes de firmar — abro el chat y te lo explico.
          </HumanNote>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, rowGap: 8 }}>
          <Button variant="primary" size="sm" onClick={() => navigateTo("canvas")}>
            <Rocket size={13} strokeWidth={1.75} />
            Revisar en Canvas Live
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              sendIntent(
                `Repasá conmigo las ${count} propuesta(s) de dominio disponibles antes de firmar ninguna.`,
                "domains:banner-open-chat"
              )
            }
          >
            Abrir chat
          </Button>
        </div>
      </div>
    </AdvisorCard>
  );
}

/* ============================================================
 * FooterStrip — chrome de ops (runbook + endpoint). Va en `ink` (inlay negro en
 * modo claro): junto al AdvisorCard cierra el borde INFERIOR del marco cohesivo
 * (banda KPI arriba + sidebar a la izq + este baseboard abajo = marco en U), y
 * como consola/ops es una superficie conceptualmente siempre-oscura (SPEC §1.3).
 * El cap ya vive en el hero (restante) y en el KPI (consumido): no se repite acá.
 * ============================================================ */

function FooterStrip() {
  return (
    <Card ink style={{ padding: "14px 20px", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 20, rowGap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Eyebrow>Runbook</Eyebrow>
        <a
          href="#"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", minWidth: 0, wordBreak: "break-all" }}
        >
          {RUNBOOK_PATH}
          <ExternalLink size={10} strokeWidth={1.75} />
        </a>
      </div>
      <span aria-hidden="true" style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--color-border-strong)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Eyebrow>Endpoint</Eyebrow>
        <MonoCode>GET {READ_ENDPOINTS.domainAvailability}</MonoCode>
      </div>
    </Card>
  );
}

/* ============================================================
 * Builders + utils
 * ============================================================ */

function buildProposals(args: {
  submitted: string;
  availability: AvailabilityResponse | undefined;
  suggestions: DomainSuggestion[];
  prices: DomainPrice[];
}): ProposalRow[] {
  const { submitted, availability, suggestions, prices } = args;
  const priceByTld = new Map(prices.map((p) => [p.tld.toLowerCase(), p]));
  const rows: ProposalRow[] = [];
  const seen = new Set<string>();

  if (availability && submitted) {
    const tld = tldOf(availability.domain) ?? "";
    rows.push({
      domain: availability.domain,
      tld,
      availability: availability.availability,
      route53Price: priceByTld.get(tld),
      source: "submitted"
    });
    seen.add(availability.domain);
  }

  for (const s of suggestions) {
    if (seen.has(s.domain)) continue;
    seen.add(s.domain);
    const tld = tldOf(s.domain) ?? "";
    rows.push({
      domain: s.domain,
      tld,
      availability: s.availability,
      route53Price: priceByTld.get(tld),
      source: "suggestion"
    });
  }

  return rows;
}

/** Availability → visual del StateBadge (reusa el molde; label semántico real). */
function availabilityBadge(status: DomainAvailabilityStatus | null): { status: string; label: string } {
  if (status === "AVAILABLE") return { status: "active", label: "Disponible" };
  if (status === "UNAVAILABLE") return { status: "retired", label: "Registrado" };
  // RESERVED/PENDING = espera, no caución → neutral (Clock), NO ámbar (ámbar solo PAUSED).
  if (status === "RESERVED") return { status: "retired_pending_approval", label: "Reservado" };
  if (status === "PENDING") return { status: "retired_pending_approval", label: "Pendiente" };
  return { status: "READY", label: "Sin confirmar" };
}

function tldOf(domain: string): string | null {
  if (!domain.includes(".")) return null;
  const tld = domain.split(".").filter(Boolean).at(-1);
  return tld ? tld.toLowerCase() : null;
}

function seedFromQuery(query: string): string {
  if (!query) return "";
  const prefix = query.split(".")[0]?.trim() ?? "";
  return prefix.length >= 3 ? prefix : "";
}

function isPlausibleDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,}$/.test(value);
}

function formatUsd(amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}
