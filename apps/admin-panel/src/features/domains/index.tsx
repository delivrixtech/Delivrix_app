/**
 * Domains · Fase 1 discover/propose (Hito 5.12 / Bloque 5 Codex 2026-05-25).
 *
 * Feature read-only que permite al operador (y a OpenClaw via skills) explorar
 * dominios disponibles vía AWS Route53 Domains sin compra real. La compra real
 * queda detrás de Fase 2 con doble aprobación humana · esta UI deja todos los
 * affordances visibles para que la transición sea additiva.
 *
 * Diseño:
 *   - SearchHero: input grande con debounce → resultado inline (status + price).
 *   - Suggestions: 10 candidatas cuando hay seed.
 *   - PricesPanel: snapshot top TLDs (.com .net .io .co).
 *   - OwnedDomains: tabla · empty state Fase 1.
 *   - ProposalQueue: placeholder Fase 2 con el flujo de doble aprobación.
 *   - OpenClawBanner: CTAs que inyectan intent al chat (sin endpoints nuevos).
 *
 * Endpoints (Codex 5104fd9):
 *   GET /v1/domains/availability?name=...
 *   GET /v1/domains/suggestions?seed=...&count=...&onlyAvailable=...
 *   GET /v1/domains/prices?tlds=com,net,io,co
 *   GET /v1/domains/owned
 *
 * Read-only por contrato: no hay POST en este archivo. La eventual Fase 2 (compra)
 * pasará por OpenClaw skill con gate `requires_human_approval`, NO por un POST
 * directo del panel.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Globe,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  TriangleAlert,
  XCircle
} from "lucide-react";
import { getJson, getJsonWithQuery } from "../../shared/api/client.ts";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary.ts";
import {
  FeatureHeader,
  LiveIndicator,
  SectionDivider,
  SkeletonRow,
  useOpenClawIntent,
  useToast
} from "../../shared/ui/v2/index.ts";

/* ============================================================
 * Contract types · mirror del paquete @delivrix/domain
 * (packages/domain/src/domains-discover.ts, Codex 5104fd9).
 *
 * Patrón del panel: cada feature copia los tipos del contract domain en vez
 * de importar el paquete directamente (mantiene el bundle acotado y evita
 * acoplar el FE a cambios de versión transitiva).
 * ============================================================ */

export type DomainAvailabilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "RESERVED"
  | "DONT_KNOW"
  | "PENDING";

export interface DomainAvailability {
  domain: string;
  availability: DomainAvailabilityStatus;
  available: boolean;
  checkedAt: string;
}

export interface DomainSuggestion {
  domain: string;
  availability: DomainAvailabilityStatus | null;
}

export interface DomainPrice {
  tld: string;
  registration: number | null;
  renewal: number | null;
  currency: string | null;
}

export interface OwnedDomain {
  domain: string;
  expiry: string | null;
}

interface AvailabilityResponse {
  domain: string;
  availability: DomainAvailabilityStatus;
  available: boolean;
  checkedAt: string;
  source: { kind: "live" | "mock"; responseOk?: boolean; trusted?: boolean };
}

interface SuggestionsResponse {
  seed: string;
  suggestions: DomainSuggestion[];
  source: { kind: "live" | "mock"; responseOk?: boolean; trusted?: boolean };
}

interface PricesResponse {
  prices: DomainPrice[];
  source: { kind: "live" | "mock"; responseOk?: boolean; trusted?: boolean };
}

interface OwnedResponse {
  domains: OwnedDomain[];
  source: { kind: "live" | "mock"; responseOk?: boolean; trusted?: boolean };
}

/* ============================================================
 * Hooks
 * ============================================================ */

const POLL_PRICES_MS = 5 * 60_000; // 5min · Route53 cache TTL
const POLL_OWNED_MS = 60_000;
const DEFAULT_TLDS = ["com", "net", "io", "co"];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function usePrices(extraTld?: string | null) {
  const tlds = useMemo(() => uniqueStrings([
    ...DEFAULT_TLDS,
    ...(extraTld ? [extraTld] : [])
  ]), [extraTld]);
  return useQuery({
    queryKey: ["domains", "prices", tlds.join(",")],
    queryFn: () =>
      getJsonWithQuery<PricesResponse>(READ_ENDPOINTS.domainPrices, {
        tlds: tlds.join(",")
      }),
    refetchInterval: POLL_PRICES_MS,
    staleTime: POLL_PRICES_MS / 2
  });
}

