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
  testId?: string | null;
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

interface LecturaAgente {
  generadoEn: string | null;
  modelo: string | null;
  lectura: string | null;
  verificacion?: { ahora: string | null; porque: string | null; riesgo: string | null; falta: string | null; reparos: string[] } | null;
  /** Lo que el agente DECIDIÓ hacer, y si pudo. Sin esto es un termómetro caro. */
  acciones?: Array<{ accion: string; ejecutada: boolean; detalle: string }>;
  motivo: string | null;
  tokens: { prompt: number; completion: number } | null;
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

/**
 * Colapsa vueltas consecutivas con el MISMO error, dejando una fila con el contador.
 *
 * El feed mostraba seis filas idénticas seguidas con el mismo rechazo palabra por palabra. Seis
 * copias del mismo hecho no informan seis veces: empujan fuera de la pantalla lo que sí es
 * distinto, y hacen que el operador deje de leer el feed. La cuenta se conserva (`×6`) porque
 * "pasó seis veces" sí es información — lo que sobra es repetir el texto.
 */
export function agruparRepetidos(vueltas: Vuelta[]): Vuelta[] {
  const out: Vuelta[] = [];
  for (const v of vueltas) {
    const previa = out[out.length - 1];
    const mismoError = previa && v.error && previa.error && previa.error === v.error && previa.domain !== v.domain;
    if (mismoError) {
      // Se acumula sobre la primera, que es la más reciente: el contador queda arriba.
      previa.repetidos = (previa.repetidos ?? 1) + 1;
      continue;
    }
    out.push({ ...v });
  }
  return out;
}

/**
 * Parte la lectura del agente en sus cuatro campos para mostrarla como tal.
 *
 * Tolera que falten los dos puntos: el modelo escribe "PORQUE el 75%..." tan seguido como
 * "PORQUE: el 75%...", y no vale perder el campo por puntuación. Si no reconoce el formato,
 * devuelve el texto entero bajo una etiqueta vacía en vez de esconderlo — una lectura sin formato
 * sigue siendo la lectura.
 */
function campos(texto: string): Array<[string, string]> {
  const ETIQUETAS = ["AHORA", "PORQUE", "RIESGO", "FALTA"];
  const out: Array<[string, string]> = [];
  for (const linea of texto.split("\n")) {
    // ANCLADO al inicio de línea y sensible a mayúsculas. Sin esto, una lectura en prosa que
    // contuviera "...porque el receptor no las procesa" se partía por ese "porque" del medio de la
    // frase y la pantalla mostraba un solo campo con media oración. Una etiqueta es una etiqueta
    // solo si abre la línea.
    const m = linea.match(new RegExp(`^\\s*\\*{0,2}(${ETIQUETAS.join("|")})\\*{0,2}\\s*:?\\s+(.+)$`));
    if (m) out.push([m[1]!.toLowerCase(), m[2]!.trim()]);
  }
  // Sin formato reconocible se muestra el texto entero: una lectura sin etiquetas sigue siendo la
  // lectura, y esconderla sería peor que mostrarla fea.
  return out.length > 0 ? out : [["", texto]];
}

/** Fecha y hora exactas, para el `title`. Lo relativo se lee de un vistazo; lo exacto se audita. */
function fechaExacta(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "medium" }) : iso;
}

/**
 * El buzón del nodo devuelve la fecha en formato de correo (`Mon, 03 Aug 2026 23:03:56 +0000`).
 * Mostrarla cruda, como estaba, obliga al operador a parsear un header mentalmente.
 */
function isoDeFechaCorreo(fecha: string): string {
  const t = Date.parse(fecha);
  return Number.isFinite(t) ? new Date(t).toISOString() : fecha;
}

/**
 * Cuánto pasó entre dos mensajes del hilo. Es EL dato del calentamiento: lo que distingue una
 * conversación de una ráfaga automática es que tenga separación humana. Sin esto en pantalla, el
 * operador no puede verificar de un vistazo que el hilo parezca real.
 */
export function separacionEntre(a: string, b: string): string | null {
  const ini = Date.parse(a);
  const fin = Date.parse(b);
  if (!Number.isFinite(ini) || !Number.isFinite(fin)) return null;
  // FLOOR, no round: redondear hacia arriba convertía 30 segundos en "1 min". Y más de fondo —
  // esta cifra existe para demostrar que el hilo tiene separación humana, así que nunca puede
  // exagerarla: sería halagarnos con el dato que estamos tratando de probar.
  const min = Math.floor((fin - ini) / 60_000);
  if (min < 1) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim() : `${Math.floor(h / 24)} d`;
}

