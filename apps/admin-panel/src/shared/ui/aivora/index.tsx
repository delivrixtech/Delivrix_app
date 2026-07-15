/**
 * Primitivos "Aivora" — el MOLDE oficial extraído tal cual del demo aprobado
 * (features/overview/TravigueOverviewProto.tsx). NO improvisar: cualquier vista de
 * la plataforma se construye reusando ESTOS componentes para verse igual al demo.
 *
 * Diferencia vs el demo: el demo coloreaba con un objeto JS `T`; acá los colores salen
 * de los TOKENS CSS (var(--color-*)), que ya tienen los valores EXACTOS del demo en
 * tokens.css. Así los primitivos son theme-aware (negro/claro) sin duplicar la paleta.
 *
 * Geometría/estructura calcadas del demo: card radius 18 + hairline + shadow-sm; KPI tile
 * neutro + número tabular + delta + sparkline; StateBadge dot+icono+label; PlacementGauge
 * arco 270°; Spark área+dot de acento; SectionHead eyebrow+h1 light.
 */
import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import {
  Flame, CircleCheck, Pause, ShieldAlert, Sprout, CircleDot, Ban,
  TriangleAlert, Clock, ArrowUp, ArrowDown, type LucideIcon,
} from "lucide-react";

/* Superficies sutiles del demo (tile/track) como overlays del texto → theme-aware. */
const TILE = "color-mix(in srgb, var(--color-text-primary) 5%, transparent)";
const TRACK = "color-mix(in srgb, var(--color-text-primary) 8%, transparent)";
const GRAD =
  "linear-gradient(135deg, var(--color-gradient-start), var(--color-gradient-mid) 52%, var(--color-gradient-end))";

export const aivoraGradient = GRAD;

/* ── Card FLAT premium (demo): superficie sólida + hairline + shadow-sm. Sin blur.
 * `ink`: card NEGRA en modo claro (inlay del demo), sin cambio en modo oscuro. ── */
