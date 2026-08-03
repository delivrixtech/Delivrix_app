// La vista "En vivo" de la fábrica: qué está pasando AHORA en la flota.
//
// Tres capas, ordenadas por lo que el operador necesita primero:
//   1. TITULARES (KPI): cuánto entró hoy, cuántos nodos frenados, qué es crítico.
//   2. LÍMITE FÍSICO por nodo: el cupo diario y cuánto se consumió (tabla, no lista suelta).
//   3. ALERTAS agrupadas por tipo: 50+ filas planas eran ilegibles; agrupadas son 6 renglones
//      que se abren si te interesan.
//   4. FEED por nodo: lectura viva del mail.log por SSH, bajo demanda.
//
// Costos distintos por capa: KPI/límite/alertas son JSON local (baratos, refrescan solos); el feed
// es SSH y va bajo demanda. Fail-honest en todas: un fallo de carga NO deja la pantalla en cero,
// deja "no pude leer".

import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Gauge, ShieldAlert, TriangleAlert } from "lucide-react";

import { Caption, Card, DataTable, Eyebrow, KpiCard, Pill, Row, SectionHead } from "../../shared/ui/aivora";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";

type AlertSeverity = "critical" | "high" | "warning";

interface SenderAlert {
  domain: string;
  severity: AlertSeverity;
  kind: string;
  detail: string;
}

interface AlertsFlota {
  medidoEn: string | null;
  capMedidoEn: string | null;
  conteos: Record<AlertSeverity, number>;
  alerts: SenderAlert[];
  parcial: boolean;
}

interface CapNodo {
  domain: string;
  serverSlug: string;
  cap: number | null;
  consumidoHoy: number | null;
  cableado: boolean;
  motivo: string | null;
}

interface CapFlota {
  medidoEn: string | null;
  nodos: CapNodo[];
  ilegibles: number;
  omitidos?: number;
  /** El archivo existe pero no se pudo leer: distinto de "nunca se corrió". */
  ilegible?: string | null;
}

interface ActivityEvent {
  at: string;
  queueId: string | null;
  recipient: string;
  provider: string;
  status: "sent" | "bounced" | "deferred";
  code: string | null;
  dsn: string | null;
  relay: string | null;
}

interface ActivityFeed {
  serverSlug: string;
  status: "ok" | "no_access" | "unreadable";
  detail?: string;
  count?: number;
  events: ActivityEvent[];
}

const SEV_TONE: Record<AlertSeverity, "critical" | "warning" | "neutral"> = {
  critical: "critical",
  high: "warning",
  warning: "neutral"
};

/** El `kind` técnico no se le muestra al operador: cada uno tiene su nombre en castellano. */
const KIND_LABEL: Record<string, string> = {
  umbral_cruzado: "Cruzó el umbral permanente",
  cap_alcanzado: "Tocó el cupo diario",
  cerca_del_cap: "Cerca del cupo diario",
  sin_limite_fisico: "Sin límite físico",
  bloqueada: "Cerrada en el receptor",
  cola_atascada: "Cola atascada",
  rampa_pausada: "Warmup auto-pausado",
  sin_lectura: "Nodo incomunicado",
  rechazo_parcial: "Rechazo parcial",
  cerca_umbral: "Cerca del umbral permanente"
};

const STATUS_COLOR: Record<ActivityEvent["status"], string> = {
  sent: "var(--color-success)",
  bounced: "var(--color-critical)",
  deferred: "var(--color-warning)"
};

/** Hook de lectura con refresco. Fail-honest: el error se devuelve, no se traga. */
function useLectura<T>(url: string, refrescoMs: number): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as T;
        if (!vivo) return;
        setData(payload);
        setError(null);
      } catch (cause) {
        if (vivo) setError(cause instanceof Error ? cause.message : "no se pudo leer");
      }
    };
    void cargar();
    const t = setInterval(() => void cargar(), refrescoMs);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [url, refrescoMs]);
  return { data, error };
}

const fecha = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("es") : "nunca");

