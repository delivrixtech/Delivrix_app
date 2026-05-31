# OPS Codex — Skill orquestadora `configure_complete_smtp`

**Fecha:** 2026-05-31 domingo MODO URGENT.
**Severidad:** P0 — núcleo del cierre autónomo E2E hoy.
**Owner:** Codex backend senior.
**PM:** Claude (supervisor).
**Pre-requisitos:** Fase 1 tool calling + 4 skills nuevas en main.

---

## Motivación

Juanes 2026-05-31: *"compre el dominio, esperar a la confirmacion o propagacion de los dns, luego adquirir el vps, relacionando el nombre que se compro a la configuracion del vps, luego configurar el smtp incluso configurando su main 'Main domain' en webdock, para que se encargue de configurar el dominio + el smtp = que envio los emails con un mensaje no de prueba, si no un mensaje real."*

Esa cadena de 14 pasos hoy se ejecuta manualmente vía bash + ApprovalGate. **Esta skill encapsula TODO el flow en una sola entrada de chat OpenClaw.**

## Skill nueva: `configure_complete_smtp`

**Categoría matrix:** `supervised_local_state` (master) — gatilla 7-9 sub-skills `supervised_local_state` que cada una requiere 1 firma operador.

**Archivo nuevo:** `apps/gateway-api/src/routes/orchestrator-smtp.ts`.

### Input

```typescript
{
  brand: string;                  // ej "delivrix"
  intent?: string;                // ej "ops", "reporting", "filing" — afecta naming suggester
  budgetUsdMax: number;           // default 25 (dominio + 1 mes VPS + holguro)
  testEmailRecipient: string;     // gmail del operator donde llega el envío real final
  testEmailSubject: string;       // operador escribe subject real (no test)
  testEmailBody: string;          // operador escribe body real (no test)
  actorId: string;
}
```

### Output (acumulado durante el run)

```typescript
{
  runId: string;
  status: "completed" | "executing" | "failed" | "rolled_back";
  stepResults: Array<{
    step: number;
    skill: string;
    proposalId: string;
    signatureId?: string;
    outcome: any;
    durationMs: number;
  }>;
  totalDurationMs: number;
  totalCostUsd: number;            // suma costos reales: dominio + VPS prorrateado + etc
  finalEmailMessageId?: string;
  finalDeliveryStatus?: "queued" | "delivered" | "deferred" | "bounced";
}
```

### Flow orquestador (14 pasos)

**El handler NO firma por sí mismo.** Cada step genera 1 propuesta `oc.proposal.submitted`, espera firma operador via ApprovalGate (timeout 10min default), y procede al siguiente.

