/**
 * v5 Domains — Fase 1 discover/propose (Hito 5.12).
 *
 * Restyle al MOLDE oficial "Aivora" (src/shared/ui/aivora): mismos primitivos
 * que el demo aprobado (features/overview/TravigueOverviewProto) — Card radius
 * 18 + hairline, KpiCard tile+número tabular, StateBadge dot+icono, SectionHead
 * eyebrow+h1 light, AdvisorCard para OpenClaw. Colores 100% desde tokens
 * (var(--color-*)); cero hex hardcodeado.
 *
 * Disciplina de DATOS (reescrita el 2026-08-06: los "guardrails de config real" NO eran reales):
 *   - El cap mensual NO se muestra: era un literal de $50 en este archivo mientras el backend
 *     enforcea 700 (Route53) y 100 (Namecheap), y era el denominador del "Cap restante", del KPI
 *     "Cap consumido" y del semáforo Saludable/Vigilar/Excedido. Un gasto legítimo de $60 pintaba
 *     "Cap restante: $-10 · Excedido" con el guardrail real intacto. Ningún endpoint de lectura
 *     publica esos caps, así que la pantalla dice que no están publicados.
 *   - El estado de la compra real sale de GET /health → runtimeFlags, uno por registrador. Estaba
 *     hardcodeado en `false` ("Bloqueada") mientras producción tenía los DOS flags en true: un
 *     guardrail de gasto irreversible mostrado al revés.
 *   - El gasto del mes NO se afirma: se calculaba sobre las últimas 50 FILAS de la cadena.
 *   - Precio real de Route53 por TLD, consultando los TLD que efectivamente aparecen en las
 *     propuestas (antes la lista era fija en com/net/io/co y la card decía "sin precio publicado"
 *     de un .org que Route53 SÍ cotiza — una afirmación sobre el proveedor derivada de una
 *     consulta que nunca hicimos).
 *   - Un fallo de AWS se muestra como fallo: el gateway atrapa el error y responde 200 con lista
 *     vacía marcando `source.responseOk=false`, así que sin leer ese campo una caída de AWS se
 *     leía como "probá un seed más específico".
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
  Globe,
  Lock,
  Rocket,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
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

/**
 * TLDs que se consultan cuando todavía no hay propuestas.
 *
 * Antes era LA lista, fija, y las sugerencias de Route53 devuelven .org/.info/.me/.biz (6 de 10
 * para el seed "delivrix"): el precio salía undefined y la card afirmaba "sin precio publicado"
 * sobre TLDs que Route53 sí cotiza (org 16, info 30, me 31, biz 26 USD). Ahora es solo el
 * arranque: `tldsAConsultar` agrega los que de verdad aparecen.
 */
const DEFAULT_TLDS = ["com", "net", "io", "co"];
/** Filas de la cadena que se leen. Ver `useMovimientosEnVentana`: es una ventana, no un mes. */
const AUDIT_WINDOW_ROWS = 50;
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

/**
 * La procedencia que las CUATRO rutas de dominios devuelven y que la vista no declaraba.
 *
 * El gateway atrapa los errores de AWS y responde 200 con lista vacía marcando
 * `responseOk: false` (domains.ts:82-93 y :128-137). Sin leer esto, `isError` nunca se prendía y
 * lo que veía el operador ante una caída de AWS era "OpenClaw no encontró sugerencias para X.
 * Probá un seed más específico": la pantalla le echaba la culpa a su búsqueda.
 */
interface DiscoverySource {
  provider: string;
  kind: "live" | "mock";
  region: string;
  responseOk: boolean;
  errorReason?: string;
}

interface AvailabilityResponse {
  domain: string;
  availability: DomainAvailabilityStatus;
  available: boolean;
  checkedAt: string;
  source?: DiscoverySource;
}

interface SuggestionsResponse {
  seed: string;
  suggestions: DomainSuggestion[];
  source?: DiscoverySource;
}