export function Card({
  children, style, className, onClick, ink,
}: { children: ReactNode; style?: CSSProperties; className?: string; onClick?: () => void; ink?: boolean }) {
  const cls = [ink ? "ink-card" : null, className].filter(Boolean).join(" ") || undefined;
  return (
    <div
      className={cls}
      onClick={onClick}
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 18,
        boxShadow: "var(--shadow-sm)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── SectionHead (demo): eyebrow uppercase + h1 peso light + subtítulo mid ── */
export function SectionHead({
  eyebrow, title, subtitle, right,
}: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? (
          <div style={{ fontSize: 11, letterSpacing: ".16em", color: "var(--color-text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}>
            {eyebrow}
          </div>
        ) : null}
        <h1 style={{ margin: eyebrow ? "8px 0 0" : 0, fontSize: 30, fontWeight: 300, letterSpacing: "-0.02em", color: "var(--color-text-primary)" }}>
          {title}
        </h1>
        {subtitle ? (
          <div style={{ marginTop: 6, fontSize: 13.5, color: "var(--color-text-secondary)" }}>{subtitle}</div>
        ) : null}
      </div>
      {right ? <div style={{ flex: "none" }}>{right}</div> : null}
    </div>
  );
}

/* ── Spark (demo): sparkline de ACENTO, área+gradiente soft + dot final. Full-width, se
 * estira solo en X (non-scaling-stroke); el dot es HTML para no ovalarse. DATOS REALES:
 * pasá `data` (serie numérica); si no hay serie real, no se renderiza (nada mock). ── */
export function Spark({ id, data, up }: { id: string; data?: number[]; up?: boolean }) {
  const raw =
    data && data.length >= 2
      ? data
      : undefined;
  if (!raw) return null;
  const w = 118, h = 36, pad = 4;
  const max = Math.max(...raw), min = Math.min(...raw);
  const span = max - min || 1;
  const step = w / (raw.length - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = raw.map((v, i) => [i * step, y(v)] as const);
  const line = pts.map(([x, yy], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const ey = pts[pts.length - 1][1];
  const rising = up ?? raw[raw.length - 1] >= raw[0];
  void rising; // el color es siempre acento (demo); `up` queda disponible p/ semántica futura
  return (
    <div style={{ position: "relative", width: "100%", height: h }}>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.26} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={{ position: "absolute", right: 0, top: ey, width: 10, height: 10, marginTop: -5, marginRight: -1, borderRadius: "50%", background: "var(--color-accent)", opacity: 0.18, pointerEvents: "none" }} />
      <span style={{ position: "absolute", right: 0, top: ey, width: 5.2, height: 5.2, marginTop: -2.6, marginRight: 1.4, borderRadius: "50%", background: "var(--color-accent)", pointerEvents: "none" }} />
    </div>
  );
}

/* ── KpiCard (demo): tile de icono neutro + label + número grande tabular + delta
 * (verde+/rojo−, texto plano) + sparkline de acento (solo si hay serie real). ── */
export function KpiCard({
  label, value, suffix, icon: Icon, delta, deltaUp, deltaGood, series, sparkId, ink = true,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  icon: LucideIcon;
  delta?: string;
  deltaUp?: boolean;
  deltaGood?: boolean;
  series?: number[];
  sparkId?: string;
  /** inlay negro en modo claro (default true, como el demo). Pasá ink={false} para dejarla clara. */
  ink?: boolean;
}) {
  return (
    <Card ink={ink} style={{ padding: 20, position: "relative", overflow: "hidden" }}>
      {/* glow radial de acento MUY sutil en la esquina (demo) */}
      <div style={{ position: "absolute", right: -30, bottom: -40, width: 160, height: 160, background: "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "relative", width: 38, height: 38, borderRadius: 12, background: TILE, border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
        <Icon size={18} color="var(--color-text-secondary)" strokeWidth={1.7} />
      </div>
      <div style={{ position: "relative", fontSize: 13, color: "var(--color-text-secondary)", marginTop: 16 }}>{label}</div>
      <div style={{ position: "relative", fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--color-text-primary)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
        {value}
        {suffix ? <span style={{ fontSize: 16, color: "var(--color-text-tertiary)", fontWeight: 500 }}>{suffix}</span> : null}
      </div>
      {delta ? (
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3, marginTop: 6, fontSize: 12.5, fontWeight: 600, color: deltaGood ? "var(--color-success)" : "var(--color-critical)" }}>
          {deltaUp ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{delta}
        </div>
      ) : null}
      {series && series.length >= 2 ? (
        <div style={{ position: "relative", marginTop: 12 }}>
          <Spark id={sparkId ?? `sp-${label.replace(/\s+/g, "-")}`} data={series} up={deltaUp} />
        </div>
      ) : null}
    </Card>
  );
}

/* ── StateBadge (demo): dot + icono + label, coloreado por token semántico. Soporta el
 * enum REAL de SenderNodeStatusContract + los estados de warmup del demo. ── */
type BadgeVisual = { label: string; color: string; soft: string; Icon: LucideIcon; pulse?: boolean };

const STATE_MAP: Record<string, BadgeVisual> = {
  // enum real de sender nodes
  active: { label: "Activa", color: "var(--color-success)", soft: "var(--color-success-soft)", Icon: CircleCheck },
  warming: { label: "Calentando", color: "var(--color-warming)", soft: "var(--color-warming-soft)", Icon: Flame, pulse: true },
  paused: { label: "Pausada", color: "var(--color-warning)", soft: "var(--color-warning-soft)", Icon: Pause },
  quarantined: { label: "Cuarentena", color: "var(--color-critical)", soft: "var(--color-critical-soft)", Icon: ShieldAlert },
  degraded: { label: "Degradada", color: "var(--color-warning)", soft: "var(--color-warning-soft)", Icon: TriangleAlert },
  retired_pending_approval: { label: "Baja pendiente", color: "var(--color-text-tertiary)", soft: "var(--color-neutral-soft)", Icon: Clock },
  retired: { label: "Retirada", color: "var(--color-text-tertiary)", soft: "var(--color-neutral-soft)", Icon: Ban },
  // estados de warmup del demo (por si se usan directo)
  FRESH: { label: "Fresh", color: "var(--color-text-tertiary)", soft: "var(--color-neutral-soft)", Icon: Sprout },
  READY: { label: "Ready", color: "var(--color-text-secondary)", soft: "var(--color-neutral-soft)", Icon: CircleDot },
  WARMING: { label: "Warming", color: "var(--color-warming)", soft: "var(--color-warming-soft)", Icon: Flame, pulse: true },
  WARM: { label: "Warm", color: "var(--color-success)", soft: "var(--color-success-soft)", Icon: CircleCheck },
  PAUSED: { label: "Paused", color: "var(--color-warning)", soft: "var(--color-warning-soft)", Icon: Pause },
  QUARANTINED: { label: "Quarantined", color: "var(--color-critical)", soft: "var(--color-critical-soft)", Icon: ShieldAlert },
  BLOCKED: { label: "Blocked", color: "var(--color-text-tertiary)", soft: "var(--color-neutral-soft)", Icon: Ban },
};

export function StateBadge({ status, label }: { status: string; label?: string }) {
  const st = STATE_MAP[status] ?? { label: status, color: "var(--color-text-tertiary)", soft: "var(--color-neutral-soft)", Icon: CircleDot };
  const Ic = st.Icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px 3px 7px", borderRadius: 999, background: st.soft, color: st.color, fontSize: 12, fontWeight: 500 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.color, boxShadow: st.pulse ? `0 0 6px ${st.color}` : "none" }} />
      <Ic size={12.5} strokeWidth={2} />{label ?? st.label}
    </span>
  );
}

/** ¿el estado lleva left-border en filas de tabla? (demo: solo los "malos"/pausados) */
export function stateNeedsLeftBorder(status: string): boolean {
  return ["quarantined", "paused", "degraded", "retired", "QUARANTINED", "PAUSED", "BLOCKED"].includes(status);
}
export function stateColor(status: string): string {
  return (STATE_MAP[status] ?? { color: "var(--color-text-tertiary)" }).color;
}

/* ── PlacementGauge (demo): arco radial 270°, número central tabular, color por umbral. ── */
export function PlacementGauge({ value, label }: { value: number; label: string }) {
  const c = value >= 90 ? "var(--color-success)" : value >= 75 ? "var(--color-warning)" : "var(--color-critical)";
  const R = 46, cx = 60, cy = 60, start = 135, sweep = 270;
  const rad = (a: number) => (a * Math.PI) / 180;
  const pt = (a: number) => [cx + R * Math.cos(rad(a)), cy + R * Math.sin(rad(a))];
  const [x0, y0] = pt(start), [x1, y1] = pt(start + (sweep * value) / 100);
  const large = (sweep * value) / 100 > 180 ? 1 : 0;
  const [xe, ye] = pt(start + sweep);
  return (
    <div style={{ textAlign: "center" }}>
      <svg viewBox="0 0 120 120" aria-hidden style={{ width: "100%", maxWidth: 118, height: "auto", margin: "0 auto", display: "block" }}>
        <path d={`M ${x0} ${y0} A ${R} ${R} 0 1 1 ${xe} ${ye}`} fill="none" stroke={TRACK} strokeWidth="8" strokeLinecap="round" />
        <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`} fill="none" stroke={c} strokeWidth="8" strokeLinecap="round" />
        <text x="60" y="60" textAnchor="middle" fontSize="24" fontWeight="600" fill="var(--color-text-primary)" style={{ fontVariantNumeric: "tabular-nums" }}>{value}</text>
        <text x="60" y="78" textAnchor="middle" fontSize="10" fill="var(--color-text-tertiary)">inbox %</text>
      </svg>
      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: -6 }}>{label}</div>
    </div>
  );
}

/* ── AvatarGroup (demo): avatares circulares solapados (firma del Project Timeline). ── */
export function AvatarGroup({ items, tint }: { items: string[]; tint?: string }) {
  const ring = tint ?? "var(--color-accent)";
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {items.map((t, i) => (
        <div key={i} style={{
          width: 24, height: 24, borderRadius: "50%", background: "var(--color-surface-raised)",
          border: "2px solid var(--color-surface)", display: "grid", placeItems: "center", fontSize: 10.5,
          fontWeight: 600, color: "var(--color-text-primary)", marginLeft: i === 0 ? 0 : -8,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${ring} 40%, transparent)`,
        }}>{t}</div>
      ))}
    </div>
  );
}

