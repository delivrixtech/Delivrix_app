/**
 * Shell — Sidebar + Topbar + Main, calcado del demo Aivora
 * (features/overview/TravigueOverviewProto.tsx).
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Topbar 60 sticky · Buscar + CTA + avatar │
 *   ├────────┬─────────────────────────────────┤
 *   │ Sidebar│                                 │
 *   │ 240/64 │  Main (1440 max, gutter 24)     │
 *   │  (ink) │                                 │
 *   └────────┴─────────────────────────────────┘
 *
 * El sidebar es "ink island" (siempre negro, clase theme-ink-island): dentro de
 * él los tokens var(--color-*) resuelven a la paleta oscura. El chrome se
 * construye con elementos crudos + TOKENS (como el demo), no con primitivos B/N.
 * Superficie de gradiente única: la CTA "Preguntar a Delivrix" (aivoraGradient).
 */

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Bell,
  Command,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  X
} from "lucide-react";
import { cn } from "../lib/cn";
import { sidebarSlide, durations, easeOutExpo } from "../lib/motion";
import { aivoraGradient } from "../../shared/ui/aivora/index.tsx";

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  href?: string;
  active?: boolean;
  status?: "ok" | "warn" | "crit" | "info" | null;
  badge?: string | number | null;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export interface ShellAlert {
  severity: string;
  title: string;
  message: string;
}

export interface ShellProps {
  groups: NavGroup[];
  activeSection: string;
  onSelect: (id: string) => void;
  /** Se conserva por compat con App; el topbar del demo no muestra breadcrumb. */
  breadcrumb?: { group: string; section: string };
  killSwitchArmed?: boolean;
  killSwitchOnClick?: () => void;
  onRefresh?: () => void | Promise<void>;
  isRefreshing?: boolean;
  onOpenCommand?: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  /** Alertas REALES del backend (overview.alerts) para la campana. */
  alerts?: ShellAlert[];
  /** Placeholder dev: aún no hay sesión autenticada. */
  user?: { initial: string; label: string };
  rightDrawer?: ReactNode;
  contentClassName?: string;
  contentInnerClassName?: string;
  children: ReactNode;
}

const COLLAPSED_KEY = "delivrix-v5-sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 767px)";

/* Pastilla translúcida del nav activo (demo `T.pill`): overlay del texto → theme-aware. */
const NAV_ACTIVE = "color-mix(in srgb, var(--color-text-primary) 7%, transparent)";

/** Estilos de hover/transición del chrome (el demo también inyecta un <style>). */
const SHELL_STYLE = `
.shell-root{ height: 100vh; height: 100dvh; }
.shell-topbar{ background: var(--color-bg); background: color-mix(in srgb, var(--color-bg) 85%, transparent); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.shell-nav{ transition: background-color .15s ease, color .15s ease; }
.shell-nav:hover:not([data-active="true"]){ background: color-mix(in srgb, var(--color-text-primary) 5%, transparent); color: var(--color-text-primary); }
.shell-iconbtn{ transition: background-color .15s ease, color .15s ease, border-color .15s ease; }
.shell-iconbtn:hover{ color: var(--color-text-primary); border-color: var(--color-border-strong); }
.shell-search{ transition: border-color .15s ease, color .15s ease; }
.shell-search:hover{ border-color: var(--color-border-strong); color: var(--color-text-secondary); }
.shell-cta{ transition: filter .15s ease, box-shadow .15s ease; }
.shell-cta:hover{ filter: brightness(1.06); }
.shell-killswitch{ transition: border-color .15s ease; }
.shell-killswitch:hover{ border-color: var(--color-border-strong); }
`;

