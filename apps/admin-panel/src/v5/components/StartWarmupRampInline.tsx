/**
 * StartWarmupRampInline — disparador del warmup ramp con input runtime.
 *
 * Filosofía: el operador (humano) escribe las 3+ direcciones de prueba EN
 * EL MOMENTO en que decide arrancar el ramp. No viven en `.env.local`,
 * no son hardcodeadas. Cada vez que se prueba warmup, el operador define
 * a qué inboxes mandar los seeds.
 *
 * El handler POST /v1/warmup/ramp/start ya soporta `recipientPool` por
 * body; este componente solo es el form.
 *
 * INTEGRIDAD DE AUDITORÍA: el ramp firma un `actorId` + `approvalToken` en
 * la audit chain. Esos valores NO pueden ser literales de smoke-test. Deben
 * venir de una sesión de operador real (props `actorId`/`approvalToken`).
 * Mientras el panel NO tenga identidad autenticada, el POST directo firmado
 * queda DESHABILITADO — no se firma con un literal. La ruta compliant es
 * disparar el ramp vía el chat OpenClaw (useOpenClawIntent), donde el agente
 * ejecuta la acción bajo su propia identidad + audit chain.
 *
 * Mounted bajo cada DomainRow donde el dominio NO tenga ramp activo
 * todavía. Cuando arranca, el query de sender-pool refetcha y aparece
 * el WarmupRampPanel.
 *
 * Ref: REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §14
 * (warm-up disciplinado: el operador decide a qué inboxes manda cada
 * seed para poder monitorear placement en sus propios clientes Gmail/
 * Outlook).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Play, X, AlertCircle, CheckCircle2, ShieldAlert, Sparkles } from "lucide-react";
// MOLDE ÚNICO Aivora — card radius 18 + hairline + shadow; tipografía sans del demo.
import { Button, Card, Caption, Eyebrow, Heading, Pill } from "../../shared/ui/aivora";
import { useOpenClawIntent } from "../../shared/ui/v2";
import { startWarmupRamp, type StartWarmupRampResult } from "../../shared/api/client";

interface StartWarmupRampInlineProps {
  domain: string;
  /**
   * Token de aprobación real del audit chain, derivado de una sesión de
   * operador autenticada. Sin este valor NO se firma el POST directo.
   */
  approvalToken?: string;
  /**
   * ID de operador autenticado que va a la audit chain. Sin identidad real
   * NO se firma el POST directo.
   */
  actorId?: string;
}

/* ----- helpers de texto (tokens del demo, sin primitivos v5 B/N) ----- */