interface PricesResponse {
  prices: DomainPrice[];
  source?: DiscoverySource;
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

function usePrices(tlds: string[]) {
  const lista = tlds.join(",");
  return useQuery({
    queryKey: ["v5", "domains", "prices", lista],
    queryFn: () =>
      getJsonWithQuery<PricesResponse>(READ_ENDPOINTS.domainPrices, {
        tlds: lista
      }),
    refetchInterval: POLL_PRICES_MS,
    staleTime: POLL_PRICES_MS / 2,
    retry: false
  });
}

function useOwnedCount() {
  return useQuery({
    queryKey: ["v5", "domains", "owned"],
    queryFn: () => getJson<{ domains: unknown[]; source?: DiscoverySource }>(READ_ENDPOINTS.ownedDomains),
    refetchInterval: POLL_OWNED_MS,
    staleTime: POLL_OWNED_MS / 2,
    retry: false
  });
}

/**
 * Si la compra real está habilitada, según el GATEWAY.
 *
 * `const PURCHASE_ENABLED = false` pintaba "Compra real: Bloqueada" con badge BLOCKED mientras la
 * Studio tenía AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true y NAMECHEAP_ENABLE_PURCHASE=true, y
 * /health ya los publicaba. Es el guardrail de un gasto irreversible mostrado al revés, y el dato
 * verdadero estaba a una propiedad de distancia.
 *
 * Un flag que no venga NO es "bloqueada": es "no publicado por el gateway".
 */
function useComprasHabilitadas() {
  const query = useQuery({
    queryKey: ["v5", "domains", "health-flags"],
    queryFn: () => getJson<{ runtimeFlags?: Record<string, string | undefined> }>(READ_ENDPOINTS.health),
    refetchInterval: POLL_OWNED_MS,
    staleTime: POLL_OWNED_MS / 2,
    retry: false
  });
  const flag = (nombre: string): boolean | null => {
    if (!query.data) return null;
    const raw = query.data.runtimeFlags?.[nombre];
    if (raw === undefined) return null;
    return raw === "true";
  };
  return {
    route53: flag("AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE"),
    namecheap: flag("NAMECHEAP_ENABLE_PURCHASE")
  };
}

/**
 * Movimientos de compra que aparecen en la ventana leída de la cadena de auditoría.
 *
 * NO es el gasto del mes y ya no se presenta como tal: el panel pide las últimas
 * AUDIT_WINDOW_ROWS FILAS y recién después filtra por mes. Medido: un alta de dominio escribe ~5
 * eventos, así que una sesión de ~10 altas empuja sus propias primeras compras fuera de la ventana
 * mientras la plata ya se gastó — y el KPI lo mostraba como gasto CONFIRMADO.
 */
function useMovimientosEnVentana() {
  const query = useQuery({
    queryKey: ["v5", "domains", "wallet"],
    queryFn: () =>
      getJsonWithQuery<AuditEventsPayload>(READ_ENDPOINTS.auditEvents, { limit: AUDIT_WINDOW_ROWS }),
    refetchInterval: POLL_WALLET_MS,
    staleTime: POLL_WALLET_MS / 2,
    retry: 1
  });
  const movimientos = computeWalletTransactions(query.data?.events ?? []);
  return { movimientos, isLoading: query.isLoading, isError: query.isError };
}

/** Las propuestas que de verdad esperan una firma. Devuelve [] en producción hoy. */
function usePropuestasPendientes() {
  return useQuery({
    queryKey: ["v5", "domains", "proposals"],
    queryFn: () => getJson<unknown[]>(READ_ENDPOINTS.openClawProposals),
    refetchInterval: POLL_OWNED_MS,
    staleTime: POLL_OWNED_MS / 2,
    retry: false
  });
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
  // Los TLD a cotizar salen de lo que las sugerencias devuelven, no de una lista fija.
  const tldsAConsultar = useMemo(() => {
    const vistos = new Set(DEFAULT_TLDS);
    for (const s of suggestions.data?.suggestions ?? []) {
      const t = tldOf(s.domain);
      if (t) vistos.add(t);
    }
    const propio = tldOf(submitted);
    if (propio) vistos.add(propio);
    return [...vistos];
  }, [suggestions.data?.suggestions, submitted]);
  const prices = usePrices(tldsAConsultar);
  const owned = useOwnedCount();
  const compras = useComprasHabilitadas();
  const propuestas = usePropuestasPendientes();
  const pendientesDeFirma = Array.isArray(propuestas.data) ? propuestas.data.length : 0;
  const { movimientos, isLoading: walletLoading, isError: walletError } = useMovimientosEnVentana();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = input.trim().toLowerCase();
    setSubmitted(trimmed);
  };

  const proposals = buildProposals({
    submitted,
    availability: availability.data,
    suggestions: suggestions.data?.suggestions ?? [],
    prices: prices.data?.prices ?? [],
    tldsConsultados: tldsAConsultar
  });

