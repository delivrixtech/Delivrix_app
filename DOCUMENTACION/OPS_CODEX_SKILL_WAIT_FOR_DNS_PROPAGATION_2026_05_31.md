# OPS Codex — Skill `wait_for_dns_propagation`

**Fecha despacho:** 2026-05-31 domingo 14:30 COT.
**Fecha ejecución:** **HOY MISMO. Trabajar en paralelo con OPS 2/3/4.**
**Severidad:** P1 — bloquea cierre del flow E2E SMTP autónomo (Fase 1).
**Owner:** Codex backend senior (puede correr en sub-agente paralelo).
**PM:** Claude.
**Modo:** URGENT — Juanes pidió cierre E2E autónomo HOY domingo.

---

## Síntoma / Motivación

OpenClaw hoy compra un dominio en Route53 (skill `register_domain_route53` OK), pero el siguiente paso del flow E2E asume propagación DNS instantánea. Eso es falso: NS records demoran 2–10 min, A records pueden tardar hasta 30 min según resolver. Sin una skill que **bloquee hasta confirmar propagación**, el flow:

- Intenta crear VPS Webdock antes de que el dominio resuelva.
- Intenta instalar Postfix sin que el VPS responda al hostname.
- Falla con timeouts opacos en `provision_smtp_postfix` o `bind_domain_to_server`.

Necesitamos una skill **sincrónica bloqueante** que poll DNS hasta que el record esperado aparezca o se cumpla el timeout. Es lectura solamente, no muta estado.

---

## Decisión arquitectónica

- **Categoría matrix:** `supervised_local_state` (1 firma operador via ApprovalGate).
  - Aunque es solo lectura, bloquea el flow del agente por hasta 10 min. Pedimos firma para que el operador confirme conscientemente que está dispuesto a esperar (y no abortar el turno).
  - **Alternativa rechazada:** `read_only` sin firma. La rechazamos porque OpenClaw podría llamarla en loop infinito si el TTL es alto. Con firma, el operador firma 1 vez y queda explícito en audit chain.
- **Sincrónica:** la skill bloquea hasta resultado. NO devuelve `pending` async. Esto simplifica el loop tool_use de Fase 1.
- **Rate-limit interno:** mínimo `pollIntervalMs = 30_000` (30s). Si OpenClaw pide menos, se redondea hacia arriba.
- **Max wait absoluto:** `maxWaitMs ≤ 600_000` (10 min) hard cap. Si OpenClaw pide más, se rechaza con `invalid_params`.
- **Auto-rollback:** no aplica (lectura).
- **Audit event:** `oc.dns.propagation_check` con metadata `{ domain, expectedRecord, attempts, lastSeen, durationMs, ok }`.
- **Sin dependencia externa:** usa `node:dns/promises` (`resolve4`, `resolveNs`, `resolveMx`). NO usa libs como `dig`, `nslookup`, `dns-query`.

---

## Tarea 1 — Schema zod

**Archivo nuevo:** `apps/gateway-api/src/routes/dns-wait.ts`.

```typescript
import { z } from "zod";

export const waitForDnsPropagationParamSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9-]{1,63})+$/, "domain_invalid_format"),
  expectedRecord: z.object({
    type: z.enum(["A", "NS", "MX"]),
    value: z.string().min(1).max(253)
  }),
  maxWaitMs: z
    .number()
    .int()
    .min(30_000)        // mínimo 30s
    .max(600_000)       // máximo 10min
    .default(600_000),
  pollIntervalMs: z
    .number()
    .int()
    .min(30_000)        // mínimo 30s
    .max(120_000)       // máximo 2min
    .default(30_000),
  actorId: z.string().min(1).max(120),
  approvalToken: z.string().min(1).max(200)
});

export type WaitForDnsPropagationParams = z.infer<typeof waitForDnsPropagationParamSchema>;

export interface WaitForDnsPropagationResult {
  ok: boolean;
  attempts: number;
  lastSeen: string;            // último valor visto, "" si nada
  durationMs: number;
  error?: "timeout" | "value_mismatch" | "resolver_error" | "domain_nxdomain";
  errorDetails?: string;
  eventId: string;             // audit event ID
}
```

---

## Tarea 2 — Poll loop con `dns.resolve()` nativo

