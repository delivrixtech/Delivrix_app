// La pantalla de la fabrica: una lista, tres columnas, un numero editable.
//
// DOMINIO · ESTADO · HOY PUEDE. Ese numero es el producto — es lo que NFC consume por
// GET /v1/sender-pool/quota. El semaforo se calcula en el gateway, no se elige aca: verde solo
// si se midio y entrega, y una bandeja roja o gris vende 0 con el motivo al lado.
//
// Version 2 tras la revision del owner sobre la v1: demasiado texto, poco practica. Un panel de
// operacion muestra, no explica: se fueron los bloques explicativos y quedo la decision que el
// operador toma por bandeja — cuanto le dejo enviar hoy.
//
// La regla de honestidad sigue intacta: un dato no medido es un guion CON MOTIVO, nunca un cero.
// Las invisibles y los conflictos no son filas: son una linea al pie que se despliega.

import { useEffect, useRef, useState } from "react";

import { Caption, Card, Eyebrow, Heading, Pill, Row } from "../../shared/ui/aivora";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";
import { ProcedenciaBadge, type Atribucion } from "../../shared/ui/ProcedenciaBadge";

type SemaforoColor = "verde" | "rojo" | "gris" | "calentando";

interface RampaCuota {
  estado: "running" | "paused" | "auto_paused";
  pauseReason?: string;
  cupoHoy: number;
  dia: number;
  totalDias: number;
  schedule: string;
}

interface CuotaBandeja {
  domain: string;
  serverSlug: string | null;
  color: SemaforoColor;
  estado: string;
  motivo: string | null;
  asignada: number | null;
  hoyPuede: number;
  editable: boolean;
  edadDias: number | null;
  cruzados: string[];
  cerca: string[];
  rampa: RampaCuota | null;
  /**
   * El "nodo vivo pero incomunicado": la medición corrió y no pudo leer el nodo.
   *
   * Viaja aparte del estado a propósito y el backend lo dice textual: una rampa corriendo TAPA el
   * estado "sin lectura" en el semáforo, y un nodo incomunicado que está calentando es justo el
   * que más urge mirar. La vista ni lo declaraba: el día que un nodo se quede incomunicado
   * mientras calienta, se veía en cyan como si todo anduviera.
   */
  sinLectura?: { motivo: string } | null;
  /**
   * Tamaño de la muestra sobre la que se emitió el veredicto. Opcional porque hoy el endpoint no
   * lo manda: cuando falta, la fila lo DICE en vez de que un verde de 3 mensajes se vea igual que
   * uno de 20.000. El clasificador exige 20 intentos para animarse a decir "bloqueada" pero
   * "healthy" es el fallthrough final: con 1 entrega ya es verde y habilita cuota hasta 2.000/día.
   */
  entregados?: number | null;
  rechazados?: number | null;
  /** De quién es el correo que produjo el veredicto (lote A). Ausente = no declarada. */
  atribucion?: Atribucion | null;
}

/** Lo que se usa de GET /v1/sender-pool/cap: el techo que Postfix aplica de verdad en el nodo. */
interface CapNodo {
  domain: string;
  cap: number | null;
  consumidoHoy: number | null;
  cableado: boolean;
}
interface CapFlota {
  medidoEn: string | null;
  nodos: CapNodo[];
}

interface CuotaFlota {
  medidoEn: string | null;
  techoDiario: number;
  bandejas: CuotaBandeja[];
  totalBandejas: number;
  totalHoyPuede: number;
  fueraDeMedicion: string[];
  enConflicto: string[];
  parcial: boolean;
  motivosParcial: string[];
}

const COLOR: Record<SemaforoColor, string> = {
  verde: "var(--color-success, #1e8e5a)",
  rojo: "var(--color-critical, #c0392b)",
  gris: "var(--muted, #8a94a0)",
  // Paleta oficial: warming es cyan, nunca ámbar.
  calentando: "var(--color-warming, #0891b2)"
};

