/**
 * DEMO direccion "Aivora" (Behance 252257649) aplicada a Delivrix.
 * Look Aivora REAL: canvas CARBON suave (no negro duro), cards FLAT premium (hairline +
 * glow radial MUY sutil, sin blur/reflejo), nav activo = pildora blanco-translucida,
 * sparklines TODAS de acento con area+dot, KPI tiles neutros (color solo en delta verde y
 * sparkline), Project Timeline de rampa/warmup con grupos de avatares, tipografia Inter light,
 * numeros tabulares. Acento = FUENTE UNICA: la constante ACCENT (una linea) recolorea
 * sparklines, glow, botones, advisor, gradiente y sombras en los 3 temas.
 * Advisor OpenClaw = unica superficie con gradiente/sparkle.
 *
 * TRI-TEMA: selector en la topbar — "Oscuro" (carbon), "Negro" (mas oscuro), "Claro" (white/black).
 * SOLO cambian tokens de color; geometria/alineaciones/jerarquias/renglones son identicos entre temas.
 */
import { useState } from "react";
import {
  LayoutDashboard, Inbox, Target, TrendingUp, ListX, ScrollText, Sparkles, Settings,
  Search, Bell, Command, ArrowUp, ArrowDown, Flame, CircleCheck, Pause, ShieldAlert,
  Sprout, CircleDot, Ban, Server, ShieldCheck, Rocket, Sun, Moon,
} from "lucide-react";

type Palette = Record<string, string>;

/* ============================================================================
 * ACENTO — FUENTE UNICA. Cambia SOLO esta linea (azul <-> violeta <-> lo que sea)
 * y TODO el acento (sparklines, glow KPI, botones, advisor, gradiente, sombras)
 * se recolorea en los TRES temas. Los tintes se derivan de ACCENT por alpha/lighten/darken. */
const ACCENT = "#4C8DF5";

// hex8: agrega alpha (0..1) a un hex #rrggbb -> #rrggbbaa
const hexa = (hex: string, alpha: number) =>
  hex + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
// mezcla hacia blanco (amt>0) o negro (amt<0). Deriva los stops del gradiente desde ACCENT.
function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  const mix = (ch: number) => Math.round((t - ch) * p + ch);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
// TODO el acento sale de aca: cambiar `base` (o ACCENT) recolorea todo.
const accentTokens = (base: string) => ({
  accent: base,
  accentSoft: hexa(base, 0.14),
  accentGlow: hexa(base, 0.1),
  accentGrad: `linear-gradient(135deg,${shade(base, 0.35)} 0%,${base} 52%,${shade(base, -0.32)} 100%)`,
  accentShadow: `0 8px 26px -10px ${hexa(base, 0.5)}`,
});
// El tema claro usa el mismo acento pero un paso mas oscuro (contraste sobre blanco), tambien derivado.
const ACCENT_LIGHT = shade(ACCENT, -0.28);

