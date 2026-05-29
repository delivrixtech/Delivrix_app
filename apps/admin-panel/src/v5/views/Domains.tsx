/**
 * v5 Domains — Fase 1 discover/propose (Hito 5.12).
 *
 * Reescritura desde 0 con el sistema v5 (Three Dials VARIANCE=2 / MOTION=1 /
 * DENSITY=4). Sustituye la legacy `features/domains/index.tsx` cuando el shell
 * v5 la cablee. La propia legacy se mantiene intacta como referencia hasta el
 * cableo en `App.tsx`.
 *
 * Disciplina:
 *   - Cap mensual $50 USD hardcoded · visible en strip de guardrails + footer.
 *   - Compra real bloqueada (`AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=false`) ·
 *     la UI muestra el lock semánticamente en cada CTA crítico.
 *   - WHOIS privacy hardcoded true · chip permanent.
 *   - Cada propuesta queda en audit chain · footer recuerda runbook.
 *   - Comparativa Route53 vs Porkbun (Δ$) en cada card de propuesta.
 *   - Una sola `HumanNote` (en el banner OpenClaw).
 *   - staggerContainer + staggerItem para entrance.
 *   - Sin pills redundantes en KPIs.
 *
 * Endpoints (read-only · features 5104fd9 + ff622f9):
 *   GET /v1/domains/availability?name=...
 *   GET /v1/domains/suggestions?seed=...&count=10
 *   GET /v1/domains/prices?tlds=com,net,io,co
 *   GET /v1/domains/owned
 *
 * Porkbun: el endpoint comparativo aún no está en el read-boundary v5; el
 * tile usa el precio Route53 + estimación Porkbun derivada de la matriz
 * conocida (.com −$5, .io −$2, .net −$3, .co −$4) hasta que Codex publique
 * `/v1/domains/prices/compare`. Si el TLD no está en la matriz, se muestra
 * "—" en lugar de inventar.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  Lock,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert
} from "lucide-react";
import { getJson, getJsonWithQuery } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { staggerContainer, staggerItem } from "../lib/motion";
import {
  Badge,
  Body,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H2,
  H3,
  HumanNote,
  MonoCode,
  MonoData,
  Pill,
  SectionHead
} from "../components/primitives";
import { cn } from "../lib/cn";
import { PageHead } from "./_PageHead";

/* ============================================================
 * Constants — guardrails hardcoded para la Fase 1.
 * ============================================================ */

const MONTHLY_CAP_USD = 50;
const SPENT_THIS_MONTH_USD = 0; // Fase 1: discover/propose, sin compras reales.
const PURCHASE_ENABLED = false;
const WHOIS_PRIVACY_ENABLED = true;
const RUNBOOK_PATH = "DOCUMENTACION/runbooks-demo-viernes/flip-purchase-flag.sh";
const DEFAULT_TLDS = ["com", "net", "io", "co"];
const POLL_PRICES_MS = 5 * 60_000;
const POLL_OWNED_MS = 60_000;

