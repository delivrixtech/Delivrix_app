/**
 * v5 Nodos — la flota REAL, agrupada por subred.
 *
 * Reescrita el 2026-08-06. Antes esta pantalla mostraba 11 nodos de FIXTURE de mayo y los
 * presentaba como la flota: /v1/admin/clusters sale de runtime/sender-nodes.json (mtime
 * May 3 14:22) con IPs 203.0.113.x —TEST-NET-3, el rango de documentación de la RFC 5737—,
 * hostnames *.delivrix.example e ids que se autodelatan (sender_demo_001,
 * sender_rate_limit_test_001). Sobre eso se pintaban 4 KPIs, 3 tarjetas y el badge de estado,
 * mientras la pestaña de al lado mostraba 66 bandejas reales. No era un número desactualizado:
 * era una flota que no existe.
 *
 * Ahora sale del mismo inventario que el resto del panel:
 *   · GET /v1/sender-pool/inventory → dominio, slug e IP de cada bandeja.
 *   · GET /v1/sender-pool/cap       → cupo físico y consumo del día por nodo.
 *   · GET /v1/sender-pool/quota     → el semáforo de entrega ya calculado en el gateway.
 *
 * Y agrupa por /24, no por "clúster": es la pregunta real del operador y el patrón que ya nos
 * mordió (el /24 80.190.75.x tenía 11 de 13 nodos no sanos). Un clúster homogéneo que el backend
 * rotulaba "mixed" no le sirve a nadie.
 *
 * Lo que se fue con la reescritura, y por qué:
 *   · El banner "Advisor · OpenClaw": contaba un `const` de 5 strings de política como
 *     "7 aprobaciones humanas pendientes" y 32 campos vacíos de un formulario de onboarding de
 *     Proxmox como "32 bloqueos activos en la topología", sobre un contrato que se autodeclara
 *     mock (source.kind="mock", trusted:false) y que la vista nunca mostraba.
 *   · 4 botones sin onClick ("Revisar plan", "Abrir canvas", "Configurar", "Ver detalle"): 8 en
 *     pantalla con 3 clústeres. Un botón inerte enseña a desconfiar de los que sí funcionan.
 *   · El link a https://docs.delivrix.dev/runbooks/clusters: NXDOMAIN.
 *   · El cartel fijo "Reputación: pendiente · sin medición", que era texto literal en el JSX
 *     mientras la medición existe. Decir "sin medición" habiendo medición es tan falso como
 *     inventar el número, solo que en la dirección contraria.
 *   · La tarjeta "Plan warmup · Día N + cap Xk/día": agregaba con Math.max POR SEPARADO, así que
 *     el día salía de un nodo y el cap de otro, y `warmupDay` solo se escribe al registrar el nodo
 *     (nadie lo incrementa nunca: los 11 seguían en día 0 o 1 desde mayo).
 *
 * Lo único que se conserva tal cual es LivePulse: lee frescura real del cache (dataUpdatedAt /
 * isError) y su POLL_SEC coincide con el refetchInterval real de App.tsx.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Network,
  Power,
  Server,
  ShieldCheck,
  X
} from "lucide-react";
import { getJson, loadDashboardData } from "../../shared/api/client";
import type { DashboardData } from "../../shared/api/client";
import { READ_ENDPOINTS, type ReadEndpoint } from "../../shared/api/read-boundary";
import { staggerContainer, staggerItem } from "../lib/motion";
import { Card, SectionHead, KpiCard, Pill, Eyebrow } from "../../shared/ui/aivora";
import { ProcedenciaBadge } from "../../shared/ui/ProcedenciaBadge";
import { estadoDeCupo, resumenCupo, subredDe, type NodoCupo } from "../../shared/lib/flota-cupo";
import { useToast } from "../../shared/ui/v2";

const POLL_SEC = 30;

/* Estilos mono/label reusados — todos derivados de tokens. --font-mono está
 * congelado a Inter (tabular-nums) a propósito: una sola familia, nada ad-hoc. */