/* Tres paletas. Misma estructura de tokens => mismo layout, distinto color. Acento = FUENTE UNICA. */
const THEMES: Record<"dark" | "light", Palette> = {
  // NEGRO (dark) — canvas casi-negro, maximo contraste/profundidad (el que elegiste)
  dark: {
    ...accentTokens(ACCENT),
    bg: "#08080B", panel: "#0B0B0F", surface: "#101015", raised: "#191920", inset: "#050507",
    border: "rgba(255,255,255,.06)", borderS: "rgba(255,255,255,.10)",
    hi: "#F5F6F8", mid: "#8F9198", dim: "#55575E",
    pill: "rgba(255,255,255,.075)",
    success: "#3FB27F", successSoft: "rgba(63,178,127,.14)",
    danger: "#E8654E", dangerSoft: "rgba(232,101,78,.14)",
    warning: "#E0C04A", warningSoft: "rgba(224,192,74,.14)",
    orange: "#C9702E", orangeSoft: "rgba(201,112,46,.17)",
    tile: "rgba(255,255,255,.045)", track: "rgba(255,255,255,.06)", rowHover: "rgba(255,255,255,.028)",
    topbar: "rgba(8,8,11,.85)", neutralSoft: "rgba(150,152,160,.14)",
    shadow: "0 1px 2px rgba(0,0,0,.4)",
  },
  // CLARO — white/black. Fondo off-white, cards blancas, texto casi-negro, mismo acento derivado.
  light: {
    ...accentTokens(ACCENT_LIGHT),
    bg: "#F5F6F8", panel: "#FFFFFF", surface: "#FFFFFF", raised: "#EEF0F3", inset: "#F1F2F5",
    border: "rgba(17,20,28,.09)", borderS: "rgba(17,20,28,.15)",
    hi: "#14161C", mid: "#565A63", dim: "#8B8F98",
    pill: "rgba(17,20,28,.06)",
    success: "#1F9E63", successSoft: "rgba(31,158,99,.12)",
    danger: "#D8452C", dangerSoft: "rgba(216,69,44,.11)",
    warning: "#B98A0E", warningSoft: "rgba(185,138,14,.13)",
    orange: "#B4611F", orangeSoft: "rgba(180,97,31,.12)",
    tile: "rgba(17,20,28,.04)", track: "rgba(17,20,28,.07)", rowHover: "rgba(17,20,28,.025)",
    topbar: "rgba(255,255,255,.85)", neutralSoft: "rgba(17,20,28,.05)",
    shadow: "0 1px 2px rgba(17,20,28,.06), 0 2px 6px -2px rgba(17,20,28,.06)",
  },
};

const stateMap = (T: Palette): Record<string, { label: string; c: string; soft: string; Icon: any }> => ({
  FRESH: { label: "Fresh", c: T.dim, soft: T.neutralSoft, Icon: Sprout },
  READY: { label: "Ready", c: T.mid, soft: T.neutralSoft, Icon: CircleDot },
  WARMING: { label: "Warming", c: T.orange, soft: T.orangeSoft, Icon: Flame },
  WARM: { label: "Warm", c: T.success, soft: T.successSoft, Icon: CircleCheck },
  PAUSED: { label: "Paused", c: T.warning, soft: T.warningSoft, Icon: Pause },
  QUARANTINED: { label: "Quarantined", c: T.danger, soft: T.dangerSoft, Icon: ShieldAlert },
  BLOCKED: { label: "Blocked", c: T.dim, soft: T.neutralSoft, Icon: Ban },
});

function StateBadge({ s, T }: { s: string; T: Palette }) {
  const st = stateMap(T)[s]; const Ic = st.Icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px 3px 7px", borderRadius: 999, background: st.soft, color: st.c, fontSize: 12, fontWeight: 500 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.c, boxShadow: s === "WARMING" ? `0 0 6px ${st.c}` : "none" }} />
      <Ic size={12.5} strokeWidth={2} />{st.label}
    </span>
  );
}

/* Sparkline Aivora: SIEMPRE de acento, con area/gradiente soft + dot al final.
 * En KPI va full-width DEBAJO del numero (como Aivora): el SVG estira solo en X
 * (preserveAspectRatio=none + non-scaling-stroke), y el dot final es un elemento HTML
 * posicionado al borde derecho para que quede circular (no ovalado por el estiramiento). */
