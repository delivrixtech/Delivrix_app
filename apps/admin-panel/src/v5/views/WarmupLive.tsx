// CONSOLA EN VIVO del warmup. Se mira, no se lee.
//
// Reemplaza el póster explicativo por una sala de control: el ciclo que está pasando ahora, el
// flujo de eventos entrando, y el pulso de la flota. Casi sin prosa — si algo necesita un párrafo
// para entenderse, está mal diseñado, no mal explicado.
//
// Qué se mueve de verdad acá (y por qué, porque "en vivo" no puede ser decorativo):
//   · el reloj del último evento, que corre cada segundo;
//   · las etapas del ciclo, que se encienden en orden a medida que ocurren;
//   · el flujo de eventos, que entra por arriba;
//   · el consumo del cupo de la flota.
// El warmup hace 3 vueltas por día: no hay animación permanente que fingir. Lo que late es el
// tiempo desde el último hecho real, que es justamente el dato que dice si esto sigue vivo.

import { useEffect, useMemo, useRef, useState } from "react";

import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";

// ── Contratos (los que ya sirven los endpoints) ─────────────────────────────────────────────────

interface EventoWarmup {
  id: string;
  occurredAt: string;
  cycleId: string;
  nodeDomain: string;
  seedInbox: string;
  kind: "sent" | "measured" | "engaged" | "replied" | "error";
  placement: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
}

interface ActividadWarmup {
  generatedAt: string;
  events: EventoWarmup[];
  note?: string;
}

interface CapFlota {
  medidoEn: string | null;
  nodos: Array<{ domain: string; cap: number | null; consumidoHoy: number | null; cableado: boolean }>;
}

interface SemillasResp {
  destinos: number;
  midiendo: number;
  puntoCiego: string[];
}

/** Las 4 etapas de una vuelta, en orden. El orden ES la información. */
const ETAPAS = [
  { kind: "sent", label: "envío" },
  { kind: "measured", label: "medición" },
  { kind: "engaged", label: "señal" },
  { kind: "replied", label: "respuesta" }
] as const;

const POLL_MS = 4000;

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────────

/** Reloj vivo: el "hace X" tiene que correr solo, si no la pantalla parece congelada. */
function useAhora(intervaloMs = 1000): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return ahora;
}