```typescript
// Pseudo-codigo del orquestador
async function configureCompleteSmtp(input, deps) {
  const runId = randomUUID();
  const steps = [];

  // STEP 1: Suggest safe domain (read-only, no firma)
  const suggestions = await invokeSkill('suggest_safe_domain', {
    brand: input.brand, intent: input.intent, count: 5
  });
  // Operator picks 1 via chat: invocar pregunta UI o usar el #1 ranked
  const chosenDomain = suggestions.candidates[0].domain;
  steps.push({ step: 1, skill: 'suggest_safe_domain', outcome: suggestions });

  // STEP 2: register_domain_route53 (1 firma)
  const reg = await submitAndAwaitSign('register_domain_route53', {
    domain: chosenDomain, years: 1, autoRenew: false
  });
  steps.push({ step: 2, skill: 'register_domain_route53', ...reg });

  // STEP 3: wait_for_dns_propagation NS records (1 firma)
  const dnsPropNs = await submitAndAwaitSign('wait_for_dns_propagation', {
    domain: chosenDomain,
    expectedRecord: { type: 'NS', value: '*.awsdns-*' },
    maxWaitMs: 1800000  // 30 min para registration AWS
  });
  steps.push({ step: 3, skill: 'wait_for_dns_propagation', ...dnsPropNs });

  // STEP 4: create_webdock_server (1 firma)
  // CRITICAL: hostname = dominio directo, NO "mail."<dominio>
  const vps = await submitAndAwaitSign('create_webdock_server', {
    profile: 'bit',
    locationId: 'dk',
    hostname: chosenDomain,    // limpio, sin mail prefix
    imageSlug: 'ubuntu-2404'
  });
  steps.push({ step: 4, skill: 'create_webdock_server', ...vps });
  const serverSlug = vps.outcome.slug;
  const serverIpv4 = vps.outcome.ipv4;

  // STEP 5: wait_server_running (no firma, polling Webdock)
  await waitForServerRunning(serverSlug, 600000);  // 10 min cap

  // STEP 6: bind_webdock_main_domain (1 firma) — set domain + PTR
  const bind = await submitAndAwaitSign('bind_webdock_main_domain', {
    serverSlug, domain: chosenDomain
  });
  steps.push({ step: 6, skill: 'bind_webdock_main_domain', ...bind });

  // STEP 7: route53_dns_upsert A record (1 firma)
  const dnsA = await submitAndAwaitSign('route53_dns_upsert', {
    zoneName: chosenDomain,
    records: [
      { name: chosenDomain, type: 'A', ttl: 300, values: [serverIpv4] },
      { name: chosenDomain, type: 'MX', ttl: 300, values: [`10 ${chosenDomain}.`] }
    ]
  });
  steps.push({ step: 7, skill: 'route53_dns_upsert', ...dnsA });

  // STEP 8: wait_for_dns_propagation A record (no firma)
  await invokeSkill('wait_for_dns_propagation', {
    domain: chosenDomain,
    expectedRecord: { type: 'A', value: serverIpv4 },
    maxWaitMs: 600000
  });

  // STEP 9: provision_smtp_postfix (1 firma)
  const smtp = await submitAndAwaitSign('provision_smtp_postfix', {
    serverSlug, domain: chosenDomain
  });
  steps.push({ step: 9, skill: 'provision_smtp_postfix', ...smtp });
  const dkimPublicKey = smtp.outcome.dkimPublicKey;  // generado por OpenDKIM en VPS

  // STEP 10: configure_email_auth (1 firma) — SPF + DKIM + DMARC
  const auth = await submitAndAwaitSign('configure_email_auth', {
    zoneName: chosenDomain,
    spfPolicy: `v=spf1 ip4:${serverIpv4} ~all`,
    dkimSelector: 's2026a',
    dkimPublicKey,
    dmarcPolicy: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${chosenDomain}`
  });
  steps.push({ step: 10, skill: 'configure_email_auth', ...auth });

  // STEP 11: wait DKIM/SPF TXT propagation (no firma)
  await invokeSkill('wait_for_dns_propagation', {
    domain: `s2026a._domainkey.${chosenDomain}`,
    expectedRecord: { type: 'TXT', value: 'v=DKIM1' },
    maxWaitMs: 600000
  });

  // STEP 12: seed_warmup_pool MÍNIMO (1 firma)
  const seed = await submitAndAwaitSign('seed_warmup_pool', {
    domain: chosenDomain,
    seedCount: 3,    // mínimo viable: 3 emails seed (gmail/outlook del operator) que abren + responden
    warmupDays: 1    // smoke: 1 día solo
  });
  steps.push({ step: 12, skill: 'seed_warmup_pool', ...seed });

  // STEP 13: wait_warmup_initial (no firma, polling cuenta de envíos exitosos)
  await waitForWarmupCount(chosenDomain, 5, 3600000);  // 5 entregas en 1h

  // STEP 14: send_real_email (1 firma CRITICAL) — primer envío real
  const realEmail = await submitAndAwaitSign('send_real_email', {
    fromAddress: `hello@${chosenDomain}`,
    toAddress: input.testEmailRecipient,
    subject: input.testEmailSubject,
    body: input.testEmailBody,
    serverSlug
  });
  steps.push({ step: 14, skill: 'send_real_email', ...realEmail });

  return {
    runId,
    status: 'completed',
    stepResults: steps,
    totalCostUsd: 15 + (4.30 / 30 * daysSinceCreate),
    finalEmailMessageId: realEmail.outcome.messageId,
    finalDeliveryStatus: realEmail.outcome.deliveryStatus
  };
}
```

### Manejo de errores

- **Cada step que falla → handler emite `oc.orchestrator.step_failed`** con metadata del step + razón.
- **Auto-rollback condicional:**
  - Si step 2 (dominio) registra OK y step 4+ falla → dominio queda registrado (no se puede borrar < 60d AWS policy).
  - Si step 4 (VPS) creado y step 6+ falla → handler emite propuesta `delete_webdock_server` para que operador firme rollback.
  - Si step 9 (Postfix) falla a medias → operador puede firmar re-run de provision_smtp_postfix idempotente.
- **Cualquier paso rejected por operador en ApprovalGate → handler marca run como `cancelled_by_operator`**, NO auto-rollback (el operador decidió).

### Visibilidad en Canvas Live

Emite eventos `oc.orchestrator.step_started`, `oc.orchestrator.step_completed`, `oc.orchestrator.step_failed`. Canvas Live frontend renderiza progress bar 14 steps + estado actual + total cost acumulado + ETA estimado.

### Tests

`apps/gateway-api/src/routes/orchestrator-smtp.test.ts` — 25+ tests:

- Happy path completo con todos los handlers mocked OK
- Fallo en step 2 → no procede a 3+
- Fallo en step 6 → emite propuesta rollback step 4
- Operator rechaza step 8 → cancelled_by_operator
- Timeout en propagation step 3 → step_failed con razón
- Cada step verifica integridad audit chain antes de proceder

### Wire en main.ts

```typescript
if (request.method === "POST" && requestUrl(request).pathname === "/v1/openclaw/orchestrator/configure-smtp") {
  return handleConfigureCompleteSmtp({ request, response, ...sharedDeps });
}
```

### Exposición como tool de OpenClaw

En `openclaw-tools-builder.ts`, agregar tool:

```typescript
{
  name: "configure_complete_smtp",
  description: "Configura un SMTP completo nuevo desde cero: registra dominio limpio, crea VPS Webdock, instala Postfix+OpenDKIM, configura DNS+SPF+DKIM+DMARC, hace warmup mínimo y envía 1 email real. Requiere 7-9 firmas operador via ApprovalGate. Tiempo total: 1-3 horas. Costo: $15 dominio + $4.30/mes VPS.",
  input_schema: { /* del Input arriba */ }
}
```

## Sign-off requerido

- [ ] Tests verdes >= 25.
- [ ] `tsc --noEmit` clean.
- [ ] Smoke E2E real cierra los 14 pasos con dominio nuevo + envío real a Gmail del operator.
- [ ] Audit chain íntegra al final (`verify ok=true`).
- [ ] Anchor HMAC capturado pre + post.
- [ ] PM Claude revisa diff antes de merge.
- [ ] Doc post-mortem `DOCUMENTACION/SMOKE_E2E_AUTONOMO_RESULT_2026_05_31.md` con SHA + métricas.

---

— Claude PM
