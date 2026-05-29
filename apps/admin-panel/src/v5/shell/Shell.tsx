/**
 * v5 Shell — Sidebar + Topbar + Main + Footer desde cero.
 *
 * Arquitectura:
 *   ┌──────────────────────────────────────────┐
 *   │ Topbar 52px · breadcrumb + agent + utils │
 *   ├────────┬─────────────────────────────────┤
 *   │ Sidebar│                                 │
 *   │ 256/64 │  Main (1440 max, gutter 24)     │
 *   │        │                                 │
 *   │        ├─────────────────────────────────┤
 *   │        │ Footer 36 · operational status  │
 *   └────────┴─────────────────────────────────┘
 *
 * Linear/Vercel/Cursor lead. Dark-first. Sidebar colapsable a 64px icon-only.
 * Topbar minimal con breadcrumb + AgentPulse + user. Footer compacto con
 * operational status (audit chain count, kill switch state, env).
 */

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  CircleDot,
  Command,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  RefreshCw,
  Search,
  Sparkles,
  Sun
} from "lucide-react";
import { cn } from "../lib/cn";
import { sidebarSlide, durations, easeOutExpo } from "../lib/motion";
import { AgentPulse, Badge, Button, Caption, Eyebrow, MonoCode, Pill } from "../components/primitives";

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

export interface ShellProps {
  groups: NavGroup[];
  activeSection: string;
  onSelect: (id: string) => void;
  breadcrumb: { group: string; section: string };
  agentState?: "idle" | "thinking" | "executing";
  killSwitchArmed?: boolean;
  killSwitchOnClick?: () => void;
  envLabel?: string;
  buildSha?: string;
  postgresOk?: boolean;
  redisOk?: boolean;
  onRefresh?: () => void | Promise<void>;
  isRefreshing?: boolean;
  onOpenCommand?: () => void;
  user?: { initial: string; label: string };
  rightDrawer?: ReactNode;
  children: ReactNode;
}

const COLLAPSED_KEY = "delivrix-v5-sidebar-collapsed";

export function Shell({
  groups,
  activeSection,
  onSelect,
  breadcrumb,
  agentState = "idle",
  killSwitchArmed = true,
  killSwitchOnClick,
  envLabel = "mvp.local",
  buildSha = "dev",
  postgresOk = true,
  redisOk = true,
  onRefresh,
  isRefreshing = false,
  onOpenCommand,
  user = { initial: "J", label: "operador" },
  rightDrawer,
  children
}: ShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  });
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
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        groups={groups}
        activeSection={activeSection}
        onSelect={onSelect}
        killSwitchArmed={killSwitchArmed}
        killSwitchOnClick={killSwitchOnClick}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          breadcrumb={breadcrumb}
          agentState={agentState}
          envLabel={envLabel}
          postgresOk={postgresOk}
          redisOk={redisOk}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          onOpenCommand={onOpenCommand}
          user={user}
        />
        <main className="relative flex min-h-0 flex-1 overflow-hidden">
          <motion.div
            key={breadcrumb.section}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: durations.page, ease: easeOutExpo }}
            className="flex-1 overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-[1440px] px-6 py-6">{children}</div>
          </motion.div>
          {rightDrawer}
        </main>
        <Footer killSwitchArmed={killSwitchArmed} />
      </div>
    </div>
  );
}

/* ============================================================
 * Sidebar
 * ============================================================ */