function useOwned() {
  return useQuery({
    queryKey: ["domains", "owned"],
    queryFn: () => getJson<OwnedResponse>(READ_ENDPOINTS.ownedDomains),
    refetchInterval: POLL_OWNED_MS,
    staleTime: POLL_OWNED_MS / 2
  });
}

function useAvailability(rawQuery: string) {
  const debounced = useDebounced(rawQuery.trim().toLowerCase(), 350);
  const valid = isPlausibleDomain(debounced);
  return useQuery({
    queryKey: ["domains", "availability", debounced],
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
    queryKey: ["domains", "suggestions", debounced],
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

function isPlausibleDomain(value: string): boolean {
  // delivrix-mail.com, foo.io, bar-baz.co · al menos un punto, TLD ≥ 2 chars.
  return /^[a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,}$/.test(value);
}

function domainTldFromQuery(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes(".")) return null;
  const tld = trimmed.split(".").filter(Boolean).at(-1);
  return tld && /^[a-z][a-z0-9-]{1,62}$/.test(tld) ? tld : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/* ============================================================
 * <DomainsSection> · root
 * ============================================================ */

export function DomainsSection() {
  const [query, setQuery] = useState("");
  const [seed, setSeed] = useState("");
  const activeTld = domainTldFromQuery(query);

  const availability = useAvailability(query);
  const suggestions = useSuggestions(seed);
  const prices = usePrices(activeTld);
  const owned = useOwned();

  const lastUpdate = Math.max(
    prices.dataUpdatedAt || 0,
    owned.dataUpdatedAt || 0,
    availability.dataUpdatedAt || 0
  ) || Date.now();

  // Si el usuario escribe un dominio "foo.com" → también buscar suggestions del prefijo.
  useEffect(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      setSeed("");
      return;
    }
    const prefix = trimmed.split(".")[0];
    if (prefix.length >= 3) setSeed(prefix);
  }, [query]);

  return (
    <section className="flex flex-col" style={{ gap: 24 }}>
      <FeatureHeader
        eyebrow="Hito 5.12 · Dominios"
        title="Buscar, valorar y proponer dominios."
        lead={
          <>
            Discover/propose vía AWS Route53 Domains. <strong style={{ color: "var(--color-text-primary)" }}>Compra real bloqueada</strong> hasta
            que OpenClaw proponga + dos humanos aprueben. Cada consulta queda en audit chain.
          </>
        }
        eyebrowSuffix={<PhaseBadge phase="1" />}
        rightSlot={<LiveIndicator pollIntervalSec={300} lastUpdateAt={lastUpdate} tone="success" />}
      />

      <SearchHero
        query={query}
        onQueryChange={setQuery}
        availability={availability}
        prices={prices.data?.prices}
        pricesFetching={prices.isFetching}
      />

      <div
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]"
        style={{ gap: 20 }}
      >
        {/* Main column */}
        <div className="flex flex-col min-w-0" style={{ gap: 20 }}>
          <SuggestionsSection
            seed={seed}
            onSelectDomain={(d) => setQuery(d)}
            suggestions={suggestions}
          />
          <OwnedDomainsSection owned={owned} />
          <ProposalQueueSection />
        </div>

        {/* Side rail */}
        <aside className="flex flex-col" style={{ gap: 16 }}>
          <OnboardEndToEndCard
            currentQuery={query}
            currentAvailability={availability.data?.availability ?? null}
          />
          <PricesPanel prices={prices} />
          <AskOpenClawCard currentQuery={query} />
          <PhaseStatusCard />
        </aside>
      </div>
    </section>
  );
}

/* ============================================================
 * SearchHero
 * ============================================================ */

function SearchHero({
  query,
  onQueryChange,
  availability,
  prices,
  pricesFetching
}: {
  query: string;
  onQueryChange: (v: string) => void;
  availability: ReturnType<typeof useAvailability>;
  prices: DomainPrice[] | undefined;
  pricesFetching: boolean;
}) {
  const trimmed = query.trim().toLowerCase();
  const valid = isPlausibleDomain(trimmed);
  const tld = domainTldFromQuery(trimmed);
  const tldPrice = tld ? prices?.find((p) => p.tld === tld) : undefined;

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 24,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 12,
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <label className="flex flex-col" style={{ gap: 6 }}>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold uppercase"
          style={{ fontSize: 10, letterSpacing: "1.2px", color: "var(--color-text-tertiary)" }}
        >
          Buscar dominio
        </span>
        <div
          className="flex items-center"
          style={{
            gap: 10,
            padding: "0 14px",
            height: 52,
            background: "var(--color-bg)",
            border: `1px solid ${valid ? "var(--color-accent-tertiary)" : "var(--color-border)"}`,
            borderRadius: 10,
            transition: "border-color 120ms ease"
          }}
        >
          <Search size={18} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="delivrix-mail.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 bg-transparent font-[family-name:var(--font-mono)] outline-none"
            style={{ fontSize: 16, color: "var(--color-text-primary)", border: "none" }}
            aria-label="Dominio a verificar"
          />
          {availability.isFetching ? (
            <Loader2
              size={16}
              strokeWidth={1.75}
              className="animate-spin"
              style={{ color: "var(--color-text-tertiary)" }}
              aria-label="Buscando…"
            />
          ) : null}
          {tld ? (
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 4,
                background: "var(--color-surface-sunken)",
                color: "var(--color-text-secondary)"
              }}
            >
              .{tld}
            </span>
          ) : null}
        </div>
      </label>

      <AvailabilityRow
        trimmed={trimmed}
        valid={valid}
        availability={availability}
        tldPrice={tldPrice}
        pricePending={Boolean(tld && pricesFetching && !tldPrice)}
      />
    </div>
  );
}