/** Agrupa los eventos crudos en vueltas. La vuelta es la unidad que el operador entiende. */
export interface Vuelta {
  cycleId: string;
  /** Cuántas vueltas seguidas compartían este mismo error. `undefined` = una sola. */
  repetidos?: number;
  testId: string | null;
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
      testId: null,
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
    // El testId es la llave para traer el correo real del buzón: sin él, la vuelta no se puede abrir.
    if (e.testId) vuelta.testId = e.testId;
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

interface MensajeHilo {
  papel: "recibido" | "respuesta";
  carpeta: string;
  asunto: string;
  de: string;
  para: string;
  fecha: string;
  texto: string | null;
}
interface HiloResp {
  testId: string;
  semilla: string | null;
  mensajes: MensajeHilo[];
  /** El otro extremo: lo que volvió a NUESTRO nodo (la respuesta de la semilla). */
  enElNodo: { respuestas: Array<{ de: string; asunto: string; fecha: string; texto: string | null }>; motivo: string | null } | null;
  motivo: string | null;
}

// ── Consola ──────────────────────────────────────────────────────────────────────────────────────

export default function WarmupLive() {
  const ahora = useAhora();
  const [act, setAct] = useState<ActividadWarmup | null>(null);
  const [cap, setCap] = useState<CapFlota | null>(null);
  const [semillas, setSemillas] = useState<SemillasResp | null>(null);
  const [agente, setAgente] = useState<LecturaAgente | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nuevos = useRef<Set<string>>(new Set());
  const vistos = useRef<Set<string>>(new Set());
  const [hilo, setHilo] = useState<{ testId: string; cargando: boolean; data: HiloResp | null } | null>(null);

  /** Trae el correo REAL del buzón semilla. Caro (abre IMAP): solo cuando el operador lo pide. */
  const abrirHilo = async (testId: string, domain: string) => {
    setHilo({ testId, cargando: true, data: null });
    try {
      // fetch directo y no getJson: el borde de lectura tipa el endpoint como literal exacto, y
      // acá hace falta un query param. La ruta base sigue saliendo de READ_ENDPOINTS.
      const r = await fetch(`${READ_ENDPOINTS.warmupConversation}?testId=${encodeURIComponent(testId)}&domain=${encodeURIComponent(domain)}`, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setHilo({ testId, cargando: false, data: (await r.json()) as HiloResp });
    } catch (e) {
      setHilo({
        testId, cargando: false,
        data: { testId, semilla: null, mensajes: [], enElNodo: null, motivo: e instanceof Error ? e.message : "no se pudo leer" }
      });
    }
  };

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
    // El agente mira cada 10 min; el panel lo relee cada 60s (el JSON es barato, el modelo no).
    const leerAgente = () => void getJson<LecturaAgente>(READ_ENDPOINTS.warmupMonitor).then(setAgente).catch(() => {});
    leerAgente();
    const ta = setInterval(leerAgente, 60_000);
    const t = setInterval(() => {
      void getJson<CapFlota>(READ_ENDPOINTS.senderPoolCap).then(setCap).catch(() => {});
    }, 60_000);
    return () => {
      clearInterval(t);
      clearInterval(ta);
    };
  }, []);

  const vueltas = useMemo(() => agruparVueltas(act?.events ?? []), [act]);
  const enCurso = vueltas[0] ?? null;
  const consumido = (cap?.nodos ?? []).reduce((s, n) => s + (n.consumidoHoy ?? 0), 0);
  const tope = (cap?.nodos ?? []).reduce((s, n) => s + (n.cap ?? 0), 0);
  // EL PULSO, contra la CADENCIA REAL del daemon y no contra 10 minutos fijos.
  //
  // El daemon manda cada 4 horas: con el umbral de 10 min, el semáforo estaba gris el 99% del
  // tiempo EN OPERACIÓN SANA. Un indicador que casi siempre dice "mal" no informa nada — el
  // operador aprende a ignorarlo, y el día que de verdad esté muerto no se va a notar.
  //
  // Tres estados, porque "esperando el intervalo" y "daemon muerto" NO son lo mismo:
  //   · activo   — hubo una vuelta hace poco: se está moviendo ahora.
  //   · en pausa — dentro de la cadencia esperada: sano, esperando su turno.
  //   · frío     — pasó más de dos cadencias sin una vuelta: algo se rompió.
  const CADENCIA_MS = 4 * 60 * 60_000;
  const desdeUltima = enCurso ? ahora - Date.parse(enCurso.ultimo) : Number.POSITIVE_INFINITY;
  const pulso: "activo" | "en pausa" | "frío" =
    desdeUltima < 15 * 60_000 ? "activo" : desdeUltima < 2 * CADENCIA_MS ? "en pausa" : "frío";
  const vivo = pulso !== "frío";