/* ── AdvisorCard (demo): la ÚNICA superficie con gradiente/sparkle — patrón OpenClaw. ── */
export function AdvisorCard({ children, style, ink = true }: { children: ReactNode; style?: CSSProperties; ink?: boolean }) {
  return (
    <div className={ink ? "ink-card" : undefined} style={{
      background: "var(--color-surface)", borderRadius: 18, position: "relative", overflow: "hidden",
      border: "1px solid var(--color-accent-soft)", boxShadow: "var(--shadow-md)", ...style,
    }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 80% at 0% 0%, var(--color-accent-soft), transparent 55%)", pointerEvents: "none" }} />
      <div style={{ position: "relative" }}>{children}</div>
    </div>
  );
}

/* ============================================================================
 * PIEZAS COMPARTIDAS (reemplazan a v5/components/primitives.tsx B/N). FUENTE ÚNICA:
 * toda pantalla usa ESTAS, no las viejas. Tipografía/colores del demo, por tokens.
 * ========================================================================== */

/* Eyebrow: label uppercase del demo (sans, no mono). */
export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 11, letterSpacing: ".16em", color: "var(--color-text-tertiary)", fontWeight: 600, textTransform: "uppercase", ...style }}>{children}</div>;
}

/* Caption: meta/subcopy 12px dim. */
export function Caption({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", ...style }}>{children}</div>;
}

/* Heading: jerarquía del demo — h1 grande light (30/300), h2 15/500, h3 14/500. */
export function Heading({ level = 2, children, style }: { level?: 1 | 2 | 3; children: ReactNode; style?: CSSProperties }) {
  const sizes = { 1: { fontSize: 30, fontWeight: 300, letterSpacing: "-0.02em" }, 2: { fontSize: 15, fontWeight: 500 }, 3: { fontSize: 14, fontWeight: 500 } } as const;
  const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
  return <Tag style={{ margin: 0, color: "var(--color-text-primary)", ...sizes[level], ...style }}>{children}</Tag>;
}

/* Button: primario (acento), gradiente IA (solo CTA/advisor), ghost, danger. Del demo.
 * forwardRef + spread de ...rest: reenvía la ref y propaga props inyectadas (Radix asChild /
 * Slot: handlers de pointer/focus, aria-describedby, data-state) al <button>, para que
 * envolverlo en <Tooltip>/<Popover> funcione en todos los consumidores. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "gradient" | "ghost" | "danger";
  size?: "sm" | "md";
  children: ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", children, disabled, type = "button", style, ...rest },
  ref,
) {
  const base: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, border: "none", cursor: disabled ? "not-allowed" : "pointer", borderRadius: 10, fontWeight: 600, fontSize: size === "sm" ? 12.5 : 13, padding: size === "sm" ? "6px 12px" : "8px 16px", opacity: disabled ? 0.55 : 1, whiteSpace: "nowrap" };
  const variants: Record<string, CSSProperties> = {
    gradient: { background: GRAD, color: "#fff", boxShadow: "var(--shadow-sm)" },
    primary: { background: "var(--color-accent)", color: "var(--color-accent-fg)" },
    ghost: { background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)" },
    danger: { background: "var(--color-critical-soft)", color: "var(--color-critical)" },
  };
  return <button ref={ref} type={type} disabled={disabled} style={{ ...base, ...variants[variant], ...style }} {...rest}>{children}</button>;
});

/* Pill/Chip: badge redondeado por tono semántico (token). */
export function Pill({ children, tone = "neutral", style }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "critical" | "warming" | "info"; style?: CSSProperties }) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: "var(--color-neutral-soft)", fg: "var(--color-text-secondary)" },
    accent: { bg: "var(--color-accent-soft)", fg: "var(--color-accent)" },
    success: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
    warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
    critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" },
    warming: { bg: "var(--color-warming-soft)", fg: "var(--color-warming)" },
    info: { bg: "var(--color-info-soft)", fg: "var(--color-info)" },
  };
  const t = tones[tone] || tones.neutral;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: t.bg, color: t.fg, ...style }}>{children}</span>;
}

/* Row: fila con hairline (para APLANAR card-in-card → filas dentro de un Card padre). */
export function Row({ children, onClick, last, style }: { children: ReactNode; onClick?: () => void; last?: boolean; style?: CSSProperties }) {
  return (
    <div onClick={onClick} className={onClick ? "aiv-row" : undefined} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: last ? "none" : "1px solid var(--color-border)", cursor: onClick ? "pointer" : "default", ...style }}>
      {children}
    </div>
  );
}

/* DataTable: tabla estilada del demo (th uppercase dim, filas con hairline, números tabulares).
 * Para reemplazar tablas markdown crudas y las tablas bespoke del canvas. */
export function DataTable({ headers, rows, align }: { headers: ReactNode[]; rows: ReactNode[][]; align?: ("left" | "right" | "center")[] }) {
  const a = (i: number) => (align && align[i]) || "left";
  return (
    <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ textAlign: a(i), padding: "9px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--color-text-tertiary)", borderBottom: "1px solid var(--color-border)", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} style={{ borderBottom: ri < rows.length - 1 ? "1px solid var(--color-border)" : "none" }}>
              {r.map((c, ci) => (
                <td key={ci} style={{ padding: "10px 14px", textAlign: a(ci), color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