const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

/* ============================================================
 * LivePulse — indicador de frescura del dashboard (dot + label + pulso).
 *
 * NO es un adorno siempre-verde: el tono y el "hace Xs" salen de la señal REAL
 * del query de react-query (dataUpdatedAt = último fetch exitoso, isError = último
 * fetch falló), no de un reloj congelado al montar. Reglas (POLL_SEC = intervalo de
 * refetch de App.tsx):
 *   • último fetch OK y fresco (< 2 ciclos de poll)  → success "En vivo" + pulso.
 *   • sin refetch exitoso hace > 2 ciclos            → warning "Datos atrasados", sin pulso.
 *   • último fetch con error                          → critical "Sin conexión", sin pulso.
 *   • sin ninguna lectura (updatedAt = 0)             → estado neutro honesto, sin "en vivo".
 * El pulso (que en el documento §4 "dice en vivo") corre SOLO en success: nunca fingimos
 * liveness cuando el backend está caído o el dato quedó viejo. prefers-reduced-motion lo apaga.
 * ============================================================ */

type LiveTone = "success" | "warning" | "critical";

function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  return `hace ${Math.floor(minutes / 60)}h`;
}

function LivePulse({ pollSec, updatedAt, isError }: { pollSec: number; updatedAt: number; isError: boolean }) {
  const reduce = useReducedMotion();
  const [, setTick] = useState(0);
  useEffect(() => {
    // Tick de 1s: hace avanzar el "hace Xs" y deja que el tono vire a "atrasado"
    // aunque no llegue un re-render nuevo del query (p. ej. el poll dejó de refrescar).
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const hasSignal = updatedAt > 0;
  const ageSec = hasSignal ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : null;
  // "Atrasado" = el loop de poll no entregó dato fresco en 2 ciclos + gracia.
  const staleThreshold = pollSec * 2 + 5;

  const tone: LiveTone = isError
    ? "critical"
    : !hasSignal || (ageSec != null && ageSec > staleThreshold)
    ? "warning"
    : "success";
  const live = tone === "success";

  const color =
    tone === "warning" ? "var(--color-warning)" : tone === "critical" ? "var(--color-critical)" : "var(--color-success)";
  const soft =
    tone === "warning"
      ? "var(--color-warning-soft)"
      : tone === "critical"
      ? "var(--color-critical-soft)"
      : "var(--color-success-soft)";
  const label = isError ? "Sin conexión" : tone === "warning" ? "Datos atrasados" : "En vivo";
  const rel = hasSignal ? formatRelative(updatedAt) : null;

  return (
    <span
      aria-label={rel ? `${label}: actualizado ${rel}` : `${label}: sin lectura de frescura`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        background: soft,
        color
      }}
    >
      <span aria-hidden="true" style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
        {reduce || !live ? null : (
          <motion.span
            style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }}
            initial={{ scale: 1, opacity: 0.4 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span
          style={{ position: "absolute", top: 2, left: 2, width: 4, height: 4, borderRadius: "50%", background: color }}
        />
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.01em", fontVariantNumeric: "tabular-nums" }}>
        {label} · poll {pollSec}s{rel ? ` · ${rel}` : ""}
      </span>
    </span>
  );
}

export interface ClustersV5Props {
  data: DashboardData;
}

/* ── Contratos de lectura (los que ya sirven los endpoints del read boundary) ── */

interface BandejaInventario {
  domain: string;
  serverSlug: string | null;
  serverIp: string | null;
  edadDias: number | null;
}
interface InventarioFabrica {
  bandejas: BandejaInventario[];
  totalBandejas: number;
  parcial: boolean;
  motivosParcial: string[];
}
interface CapFlota {
  medidoEn: string | null;
  nodos: Array<NodoCupo & { serverSlug: string }>;
  ilegibles: number;
  omitidos?: number;
}
interface CuotaFlota {
  bandejas: Array<{ domain: string; color: string; estado: string; motivo: string | null }>;
}

/** Una subred /24 con sus nodos. Es la unidad que decide reputación, no el "clúster". */
interface Subred {
  cidr: string;
  filas: FilaNodo[];
}
interface FilaNodo {
  domain: string;
  serverSlug: string | null;
  serverIp: string | null;
  cupo: (NodoCupo & { serverSlug: string }) | null;
  estadoEntrega: { color: string; estado: string; motivo: string | null } | null;
}

function useLectura<T>(url: ReadEndpoint, refrescoMs: number) {
  return useQuery({
    queryKey: ["nodos", url],
    queryFn: () => getJson<T>(url),
    refetchInterval: refrescoMs,
    retry: false
  });
}

export function ClustersV5({ data }: ClustersV5Props) {
  // Nos re-suscribimos al MISMO query del dashboard (la fuente que App.tsx refresca
  // cada 30s) solo para LEER su frescura real: dataUpdatedAt (último fetch OK) e isError.
  // enabled:false → este observador no dispara un segundo loop de poll; refleja el estado
  // compartido del cache de forma reactiva. Así el badge deja de colgar de un reloj de montaje.
  const dashboardQuery = useQuery({
    queryKey: ["admin-panel", "dashboard"],
    queryFn: loadDashboardData,
    enabled: false
  });

  const inventario = useLectura<InventarioFabrica>(READ_ENDPOINTS.senderPoolInventory, POLL_SEC * 1000 * 2);
  const cap = useLectura<CapFlota>(READ_ENDPOINTS.senderPoolCap, POLL_SEC * 1000 * 2);
  const cuota = useLectura<CuotaFlota>(READ_ENDPOINTS.senderPoolQuota, POLL_SEC * 1000 * 2);

  const bandejas = inventario.data?.bandejas ?? [];
  const cupoPorDominio = new Map((cap.data?.nodos ?? []).map((n) => [n.domain, n]));
  const entregaPorDominio = new Map((cuota.data?.bandejas ?? []).map((b) => [b.domain, b]));

  const filas: FilaNodo[] = bandejas.map((b) => ({
    domain: b.domain,
    serverSlug: b.serverSlug,
    serverIp: b.serverIp,
    cupo: cupoPorDominio.get(b.domain) ?? null,
    estadoEntrega: entregaPorDominio.get(b.domain) ?? null
  }));

  // Agrupación por /24. Lo que no tiene IP no se inventa una subred: va a su propio grupo.
  const porSubred = new Map<string, FilaNodo[]>();
  for (const fila of filas) {
    const clave = subredDe(fila.serverIp) ?? "sin IP en el inventario";
    const previo = porSubred.get(clave);
    if (previo) previo.push(fila);
    else porSubred.set(clave, [fila]);
  }
  const subredes: Subred[] = [...porSubred.entries()]
    .map(([cidr, f]) => ({ cidr, filas: f }))
    .sort((a, b) => b.filas.length - a.filas.length || a.cidr.localeCompare(b.cidr));

  const resumen = resumenCupo(cap.data?.nodos ?? [], {
    omitidos: cap.data?.omitidos ?? 0,
    ilegibles: cap.data?.ilegibles ?? 0
  });
  // IPs DISTINTAS, no nodos: el KPI viejo hacía `senderNodes.length` y lo llamaba "IPs en pool"
  // con 3 nodos sin IP y 3 direcciones duplicadas entre clústeres (11 mostrados, 5 reales). Un
  // pool de IPs es justo el dato sobre el que se decide reputación.
  const ipsDistintas = new Set(filas.map((f) => f.serverIp).filter((ip): ip is string => Boolean(ip))).size;
  const leyendo = inventario.isLoading || cap.isLoading;
  const fallos = [
    inventario.isError ? "inventario" : null,
    cap.isError ? "cupo físico" : null,
    cuota.isError ? "estado de entrega" : null
  ].filter(Boolean);

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-6"
    >
      <motion.div variants={staggerItem}>
        <SectionHead
          eyebrow="Flota real"
          title="Nodos de envío, por subred."
          subtitle="Un nodo por dominio. Se agrupan por /24 porque la reputación se quema por subred: un vecino malo arrastra a los demás."
          right={
            <LivePulse
              pollSec={POLL_SEC}
              updatedAt={dashboardQuery.dataUpdatedAt}
              isError={dashboardQuery.isError}
            />
          }
        />
      </motion.div>

      {/* La procedencia de lo medido: por estos mismos nodos pasa el correo de otro producto. */}
      <motion.div variants={staggerItem}>
        <ProcedenciaBadge />
      </motion.div>

      {fallos.length > 0 ? (
        <motion.div variants={staggerItem}>
          <Card style={{ padding: 16, borderLeft: "2px solid var(--color-critical)" }}>
            <Eyebrow>Lectura incompleta</Eyebrow>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--color-text-secondary)" }}>
              No se pudo leer: {fallos.join(" · ")}. Lo que falta NO se muestra como cero.
            </p>
          </Card>
        </motion.div>
      ) : null}

      <motion.section variants={staggerItem} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard icon={Network} label="Subredes /24" value={leyendo ? "—" : subredes.length} />
          <KpiCard icon={Server} label="Nodos" value={leyendo ? "—" : filas.length} />
          <KpiCard icon={Network} label="IPs distintas" value={leyendo ? "—" : ipsDistintas} />
          <KpiCard
            icon={CircleCheck}
            label="Con cupo hoy"
            value={cap.data ? resumen.totalNodos - resumen.frenados - resumen.sinLimite : "—"}
            {...(cap.data && resumen.sinContador > 0
              ? { suffix: ` · ${resumen.sinContador} sin contador` }
              : {})}
          />
        </div>
      </motion.section>

      <motion.section variants={staggerItem} className="flex flex-col gap-4">
        <SectionHead
          eyebrow="Subredes"
          title="Dónde vive cada nodo"
          subtitle={
            leyendo
              ? "Leyendo el inventario…"
              : `${subredes.length} subred${subredes.length === 1 ? "" : "es"} · ${filas.length} nodos`
          }
        />
        {leyendo ? null : subredes.length === 0 ? (
          <Card style={{ padding: 20 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary)" }}>
              El inventario no devolvió bandejas. Eso NO significa que la flota esté vacía: puede
              ser que la lectura del workspace haya fallado (mirá el aviso de arriba).
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5">
            {subredes.map((sub) => (
              <SubredCard key={sub.cidr} subred={sub} />
            ))}
          </div>
        )}
      </motion.section>

      <motion.div variants={staggerItem}>
        <KillSwitchBlock ks={data.killSwitch} />
      </motion.div>
    </motion.div>
  );
}

/**
 * Una subred con sus nodos. El encabezado dice cuántos NO están sanos, que es la razón de
 * agrupar así: 11 de 13 nodos del 80.190.75.x caídos no se ve mirando dominio por dominio.
 */
function SubredCard({ subred }: { subred: Subred }) {
  const [abierto, setAbierto] = useState(false);
  const noSanos = subred.filas.filter(
    (f) => (f.estadoEntrega && f.estadoEntrega.color === "rojo") || (f.cupo && estadoDeCupo(f.cupo) !== "en_uso")
  ).length;
  const proporcion = subred.filas.length > 0 ? noSanos / subred.filas.length : 0;

  return (
    <Card style={{ padding: 20 }} className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span style={{ ...MONO, fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
            {subred.cidr}
          </span>
          <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            {subred.filas.length} nodo{subred.filas.length === 1 ? "" : "s"}
          </span>
        </div>
        {noSanos > 0 ? (
          <Pill tone={proporcion >= 0.5 ? "critical" : "warning"}>
            {noSanos} de {subred.filas.length} con problema
          </Pill>
        ) : (
          <Pill tone="success">sin problemas medidos</Pill>
        )}
      </header>

      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex items-center gap-1.5 self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        {abierto ? <ChevronDown size={13} strokeWidth={1.9} /> : <ChevronRight size={13} strokeWidth={1.9} />}
        {abierto ? "Ocultar nodos" : `Ver ${subred.filas.length} nodo${subred.filas.length === 1 ? "" : "s"}`}
      </button>

      {abierto ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {subred.filas.map((f) => (
            <NodoRow key={f.domain} fila={f} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function NodoRow({ fila }: { fila: FilaNodo }) {
  const estado = fila.cupo ? estadoDeCupo(fila.cupo) : null;
  return (
    <li className="flex flex-wrap items-center gap-3" style={{ borderRadius: 8, padding: "6px 8px" }}>
      <span style={{ ...MONO, flex: 1, minWidth: 160, fontSize: 11.5, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {fila.domain}
      </span>
      <span style={{ ...MONO, fontSize: 11, color: "var(--color-text-tertiary)" }}>
        {fila.serverSlug ?? "sin nodo"} · {fila.serverIp ?? "sin IP"}
      </span>
      {/* Entrega: lo que el gateway ya calculó. `null` = no llegó, y se dice. */}
      {fila.estadoEntrega ? (
        <Pill tone={fila.estadoEntrega.color === "verde" ? "success" : fila.estadoEntrega.color === "rojo" ? "critical" : "neutral"}>
          {fila.estadoEntrega.estado}
        </Pill>
      ) : (
        <Pill tone="neutral">entrega sin medir</Pill>
      )}
      {/* Cupo físico: los tres estados que NO son un porcentaje se nombran. */}
      {estado === null ? (
        <Pill tone="neutral">cupo sin leer</Pill>
      ) : estado === "sin_limite" ? (
        <Pill tone="critical">sin límite físico</Pill>
      ) : estado === "frenado" ? (
        <Pill tone="critical">frenado: difiere todo</Pill>
      ) : estado === "ilegal" ? (
        <Pill tone="critical">cap {fila.cupo?.cap} sobre el techo</Pill>
      ) : estado === "sin_contador" ? (
        <Pill tone="neutral">cap {fila.cupo?.cap} · sin contador hoy</Pill>
      ) : (
        <Pill tone="success">
          {fila.cupo?.consumidoHoy ?? 0} / {fila.cupo?.cap} hoy
        </Pill>
      )}
    </li>
  );
}

/* ============================================================
 * Kill Switch Block (always-dark) — intacto
 * ============================================================ */

interface KillSwitchBlockProps {
  ks: DashboardData["killSwitch"];
}

function KillSwitchBlock({ ks }: KillSwitchBlockProps) {
  const armed = !ks.enabled;
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (payload: { enabled: boolean; reason: string; actorId: string }) => {
      const res = await fetch("/v1/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ""}`);
      }
      return res.json() as Promise<{ killSwitch: { enabled: boolean } }>;
    },
    onSuccess: (result) => {
      const nowEnabled = result.killSwitch.enabled;
      toast.success(
        nowEnabled ? "Interruptor de corte ACTIVADO" : "Interruptor de corte rearmado",
        {
          description: nowEnabled
            ? "Cola local del worker bloqueada. NO corta el warmup en curso ni el correo del otro inquilino. Audit event escrito."
            : "Cola local del worker disponible. Audit event escrito."
        }
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-panel", "dashboard"] });
      setModalOpen(false);
    },
    onError: (error) => {
      toast.error("No se pudo cambiar el interruptor de corte", {
        description: error instanceof Error ? error.message : "Error desconocido"
      });
    }
  });

  const responsable = ks.updatedBy || "sin registro";
  const updatedAt = ks.updatedAt
    ? new Date(ks.updatedAt).toLocaleString("es-CO", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "—";

  const buttonBg = "var(--color-always-dark-bg)";
  const buttonBorder = "1px solid var(--color-always-dark-border-strong)";

  return (
    <>
      <section
        className="flex flex-col overflow-hidden rounded-[10px]"
        style={{
          background: "var(--color-always-dark-bg)",
          border: "1px solid var(--color-always-dark-border)"
        }}
      >
        <div
          className="flex items-start gap-4 p-5"
          style={{ borderBottom: "1px solid var(--color-always-dark-border)" }}
        >
          <div
            className="grid size-10 shrink-0 place-items-center rounded-md"
            style={{
              background: armed
                ? "var(--color-on-dark-success-overlay)"
                : "var(--color-on-dark-critical-overlay)",
              color: "var(--color-on-dark-strong)"
            }}
            aria-hidden="true"
          >
            <Power size={18} strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-[10px] font-semibold uppercase leading-none"
                style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
              >
                Interruptor de corte
              </span>
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[10px] font-medium"
                style={{
                  background: armed
                    ? "var(--color-on-dark-success-overlay)"
                    : "var(--color-on-dark-critical-overlay)",
                  color: "var(--color-on-dark-strong)"
                }}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background: armed ? "var(--color-success)" : "var(--color-critical)"
                  }}
                />
                {armed ? "Armado" : "Activado"}
              </span>
            </div>
            <h2
              className="m-0 font-heading text-[16px] font-semibold leading-[1.25]"
              style={{ color: "var(--color-on-dark-strong)", letterSpacing: "-0.01em" }}
            >
              {armed
                ? "Cola del worker disponible · listo para corte de emergencia"
                : "Cola del worker bloqueada · corte de emergencia activo"}
            </h2>
            <p
              className="m-0 font-sans text-[12.5px] leading-[1.5]"
              style={{ color: "var(--color-on-dark-medium)", maxWidth: 520 }}
            >
              {ks.reason
                ? `Razón · ${ks.reason}`
                : "Sin uso registrado. Cualquier acción queda en audit chain con el operador responsable."}
            </p>
          </div>
          <div className="hidden flex-col items-end gap-1 lg:flex">
            <span
              className="font-mono text-[10px] uppercase"
              style={{ color: "var(--color-on-dark-soft)", letterSpacing: "0.14em" }}
            >
              Responsable
            </span>
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--color-on-dark-strong)" }}
            >
              {responsable}
            </span>
            <span
              className="font-mono text-[10px]"
              style={{ color: "var(--color-on-dark-soft)" }}
            >
              {updatedAt}
            </span>
          </div>
        </div>

        {/* ALCANCE REAL del interruptor, verificado el 2026-08-06. Decía "1 firma operador ·
            audit chain SHA-256 · rol elevado obligatorio" sobre un POST que no valida token, HMAC
            ni rol (el endpoint vecino de mutación SÍ valida HMAC, así que la asimetría no es
            "todavía no hay auth": a este control, el más peligroso de la pantalla, se le olvidó),
            y el título prometía "Pipeline de envío bloqueado" sobre un freno que el único proceso
            que hoy manda correo no mira. De la frase original solo era cierto el SHA-256. */}
        <div className="flex flex-col gap-3 p-5">
          <div
            className="flex flex-col gap-1.5 rounded-md p-3"
            style={{ border: "1px solid var(--color-always-dark-border)" }}
          >
            <span className="font-sans text-[11px]" style={{ color: "var(--color-on-dark-strong)" }}>
              <strong>Corta:</strong> la cola local del worker (<code>runtime/kill-switch.json</code>) —
              hoy no hay ningún proceso worker corriendo.
            </span>
            <span className="font-sans text-[11px]" style={{ color: "var(--color-on-dark-strong)" }}>
              <strong>NO corta:</strong> el daemon de warmup, que usa su propio freno
              (<code>runtime/warmup-live.kill</code>), ni el tráfico del otro inquilino, que entra
              por SMTP 587 directo al nodo, fuera del gateway.
            </span>
            <span className="font-sans text-[11px]" style={{ color: "var(--color-on-dark-medium)" }}>
              <strong>Autorización:</strong> este endpoint no valida token ni rol. El{" "}
              <code>actorId</code> es texto libre y el evento de auditoría queda{" "}
              <code>humanApproved:false</code>. La cadena SHA-256 sí es real.
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="font-sans text-[11px]"
            style={{ color: "var(--color-on-dark-medium)" }}
          >
            1 firma operador · audit chain SHA-256.
          </span>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={mutation.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 font-sans text-[13px] font-semibold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: buttonBg,
              border: buttonBorder,
              color: "var(--color-on-dark-strong)",
              cursor: mutation.isPending ? "wait" : "pointer"
            }}
          >
            <Power size={13} strokeWidth={1.75} />
            {mutation.isPending
              ? "Procesando…"
              : armed
              ? "Activar interruptor"
              : "Rearmar interruptor"}
          </button>
          </div>
        </div>
      </section>

      {modalOpen ? (
        <KillSwitchModal
          armed={armed}
          isPending={mutation.isPending}
          onCancel={() => setModalOpen(false)}
          onConfirm={(reason, actorId) => mutation.mutate({ enabled: armed, reason, actorId })}
        />
      ) : null}
    </>
  );
}

/* ============================================================
 * Modal de confirmación KillSwitch — intacto
 * ============================================================ */

function KillSwitchModal({
  armed,
  isPending,
  onCancel,
  onConfirm
}: {
  armed: boolean;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, actorId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [actorId, setActorId] = useState("");

  const activating = armed;
  const reasonValid = !activating || reason.trim().length >= 4;
  const actorValid = actorId.trim().length >= 2;
  const canSubmit = reasonValid && actorValid && !isPending;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onConfirm(reason.trim(), actorId.trim());
  }, [canSubmit, reason, actorId, onConfirm]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cluster-killswitch-modal-title"
      className="fixed inset-0 z-[9990] flex items-start justify-center overflow-y-auto px-4 py-4"
      style={{
        background: "color-mix(in srgb, var(--color-always-dark-bg) 62%, transparent)",
        // Safari exige el prefijo -webkit para el desenfoque del scrim del modal.
        WebkitBackdropFilter: "blur(4px)",
        backdropFilter: "blur(4px)"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        className="my-auto flex w-full max-w-[460px] flex-col overflow-hidden rounded-[10px]"
        style={{
          background: "var(--color-always-dark-surface)",
          border: "1px solid var(--color-always-dark-border-strong)",
          boxShadow: "var(--shadow-lg)",
          maxHeight: "calc(100dvh - 32px)"
        }}
      >
        <header
          className="flex shrink-0 items-start gap-3 p-5"
          style={{ borderBottom: "1px solid var(--color-always-dark-border)" }}
        >
          <div
            className="grid size-9 shrink-0 place-items-center rounded-md"
            style={{
              background: activating
                ? "var(--color-on-dark-critical-overlay)"
                : "var(--color-on-dark-success-overlay)",
              color: "var(--color-on-dark-strong)"
            }}
            aria-hidden="true"
          >
            <ShieldCheck size={16} strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id="cluster-killswitch-modal-title"
              className="m-0 font-heading text-[15px] font-semibold leading-[1.25]"
              style={{ color: "var(--color-on-dark-strong)", letterSpacing: "-0.01em" }}
            >
              {activating ? "Activar interruptor de corte" : "Rearmar interruptor"}
            </h2>
            <span
              className="font-sans text-[11.5px] leading-[1.4]"
              style={{ color: "var(--color-on-dark-medium)" }}
            >
              {activating
                ? "Bloqueará la cola local del worker. NO frena el warmup en curso ni el tráfico del otro inquilino por 587. Acción reversible y auditada."
                : "Restaurará la cola local del worker. Audit event escrito."}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="grid size-7 shrink-0 place-items-center rounded transition-colors hover:bg-[var(--color-on-dark-hint)] disabled:cursor-not-allowed"
            style={{ color: "var(--color-on-dark-medium)" }}
            aria-label="Cancelar"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {activating ? (
            <label className="flex flex-col gap-1.5">
              <span
                className="font-mono text-[10px] font-semibold uppercase"
                style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
              >
                Razón <span style={{ color: "var(--color-critical)" }}>*</span>
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej: pico de quejas detectado en clúster A; dry-run no resolvió."
                rows={3}
                disabled={isPending}
                className="w-full rounded-md px-3 py-2 font-sans text-[12.5px] leading-[1.45] outline-none transition-colors focus:border-white/40"
                style={{
                  background: "var(--color-always-dark-bg)",
                  border: "1px solid var(--color-always-dark-border)",
                  color: "var(--color-on-dark-strong)",
                  resize: "vertical",
                  minHeight: 72
                }}
              />
              {!reasonValid && reason.length > 0 ? (
                <span className="font-sans text-[11px]" style={{ color: "var(--color-critical)" }}>
                  Mínimo 4 caracteres.
                </span>
              ) : null}
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[10px] font-semibold uppercase"
              style={{ color: "var(--color-on-dark-medium)", letterSpacing: "0.14em" }}
            >
              Operador (texto libre · el endpoint no lo verifica) <span style={{ color: "var(--color-critical)" }}>*</span>
            </span>
            <input
              type="text"
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              placeholder="op-juanes-a / op-mariana-b"
              disabled={isPending}
              autoFocus
              className="w-full rounded-md px-3 py-2 font-mono text-[12.5px] outline-none transition-colors focus:border-white/40"
              style={{
                background: "var(--color-always-dark-bg)",
                border: "1px solid var(--color-always-dark-border)",
                color: "var(--color-on-dark-strong)"
              }}
            />
            <span
              className="font-sans text-[10.5px]"
              style={{ color: "var(--color-on-dark-soft)" }}
            >
              Queda escrito en la cadena tal cual lo escribas: el gateway no valida token ni rol,
              así que este campo es una declaración, no una autenticación.
            </span>
          </label>
        </div>

        <footer
          className="flex shrink-0 items-center justify-end gap-2 p-4"
          style={{
            background: "var(--color-always-dark-bg)",
            borderTop: "1px solid var(--color-always-dark-border)"
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center rounded-md px-3.5 py-2 font-sans text-[12.5px] font-semibold transition-colors hover:bg-[var(--color-on-dark-hint)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: "transparent",
              color: "var(--color-on-dark-medium)",
              border: "1px solid var(--color-always-dark-border)"
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md px-3.5 py-2 font-sans text-[12.5px] font-semibold transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: activating ? "var(--color-critical)" : "var(--color-success)",
              color: "var(--color-on-dark-strong)",
              border: "none",
              cursor: canSubmit ? "pointer" : "not-allowed"
            }}
          >
            <Power size={12} strokeWidth={1.75} />
            {isPending
              ? "Procesando…"
              : activating
              ? "Confirmar activación"
              : "Confirmar rearmado"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
 * Footer — molde Card
 * ============================================================ */

/* FooterBar: BORRADO. Ofrecía "Runbook · clústeres y kill switch" apuntando a
 * https://docs.delivrix.dev/runbooks/clusters, que responde NXDOMAIN (delivrix.dev tampoco
 * resuelve), y anunciaba "GET /v1/admin/clusters", el endpoint de fixtures que esta vista dejó de
 * consumir. La documentación real vive en DOCUMENTACION/ dentro del repo. */

/* ============================================================
 * Helpers: BORRADOS con los fixtures.
 *
 * `inferClusterStatus` reportaba "Pausado" cuando un clúster tenía 0 nodos —alguien lo pausó vs.
 * no tiene nodos asignados son dos situaciones distintas y la segunda es la que hay que ir a
 * arreglar—, y `normalizeNodeStatus`/`statusDot` traducían el enum del registro de fixtures.
 * Nada de eso tiene consumidor con el inventario real: el estado de un nodo ahora sale de su cupo
 * físico y de la medición de entrega, los dos calculados en el gateway.
 * ============================================================ */
