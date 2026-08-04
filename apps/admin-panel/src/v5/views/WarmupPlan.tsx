// EL PLAN DEL DÍA — la pantalla que responde "¿por qué este dominio manda 2 y no 20?".
//
// La consola en vivo muestra lo que PASÓ. Faltaba lo que va a pasar y con qué fundamento: el
// operador veía correos yendo y viniendo sin poder auditar la decisión detrás. Esta sección expone
// exactamente lo que el daemon consulta antes de actuar — misma función, no una reconstrucción.
//
// Regla de la casa acá: cada número viene con su evidencia al lado. Un "cupo 2/día" solo no dice
// nada; "cupo 2/día porque es el día 1 y el placement va 75% sobre 4 mediciones" es auditable.
// Y lo que no se pudo medir se dice, en vez de mostrarse como 0 — que se leería como "todo mal".

import { useEffect, useState } from "react";

import { getJson } from "../../shared/api/client";
import { READ_ENDPOINTS } from "../../shared/api/read-boundary";

// ── Contrato (lo que sirve /v1/warmup/plan) ─────────────────────────────────────────────────────

type Accion = "arrancar" | "subir" | "sostener" | "bajar" | "frenar";

interface DominioDelPlan {
  dominio: string;
  diaN: number | null;
  desde: string | null;
  vueltas: number;
  placement: { tasa: number | null; muestra: number; error: string | null };
  cupoFisico: number | null;
  enviadosHoy: number;
  rebotoHoy: boolean;
  decision: { cupo: number; accion: Accion; motivo: string; placement: number | null };
}

interface PlanDelDia {
  generadoEn: string;
  medicionCupo?: { medidoEn: string | null; vencida: boolean; edadHoras: number | null };
  pool?: { boxes: string[]; motivo: string };
  dominios: DominioDelPlan[];
  lecturasFallidas?: string[];
  nota?: string;
}

interface Pendiente {
  id: string;
  que: string;
  porque: string;
  visto: number;
  diasAbierto: number | null;
}
interface PendientesResp {
  abiertos: Pendiente[];
  resueltos: Pendiente[];
  nota?: string;
}

const REFRESCO_MS = 30_000;

