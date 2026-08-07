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
import { ProcedenciaBadge } from "../../shared/ui/ProcedenciaBadge";
import { agruparBloqueos } from "../../shared/lib/bloqueos-receptor";
import {
  TECHO_ABSOLUTO,
  estadoDeCupo,
  medicionEsDeHoy,
  ordenarPorRiesgo,
  resumenCupo,
  usoDelCupo,
  type NodoCupo
} from "../../shared/lib/flota-cupo";

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

/** Misma forma que `NodoCupo` del módulo compartido, más el slug que solo usa esta vista. */
interface CapNodo extends NodoCupo {
  serverSlug: string;
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
  /**
   * A quién iba. Se pinta SOLO el dominio del destinatario, nunca la parte local: por estos nodos
   * pasa el correo de clientes de otro producto y publicar sus direcciones en nuestro panel es
   * peor que no mostrarlas. Pero el dominio hay que mostrarlo: sin él, el operador no puede notar
   * que los 50 eventos del feed van a terceros y ninguno a nuestras semillas.
   */
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
  cap_ilegal: "Cupo por encima del techo",
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

  const nodos: CapNodo[] = Array.isArray(cap?.nodos) ? cap.nodos : [];
  // Las cuatro cuentas viven en shared/lib/flota-cupo.ts con su test: cap 0 se evalúa antes que el
  // contador, un cap ilegal se mide contra el techo del sistema, los nulls no suman cero, y "sin
  // límite" incluye a los que nadie alcanzó.
  const resumen = resumenCupo(nodos, {
    omitidos: cap?.omitidos ?? 0,
    ilegibles: cap?.ilegibles ?? 0
  });
  // Una lectura de OTRO día no está vieja: está MAL (el contador se reinicia a medianoche UTC).
  // El KPI decía "hoy" igual. Pasa de verdad cuando la Mac se duerme y la medición vence.
  const capEsDeHoy = medicionEsDeHoy(cap?.medidoEn, new Date());
  const etiquetaConsumo = capEsDeHoy
    ? "Inyectado hoy en los nodos"
    : `Inyectado el ${cap?.medidoEn ? new Date(cap.medidoEn).toLocaleDateString("es") : "—"}`;

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

      {/* De quién es el correo que produjo TODO lo de esta pantalla. El clasificador de salud y el
          contador del policy service leen el mismo mail.log sin filtrar quién inyectó. */}
      <ProcedenciaBadge />

      {/* Los titulares. Números que se leen de un vistazo, no enterrados en una lista. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {/* El rótulo decía "Aceptados hoy por la flota" sobre 95.952 mensajes. Dos mentiras en una
            frase: (1) "aceptados" se lee como "el receptor los aceptó" y es "el nodo los admitió
            para inyectar" —el 100% de la muestra del feed de ese mismo nodo estaba en deferred—;
            (2) "de la flota" sugiere que es nuestro, y es el contador del policy service de
            Postfix en 587/465 con SASL: el warmup inyecta con `sendmail -t`, que por diseño ese
            contador NO ve. Con WARMUP_LIVE_MAX_PER_DAY=14 vueltas por día para TODA la flota,
            95.952 es aritméticamente imposible que sea nuestro. */}
        <KpiCard
          label={etiquetaConsumo}
          value={cap ? resumen.consumido.toLocaleString("es") : "—"}
          suffix={cap ? ` en ${resumen.medidos} de ${resumen.totalNodos} nodos` : undefined}
          icon={Gauge}
        />
        <KpiCard
          label="Nodos en el tope"
          value={cap ? resumen.enElTope : "—"}
          suffix={cap && resumen.frenados > 0 ? ` · ${resumen.frenados} frenados` : undefined}
          icon={Ban}
        />
        <KpiCard label="Alertas críticas" value={alerts ? alerts.conteos.critical : "—"} icon={ShieldAlert} />
        <KpiCard
          label="Nodos sin límite"
          value={cap ? resumen.sinLimite : "—"}
          suffix={cap && (cap.omitidos ?? 0) > 0 ? ` · ${cap.omitidos} fuera de alcance` : undefined}
          icon={TriangleAlert}
        />
      </div>
      <Caption>
        {cap
          ? `El primer número es TODO el correo que entró por el camino autenticado del nodo, incluido el del otro inquilino — no es volumen del warmup.${
              resumen.sinContador > 0
                ? ` ${resumen.sinContador} nodos no tienen contador del día y NO suman al total.`
                : ""
            }`
          : "Leyendo el cupo de la flota…"}
      </Caption>

