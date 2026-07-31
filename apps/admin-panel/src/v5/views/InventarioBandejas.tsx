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

const GRID = "1.6fr 1.3fr 0.9fr";

export default function InventarioBandejas() {
  const [flota, setFlota] = useState<CuotaFlota | null>(null);
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

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <Eyebrow>Fábrica · cuota diaria por bandeja</Eyebrow>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline", marginTop: 4 }}>
          <Heading level={1}>{flota.totalHoyPuede.toLocaleString("es")}</Heading>
          <Caption>
            envíos/día en venta · <strong>{flota.bandejas.length}</strong> de{" "}
            <strong>{flota.totalBandejas}</strong> bandejas en lista ·{" "}
            {flota.medidoEn
              ? `medido ${new Date(flota.medidoEn).toLocaleString("es")}`
              : "la flota nunca se midió"}{" "}
            · techo {flota.techoDiario.toLocaleString("es")}/día
          </Caption>
        </div>
        {flota.parcial ? (
          <div style={{ marginTop: 8 }}>
            <Pill tone="critical">lectura parcial</Pill> <Caption>{flota.motivosParcial.join(" · ")}</Caption>
          </div>
        ) : null}
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
          <span>Estado</span>
          <span style={{ textAlign: "right" }}>Hoy puede</span>
        </div>
        {flota.bandejas.map((b) => (
          <FilaBandeja key={b.domain} bandeja={b} techo={flota.techoDiario} onGuardado={cargar} />
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
  onGuardado
}: {
  bandeja: CuotaBandeja;
  techo: number;
  onGuardado: () => Promise<void>;
}) {
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
        <span style={{ fontWeight: 500 }}>{bandeja.domain}</span>
        <span>
          <span style={{ color: COLOR[bandeja.color] }}>{bandeja.color === "gris" ? "○" : "●"}</span>{" "}
          {bandeja.estado}
          {bandeja.motivo ? (
            <span style={{ display: "block", fontSize: 11, color: "var(--muted, #8a94a0)" }}>
              {bandeja.motivo}
            </span>
          ) : null}
        </span>
        <CeldaCuota bandeja={bandeja} techo={techo} onGuardado={onGuardado} />
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
  onGuardado
}: {
  bandeja: CuotaBandeja;
  techo: number;
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
    // Mientras calienta, el numero lo dicta la rampa: se muestra, pero no se edita.
    if (bandeja.color === "calentando") {
      return (
        <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {bandeja.hoyPuede.toLocaleString("es")}
          <span style={{ display: "block", fontSize: 11, color: "var(--color-warming, #0891b2)" }}>
            dicta la rampa
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
    const valor = Number.parseInt(borrador, 10);
    if (!Number.isInteger(valor) || valor < 0) {
      setErrorGuardar("tiene que ser un entero ≥ 0");
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
          setBorrador(String(bandeja.asignada ?? 0));
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
        {bandeja.hoyPuede.toLocaleString("es")}
      </button>
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