function AvailabilityRow({
  trimmed,
  valid,
  availability,
  tldPrice,
  pricePending
}: {
  trimmed: string;
  valid: boolean;
  availability: ReturnType<typeof useAvailability>;
  tldPrice: DomainPrice | undefined;
  pricePending: boolean;
}) {
  if (!trimmed) {
    return (
      <p
        className="m-0 font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
      >
        Escribe un dominio completo (ej. <code>delivrix-mail.com</code>). Las consultas pegan en vivo a Route53 · cache 5 min.
      </p>
    );
  }
  if (!valid) {
    return (
      <p
        className="m-0 font-[family-name:var(--font-mono)]"
        style={{ fontSize: 11, color: "var(--color-warning)" }}
      >
        Formato inválido. Necesita un nombre + TLD (ej. <code>delivrix-mail.com</code>).
      </p>
    );
  }
  if (availability.isLoading) {
    return (
      <div className="flex items-center" style={{ gap: 10 }}>
        <Loader2 size={14} strokeWidth={1.75} className="animate-spin" style={{ color: "var(--color-text-tertiary)" }} />
        <span className="font-[family-name:var(--font-mono)]" style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          Consultando Route53…
        </span>
      </div>
    );
  }
  if (availability.isError) {
    return (
      <div className="flex items-center" style={{ gap: 10 }}>
        <TriangleAlert size={14} strokeWidth={1.75} style={{ color: "var(--color-warning)" }} />
        <span className="font-[family-name:var(--font-mono)]" style={{ fontSize: 11, color: "var(--color-warning)" }}>
          No se pudo consultar · {availability.error instanceof Error ? availability.error.message : "error desconocido"}
        </span>
      </div>
    );
  }
  if (!availability.data) return null;

  const status = availability.data.availability;
  return (
    <div
      className="flex flex-wrap items-center"
      style={{
        gap: 12,
        padding: "10px 14px",
        background: statusBg(status),
        border: `1px solid ${statusBorder(status)}`,
        borderRadius: 8
      }}
    >
      <StatusIcon status={status} />
      <div className="flex flex-col min-w-0">
        <span
          className="font-[family-name:var(--font-mono)] font-semibold truncate"
          style={{ fontSize: 14, color: statusFg(status) }}
        >
          {availability.data.domain}
        </span>
        <span
          className="font-[family-name:var(--font-caption)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {statusLabel(status)}
        </span>
      </div>
      <span className="flex-1" aria-hidden="true" />
      {tldPrice ? (
        <div className="flex flex-col items-end" style={{ gap: 2 }}>
          <span
            className="font-[family-name:var(--font-mono)] font-semibold"
            style={{ fontSize: 13, color: "var(--color-text-primary)" }}
          >
            {formatPrice(tldPrice.registration, tldPrice.currency)}/año
          </span>
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            Renovación {formatPrice(tldPrice.renewal, tldPrice.currency)}
          </span>
        </div>
      ) : availability.data.available ? (
        <div className="flex flex-col items-end" style={{ gap: 2 }}>
          <span
            className="font-[family-name:var(--font-mono)] font-semibold"
            style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
          >
            {pricePending ? "consultando precio..." : "precio no disponible"}
          </span>
          <span
            className="font-[family-name:var(--font-caption)]"
            style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
          >
            Route53 snapshot
          </span>
        </div>
      ) : null}
      {status === "AVAILABLE" ? <ProposePurchaseButton domain={availability.data.domain} /> : null}
    </div>
  );
}