// El binding (nodo) y la edad entran a la grilla: sin el nodo no se puede ver que 11 de 13
// bandejas del mismo /24 están caídas por la misma subred, que es el patrón que ya nos mordió.
const GRID = "1.5fr 0.9fr 1.3fr 0.9fr";

/**
 * A las cuántas horas una medición deja de servir para decidir.
 *
 * El resto del sistema usa 12h (y /v1/warmup/plan ya devuelve `medicionCupo.vencida`). Acá la
 * fecha se mostraba sin marca de vencimiento y el operador tenía que hacer la resta mental
 * mientras la pantalla seguía pintando verdes y rojos con la misma tinta.
 */
const MEDICION_VENCE_HORAS = 12;

export default function InventarioBandejas() {
  const [flota, setFlota] = useState<CuotaFlota | null>(null);
  const [cap, setCap] = useState<CapFlota | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    try {
      const response = await fetch(READ_ENDPOINTS.senderPoolQuota, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setFlota((await response.json()) as CuotaFlota);
      setError(null);
    } catch (cause) {
      // Un fallo de carga NO deja la pantalla en cero: la deja en "no pude leer".
      setError(cause instanceof Error ? cause.message : "no se pudo leer la cuota");
    }
    // El cupo FÍSICO del nodo, que es el que manda. El titular decía "200 envíos/día en venta"
    // sobre un nodo con cap de Postfix 20/día (medido 2026-08-06 20:59, 8 ya consumidos): 10× lo
    // que el nodo deja pasar. La medición que lo contradice vivía en el mismo workspace y nunca
    // se cruzaba. Si esta lectura falla, la celda lo dice — no se asume el techo de política.
    try {
      const r = await fetch(READ_ENDPOINTS.senderPoolCap, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCap((await r.json()) as CapFlota);
      setCapError(null);
    } catch (cause) {
      setCapError(cause instanceof Error ? cause.message : "no se pudo leer el cupo físico");
    }
  };

  /** El techo real de hoy para una bandeja: `null` = el cupo físico no se pudo medir. */
  const topeFisico = (domain: string): number | null => {
    const nodo = cap?.nodos.find((n) => n.domain === domain);
    if (!nodo || !nodo.cableado || nodo.cap === null) return null;
    if (nodo.consumidoHoy === null) return nodo.cap;
    return Math.max(0, nodo.cap - nodo.consumidoHoy);
  };

  useEffect(() => {
    void cargar();
    const timer = setInterval(() => void cargar(), 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <Card>
        <Eyebrow>Fábrica</Eyebrow>
        <Heading level={2}>No se pudo leer la cuota</Heading>
        <Caption>{error}</Caption>
      </Card>
    );
  }

  if (!flota) {
    return (
      <Card>
        <Eyebrow>Fábrica</Eyebrow>
        <Caption>Leyendo…</Caption>
      </Card>
    );
  }

  // El titular ya no es la suma de la política: es la suma de lo que los nodos DEJAN pasar hoy.
  // Las bandejas cuyo cupo físico no se pudo medir no se suman con su número de política: se
  // cuentan aparte y se declaran, porque asumirlas sería volver a vender 200 sobre un cap de 20.
  const vendibles = flota.bandejas.reduce(
    (acc, b) => {
      const tope = topeFisico(b.domain);
      if (tope === null) return { ...acc, sinCap: acc.sinCap + 1 };
      return { ...acc, total: acc.total + Math.min(b.hoyPuede, tope) };
    },
    { total: 0, sinCap: 0 }
  );
  const edadHoras = flota.medidoEn
    ? (Date.now() - Date.parse(flota.medidoEn)) / 3_600_000
    : null;
  const medicionVencida = edadHoras !== null && edadHoras > MEDICION_VENCE_HORAS;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <Eyebrow>Fábrica · cuota diaria por bandeja</Eyebrow>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline", marginTop: 4 }}>
          <Heading level={1}>{vendibles.total.toLocaleString("es")}</Heading>
          <Caption>
            envíos/día que los nodos dejan pasar hoy · <strong>{flota.bandejas.length}</strong> de{" "}
            <strong>{flota.totalBandejas}</strong> bandejas en lista ·{" "}
            {flota.medidoEn
              ? `medido ${new Date(flota.medidoEn).toLocaleString("es")}`
              : "la flota nunca se midió"}{" "}
            · techo de política {flota.techoDiario.toLocaleString("es")}/día
          </Caption>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ProcedenciaBadge atribucion={flota.bandejas[0]?.atribucion ?? null} />
          {medicionVencida ? (
            <Pill tone="warning">
              medición vencida · {Math.round(edadHoras ?? 0)}h (el umbral son {MEDICION_VENCE_HORAS}h)
            </Pill>
          ) : null}
          {vendibles.sinCap > 0 ? (
            <Pill tone="warning">
              {vendibles.sinCap} sin cupo físico medido · no suman al total
            </Pill>
          ) : null}
          {capError ? <Pill tone="critical">cupo físico: {capError}</Pill> : null}
          {flota.parcial ? (
            <>
              <Pill tone="critical">lectura parcial</Pill>{" "}
              <Caption>{flota.motivosParcial.join(" · ")}</Caption>
            </>
          ) : null}
        </div>
      </Card>

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 8,
            padding: "6px 0",
            borderBottom: "1px solid var(--line, #e6e9ee)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            opacity: 0.6
          }}
        >
          <span>Dominio</span>
          <span>Nodo</span>
          <span>Estado</span>
          <span style={{ textAlign: "right" }}>Hoy puede</span>
        </div>
        {flota.bandejas.map((b) => (
          <FilaBandeja
            key={b.domain}
            bandeja={b}
            techo={flota.techoDiario}
            topeFisico={topeFisico(b.domain)}
            onGuardado={cargar}
          />
        ))}
      </Card>

      {flota.fueraDeMedicion.length + flota.enConflicto.length > 0 ? (
        <PieIntegridad fueraDeMedicion={flota.fueraDeMedicion} enConflicto={flota.enConflicto} />
      ) : null}
    </div>
  );
}

