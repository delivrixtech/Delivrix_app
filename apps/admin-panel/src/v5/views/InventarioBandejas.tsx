// Inventario de bandejas: la pantalla de la fabrica.
//
// Una sola tabla, una fila por bandeja. Reemplaza los 8 bloques de Warmup.tsx —hero explicativo,
// KPIs, "recorrido del nodo", panel de tendencias— que hoy salen todos en cero cuando Postgres
// se cae, con un cartel que ademas afirma algo falso.
//
// LA REGLA DEL ARCHIVO, y esta en el codigo y no en un comentario: un dato que no se midio se
// pinta como guion gris CON EL MOTIVO PEGADO. Un cero solo se imprime si hubo denominador.
// Esta semana aparecieron seis sensores que reportaban salud sin datos y los seis compartian la
// misma forma: un cero que se lee como "todo bien". `Dato` hace eso imposible de escribir.

import { useEffect, useState } from "react";

import { Caption, Card, Eyebrow, Heading, Pill, Row } from "../../shared/ui/aivora";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";

type SinMedicion = "sin_binding" | "nunca_medida" | "conflicto_de_inventario";

interface Bandeja {
  domain: string;
  serverSlug: string | null;
  serverIp: string | null;
  edadDias: number | null;
  tieneAccesoOps: boolean;
  conflicto: { enBindings: string; enCredencial: string } | null;
  sinMedicion: SinMedicion | null;
}

interface Inventario {
  totalBandejas: number;
  medibles: number;
  sinBinding: string[];
  enConflicto: string[];
  bandejas: Bandeja[];
  parcial: boolean;
  motivosParcial: string[];
}

/** El motivo viaja pegado al guion. Nunca se resume en "sin datos". */
const MOTIVO: Record<SinMedicion, string> = {
  sin_binding: "ningún sondeo la alcanza",
  conflicto_de_inventario: "el inventario se contradice",
  nunca_medida: "nunca se midió"
};

/**
 * El unico componente que puede imprimir un numero en esta pantalla.
 *
 * Tres estados y no dos: medido / cero-con-denominador / no-medido-con-motivo. La firma obliga
 * a pasar el motivo cuando el valor es null, asi que no se puede escribir por accidente una
 * celda vacia que parezca un cero.
 */
function Dato({
  valor,
  motivo,
  sufijo
}: {
  valor: number | string | null;
  motivo: string;
  sufijo?: string;
}) {
  if (valor === null || valor === undefined) {
    return (
      <span style={{ color: "var(--muted, #8a94a0)", fontVariantNumeric: "tabular-nums" }}>
        — <span style={{ fontSize: 11 }}>{motivo}</span>
      </span>
    );
  }
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {valor}
      {sufijo ? <span style={{ opacity: 0.6, fontSize: 11 }}> {sufijo}</span> : null}
    </span>
  );
}