  // "Dominios en cartera" imprimía un 0 duro mientras cargaba y de forma PERMANENTE si la query
  // fallaba — y como el gateway se traga los errores de AWS y responde 200 con `domains: []`, en
  // el modo de falla más probable `isError` ni se prendía. Ahora: `null` = no medido ⇒ "—".
  const ownedOk = owned.data?.source ? owned.data.source.responseOk : !owned.isError;
  const ownedCount =
    owned.data && ownedOk && Array.isArray(owned.data.domains) ? owned.data.domains.length : null;
  const availableCount = proposals.filter((p) => p.availability === "AVAILABLE").length;
  const movimientosEnVentana = movimientos.reduce((sum, t) => sum + (t.amount ?? 0), 0);
  // Un 200 con lista vacía y responseOk=false es un FALLO, no un resultado vacío.
  const proposalsError =
    availability.isError ||
    suggestions.isError ||
    availability.data?.source?.responseOk === false ||
    suggestions.data?.source?.responseOk === false;
  const proposalsErrorReason =
    availability.data?.source?.errorReason ??
    suggestions.data?.source?.errorReason ??
    (availability.error instanceof Error ? availability.error.message : null) ??
    (suggestions.error instanceof Error ? suggestions.error.message : null);
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
          subtitle="Búsqueda de dominios contra AWS Route53 Domains, con precio real por TLD. El alta la ejecuta el gateway detrás de una firma del operador."
          right={
            <Card ink style={{ padding: "10px 14px", textAlign: "right" }}>
              <Eyebrow>Movimientos leídos</Eyebrow>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {walletError ? "—" : walletLoading ? "…" : `$${movimientosEnVentana.toFixed(0)} USD`}
              </div>
              <Caption style={walletError ? { color: "var(--color-critical)" } : undefined}>
                {walletError
                  ? "audit chain sin datos"
                  : `en las últimas ${AUDIT_WINDOW_ROWS} filas de la cadena · no es el mes`}
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
        {/* Sin denominador no hay porcentaje: el cap real vive en env, por registrador, y ningún
            endpoint de lectura lo publica. Antes esta card decía "$0 / $50" con el $50 inventado. */}
        <KpiCard label="Gasto del mes" value="no medido" icon={ShieldCheck} />
        {/* "Registrados en Route53", no "en cartera": el endpoint devuelve 60 y el inventario de
            producción tiene 68 (64 route53 + 4 namecheap). Los de Namecheap son estructuralmente
            invisibles acá, así que el rótulo tiene que decir qué registrador está contando. */}
        <KpiCard label="Registrados en Route53" value={ownedCount ?? "—"} icon={Globe} />
        <KpiCard label="Propuestas" value={proposals.length} icon={Sparkles} />
        <KpiCard label="Disponibles ahora" value={availableCount} icon={CheckCircle2} />
      </motion.section>

      {/* Guardrails — lo que el gateway declara, no lo que este archivo suponía. */}
      <motion.section variants={staggerItem}>
        <GuardrailStrip compras={compras} />
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
          errorReason={proposalsErrorReason}
          onRetry={() => {
            void availability.refetch();
            void suggestions.refetch();
          }}
          submitted={submitted}
        />
      </motion.section>

      {/* El banner decía "N propuestas esperan aprobación humana" donde N eran los resultados
          AVAILABLE de la búsqueda: escribir "delivrix" hacía que la pantalla afirmara que 10
          propuestas esperaban la firma del operador con el ApprovalGate VACÍO
          (/v1/openclaw/proposals devuelve [] en producción). Ahora cuenta propuestas de verdad,
          y si no hay ninguna el banner no se renderiza. */}
      {pendientesDeFirma > 0 ? (
        <motion.div variants={staggerItem}>
          <AdvisorOpenClaw count={pendientesDeFirma} />
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

function GuardrailStrip({ compras }: { compras: { route53: boolean | null; namecheap: boolean | null } }) {
  // El cap mensual YA NO figura: era un literal de $50 rotulado "config real" mientras el backend
  // enforcea 700 (Route53, domains-purchase.ts:423) y 100 (Namecheap,
  // domains-namecheap-purchase.ts:193), y ningún endpoint de lectura publica esos valores.
  // Mostrar un denominador inventado como si fuera configuración es peor que no mostrarlo.
  const badgeCompra = (flag: boolean | null) =>
    flag === null ? (
      <StateBadge status="retired" label="No publicado" />
    ) : flag ? (
      // Compra real ENCENDIDA = gasto irreversible posible. Se pinta como lo que es.
      <Pill tone="critical">
        <TriangleAlert size={12.5} strokeWidth={2} />
        Habilitada
      </Pill>
    ) : (
      <StateBadge status="BLOCKED" label="Bloqueada" />
    );
  const valorCompra = (flag: boolean | null) =>
    flag === null ? "no publicado por el gateway" : flag ? "Habilitada" : "Bloqueada";

  return (
    <Card ink style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <CardHead
        title="Guardrails"
        subtitle="Lo que el gateway declara en /health · no editable desde el panel"
        right={<Eyebrow>gateway</Eyebrow>}
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
          value="no publicado"
          badge={<StateBadge status="retired" label="Sin dato" />}
        />
        <GuardrailItem
          label="WHOIS privacy"
          value="Activada"
          // "Forzado" era falso: el backend usa `?? true` (skill-schemas.ts:421,
          // domains-namecheap-purchase.ts:97, y el adapter con `opts.privacyProtection ?? true`).
          // Un caller puede mandar false y la compra sale sin privacy.
          badge={<StateBadge status="active" label="Default, no forzado" />}
        />
        <GuardrailItem
          label="Compra real · Route53"
          value={valorCompra(compras.route53)}
          badge={badgeCompra(compras.route53)}
        />
        <GuardrailItem
          label="Compra real · Namecheap"
          value={valorCompra(compras.namecheap)}
          badge={badgeCompra(compras.namecheap)}
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
      {/* "cada consulta queda firmada en audit chain" era falso: el gateway solo escribe el evento
          si el request trae el header x-openclaw-skill-invocation, y el cliente del panel manda
          únicamente `accept`. Medido: 0 eventos oc.domains.discover sobre 2121 de la cadena. */}
      <CardHead
        title="Sugerir con OpenClaw"
        subtitle="Escribe un dominio completo o una keyword · esta búsqueda es solo lectura y no queda firmada"
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
        {/* Se fue "cache 5 min": el TTL del adapter envuelve SOLO listInventory (los dominios
            propios). checkAvailability, getSuggestions y listPrices pegan a AWS en cada llamada,
            y el chip estaba justo al lado de las dos cosas que no describe. */}
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
  /** ¿Le preguntamos el precio de este TLD a Route53? Sin esto, "no consultado" y "el proveedor
   *  no publica precio" se veían idénticos — y el segundo es una afirmación sobre el proveedor. */
  precioConsultado: boolean;
  source: "submitted" | "suggestion";
}

function ProposalsList({
  proposals,
  loading,
  error,
  errorReason,
  onRetry,
  submitted
}: {
  proposals: ProposalRow[];
  loading: boolean;
  error: boolean;
  /** El motivo que el gateway devuelve en `source.errorReason` cuando AWS falla con un 200. */
  errorReason: string | null;
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
              La búsqueda de disponibilidad o sugerencias para <MonoCode>{submitted}</MonoCode> falló.
              Esto no significa que no haya candidatos, y no es culpa del seed.
              {errorReason ? (
                <>
                  {" "}
                  Motivo del proveedor: <MonoCode>{errorReason}</MonoCode>
                </>
              ) : null}
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
      `Prepará la propuesta de registro de ${proposal.domain} en Route53 (WHOIS privacy activada). No ejecutes la compra: dejala firmada en el ApprovalGate para revisión humana, y decime el cap mensual vigente del registrador antes de que firme.`,
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
        {/* "sin precio publicado" era una afirmación sobre Route53 derivada de una consulta que
            nunca hicimos: la lista de TLD estaba fija en com/net/io/co y las sugerencias devuelven
            .org/.info/.me/.biz, que Route53 SÍ cotiza (16/30/31/26 USD medidos). */}
        <PriceColumn
          label="Registro Route53"
          value={registrationLabel}
          hint={
            proposal.route53Price
              ? currency
              : proposal.precioConsultado
                ? "Route53 no publica precio para este TLD"
                : "no consultado"
          }
        />
        <PriceColumn
          label="Renovación Route53"
          value={renewalLabel}
          hint={
            proposal.route53Price?.renewal != null
              ? `${currency}/año`
              : proposal.precioConsultado
                ? "Route53 no publica renovación para este TLD"
                : "no consultado"
          }
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
              ? "1 propuesta espera la firma del operador"
              : `${count} propuestas esperan la firma del operador`}
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
  // Se fue el "Runbook · DOCUMENTACION/runbooks-demo-viernes/flip-purchase-flag.sh": el link era
  // un <a href="#"> que no iba a ningún lado, y el script que nombraba edita un `.env.local` que
  // no existe en el host de producción (el gateway carga config/gateway.env). Su propio comentario
  // decía que el cap es $50, contradiciendo el 700 real. Un operador que siguiera ese footer para
  // apagar la compra real no apagaba nada. El estado de los flags ya se lee arriba, de /health.
  return (
    <Card ink style={{ padding: "14px 20px", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 20, rowGap: 8 }}>
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
  tldsConsultados: string[];
}): ProposalRow[] {
  const { submitted, availability, suggestions, prices, tldsConsultados } = args;
  const priceByTld = new Map(prices.map((p) => [p.tld.toLowerCase(), p]));
  const consultados = new Set(tldsConsultados.map((t) => t.toLowerCase()));
  const rows: ProposalRow[] = [];
  const seen = new Set<string>();

  if (availability && submitted) {
    const tld = tldOf(availability.domain) ?? "";
    rows.push({
      domain: availability.domain,
      tld,
      availability: availability.availability,
      route53Price: priceByTld.get(tld),
      precioConsultado: consultados.has(tld),
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
      precioConsultado: consultados.has(tld),
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