```typescript
import { promises as dns } from "node:dns";

async function pollDnsRecord(input: {
  domain: string;
  expectedRecord: { type: "A" | "NS" | "MX"; value: string };
  maxWaitMs: number;
  pollIntervalMs: number;
  now: () => number;
}): Promise<{
  ok: boolean;
  attempts: number;
  lastSeen: string;
  durationMs: number;
  error?: WaitForDnsPropagationResult["error"];
  errorDetails?: string;
}> {
  const startedAt = input.now();
  let attempts = 0;
  let lastSeen = "";
  let lastError: string | undefined;

  while (input.now() - startedAt < input.maxWaitMs) {
    attempts += 1;
    try {
      let observed: string[] = [];
      if (input.expectedRecord.type === "A") {
        observed = await dns.resolve4(input.domain);
      } else if (input.expectedRecord.type === "NS") {
        observed = (await dns.resolveNs(input.domain)).map((ns) => ns.toLowerCase().replace(/\.$/, ""));
      } else if (input.expectedRecord.type === "MX") {
        const mx = await dns.resolveMx(input.domain);
        observed = mx.map((entry) => entry.exchange.toLowerCase().replace(/\.$/, ""));
      }
      lastSeen = observed.join(",");
      const expectedValue = input.expectedRecord.value.toLowerCase().replace(/\.$/, "");
      const matches = observed.some(
        (value) => value.toLowerCase().replace(/\.$/, "") === expectedValue
      );
      if (matches) {
        return {
          ok: true,
          attempts,
          lastSeen,
          durationMs: input.now() - startedAt
        };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
      lastError = `${code}: ${(err as Error).message ?? "unknown"}`;
      if (code === "ENOTFOUND") {
        // NXDOMAIN — pero seguimos polling porque pudo no haber propagado aún
        lastSeen = "(nxdomain)";
      }
    }

    // No exceder maxWaitMs en el último intento
    const remaining = input.maxWaitMs - (input.now() - startedAt);
    if (remaining <= 0) break;
    const sleepMs = Math.min(input.pollIntervalMs, remaining);
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  const durationMs = input.now() - startedAt;
  if (lastSeen === "" || lastSeen === "(nxdomain)") {
    return {
      ok: false,
      attempts,
      lastSeen,
      durationMs,
      error: "domain_nxdomain",
      errorDetails: lastError
    };
  }
  return {
    ok: false,
    attempts,
    lastSeen,
    durationMs,
    error: "value_mismatch",
    errorDetails: `expected ${input.expectedRecord.value}, observed ${lastSeen}`
  };
}
```

---

## Tarea 3 — Handler HTTP

```typescript
export interface WaitForDnsPropagationDeps {
  auditLog: { append(event: AuditEventInput): Promise<AuditEvent | unknown> };
  approvalGuard: {
    verify(opts: { approvalToken: string; actorId: string }): Promise<{ ok: boolean; eventId?: string }>;
  };
  dns?: { resolve4: typeof dns.resolve4; resolveNs: typeof dns.resolveNs; resolveMx: typeof dns.resolveMx };
  now: () => number;
}

export async function handleWaitForDnsPropagation(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: WaitForDnsPropagationDeps;
}): Promise<void> {
  const body = await readJsonBody(input.request);
  const parsed = waitForDnsPropagationParamSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;

  // 1. Verificar firma operador
  const approval = await input.deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    sendJson(input.response, 403, { error: "approval_invalid" });
    return;
  }

  // 2. Ejecutar poll loop
  const result = await pollDnsRecord({
    domain: params.domain,
    expectedRecord: params.expectedRecord,
    maxWaitMs: params.maxWaitMs,
    pollIntervalMs: params.pollIntervalMs,
    now: input.deps.now
  });

  // 3. Audit event con prevHash chain
  const auditEvent = await input.deps.auditLog.append({
    type: "oc.dns.propagation_check",
    actorId: params.actorId,
    metadata: {
      domain: params.domain,
      expectedRecordType: params.expectedRecord.type,
      expectedRecordValue: params.expectedRecord.value,
      attempts: result.attempts,
      lastSeen: result.lastSeen,
      durationMs: result.durationMs,
      ok: result.ok,
      error: result.error ?? null,
      approvalEventId: approval.eventId ?? null
    }
  });

  sendJson(input.response, result.ok ? 200 : 408, {
    ok: result.ok,
    attempts: result.attempts,
    lastSeen: result.lastSeen,
    durationMs: result.durationMs,
    error: result.error,
    errorDetails: result.errorDetails,
    eventId: (auditEvent as { id?: string }).id ?? null
  } satisfies WaitForDnsPropagationResult);
}
```

---

## Tarea 4 — Wire en `main.ts` + `skill-dispatcher.ts`

1. **main.ts:** registrar ruta `POST /v1/skills/wait-for-dns-propagation`.
2. **skill-dispatcher.ts:** agregar entry al map:

```typescript
const waitForDnsPropagation: SkillHandlerEntry = {
  paramSchema: waitForDnsPropagationParamSchema,
  timeoutMs: 700_000,    // 10min + buffer
  canRollback: false,
  invoke: ({ request, response, deps }) =>
    handleWaitForDnsPropagation({
      request,
      response,
      deps: {
        auditLog: deps.auditLog,
        approvalGuard: deps.approvalGuard,
        now: deps.now
      }
    })
};

return {
  // ... existing
  wait_for_dns_propagation: waitForDnsPropagation,
  dns_propagation_wait: waitForDnsPropagation     // alias
};
```