export default function InventarioBandejas() {
  const [inv, setInv] = useState<Inventario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [medidoHace, setMedidoHace] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const response = await fetch(READ_ENDPOINTS.senderPoolInventory, {
          headers: { accept: "application/json" },
          cache: "no-store"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as Inventario;
        if (!vivo) return;
        setInv(payload);
        setError(null);
        setMedidoHace(new Date().toLocaleTimeString());
      } catch (cause) {
        if (!vivo) return;
        // Un fallo de carga NO deja la pantalla en cero: deja la pantalla en "no pude leer".
        setError(cause instanceof Error ? cause.message : "no se pudo leer el inventario");
      }
    };
    void cargar();
    const timer = setInterval(() => void cargar(), 60_000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <Card>
        <Eyebrow>Inventario de bandejas</Eyebrow>
        <Heading level={2}>No se pudo leer el inventario</Heading>
        <Caption>{error}</Caption>
      </Card>
    );
  }

  if (!inv) {
    return (
      <Card>
        <Eyebrow>Inventario de bandejas</Eyebrow>
        <Caption>Leyendo…</Caption>
      </Card>
    );
  }

  const nuncaMedidas = inv.bandejas.filter((b) => b.sinMedicion === "nunca_medida").length;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* FRANJA 0 — el sello. Antes de cualquier numero: sobre que poblacion se habla. */}
      <Card>
        <Eyebrow>Inventario de bandejas</Eyebrow>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline", marginTop: 4 }}>
          <Heading level={1}>{inv.totalBandejas}</Heading>
          <Caption>
            bandejas · <strong>{inv.medibles}</strong> medibles ·{" "}
            <strong>{inv.sinBinding.length}</strong> sin binding ·{" "}
            <strong>{inv.enConflicto.length}</strong> en conflicto
            {medidoHace ? ` · leído ${medidoHace}` : null}
          </Caption>
        </div>
        {inv.parcial ? (
          <div style={{ marginTop: 8 }}>
            <Pill tone="critical">lectura parcial</Pill>{" "}
            <Caption>{inv.motivosParcial.join(" · ")}</Caption>
          </div>
        ) : null}
      </Card>

      {/* FRANJA 1 — cuatro numeros que SIEMPRE suman el total. Si no suman, hay un bug y se ve. */}
      <Card>
        <Eyebrow>Estado</Eyebrow>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 8 }}>
          <Bloque
            titulo="Medibles"
            valor={inv.medibles}
            nota="tienen nodo asignado"
          />
          <Bloque
            titulo="Sin lectura"
            valor={nuncaMedidas}
            nota="nunca se midieron"
            atencion
          />
          <Bloque
            titulo="En conflicto"
            valor={inv.enConflicto.length}
            nota="el inventario se contradice"
            atencion={inv.enConflicto.length > 0}
          />
          <Bloque
            titulo="Invisibles"
            valor={inv.sinBinding.length}
            nota="ningún sondeo las toca"
            atencion={inv.sinBinding.length > 0}
          />
        </div>
      </Card>

      {/* FRANJA 3 — la tabla. Riesgo primero. */}
      <Card>
        <Eyebrow>Bandejas</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 0.9fr 0.6fr 0.6fr 1.4fr",
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
            <span>IP</span>
            <span>Edad</span>
            <span>SSH</span>
            <span>Medición</span>
          </div>
          {inv.bandejas.map((b) => (
            <Row key={b.domain}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 0.9fr 0.6fr 0.6fr 1.4fr",
                  gap: 8,
                  alignItems: "center",
                  width: "100%",
                  fontSize: 13
                }}
              >
                <span style={{ fontWeight: 500 }}>{b.domain}</span>
                <Dato valor={b.serverSlug} motivo="sin binding" />
                <Dato valor={b.serverIp} motivo="sin binding" />
                <Dato valor={b.edadDias} motivo="sin fecha" sufijo="d" />
                <span>{b.tieneAccesoOps ? "sí" : <Dato valor={null} motivo="sin acceso ops" />}</span>
                <span>
                  {b.conflicto ? (
                    <Pill tone="critical">
                      {b.conflicto.enBindings} ≠ {b.conflicto.enCredencial}
                    </Pill>
                  ) : (
                    <Dato valor={null} motivo={MOTIVO[b.sinMedicion ?? "nunca_medida"]} />
                  )}
                </span>
              </div>
            </Row>
          ))}
        </div>
      </Card>

      {/* FRANJA 4 — integridad. Los nombres, no un conteo. */}
      {inv.sinBinding.length > 0 ? (
        <Card>
          <Eyebrow>Fuera de toda medición</Eyebrow>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {inv.sinBinding.map((d) => (
              <Pill key={d} tone="warning">
                {d}
              </Pill>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Bloque({
  titulo,
  valor,
  nota,
  atencion
}: {
  titulo: string;
  valor: number;
  nota: string;
  atencion?: boolean;
}) {
  return (
    <div>
      <Caption>{titulo}</Caption>
      <div
        style={{
          fontSize: 30,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: atencion && valor > 0 ? "var(--critical, #c0392b)" : "inherit"
        }}
      >
        {valor}
      </div>
      <Caption style={{ fontSize: 11 }}>{nota}</Caption>
    </div>
  );
}
