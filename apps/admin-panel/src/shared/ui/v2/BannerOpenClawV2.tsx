import { ArrowRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { useOpenClawIntent } from "./OpenClawIntent.tsx";
import { useToast } from "./Toast.tsx";

export interface BannerOpenClawV2Props {
  title: string;
  body: ReactNode;
  primaryCta: string;
  secondaryCta?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  className?: string;
}

/**
 * Construye el prompt que se va a inyectar en el chat OpenClaw según el texto
 * del CTA + el título y body del banner. Esto convierte cada botón "aspiracional"
 * en una conversación REAL con OpenClaw que sí puede ejecutar la acción via skills.
 *
 * Filosofía: en lugar de toasts "pendiente backend", el operador queda en el
 * Canvas con el prompt pre-llenado, lo revisa y presiona Enter. OpenClaw
 * responde via Bedrock + ejecuta los skills correspondientes. Audit chain queda
 * con el intent completo.
 */
function buildIntentPrompt(cta: string, title: string, body: ReactNode): string {
  const lower = cta.toLowerCase();
  const ctxTitle = typeof title === "string" ? title : "";
  const ctxBody = typeof body === "string" ? body : "";
  const context = [ctxTitle, ctxBody].filter(Boolean).join(" · ");
  if (lower.includes("revisar plan de degradación") || lower.includes("plan dry-run") || lower.includes("plan ordenado")) {
    return `Acción del operador: ${cta}.\n\nContexto del panel: ${context}\n\nPor favor revisa el plan, identifica los próximos pasos y proponme un dry-run claro con audit chain.`;
  }
  if (lower.includes("ver runbook") || lower.includes("runbook")) {
    return `Acción del operador: ${cta}.\n\nContexto: ${context}\n\nMuéstrame el runbook relevante con los pasos a seguir. Si es un incidente, incluye los gates de aprobación requeridos.`;
  }
  if (lower.includes("revisar recomendación") || lower.includes("ver recomendación")) {
    return `Acción del operador: ${cta}.\n\nContexto: ${context}\n\nExplícame en detalle la recomendación, su evidencia, y qué decisión necesitas que tome.`;
  }
  if (lower.includes("ver plan") || lower.includes("ver evidencia") || lower.includes("ver gráfica") || lower.includes("ver incidente")) {
    return `Acción del operador: ${cta}.\n\nContexto: ${context}\n\nTráeme la evidencia o el plan ordenado por impacto. Cita los snapshots y eventos del audit chain.`;
  }
  // Default: prompt genérico que pasa el contexto completo al agente.
  return `Acción del operador: ${cta}.\n\nContexto del panel: ${context}\n\nPor favor procede con esta acción usando los skills disponibles y reporta resultado.`;
}

/**
 * Fallback handler para CTAs sin onClick explícito.
 *
 * Estrategia inteligente: en lugar de toast "pendiente backend":
 *   - "abrir canvas" / "ir al canvas" → solo navega (no inyecta prompt).
 *   - "abrir chat" / "ir al chat" → solo focus al textarea.
 *   - resto → navega a Canvas + inyecta prompt pre-llenado → operador
 *     solo presiona Enter para que OpenClaw ejecute la skill correspondiente.
 *
 * Esto aprovecha el chat real (SSH bridge ya cableado) sin necesidad de
 * endpoints backend nuevos por cada CTA del panel.
 */
function buildFallbackHandler(
  label: string,
  title: string,
  body: ReactNode,
  toastApi: ReturnType<typeof useToast>["toast"],
  intent: ReturnType<typeof useOpenClawIntent>
): () => void {
  const lower = label.toLowerCase();
  if (lower === "abrir canvas" || lower === "ir al canvas") {
    return () => {
      intent.sendIntent("", `banner:${label}`);
    };
  }
  if (lower === "abrir chat" || lower === "ir al chat") {
    return () => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="OpenClaw"]');
      if (textarea) {
        textarea.focus();
        textarea.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        // Si el chat no está visible (estamos en otra sección), navega a Canvas.
        intent.sendIntent("", `banner:${label}`);
      }
    };
  }
  // Para cualquier otra acción: navegar a Canvas + pre-llenar el chat con prompt.
  return () => {
    const prompt = buildIntentPrompt(label, title, body);
    intent.sendIntent(prompt, `banner:${label}`);
    toastApi.info(`Enviando a OpenClaw · ${label}`, {
      description: "Prompt pre-llenado en el chat. Revisa y presiona Enter para ejecutar.",
      duration: 2500
    });
  };
}

