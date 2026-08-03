// La vista "En vivo" de la fábrica: alertas de flota + feed de actividad por nodo.
//
// Estilo Instantly/Postmark, medido de la fuente REAL (el mail.log de la flota), no de un tercero.
// Dos mitades, según su costo:
//   - ALERTAS: rollup barato (JSON local, sin SSH). Se refresca solo cada 30s. Es el "qué mirar".
//   - FEED por nodo: lectura VIVA por SSH bajo demanda. El operador elige un nodo y lo poletea.
//
// Fail-honest de punta a punta: un fallo de carga NO deja la pantalla en cero, deja "no pude leer".

import { useEffect, useMemo, useRef, useState } from "react";

import { Caption, Card, Eyebrow, Heading, Pill, Row } from "../../shared/ui/aivora";
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

const STATUS_COLOR: Record<ActivityEvent["status"], string> = {
  sent: "var(--color-success, #1e8e5a)",
  bounced: "var(--color-critical, #c0392b)",
  deferred: "var(--color-warning, #d97706)"
};

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

export default function ActividadEnVivo() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <AlertasFlota />
      <LimiteFisico />
      <FeedPorNodo />
    </div>
  );
}

/**
 * El consumo del límite físico por nodo. Es la contracara de la cuota: la cuota dice lo que el
 * nodo DEBERÍA poder enviar; esto dice lo que realmente entró por la puerta hoy. Cuando los dos
 * números no se parecen, alguien no está respetando el contrato — y eso es justo lo que hay que ver.
 *
 * Barato: JSON local (lo persiste la corrida de límite-físico), sin SSH. Refresca cada 60s porque
 * la fuente cambia solo cuando se corre la lectura, no en tiempo real.
 */
function LimiteFisico() {
  const [data, setData] = useState<CapFlota | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await fetch(READ_ENDPOINTS.senderPoolCap, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as CapFlota;
        // Sin este chequeo, un payload de forma inesperada revienta EN RENDER y el
        // PanelErrorBoundary se lleva puesta la pestaña entera (alertas y feed incluidos).
        if (!payload || !Array.isArray(payload.nodos)) throw new Error("respuesta con forma inesperada");
        if (!vivo) return;
        setData(payload);
        setError(null);
      } catch (cause) {
        if (vivo) setError(cause instanceof Error ? cause.message : "no se pudo leer el límite físico");
      }
    };
    void cargar();
    const t = setInterval(() => void cargar(), 60_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return (
      <Card>
        <Eyebrow>Límite físico por nodo</Eyebrow>
        <Caption>No se pudo leer: {error}</Caption>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <Eyebrow>Límite físico por nodo</Eyebrow>
        <Caption>Leyendo…</Caption>
      </Card>
    );
  }
  if (data.medidoEn === null) {
    return (
      <Card>
        <Eyebrow>Límite físico por nodo</Eyebrow>
        <Caption>
          {data.ilegible
            ? `La última lectura existe pero no se pudo leer: ${data.ilegible}`
            : "Nunca se leyó el límite de la flota."}{" "}
          Corré <code>scripts/ops/limite-fisico.ts --status</code> para poblar esta vista.
        </Caption>
      </Card>
    );
  }

  // Lo más urgente arriba: primero los que perdieron el límite, después por porcentaje consumido.
  // `cap === 0` es uso INFINITO (el nodo difiere todo), no "desconocido": si cayera en el -1 de
  // los ilegibles se hundiría al fondo mientras las alertas lo dan en el tope — dos vistas del
  // mismo hecho que no coincidirían.
  const usoDe = (n: CapNodo): number => {
    if (n.cap === null || n.consumidoHoy === null) return -1;
    return n.cap === 0 ? Number.POSITIVE_INFINITY : n.consumidoHoy / n.cap;
  };
  const ordenados = [...data.nodos].sort((a, b) => {
    if (a.cableado !== b.cableado) return a.cableado ? 1 : -1;
    return usoDe(b) - usoDe(a);
  });
  const sinLimite = data.nodos.filter((n) => !n.cableado).length;
  const enElTope = data.nodos.filter((n) => usoDe(n) >= 1).length;
  const totalHoy = data.nodos.reduce((s, n) => s + (n.consumidoHoy ?? 0), 0);
  // Los `null` NO suman 0 al titular en silencio: se cuentan y se declaran, porque "sin contador"
  // no es "no envió nada" y el número grande es el que más se lee.
  const sinContador = data.nodos.filter((n) => n.cableado && n.consumidoHoy === null).length;

  return (
    <Card>
      <Eyebrow>Límite físico por nodo</Eyebrow>
      <div style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}>
        <Heading level={1}>{totalHoy.toLocaleString("es")}</Heading>
        <Caption>
          mensajes aceptados hoy en {data.nodos.length} nodos ·{" "}
          <strong style={{ color: enElTope > 0 ? "var(--color-critical, #c0392b)" : "inherit" }}>{enElTope}</strong> en el
          tope · <strong style={{ color: sinLimite > 0 ? "var(--color-critical, #c0392b)" : "inherit" }}>{sinLimite}</strong>{" "}
          sin límite
          {sinContador > 0 ? ` · ${sinContador} sin contador (no suman al total)` : ""}
          {data.ilegibles > 0 ? ` · ${data.ilegibles} sin lectura` : ""}
          {data.omitidos ? ` · ${data.omitidos} fuera de alcance (nadie los capa)` : ""} · leído{" "}
          {new Date(data.medidoEn).toLocaleString("es")}
        </Caption>
      </div>

      <div style={{ marginTop: 12 }}>
        {ordenados.slice(0, 15).map((n) => {
          const uso = usoDe(n);
          const color =
            !n.cableado || uso >= 1
              ? "var(--color-critical, #c0392b)"
              : uso >= 0.8
                ? "var(--color-warning, #d97706)"
                : "var(--color-success, #1e8e5a)";
          return (
            <Row key={n.domain}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", fontSize: 13 }}>
                <span style={{ fontWeight: 500, minWidth: 220 }}>{n.domain}</span>
                {n.cableado ? (
                  <>
                    <div
                      aria-hidden
                      style={{
                        width: 120,
                        height: 6,
                        borderRadius: 3,
                        background: "var(--line, #e6e9ee)",
                        overflow: "hidden",
                        flexShrink: 0
                      }}
                    >
                      <div style={{ width: `${Math.min(100, Math.max(0, uso * 100))}%`, height: "100%", background: color }} />
                    </div>
                    <span style={{ color, fontVariantNumeric: "tabular-nums", minWidth: 110 }}>
                      {/* Null con motivo, nunca 0: "sin contador" no es "no envió nada". */}
                      {n.consumidoHoy === null ? "sin contador" : `${n.consumidoHoy}/${n.cap ?? "?"}`}
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--color-critical, #c0392b)" }}>SIN LÍMITE — {n.motivo}</span>
                )}
              </div>
            </Row>
          );
        })}
        {ordenados.length > 15 ? <Caption style={{ marginTop: 8 }}>… y {ordenados.length - 15} nodos más por debajo.</Caption> : null}
      </div>
    </Card>
  );
}