export default function ActividadEnVivo() {
  const { data: alerts, error: errAlerts } = useLectura<AlertsFlota>(READ_ENDPOINTS.senderPoolAlerts, 30_000);
  const { data: cap, error: errCap } = useLectura<CapFlota>(READ_ENDPOINTS.senderPoolCap, 60_000);

  const nodos = Array.isArray(cap?.nodos) ? cap.nodos : [];
  // `cap === 0` es uso INFINITO (difiere todo), no "desconocido": si cayera en el -1 de los
  // ilegibles se hundiría al fondo mientras las alertas lo dan en el tope.
  const usoDe = (n: CapNodo): number => {
    if (n.cap === null || n.consumidoHoy === null) return -1;
    return n.cap === 0 ? Number.POSITIVE_INFINITY : n.consumidoHoy / n.cap;
  };
  const totalHoy = nodos.reduce((s, n) => s + (n.consumidoHoy ?? 0), 0);
  const enElTope = nodos.filter((n) => usoDe(n) >= 1).length;
  const sinLimite = nodos.filter((n) => !n.cableado).length;
  const sinContador = nodos.filter((n) => n.cableado && n.consumidoHoy === null).length;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <SectionHead
        eyebrow="Monitoreo en vivo"
        title="Todo lo que está pasando."
        subtitle={
          <>
            Entrega medida {fecha(alerts?.medidoEn ?? null)} · límite físico leído{" "}
            {fecha(cap?.medidoEn ?? null)}. Las dos son corridas distintas.
          </>
        }
      />

      {/* Los titulares. Números que se leen de un vistazo, no enterrados en una lista. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label="Aceptados hoy por la flota"
          value={cap ? totalHoy.toLocaleString("es") : "—"}
          icon={Gauge}
        />
        <KpiCard label="Nodos en el tope" value={cap ? enElTope : "—"} icon={Ban} />
        <KpiCard label="Alertas críticas" value={alerts ? alerts.conteos.critical : "—"} icon={ShieldAlert} />
        <KpiCard label="Nodos sin límite" value={cap ? sinLimite : "—"} icon={TriangleAlert} />
      </div>

      <LimiteFisico data={cap} error={errCap} nodos={nodos} usoDe={usoDe} sinContador={sinContador} />
      <AlertasFlota data={alerts} error={errAlerts} />
      <FeedPorNodo alerts={alerts?.alerts ?? []} />
    </div>
  );
}

// ── Límite físico ────────────────────────────────────────────────────────────────────────────────

function LimiteFisico({
  data,
  error,
  nodos,
  usoDe,
  sinContador
}: {
  data: CapFlota | null;
  error: string | null;
  nodos: CapNodo[];
  usoDe: (n: CapNodo) => number;
  sinContador: number;
}) {
  const [verTodos, setVerTodos] = useState(false);

  if (error) return <Aviso titulo="Límite físico por nodo" texto={`No se pudo leer: ${error}`} />;
  if (!data) return <Aviso titulo="Límite físico por nodo" texto="Leyendo…" />;
  if (data.medidoEn === null) {
    return (
      <Aviso
        titulo="Límite físico por nodo"
        texto={
          data.ilegible
            ? `La última lectura existe pero no se pudo leer: ${data.ilegible}. Volvé a correr scripts/ops/limite-fisico.ts --status`
            : "Nunca se leyó el límite de la flota. Corré scripts/ops/limite-fisico.ts --status para poblar esta vista."
        }
      />
    );
  }

  const ordenados = [...nodos].sort((a, b) => {
    if (a.cableado !== b.cableado) return a.cableado ? 1 : -1;
    return usoDe(b) - usoDe(a);
  });
  const visibles = verTodos ? ordenados : ordenados.slice(0, 10);

  const filas = visibles.map((n) => {
    const uso = usoDe(n);
    const color =
      !n.cableado || uso >= 1
        ? "var(--color-critical)"
        : uso >= 0.8
          ? "var(--color-warning)"
          : "var(--color-success)";
    return [
      <span style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{n.domain}</span>,
      n.cableado ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 90, maxWidth: 180, height: 6, borderRadius: 3, background: "var(--color-border)", overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, Math.max(0, uso * 100))}%`, height: "100%", background: color }} />
          </div>
        </div>
      ) : (
        <Pill tone="critical">sin límite</Pill>
      ),
      // Null con motivo, nunca 0: "sin contador" NO es "no envió nada".
      n.cableado ? (
        <span style={{ color, fontWeight: 500 }}>
          {n.consumidoHoy === null ? "sin contador" : `${n.consumidoHoy.toLocaleString("es")} / ${n.cap ?? "?"}`}
        </span>
      ) : (
        <span style={{ color: "var(--color-critical)" }}>{n.motivo}</span>
      )
    ];
  });

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <Eyebrow>Límite físico por nodo</Eyebrow>
          <Caption style={{ marginTop: 4 }}>
            Cupo diario aplicado en el Postfix de cada nodo. Se reinicia a medianoche UTC.
          </Caption>
        </div>
        <Caption>
          {nodos.length} nodos
          {sinContador > 0 ? ` · ${sinContador} sin contador (no suman al total)` : ""}
          {data.ilegibles > 0 ? ` · ${data.ilegibles} sin lectura` : ""}
          {data.omitidos ? ` · ${data.omitidos} fuera de alcance (nadie los capa)` : ""}
        </Caption>
      </div>

      <DataTable headers={["Dominio", "Uso del cupo", "Hoy / cupo"]} rows={filas} align={["left", "left", "right"]} />

      {ordenados.length > 10 ? (
        <button
          type="button"
          onClick={() => setVerTodos((v) => !v)}
          style={{
            marginTop: 12,
            font: "inherit",
            fontSize: 12.5,
            padding: "6px 12px",
            borderRadius: 8,
            cursor: "pointer",
            border: "1px solid var(--color-border)",
            background: "transparent",
            color: "var(--color-text-secondary)"
          }}
        >
          {verTodos ? "Mostrar solo los 10 más cargados" : `Ver los ${ordenados.length} nodos`}
        </button>
      ) : null}
    </Card>
  );
}

// ── Alertas ──────────────────────────────────────────────────────────────────────────────────────

function AlertasFlota({ data, error }: { data: AlertsFlota | null; error: string | null }) {
  if (error) return <Aviso titulo="Alertas de flota" texto={`No se pudo leer: ${error}`} />;
  if (!data) return <Aviso titulo="Alertas de flota" texto="Leyendo…" />;

  const total = data.conteos.critical + data.conteos.high + data.conteos.warning;
  if (total === 0) {
    return <Aviso titulo="Alertas de flota" texto="Sin alertas: nada cruzado, atascado ni bloqueado en la última medición." />;
  }

  // Agrupar por tipo es lo que vuelve la lista legible: 52 filas planas no se leen; 6 grupos con
  // su conteo, sí — y el detalle se abre solo si te interesa (<details> nativo, sin estado).
  const grupos = new Map<string, SenderAlert[]>();
  for (const a of data.alerts) {
    const previo = grupos.get(a.kind);
    if (previo) previo.push(a);
    else grupos.set(a.kind, [a]);
  }
  const ordenSeveridad: Record<AlertSeverity, number> = { critical: 0, high: 1, warning: 2 };
  const ordenados = [...grupos.entries()].sort((a, b) => {
    const sa = ordenSeveridad[a[1][0]!.severity];
    const sb = ordenSeveridad[b[1][0]!.severity];
    return sa !== sb ? sa - sb : b[1].length - a[1].length;
  });

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div>
          <Eyebrow>Alertas de flota</Eyebrow>
          <Caption style={{ marginTop: 4 }}>Lo que necesita acción, agrupado por tipo. Tocá un grupo para ver los dominios.</Caption>
        </div>
        <Caption>
          <strong style={{ color: "var(--color-critical)" }}>{data.conteos.critical}</strong> críticas ·{" "}
          <strong>{data.conteos.high}</strong> altas · <strong>{data.conteos.warning}</strong> avisos
          {data.parcial ? " · lectura parcial" : ""}
        </Caption>
      </div>

      <div style={{ marginTop: 10 }}>
        {ordenados.map(([kind, items]) => {
          const sev = items[0]!.severity;
          // Lo crítico arranca ABIERTO: es irreversible y no puede depender de un clic.
          return (
            <details key={kind} open={sev === "critical"} style={{ borderTop: "1px solid var(--color-border)" }}>
              <summary
                style={{
                  cursor: "pointer",
                  padding: "11px 2px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13.5,
                  color: "var(--color-text-primary)"
                }}
              >
                <Pill tone={SEV_TONE[sev]}>{items.length}</Pill>
                <span style={{ fontWeight: 500 }}>{KIND_LABEL[kind] ?? kind}</span>
                <span style={{ color: "var(--color-text-tertiary)", fontSize: 12.5 }}>
                  {items
                    .slice(0, 3)
                    .map((i) => i.domain)
                    .join(", ")}
                  {items.length > 3 ? ` y ${items.length - 3} más` : ""}
                </span>
              </summary>
              <div style={{ paddingBottom: 8 }}>
                {items.map((a, i) => (
                  <Row key={`${a.domain}-${i}`} last={i === items.length - 1}>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 260px) 1fr", gap: 14, width: "100%", fontSize: 12.5, alignItems: "baseline" }}>
                      <span style={{ color: "var(--color-text-primary)" }}>{a.domain}</span>
                      <span style={{ color: "var(--color-text-secondary)" }}>{a.detail}</span>
                    </div>
                  </Row>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </Card>
  );
}

// ── Feed por nodo (SSH, bajo demanda) ────────────────────────────────────────────────────────────

function FeedPorNodo({ alerts }: { alerts: SenderAlert[] }) {
  const [nodosInv, setNodosInv] = useState<Map<string, { slug: string; ip: string }>>(new Map());
  const [slug, setSlug] = useState("");
  const [ip, setIp] = useState("");
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // La lectura SSH es lenta: al cambiar de nodo, una respuesta en vuelo del anterior puede llegar
  // después y pisar la pantalla con eventos del nodo equivocado. El contador la descarta.
  const seq = useRef(0);

  useEffect(() => {
    void fetch(READ_ENDPOINTS.senderPoolInventory, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { bandejas?: Array<{ domain: string; serverSlug: string | null; serverIp: string | null }> } | null) => {
        if (!d?.bandejas) return;
        const m = new Map<string, { slug: string; ip: string }>();
        for (const b of d.bandejas) if (b.serverSlug && b.serverIp) m.set(b.domain, { slug: b.serverSlug, ip: b.serverIp });
        setNodosInv(m);
      })
      .catch(() => {});
  }, []);

  const cargarFeed = useMemo(
    () => async (s: string, i: string) => {
      if (!s || !i) return;
      const mio = ++seq.current;
      setCargando(true);
      try {
        const url = `${READ_ENDPOINTS.senderPoolActivity}?serverSlug=${encodeURIComponent(s)}&serverIp=${encodeURIComponent(i)}&limit=50`;
        const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as ActivityFeed;
        if (seq.current !== mio) return;
        setFeed(payload);
        setError(null);
      } catch (cause) {
        if (seq.current === mio) setError(cause instanceof Error ? cause.message : "no se pudo leer el nodo");
      } finally {
        if (seq.current === mio) setCargando(false);
      }
    },
    []
  );

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (slug && ip) {
      void cargarFeed(slug, ip);
      timer.current = setInterval(() => void cargarFeed(slug, ip), 15_000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [slug, ip, cargarFeed]);

  const conAlerta = [...new Map(alerts.map((a) => [a.domain, a])).values()].slice(0, 10);

  return (
    <Card style={{ padding: 20 }}>
      <Eyebrow>Feed en vivo por nodo</Eyebrow>
      <Caption style={{ marginTop: 4 }}>
        Lectura viva del mail.log por SSH (más cara que lo de arriba: un nodo a la vez, refresca cada 15s).
      </Caption>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {conAlerta.map((a) => {
          const nodo = nodosInv.get(a.domain);
          const activo = slug !== "" && slug === (nodo?.slug ?? a.domain);
          return (
            <button
              key={a.domain}
              type="button"
              onClick={() => {
                // slug+IP salen del inventario: un clic y arranca. Si no está, cae al dominio como
                // pista y LIMPIA la IP (si no, poletearía el nodo anterior con esta etiqueta).
                if (nodo) {
                  setSlug(nodo.slug);
                  setIp(nodo.ip);
                } else {
                  setSlug(a.domain);
                  setIp("");
                }
              }}
              style={{
                font: "inherit",
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 8,
                cursor: "pointer",
                border: `1px solid ${activo ? "var(--color-accent)" : "var(--color-border)"}`,
                background: activo ? "var(--color-accent-soft, transparent)" : "transparent",
                color: "var(--color-text-secondary)"
              }}
            >
              {a.domain}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="serverSlug (ej server51)" style={inputStyle} />
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="serverIp (ej 1.2.3.4)" style={inputStyle} />
        <Caption>{cargando ? "leyendo…" : slug && ip ? "actualiza cada 15s" : "tocá un chip o pegá slug + IP"}</Caption>
      </div>

      {error ? <Caption style={{ marginTop: 10, color: "var(--color-critical)" }}>{error}</Caption> : null}

      {feed && feed.status !== "ok" ? (
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <Pill tone="warning">{feed.status}</Pill>
          <Caption>{feed.detail}</Caption>
        </div>
      ) : null}

      {feed && feed.status === "ok" ? (
        <div style={{ marginTop: 14 }}>
          <Caption>
            {feed.count} eventos recientes en <strong>{feed.serverSlug}</strong>
          </Caption>
          <div style={{ marginTop: 8 }}>
            {feed.events.length === 0 ? (
              <Caption>El mail.log actual no registra entregas ahora mismo.</Caption>
            ) : (
              <DataTable
                headers={["Momento", "Estado", "Proveedor", "Código", "DSN"]}
                align={["left", "left", "left", "right", "right"]}
                rows={feed.events
                  .slice()
                  .reverse()
                  .map((e) => [
                    <span style={{ color: "var(--color-text-tertiary)" }}>{e.at}</span>,
                    <span style={{ color: STATUS_COLOR[e.status], fontWeight: 500 }}>{e.status}</span>,
                    e.provider,
                    e.code ?? "—",
                    e.dsn ?? ""
                  ])}
              />
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Aviso({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <Card style={{ padding: 20 }}>
      <Eyebrow>{titulo}</Eyebrow>
      <Caption style={{ marginTop: 6 }}>{texto}</Caption>
    </Card>
  );
}

const inputStyle = {
  fontSize: 13,
  padding: "6px 10px",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  background: "transparent",
  color: "inherit"
} as const;
