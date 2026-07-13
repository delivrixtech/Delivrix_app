/**
 * Warmup Onboard Selector — capa de selección masiva sobre los dominios del Sender Pool (fuente única).
 *
 * El operador ve un acordeón ordenado reciente→antiguo (mismo orden + divisor de 24h que SenderPool),
 * marca varios dominios con checkbox y dispara `Calentar seleccionados` → POST /v1/mailboxes:onboard-batch.
 * Como el onboard es idempotente por email, re-calentar es seguro (queda 'exists', no duplica ni resetea).
 *
 * El email del buzón a calentar = el mailer del dominio (smtpCredential.username). Los dominios sin mailer
 * resoluble (sin credencial SMTP) se muestran pero NO son seleccionables: no hay buzón que calentar todavía.
 *
 * Cruza con GET /v1/mailboxes: los dominios cuyo mailer YA es un nodo de warmup se marcan `en warmup` con
 * su estado (blocked/fresh/warm/paused) y quedan fuera de la selección por defecto (re-seleccionar es opt-in).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Flame, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  listWarmupMailboxes,
  postWarmupMailboxBatch,
  type WarmupBatchInput,
  type WarmupBatchResult,
  type WarmupMailboxState
} from "../../shared/api/warmup-mailboxes-client";
import {
  Badge,
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  MonoData,
  Pill,
  type PillProps,
  SectionHead
} from "../components/primitives";
import { useToast } from "../../shared/ui/v2";

type PillTone = NonNullable<PillProps["tone"]>;

/**
 * Forma mínima del dominio que necesita el selector (subconjunto estructural del DomainSummary del
 * SenderPool). Se acepta por estructura para no acoplar los dos módulos.
 */
export interface SelectorDomain {
  domain: string;
  status: string;
  registeredAt?: string | null;
  smtpCredential?: {
    host?: string | null;
    username?: string | null;
    createdAt?: string;
  } | null;
}

/** Fila materializada del selector: dominio + su mailer + estado de warmup cruzado. */
export interface SelectorRow {
  domain: string;
  status: string;
  /** email del buzón a calentar (mailer). null ⇒ no hay credencial ⇒ no seleccionable. */
  email: string | null;
  smtpHost: string | null;
  /** estado del nodo si el mailer YA está en warmup; null si todavía no. */
  warmupState: WarmupMailboxState | null;
  selectable: boolean;
}

/**
 * Resuelve el mailer (email del buzón) de un dominio: es el username de su credencial SMTP si parece
 * un email. Sin credencial resoluble ⇒ null (no hay buzón que calentar).
 */
export function resolveMailerEmail(d: SelectorDomain): string | null {
  const username = d.smtpCredential?.username;
  if (typeof username === "string" && username.includes("@")) {
    return username.trim().toLowerCase();
  }
  return null;
}

/**
 * Materializa una fila del selector cruzando el dominio con el índice de buzones en warmup (por email
 * en minúsculas). `warmupByEmail` mapea email→estado del nodo vivo.
 */
export function buildSelectorRow(
  d: SelectorDomain,
  warmupByEmail: Map<string, WarmupMailboxState>
): SelectorRow {
  const email = resolveMailerEmail(d);
  const warmupState = email ? warmupByEmail.get(email) ?? null : null;
  return {
    domain: d.domain,
    status: d.status,
    email,
    smtpHost: d.smtpCredential?.host ?? null,
    warmupState,
    selectable: email !== null
  };
}

/**
 * Emails elegibles para una acción "seleccionar todos": seleccionables y, salvo `includeInWarmup`,
 * los que todavía NO están en warmup (re-calentar es opt-in). Devuelve emails únicos en minúsculas.
 */
export function selectableEmails(
  rows: SelectorRow[],
  opts: { includeInWarmup?: boolean } = {}
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.selectable || !r.email) continue;
    if (!opts.includeInWarmup && r.warmupState !== null) continue;
    out.add(r.email);
  }
  return [...out];
}

/**
 * Construye el payload del batch a partir de los emails seleccionados. Deriva el domain de cada mailer
 * (parte tras la @) para que el backend no dependa de otro lookup. Ignora emails sin fila conocida.
 */
export function buildBatchInput(
  selected: Iterable<string>,
  rows: SelectorRow[],
  actorId?: string
): WarmupBatchInput {
  const rowByEmail = new Map(rows.filter((r) => r.email).map((r) => [r.email as string, r]));
  const mailboxes: WarmupBatchInput["mailboxes"] = [];
  const seen = new Set<string>();
  for (const email of selected) {
    if (seen.has(email)) continue;
    seen.add(email);
    if (!rowByEmail.has(email)) continue;
    const domain = email.slice(email.indexOf("@") + 1);
    mailboxes.push(domain ? { email, domain } : { email });
  }
  return actorId ? { mailboxes, actorId } : { mailboxes };
}

/** Índice email→estado desde la lista de buzones de warmup. */
function indexWarmup(
  mailboxes: Array<{ email: string; state: WarmupMailboxState }>
): Map<string, WarmupMailboxState> {
  const map = new Map<string, WarmupMailboxState>();
  for (const m of mailboxes) {
    if (m.email) map.set(m.email.toLowerCase(), m.state);
  }
  return map;
}