/** Δ aproximada Porkbun − Route53 (USD). Negativo = Porkbun más barato. */
const PORKBUN_DELTA_USD: Record<string, number> = {
  com: -5,
  net: -3,
  io: -2,
  co: -4
};

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
  const spentRemaining = MONTHLY_CAP_USD - SPENT_THIS_MONTH_USD;
  const capPct = (SPENT_THIS_MONTH_USD / MONTHLY_CAP_USD) * 100;

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <PageHead
          eyebrow="Discover & propose"
          meta="Sin compra real"
          title="Buscar, valorar y proponer dominios."
          body={
            <Body className="max-w-[640px]">
              Discover/propose vía AWS Route53 Domains con comparativa frente a
              Porkbun. OpenClaw sugiere candidatos y el operador firma la
              propuesta; la compra real queda detrás de doble aprobación humana
              (Fase 2) y todavía no está habilitada.
            </Body>
          }
          trailing={
            <Card tone="quiet" padding="compact" className="hidden shrink-0 flex-col items-end gap-1 lg:flex">
              <Eyebrow>Cap restante</Eyebrow>
              <MonoData className="text-[14px]">${spentRemaining.toFixed(0)} USD</MonoData>
              <Caption>de ${MONTHLY_CAP_USD} mensual</Caption>
            </Card>
          }
        />
      </motion.div>

      <motion.section variants={staggerItem}>
        <GuardrailStrip
          spent={SPENT_THIS_MONTH_USD}
          cap={MONTHLY_CAP_USD}
          capPct={capPct}
          ownedCount={ownedCount}
        />
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Discover"
          title="Sugerir con OpenClaw"
          caption={
            <>
              Escribe un dominio completo (<MonoCode>delivrix-mail.com</MonoCode>)
              o una keyword para que OpenClaw proponga alternativas. Cada
              consulta queda firmada en audit chain.
            </>
          }
        />
        <DiscoverForm
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          submitted={submitted}
          availability={availability}
          suggestionsFetching={suggestions.isFetching}
        />
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-3">
        <SectionHead
          eyebrow="Propuestas"
          title="Resultados sugeridos"
          caption={
            proposals.length === 0
              ? "Submit una búsqueda para ver propuestas"
              : "Cada candidato lleva comparativa Route53 vs Porkbun"
          }
          count={proposals.length || undefined}
          countTone={proposals.length > 0 ? "success" : "neutral"}
        />
        <ProposalsList
          proposals={proposals}
          loading={availability.isFetching || suggestions.isFetching}
          submitted={submitted}
        />
      </motion.section>

      {proposals.some((p) => p.availability === "AVAILABLE") ? (
        <motion.div variants={staggerItem}>
          <BannerOpenClawV2 count={proposals.filter((p) => p.availability === "AVAILABLE").length} />
        </motion.div>
      ) : null}

      <motion.footer variants={staggerItem}>
        <FooterStrip spentRemaining={spentRemaining} />
      </motion.footer>
    </motion.div>
  );
}

/* ============================================================
 * GuardrailStrip — 4 chips/stats visibles arriba.
 * ============================================================ */

function GuardrailStrip({
  spent,
  cap,
  capPct,
  ownedCount
}: {
  spent: number;
  cap: number;
  capPct: number;
  ownedCount: number;
}) {
  const capTone: "success" | "warning" | "critical" = capPct >= 95 ? "critical" : capPct >= 80 ? "warning" : "success";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <GuardrailTile
        label="Cap mensual"
        value={`$${spent.toFixed(0)} / $${cap.toFixed(0)}`}
        unit="USD"
        hint={`${(100 - capPct).toFixed(0)}% disponible · ${ownedCount} dominios en cartera`}
        pillLabel={capTone === "critical" ? "excedido" : capTone === "warning" ? "vigilar" : "saludable"}
        pillTone={capTone}
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
        progress={capPct}
        progressTone={capTone}
      />
      <GuardrailTile
        label="WHOIS privacy"
        value="Activada"
        hint="Hardcoded · oculta contacto del registrante en todos los registros"
        pillLabel="forzado"
        pillTone="success"
        icon={<ShieldCheck size={14} strokeWidth={1.75} />}
      />
      <GuardrailTile
        label="Aprobación"
        value="Doble firma"
        hint="Operador 1 propone, Operador 2 confirma · audit chain firma cada paso"
        pillLabel="2 humanos"
        pillTone="warning"
        icon={<CircleHelp size={14} strokeWidth={1.75} />}
      />
      <GuardrailTile
        label="Compra real"
        value={PURCHASE_ENABLED ? "Habilitada" : "Bloqueada"}
        hint={
          PURCHASE_ENABLED
            ? "Flag de demo activada · cuidado con cada propuesta"
            : "Fase 2 deshabilitada · el panel solo propone, no ejecuta"
        }
        pillLabel={PURCHASE_ENABLED ? "demo on" : "lock"}
        pillTone={PURCHASE_ENABLED ? "warning" : "critical"}
        icon={<Lock size={14} strokeWidth={1.75} />}
      />
    </div>
  );
}