function FilaBandeja({
  bandeja,
  techo,
  topeFisico,
  onGuardado
}: {
  bandeja: CuotaBandeja;
  techo: number;
  topeFisico: number | null;
  onGuardado: () => Promise<void>;
}) {
  // El tamaño de la muestra detrás del veredicto. Sin esto, un verde de 3 mensajes en 5 días se ve
  // exactamente igual que uno de 20.000, y el clasificador es asimétrico: exige 20 intentos para
  // decir "bloqueada" pero "healthy" es su fallthrough final.
  const muestra =
    typeof bandeja.entregados === "number"
      ? `${bandeja.entregados.toLocaleString("es")} entregados${
          typeof bandeja.rechazados === "number" ? `, ${bandeja.rechazados.toLocaleString("es")} rechazos` : ""
        }`
      : null;
  return (
    <Row>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID,
          gap: 8,
          alignItems: "center",
          width: "100%",
          fontSize: 13
        }}
      >
        <span>
          <span style={{ fontWeight: 500 }}>{bandeja.domain}</span>
          {/* Familias arriba del 40% del umbral permanente de Google. Llegaba en el payload para
              16 de 58 bandejas y no se pintaba en ningún lado: una al 90% del umbral irreversible
              se veía idéntica a una al 1%. Cruzarlo no se deshace nunca. */}
          {bandeja.cruzados.length > 0 ? (
            <span style={{ display: "block", fontSize: 11, color: COLOR.rojo }}>
              cruzó el umbral permanente en {bandeja.cruzados.join(", ")}
            </span>
          ) : bandeja.cerca.length > 0 ? (
            <span style={{ display: "block", fontSize: 11, color: "var(--color-warning, #b26a00)" }}>
              cerca del umbral permanente en {bandeja.cerca.join(", ")}
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted, #8a94a0)" }}>
          {bandeja.serverSlug ?? "sin nodo"}
          {bandeja.edadDias !== null ? (
            <span style={{ display: "block" }}>{bandeja.edadDias} días</span>
          ) : null}
        </span>
        <span>
          <span style={{ color: COLOR[bandeja.color] }}>{bandeja.color === "gris" ? "○" : "●"}</span>{" "}
          {bandeja.estado}
          <span style={{ display: "block", fontSize: 11, color: "var(--muted, #8a94a0)" }}>
            {muestra ?? "tamaño de muestra no declarado por el gateway"}
          </span>
          {bandeja.motivo ? (
            <span style={{ display: "block", fontSize: 11, color: "var(--muted, #8a94a0)" }}>
              {bandeja.motivo}
            </span>
          ) : null}
          {/* El nodo incomunicado alerta SIEMPRE, aunque la bandeja esté calentando: la rampa tapa
              el estado en el semáforo y es justo ahí cuando más importa. */}
          {bandeja.sinLectura ? (
            <span style={{ display: "block", fontSize: 11, color: COLOR.rojo }}>
              nodo incomunicado: {bandeja.sinLectura.motivo}
            </span>
          ) : null}
        </span>
        <CeldaCuota bandeja={bandeja} techo={techo} topeFisico={topeFisico} onGuardado={onGuardado} />
      </div>
    </Row>
  );
}