function hace(iso: string, ahora: number): string {
  const s = Math.max(0, Math.round((ahora - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Agrupa los eventos crudos en vueltas. La vuelta es la unidad que el operador entiende. */
export interface Vuelta {
  cycleId: string;
  domain: string;
  seed: string;
  subject: string | null;
  etapas: Record<string, EventoWarmup | undefined>;
  placement: string | null;
  error: string | null;
  ultimo: string;
}

export function agruparVueltas(events: EventoWarmup[]): Vuelta[] {
  const mapa = new Map<string, Vuelta>();
  for (const e of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const previa = mapa.get(e.cycleId);
    const vuelta: Vuelta = previa ?? {
      cycleId: e.cycleId,
      domain: e.nodeDomain,
      seed: e.seedInbox,
      subject: e.subject,
      etapas: {},
      placement: null,
      error: null,
      ultimo: e.occurredAt
    };
    vuelta.etapas[e.kind] = e;
    vuelta.ultimo = e.occurredAt;
    if (e.placement) vuelta.placement = e.placement;
    // El motivo del corte se muestra: el `detail` traía el error y la vista anterior lo tiraba.
    if (e.kind === "error") {
      const d = e.detail as { note?: string; stage?: string };
      vuelta.error = [d?.stage, d?.note].filter(Boolean).join(": ") || "error";
    }
    mapa.set(e.cycleId, vuelta);
  }
  return [...mapa.values()].sort((a, b) => b.ultimo.localeCompare(a.ultimo));
}

// ── Consola ──────────────────────────────────────────────────────────────────────────────────────

export default function WarmupLive() {
  const ahora = useAhora();
  const [act, setAct] = useState<ActividadWarmup | null>(null);
  const [cap, setCap] = useState<CapFlota | null>(null);
  const [semillas, setSemillas] = useState<SemillasResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nuevos = useRef<Set<string>>(new Set());
  const vistos = useRef<Set<string>>(new Set());

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const a = await getJson<ActividadWarmup>(READ_ENDPOINTS.warmupActivity);
        if (!vivo) return;
        // Marca los ciclos recién aparecidos para resaltarlos al entrar.
        for (const e of a.events ?? []) {
          if (!vistos.current.has(e.id)) {
            if (vistos.current.size > 0) nuevos.current.add(e.cycleId);
            vistos.current.add(e.id);
          }
        }
        setAct(a);
        setError(null);
      } catch (e) {
        if (vivo) setError(e instanceof Error ? e.message : "sin conexión");
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    void getJson<CapFlota>(READ_ENDPOINTS.senderPoolCap).then(setCap).catch(() => {});
    void getJson<SemillasResp>(READ_ENDPOINTS.warmupSeeds).then(setSemillas).catch(() => {});
    const t = setInterval(() => {
      void getJson<CapFlota>(READ_ENDPOINTS.senderPoolCap).then(setCap).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const vueltas = useMemo(() => agruparVueltas(act?.events ?? []), [act]);
  const enCurso = vueltas[0] ?? null;
  const consumido = (cap?.nodos ?? []).reduce((s, n) => s + (n.consumidoHoy ?? 0), 0);
  const tope = (cap?.nodos ?? []).reduce((s, n) => s + (n.cap ?? 0), 0);
  const vivo = enCurso ? ahora - Date.parse(enCurso.ultimo) < 10 * 60_000 : false;

  return (
    <div style={S.consola}>
      {/* ── Pulso ── */}
      <div style={S.pulso}>
        <span style={S.latido(vivo)} aria-hidden />
        <span style={S.pulsoTxt}>
          {enCurso ? (
            <>
              última vuelta hace <b style={S.num}>{hace(enCurso.ultimo, ahora)}</b>
            </>
          ) : (
            "sin vueltas registradas"
          )}
        </span>
        <span style={S.sep} />
        <span style={S.pulsoTxt}>
          flota <b style={S.num}>{consumido.toLocaleString("es")}</b>
          <span style={S.dim}> / {tope.toLocaleString("es")} hoy</span>
        </span>
        <span style={S.sep} />
        <span style={S.pulsoTxt}>
          semillas <b style={S.num}>{semillas?.midiendo ?? "—"}</b>
          <span style={S.dim}> miden de {semillas?.destinos ?? "—"}</span>
        </span>
        {error ? <span style={{ ...S.pulsoTxt, color: "var(--color-critical)" }}>· {error}</span> : null}
      </div>

      <div style={S.cuerpo}>
        <div style={S.principal}>
          {/* ── El ciclo ── */}
          {enCurso ? <Ciclo vuelta={enCurso} ahora={ahora} destacado={nuevos.current.has(enCurso.cycleId)} /> : <SinCiclo />}

          {/* ── Flujo ── */}
          <div style={S.flujo}>
            {vueltas.slice(1, 9).map((v) => (
              <Fila key={v.cycleId} vuelta={v} ahora={ahora} nueva={nuevos.current.has(v.cycleId)} />
            ))}
          </div>
        </div>

        {/* ── El agente, al lado ── */}
        <aside style={S.rail}>
          <div style={S.railHead}>agente</div>
          <div style={S.railBody}>
            <p style={S.railTxt}>El chat del agente vive en el botón “Preguntar a Delivrix”, arriba a la derecha.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── El ciclo en curso: 4 etapas que se encienden en orden ────────────────────────────────────────

function Ciclo({ vuelta, ahora, destacado }: { vuelta: Vuelta; ahora: number; destacado: boolean }) {
  const alcanzada = (kind: string) => Boolean(vuelta.etapas[kind]);
  const completa = alcanzada("replied");

  return (
    <div style={{ ...S.ciclo, ...(destacado ? S.cicloNuevo : null) }}>
      <div style={S.cicloTop}>
        <span style={S.dominio}>{vuelta.domain}</span>
        <span style={S.flecha}>→</span>
        <span style={S.seed}>{vuelta.seed}</span>
        <span style={{ flex: 1 }} />
        {vuelta.placement ? (
          <span style={S.placement(vuelta.placement)}>{vuelta.placement}</span>
        ) : null}
        <span style={S.hace}>{hace(vuelta.ultimo, ahora)}</span>
      </div>

      <div style={S.pista}>
        {ETAPAS.map((et, i) => {
          const on = alcanzada(et.kind);
          const cortoAca = !on && Boolean(vuelta.error) && ETAPAS.slice(0, i).every((p) => alcanzada(p.kind));
          return (
            <div key={et.kind} style={S.etapa}>
              <div style={S.nodo(on, cortoAca)} aria-label={`${et.label}: ${on ? "ok" : cortoAca ? "cortó" : "pendiente"}`} />
              <span style={S.etapaTxt(on, cortoAca)}>{et.label}</span>
              {i < ETAPAS.length - 1 ? <div style={S.riel(alcanzada(ETAPAS[i + 1]!.kind))} /> : null}
            </div>
          );
        })}
      </div>

      {vuelta.error ? <div style={S.error}>{vuelta.error}</div> : null}
      {completa && !vuelta.error ? <div style={S.ok}>vuelta completa</div> : null}
    </div>
  );
}

function SinCiclo() {
  return (
    <div style={{ ...S.ciclo, alignItems: "center", justifyContent: "center", minHeight: 150 }}>
      <span style={S.dim}>sin vueltas todavía</span>
    </div>
  );
}

// ── Fila del flujo ───────────────────────────────────────────────────────────────────────────────

function Fila({ vuelta, ahora, nueva }: { vuelta: Vuelta; ahora: number; nueva: boolean }) {
  return (
    <div style={{ ...S.fila, ...(nueva ? S.filaNueva : null) }}>
      <span style={S.filaHora}>{hace(vuelta.ultimo, ahora)}</span>
      <span style={S.filaDom}>{vuelta.domain}</span>
      <div style={S.puntos}>
        {ETAPAS.map((et) => (
          <span key={et.kind} style={S.punto(Boolean(vuelta.etapas[et.kind]))} />
        ))}
      </div>
      {vuelta.placement ? <span style={S.placement(vuelta.placement)}>{vuelta.placement}</span> : null}
      {vuelta.error ? <span style={S.filaErr}>{vuelta.error}</span> : null}
    </div>
  );
}

// ── Estilos: pocos, con los tokens de la casa ────────────────────────────────────────────────────

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const S = {
  consola: { display: "grid", gap: 14 } as const,

  pulso: {
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const,
    padding: "10px 16px", borderRadius: 12,
    background: "var(--color-surface)", border: "1px solid var(--color-border)"
  },
  latido: (vivo: boolean) => ({
    width: 8, height: 8, borderRadius: "50%", flex: "none",
    background: vivo ? "var(--color-success)" : "var(--color-text-tertiary)",
    boxShadow: vivo ? "0 0 0 4px color-mix(in srgb, var(--color-success) 18%, transparent)" : "none"
  }),
  pulsoTxt: { fontSize: 12.5, color: "var(--color-text-secondary)" } as const,
  num: { color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" } as const,
  dim: { color: "var(--color-text-tertiary)" } as const,
  sep: { width: 1, height: 14, background: "var(--color-border)" } as const,

  cuerpo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", gap: 14, alignItems: "start" } as const,
  principal: { display: "grid", gap: 14, minWidth: 0 } as const,

  ciclo: {
    display: "flex", flexDirection: "column" as const, gap: 18,
    padding: 22, borderRadius: 18,
    background: "var(--color-surface)", border: "1px solid var(--color-border)",
    transition: "border-color .4s ease"
  },
  cicloNuevo: { borderColor: "var(--color-accent)" } as const,

  cicloTop: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const, fontSize: 13 } as const,
  dominio: { color: "var(--color-text-primary)", fontWeight: 600 } as const,
  flecha: { color: "var(--color-text-tertiary)" } as const,
  seed: { color: "var(--color-text-secondary)", fontFamily: MONO, fontSize: 12 } as const,
  hace: { color: "var(--color-text-tertiary)", fontSize: 12, fontVariantNumeric: "tabular-nums" } as const,

  pista: { display: "flex", alignItems: "center", gap: 0 } as const,
  etapa: { display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 } as const,
  nodo: (on: boolean, corto: boolean) => ({
    width: 11, height: 11, borderRadius: "50%", flex: "none",
    background: corto ? "var(--color-critical)" : on ? "var(--color-success)" : "var(--color-border)",
    boxShadow: on ? "0 0 0 4px color-mix(in srgb, var(--color-success) 14%, transparent)" : "none",
    transition: "background .35s ease, box-shadow .35s ease"
  }),
  etapaTxt: (on: boolean, corto: boolean) => ({
    fontSize: 12,
    color: corto ? "var(--color-critical)" : on ? "var(--color-text-primary)" : "var(--color-text-tertiary)"
  }),
  riel: (on: boolean) => ({
    flex: 1, height: 2, borderRadius: 1, marginInline: 8, minWidth: 12,
    background: on ? "var(--color-success)" : "var(--color-border)",
    transition: "background .5s ease"
  }),

  placement: (p: string) => ({
    fontSize: 11.5, fontWeight: 600, borderRadius: 7, padding: "3px 8px",
    color: p === "INBOX" ? "var(--color-success)" : "var(--color-critical)",
    background:
      p === "INBOX"
        ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
        : "color-mix(in srgb, var(--color-critical) 12%, transparent)"
  }),
  error: { fontSize: 12, color: "var(--color-critical)", fontFamily: MONO } as const,
  ok: { fontSize: 12, color: "var(--color-success)" } as const,

  flujo: { display: "grid", gap: 1, borderRadius: 12, overflow: "hidden", border: "1px solid var(--color-border)" } as const,
  fila: {
    display: "flex", alignItems: "center", gap: 12, padding: "9px 14px",
    background: "var(--color-surface)", fontSize: 12.5,
    transition: "background .6s ease"
  } as const,
  filaNueva: { background: "color-mix(in srgb, var(--color-accent) 7%, var(--color-surface))" } as const,
  filaHora: { color: "var(--color-text-tertiary)", width: 38, fontVariantNumeric: "tabular-nums", flex: "none" } as const,
  filaDom: { color: "var(--color-text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } as const,
  filaErr: { color: "var(--color-critical)", fontSize: 11.5, fontFamily: MONO } as const,

  puntos: { display: "flex", gap: 4, flex: "none" } as const,
  punto: (on: boolean) => ({
    width: 7, height: 7, borderRadius: "50%",
    background: on ? "var(--color-success)" : "var(--color-border)"
  }),

  rail: {
    borderRadius: 18, border: "1px solid var(--color-border)",
    background: "var(--color-surface)", overflow: "hidden", position: "sticky" as const, top: 12
  } as const,
  railHead: {
    fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" as const,
    color: "var(--color-text-tertiary)", fontWeight: 600,
    padding: "12px 16px", borderBottom: "1px solid var(--color-border)"
  } as const,
  railBody: { padding: 16 } as const,
  railTxt: { fontSize: 12.5, color: "var(--color-text-secondary)", margin: 0 } as const
};