function Sidebar({
  collapsed,
  onToggle,
  groups,
  activeSection,
  onSelect,
  killSwitchArmed,
  killSwitchOnClick
}: {
  collapsed: boolean;
  onToggle: () => void;
  groups: NavGroup[];
  activeSection: string;
  onSelect: (id: string) => void;
  killSwitchArmed: boolean;
  killSwitchOnClick?: () => void;
}) {
  return (
    <motion.aside
      initial={false}
      animate={collapsed ? "collapsed" : "expanded"}
      variants={sidebarSlide}
      transition={{ duration: durations.base, ease: easeOutExpo }}
      className="flex shrink-0 flex-col border-r border-border bg-surface-sunken"
      style={{ overflow: "hidden" }}
    >
      {/* Brand row */}
      <div
        className={cn(
          "flex items-center border-b border-border",
          collapsed ? "flex-col gap-2 px-2 py-3" : "gap-2.5 px-3.5 py-3.5"
        )}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-[7px] bg-fg text-bg">
          <span
            className="font-heading text-[14px] font-bold"
            style={{ letterSpacing: "-0.04em" }}
          >
            D
          </span>
        </div>
        {!collapsed && (
          <div className="flex min-w-0 flex-1 flex-col leading-none">
            <span
              className="font-heading text-[13.5px] font-semibold text-fg"
              style={{ letterSpacing: "-0.015em" }}
            >
              Delivrix
            </span>
            <span
              className="mt-1 font-mono text-[9.5px] font-medium uppercase text-fg-subtle"
              style={{ letterSpacing: "0.16em" }}
            >
              control plane
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
          title={collapsed ? "Expandir · ⌘\\" : "Colapsar · ⌘\\"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-fg-subtle transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      </div>

      {/* Nav */}
      <nav
        className={cn("flex flex-1 flex-col gap-4 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}
        aria-label="Secciones"
      >
        {groups.map((group, gi) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            {!collapsed ? (
              <div
                className="mb-1 px-2.5 font-mono text-[9.5px] font-semibold uppercase text-fg-subtle"
                style={{ letterSpacing: "0.16em" }}
              >
                {group.label}
              </div>
            ) : gi > 0 ? (
              <div className="mx-1 my-1 h-px bg-border" />
            ) : null}
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

      {/* Kill Switch */}
      <div className={cn("border-t border-border", collapsed ? "px-2 py-3" : "px-3 py-3")}>
        <KillSwitch armed={killSwitchArmed} collapsed={collapsed} onClick={killSwitchOnClick} />
      </div>
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
      data-active={active}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "v5-nav-row group relative flex items-center rounded text-[12.5px] font-medium transition-colors duration-150",
        collapsed ? "h-8 w-full justify-center px-0" : "gap-2.5 px-2.5 py-1.5",
        active
          ? "bg-surface text-fg"
          : "text-fg-muted hover:bg-surface hover:text-fg"
      )}
    >
      <span className={cn("inline-flex shrink-0", active ? "text-fg" : "text-fg-subtle group-hover:text-fg-muted")}>
        {item.icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left font-sans">{item.label}</span>
          {item.badge != null && (
            <Badge className="px-1.5 text-[10px]">{item.badge}</Badge>
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
        title={`Kill switch · ${label} · click para gestionar`}
        className="grid h-8 w-full place-items-center rounded transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
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
      className="flex w-full flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      <div className="flex items-center gap-2">
        <Power size={13} style={{ color }} aria-hidden="true" />
        <span className="font-sans text-[12px] font-semibold text-fg">Kill Switch</span>
        <span className="flex-1" aria-hidden="true" />
        <Pill tone={armed ? "success" : "critical"} size="sm">
          {label}
        </Pill>
      </div>
      <span className="font-sans text-[10.5px] leading-[1.4] text-fg-subtle">
        Regla de 2 personas · click para gestionar
      </span>
    </button>
  );
}

/* ============================================================
 * Topbar
 * ============================================================ */

function Topbar({
  breadcrumb,
  agentState,
  envLabel,
  postgresOk,
  redisOk,
  onRefresh,
  isRefreshing,
  onOpenCommand,
  user
}: {
  breadcrumb: { group: string; section: string };
  agentState: "idle" | "thinking" | "executing";
  envLabel: string;
  postgresOk: boolean;
  redisOk: boolean;
  onRefresh?: () => void | Promise<void>;
  isRefreshing: boolean;
  onOpenCommand?: () => void;
  user: { initial: string; label: string };
}) {
  return (
    <header
      className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-bg px-5"
    >
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
        <Caption className="shrink-0">{breadcrumb.group}</Caption>
        <ChevronRight size={12} className="shrink-0 text-fg-subtle" strokeWidth={2} aria-hidden="true" />
        <span
          className="truncate font-heading text-[14px] font-semibold text-fg"
          style={{ letterSpacing: "-0.015em" }}
        >
          {breadcrumb.section}
        </span>
      </nav>

      <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />

      {/* AgentPulse */}
      <AgentPulse state={agentState} />

      <span className="flex-1" aria-hidden="true" />

      {/* Command palette trigger */}
      {onOpenCommand && (
        <button
          type="button"
          onClick={onOpenCommand}
          title="Buscar · ⌘K"
          className="hidden h-7 items-center gap-2 rounded border border-border bg-surface px-2.5 text-fg-subtle transition-colors hover:border-border-strong hover:text-fg sm:inline-flex"
        >
          <Search size={11} strokeWidth={1.75} aria-hidden="true" />
          <span className="font-sans text-[12px] font-medium">Buscar</span>
          <kbd
            className="ml-2 inline-flex items-center gap-0.5 rounded bg-surface-sunken px-1 font-mono text-[9.5px] font-medium text-fg-subtle"
            style={{ paddingTop: 1, paddingBottom: 1 }}
          >
            <Command size={9} /> K
          </kbd>
        </button>
      )}

      {/* Status chips eliminadas del topbar 2026-05-28: pg/redis/branch
       * eran metadata de dev/ops que ruido visual para demos. El footer
       * ya muestra envLabel + buildSha + audit chain — ahí está la verdad
       * de telemetría para los curiosos. Los props quedan en la API por
       * si se quiere reactivar tras un toggle dev-mode. */}

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Refresh */}
      {onRefresh && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Actualizar datos"
          title="Actualizar datos"
          onClick={() => void onRefresh()}
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            className={cn(isRefreshing && "animate-spin")}
            aria-hidden="true"
          />
        </Button>
      )}

      {/* User */}
      <div className="flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pl-0.5 pr-2.5">
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-fg font-heading text-[10px] font-semibold text-bg"
        >
          {user.initial}
        </span>
        <span className="hidden font-sans text-[11.5px] font-medium text-fg sm:inline">
          {user.label}
        </span>
      </div>
    </header>
  );
}

function DepChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      title={`${label} · ${ok ? "ok" : "down"}`}
      className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1"
    >
      <span
        aria-hidden="true"
        className="inline-block size-1.5 rounded-full"
        style={{ background: ok ? "var(--color-success)" : "var(--color-critical)" }}
      />
      <span className="hidden font-mono text-[10.5px] font-medium text-fg-muted sm:inline">{label}</span>
    </span>
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
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Cambiar a tema ${next}`}
      title={`Tema actual: ${theme} · click para ${next}`}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? (
        <Sun size={13} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={13} strokeWidth={1.75} aria-hidden="true" />
      )}
    </Button>
  );
}

function EnvChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1">
      <Sparkles size={10} className="text-fg-subtle" strokeWidth={1.75} aria-hidden="true" />
      <span className="hidden font-mono text-[10.5px] font-medium text-fg-muted sm:inline">{label}</span>
    </span>
  );
}

/* ============================================================
 * Footer
 * ============================================================ */

function Footer({
  killSwitchArmed
}: {
  /** envLabel + buildSha quedan en la API por compat; el footer no los
   * renderiza — eran metadata de dev. Para 'dev mode' futuro, basta
   * reincorporarlos aquí. */
  envLabel?: string;
  buildSha?: string;
  killSwitchArmed: boolean;
}) {
  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-border bg-surface-sunken px-5 text-fg-subtle">
      {/* Izquierda: marca discreta */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="grid size-4 place-items-center rounded-[3px] bg-fg text-bg font-mono text-[8.5px] font-bold leading-none"
        >
          D
        </span>
        <Caption className="text-[10.5px] font-medium tracking-tight">Delivrix</Caption>
      </div>

      <span className="flex-1" aria-hidden="true" />

      {/* Derecha: solo el estado funcional clave.
       *
       * Antes vivían acá 'Audit chain · Append-only · Regla de 2 personas'
       * — jerga técnica que el stakeholder no entiende y que ya se cuenta
       * mejor en banners, Vista General y la sección de Seguridad. El
       * footer queda minimal estilo Linear/Stripe/Vercel. */}
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block size-1.5 rounded-full"
          style={{ background: killSwitchArmed ? "var(--color-success)" : "var(--color-critical)" }}
        />
        <Caption className="text-[10.5px] font-medium tracking-tight">
          {killSwitchArmed ? "Solo lectura" : "Escritura en vivo"}
        </Caption>
      </span>
    </footer>
  );
}
