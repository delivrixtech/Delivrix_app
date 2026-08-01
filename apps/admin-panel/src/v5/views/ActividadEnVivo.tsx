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

export default function ActividadEnVivo() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <AlertasFlota />
      <FeedPorNodo />
    </div>
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
          {data.medidoEn ? ` · medido ${new Date(data.medidoEn).toLocaleString("es")}` : " · la flota nunca se midió"}
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

function FeedPorNodo() {
  const [alerts, setAlerts] = useState<SenderAlert[]>([]);
  const [slug, setSlug] = useState("");
  const [ip, setIp] = useState("");
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Los nodos con alertas son los más interesantes para bucear; se ofrecen como atajo.
  useEffect(() => {
    void fetch(READ_ENDPOINTS.senderPoolAlerts, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AlertsFlota | null) => {
        if (d?.alerts) setAlerts(d.alerts);
      })
      .catch(() => {});
  }, []);

  const cargarFeed = useMemo(
    () => async (s: string, i: string) => {
      if (!s || !i) return;
      setCargando(true);
      try {
        const url = `${READ_ENDPOINTS.senderPoolActivity}?serverSlug=${encodeURIComponent(s)}&serverIp=${encodeURIComponent(i)}&limit=50`;
        const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setFeed((await r.json()) as ActivityFeed);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "no se pudo leer el nodo");
      } finally {
        setCargando(false);
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
              // El feed necesita slug+ip; el operador los pega, o se derivan del inventario en un
              // slice futuro. Por ahora el atajo prefila el dominio como pista.
              setSlug(a.domain);
            }}
            title={`Bucear en ${a.domain}`}
            style={{
              font: "inherit",
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 8,
              cursor: "pointer",
              border: "1px solid var(--line, #e6e9ee)",
              background: slug === a.domain ? "var(--color-warning-soft, #fef3c7)" : "transparent",
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
          {cargando ? "leyendo…" : slug && ip ? "actualiza cada 15s" : "pegá slug + IP del nodo"}
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