  return (
    <div style={S.consola}>
      {/* ── Pulso ── */}
      <div style={S.pulso}>
        <span style={S.latido(vivo)} aria-hidden />
        <span style={S.pulsoTxt}>
          {enCurso ? (
            <>
              <b style={S.pulsoEstado(pulso)}>{pulso}</b> · última vuelta hace{" "}
              <b style={S.num}>{hace(enCurso.ultimo, ahora)}</b>
              {pulso === "frío" ? <span style={S.dim}> (más de 8 h: revisá el daemon)</span> : null}
            </>
          ) : act === null ? (
            // `act === null` = todavía no volvió la primera respuesta (o falló). No es lo mismo
            // que "no hubo vueltas", y afirmarlo sería inventar.
            "leyendo la actividad…"
          ) : (
            // "sin vueltas registradas" afirmaba algo que puede ser falso: en el primer render y
            // ante un fallo de red no sabemos si hubo vueltas, solo que no las pudimos leer.
            "todavía sin datos de actividad"
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
          {enCurso ? <Ciclo vuelta={enCurso} ahora={ahora} destacado={nuevos.current.has(enCurso.cycleId)} onVerHilo={abrirHilo} /> : <SinCiclo />}

          {hilo ? <Hilo ahora={ahora} estado={hilo} onCerrar={() => setHilo(null)} /> : null}

          {/* ── Flujo ── */}
          <div style={S.flujo}>
            {agruparRepetidos(vueltas.slice(1, 12)).slice(0, 9).map((v) => (
              <Fila key={v.cycleId} vuelta={v} ahora={ahora} nueva={nuevos.current.has(v.cycleId)} onVerHilo={abrirHilo} />
            ))}
          </div>
        </div>

        {/* ── El agente, al lado ── */}
        <Agente lectura={agente} ahora={ahora} />
      </div>
    </div>
  );
}

// ── El ciclo en curso: 4 etapas que se encienden en orden ────────────────────────────────────────

function Ciclo({ vuelta, ahora, destacado, onVerHilo }: { vuelta: Vuelta; ahora: number; destacado: boolean; onVerHilo: (t: string, d: string) => void }) {
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
        {vuelta.testId ? (
          <button type="button" style={S.verHilo} onClick={() => onVerHilo(vuelta.testId!, vuelta.domain)}>
            ver el correo
          </button>
        ) : null}
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

function Fila({ vuelta, ahora, nueva, onVerHilo }: { vuelta: Vuelta; ahora: number; nueva: boolean; onVerHilo: (t: string, d: string) => void }) {
  return (
    <div
      style={{ ...S.fila, ...(nueva ? S.filaNueva : null), cursor: vuelta.testId ? "pointer" : "default" }}
      onClick={() => vuelta.testId && onVerHilo(vuelta.testId, vuelta.domain)}
      role={vuelta.testId ? "button" : undefined}
      tabIndex={vuelta.testId ? 0 : undefined}
      onKeyDown={(ev) => { if (vuelta.testId && (ev.key === "Enter" || ev.key === " ")) onVerHilo(vuelta.testId, vuelta.domain); }}
    >
      <span style={S.filaHora}>{hace(vuelta.ultimo, ahora)}</span>
      <span style={S.filaDom}>{vuelta.domain}</span>
      <div style={S.puntos}>
        {ETAPAS.map((et) => (
          <span key={et.kind} style={S.punto(Boolean(vuelta.etapas[et.kind]))} />
        ))}
      </div>
      {vuelta.placement ? <span style={S.placement(vuelta.placement)}>{vuelta.placement}</span> : null}
      {vuelta.error ? (
        <span style={S.filaErr}>
          {vuelta.repetidos && vuelta.repetidos > 1 ? <b style={S.repetidos}>×{vuelta.repetidos}</b> : null}
          {vuelta.error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * La lectura del agente que mira el warmup, sobre el modelo local de la Mac mini.
 *
 * Lleva SIEMPRE su fecha y el modelo que la produjo: una opinión sin autor ni momento no es
 * evidencia, y una lectura de hace horas no puede parecer de ahora. Si el agente no pudo mirar, se
 * dice — nunca se muestra la anterior como si fuera fresca.
 */
function Agente({ lectura, ahora }: { lectura: LecturaAgente | null; ahora: number }) {
  const vieja = lectura?.generadoEn ? ahora - Date.parse(lectura.generadoEn) > 30 * 60_000 : false;
  return (
    <aside style={S.rail}>
      <div style={S.railHead}>
        <span style={S.latido(Boolean(lectura?.lectura) && !vieja)} aria-hidden />
        agente
        {lectura?.generadoEn ? <span style={S.agenteHace}>hace {hace(lectura.generadoEn, ahora)}</span> : null}
      </div>
      <div style={S.railBody}>
        {lectura?.lectura ? (
          <>
            {/* Las cuatro líneas se muestran como CAMPOS, no como un párrafo. El párrafo era parte
                del problema: leído como bloque, todo pesa igual y no se distingue el hecho de la
                consecuencia. Con etiquetas, el operador salta directo a RIESGO o a FALTA. */}
            {campos(lectura.lectura).map(([etiqueta, texto]) => (
              <div key={etiqueta} style={S.campo}>
                <span style={S.campoEt(etiqueta)}>{etiqueta}</span>
                <p style={S.campoTxt}>{texto}</p>
              </div>
            ))}
            {/* Los reparos de la verificación se MUESTRAN. Si la lectura no se sostiene contra los
                datos, el operador tiene que verlo junto a la lectura, no en un log. */}
            {(lectura.verificacion?.reparos ?? []).length > 0 ? (
              <div style={S.reparos}>
                ⚠ sin respaldo en los datos: {(lectura.verificacion?.reparos ?? []).join(" · ")}
              </div>
            ) : null}
            {/* LO QUE HIZO. Es la diferencia entre un agente y un termómetro: si decidió algo,
                tiene que verse acá, ejecutado o no, con su motivo. Una decisión que no se ve no
                se puede corregir. */}
            {(lectura.acciones ?? []).length > 0 ? (
              <div style={S.acciones}>
                <span style={S.campoEt("acciones")}>decidió</span>
                {(lectura.acciones ?? []).map((a, i) => (
                  <p key={i} style={S.accion(a.ejecutada)}>
                    {a.ejecutada ? "✓ " : "· "}
                    {a.detalle}
                  </p>
                ))}
              </div>
            ) : null}
            <div style={S.agentePie}>
              {lectura.modelo}
              {lectura.tokens ? ` · ${lectura.tokens.completion} tokens · costo 0` : ""}
              {vieja ? " · LECTURA VIEJA" : ""}
            </div>
          </>
        ) : (
          <p style={S.railTxt}>{lectura?.motivo ?? "leyendo…"}</p>
        )}
      </div>
    </aside>
  );
}

/**
 * El correo REAL, leído del buzón semilla. La evidencia de que el calentamiento existe.
 *
 * Dos cosas que estaban mal y hacían que la pantalla no se pudiera leer como una conversación:
 *
 *  1. NO SE VEÍA LA HORA de cada mensaje. Un hilo de calentamiento sin tiempos no demuestra nada:
 *     lo que importa es justamente que hubo ida y vuelta con separación humana. Ahora cada mensaje
 *     lleva su hora relativa, y la exacta en el title.
 *  2. EL ÚLTIMO MENSAJE SE REPETÍA. Lo que la semilla responde se ve dos veces: en sus Enviados
 *     (por IMAP) y en el buzón de nuestro nodo (por SSH), porque son los dos extremos del MISMO
 *     correo. Mostrarlos como dos mensajes distintos sugiere una conversación más larga de la que
 *     hubo. Ahora se funden: el mensaje se muestra una vez, con una marca de que además llegó al
 *     nodo — que es información valiosa (prueba la entrega de vuelta) pero no un turno más.
 */
function Hilo({
  estado,
  onCerrar,
  ahora
}: {
  estado: { testId: string; cargando: boolean; data: HiloResp | null };
  onCerrar: () => void;
  ahora: number;
}) {
  const mensajes = estado.data?.mensajes ?? [];
  const enNodo = estado.data?.enElNodo?.respuestas ?? [];

  /** Normaliza un cuerpo para comparar: los dos extremos difieren en espacios y cortes de línea. */
  const clave = (t: string | null | undefined): string => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const cuerposDelHilo = new Set(mensajes.map((m) => clave(m.texto)).filter(Boolean));

  // Solo las copias del nodo que NO son un mensaje ya mostrado. Las que sí, se marcan sobre el
  // mensaje original en vez de repetirse.
  const soloEnNodo = enNodo.filter((r) => !cuerposDelHilo.has(clave(r.texto)));
  const confirmadasEnNodo = new Set(
    enNodo.map((r) => clave(r.texto)).filter((k) => k && cuerposDelHilo.has(k))
  );

  return (
    <div style={S.hilo}>
      <div style={S.hiloTop}>
        <span style={S.hiloTit}>el correo</span>
        {estado.data?.semilla ? <span style={S.seed}>{estado.data.semilla}</span> : null}
        <span style={{ flex: 1 }} />
        {mensajes.length > 0 ? <span style={S.dim}>{mensajes.length} mensajes</span> : null}
        <button type="button" style={S.cerrar} onClick={onCerrar} aria-label="cerrar">×</button>
      </div>

      {estado.cargando ? <div style={S.dim}>abriendo el buzón…</div> : null}

      {mensajes.map((m, i) => {
        // La separación con el mensaje anterior es EL dato del calentamiento: un ida y vuelta
        // instantáneo no parece humano, y es lo primero que hay que poder verificar de un vistazo.
        const previo = i > 0 ? mensajes[i - 1] : null;
        const separacion = previo ? separacionEntre(previo.fecha, m.fecha) : null;
        return (
          <div key={i} style={S.msg}>
            {separacion ? <div style={S.separacion}>{separacion} después</div> : null}
            <div style={S.msgTop}>
              <span style={S.msgPapel(m.papel)}>{m.papel === "recibido" ? "llegó" : "respondió"}</span>
              <span style={S.msgDe}>{m.de}</span>
              <span style={S.flecha}>→</span>
              <span style={S.msgDe}>{m.para}</span>
              <span style={{ flex: 1 }} />
              <span style={S.msgHora} title={fechaExacta(m.fecha)}>
                {m.fecha ? hace(m.fecha, ahora) : "sin fecha"}
              </span>
              <span style={S.carpeta(m.carpeta)}>{m.carpeta}</span>
            </div>
            <div style={S.asunto}>{m.asunto}</div>
            {m.texto ? <pre style={S.cuerpoMsg}>{m.texto}</pre> : <span style={S.dim}>sin cuerpo legible</span>}
            {confirmadasEnNodo.has(clave(m.texto)) ? (
              <div style={S.confirmado}>✓ también llegó al buzón de nuestro nodo</div>
            ) : null}
          </div>
        );
      })}

      {estado.data?.motivo ? <div style={S.motivo}>{estado.data.motivo}</div> : null}

      {/* Solo lo que está en el nodo y NO en el hilo: una respuesta que la semilla mandó y que
          todavía no aparece del otro lado. Si se repitiera lo ya mostrado, la conversación se
          vería más larga de lo que es. */}
      {soloEnNodo.map((r, i) => (
        <div key={`n${i}`} style={S.msg}>
          <div style={S.msgTop}>
            <span style={S.msgPapel("respuesta")}>volvió al nodo</span>
            <span style={S.msgDe}>{r.de}</span>
            <span style={{ flex: 1 }} />
            <span style={S.msgHora} title={r.fecha}>{r.fecha ? hace(isoDeFechaCorreo(r.fecha), ahora) : "sin fecha"}</span>
          </div>
          <div style={S.asunto}>{r.asunto}</div>
          {r.texto ? <pre style={S.cuerpoMsg}>{r.texto}</pre> : <span style={S.dim}>sin cuerpo legible</span>}
        </div>
      ))}
      {estado.data?.enElNodo?.motivo ? <div style={S.motivo}>{estado.data.enElNodo.motivo}</div> : null}
    </div>
  );
}

// ── Estilos: pocos, con los tokens de la casa ────────────────────────────────────────────────────

// El token de la casa, NO una pila de fuentes propia. El sitio usa UNA sola familia en todos los
// roles —Inter, incluido "mono"— por decisión del 2026-07-14 (dirección Aivora): sin mezcla de
// familias. Lo que alinea los números es `font-variant-numeric: tabular-nums`, que Inter trae.
// Hardcodear ui-monospace metía una segunda tipografía en la única pantalla nueva del panel.
const MONO = "var(--font-mono)";

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
  pulsoEstado: (p: "activo" | "en pausa" | "frío") => ({
    color: p === "activo" ? "var(--color-success)" : p === "en pausa" ? "var(--color-text-secondary)" : "var(--color-critical)",
    textTransform: "uppercase" as const,
    fontSize: 10.5,
    letterSpacing: ".07em"
  }),
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
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" as const,
    color: "var(--color-text-tertiary)", fontWeight: 600,
    padding: "12px 16px", borderBottom: "1px solid var(--color-border)"
  } as const,
  agenteHace: { marginInlineStart: "auto", letterSpacing: 0, textTransform: "none" as const } as const,
  agenteTxt: {
    margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--color-text-primary)"
  } as const,
  agentePie: {
    marginTop: 10, fontSize: 10.5, color: "var(--color-text-tertiary)",
    fontFamily: MONO, wordBreak: "break-word" as const
  } as const,
  railBody: { padding: 16 } as const,
  railTxt: { fontSize: 12.5, color: "var(--color-text-secondary)", margin: 0 } as const,

  verHilo: {
    font: "inherit", fontSize: 11.5, padding: "3px 9px", borderRadius: 7, cursor: "pointer",
    border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)"
  } as const,
  hilo: {
    display: "grid", gap: 12, padding: 18, borderRadius: 16,
    background: "var(--color-surface)", border: "1px solid var(--color-accent)"
  } as const,
  hiloTop: { display: "flex", alignItems: "center", gap: 10 } as const,
  hiloTit: {
    fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" as const,
    color: "var(--color-text-tertiary)", fontWeight: 600
  } as const,
  cerrar: {
    font: "inherit", fontSize: 16, lineHeight: 1, width: 24, height: 24, cursor: "pointer",
    border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent",
    color: "var(--color-text-secondary)"
  } as const,
  msg: {
    display: "grid", gap: 6, padding: 14, borderRadius: 12,
    background: "var(--color-surface-sunken, transparent)", border: "1px solid var(--color-border)"
  } as const,
  msgTop: { display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, flexWrap: "wrap" as const } as const,
  campo: { display: "grid", gap: 3, marginBottom: 12 } as const,
  acciones: { display: "grid", gap: 4, marginBottom: 12, paddingTop: 10, borderTop: "1px solid var(--color-border)" } as const,
  accion: (hecha: boolean) => ({
    margin: 0, fontSize: 11.5, lineHeight: 1.45,
    color: hecha ? "var(--color-success)" : "var(--color-text-tertiary)"
  }),
  campoEt: (et: string) => ({
    fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase" as const, fontWeight: 600,
    color:
      et === "riesgo" ? "var(--color-warning)" : et === "falta" ? "var(--color-info, #0c7cb5)" : "var(--color-text-tertiary)"
  }),
  campoTxt: { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--color-text-secondary)" } as const,
  reparos: {
    marginBottom: 12, padding: "8px 10px", borderRadius: 8, fontSize: 11, lineHeight: 1.45,
    color: "var(--color-warning)",
    background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-warning) 26%, transparent)"
  } as const,
  repetidos: { marginRight: 6, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" as const } as const,
  msgHora: { color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" as const, cursor: "default" } as const,
  separacion: {
    fontSize: 10.5, color: "var(--color-text-tertiary)", letterSpacing: ".04em",
    padding: "0 0 6px 0", display: "flex", alignItems: "center", gap: 8
  } as const,
  confirmado: { marginTop: 8, fontSize: 11, color: "var(--color-success)" } as const,
  msgPapel: (p: string) => ({
    fontSize: 11, fontWeight: 600, borderRadius: 6, padding: "2px 7px",
    color: p === "recibido" ? "var(--color-success)" : "var(--color-warming)",
    background: p === "recibido"
      ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
      : "color-mix(in srgb, var(--color-warming) 12%, transparent)"
  }),
  msgDe: { color: "var(--color-text-secondary)", fontFamily: MONO, fontSize: 11.5 } as const,
  carpeta: (c: string) => ({
    fontSize: 11, fontFamily: MONO,
    color: /spam|junk|bulk/i.test(c) ? "var(--color-critical)" : "var(--color-text-tertiary)"
  }),
  asunto: { fontSize: 13.5, color: "var(--color-text-primary)", fontWeight: 500 } as const,
  cuerpoMsg: {
    margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--color-text-secondary)",
    fontFamily: "inherit", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const
  } as const,
  motivo: { fontSize: 12, color: "var(--color-text-tertiary)" } as const
};