function ProposePurchaseButton({ domain }: { domain: string }) {
  const intent = useOpenClawIntent();
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        const prompt = `Acción del operador: proponer compra de "${domain}".\n\nContexto: encontré disponible vía Route53. Por favor:\n1. Verifica el precio de registro y renovación.\n2. Sugiere si conviene multi-año o auto-renew.\n3. Prepara la propuesta para que dos humanos aprueben antes de Fase 2 (compra real).\n\nNo ejecutes la compra todavía · la Fase 2 requiere doble aprobación y todavía no está habilitada.`;
        intent.sendIntent(prompt, "domains:propose");
        toast.info("Enviando a OpenClaw · Proponer compra", {
          description: "OpenClaw preparará la propuesta. La compra real queda detrás de doble aprobación.",
          duration: 3000
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-[6px] font-[family-name:var(--font-sans)] font-semibold transition-colors hover:bg-[var(--color-accent-tertiary)] hover:text-[var(--color-on-dark-strong)]"
      style={{
        padding: "7px 12px",
        fontSize: 12,
        background: "var(--color-surface)",
        color: "var(--color-accent-tertiary)",
        border: "1px solid var(--color-accent-tertiary)",
        cursor: "pointer"
      }}
    >
      <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
      Proponer con OpenClaw
    </button>
  );
}

/* ============================================================
 * SuggestionsSection
 * ============================================================ */

function SuggestionsSection({
  seed,
  onSelectDomain,
  suggestions
}: {
  seed: string;
  onSelectDomain: (domain: string) => void;
  suggestions: ReturnType<typeof useSuggestions>;
}) {
  if (!seed) return null;
  const items = suggestions.data?.suggestions ?? [];
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      <SectionDivider
        title="Sugerencias"
        caption={`seed: ${seed}`}
        countTone="neutral"
        count={items.length > 0 ? items.length : undefined}
      />
      {suggestions.isLoading ? (
        <div className="flex flex-col" style={{ gap: 6 }}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : items.length === 0 ? (
        <p
          className="m-0 font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "12px 0" }}
        >
          Sin sugerencias para <code>{seed}</code>. Probá un seed más específico (3+ caracteres alfanuméricos).
        </p>
      ) : (
        <ul
          className="grid grid-cols-1 sm:grid-cols-2"
          style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}
        >
          {items.map((s) => (
            <li key={s.domain}>
              <button
                type="button"
                onClick={() => onSelectDomain(s.domain)}
                className="flex w-full items-center transition-colors hover:bg-[var(--color-surface-sunken)]"
                style={{
                  gap: 10,
                  padding: "10px 12px",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  cursor: "pointer"
                }}
              >
                <StatusDot status={s.availability} />
                <span
                  className="flex-1 truncate font-[family-name:var(--font-mono)] text-left"
                  style={{ fontSize: 12, color: "var(--color-text-primary)" }}
                >
                  {s.domain}
                </span>
                <ArrowRight size={12} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 * OwnedDomainsSection
 * ============================================================ */

function OwnedDomainsSection({ owned }: { owned: ReturnType<typeof useOwned> }) {
  const items = owned.data?.domains ?? [];
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      <SectionDivider
        title="Dominios propios"
        caption="GET /v1/domains/owned · Route53 live"
        countTone={items.length > 0 ? "success" : "neutral"}
        count={owned.data ? items.length : undefined}
      />
      {owned.isLoading ? (
        <SkeletonRow />
      ) : items.length === 0 ? (
        <div
          className="flex flex-col items-start"
          style={{
            gap: 6,
            padding: 20,
            background: "var(--color-surface)",
            border: "1px dashed var(--color-border)",
            borderRadius: 10
          }}
        >
          <div className="flex items-center" style={{ gap: 8 }}>
            <Globe size={16} strokeWidth={1.5} style={{ color: "var(--color-text-tertiary)" }} />
            <span
              className="font-[family-name:var(--font-sans)] font-semibold"
              style={{ fontSize: 13, color: "var(--color-text-primary)" }}
            >
              Aún no hay dominios registrados
            </span>
          </div>
          <p
            className="m-0 font-[family-name:var(--font-caption)]"
            style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}
          >
            La cuenta AWS está conectada y autorizada para leer dominios, pero todavía no se registró
            ninguno. La compra real se habilita en Fase 2 con doble aprobación.
          </p>
        </div>
      ) : (
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            overflow: "hidden"
          }}
        >
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-surface-sunken)" }}>
                <Th>Dominio</Th>
                <Th align="right">Expira</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.domain} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <Td>
                    <span className="font-[family-name:var(--font-mono)]" style={{ fontSize: 12 }}>
                      {d.domain}
                    </span>
                  </Td>
                  <Td align="right">
                    <span
                      className="font-[family-name:var(--font-mono)]"
                      style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
                    >
                      {formatExpiry(d.expiry)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * ProposalQueueSection · Fase 2 placeholder con flujo educativo
 * ============================================================ */

function ProposalQueueSection() {
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      <SectionDivider
        title="Propuestas de compra"
        caption="Fase 2 · requiere doble aprobación"
        countTone="warning"
        count="Fase 2"
      />
      <div
        className="flex flex-col"
        style={{
          gap: 14,
          padding: 18,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 10
        }}
      >
        <div className="flex items-start" style={{ gap: 12 }}>
          <span
            aria-hidden="true"
            className="grid place-items-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--color-warning-soft)",
              color: "var(--color-warning)"
            }}
          >
            <Lock size={18} strokeWidth={1.5} />
          </span>
          <div className="flex flex-col" style={{ gap: 4 }}>
            <span
              className="font-[family-name:var(--font-sans)] font-semibold"
              style={{ fontSize: 13, color: "var(--color-text-primary)" }}
            >
              Compra real deshabilitada por seguridad
            </span>
            <p
              className="m-0 font-[family-name:var(--font-caption)]"
              style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
            >
              Las propuestas que dispares con OpenClaw quedan acá esperando aprobación humana.
              Cuando habilitemos Fase 2, el flujo será: propuesta → review → aprobación de dos
              operadores → ejecución <code>route53domains:RegisterDomain</code>.
            </p>
          </div>
        </div>

        <ol
          className="flex flex-col"
          style={{ gap: 8, padding: 0, margin: 0, listStyle: "none" }}
        >
          {[
            "OpenClaw prepara la propuesta (disponibilidad + precio + recomendación)",
            "Operador 1 revisa y firma",
            "Operador 2 revisa y firma",
            "Gateway ejecuta RegisterDomain via Route53",
            "Audit chain captura el evento crítico"
          ].map((step, i) => (
            <li key={i} className="flex items-center" style={{ gap: 10 }}>
              <span
                aria-hidden="true"
                className="grid place-items-center font-[family-name:var(--font-mono)] font-bold"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: "var(--color-surface-sunken)",
                  color: "var(--color-text-secondary)",
                  fontSize: 10
                }}
              >
                {i + 1}
              </span>
              <span
                className="font-[family-name:var(--font-caption)]"
                style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
              >
                {step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ============================================================
 * PricesPanel (side rail)
 * ============================================================ */

function PricesPanel({ prices }: { prices: ReturnType<typeof usePrices> }) {
  const items = prices.data?.prices ?? [];
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 12,
        padding: 16,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Precios snapshot
        </span>
        <span className="flex-1" aria-hidden="true" />
        <span
          className="font-[family-name:var(--font-caption)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          cache 5min
        </span>
      </div>
      {prices.isLoading ? (
        <SkeletonRow />
      ) : items.length === 0 ? (
        <p
          className="m-0 font-[family-name:var(--font-mono)]"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          Sin precios disponibles.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((p) => (
            <li
              key={p.tld}
              className="flex items-center"
              style={{ gap: 10, padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}
            >
              <span
                className="font-[family-name:var(--font-mono)] font-semibold"
                style={{ fontSize: 12, color: "var(--color-text-primary)", minWidth: 38 }}
              >
                .{p.tld}
              </span>
              <span className="flex-1" aria-hidden="true" />
              <span
                className="font-[family-name:var(--font-mono)]"
                style={{ fontSize: 12, color: "var(--color-text-primary)" }}
              >
                {formatPrice(p.registration, p.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 * OnboardEndToEndCard · dispara el flow viernes-demo completo
 *
 * Pieza 2 del sprint demo viernes (Bloque 10). Equivalente al
 * OnboardNewDomainCard del Sender Pool pero situado en Domains para que
 * el operador no tenga que cambiar de feature después de buscar/elegir
 * un dominio.
 *
 * Si el input tiene un dominio AVAILABLE, lo pre-llena en el prompt.
 * Si no, deja que OpenClaw proponga 3 candidatos.
 * ============================================================ */

function OnboardEndToEndCard({
  currentQuery,
  currentAvailability
}: {
  currentQuery: string;
  currentAvailability: DomainAvailabilityStatus | null;
}) {
  const intent = useOpenClawIntent();
  const { toast } = useToast();
  const [flowState, setFlowState] = useState<"idle" | "in_progress">("idle");

  const trimmed = currentQuery.trim().toLowerCase();
  const validInput = isPlausibleDomain(trimmed);
  const isAvailableForCurrent = validInput && currentAvailability === "AVAILABLE";

  const handleOnboard = useCallback(() => {
    if (flowState === "in_progress") return;
    setFlowState("in_progress");

    // Prompt context-aware: si hay dominio AVAILABLE, va con ese; si no, OpenClaw propone.
    const prompt = isAvailableForCurrent
      ? `Acción del operador: onboardar el dominio "${trimmed}" end-to-end como sender Delivrix.

Acabo de verificar que está disponible en Route53. Por favor:
1. Confirma precio (registration + renewal) y prepara la propuesta de compra (Fase 2 · doble aprobación).
2. Una vez aprobada la compra, configura el flow completo:
   - Hosted zone Route53 + records DNS básicos.
   - SPF + DKIM (RSA 2048) + DMARC (p=none para warmup).
   - Provisionar VPS Webdock profile bit (Finland).
   - Install stack SMTP (postfix + opendkim + certbot TLS).
   - Bind dominio al servidor (MX + A).
   - Arrancar warmup con 3 emails seed a las inboxes configuradas.
3. Materializa cada paso en Canvas Live como artifact aprovable.
4. NO ejecutes la compra real sin aprobación humana doble en el artifact.`
      : `Acción del operador: onboardar un nuevo dominio sender para Delivrix end-to-end.

Por favor:
1. Propon 3 dominios disponibles relevantes para envío de email (.com o .net, máximo 18 chars, brandables).
2. Para el dominio que recomiendes, prepara el flow completo:
   - Compra en Route53 (con gates de aprobación).
   - Hosted zone + records DNS básicos.
   - SPF + DKIM (RSA 2048) + DMARC (p=none para warmup).
   - Provisionar VPS Webdock profile bit (Finland).
   - Install stack SMTP (postfix + opendkim + certbot TLS).
   - Bind dominio al servidor (MX + A).
   - Iniciar warmup con 3 emails seed.
3. Materializa cada paso en Canvas Live como artifact aprovable.
4. NO ejecutes la compra real sin mi aprobación explícita en el artifact.`;

    intent.sendIntent(prompt, "domains:onboard-end-to-end");
    toast.info("Enviando a OpenClaw · Onboarding end-to-end", {
      description: isAvailableForCurrent
        ? `Flow para "${trimmed}". Cada paso crítico requiere tu aprobación.`
        : "OpenClaw propondrá candidatos y luego ejecutará el flow paso a paso.",
      duration: 3500
    });
    setTimeout(() => setFlowState("idle"), 2000);
  }, [flowState, intent, isAvailableForCurrent, toast, trimmed]);

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 12,
        padding: 18,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-strong, var(--color-border))",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Sparkles size={14} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Onboard end-to-end
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
      >
        Dispara el flow completo con OpenClaw: compra · DNS · SPF/DKIM/DMARC · VPS · SMTP · warmup. Cada paso crítico requiere tu aprobación.
      </p>
      {isAvailableForCurrent ? (
        <div
          className="flex items-center"
          style={{
            gap: 6,
            padding: "6px 8px",
            background: "var(--color-success-soft)",
            border: "1px solid var(--color-success)",
            borderRadius: 6
          }}
        >
          <CheckCircle2 size={12} strokeWidth={2} style={{ color: "var(--color-success)", flexShrink: 0 }} />
          <span
            className="font-[family-name:var(--font-mono)] truncate"
            style={{ fontSize: 11, color: "var(--color-success)", fontWeight: 500, minWidth: 0 }}
            title={trimmed}
          >
            {trimmed}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={handleOnboard}
        disabled={flowState === "in_progress"}
        className="inline-flex items-center justify-center font-[family-name:var(--font-sans)] font-semibold transition-colors"
        style={{
          gap: 8,
          padding: "9px 14px",
          borderRadius: 8,
          background: "var(--color-text-primary)",
          color: "var(--color-bg)",
          border: "none",
          fontSize: 13,
          cursor: flowState === "in_progress" ? "wait" : "pointer",
          opacity: flowState === "in_progress" ? 0.7 : 1
        }}
      >
        {flowState === "in_progress" ? (
          <>
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
            Preparando onboarding…
          </>
        ) : (
          <>
            <Plus size={14} strokeWidth={1.75} />
            {isAvailableForCurrent ? `Onboard ${trimmed}` : "Onboard con OpenClaw"}
            <ArrowRight size={12} strokeWidth={1.75} />
          </>
        )}
      </button>
    </div>
  );
}

/* ============================================================
 * AskOpenClawCard · intent prompts al chat
 * ============================================================ */

function AskOpenClawCard({ currentQuery }: { currentQuery: string }) {
  const intent = useOpenClawIntent();
  const { toast } = useToast();
  const send = useCallback(
    (label: string, prompt: string) => {
      intent.sendIntent(prompt, `domains:${label}`);
      toast.info(`Enviando a OpenClaw · ${label}`, {
        description: "Prompt pre-llenado en el chat.",
        duration: 2500
      });
    },
    [intent, toast]
  );
  const trimmed = currentQuery.trim().toLowerCase();
  const hasQuery = trimmed.length > 0;
  const askCurrent = () => {
    if (!hasQuery) {
      toast.warning("Escribe un dominio primero", {
        description: "El campo de búsqueda está vacío.",
        duration: 2500
      });
      return;
    }
    send(
      "research",
      `Pregunta del operador: investiga el dominio "${trimmed}".\n\n1. Verifica disponibilidad con check_availability.\n2. Si está disponible: dame precio (registration + renewal) y propone si conviene multi-año.\n3. Si está ocupado: sugiere 3 alternativas cercanas con disponibilidad confirmada.\n4. Evalúa riesgo de typo-squatting respecto a marcas conocidas.\n\nNo ejecutes compra · la Fase 2 todavía no está habilitada.`
    );
  };
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 10,
        padding: 16,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Sparkles size={14} strokeWidth={1.75} style={{ color: "var(--color-accent-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Preguntar a OpenClaw
        </span>
      </div>
      <p
        className="m-0 font-[family-name:var(--font-caption)]"
        style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.55 }}
      >
        El agente puede explorar opciones, comparar TLDs y preparar propuestas.
      </p>
      <div className="flex flex-col" style={{ gap: 6 }}>
        <IntentButton
          label="Sugerencias para Delivrix"
          icon={<MessageSquare size={12} strokeWidth={1.75} />}
          onClick={() =>
            send(
              "suggest-delivrix",
              `Pregunta del operador: dame 5 sugerencias de dominios para Delivrix (plataforma de email infrastructure). Prioriza .com y .io, máximo 18 caracteres, fáciles de pronunciar. Para cada uno: verifica disponibilidad con check_availability, dame precio con list_prices, y un score 0-10 de qué tan brandable es.`
            )
          }
        />
        <IntentButton
          label="Comparar 3 candidatos"
          icon={<MessageSquare size={12} strokeWidth={1.75} />}
          onClick={() =>
            send(
              "compare",
              `Pregunta del operador: tengo 3 dominios candidatos: delivrix.com, delivrix-mail.io, sendviadx.co. Compara: precio anual, riesgo de typo-squatting, similitud con marcas existentes, y memorabilidad. Recomienda uno y explica el trade-off.`
            )
          }
        />
        <IntentButton
          label={hasQuery ? `Investigar ${trimmed}` : "Investigar dominio actual"}
          icon={<Search size={12} strokeWidth={1.75} />}
          onClick={askCurrent}
        />
      </div>
    </div>
  );
}

function IntentButton({
  label,
  icon,
  onClick
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center transition-colors hover:border-[var(--color-accent-tertiary)] hover:text-[var(--color-text-primary)]"
      style={{
        gap: 8,
        padding: "8px 10px",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        color: "var(--color-text-secondary)",
        cursor: "pointer",
        textAlign: "left"
      }}
    >
      <span style={{ color: "var(--color-accent-tertiary)" }}>{icon}</span>
      <span className="flex-1 font-[family-name:var(--font-sans)]" style={{ fontSize: 12 }}>
        {label}
      </span>
      <ArrowRight size={11} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
    </button>
  );
}

/* ============================================================
 * PhaseStatusCard
 * ============================================================ */

function PhaseStatusCard() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 12,
        padding: 16,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-semibold"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          Estado del módulo
        </span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <PhaseRow status="ok" label="Disponibilidad" sub="Route53 live" />
        <PhaseRow status="ok" label="Sugerencias" sub="Route53 live" />
        <PhaseRow status="ok" label="Precios" sub="Route53 live · cache 5min" />
        <PhaseRow status="ok" label="Listar propios" sub="Route53 live" />
        <PhaseRow status="locked" label="Comprar dominio" sub="Fase 2 · doble aprobación" />
        <PhaseRow status="locked" label="Hosted zones" sub="Fase 2 · DNS write" />
      </ul>
    </div>
  );
}

function PhaseRow({
  status,
  label,
  sub
}: {
  status: "ok" | "locked";
  label: string;
  sub: string;
}) {
  return (
    <li className="flex items-start" style={{ gap: 10 }}>
      <span aria-hidden="true" className="shrink-0" style={{ marginTop: 1 }}>
        {status === "ok" ? (
          <CheckCircle2 size={14} strokeWidth={1.75} style={{ color: "var(--color-success)" }} />
        ) : (
          <Lock size={14} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />
        )}
      </span>
      <div className="flex flex-col min-w-0" style={{ gap: 1 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-medium"
          style={{ fontSize: 12, color: "var(--color-text-primary)" }}
        >
          {label}
        </span>
        <span
          className="font-[family-name:var(--font-caption)]"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {sub}
        </span>
      </div>
    </li>
  );
}

/* ============================================================
 * Helpers visuales
 * ============================================================ */

function PhaseBadge({ phase }: { phase: string }) {
  return (
    <span
      className="font-[family-name:var(--font-caption)] font-semibold uppercase"
      style={{
        fontSize: 10,
        letterSpacing: "1px",
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--color-info-soft)",
        color: "var(--color-info)"
      }}
    >
      Fase {phase} · discover/propose
    </span>
  );
}

function StatusIcon({ status }: { status: DomainAvailabilityStatus }) {
  const size = 18;
  if (status === "AVAILABLE")
    return <CheckCircle2 size={size} strokeWidth={1.75} style={{ color: "var(--color-success)" }} />;
  if (status === "UNAVAILABLE")
    return <XCircle size={size} strokeWidth={1.75} style={{ color: "var(--color-critical)" }} />;
  if (status === "RESERVED")
    return <Lock size={size} strokeWidth={1.75} style={{ color: "var(--color-warning)" }} />;
  return <Circle size={size} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)" }} />;
}

function StatusDot({ status }: { status: DomainAvailabilityStatus | null }) {
  const color =
    status === "AVAILABLE"
      ? "var(--color-success)"
      : status === "UNAVAILABLE"
        ? "var(--color-critical)"
        : status === "RESERVED"
          ? "var(--color-warning)"
          : "var(--color-text-tertiary)";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        flexShrink: 0
      }}
    />
  );
}

function statusBg(status: DomainAvailabilityStatus): string {
  if (status === "AVAILABLE") return "var(--color-success-soft)";
  if (status === "UNAVAILABLE") return "var(--color-critical-soft)";
  if (status === "RESERVED") return "var(--color-warning-soft)";
  return "var(--color-surface-sunken)";
}

function statusBorder(status: DomainAvailabilityStatus): string {
  if (status === "AVAILABLE") return "var(--color-success)";
  if (status === "UNAVAILABLE") return "var(--color-critical)";
  if (status === "RESERVED") return "var(--color-warning)";
  return "var(--color-border)";
}

function statusFg(status: DomainAvailabilityStatus): string {
  if (status === "AVAILABLE") return "var(--color-success)";
  if (status === "UNAVAILABLE") return "var(--color-critical)";
  if (status === "RESERVED") return "var(--color-warning)";
  return "var(--color-text-primary)";
}

function statusLabel(status: DomainAvailabilityStatus): string {
  if (status === "AVAILABLE") return "Disponible · listo para proponer compra";
  if (status === "UNAVAILABLE") return "Ya está registrado por alguien más";
  if (status === "RESERVED") return "Reservado por el registry";
  if (status === "PENDING") return "Pendiente de confirmación";
  return "No se pudo determinar";
}

function formatPrice(amount: number | null, currency: string | null): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Precio no disponible";
  }
  return `${currency ?? "USD"} ${amount.toFixed(2)}`;
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "Sin dato";
  try {
    let date: Date;
    // El backend de Route53 a veces devuelve Unix epoch como string ("1811462902")
    // en vez de ISO. Si el input es solo dígitos, parseamos como epoch (segundos si
    // tiene ≤10 dígitos, ms si tiene 13). Si es ISO normal, parse directo.
    if (/^\d+$/.test(iso)) {
      const num = Number(iso);
      const ms = iso.length <= 10 ? num * 1000 : num;
      date = new Date(ms);
    } else {
      date = new Date(iso);
    }
    if (Number.isNaN(date.getTime())) return "Sin fecha válida";
    return date.toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "Sin fecha válida";
  }
}

/* ============================================================
 * Table primitives (compactas, evitamos meter una lib)
 * ============================================================ */

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 14px",
        fontSize: 10,
        fontFamily: "var(--font-caption)",
        fontWeight: 600,
        letterSpacing: "1px",
        textTransform: "uppercase",
        color: "var(--color-text-tertiary)"
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return <td style={{ textAlign: align, padding: "10px 14px" }}>{children}</td>;
}
