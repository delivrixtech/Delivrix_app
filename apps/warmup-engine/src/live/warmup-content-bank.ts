// Banco de contenido v1 del warmup — conversaciones cotidianas VARIADAS para calentar bandejas.
//
// Diseño v1 (source of truth): el warmup se calienta con tráfico que parece humano. En vez de pedirle
// a un LLM que escriba cada correo (caro, no determinista, riesgo de patrones raros), curamos un BANCO
// de conversaciones naturales y las ROTAMOS. Cada entrada es un hilo completo: asunto + cuerpo + la
// respuesta esperada (para cerrar el loop bidireccional). Sin links, sin marketing, sin CTA — charla
// cotidiana de temas distintos para no levantar sospechas.
//
// Determinista a propósito: pickConversation(index) rota el banco de forma estable (mismo index →
// misma conversación). El runner varía el index por vuelta; los tests lo verifican sin azar.

import conversationsData from "./warmup-conversations.json" with { type: "json" };

export interface WarmupConversation {
  /** Etiqueta corta del tema (reunion, cafe, planilla…). Sólo para trazas/legibilidad. */
  topic: string;
  subject: string;
  body: string;
  /** Respuesta que el seed manda de vuelta al box para cerrar el hilo (señal bidireccional). */
  reply: string;
}

const RAW = (conversationsData as { conversations: WarmupConversation[] }).conversations;

/** Banco completo (copia congelada — el llamador no puede mutarlo). */
export const WARMUP_CONVERSATIONS: readonly WarmupConversation[] = Object.freeze(
  RAW.map((c) => Object.freeze({ topic: c.topic, subject: c.subject, body: c.body, reply: c.reply }))
);

/** Cantidad de conversaciones distintas disponibles. */
export function conversationCount(): number {
  return WARMUP_CONVERSATIONS.length;
}

/**
 * Elige una conversación de forma determinista y estable por índice (rota el banco).
 * `index` puede ser cualquier entero (se normaliza con módulo); negativos y grandes son válidos.
 */
export function pickConversation(index: number): WarmupConversation {
  const n = WARMUP_CONVERSATIONS.length;
  if (n === 0) throw new Error("warmup content bank is empty");
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  const i = ((safe % n) + n) % n;
  return WARMUP_CONVERSATIONS[i] as WarmupConversation;
}

/**
 * Genera un test-id único y observable para estampar en el header X-Delivrix-Test-Id.
 * No usa azar (los scripts pasan un seed estable, p.ej. un timestamp) para mantener trazabilidad.
 */
export function makeTestId(seed: string | number): string {
  return `warmup-cycle-${String(seed)}`;
}