3. **OPENCLAW_PERMISSIONS_MATRIX.md:** agregar fila con categoría `supervised_local_state`, reversible `n/a`, rollback `n/a`, costo `$0`.

---

## Tarea 5 — Tests obligatorios

**Archivo:** `apps/gateway-api/src/routes/dns-wait.test.ts`.

Mínimo 9 tests:

1. **Happy path A record** — mock `dns.resolve4` retorna `["1.2.3.4"]` en primer intento. `expectedRecord.value = "1.2.3.4"` → `ok: true, attempts: 1`.
2. **Happy path después de 3 polls** — mock retorna `[]` en intento 1, throw ENOTFOUND en 2, retorna `["1.2.3.4"]` en 3. `ok: true, attempts: 3`.
3. **Timeout sin propagación** — mock siempre throws ENOTFOUND. `maxWaitMs: 90_000, pollIntervalMs: 30_000` → 3 attempts, `ok: false, error: "domain_nxdomain"`.
4. **Value mismatch** — mock retorna `["9.9.9.9"]`. `expectedRecord.value = "1.2.3.4"` → `ok: false, error: "value_mismatch"`, `lastSeen: "9.9.9.9"`.
5. **NS record happy path** — mock `resolveNs` retorna `["ns-1.awsdns-01.com"]`. Expected `"ns-1.awsdns-01.com"` → `ok: true`.
6. **MX record happy path** — mock `resolveMx` retorna `[{priority:10, exchange:"mail.example.com"}]`. Expected `"mail.example.com"` → `ok: true`.
7. **Invalid domain format** — `domain: "no-tld"` → HTTP 400 `invalid_params`.
8. **maxWaitMs > 600_000** → HTTP 400 `invalid_params`.
9. **pollIntervalMs < 30_000** → HTTP 400 `invalid_params`.
10. **approvalToken inválido** → HTTP 403 `approval_invalid`, NO se ejecuta poll.
11. **Audit event emitido con metadata correcta** — verificar `auditLog.append` recibió `oc.dns.propagation_check` con `attempts`, `lastSeen`, `ok`.

Para tests usar `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` para no esperar real-time 10 min en CI.

---

## Tarea 6 — Integration test en flow E2E (post-tarea 5)

Agregar a `apps/gateway-api/src/routes/onboard-flow.test.ts` o crear `dns-wait.integration.test.ts`:

- Simular flow: `register_domain_route53` → emite NS records esperados → `wait_for_dns_propagation` confirma → `create_webdock_server` arranca.
- Test debe correr en < 5s usando fake timers.

---

## Sign-off requerido

- [ ] Codex confirma SHA final del commit + push a main.
- [ ] `pnpm tsc --noEmit` clean en `apps/gateway-api`.
- [ ] `pnpm vitest run apps/gateway-api/src/routes/dns-wait.test.ts` verde con ≥ 9 tests.
- [ ] `wait_for_dns_propagation` aparece en `GET /v1/skills/dispatcher/registry` (si endpoint existe) o en el array de `buildToolsForOpenClaw` cuando Fase 1 esté wired.
- [ ] Audit event `oc.dns.propagation_check` aparece en `GET /v1/audit-chain` con `prevHash` linked correctamente.
- [ ] Smoke manual: `curl POST /v1/skills/wait-for-dns-propagation` con dominio recién comprado retorna `ok: true` en < 10 min.
- [ ] PM Claude revisa diff antes de merge.

---

## Entregables

1. **Código:**
   - `apps/gateway-api/src/routes/dns-wait.ts` (handler + schema + poll loop)
   - `apps/gateway-api/src/routes/dns-wait.test.ts` (≥ 9 tests)
   - `apps/gateway-api/src/main.ts` (wire ruta)
   - `apps/gateway-api/src/skill-dispatcher.ts` (entry map + alias)
   - `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` (fila nueva)

2. **Tests:** ≥ 9 unit + 1 integration verdes.

3. **Docs:** actualizar `DOCUMENTACION/INDICE_DOCUMENTACION.md` con link a este OPS.

---

## Notas finales del PM

- **NO uses libs externas** como `dns-packet` o `dig-js`. `node:dns/promises` es suficiente.
- **NO hagas la skill async/pending.** Bloquea sincrónica. El operador firma 1 vez y espera hasta 10 min — eso es aceptable porque es el último gate antes de provisionar VPS.
- **Si Bedrock Fase 1 todavía no está wired**, esta skill se puede probar via `curl` directo. NO esperes Fase 1 para entregar este OPS.
- **Respeta el rate-limit de 30s entre polls.** Public DNS resolvers (Google, Cloudflare, Quad9) penalizan ráfagas.
- **Reportar a PM Claude** al terminar implementación + al pasar tests.

— Claude PM