/**
 * Mobile (<768px): el sidebar in-flow de 240px dejaba ~130px de contenido en un
 * iPhone (HIGH-1 post-audit). Bajo `md` el sidebar pasa a drawer overlay con
 * hamburguesa en el topbar; en desktop nada cambia.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export function Shell({
  groups,
  activeSection,
  onSelect,
  killSwitchArmed = true,
  killSwitchOnClick,
  onRefresh,
  isRefreshing = false,
  onOpenCommand,
  chatOpen = false,
  onToggleChat,
  alerts = [],
  user = { initial: "J", label: "operador" },
  rightDrawer,
  contentClassName,
  contentInnerClassName,
  children
}: ShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  });
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [collapsed]);

  // ⌘\ toggle (Notion/VS Code muscle memory).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key === "\\") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
      if (isMeta && e.key === "k" && onOpenCommand) {
        e.preventDefault();
        onOpenCommand();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpenCommand]);

  return (
    <div className="shell-root flex w-full overflow-hidden bg-bg text-fg">
      <style>{SHELL_STYLE}</style>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        groups={groups}
        activeSection={activeSection}
        onSelect={(id) => {
          onSelect(id);
          setMobileNavOpen(false);
        }}
        killSwitchArmed={killSwitchArmed}
        killSwitchOnClick={() => {
          killSwitchOnClick?.();
          setMobileNavOpen(false);
        }}
        isMobile={isMobile}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          mobileNavOpen={mobileNavOpen}
          onToggleMobileNav={() => setMobileNavOpen((v) => !v)}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          onOpenCommand={onOpenCommand}
          chatOpen={chatOpen}
          onToggleChat={onToggleChat}
          alerts={alerts}
          user={user}
        />
        <main className="relative flex min-h-0 flex-1 overflow-hidden">
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: durations.page, ease: easeOutExpo }}
            className={cn("flex-1 overflow-y-auto", contentClassName)}
          >
            <div className={cn("mx-auto w-full max-w-[1440px] px-4 py-4 sm:px-6 sm:py-6", contentInnerClassName)}>
              {children}
            </div>
          </motion.div>
          {rightDrawer}
        </main>
      </div>
    </div>
  );
}

/* ============================================================
 * Sidebar (ink island)
 * ============================================================ */