function Spark({ id, up = true, T }: { id: string; up?: boolean; T: Palette }) {
  const raw = up ? [8, 10, 9, 13, 12, 16, 15, 20, 19, 24, 26, 31] : [30, 28, 29, 24, 22, 20, 18, 16, 15, 12, 11, 9];
  const w = 118, h = 36, max = 33, step = w / (raw.length - 1), pad = 4;
  const pts = raw.map((v, i) => [i * step, h - pad - (v / max) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const ey = pts[pts.length - 1][1]; // Y del ultimo punto (altura fija h => se puede usar en px)
  return (
    <div style={{ position: "relative", width: "100%", height: h }}>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={T.accent} stopOpacity={0.26} />
            <stop offset="100%" stopColor={T.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={T.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* dot final circular (HTML, inmune al estiramiento en X) */}
      <span style={{ position: "absolute", right: 0, top: ey, width: 10, height: 10, marginTop: -5, marginRight: -1, borderRadius: "50%", background: T.accent, opacity: 0.18, pointerEvents: "none" }} />
      <span style={{ position: "absolute", right: 0, top: ey, width: 5.2, height: 5.2, marginTop: -2.6, marginRight: 1.4, borderRadius: "50%", background: T.accent, pointerEvents: "none" }} />
    </div>
  );
}

function PlacementGauge({ v, label, T }: { v: number; label: string; T: Palette }) {
  const c = v >= 90 ? T.success : v >= 75 ? T.warning : T.danger;
  const R = 46, cx = 60, cy = 60, start = 135, sweep = 270;
  const rad = (a: number) => (a * Math.PI) / 180;
  const pt = (a: number) => [cx + R * Math.cos(rad(a)), cy + R * Math.sin(rad(a))];
  const [x0, y0] = pt(start), [x1, y1] = pt(start + sweep * v / 100);
  const large = (sweep * v / 100) > 180 ? 1 : 0;
  const [xe, ye] = pt(start + sweep);
  return (
    <div style={{ textAlign: "center" }}>
      <svg width="118" height="106" viewBox="0 0 120 120" aria-hidden style={{ margin: "0 auto", display: "block" }}>
        <path d={`M ${x0} ${y0} A ${R} ${R} 0 1 1 ${xe} ${ye}`} fill="none" stroke={T.track} strokeWidth="8" strokeLinecap="round" />
        <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`} fill="none" stroke={c} strokeWidth="8" strokeLinecap="round" />
        <text x="60" y="60" textAnchor="middle" fontFamily="Inter Variable, Inter" fontSize="24" fontWeight="600" fill={T.hi} style={{ fontVariantNumeric: "tabular-nums" }}>{v}</text>
        <text x="60" y="78" textAnchor="middle" fontSize="10" fill={T.dim}>inbox %</text>
      </svg>
      <div style={{ fontSize: 12.5, color: T.mid, marginTop: -6 }}>{label}</div>
    </div>
  );
}

/* Grupo de avatares solapados (elemento firma de Aivora Project Timeline) */
function AvatarGroup({ items, tint, T }: { items: string[]; tint: string; T: Palette }) {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {items.map((t, i) => (
        <div key={i} style={{
          width: 24, height: 24, borderRadius: "50%", background: T.raised, border: `2px solid ${T.surface}`,
          display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 600, color: T.hi,
          marginLeft: i === 0 ? 0 : -8, boxShadow: `inset 0 0 0 1px ${tint}44`,
        }}>{t}</div>
      ))}
    </div>
  );
}

const nav = [
  ["Dashboard", LayoutDashboard, true, undefined, undefined],
  ["Bandejas", Inbox, false, undefined, undefined],
  ["Placement", Target, false, undefined, undefined],
  ["Rampa", TrendingUp, false, undefined, undefined],
  ["Colas / DLQ", ListX, false, 2, undefined],
  ["Logs", ScrollText, false, undefined, undefined],
  ["Advisor", Sparkles, false, undefined, true],
  ["Ajustes", Settings, false, undefined, undefined],
] as const;

const boxes = [
  { email: "corpannualops@smtp.corpannualops.com", prov: "Postfix", state: "WARM", place: 82, when: "hace 16 h" },
  { email: "corpannualinfra@smtp.corpannualinfra.com", prov: "Postfix", state: "WARMING", place: 61, when: "hace 16 h" },
  { email: "controlannualfiling@smtp.controlannualfiling.com", prov: "Postfix", state: "WARM", place: 78, when: "hace 18 h" },
  { email: "annualfilinginfra@smtp.annualfilinginfra.com", prov: "Postfix", state: "FRESH", place: 0, when: "hace 3 h" },
  { email: "annualfilingcontrol@smtp.annualfilingcontrol.com", prov: "Postfix", state: "PAUSED", place: 44, when: "hace 1 d" },
  { email: "legacy@webdock-quinary.net", prov: "Gmail", state: "QUARANTINED", place: 22, when: "hace 2 d" },
] as const;

/* Fases de la rampa Delivrix (adaptacion del Project Timeline de Aivora).
 * Como en Aivora: el timeline es NEUTRO (avatares + conectores + labels cargan la identidad).
 * El color se reserva SOLO para la fase activa (Warmup = naranja/warming). Las done/futuras van
 * en grises (mid=completada, dim=futura). Nada de azul/verde compitiendo con la estructura. */
const makePhases = (T: Palette) => [
  { name: "Onboarding", sub: "Alta + DNS/DKIM", start: 0, width: 15, color: T.mid, Icon: Sprout, avatars: ["AF", "AC", "AI"], due: "Sem 1", done: true, active: false },
  { name: "Provision", sub: "VPS + Postfix", start: 15, width: 20, color: T.mid, Icon: Server, avatars: ["P1", "P2"], due: "Sem 2", done: true, active: false },
  { name: "Warmup", sub: "Rampa gradual", start: 35, width: 40, color: T.orange, Icon: Flame, avatars: ["CA", "CB", "CC", "+2"], due: "Sem 5", done: false, active: true },
  { name: "Reputacion", sub: "Placement estable", start: 75, width: 25, color: T.dim, Icon: ShieldCheck, avatars: ["G", "O", "Y"], due: "Sem 6", done: false, active: false },
];

const THEME_KEY = "delivrix-theme";
/* Siembra el tema del ajuste del DISPOSITIVO (prefers-color-scheme) y respeta la eleccion previa
 * guardada. Asi el panel arranca en el modo que el usuario ya tiene configurado en su SO. */
function initialTheme(): "dark" | "light" {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch { /* localStorage no disponible */ }
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  }
  return "dark"; // superficie de ops: dark por defecto si el device no indica lo contrario
}

export function TravigueOverviewProto() {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { window.localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  };
  const T = THEMES[theme];
  // Inlays oscuros: en modo CLARO ciertas secciones (sidebar, Advisor) se visten con el
  // negro mas oscuro para cortar el brillo "hospital". En modo oscuro ink === T (sin cambio).
  const ink = theme === "light" ? THEMES.dark : T;
  const phases = makePhases(T);

  // Card FLAT premium: superficie solida + hairline. Sin blur, sin reflejo especular, sin sombra dramatica.
  const card: React.CSSProperties = {
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, boxShadow: T.shadow,
  };
  // Card "inlay" oscura: en modo CLARO usa la paleta negra (reparte el negro para no verse disparejo);
  // en modo oscuro inkCard === card (sin cambio). Sus internos deben usar `ink` para leer sobre negro.
  const inkCard: React.CSSProperties = {
    background: ink.surface, border: `1px solid ${ink.border}`, borderRadius: 18, boxShadow: ink.shadow,
  };
  return (
    <div className="aiv" style={{
      fontFamily: "'Inter Variable', Inter, ui-sans-serif, system-ui", color: T.hi, position: "fixed", inset: 0,
      zIndex: 9999, height: "100vh", display: "flex", WebkitFontSmoothing: "antialiased", fontWeight: 300,
      background: T.bg,
    }}>
      <style>{`.aiv *{ font-variant-numeric:tabular-nums; } .aiv-nav:hover{ background:${ink.raised}; } .aiv-row:hover{ background:${T.rowHover}; }`}</style>
      <div style={{ display: "flex", width: "100%" }}>

        {/* SIDEBAR RAIL 240 — en modo CLARO va en NEGRO (inlay oscuro) para cortar el brillo */}
        <aside style={{ width: 240, flex: "none", background: ink.panel, borderRight: `1px solid ${ink.border}`, padding: "18px 14px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px" }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: ink.accentGrad, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 15, color: "#fff" }}>D</div>
            <div style={{ fontSize: 15.5, fontWeight: 500, letterSpacing: "-0.01em", color: ink.hi }}>Delivrix</div>
          </div>
          <div style={{ fontSize: 10.5, letterSpacing: ".14em", color: ink.dim, fontWeight: 600, padding: "0 8px" }}>MENU</div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {nav.map(([label, Ic, active, badge, ai]) => (
              <div key={label} className="aiv-nav" style={{
                display: "flex", alignItems: "center", gap: 11, padding: "9px 11px", borderRadius: 10, cursor: "pointer",
                background: active ? ink.pill : "transparent", color: active ? ink.hi : ink.mid,
              }}>
                <Ic size={17} strokeWidth={1.6} color={active ? ink.hi : ink.mid} />
                <span style={{ fontSize: 13.5, fontWeight: active ? 500 : 400 }}>{label}</span>
                {ai ? <Sparkles size={12} color={ink.accent} style={{ marginLeft: "auto" }} /> : null}
                {badge ? <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: ink.danger, background: ink.dangerSoft, borderRadius: 999, padding: "1px 7px" }}>{badge}</span> : null}
              </div>
            ))}
          </nav>
          <div style={{ marginTop: "auto", background: ink.inset, border: `1px solid ${ink.border}`, borderRadius: 18, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: ink.success }} /><span style={{ color: ink.mid }}>Kill switch</span><b style={{ marginLeft: "auto", color: ink.success, fontWeight: 600 }}>Armado</b>
          </div>
        </aside>

        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* TOP BAR */}
          <header style={{ height: 60, flex: "none", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 14, padding: "0 24px", position: "sticky", top: 0, background: T.topbar, backdropFilter: "blur(12px)", zIndex: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: T.inset, border: `1px solid ${T.border}`, borderRadius: 999, padding: "7px 12px", width: 280, color: T.dim, fontSize: 13 }}>
              <Search size={15} /><span style={{ flex: 1 }}>Buscar cualquier cosa...</span><span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11 }}><Command size={11} />K</span>
            </div>
            {/* TOGGLE DE TEMA — un solo icono sol/luna (negro <-> claro), sembrado del device */}
            <button onClick={toggleTheme}
              aria-label={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
              title={theme === "dark" ? "Modo claro" : "Modo oscuro"}
              style={{ marginLeft: "auto", display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 10, background: T.inset, border: `1px solid ${T.border}`, color: T.mid, cursor: "pointer" }}>
              {theme === "dark" ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
            </button>
            <button style={{ display: "inline-flex", alignItems: "center", gap: 8, background: T.accentGrad, color: "#fff", border: "none", borderRadius: 12, padding: "9px 15px", fontSize: 13.5, fontWeight: 600, cursor: "pointer", boxShadow: T.accentShadow }}>
              <Sparkles size={15} />Preguntar a Delivrix
            </button>
            <Bell size={18} color={T.mid} />
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.raised, border: `1px solid ${T.border}`, display: "grid", placeItems: "center", fontSize: 12, color: T.mid }}>JE</div>
          </header>

          <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 24, overflow: "auto" }}>
            {/* Bienvenida — eyebrow + h1 light */}
            <div>
              <div style={{ fontSize: 11, letterSpacing: ".16em", color: T.dim, fontWeight: 600 }}>DASHBOARD</div>
              <h1 style={{ margin: "8px 0 0", fontSize: 30, fontWeight: 300, letterSpacing: "-0.02em", color: T.hi }}>
                Bienvenido de nuevo, <span style={{ fontWeight: 500 }}>Juan Es</span>
              </h1>
              <div style={{ marginTop: 6, fontSize: 13.5, color: T.mid }}>6 bandejas en cuenta contabo-2 · rampa activa · placement promedio 76,3%</div>
            </div>

            {/* KPI cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 20 }}>
              {[
                { key: "k1", label: "Bandejas activas", n: "11", Ic: Inbox, delta: "+2", up: true, good: true },
                { key: "k2", label: "Calentando", n: "5", Ic: Flame, delta: "+1", up: true, good: true },
                { key: "k3", label: "Errores DLQ", n: "2", Ic: ListX, delta: "−3", up: false, good: true },
                { key: "k4", label: "Placement prom.", n: "76,3", suf: "%", Ic: Target, delta: "+4,1", up: true, good: true },
              ].map((k) => (
                <div key={k.key} style={{ ...inkCard, padding: 20, position: "relative", overflow: "hidden" }}>
                  {/* glow radial acento MUY sutil en la esquina */}
                  <div style={{ position: "absolute", right: -30, bottom: -40, width: 160, height: 160, background: `radial-gradient(circle, ${ink.accentGlow}, transparent 70%)`, pointerEvents: "none" }} />
                  {/* tile de icono NEUTRO */}
                  <div style={{ position: "relative", width: 38, height: 38, borderRadius: 12, background: ink.tile, border: `1px solid ${ink.border}`, display: "grid", placeItems: "center" }}>
                    <k.Ic size={18} color={ink.mid} strokeWidth={1.7} />
                  </div>
                  <div style={{ position: "relative", fontSize: 13, color: ink.mid, marginTop: 16 }}>{k.label}</div>
                  <div style={{ position: "relative", fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", color: ink.hi, marginTop: 4 }}>
                    {k.n}<span style={{ fontSize: 16, color: ink.dim, fontWeight: 500 }}>{k.suf || ""}</span>
                  </div>
                  {/* sub-delta = texto plano (verde+/rojo-), SIN pildora de fondo, como Aivora */}
                  <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3, marginTop: 6, fontSize: 12.5, fontWeight: 600, color: k.good ? ink.success : ink.danger }}>
                    {k.up ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{k.delta}
                  </div>
                  {/* sparkline de acento full-width DEBAJO del numero */}
                  <div style={{ position: "relative", marginTop: 12 }}>
                    <Spark id={`sp-${theme}-${k.key}`} up={k.up} T={ink} />
                  </div>
                </div>
              ))}
            </div>

            {/* PROJECT TIMELINE — rampa/warmup de Delivrix con grupos de avatares */}
            <div style={{ ...card, padding: "18px 20px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>Linea de rampa</div>
                  <div style={{ fontSize: 12.5, color: T.dim, marginTop: 2 }}>Onboarding → Reputacion · 6 semanas</div>
                </div>
                <span style={{ fontSize: 12, color: T.orange, background: T.orangeSoft, borderRadius: 999, padding: "3px 10px", fontWeight: 500 }}>Fase actual: Warmup</span>
              </div>
              {/* eje temporal */}
              <div style={{ display: "grid", gridTemplateColumns: "132px 1fr", gap: 16, alignItems: "center", marginBottom: 10 }}>
                <span />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.dim, padding: "0 2px" }}>
                  {["Sem 1", "Sem 2", "Sem 3", "Sem 4", "Sem 5", "Sem 6"].map((w) => <span key={w}>{w}</span>)}
                </div>
              </div>
              {/* filas de fases */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {phases.map((p) => (
                  <div key={p.name} style={{ display: "grid", gridTemplateColumns: "132px 1fr", gap: 16, alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 8, background: T.tile, border: `1px solid ${T.border}`, display: "grid", placeItems: "center", flex: "none" }}>
                        <p.Icon size={14} color={p.color} strokeWidth={1.8} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: T.hi, fontWeight: 500 }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: T.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.sub}</div>
                      </div>
                    </div>
                    {/* track */}
                    <div style={{ position: "relative", height: 34 }}>
                      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: T.track, borderRadius: 2, transform: "translateY(-50%)" }} />
                      <div style={{
                        position: "absolute", top: "50%", transform: "translateY(-50%)",
                        left: `${p.start}%`, width: `${p.width}%`, height: 8, borderRadius: 999,
                        background: p.done ? p.color : `${p.color}55`,
                        border: p.active ? `1px solid ${p.color}` : "none",
                        boxShadow: p.active ? `0 0 0 3px ${p.color}22` : "none",
                      }} />
                      {/* nodo al final del segmento */}
                      <div style={{ position: "absolute", top: "50%", left: `calc(${p.start + p.width}% - 5px)`, transform: "translateY(-50%)", width: 10, height: 10, borderRadius: "50%", background: p.color, border: `2px solid ${T.surface}` }} />
                      {/* grupo de avatares sobre el inicio del segmento */}
                      <div style={{ position: "absolute", top: "50%", left: `calc(${p.start}% + 6px)`, transform: "translateY(-50%)" }}>
                        <AvatarGroup items={p.avatars} tint={p.color} T={T} />
                      </div>
                      {/* deadline */}
                      <div style={{ position: "absolute", top: -2, right: 0, fontSize: 11, color: T.dim }}>{p.due}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* tabla de bandejas + gauges */}
            <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 20, alignItems: "start" }}>
              <div style={{ ...card, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>Bandejas en warmup</div>
                  <span style={{ fontSize: 12.5, color: T.mid }}>6 activas · contabo-2</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", fontSize: 11, color: T.dim, padding: "8px 20px", borderBottom: `1px solid ${T.border}`, gap: 12, textTransform: "uppercase", letterSpacing: ".05em" }}>
                  <span>Bandeja</span><span>Estado</span><span style={{ textAlign: "right" }}>Placement</span><span style={{ textAlign: "right" }}>Warmed</span>
                </div>
                {boxes.map((b) => {
                  const st = stateMap(T)[b.state]; const lb = (["QUARANTINED", "PAUSED", "BLOCKED"] as string[]).includes(b.state);
                  return (
                    <div key={b.email} className="aiv-row" style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: `1px solid ${T.border}`, borderLeft: lb ? `2px solid ${st.c}` : "2px solid transparent" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: T.hi, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.email.split("@")[0]}</div>
                        <div style={{ fontSize: 11.5, color: T.dim }}>{b.prov} · {b.email.split("@")[1]}</div>
                      </div>
                      <StateBadge s={b.state} T={T} />
                      <div style={{ textAlign: "right", fontSize: 14, color: b.place === 0 ? T.dim : b.place >= 75 ? T.success : b.place >= 45 ? T.warning : T.danger, fontWeight: 600 }}>{b.place === 0 ? "—" : `${b.place}%`}</div>
                      <div style={{ textAlign: "right", fontSize: 12, color: T.mid }}>{b.when}</div>
                    </div>
                  );
                })}
              </div>

              {/* right column: gauges + advisor */}
              <div style={{ display: "grid", gap: 20 }}>
                <div style={{ ...inkCard, padding: "16px 20px" }}>
                  <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, color: ink.hi }}>Placement por proveedor</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
                    <PlacementGauge v={91} label="Gmail" T={ink} /><PlacementGauge v={78} label="Outlook" T={ink} /><PlacementGauge v={64} label="Yahoo" T={ink} />
                  </div>
                </div>
                {/* ADVISOR — superficie IA; en modo CLARO va en NEGRO (inlay) con glow de acento */}
                <div style={{ background: ink.surface, borderRadius: 18, padding: 0, position: "relative", overflow: "hidden", border: `1px solid ${ink.accentSoft}`, boxShadow: ink.accentShadow }}>
                  <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 80% at 0% 0%, ${ink.accentSoft}, transparent 55%)`, pointerEvents: "none" }} />
                  <div style={{ padding: 18, position: "relative" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 9, background: ink.accentGrad, display: "grid", placeItems: "center" }}><Sparkles size={16} color="#fff" /></div>
                      <div style={{ fontSize: 14.5, fontWeight: 500, color: ink.hi }}>Advisor · OpenClaw</div>
                    </div>
                    <div style={{ marginTop: 14, borderLeft: `2px solid transparent`, borderImage: `${ink.accentGrad} 1`, paddingLeft: 12 }}>
                      <div style={{ fontSize: 13.5, color: ink.hi, lineHeight: 1.5, fontWeight: 300 }}>Yahoo placement cayo a 64%. Sugiero pausar <b style={{ fontWeight: 600 }}>corpannualinfra</b> 24h y bajar la rampa a 50%.</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11.5, color: ink.mid, background: ink.inset, borderRadius: 999, padding: "3px 9px" }}>confianza 82%</span>
                        <span style={{ fontSize: 11.5, color: ink.accent, background: ink.accentSoft, borderRadius: 999, padding: "3px 9px" }}>2 bandejas</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      <button style={{ display: "inline-flex", alignItems: "center", gap: 6, background: ink.accentGrad, color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}><Rocket size={14} />Aplicar</button>
                      <button style={{ background: "transparent", color: ink.mid, border: `1px solid ${ink.border}`, borderRadius: 10, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}>Descartar</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
