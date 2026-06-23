/**
 * OpenClaw Intent Router — convierte "botones aspiracionales" sin endpoint
 * propio en prompts pre-llenados al chat OpenClaw real.
 *
 * Filosofía: el chat OpenClaw via SSH bridge YA funciona end-to-end. En lugar
 * de toasts "acción pendiente backend", los botones del panel pueden dispar
 * un intent que:
 *   1. Navega a la sección Canvas (donde vive el chat).
 *   2. Pre-llena el textarea con un prompt específico.
 *   3. Hace focus para que el operador solo presione Enter (o ajuste antes).
 *
 * Beneficios:
 *   - Aprovecha el RPC OpenClaw + Bedrock que ya está cableado.
 *   - Audit chain captura cada intent (el chat ya escribe audit events).
 *   - OpenClaw puede ejecutar cualquier skill registrado (publish_proposal,
 *     plan_degradation, evaluate_runbook, etc.) sin que el panel necesite
 *     endpoints HTTP nuevos.
 *   - El operador siempre revisa el prompt antes de enviar — control humano.
 *
 * Uso:
 *   const { sendIntent } = useOpenClawIntent();
 *   sendIntent("Revisa el plan de degradación de la topología y propón los próximos pasos.");
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

interface OpenClawIntentContextValue {
  /** Operador o módulo dispara: navega a Canvas + pre-llena el chat. */
  sendIntent: (prompt: string, source?: string) => void;
  /** Navegación directa del shell sin crear intent de chat. */
  navigateTo: (section: string) => void;
  /**
   * El ChatInput consume el intent pendiente al mount. Devuelve el prompt y
   * lo limpia. Si no hay intent, devuelve null.
   */
  consumePendingIntent: () => { prompt: string; source: string | null } | null;
}

const OpenClawIntentContext = createContext<OpenClawIntentContextValue | null>(
  null
);

const STORAGE_KEY = "delivrix.openclaw.intent";

/**
 * Provider — guarda el intent en localStorage para sobrevivir el unmount del
 * componente origen (ej la card que disparó el intent puede desmontarse
 * cuando el usuario navega a Canvas).
 */
export function OpenClawIntentProvider({
  children,
  onNavigate
}: {
  children: ReactNode;
  /** Callback para navegar a una sección específica (típicamente "canvas"). */
  onNavigate?: (section: string) => void;
}) {
  const [tick, setTick] = useState(0);

  const sendIntent = useCallback(
    (prompt: string, source?: string) => {
      try {
        const payload = {
          prompt,
          source: source ?? null,
          ts: Date.now()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // localStorage puede fallar en private browsing — fallback silencioso.
      }
      onNavigate?.("canvas");
      setTick((t) => t + 1);
    },
    [onNavigate]
  );

  const navigateTo = useCallback((section: string) => {
    onNavigate?.(section);
  }, [onNavigate]);

  const consumePendingIntent = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      localStorage.removeItem(STORAGE_KEY);
      const parsed = JSON.parse(raw) as { prompt?: unknown; source?: unknown; ts?: unknown };
      if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
        return null;
      }
      // Evitar intents viejos (más de 30s sugiere refresh manual del usuario).
      if (typeof parsed.ts === "number" && Date.now() - parsed.ts > 30_000) {
        return null;
      }
      return {
        prompt: parsed.prompt,
        source: typeof parsed.source === "string" ? parsed.source : null
      };
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<OpenClawIntentContextValue>(
    () => ({ sendIntent, navigateTo, consumePendingIntent }),
    [sendIntent, navigateTo, consumePendingIntent]
  );

  // tick forzaria re-render de consumidores si lo necesitaran (no expuesto).
  void tick;

  return (
    <OpenClawIntentContext.Provider value={value}>
      {children}
    </OpenClawIntentContext.Provider>
  );
}

/**
 * Hook con fallback no-op cuando no hay provider (ej tests). Devuelve siempre
 * una API funcional para que los callers no tengan que envolver en if.
 */
export function useOpenClawIntent(): OpenClawIntentContextValue {
  const ctx = useContext(OpenClawIntentContext);
  if (ctx) return ctx;
  // Fallback: log a console pero no rompe.
  return {
    navigateTo: (section) => {
      // eslint-disable-next-line no-console
      console.warn("[OpenClawIntent] No provider mounted. Navegación ignorada:", section);
    },
    sendIntent: (prompt) => {
      // eslint-disable-next-line no-console
      console.warn("[OpenClawIntent] No provider mounted. Intent ignorado:", prompt);
    },
    consumePendingIntent: () => null
  };
}

/**
 * Helper hook para componentes que quieren leer el intent al mount (ej
 * ChatInput). Llama callback `onIntent(prompt, source)` y limpia localStorage.
 */
export function useConsumeIntentOnMount(
  callback: (prompt: string, source: string | null) => void
): void {
  const { consumePendingIntent } = useOpenClawIntent();
  useEffect(() => {
    const pending = consumePendingIntent();
    if (pending) {
      callback(pending.prompt, pending.source);
    }
    // mount-only: corremos una vez al montar el componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