function Sidebar({
  collapsed: collapsedProp,
  onToggle,
  groups,
  activeSection,
  onSelect,
  killSwitchArmed,
  killSwitchOnClick,
  isMobile,
  mobileOpen,
  onCloseMobile
}: {
  collapsed: boolean;
  onToggle: () => void;
  groups: NavGroup[];
  activeSection: string;
  onSelect: (id: string) => void;
  killSwitchArmed: boolean;
  killSwitchOnClick?: () => void;
  isMobile: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  // En mobile el drawer siempre se muestra expandido.
  const collapsed = isMobile ? false : collapsedProp;
  const body = (
    <>
      {/* Brand row — tile radius 9 gradiente + "Delivrix" (sin subtítulo, sin border) */}
      <div
        className={cn(
          "flex items-center",
          collapsed ? "flex-col gap-2 px-2 py-3" : "gap-2.5 px-3.5 py-3.5"
        )}
      >
        <div
          className="grid shrink-0 place-items-center text-white"
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: aivoraGradient
          }}
        >
          <span className="font-heading" style={{ fontSize: 15, fontWeight: 700 }}>
            D
          </span>
        </div>
        {!collapsed && (
          <span
            className="min-w-0 flex-1 truncate font-heading"
            style={{ fontSize: 15.5, fontWeight: 500, letterSpacing: "-0.01em", color: "var(--color-text-primary)" }}
          >
            Delivrix
          </span>
        )}
        <button
          type="button"
          onClick={isMobile ? onCloseMobile : onToggle}
          aria-label={isMobile ? "Cerrar navegación" : collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
          title={isMobile ? "Cerrar navegación" : collapsed ? "Expandir · ⌘\\" : "Colapsar · ⌘\\"}
          className="shell-iconbtn grid h-7 w-7 shrink-0 place-items-center rounded"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {isMobile ? <X size={14} /> : collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      </div>

      {/* Nav — un solo eyebrow "MENU" + lista plana */}
      <nav
        className={cn("flex flex-1 flex-col gap-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}
        aria-label="Secciones"
      >
        {!collapsed && (
          <div
            className="mb-1 px-2"
            style={{ fontSize: 10.5, letterSpacing: ".14em", color: "var(--color-text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}
          >
            MENU
          </div>
        )}
        {groups.map((group, gi) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            {collapsed && gi > 0 ? <div className="mx-1 my-1 h-px" style={{ background: "var(--color-border)" }} /> : null}
            {group.items.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={item.id === activeSection}
                collapsed={collapsed}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Kill Switch — card radius 18 minimal (dot + label + estado real) */}
      <div className={cn(collapsed ? "px-2 py-3" : "px-3 py-3")}>
        <KillSwitch armed={killSwitchArmed} collapsed={collapsed} onClick={killSwitchOnClick} />
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <div
          aria-hidden="true"
          onClick={onCloseMobile}
          className={cn(
            "fixed inset-0 z-30 transition-opacity duration-200",
            mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          style={{ background: "color-mix(in srgb, #000 55%, transparent)" }}
        />
        <aside
          aria-label="Navegación del panel"
          aria-hidden={!mobileOpen}
          className={cn(
            "theme-ink-island fixed inset-y-0 left-0 z-40 flex w-[min(82vw,300px)] flex-col border-r border-border bg-surface-sunken shadow-[var(--shadow-lg)] transition-transform duration-200 ease-out",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {body}
        </aside>
      </>
    );
  }

  return (
    <motion.aside
      initial={false}
      animate={collapsed ? "collapsed" : "expanded"}
      variants={sidebarSlide}
      transition={{ duration: durations.base, ease: easeOutExpo }}
      className="theme-ink-island flex shrink-0 flex-col border-r border-border bg-surface-sunken"
      style={{ overflow: "hidden" }}
    >
      {body}
    </motion.aside>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  onClick
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const statusColor =
    item.status === "ok"
      ? "var(--color-success)"
      : item.status === "warn"
      ? "var(--color-warning)"
      : item.status === "crit"
      ? "var(--color-critical)"
      : item.status === "info"
      ? "var(--color-info)"
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active ? "true" : undefined}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "shell-nav group relative flex items-center",
        collapsed ? "h-9 w-full justify-center px-0" : "gap-[11px] px-[11px] py-[9px]"
      )}
      style={{
        borderRadius: 10,
        fontSize: 13.5,
        fontWeight: active ? 500 : 400,
        background: active ? NAV_ACTIVE : "transparent",
        color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)"
      }}
    >
      <span
        className="inline-flex shrink-0"
        style={{ color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}
      >
        {item.icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{item.label}</span>
          {item.badge != null && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--color-critical)",
                background: "var(--color-critical-soft)",
                borderRadius: 999,
                padding: "1px 7px"
              }}
            >
              {item.badge}
            </span>
          )}
          {statusColor && (
            <span
              aria-hidden="true"
              className="ml-1 inline-block size-1.5 shrink-0 rounded-full"
              style={{ background: statusColor }}
            />
          )}
        </>
      )}
      {collapsed && statusColor && (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 inline-block size-1.5 rounded-full ring-2 ring-surface-sunken"
          style={{ background: statusColor }}
        />
      )}
    </button>
  );
}

function KillSwitch({
  armed,
  collapsed,
  onClick
}: {
  armed: boolean;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const color = armed ? "var(--color-success)" : "var(--color-critical)";
  const label = armed ? "Armado" : "Activo";
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Kill switch ${label}`}
        title={`Kill switch · ${label}`}
        className="shell-iconbtn grid h-8 w-full place-items-center rounded-[10px]"
      >
        <span className="relative inline-grid size-6 place-items-center">
          <Power size={14} style={{ color }} aria-hidden="true" />
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 inline-block size-2 rounded-full ring-2 ring-surface-sunken"
            style={{ background: color }}
          />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="Gestionar kill switch"
      className="shell-killswitch flex w-full items-center gap-2 text-left"
      style={{
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-border)",
        borderRadius: 18,
        padding: "10px 12px",
        fontSize: 12
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block shrink-0 rounded-full"
        style={{ width: 7, height: 7, background: color }}
      />
      <span style={{ color: "var(--color-text-secondary)" }}>Kill switch</span>
      <b style={{ marginLeft: "auto", color, fontWeight: 600 }}>{label}</b>
    </button>
  );
}

/* ============================================================
 * Topbar
 * ============================================================ */

function IconBtn({
  onClick,
  label,
  title,
  active,
  className,
  children
}: {
  onClick?: () => void;
  label: string;
  title?: string;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      className={cn("shell-iconbtn grid shrink-0 place-items-center", className)}
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        background: active ? "var(--color-accent-soft)" : "var(--color-surface-sunken)",
        border: "1px solid var(--color-border)",
        color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
        cursor: "pointer"
      }}
    >
      {children}
    </button>
  );
}

function Topbar({
  onRefresh,
  isRefreshing,
  onOpenCommand,
  chatOpen,
  onToggleChat,
  alerts,
  user,
  mobileNavOpen,
  onToggleMobileNav
}: {
  onRefresh?: () => void | Promise<void>;
  isRefreshing: boolean;
  onOpenCommand?: () => void;
  chatOpen: boolean;
  onToggleChat?: () => void;
  alerts: ShellAlert[];
  user: { initial: string; label: string };
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
}) {
  return (
    <header
      className="shell-topbar flex shrink-0 items-center gap-3.5 px-4 sm:px-6"
      style={{
        height: 60,
        borderBottom: "1px solid var(--color-border)",
        position: "sticky",
        top: 0,
        zIndex: 5
      }}
    >
      {/* Hamburguesa mobile — el sidebar es drawer bajo md */}
      <IconBtn
        onClick={onToggleMobileNav}
        label={mobileNavOpen ? "Cerrar navegación del panel" : "Abrir navegación del panel"}
        active={mobileNavOpen}
        className="md:hidden"
      >
        {mobileNavOpen ? (
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <Menu size={16} strokeWidth={1.8} aria-hidden="true" />
        )}
      </IconBtn>

      {/* Buscar — píldora a la izquierda, width 280, radius 999 */}
      {onOpenCommand && (
        <button
          type="button"
          onClick={onOpenCommand}
          title="Buscar · ⌘K"
          className="shell-search hidden items-center gap-2 sm:flex"
          style={{
            width: 280,
            maxWidth: "40vw",
            borderRadius: 999,
            padding: "7px 12px",
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
            fontSize: 13,
            cursor: "pointer"
          }}
        >
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="flex-1 truncate text-left">Buscar cualquier cosa...</span>
          <span
            className="inline-flex items-center gap-0.5"
            style={{ fontSize: 11 }}
            aria-hidden="true"
          >
            <Command size={11} />K
          </span>
        </button>
      )}

      <span className="flex-1" aria-hidden="true" />

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Refresh */}
      {onRefresh && (
        <IconBtn onClick={() => void onRefresh()} label="Actualizar datos">
          <RefreshCw
            size={16}
            strokeWidth={1.75}
            className={cn(isRefreshing && "animate-spin")}
            aria-hidden="true"
          />
        </IconBtn>
      )}

      {/* CTA firma — "Preguntar a Delivrix" (única superficie de gradiente del chrome) */}
      {onToggleChat && (
        <button
          type="button"
          onClick={onToggleChat}
          aria-pressed={chatOpen}
          aria-label={chatOpen ? "Cerrar chat con OpenClaw" : "Preguntar a Delivrix"}
          title={chatOpen ? "Cerrar chat" : "Preguntar a Delivrix"}
          className="shell-cta inline-flex shrink-0 items-center gap-2"
          style={{
            background: aivoraGradient,
            color: "#fff",
            border: "none",
            borderRadius: 12,
            padding: "9px 15px",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "var(--shadow-md)"
          }}
        >
          <Sparkles size={15} aria-hidden="true" />
          <span className="hidden sm:inline">Preguntar a Delivrix</span>
        </button>
      )}

      {/* Bell — alertas REALES del backend (overview.alerts) */}
      <NotificationsBell alerts={alerts} />

      {/* Avatar — círculo raised con iniciales, sin inversión (placeholder dev, sin auth) */}
      <span
        aria-hidden="true"
        title={`${user.label} · sesión local (sin autenticación)`}
        className="grid shrink-0 place-items-center"
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: "var(--color-surface-raised)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-secondary)",
          fontSize: 12,
          fontWeight: 600
        }}
      >
        {user.initial}
      </span>
    </header>
  );
}

/* Color de token por severidad de alerta (contrato ContractStatus). */
function alertColor(sev: string): string {
  const s = sev.toLowerCase();
  if (/(crit|error|danger|blocked|fail)/.test(s)) return "var(--color-critical)";
  if (/(warn|review|stale|pending)/.test(s)) return "var(--color-warning)";
  if (/(ok|success|healthy|ready|active)/.test(s)) return "var(--color-success)";
  return "var(--color-info)";
}

/* Campana con alertas REALES (overview.alerts): badge de conteo + dropdown. */
function NotificationsBell({ alerts }: { alerts: ShellAlert[] }) {
  const [open, setOpen] = useState(false);
  const count = alerts.length;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest("[data-notif-root]")) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div data-notif-root style={{ position: "relative" }}>
      <IconBtn
        onClick={() => setOpen((v) => !v)}
        label={count > 0 ? `Notificaciones (${count})` : "Notificaciones"}
        title={count > 0 ? `${count} alerta${count === 1 ? "" : "s"}` : "Sin alertas"}
        active={open}
      >
        <Bell size={17} strokeWidth={1.75} aria-hidden="true" />
      </IconBtn>
      {count > 0 && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -1,
            right: -1,
            minWidth: 15,
            height: 15,
            padding: "0 3px",
            borderRadius: 999,
            background: "var(--color-critical)",
            color: "#fff",
            fontSize: 9.5,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            lineHeight: 1,
            pointerEvents: "none",
            boxShadow: "0 0 0 2px var(--color-bg)"
          }}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="Alertas"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 340,
            maxWidth: "90vw",
            maxHeight: 420,
            overflowY: "auto",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 16,
            boxShadow: "var(--shadow-lg)",
            zIndex: 50
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 15px",
              borderBottom: "1px solid var(--color-border)"
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>Alertas</span>
            <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
              {count} activa{count === 1 ? "" : "s"}
            </span>
          </div>
          {count === 0 ? (
            <div style={{ padding: "26px 15px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-tertiary)" }}>
              Sin alertas · todo en orden
            </div>
          ) : (
            alerts.map((a, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "11px 15px",
                  borderBottom: i < count - 1 ? "1px solid var(--color-border)" : "none"
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 7, height: 7, borderRadius: "50%", background: alertColor(a.severity), marginTop: 5, flex: "none" }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text-primary)" }}>{a.title}</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2, lineHeight: 1.4 }}>{a.message}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "dark";
    const attr = document.documentElement.getAttribute("data-theme");
    return attr === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("delivrix-admin-theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconBtn
      onClick={() => setTheme(next)}
      label={`Cambiar a tema ${next}`}
      title={`Tema actual: ${theme} · click para ${next}`}
    >
      {theme === "dark" ? (
        <Sun size={17} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <Moon size={17} strokeWidth={1.8} aria-hidden="true" />
      )}
    </IconBtn>
  );
}