/**
 * BannerOpenClawV2 — banner agente con icon + texto + CTAs.
 *
 * Layout responsive: en containers anchos (>= ~520px) renderiza horizontal con
 * texto al centro y CTAs a la derecha. En containers angostos (sidebars, KPI
 * columns) colapsa a layout vertical para evitar el bug en el que el texto se
 * comprimía a "una palabra por línea" y los CTAs se solapaban con el título.
 *
 * Truco: usamos flex-wrap + min-width:200px en la columna de texto. Si el
 * contenedor no puede acomodar 40px icon + 200px texto + ~280px CTAs, los CTAs
 * envuelven a la línea siguiente automáticamente.
 *
 * Tipografía: title 14px Geist semibold (Funnel pierde carácter sub-20px).
 */
export function BannerOpenClawV2({
  title,
  body,
  primaryCta,
  secondaryCta,
  onPrimary,
  onSecondary,
  className
}: BannerOpenClawV2Props) {
  const { toast } = useToast();
  const intent = useOpenClawIntent();
  const handlePrimary = onPrimary ?? buildFallbackHandler(primaryCta, title, body, toast, intent);
  const handleSecondary = secondaryCta
    ? onSecondary ?? buildFallbackHandler(secondaryCta, title, body, toast, intent)
    : undefined;
  return (
    <section
      className={cn("flex flex-wrap items-start", className)}
      style={{
        gap: 14,
        padding: "14px 16px",
        borderRadius: "var(--radius-md)",
        // Impeccable fix: hairline en perímetro + surface tint, no side-tab.
        background: "var(--color-warning-soft)",
        border: "1px solid var(--color-warning)"
      }}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          // Fix 2026-05-28: antes usaba accent-tertiary que vira a #ffffff
          // en dark mode, dejando el sparkle blanco sobre cuadrado blanco
          // (invisible). always-dark-bg lo fija a negro en cualquier tema.
          background: "var(--color-always-dark-bg)",
          color: "var(--color-on-dark-strong)"
        }}
      >
        <Sparkles size={16} strokeWidth={2} />
      </div>
      <div
        className="flex flex-col"
        style={{ gap: 4, flex: "1 1 200px", minWidth: 180 }}
      >
        <h3
          className="m-0 font-[family-name:var(--font-sans)] font-semibold leading-snug"
          style={{
            fontSize: 13,
            color: "var(--color-warning)",
            letterSpacing: "var(--tracking-tight)"
          }}
        >
          {title}
        </h3>
        <p
          className="m-0 font-[family-name:var(--font-body)]"
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--color-text-secondary)"
          }}
        >
          {body}
        </p>
      </div>
      <div
        className="flex flex-wrap items-center shrink-0"
        style={{ gap: 6 }}
      >
        <button
          type="button"
          onClick={handlePrimary}
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "7px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-warning)",
            color: "var(--color-on-dark-strong)",
            fontSize: 12,
            border: "1px solid var(--color-warning)",
            cursor: "pointer"
          }}
        >
          {primaryCta}
          <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
        {secondaryCta ? (
          <button
            type="button"
            onClick={handleSecondary}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-medium leading-none transition-colors hover:bg-[var(--color-warning-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              padding: "7px 12px",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--color-warning)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)",
              fontSize: 12,
              cursor: "pointer"
            }}
          >
            {secondaryCta}
          </button>
        ) : null}
      </div>
    </section>
  );
}