      <Semillas />
      <BloqueosPorReceptor alerts={alerts?.alerts ?? []} />
      <LimiteFisico data={cap} error={errCap} nodos={nodos} sinContador={resumen.sinContador} />
      <AlertasFlota data={alerts} error={errAlerts} />
      <FeedPorNodo alerts={alerts?.alerts ?? []} />
    </div>
  );
}

// ── Semillas ─────────────────────────────────────────────────────────────────────────────────────

interface SemillaPublica {
  address: string;
  provider: string;
  enabled: boolean;
  auth: string;
  mide: boolean;
  verifiedAt: string | null;
  notes: string | null;
}

interface SemillasResponse {
  existeRegistro: boolean;
  seeds: SemillaPublica[];
  destinos: number;
  midiendo: number;
  cobertura: Record<string, number>;
  puntoCiego: string[];
}

const PAPEL_SEMILLA: Record<string, string> = {
  none: "solo destino",
  imap_password: "mide (IMAP)",
  gmail_oauth: "mide (OAuth)"
};

/**
 * Las bandejas nuestras en los proveedores contra las que la fábrica calienta sus dominios.
 *
 * Lo que esta tarjeta tiene que dejar clarísimo es la diferencia entre DESTINO y MEDICIÓN: una
 * semilla sin credencial recibe correo, pero no puede decir si cayó en inbox o en spam. Contarlas
 * juntas daría la sensación de cobertura que no tenemos.
 */
function Semillas() {
  const { data, error } = useLectura<SemillasResponse>(READ_ENDPOINTS.warmupSeeds, 60_000);

  if (error) return <Aviso titulo="Semillas del warmup" texto={`No se pudo leer: ${error}`} />;
  if (!data) return <Aviso titulo="Semillas del warmup" texto="Leyendo…" />;
  if (!data.existeRegistro) {
    return (
      <Aviso
        titulo="Semillas del warmup"
        texto="No hay registro todavía. Agregá la primera con: scripts/ops/semillas.ts --add --address=… --provider=gmail"
      />
    );
  }

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <Eyebrow>Semillas del warmup</Eyebrow>
          <Caption style={{ marginTop: 4 }}>
            Bandejas nuestras en los proveedores. Se agregan a mano con <code>scripts/ops/semillas.ts</code>.
          </Caption>
        </div>
        <Caption>
          <strong>{data.destinos}</strong> destinos · <strong>{data.midiendo}</strong> pueden medir placement
        </Caption>
      </div>

      <DataTable
        headers={["Dirección", "Proveedor", "Papel", "Estado"]}
        align={["left", "left", "left", "left"]}
        rows={data.seeds.map((s) => [
          <span style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{s.address}</span>,
          s.provider,
          // El papel sale de `mide`, no de `auth`: una semilla APAGADA con auth gmail_oauth
          // mostraba igual "mide (OAuth)" y lo único que la diferenciaba era el color gris. El
          // color no puede ser el único portador de un hecho.
          <span style={{ color: s.mide ? "var(--color-success)" : "var(--color-text-tertiary)" }}>
            {s.mide ? (PAPEL_SEMILLA[s.auth] ?? s.auth) : s.enabled ? "solo destino" : "no mide (apagada)"}
          </span>,
          !s.enabled ? (
            <Pill tone="neutral">apagada</Pill>
          ) : s.auth === "none" ? (
            // No se marca "sin verificar": una solo-destino no se verifica nunca y sería una
            // alarma falsa permanente.
            <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
          ) : s.verifiedAt ? (
            <span style={{ color: "var(--color-success)" }}>verificada</span>
          ) : (
            <Pill tone="warning">sin verificar</Pill>
          )
        ])}
      />

      {data.puntoCiego.length > 0 ? (
        <Caption style={{ marginTop: 12, color: "var(--color-warning)" }}>
          Punto ciego: sin semilla que mida en {data.puntoCiego.join(", ")} — ahí no sabemos dónde cae el correo.
        </Caption>
      ) : null}
    </Card>
  );
}