function warmupStateTone(state: WarmupMailboxState): PillTone {
  switch (state) {
    case "warm":
      return "success";
    case "fresh":
      return "warning";
    case "paused":
    case "quarantined":
    case "blocked":
      return "critical";
    default:
      return "neutral";
  }
}

const WARMUP_POLL_MS = 20_000;

/**
 * Panel del selector. Recibe los dominios YA particionados por SenderPool (reciente→antiguo + divisor
 * 24h) para preservar la fuente única de orden. `recent`/`rest` son las dos mitades del pool.
 */
export function WarmupOnboardSelector({
  recent,
  rest
}: {
  recent: SelectorDomain[];
  rest: SelectorDomain[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [lastResult, setLastResult] = useState<WarmupBatchResult | null>(null);

  const warmupQuery = useQuery({
    queryKey: ["warmup", "mailboxes", "list"],
    queryFn: listWarmupMailboxes,
    refetchInterval: WARMUP_POLL_MS,
    staleTime: WARMUP_POLL_MS / 2,
    retry: false
  });

  const warmupByEmail = useMemo(
    () => indexWarmup(warmupQuery.data?.mailboxes ?? []),
    [warmupQuery.data]
  );

  const recentRows = useMemo(
    () => recent.map((d) => buildSelectorRow(d, warmupByEmail)),
    [recent, warmupByEmail]
  );
  const restRows = useMemo(
    () => rest.map((d) => buildSelectorRow(d, warmupByEmail)),
    [rest, warmupByEmail]
  );
  const allRows = useMemo(() => [...recentRows, ...restRows], [recentRows, restRows]);

  const selectableTotal = useMemo(
    () => allRows.filter((r) => r.selectable).length,
    [allRows]
  );

  const batch = useMutation({
    mutationFn: (input: WarmupBatchInput) => postWarmupMailboxBatch(input),
    onSuccess: (result) => {
      setLastResult(result);
      const { created, existed, failed } = result.summary;
      if (failed > 0) {
        toast.error("Warmup masivo con fallos", {
          description: `${created} nuevos · ${existed} ya estaban · ${failed} fallidos.`
        });
      } else {
        toast.success("Buzones al warmup", {
          description: `${created} nuevos · ${existed} ya estaban · sin fallos.`
        });
      }
      // Refresca la lista de warmup para que las marcas 'en warmup' se actualicen.
      queryClient.invalidateQueries({ queryKey: ["warmup", "mailboxes", "list"] });
      // Deselecciona los que se onboardearon bien (created/exists) para evitar re-disparos accidentales.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of result.results) {
          if (r.status !== "failed") next.delete(r.email);
        }
        return next;
      });
    },
    onError: (error) => {
      toast.error("No se pudo calentar", {
        description: error instanceof Error ? error.message : "Revisá gateway / WARMUP_API_KEY."
      });
    }
  });

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function toggleExpand(domain: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  function selectRecent() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const email of selectableEmails(recentRows)) next.add(email);
      return next;
    });
  }

  function selectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const email of selectableEmails(allRows)) next.add(email);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function submit() {
    const input = buildBatchInput(selected, allRows, "operator/sender-pool");
    if (input.mailboxes.length === 0) return;
    batch.mutate(input);
  }

  const selectedCount = selected.size;

  if (selectableTotal === 0) {
    return (
      <Card tone="quiet" padding="relaxed" className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-subtle">
          <Flame size={15} strokeWidth={1.75} />
        </div>
        <div className="flex flex-col gap-1">
          <Eyebrow>Calentar buzones</Eyebrow>
          <BodySm className="text-fg-subtle">
            Ningún dominio tiene todavía un mailer SMTP resoluble. Generá la credencial de un dominio y
            aparecerá acá seleccionable para el warmup masivo.
          </BodySm>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="relaxed" className="flex flex-col gap-4">
      <SectionHead
        eyebrow="Warmup masivo"
        title="Calentar buzones del Sender Pool"
        caption={
          warmupQuery.isError
            ? "No se pudo leer el estado de warmup · igual podés seleccionar"
            : `${selectableTotal} con mailer · ${selectedCount} seleccionados`
        }
        count={selectedCount}
        countTone={selectedCount > 0 ? "success" : "neutral"}
        trailing={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={selectRecent} disabled={recentRows.length === 0}>
              Recientes
            </Button>
            <Button variant="ghost" size="sm" onClick={selectAll}>
              Todos
            </Button>
            {selectedCount > 0 ? (
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Limpiar
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-col gap-2">
        {recentRows.length > 0 ? (
          <>
            <Eyebrow className="text-[9.5px]">Recién creados · últimas 24h</Eyebrow>
            {recentRows.map((r) => (
              <SelectorRowView
                key={r.domain}
                row={r}
                hot
                checked={r.email ? selected.has(r.email) : false}
                open={expanded.has(r.domain)}
                onToggleCheck={() => r.email && toggle(r.email)}
                onToggleOpen={() => toggleExpand(r.domain)}
              />
            ))}
          </>
        ) : null}
        {recentRows.length > 0 && restRows.length > 0 ? (
          <Eyebrow className="mt-1 text-[9.5px]">Resto del pool</Eyebrow>
        ) : null}
        {restRows.map((r) => (
          <SelectorRowView
            key={r.domain}
            row={r}
            checked={r.email ? selected.has(r.email) : false}
            open={expanded.has(r.domain)}
            onToggleCheck={() => r.email && toggle(r.email)}
            onToggleOpen={() => toggleExpand(r.domain)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Caption>
          {selectedCount === 0
            ? "Marcá uno o varios dominios para calentarlos de una."
            : `${selectedCount} buzón${selectedCount === 1 ? "" : "es"} listos para el warmup.`}
        </Caption>
        <Button
          variant="primary"
          size="md"
          onClick={submit}
          disabled={selectedCount === 0 || batch.isPending}
        >
          <Flame size={13} strokeWidth={1.75} />
          {batch.isPending ? "Calentando…" : "Calentar seleccionados"}
        </Button>
      </div>

      {lastResult ? <BatchResultSummary result={lastResult} /> : null}
    </Card>
  );
}

/* ----- Fila (acordeón) ----- */

function SelectorRowView({
  row,
  hot = false,
  checked,
  open,
  onToggleCheck,
  onToggleOpen
}: {
  row: SelectorRow;
  hot?: boolean;
  checked: boolean;
  open: boolean;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
}) {
  const inWarmup = row.warmupState !== null;
  return (
    <Card
      padding="default"
      className="flex flex-col gap-2"
      style={
        hot
          ? {
              boxShadow: "inset 0 0 0 1px var(--color-warning-border)",
              background: "var(--color-warning-soft)"
            }
          : undefined
      }
    >
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          className="size-4 shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          style={{ accentColor: "var(--color-accent)" }}
          checked={checked}
          disabled={!row.selectable}
          onChange={onToggleCheck}
          aria-label={`Seleccionar ${row.domain} para warmup`}
          title={row.selectable ? "Seleccionar para warmup" : "Sin credencial SMTP · no hay buzón que calentar"}
        />
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-fg-subtle transition-transform duration-150"
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          />
          <MonoData className="truncate text-[13px]">{row.domain}</MonoData>
          {inWarmup ? (
            <Badge className="shrink-0" style={{ background: "var(--color-surface-sunken)" }}>
              en warmup
            </Badge>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {inWarmup && row.warmupState ? (
            <Pill tone={warmupStateTone(row.warmupState)} size="sm">
              {row.warmupState}
            </Pill>
          ) : null}
          <Pill tone="neutral" size="sm">
            {row.status}
          </Pill>
        </div>
      </div>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-border pl-7 pt-2">
          <DetailLine label="Mailer">
            {row.email ? (
              <MonoData className="text-[12px]">{row.email}</MonoData>
            ) : (
              <Caption className="flex items-center gap-1 text-warning">
                <AlertTriangle size={10} strokeWidth={1.75} />
                sin credencial SMTP · generá el mailer primero
              </Caption>
            )}
          </DetailLine>
          <DetailLine label="SMTP host">
            {row.smtpHost ? <MonoData className="text-[12px]">{row.smtpHost}</MonoData> : <Caption>—</Caption>}
          </DetailLine>
          <DetailLine label="Warmup">
            {inWarmup && row.warmupState ? (
              <span className="flex items-center gap-1 text-[12px]">
                <CheckCircle2 size={11} className="text-success" strokeWidth={1.75} />
                <span>nodo {row.warmupState}</span>
              </span>
            ) : (
              <Caption>sin nodo · re-calentar es seguro (idempotente)</Caption>
            )}
          </DetailLine>
        </div>
      ) : null}
    </Card>
  );
}

function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Eyebrow className="w-20 shrink-0 text-[9px]">{label}</Eyebrow>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ----- Resumen del resultado del batch ----- */

function BatchResultSummary({ result }: { result: WarmupBatchResult }) {
  const { requested, created, existed, failed } = result.summary;
  const failedRows = result.results.filter((r) => r.status === "failed");
  return (
    <Card tone="quiet" padding="default" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Eyebrow>Último batch</Eyebrow>
        <Caption>{requested} solicitados</Caption>
        <Pill tone="success" size="sm">
          {created} nuevos
        </Pill>
        <Pill tone="neutral" size="sm">
          {existed} ya estaban
        </Pill>
        {failed > 0 ? (
          <Pill tone="critical" size="sm">
            {failed} fallidos
          </Pill>
        ) : null}
      </div>
      {failedRows.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {failedRows.slice(0, 5).map((r) => (
            <li key={r.email} className="flex items-center gap-2 text-[11px]">
              <AlertTriangle size={10} className="shrink-0 text-critical" strokeWidth={1.75} />
              <MonoData className="truncate text-[11px]">{r.email}</MonoData>
              <Caption className="truncate text-[10px]">{r.error ?? "fallo desconocido"}</Caption>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
