/**
 * Toast notifications v2.
 *
 * Sistema interno minimalista (sin librería externa) inspirado en Linear /
 * Vercel: stack bottom-right, auto-dismiss configurable, swipe-to-dismiss,
 * variantes success/error/info/warning.
 *
 * Uso:
 *   1. Envolver el árbol con <ToastProvider> (en App.tsx).
 *   2. En cualquier componente: const { toast } = useToast();
 *      toast.success("Cambios guardados");
 *      toast.error("Falló refresh", { description: "Reintenta en 30s" });
 *      toast.info("...", { duration: 4000 });
 */

import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  /** Subtítulo opcional bajo el título. */
  description?: ReactNode;
  /** Duración antes de auto-dismiss. Default 5000ms. 0 = no dismiss automático. */
  duration?: number;
}

export interface ToastEntry {
  id: string;
  variant: ToastVariant;
  title: ReactNode;
  description?: ReactNode;
  duration: number;
  createdAt: number;
}

interface ToastContextValue {
  toasts: ToastEntry[];
  push: (variant: ToastVariant, title: ReactNode, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, title: ReactNode, opts?: ToastOptions): string => {
      const id = `toast-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const duration = opts?.duration ?? DEFAULT_DURATION;
      const entry: ToastEntry = {
        id,
        variant,
        title,
        description: opts?.description,
        duration,
        createdAt: Date.now()
      };
      setToasts((prev) => [...prev, entry].slice(-5)); // máx 5 visibles
      if (duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  const clearAll = useCallback(() => {
    for (const [, timer] of timers.current) {
      window.clearTimeout(timer);
    }
    timers.current.clear();
    setToasts([]);
  }, []);

  // Cleanup en unmount.
  useEffect(() => {
    return () => {
      for (const [, timer] of timers.current) {
        window.clearTimeout(timer);
      }
      timers.current.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, push, dismiss, clearAll }),
    [toasts, push, dismiss, clearAll]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Hook API. Devuelve `toast` con shortcuts por variante.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast debe usarse dentro de <ToastProvider>");
  }

  const toast = useMemo(
    () => ({
      success: (title: ReactNode, opts?: ToastOptions) => ctx.push("success", title, opts),
      error: (title: ReactNode, opts?: ToastOptions) => ctx.push("error", title, opts),
      info: (title: ReactNode, opts?: ToastOptions) => ctx.push("info", title, opts),
      warning: (title: ReactNode, opts?: ToastOptions) => ctx.push("warning", title, opts),
      dismiss: ctx.dismiss,
      clearAll: ctx.clearAll
    }),
    [ctx]
  );

  return { toast };
}

const VARIANT_META: Record<
  ToastVariant,
  { icon: typeof Info; ringColor: string; accentColor: string }
> = {
  success: {
    icon: CheckCircle2,
    ringColor: "var(--color-success)",
    accentColor: "var(--color-success-soft)"
  },
  error: {
    icon: AlertCircle,
    ringColor: "var(--color-critical)",
    accentColor: "var(--color-critical-soft)"
  },
  info: {
    icon: Info,
    ringColor: "var(--color-info)",
    accentColor: "var(--color-info-soft)"
  },
  warning: {
    icon: TriangleAlert,
    ringColor: "var(--color-warning)",
    accentColor: "var(--color-warning-soft)"
  }
};

function ToastViewport({
  toasts,
  dismiss
}: {
  toasts: ToastEntry[];
  dismiss: (id: string) => void;
}) {
  if (typeof window === "undefined") return null;
  if (toasts.length === 0) return null;
  return createPortal(
    <ol
      aria-live="polite"
      className="m-0 flex flex-col p-0 list-none"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        gap: 8,
        maxWidth: "calc(100vw - 32px)",
        width: "min(360px, calc(100vw - 32px))",
        pointerEvents: "none"
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </ol>,
    document.body
  );
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }) {
  const meta = VARIANT_META[entry.variant];
  const Icon = meta.icon;
  return (
    <li
      role="status"
      className="delivrix-toast-enter flex items-start"
      style={{
        gap: 10,
        padding: "12px 14px",
        // Impeccable fix: hairline color en perímetro, sin side-tab 3px.
        // El icono del meta.icon ya señala el tone semántico al usuario.
        background: "var(--color-surface)",
        border: `1px solid ${meta.ringColor}`,
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        pointerEvents: "auto"
      }}
    >
      <span
        aria-hidden="true"
        style={{ color: meta.ringColor, marginTop: 1, flexShrink: 0 }}
      >
        <Icon size={16} strokeWidth={2} />
      </span>
      <div className="flex flex-col min-w-0" style={{ gap: 2, flex: 1 }}>
        <span
          className="font-[family-name:var(--font-sans)] font-semibold leading-snug"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          {entry.title}
        </span>
        {entry.description ? (
          <span
            className="font-[family-name:var(--font-sans)] leading-snug"
            style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
          >
            {entry.description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cerrar notificación"
        className="inline-flex items-center justify-center transition-opacity hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "transparent",
          border: "none",
          color: "var(--color-text-tertiary)",
          cursor: "pointer",
          marginTop: -2,
          marginRight: -4,
          flexShrink: 0
        }}
      >
        <X size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </li>
  );
}