function BodySm({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)", ...style }}>{children}</p>;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function StartWarmupRampInline({
  domain,
  approvalToken,
  actorId
}: StartWarmupRampInlineProps) {
  const queryClient = useQueryClient();
  const { sendIntent } = useOpenClawIntent();
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState("");
  const [schedule, setSchedule] = useState<"demo-fast" | "production-14d">("demo-fast");

  const recipients = parseRecipients(raw);
  const invalid = recipients.filter((r) => !isValidEmail(r));
  const poolReady = recipients.length >= 3 && invalid.length === 0;
  // Identidad real = actorId + approvalToken provistos por una sesión autenticada.
  // Sin ambos, NO se puede firmar la audit chain con un POST directo.
  const hasSignerIdentity = Boolean(actorId && actorId.trim() && approvalToken && approvalToken.trim());
  const canSubmit = poolReady && hasSignerIdentity;

  const mutation = useMutation<StartWarmupRampResult, Error>({
    mutationFn: () => {
      if (!actorId || !approvalToken) {
        // Guard de integridad: nunca firmamos con un literal.
        throw new Error("Falta identidad de operador o token de aprobación real.");
      }
      return startWarmupRamp({
        domain,
        schedule,
        recipientPool: recipients,
        actorId,
        approvalToken
      });
    },
    onSuccess: (result) => {
      if (result.status === "blocked") return;
      // refetch sender-pool para que WarmupRampPanel aparezca
      queryClient.invalidateQueries({ queryKey: ["sender-pool", "status"] });
      queryClient.invalidateQueries({ queryKey: ["warmup-ramp", domain] });
      setExpanded(false);
      setRaw("");
    }
  });

  function startViaOpenClaw() {
    const seedList = recipients.length > 0 ? recipients.join(", ") : "(definí 3+ inboxes de prueba)";
    const prompt =
      `Iniciá el warmup ramp del dominio ${domain} con schedule ${schedule}. ` +
      `Seeds de prueba: ${seedList}. ` +
      `Firmá el arranque en la audit chain con tu identidad y el token de aprobación real (NO uses un literal de smoke-test).`;
    sendIntent(prompt, `sender-pool:start-warmup-ramp:${domain}`);
  }

  if (!expanded) {
    return (
      <div className="flex items-center gap-2 pl-7">
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          <Play size={11} strokeWidth={1.75} />
          Iniciar warmup
        </Button>
      </div>
    );
  }

  return (
    <Card className="ml-7 flex flex-col gap-3" style={{ padding: 16 }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>Warmup ramp · {domain}</Eyebrow>
          <Heading level={3}>¿A qué inboxes mandamos el seed?</Heading>
        </div>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            mutation.reset();
          }}
          className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
          aria-label="Cerrar"
        >
          <X size={12} strokeWidth={1.75} />
        </button>
      </div>

      <BodySm>
        Pega <strong>3 o más direcciones de prueba</strong> donde quieras recibir
        los seeds — una por línea o separadas por coma. Pueden ser tus propios
        Gmail/Outlook/Yahoo, plus-addressing también funciona. Estas direcciones
        NO se guardan en config: viven sólo en este ramp.
      </BodySm>

      <label className="flex flex-col gap-1.5">
        <Caption style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Direcciones de prueba
        </Caption>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={"seed1@gmail.com\nseed2@outlook.com\nseed3@yahoo.com"}
          rows={4}
          className="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex items-center gap-3">
          <Caption style={{ fontSize: 10.5 }}>
            {recipients.length} dirección{recipients.length === 1 ? "" : "es"} parsed
            {invalid.length > 0 ? ` · ${invalid.length} inválida${invalid.length === 1 ? "" : "s"}` : ""}
          </Caption>
          {poolReady ? (
            <CheckCircle2 size={11} strokeWidth={1.75} className="text-success" />
          ) : null}
        </div>
      </label>

      <label className="flex items-center gap-3">
        <Caption style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Schedule
        </Caption>
        <select
          value={schedule}
          onChange={(e) => setSchedule(e.target.value as typeof schedule)}
          className="rounded-md border border-border bg-bg px-2 py-1 font-sans text-[12px] text-fg focus:outline-none focus:ring-1 focus:ring-fg"
        >
          <option value="demo-fast">demo-fast (5 batches, 10 min, cap 270)</option>
          <option value="production-14d">production-14d (14 batches diarios)</option>
        </select>
      </label>

      {!hasSignerIdentity ? (
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
          style={{
            border: "1px solid var(--color-warning-border)",
            background: "var(--color-warning-soft)",
            color: "var(--color-warning-fg)"
          }}
        >
          <ShieldAlert size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: "var(--color-warning)" }} />
          <div className="flex flex-col gap-0.5">
            <strong className="text-[12px]">Sin identidad de operador para firmar</strong>
            <span>
              El arranque del ramp se firma en la audit chain con tu identidad y un token de aprobación
              real. Este panel todavía no tiene una sesión autenticada, así que el POST directo queda
              deshabilitado. Disparalo vía OpenClaw: el agente lo ejecuta y lo firma bajo su propia
              identidad auditada.
            </span>
          </div>
        </div>
      ) : null}

      {mutation.data?.status === "blocked" && mutation.data.blockers ? (
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
          style={{
            border: "1px solid var(--color-warning-border)",
            background: "var(--color-warning-soft)",
            color: "var(--color-warning-fg)"
          }}
        >
          <AlertCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: "var(--color-warning)" }} />
          <div className="flex flex-col gap-0.5">
            <strong className="text-[12px]">Gates bloquearon el ramp</strong>
            <ul className="m-0 list-none p-0 font-mono text-[11px]">
              {mutation.data.blockers.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {mutation.error ? (
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
          style={{
            border: "1px solid var(--color-critical-border)",
            background: "var(--color-critical-soft)",
            color: "var(--color-critical-fg)"
          }}
        >
          <AlertCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: "var(--color-critical)" }} />
          <span>{mutation.error.message}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Caption style={{ fontSize: 10.5 }}>
          Cada seed firmado en audit chain · pause &amp; resume disponibles desde el panel.
        </Caption>
        <div className="flex items-center gap-2">
          {mutation.data?.ok ? <Pill tone="success">ramp iniciado</Pill> : null}
          {hasSignerIdentity ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              <Send size={11} strokeWidth={1.75} />
              {mutation.isPending ? "Iniciando…" : "Iniciar ramp"}
            </Button>
          ) : (
            <Button
              variant="gradient"
              size="sm"
              disabled={!poolReady}
              onClick={startViaOpenClaw}
              title={poolReady ? "Disparar vía OpenClaw (firma auditada)" : "Cargá 3+ inboxes válidos primero"}
            >
              <Sparkles size={11} strokeWidth={1.75} />
              Iniciar vía OpenClaw
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