function AlertasFlota() {
  const [data, setData] = useState<AlertsFlota | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await fetch(READ_ENDPOINTS.senderPoolAlerts, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as AlertsFlota;
        if (!vivo) return;
        setData(payload);
        setError(null);
      } catch (cause) {
        if (vivo) setError(cause instanceof Error ? cause.message : "no se pudo leer alertas");
      }
    };
    void cargar();
    const t = setInterval(() => void cargar(), 30_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return (
      <Card>
        <Eyebrow>Alertas de flota</Eyebrow>
        <Caption>No se pudo leer: {error}</Caption>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <Eyebrow>Alertas de flota</Eyebrow>
        <Caption>Leyendo…</Caption>
      </Card>
    );
  }

  const total = data.conteos.critical + data.conteos.high + data.conteos.warning;

  return (
    <Card>
      <Eyebrow>Alertas de flota</Eyebrow>
      <div style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}>
        <Heading level={1}>{total}</Heading>
        <Caption>
          <strong style={{ color: "var(--color-critical, #c0392b)" }}>{data.conteos.critical}</strong> críticas ·{" "}
          <strong>{data.conteos.high}</strong> altas · <strong>{data.conteos.warning}</strong> avisos
          {data.medidoEn ? ` · entrega medida ${new Date(data.medidoEn).toLocaleString("es")}` : " · la flota nunca se midió"}
          {/* Son DOS corridas distintas y las alertas mezclan ambas: sin esta fecha, una lectura
              de cap vieja se leería con la credibilidad de la medición de entrega. */}
          {data.capMedidoEn
            ? ` · límite leído ${new Date(data.capMedidoEn).toLocaleString("es")}`
            : " · el límite físico nunca se leyó"}
        </Caption>
      </div>
      {data.alerts.length === 0 ? (
        <Caption style={{ marginTop: 10 }}>Sin alertas: nada que cruzó umbral, atascado ni bloqueado en la última medición.</Caption>
      ) : (
        <div style={{ marginTop: 12 }}>
          {data.alerts.map((a, i) => (
            <Row key={`${a.domain}-${a.kind}-${i}`}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", fontSize: 13 }}>
                <Pill tone={SEV_TONE[a.severity]}>{a.severity}</Pill>
                <span style={{ fontWeight: 500, minWidth: 200 }}>{a.domain}</span>
                <span style={{ color: "var(--muted, #8a94a0)" }}>{a.detail}</span>
              </div>
            </Row>
          ))}
        </div>
      )}
    </Card>
  );
}

interface InventarioNodos {
  bandejas: Array<{ domain: string; serverSlug: string | null; serverIp: string | null }>;
}

