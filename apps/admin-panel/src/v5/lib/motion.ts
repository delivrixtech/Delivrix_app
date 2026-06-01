import type { Transition, Variants } from "framer-motion";

/**
 * Sistema de motion v5 — TasteSkill MOTION_INTENSITY=1/5 (minimal).
 *
 * Solo movimiento funcional. Cero entrance animations decorativas.
 * Easings calibrados para "se siente vivo pero no distrae".
 */

export const easeOutQuart: Transition["ease"] = [0.25, 1, 0.5, 1];
export const easeOutExpo: Transition["ease"] = [0.16, 1, 0.3, 1];
export const easeStandard: Transition["ease"] = [0.4, 0, 0.2, 1];

export const durations = {
  fast: 0.12,
  base: 0.2,
  slow: 0.32,
  page: 0.4
};

/** Page entrance — fade subtle. */
export const pageEnter: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { duration: durations.page, ease: easeOutExpo } },
  exit: { opacity: 0, transition: { duration: durations.fast } }
};

/** Stagger lista (cards/items) — cascada 40ms entre items. */
export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } }
};

/**
 * staggerItem — IMPORTANTE: initial DEBE ser { opacity: 1 } por seguridad.
 *
 * Framer Motion propaga variants string-based (initial="initial" animate="animate")
 * por contexto React, pero cuando hay function components no-motion entre el
 * staggerContainer padre y los staggerItem hijos, la propagación se corta y los
 * items quedan stuck en initial (opacity 0) — contenido invisible.
 *
 * Fix 2026-05-28: empezamos en opacity 1 (siempre visible). El animate sigue
 * siendo opacity 1 — no añade entrance fade pero garantiza que NADA queda
 * invisible cuando hay components intermedios.
 *
 * Si quieres entrance fade-up en una vista, agrega initial="initial"
 * animate="animate" EXPLÍCITAMENTE a cada motion.* y usa enterFromBelow
 * (definido abajo).
 */
export const staggerItem: Variants = {
  initial: { opacity: 1, y: 0 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: durations.base, ease: easeOutQuart }
  }
};

/**
 * enterFromBelow — usar SOLO cuando puedas garantizar que el motion component
 * tiene initial="initial" animate="animate" propio (no depende del padre).
 */
export const enterFromBelow: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: durations.base, ease: easeOutQuart }
  }
};

/** Sidebar slide. */
export const sidebarSlide: Variants = {
  collapsed: { width: 64 },
  expanded: { width: 256 }
};

/** Pulse del agente IA — barra 60×2px que viaja. */
export const agentPulse: Variants = {
  idle: { opacity: 0 },
  thinking: {
    opacity: 1,
    transition: { duration: durations.base, ease: easeStandard }
  }
};