// ── Bloqueos por receptor ────────────────────────────────────────────────────────────────────────

/**
 * Los receptores que nos cierran la puerta, agrupados por familia.
 *
 * El agrupamiento (y su test) vive en shared/lib/bloqueos-receptor.ts: la lista tenía 3 familias y
 * lo que no caía en ninguna DESAPARECÍA en silencio — de 35 bandejas cerradas los grupos sumaban
 * 34 bajo un encabezado que decía 35, y la que faltaba era la de Microsoft, que la tarjeta de
 * semillas de esta misma pantalla declara punto ciego.
 */
function BloqueosPorReceptor({ alerts }: { alerts: SenderAlert[] }) {
  const bloqueadas = alerts.filter((a) => a.kind === "bloqueada");
  if (bloqueadas.length === 0) return null;

  const grupos = agruparBloqueos(bloqueadas);
  if (grupos.length === 0) return null;

  return (
    <Card style={{ padding: 20 }}>
      <Eyebrow>Bloqueos por receptor</Eyebrow>
      <Caption style={{ marginTop: 4 }}>
        {bloqueadas.length} bandejas cerradas, agrupadas por quién cierra: cada familia se arregla distinto.
      </Caption>
      {/* El veredicto "cerrada" sale de un grep sobre mail.log sin filtrar quién inyectó. */}
      <div style={{ marginTop: 6 }}>
        <ProcedenciaBadge />
      </div>

      <div style={{ marginTop: 12 }}>
        {grupos.map((g) => (
          <details key={g.nombre} style={{ borderTop: "1px solid var(--color-border)" }}>
            <summary style={{ cursor: "pointer", padding: "11px 2px", display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
              <Pill tone={g.recuperable ? "warning" : "critical"}>{g.afectados.length}</Pill>
              <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{g.nombre}</span>
              {g.recuperable ? <Pill tone="success">tiene trámite</Pill> : null}
            </summary>
            <div style={{ paddingBottom: 10 }}>
              <Caption style={{ marginBottom: 8 }}>{g.accion}</Caption>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {g.afectados.map((d) => (
                  <span
                    key={d}
                    style={{
                      fontSize: 12,
                      padding: "3px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-secondary)"
                    }}
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}

// ── Límite físico ────────────────────────────────────────────────────────────────────────────────

function LimiteFisico({
  data,
  error,
  nodos,
  sinContador
}: {
  data: CapFlota | null;
  error: string | null;
  nodos: CapNodo[];
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

  // Orden por RIESGO, no por porcentaje: lo ilegal y lo frenado arriba, lo no medible abajo.
  const ordenados = ordenarPorRiesgo(nodos) as CapNodo[];
  const visibles = verTodos ? ordenados : ordenados.slice(0, 10);

  const filas = visibles.map((n) => {
    const estado = estadoDeCupo(n);
    const uso = usoDelCupo(n);
    // Un cap por encima del techo del sistema es CRÍTICO aunque el porcentaje dé bajo: con la
    // barra midiendo contra el propio cap ilegal, 11.065/15000 daba 0,74 y el nodo se pintaba
    // verde mientras la tarjeta de alertas de esta misma pantalla lo marcaba cap_ilegal/critical.
    const color =
      estado === "ilegal" || estado === "frenado" || estado === "sin_limite" || (uso !== null && uso >= 1)
        ? "var(--color-critical)"
        : uso !== null && uso >= 0.8
          ? "var(--color-warning)"
          : uso === null
            ? "var(--color-text-tertiary)"
            : "var(--color-success)";
    const barra = (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 90, maxWidth: 180, height: 6, borderRadius: 3, background: "var(--color-border)", overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, Math.max(0, (uso ?? 0) * 100))}%`, height: "100%", background: color }} />
        </div>
      </div>
    );
    return [
      <span style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{n.domain}</span>,
      estado === "sin_limite" ? (
        <Pill tone="critical">sin límite</Pill>
      ) : estado === "frenado" ? (
        <Pill tone="critical">frenado: difiere todo</Pill>
      ) : estado === "ilegal" ? (
        <Pill tone="critical">cap {n.cap} sobre el techo {TECHO_ABSOLUTO}</Pill>
      ) : (
        barra
      ),
      // Null con motivo, nunca 0: "sin contador" NO es "no envió nada".
      estado === "sin_limite" ? (
        <span style={{ color: "var(--color-critical)" }}>{n.motivo}</span>
      ) : (
        <span style={{ color, fontWeight: 500 }}>
          {n.consumidoHoy === null ? "sin contador" : `${n.consumidoHoy.toLocaleString("es")} / ${n.cap ?? "?"}`}
        </span>
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
          <div style={{ marginTop: 6 }}>
            <ProcedenciaBadge />
          </div>
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

/** El dominio del destinatario, sin la parte local. `""` si no hay arroba. */
function dominioDe(recipient: string): string {
  const i = recipient.lastIndexOf("@");
  return i >= 0 ? `@${recipient.slice(i + 1)}` : "—";
}

function FeedPorNodo({ alerts }: { alerts: SenderAlert[] }) {
  const [nodosInv, setNodosInv] = useState<Map<string, { slug: string; ip: string }>>(new Map());
  const [errorInv, setErrorInv] = useState<string | null>(null);
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
        setErrorInv(null);
      })
      // El catch estaba VACÍO en un archivo cuyo encabezado promete "un fallo de carga NO deja la
      // pantalla en cero, deja 'no pude leer'". Sin inventario, cada chip caía al fallback
      // slug=dominio/ip="" y el clic no llamaba a nada: el chip se iluminaba como seleccionado,
      // no aparecía error, y la leyenda seguía diciendo "tocá un chip".
      .catch((e: unknown) => setErrorInv(e instanceof Error ? e.message : "no se pudo leer el inventario"));
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
      {/* El comando hace grep de status=(sent|bounced|deferred) SIN filtro de emisor y el evento
          normalizado no trae origen, así que este feed no puede distinguir nuestro correo del del
          otro inquilino — y hasta que exista la separación por queue-id ↔ sasl_username, la
          pantalla tiene que decirlo. Comprobado en vivo sobre corpannualinfra.com: 50/50 eventos
          deferred hacia dominios de terceros en 23 segundos, ninguno a nuestras semillas. */}
      <div style={{ marginTop: 8 }}>
        <Pill tone="warning">
          este feed es TODO el correo del nodo, no solo el del warmup
        </Pill>
      </div>

      {errorInv ? (
        <Caption style={{ marginTop: 10, color: "var(--color-critical)" }}>
          No pude leer el inventario ({errorInv}): los chips no resuelven a nodo. Pegá slug + IP a mano.
        </Caption>
      ) : null}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {conAlerta.map((a) => {
          const nodo = nodosInv.get(a.domain);
          // Sin IP el clic no dispara nada: el chip no puede marcarse activo como si lo hubiera.
          const activo = slug !== "" && ip !== "" && slug === (nodo?.slug ?? a.domain);
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
                headers={["Momento", "Estado", "Destino", "Proveedor", "Código", "DSN"]}
                align={["left", "left", "left", "left", "right", "right"]}
                rows={feed.events
                  .slice()
                  .reverse()
                  .map((e) => [
                    <span style={{ color: "var(--color-text-tertiary)" }}>{e.at}</span>,
                    <span style={{ color: STATUS_COLOR[e.status], fontWeight: 500 }}>{e.status}</span>,
                    // Solo el dominio del destinatario: sin esta columna el operador no podía
                    // notar que los 50 eventos iban a terceros. Con la parte local sería publicar
                    // direcciones de clientes de otro producto en nuestro panel.
                    <span style={{ color: "var(--color-text-secondary)" }}>{dominioDe(e.recipient)}</span>,
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