/**
 * La celda del numero. Tres estados:
 *   - editable + verde: el numero que se vende hoy. Click para cambiarlo.
 *   - editable + rojo/gris: se vende 0; la asignada queda guardada y editable para cuando vuelva.
 *   - no editable: guion. No hay medicion sobre la que aplicar un numero.
 */
function CeldaCuota({
  bandeja,
  techo,
  topeFisico,
  onGuardado
}: {
  bandeja: CuotaBandeja;
  techo: number;
  /** Lo que el Postfix del nodo deja pasar hoy. `null` = no se pudo medir. */
  topeFisico: number | null;
  onGuardado: () => Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editando) inputRef.current?.focus();
  }, [editando]);

  if (!bandeja.editable) {
    // Mientras calienta, NFC vende 0 (la rampa envía el volumen ella misma). Se muestra el cupo
    // que envía la rampa para que el operador vea el progreso, pero NO es lo que NFC consume.
    if (bandeja.color === "calentando") {
      // `?? 0` decía "la rampa envía 0" como si fuera un cupo medido cuando el registro llegaba
      // sin batches. Es el mismo molde de fabricar un cero: si no hay cupo, se dice.
      const cupo = bandeja.rampa?.cupoHoy;
      return (
        <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          <span style={{ color: "var(--muted, #8a94a0)" }}>0</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--color-warming, #0891b2)" }}>
            {typeof cupo === "number"
              ? `la rampa envía ${cupo.toLocaleString("es")}`
              : "cupo de la rampa sin determinar"}
          </span>
        </span>
      );
    }
    return (
      <span style={{ textAlign: "right", color: "var(--muted, #8a94a0)", fontVariantNumeric: "tabular-nums" }}>
        —
      </span>
    );
  }

  const guardar = async () => {
    // NO parseInt: parseInt("2.000")=2 y parseInt("1e3")=1 — el operador ve "2.000" (separador
    // de miles de toLocaleString) y guardaría 2/día en silencio. Number() sobre el string entero
    // exige que sea un entero limpio o falla.
    const limpio = borrador.trim();
    const valor = Number(limpio);
    if (limpio === "" || !Number.isInteger(valor) || valor < 0) {
      setErrorGuardar("tiene que ser un entero ≥ 0, sin puntos ni comas");
      return;
    }
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const response = await fetch(`/v1/sender-pool/quota/${encodeURIComponent(bandeja.domain)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ hoyPuede: valor })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; techo?: number };
      if (!response.ok) {
        throw new Error(
          payload.error === "cuota_supera_techo"
            ? `supera el techo de ${(payload.techo ?? techo).toLocaleString("es")}/día`
            : payload.error ?? `HTTP ${response.status}`
        );
      }
      setEditando(false);
      await onGuardado();
    } catch (cause) {
      setErrorGuardar(cause instanceof Error ? cause.message : "no se pudo guardar");
    } finally {
      setGuardando(false);
    }
  };

  if (editando) {
    return (
      <span style={{ textAlign: "right" }}>
        <input
          ref={inputRef}
          type="number"
          min={0}
          max={techo}
          value={borrador}
          disabled={guardando}
          onChange={(e) => setBorrador(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void guardar();
            if (e.key === "Escape") {
              setEditando(false);
              setErrorGuardar(null);
            }
          }}
          onBlur={() => {
            if (!guardando && errorGuardar === null) setEditando(false);
          }}
          style={{
            width: 90,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            fontSize: 13,
            padding: "2px 6px",
            border: "1px solid var(--line, #e6e9ee)",
            borderRadius: 6,
            background: "transparent",
            color: "inherit"
          }}
        />
        {errorGuardar ? (
          <span style={{ display: "block", fontSize: 11, color: "var(--color-critical, #c0392b)" }}>
            {errorGuardar}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span style={{ textAlign: "right" }}>
      <button
        type="button"
        onClick={() => {
          // Arranca VACÍO cuando `asignada` es null: prellenar "0" convertía un Enter sin tipear
          // en "asignada 0", que es justo la distinción que todo el módulo mantiene a propósito
          // (`asignada` es number|null para separar "nunca se asignó" de "asignada 0").
          setBorrador(bandeja.asignada === null ? "" : String(bandeja.asignada));
          setEditando(true);
        }}
        title={`Editar la cuota diaria de ${bandeja.domain}`}
        style={{
          font: "inherit",
          fontVariantNumeric: "tabular-nums",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "inherit",
          borderBottom: "1px dashed var(--muted, #8a94a0)"
        }}
      >
        {(topeFisico === null ? bandeja.hoyPuede : Math.min(bandeja.hoyPuede, topeFisico)).toLocaleString("es")}
      </button>
      {topeFisico === null ? (
        <span style={{ display: "block", fontSize: 11, color: "var(--color-warning, #b26a00)" }}>
          cupo físico del nodo sin medir
        </span>
      ) : topeFisico < bandeja.hoyPuede ? (
        <span style={{ display: "block", fontSize: 11, color: "var(--color-warning, #b26a00)" }}>
          el nodo solo deja pasar {topeFisico.toLocaleString("es")} hoy
        </span>
      ) : null}
      {bandeja.color !== "verde" && bandeja.asignada !== null && bandeja.asignada > 0 ? (
        <span style={{ display: "block", fontSize: 11, color: "var(--muted, #8a94a0)" }}>
          asignada {bandeja.asignada.toLocaleString("es")}, frenada
        </span>
      ) : null}
    </span>
  );
}

/** El pie: nombres detras de un toggle, no 8 filas de guiones en la lista. */
function PieIntegridad({
  fueraDeMedicion,
  enConflicto
}: {
  fueraDeMedicion: string[];
  enConflicto: string[];
}) {
  const [abierto, setAbierto] = useState(false);
  const resumen = [
    fueraDeMedicion.length > 0 ? `${fueraDeMedicion.length} fuera de medición` : null,
    enConflicto.length > 0 ? `${enConflicto.length} en conflicto` : null
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card>
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        style={{
          font: "inherit",
          fontSize: 12,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--muted, #8a94a0)"
        }}
      >
        {abierto ? "▾" : "▸"} {resumen}
      </button>
      {abierto ? (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {fueraDeMedicion.map((d) => (
            <Pill key={d} tone="warning">
              {d} · ningún sondeo la alcanza
            </Pill>
          ))}
          {enConflicto.map((d) => (
            <Pill key={d} tone="critical">
              {d} · el inventario se contradice
            </Pill>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
