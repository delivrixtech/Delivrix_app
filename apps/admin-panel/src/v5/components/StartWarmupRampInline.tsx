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
 * Mounted bajo cada DomainRow donde el dominio NO tenga ramp activo
 * todavía. Cuando arranca, el query de sender-pool refetcha y aparece
 * el WarmupRampPanel.
 *
 * Ref: REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §14
 * (warm-up disciplinado: el operador decide a qué inboxes manda cada
 * seed para poder monitorear placement en sus propios clientes Gmail/
 * Outlook).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Play, X, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  BodySm,
  Button,
  Caption,
  Card,
  Eyebrow,
  H3,
  Pill
} from "./primitives";
import { startWarmupRamp, type StartWarmupRampResult } from "../../shared/api/client";

interface StartWarmupRampInlineProps {
  domain: string;
  /** Token de aprobación del audit chain (1 firma local en MVP). */
  approvalToken?: string;
  /** ID de operador que va a la audit chain. */
  actorId?: string;
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
  approvalToken = "smoke-local",
  actorId = "operator/juanes"
}: StartWarmupRampInlineProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState("");
  const [schedule, setSchedule] = useState<"demo-fast" | "production-14d">("demo-fast");

  const recipients = parseRecipients(raw);
  const invalid = recipients.filter((r) => !isValidEmail(r));
  const canSubmit = recipients.length >= 3 && invalid.length === 0;

  const mutation = useMutation<StartWarmupRampResult, Error>({
    mutationFn: () =>
      startWarmupRamp({
        domain,
        schedule,
        recipientPool: recipients,
        actorId,
        approvalToken
      }),
    onSuccess: (result) => {
      if (result.status === "blocked") return;
      // refetch sender-pool para que WarmupRampPanel aparezca
      queryClient.invalidateQueries({ queryKey: ["sender-pool", "status"] });
      queryClient.invalidateQueries({ queryKey: ["warmup-ramp", domain] });
      setExpanded(false);
      setRaw("");
    }
  });

  if (!expanded) {
    return (
      <div className="flex items-center gap-2 pl-7">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(true)}
        >
          <Play size={11} strokeWidth={1.75} />
          Iniciar warmup
        </Button>
      </div>
    );
  }

  return (
    <Card padding="default" className="ml-7 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>Warmup ramp · {domain}</Eyebrow>
          <H3 className="text-[14px]">¿A qué inboxes mandamos el seed?</H3>
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
        <Caption className="text-[10.5px] uppercase tracking-wider">
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
          <Caption className="text-[10.5px]">
            {recipients.length} dirección{recipients.length === 1 ? "" : "es"} parsed
            {invalid.length > 0 ? ` · ${invalid.length} inválida${invalid.length === 1 ? "" : "s"}` : ""}
          </Caption>
          {recipients.length >= 3 && invalid.length === 0 ? (
            <CheckCircle2 size={11} strokeWidth={1.75} className="text-success" />
          ) : null}
        </div>
      </label>

      <label className="flex items-center gap-3">
        <Caption className="text-[10.5px] uppercase tracking-wider">
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

      {mutation.data?.status === "blocked" && mutation.data.blockers ? (
        <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-[12px] text-warning-fg">
          <AlertCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
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
        <div className="flex items-start gap-2 rounded-md border border-critical bg-critical-soft px-3 py-2 text-[12px] text-critical-fg">
          <AlertCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-critical" />
          <span>{mutation.error.message}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <Caption className="text-[10.5px]">
          Cada seed firmado en audit chain · pause &amp; resume disponibles desde el panel.
        </Caption>
        <div className="flex items-center gap-2">
          {mutation.data?.ok ? (
            <Pill tone="success" size="sm">
              ramp iniciado
            </Pill>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Send size={11} strokeWidth={1.75} />
            {mutation.isPending ? "Iniciando…" : "Iniciar ramp"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