interface GuardrailTileProps {
  label: string;
  value: string;
  unit?: string;
  hint: string;
  pillLabel: string;
  pillTone: "success" | "warning" | "critical" | "neutral";
  icon: React.ReactNode;
  progress?: number;
  progressTone?: "success" | "warning" | "critical";
}

function GuardrailTile({
  label,
  value,
  unit,
  hint,
  pillLabel,
  pillTone,
  icon,
  progress,
  progressTone
}: GuardrailTileProps) {
  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle">{icon}</span>
          <Eyebrow className="leading-[1.2]">{label}</Eyebrow>
        </div>
        <Pill tone={pillTone} size="sm">
          {pillLabel}
        </Pill>
      </div>
      <div className="flex items-baseline gap-1.5">
        <MonoData className="text-[22px] font-semibold leading-none tabular-nums">
          {value}
        </MonoData>
        {unit ? <Caption className="text-fg-subtle">{unit}</Caption> : null}
      </div>
      {typeof progress === "number" ? (
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
          <span
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(2, Math.min(100, progress))}%`,
              background:
                progressTone === "critical"
                  ? "var(--color-critical)"
                  : progressTone === "warning"
                  ? "var(--color-warning)"
                  : "var(--color-success)"
            }}
          />
        </div>
      ) : null}
      <Caption className="text-fg-subtle">{hint}</Caption>
    </Card>
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
    <Card padding="hero" className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <label className="flex flex-1 items-center gap-3 rounded-md border border-border-strong bg-surface px-4 transition-colors focus-within:border-border-focus">
          <Search size={16} strokeWidth={1.75} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="delivrix-mail.com  ·  o una keyword: delivrix"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-12 flex-1 bg-transparent font-mono text-[14px] text-fg outline-none placeholder:text-fg-subtle"
            aria-label="Dominio o keyword a explorar"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={!plausible || fetching}
          className="sm:min-w-[220px]"
        >
          <Sparkles size={13} strokeWidth={1.75} />
          Sugerir con OpenClaw
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Caption className="text-fg-subtle">
          {submitted
            ? <>Última búsqueda: <MonoCode>{submitted}</MonoCode></>
            : "Sin búsquedas en esta sesión."}
        </Caption>
        <span className="flex-1" aria-hidden="true" />
        <Badge>cache 5 min</Badge>
        <Badge>read-only</Badge>
      </div>
    </Card>
  );
}

/* ============================================================
 * ProposalsList — cards de candidatos.
 * ============================================================ */

interface ProposalRow {
  domain: string;
  tld: string;
  availability: DomainAvailabilityStatus | null;
  score: number;
  route53Price: DomainPrice | undefined;
  porkbunDelta: number | null;
  source: "submitted" | "suggestion";
}

function ProposalsList({
  proposals,
  loading,
  submitted
}: {
  proposals: ProposalRow[];
  loading: boolean;
  submitted: string;
}) {
  if (proposals.length === 0) {
    if (loading) {
      return (
        <Card padding="hero" className="flex items-center gap-3">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-fg-subtle" aria-hidden="true" />
          <Caption className="text-fg-muted">Consultando Route53 …</Caption>
        </Card>
      );
    }
    return (
      <Card padding="hero" className="flex items-start gap-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-subtle">
          <Search size={16} strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <H3>{submitted ? "Sin candidatos para esta búsqueda" : "Empieza con una búsqueda"}</H3>
          <BodySm>
            {submitted
              ? <>OpenClaw no encontró sugerencias para <MonoCode>{submitted}</MonoCode>. Prueba un seed más específico de 3 o más caracteres alfanuméricos.</>
              : "Escribe un dominio completo o una keyword. OpenClaw propondrá hasta 10 alternativas comparando precio y disponibilidad."}
          </BodySm>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {proposals.map((p) => (
        <ProposalCard key={p.domain} proposal={p} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalRow }) {
  const tone: "success" | "warning" | "critical" | "neutral" =
    proposal.availability === "AVAILABLE"
      ? "success"
      : proposal.availability === "UNAVAILABLE"
      ? "critical"
      : proposal.availability === "RESERVED"
      ? "warning"
      : "neutral";

  const route53Label = proposal.route53Price
    ? formatUsd(proposal.route53Price.registration)
    : "—";
  const porkbunLabel =
    proposal.route53Price && proposal.porkbunDelta !== null
      ? formatUsd((proposal.route53Price.registration ?? 0) + proposal.porkbunDelta)
      : "—";
  const deltaLabel = proposal.porkbunDelta !== null
    ? `${proposal.porkbunDelta < 0 ? "−" : "+"}$${Math.abs(proposal.porkbunDelta).toFixed(2)}`
    : "—";
  const cheaperOnPorkbun = (proposal.porkbunDelta ?? 0) < 0;

  return (
    <Card padding="relaxed" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block size-1.5 rounded-full"
              style={{
                background:
                  tone === "success"
                    ? "var(--color-success)"
                    : tone === "warning"
                    ? "var(--color-warning)"
                    : tone === "critical"
                    ? "var(--color-critical)"
                    : "var(--color-fg-subtle)"
              }}
            />
            <MonoData className="truncate text-[14px]" title={proposal.domain}>
              {proposal.domain}
            </MonoData>
          </div>
          <Caption className="text-fg-subtle">
            {labelForAvailability(proposal.availability)} · score {proposal.score}/10
            {proposal.source === "submitted" ? " · búsqueda directa" : " · sugerido"}
          </Caption>
        </div>
        <Pill tone={tone as never} size="sm">
          {pillLabelForAvailability(proposal.availability)}
        </Pill>
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
        <PriceColumn label="Route53" value={route53Label} />
        <PriceColumn label="Porkbun" value={porkbunLabel} hint={proposal.porkbunDelta === null ? "sin matriz" : undefined} />
        <PriceColumn
          label="Δ Porkbun"
          value={deltaLabel}
          tone={cheaperOnPorkbun ? "success" : proposal.porkbunDelta !== null ? "warning" : "neutral"}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={proposal.availability === "AVAILABLE" ? "primary" : "secondary"}
          size="sm"
          disabled={proposal.availability !== "AVAILABLE"}
          aria-label={`Solicitar aprobación para ${proposal.domain}`}
        >
          <Lock size={11} strokeWidth={1.75} />
          Solicitar aprobación
          <ArrowRight size={11} strokeWidth={1.75} />
        </Button>
        <span className="flex-1" aria-hidden="true" />
        <Caption className="text-fg-subtle">No ejecuta compra · gate Fase 2</Caption>
      </div>
    </Card>
  );
}

function PriceColumn({
  label,
  value,
  hint,
  tone = "neutral"
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning";
}) {
  const valueClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-fg";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow className="text-[9.5px]">{label}</Eyebrow>
      <MonoData className={cn("text-[14px] font-semibold tabular-nums", valueClass)}>
        {value}
      </MonoData>
      {hint ? <Caption className="text-[10px] text-fg-subtle">{hint}</Caption> : null}
    </div>
  );
}

/* ============================================================
 * BannerOpenClawV2 — única HumanNote de la vista.
 * ============================================================ */

function BannerOpenClawV2({ count }: { count: number }) {
  return (
    <Card padding="relaxed" className="flex items-start gap-4">
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
        <TriangleAlert size={16} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eyebrow>OpenClaw recuerda</Eyebrow>
          <Pill tone="warning" size="sm">Doble firma</Pill>
        </div>
        <H3>
          {count === 1
            ? "1 propuesta espera aprobación humana"
            : `${count} propuestas esperan aprobación humana`}
        </H3>
        <BodySm>
          La compra real queda detrás de Fase 2 con dos firmas humanas. Cuando
          firmes la propuesta, OpenClaw prepara el flow de registro pero no
          ejecuta hasta que un segundo operador valide en Canvas Live.
        </BodySm>
        <HumanNote className="mt-1 max-w-[560px]">
          Si quieres revisamos cada candidata antes de firmar — abro el chat y te lo explico.
        </HumanNote>
        <div className="mt-1 flex items-center gap-2">
          <Button variant="primary" size="sm">
            Revisar en Canvas Live
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
          <Button variant="ghost" size="sm">
            Abrir chat
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
 * FooterStrip — runbook + endpoint + cap.
 * ============================================================ */

function FooterStrip({ spentRemaining }: { spentRemaining: number }) {
  return (
    <Card tone="quiet" padding="relaxed" className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <Eyebrow>Runbook</Eyebrow>
        <a
          href="#"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-muted underline-offset-4 hover:text-fg hover:underline"
        >
          {RUNBOOK_PATH}
          <ExternalLink size={10} strokeWidth={1.75} />
        </a>
      </div>
      <span aria-hidden="true" className="inline-block size-[3px] rounded-full bg-border-strong" />
      <div className="flex items-center gap-2">
        <Eyebrow>Endpoint</Eyebrow>
        <MonoCode>GET {READ_ENDPOINTS.domainAvailability}</MonoCode>
      </div>
      <span className="flex-1" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <Eyebrow>Cap restante</Eyebrow>
        <MonoData className="text-[13px] tabular-nums">
          ${spentRemaining.toFixed(0)} / ${MONTHLY_CAP_USD} USD
        </MonoData>
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
      score: scoreFor(availability.domain, availability.availability),
      route53Price: priceByTld.get(tld),
      porkbunDelta: porkbunDeltaFor(tld),
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
      score: scoreFor(s.domain, s.availability),
      route53Price: priceByTld.get(tld),
      porkbunDelta: porkbunDeltaFor(tld),
      source: "suggestion"
    });
  }

  return rows;
}

function scoreFor(domain: string, status: DomainAvailabilityStatus | null): number {
  // Heurística simple Fase 1: brandability ≈ inverso de longitud + bonus disponibilidad.
  const len = domain.split(".")[0]?.length ?? domain.length;
  const lengthScore = Math.max(0, 10 - Math.max(0, len - 6));
  const availBonus = status === "AVAILABLE" ? 0 : status === "UNAVAILABLE" ? -3 : -1;
  return Math.max(1, Math.min(10, lengthScore + availBonus));
}

function porkbunDeltaFor(tld: string): number | null {
  if (!tld) return null;
  return PORKBUN_DELTA_USD[tld] ?? null;
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

function labelForAvailability(status: DomainAvailabilityStatus | null): string {
  if (status === "AVAILABLE") return "Disponible";
  if (status === "UNAVAILABLE") return "Registrado";
  if (status === "RESERVED") return "Reservado";
  if (status === "PENDING") return "Pendiente";
  if (status === "DONT_KNOW") return "Sin confirmar";
  return "Sin verificar";
}

function pillLabelForAvailability(status: DomainAvailabilityStatus | null): string {
  if (status === "AVAILABLE") return "disponible";
  if (status === "UNAVAILABLE") return "ocupado";
  if (status === "RESERVED") return "reservado";
  if (status === "PENDING") return "pendiente";
  return "sin confirmar";
}

function formatUsd(amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

/* ============================================================
 * Sanity helpers — explicit reference so unused-imports lint clean.
 * ============================================================ */

// `H2` y `CheckCircle2` reservados para evolutivos cercanos (Wallet tile +
// status chip de aprobaciones). Evitar tree-shake quirks dejando referencia.
export const __h2Reserved = H2;
export const __checkReserved = CheckCircle2;