export default function WarmupPlan() {
  const [plan, setPlan] = useState<PlanDelDia | null>(null);
  const [pendientes, setPendientes] = useState<PendientesResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const traer = async () => {
      try {
        const [d, p] = await Promise.all([
          getJson<PlanDelDia>(READ_ENDPOINTS.warmupPlan),
          // Los pendientes NO tumban el plan si fallan: son dos preguntas distintas y una pantalla
          // en blanco por el pedido secundario sería peor que no mostrar los pendientes.
          getJson<PendientesResp>(READ_ENDPOINTS.warmupPendientes).catch(() => null)
        ]);
        if (vivo) {
          setPlan(d);
          setPendientes(p);
          setError(null);
        }
      } catch (e) {
        // El error se MUESTRA, pero NO se borra lo que ya había. Un 502 pasajero del gateway
        // vaciaba la pantalla entera: el operador perdía el plan por un parpadeo de red, que es
        // peor que verlo con un aviso de que puede estar desactualizado.
        if (vivo) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void traer();
    const t = setInterval(() => void traer(), REFRESCO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  // Solo se reemplaza la pantalla si NO hay nada que mostrar. Con plan previo, el error va como
  // aviso arriba y los datos siguen visibles, marcados como posiblemente viejos.
  if (error && !plan) return <div style={S.aviso}>no se pudo leer el plan: {error}</div>;
  if (!plan) return <div style={S.dim}>leyendo el plan…</div>;

  return (
    <section style={S.seccion}>
      <header style={S.encabezado}>
        <h2 style={S.titulo}>El plan de hoy</h2>
        <span style={S.dim}>qué decidió el agente para cada dominio, y con qué evidencia</span>
      </header>

      {error ? (
        <div style={S.aviso}>
          no se pudo refrescar ({error}) — lo de abajo es de las {new Date(plan.generadoEn).toLocaleTimeString("es-AR")}
        </div>
      ) : null}

      {plan.nota ? <div style={S.aviso}>{textoNota(plan.nota)}</div> : null}

      {/* El pool y la antigüedad de la medición van arriba porque condicionan TODO lo de abajo. */}
      {plan.pool ? (
        <div style={S.tira}>
          <span style={S.tiraEtiqueta}>pool</span>
          <span style={S.tiraValor}>{plan.pool.motivo}</span>
        </div>
      ) : null}
      {plan.medicionCupo?.vencida && plan.medicionCupo.medidoEn ? (
        <div style={S.aviso}>
          la medición del cupo tiene {plan.medicionCupo.edadHoras ?? "?"}h: sirve para saber a quién
          intentarle, no para decidir volumen. Refrescala con{" "}
          <code style={S.codigo}>limite-fisico.ts --status</code>
        </div>
      ) : null}

      {(plan.lecturasFallidas ?? []).length > 0 ? (
        <div style={S.aviso}>
          el plan está incompleto — {(plan.lecturasFallidas ?? []).join(" · ")}
        </div>
      ) : null}

      {/* LO QUE EL AGENTE TE PIDE. Va ARRIBA del plan a propósito: es lo único de esta pantalla
          que requiere que hagas algo, y enterrado abajo no lo lee nadie. Ordenado por insistencia:
          lo que el agente volvió a detectar más veces, primero. */}
      {(pendientes?.abiertos ?? []).length > 0 ? (
        <div style={S.pedidos}>
          <span style={S.pedidosTit}>el agente necesita que vos hagas esto</span>
          {(pendientes?.abiertos ?? []).map((p) => (
            <div key={p.id} style={S.pedido}>
              <span style={S.pedidoQue}>{p.que}</span>
              <span style={S.pedidoPorque}>{p.porque}</span>
              <span style={S.pedidoMeta}>
                {p.visto > 1 ? `lo detectó ${p.visto} veces` : "detectado una vez"}
                {p.diasAbierto !== null ? ` · abierto hace ${p.diasAbierto === 0 ? "hoy" : `${p.diasAbierto} d`}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}

            {plan.dominios.length === 0 ? (
        <div style={S.vacio}>
          ningún dominio en calentamiento.{" "}
          {plan.pool?.motivo.includes("cap 0")
            ? "Están todos frenados en Postfix: soltá cupo en al menos uno para que el warmup tenga con qué trabajar."
            : ""}
        </div>
      ) : (
        <div style={S.grilla}>
          {plan.dominios.map((d) => (
            <FichaDominio key={d.dominio} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function FichaDominio({ d }: { d: DominioDelPlan }) {
  const restante = Math.max(0, d.decision.cupo - d.enviadosHoy);
  const progreso = d.decision.cupo > 0 ? Math.min(1, d.enviadosHoy / d.decision.cupo) : 0;

  return (
    <article style={S.ficha}>
      <div style={S.fichaTop}>
        <span style={S.dominio}>{d.dominio}</span>
        <span style={S.chip(d.decision.accion)}>{d.decision.accion}</span>
      </div>

      <div style={S.metricas}>
        <Metrica
          rotulo="día"
          valor={d.diaN === null ? "—" : String(d.diaN)}
          pie={d.diaN === null ? "todavía no mandó" : `${d.vueltas} vuelta${d.vueltas === 1 ? "" : "s"}`}
        />
        <Metrica
          rotulo="placement"
          // Sin muestra es "—", NUNCA 0%: un 0% se lee como "todo cae en spam".
          valor={d.placement.tasa === null ? "—" : `${Math.round(d.placement.tasa * 100)}%`}
          pie={
            d.placement.error
              ? "no se pudo leer"
              : d.placement.muestra === 0
                ? "sin mediciones aún"
                : `sobre ${d.placement.muestra}`
          }
          alerta={Boolean(d.placement.error)}
        />
        <Metrica
          rotulo="hoy"
          valor={`${d.enviadosHoy}/${d.decision.cupo}`}
          // Un dominio FRENADO tiene cupo 0, y "0/0 · cupo cumplido" se lee como "terminó su
          // trabajo del día" cuando en realidad está detenido por mal placement. Es la lectura
          // exactamente opuesta a la verdad, en la métrica que el operador mira primero.
          pie={
            d.decision.cupo === 0
              ? "frenado: no manda"
              : restante === 0
                ? "cupo cumplido"
                : `faltan ${restante}`
          }
        />
        <Metrica
          rotulo="cupo del nodo"
          valor={d.cupoFisico === null ? "—" : `${d.cupoFisico}`}
          pie={d.cupoFisico === null ? "medición vencida" : "Postfix"}
        />
      </div>

      <div style={S.barra}>
        <div style={S.barraLlena(progreso, d.decision.accion)} />
      </div>

      {/* El motivo es el corazón de la pantalla: es lo que hace auditable al agente. */}
      <p style={S.motivo}>{d.decision.motivo}</p>

      {d.rebotoHoy ? (
        <p style={S.rebote}>el nodo rechazó un envío hoy por cupo agotado — el daemon lo saltea hasta mañana</p>
      ) : null}
      {d.placement.error ? <p style={S.rebote}>lectura de placement fallida: {d.placement.error}</p> : null}
    </article>
  );
}

function Metrica({
  rotulo,
  valor,
  pie,
  alerta
}: {
  rotulo: string;
  valor: string;
  pie: string;
  alerta?: boolean;
}) {
  return (
    <div style={S.metrica}>
      <span style={S.rotulo}>{rotulo}</span>
      <span style={{ ...S.valor, ...(alerta ? { color: "var(--color-warning)" } : {}) }}>{valor}</span>
      <span style={S.pie}>{pie}</span>
    </div>
  );
}

function textoNota(nota: string): string {
  if (nota === "postgres_unavailable") return "sin conexión a la base: no hay plan que mostrar";
  if (nota === "plan_read_failed") return "la lectura del plan falló; se muestra vacío en vez de romper la pantalla";
  return nota;
}

// ── Estilos: los tokens de la casa, sin ámbar (warning = naranja) ───────────────────────────────

const COLOR_ACCION: Record<Accion, string> = {
  arrancar: "var(--color-info)",
  subir: "var(--color-success)",
  sostener: "var(--color-text-secondary)",
  bajar: "var(--color-warning)",
  // --color-critical, NO --color-danger: ese token no existe en tokens.css, así que el chip del
  // estado MÁS importante —un dominio frenado— se renderizaba sin color, sin fondo y sin borde.
  frenar: "var(--color-critical)"
};

const S = {
  seccion: { display: "grid", gap: 14 } as const,
  encabezado: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" as const },
  titulo: { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--color-text-primary)" } as const,
  dim: { fontSize: 12.5, color: "var(--color-text-tertiary)" } as const,

  tira: {
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const,
    padding: "8px 14px", borderRadius: 10,
    background: "var(--color-surface)", border: "1px solid var(--color-border)"
  } as const,
  tiraEtiqueta: {
    fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase" as const,
    color: "var(--color-text-tertiary)"
  } as const,
  tiraValor: { fontSize: 12.5, color: "var(--color-text-secondary)" } as const,

  aviso: {
    padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
    color: "var(--color-warning)",
    background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-warning) 28%, transparent)"
  } as const,
  // Token de la casa: Inter en todos los roles, sin mezcla de familias.
  codigo: { fontFamily: "var(--font-mono)", fontSize: 11.5 } as const,
  vacio: {
    padding: "18px 16px", borderRadius: 12, fontSize: 13, lineHeight: 1.55,
    color: "var(--color-text-secondary)",
    background: "var(--color-surface)", border: "1px dashed var(--color-border)"
  } as const,

  pedidos: {
    display: "grid", gap: 10, padding: "14px 16px", borderRadius: 12,
    background: "color-mix(in srgb, var(--color-info, #0c7cb5) 7%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-info, #0c7cb5) 26%, transparent)"
  } as const,
  pedidosTit: {
    fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase" as const, fontWeight: 600,
    color: "var(--color-info, #0c7cb5)"
  } as const,
  pedido: { display: "grid", gap: 2 } as const,
  pedidoQue: { fontSize: 13.5, fontWeight: 600, color: "var(--color-text-primary)" } as const,
  pedidoPorque: { fontSize: 12.5, lineHeight: 1.45, color: "var(--color-text-secondary)" } as const,
  pedidoMeta: { fontSize: 11, color: "var(--color-text-tertiary)" } as const,

  grilla: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" } as const,

  ficha: {
    display: "grid", gap: 12, padding: 18, borderRadius: 16, minWidth: 0,
    background: "var(--color-surface)", border: "1px solid var(--color-border)"
  } as const,
  fichaTop: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } as const,
  dominio: {
    fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, minWidth: 0, flex: 1
  } as const,
  chip: (a: Accion) => ({
    flex: "none", fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em",
    textTransform: "uppercase" as const, padding: "3px 9px", borderRadius: 999,
    color: COLOR_ACCION[a],
    background: `color-mix(in srgb, ${COLOR_ACCION[a]} 12%, transparent)`,
    border: `1px solid color-mix(in srgb, ${COLOR_ACCION[a]} 32%, transparent)`
  }),

  metricas: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 } as const,
  metrica: { display: "grid", gap: 2, minWidth: 0 } as const,
  rotulo: {
    fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase" as const,
    color: "var(--color-text-tertiary)"
  } as const,
  valor: {
    fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)",
    fontVariantNumeric: "tabular-nums" as const, lineHeight: 1.15
  } as const,
  pie: { fontSize: 10.5, color: "var(--color-text-tertiary)" } as const,

  barra: { height: 4, borderRadius: 999, background: "var(--color-border)", overflow: "hidden" } as const,
  barraLlena: (p: number, a: Accion) => ({
    height: "100%", width: `${Math.round(p * 100)}%`,
    background: COLOR_ACCION[a], transition: "width .5s ease"
  }),

  motivo: { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--color-text-secondary)" } as const,
  rebote: { margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--color-warning)" } as const
};