function FeedPorNodo() {
  const [alerts, setAlerts] = useState<SenderAlert[]>([]);
  const [nodos, setNodos] = useState<Map<string, { slug: string; ip: string }>>(new Map());
  const [slug, setSlug] = useState("");
  const [ip, setIp] = useState("");
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // La lectura SSH es lenta: al cambiar de nodo, una respuesta en vuelo del nodo anterior puede
  // llegar después y pisar la pantalla con eventos del nodo equivocado. El contador la descarta.
  const seq = useRef(0);

  // Los nodos con alertas son los más interesantes para bucear; se ofrecen como atajo. El
  // inventario da el dominio → slug+IP para que el chip llene el feed solo, sin pegar nada.
  useEffect(() => {
    void fetch(READ_ENDPOINTS.senderPoolAlerts, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AlertsFlota | null) => {
        if (d?.alerts) setAlerts(d.alerts);
      })
      .catch(() => {});
    void fetch(READ_ENDPOINTS.senderPoolInventory, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: InventarioNodos | null) => {
        if (!d?.bandejas) return;
        const m = new Map<string, { slug: string; ip: string }>();
        for (const b of d.bandejas) {
          if (b.serverSlug && b.serverIp) m.set(b.domain, { slug: b.serverSlug, ip: b.serverIp });
        }
        setNodos(m);
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

  // Poll cada 15s mientras hay un nodo seleccionado. La lectura viva por SSH es más cara que las
  // alertas: por eso es bajo demanda (un nodo a la vez) y no automática sobre toda la flota.
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

  return (
    <Card>
      <Eyebrow>Feed en vivo por nodo</Eyebrow>
      <Caption>Lectura viva del mail.log por SSH. Elegí un nodo (los que tienen alerta primero).</Caption>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {[...new Map(alerts.map((a) => [a.domain, a])).values()].slice(0, 12).map((a) => (
          <button
            key={a.domain}
            type="button"
            onClick={() => {
              // slug+IP salen del inventario: un clic y el feed arranca. Si el inventario no
              // conoce el nodo (sin binding), cae al comportamiento viejo: el dominio como pista.
              const nodo = nodos.get(a.domain);
              if (nodo) {
                setSlug(nodo.slug);
                setIp(nodo.ip);
              } else {
                // Sin binding: el dominio como pista, y la IP se LIMPIA — dejarla del nodo
                // anterior haría poletear por SSH el nodo equivocado etiquetado como este dominio.
                setSlug(a.domain);
                setIp("");
              }
            }}
            title={`Bucear en ${a.domain}`}
            style={{
              font: "inherit",
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 8,
              cursor: "pointer",
              border: "1px solid var(--line, #e6e9ee)",
              background:
                slug !== "" && slug === (nodos.get(a.domain)?.slug ?? a.domain)
                  ? "var(--color-warning-soft, #fef3c7)"
                  : "transparent",
              color: "inherit"
            }}
          >
            {a.domain}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="serverSlug (ej server51)"
          style={inputStyle}
        />
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="serverIp (ej 1.2.3.4)" style={inputStyle} />
        <span style={{ fontSize: 12, color: "var(--muted, #8a94a0)" }}>
          {cargando ? "leyendo…" : slug && ip ? "actualiza cada 15s" : "tocá un chip o pegá slug + IP"}
        </span>
      </div>

      {error ? (
        <Caption style={{ marginTop: 10, color: "var(--color-critical, #c0392b)" }}>{error}</Caption>
      ) : null}

      {feed && feed.status !== "ok" ? (
        <div style={{ marginTop: 10 }}>
          <Pill tone="warning">{feed.status}</Pill> <Caption>{feed.detail}</Caption>
        </div>
      ) : null}

      {feed && feed.status === "ok" ? (
        <div style={{ marginTop: 12 }}>
          <Caption>
            {feed.count} eventos recientes en <strong>{feed.serverSlug}</strong>
          </Caption>
          <div style={{ marginTop: 8 }}>
            {feed.events.length === 0 ? (
              <Caption>El mail.log actual no registra entregas ahora mismo.</Caption>
            ) : (
              feed.events
                .slice()
                .reverse()
                .map((e, i) => (
                  <Row key={`${e.queueId ?? i}-${i}`}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto auto",
                        gap: 10,
                        alignItems: "center",
                        width: "100%",
                        fontSize: 12,
                        fontVariantNumeric: "tabular-nums"
                      }}
                    >
                      <span style={{ color: "var(--muted, #8a94a0)", minWidth: 96 }}>{e.at}</span>
                      <span>
                        <span style={{ color: STATUS_COLOR[e.status], fontWeight: 500 }}>{e.status}</span>{" "}
                        <span style={{ color: "var(--muted, #8a94a0)" }}>→ {e.provider}</span>
                      </span>
                      <span style={{ color: "var(--muted, #8a94a0)" }}>{e.code ?? "—"}</span>
                      <span style={{ color: "var(--muted, #8a94a0)" }}>{e.dsn ?? ""}</span>
                    </div>
                  </Row>
                ))
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const inputStyle = {
  fontSize: 13,
  padding: "4px 8px",
  border: "1px solid var(--line, #e6e9ee)",
  borderRadius: 6,
  background: "transparent",
  color: "inherit"
} as const;
