# OPS Codex Fase 0.5 — Endpoint `/sign` + alinear contratos handlers

**Fecha:** 2026-05-29 viernes ~18:00 COT (despachado tras cierre Fase 0).
**Owner ejecución:** Codex backend senior.
**PM:** Claude.
**Ventana objetivo:** lunes 2026-06-01 8:00-11:00 COT (~3h). Puede arrancarse antes si Codex tiene capacidad.
**Pre-requisito cerrado:** Sprint Fase 0 al 90% (SHA `ca76c8a` + `13d9357` + `cb93e2c` + `91d020b`). Audit chain SHA-256 + auto-rollback + webhook broadcast + ApprovalGate UI + 4 gates fail-closed YA en main.
**Razón del OPS:** desbloquear el ApprovalGate del panel (sticky-bottom Canvas Live) para que pueda firmar propuestas reales y arrancar el smoke E2E con $25 USD.

---

## Resumen ejecutivo

El frontend ya tiene el ApprovalGate v5 (5s timer + botón "Firmar y ejecutar"). El POST a `/v1/openclaw/proposals/{proposalId}/sign` está cableado en el componente y la regex del vite proxy ya lo whitelistea. **Falta el endpoint backend.**

Además, el smoke A3 reveló que los contratos de los 7 handlers operativos (domains/register, dns/upsert ×2, webdock/create, smtp/provision, domains/bind, warmup/seed) no estaban alineados con los `curl` del OPS. Necesitamos una matriz canónica de shapes que el ApprovalGate use al hacer dispatch.

Este OPS cubre **ambas cosas**: (1) endpoint `/sign` + `/reject` que dispatcha la skill internamente, (2) matriz de contratos handler verificada con tests.

---

## Decisión arquitectónica: dispatch interno vs token al frontend

**Aprobado por PM:** el endpoint `/sign` hace dispatch interno. El frontend NO conoce el approvalToken, solo dice "firmo propuesta X". El backend:

1. Busca la propuesta en `proposalsStore` por `proposalId`.
2. Valida pendiente + `requiresApproval` + audit chain ok.
3. Emite `oc.proposal.signed` (audit chain).
4. Emite `oc.artifact.approved` con `metadata.executionId = approvalToken` (compat con `findRecentApproval` de handlers existentes).
5. Dispatcha el handler de la skill internamente con el token + actorId.
6. Espera outcome del handler (timeout 60s).
7. Emite `oc.proposal.executed` con outcome.
8. Retorna `{ ok, status, skill, outcome, handlerResponseSummary }` al panel.

**Por qué dispatch interno:**
- Alinea con norte autonomía 100%: el operador da 1 click, el sistema hace todo.
- Evita exponer `approvalToken` al frontend (menor superficie de ataque).
- Elimina necesidad de que el panel conozca shape de cada handler.
- Sienta la base para Fase 1 (tool calling Bedrock): el mismo dispatcher servirá para que el agente invoque.

**Trade-off aceptado:**
- Timeout 60s puede bloquear el ApprovalGate en handlers lentos (Webdock crear servidor puede tardar 90s). Mitigación: si timeout, emitir `oc.proposal.executing` y panel hace polling. Documentar en evidence.
- Si handler falla, NO se revierte el `oc.artifact.approved`. Eso lo gestiona auto-rollback A2 a nivel infra.

---

## Tarea 1 — Endpoint `POST /v1/openclaw/proposals/{proposalId}/sign`

**Archivo nuevo:** `apps/gateway-api/src/routes/proposals-sign.ts` (export `handleProposalSign`).

**Wire en `main.ts`:** dentro del bloque que ya despacha rutas `/v1/agent/proposals/...`, añadir match para `/v1/openclaw/proposals/{id}/sign`. **NO toques el resto de main.ts si es deuda preexistente.**

### Request

```http
POST /v1/openclaw/proposals/{proposalId}/sign
Content-Type: application/json

{
  "actorId": "operator-juanes",
  "reason": "Aprobado desde Canvas Live tras revisión de propuesta",
  "signatureMetadata": {
    "panelVersion": "v5",
    "viewportFingerprint": "abc123"
  }
}
```

**Campos requeridos:**
- `actorId` (string, 3-64 chars, regex `^[a-z0-9._-]+$`).
- `reason` (string, 10-500 chars).

**Campos opcionales:**
- `signatureMetadata` (object, max 10 keys, valores string ≤ 256 chars).

### Validaciones (orden estricto)

1. **Kill switch global.** Si está armado → `423 Locked` `{ rejectReason: "kill_switch_armed" }`.
2. **Path param.** `proposalId` debe ser UUID v4 válido. Si no → `400` `{ rejectReason: "schema_mismatch" }`.
3. **Body schema.** Si falla → `400` `{ rejectReason: "schema_mismatch", details }`.
4. **Propuesta existe.** Buscar en `proposalsStore` por `id`. Si no → `404` `{ rejectReason: "proposal_not_found" }`.
5. **Propuesta pendiente.** Si `status !== "pending"` → `409` `{ rejectReason: "proposal_not_pending", currentStatus }`.
6. **Propuesta no expirada.** Si `now > expiresAt` → `410 Gone` `{ rejectReason: "proposal_expired" }`. Marcar como `expired` en store.
7. **Propuesta requiere aprobación.** Si `!requiresApproval` → `409` `{ rejectReason: "proposal_does_not_require_approval" }` (caso raro pero defensivo).
8. **Audit chain íntegra.** Antes de firmar, llamar al verifier (A1) en modo light: solo head + last 10 events. Si `ok=false` → `503` `{ rejectReason: "audit_chain_broken", lastValidSeq }`. **Esto es crítico:** firmar sobre cadena rota = firma falsa.
9. **HMAC header opcional.** Si llega `x-openclaw-signature`, validar contra body+timestamp (compat con futuros bots automatizados). Si llega y falla → `401` `{ rejectReason: "signature_invalid" }`. Si NO llega, ok (firma desde panel está bajo CORS strict).

### Lógica (post-validaciones)

```typescript
// 1. Generar approvalToken HMAC
const token = issueApprovalToken({
  actionId: proposal.runbookRef ?? proposal.category,
  targetType: proposal.targetRef.type,
  targetId: proposal.targetRef.id,
  approverId: actorId
});

// 2. Emit oc.proposal.signed (chain link)
const signedEvent = await auditLog.append({
  actorType: "operator",
  actorId,
  action: "oc.proposal.signed",
  targetType: "proposal",
  targetId: proposal.id,
  riskLevel: riskLevelFromProposalSeverity(proposal.severity),
  decision: "approve",
  humanApproved: true,
  signatureId: token.tokenId,
  metadata: {
    reason,
    skillSlug: proposal.skillSlug,
    proposalHash: proposal.proposalHash,
    runbookRef: proposal.runbookRef,
    panelVersion: signatureMetadata?.panelVersion,
    chainPrevHash: await auditChain.lastHash()
  }
});

// 3. Emit oc.artifact.approved (compat con findRecentApproval de handlers)
await auditLog.append({
  actorType: "operator",
  actorId,
  action: "oc.artifact.approved",
  targetType: proposal.targetRef.type,
  targetId: proposal.targetRef.id,
  riskLevel: riskLevelFromProposalSeverity(proposal.severity),
  decision: "approve",
  humanApproved: true,
  metadata: {
    executionId: token.tokenId,  // ← clave para findRecentApproval
    proposalId: proposal.id,
    skillSlug: proposal.skillSlug
  }
});

// 4. Update canvas state (compat con findRecentApproval que lee artifacts)
await canvasState.upsertArtifact({
  ...proposal.artifactSnapshot,
  approvalStatus: "approved",
  approvedAt: now.toISOString(),
  executionId: token.tokenId
});

// 5. Update proposalsStore
proposal.status = "signed";
proposal.signedAt = now.toISOString();
proposal.signatureId = token.tokenId;

// 6. Dispatch handler internamente
const dispatchResult = await dispatchSkillHandler({
  skill: proposal.skillSlug,
  params: proposal.params,
  actorId,
  approvalToken: token,
  timeoutMs: 60_000
});

// 7. Emit oc.proposal.executed con outcome
await auditLog.append({
  actorType: "operator",
  actorId,
  action: "oc.proposal.executed",
  targetType: "proposal",
  targetId: proposal.id,
  riskLevel: riskLevelFromProposalSeverity(proposal.severity),
  decision: dispatchResult.ok ? "approve" : "reject",
  humanApproved: true,
  metadata: {
    outcome: dispatchResult.ok ? "success" : "failure",
    handlerStatusCode: dispatchResult.statusCode,
    handlerResponseSummary: redactSecrets(dispatchResult.summary),
    durationMs: dispatchResult.durationMs,
    skillSlug: proposal.skillSlug,
    chainPrevHash: signedEvent.hash
  }
});

// 8. Webhook broadcast (NO bloquea)
await webhookBroadcaster.send({
  event: "proposal.executed",
  proposal: { id: proposal.id, skill: proposal.skillSlug },
  outcome: dispatchResult.ok ? "success" : "failure",
  actor: actorId,
  signatureId: token.tokenId
});

// 9. Return
return json(response, dispatchResult.ok ? 200 : 502, {
  ok: dispatchResult.ok,
  status: dispatchResult.ok ? "executed" : "execution_failed",
  proposalId: proposal.id,
  signatureId: token.tokenId,
  skill: proposal.skillSlug,
  outcome: dispatchResult.summary,
  webhookBroadcast: webhookBroadcaster.lastDeliveryStatus()
});
```

### Casos especiales

**Handler timeout (>60s):**
- NO retornar 504. En su lugar:
  - Emit `oc.proposal.executing` (estado intermedio).
  - Mantener proposal status como `executing` en store.
  - Return `202 Accepted` `{ status: "executing", proposalId, pollEndpoint: "/v1/openclaw/proposals/{id}/status" }`.
- Frontend ApprovalGate detectará 202 y mostrará "Ejecutando…" con polling cada 3s.

**Handler kill-switch armado durante ejecución:**
- El handler abortará con `423`.
- Capturar y emit `oc.proposal.aborted` con razón `kill_switch_armed_mid_execution`.
- Auto-rollback (A2) ya está armado para los handlers que lo soportan.

---

## Tarea 2 — Endpoint `POST /v1/openclaw/proposals/{proposalId}/reject`

**Archivo nuevo:** `apps/gateway-api/src/routes/proposals-reject.ts` (export `handleProposalReject`).

### Request

```http
POST /v1/openclaw/proposals/{proposalId}/reject
Content-Type: application/json

{
  "actorId": "operator-juanes",
  "reason": "Propuesta usa registrar no canónico (Cloudflare). Re-evaluar con AWS Route53."
}
```

### Validaciones

1. Kill switch armed → `423`.
2. `proposalId` UUID válido → si no `400`.
3. Body schema → si no `400`.
4. Proposal exists → si no `404`.
5. Proposal pendiente → si no `409`.
6. Audit chain ok → si no `503`.

### Lógica

```typescript
// 1. Emit oc.proposal.rejected
await auditLog.append({
  actorType: "operator",
  actorId,
  action: "oc.proposal.rejected",
  targetType: "proposal",
  targetId: proposal.id,
  riskLevel: riskLevelFromProposalSeverity(proposal.severity),
  decision: "reject",
  humanApproved: false,
  metadata: {
    reason,
    skillSlug: proposal.skillSlug,
    chainPrevHash: await auditChain.lastHash()
  }
});

// 2. Update store
proposal.status = "rejected";
proposal.rejectedAt = now.toISOString();
proposal.rejectionReason = reason;

// 3. Update canvas state
await canvasState.upsertArtifact({
  ...proposal.artifactSnapshot,
  approvalStatus: "rejected",
  rejectedAt: now.toISOString(),
  rejectionReason: reason
});

// 4. Webhook broadcast
await webhookBroadcaster.send({
  event: "proposal.rejected",
  proposal: { id: proposal.id, skill: proposal.skillSlug },
  reason,
  actor: actorId
});

// 5. Return
return json(response, 200, {
  ok: true,
  status: "rejected",
  proposalId: proposal.id,
  rejectedAt: proposal.rejectedAt
});
```

---

## Tarea 3 — Dispatcher de skills

**Archivo nuevo:** `apps/gateway-api/src/skill-dispatcher.ts` (export `dispatchSkillHandler`).

Mapa canónico de `skillSlug` → handler interno. NO usa HTTP, llama directamente a la función handler con un mock `IncomingMessage`/`ServerResponse` adapter.

```typescript
const SKILL_HANDLER_MAP: Record<string, SkillHandlerEntry> = {
  "register_domain_route53": {
    handler: handleRoute53DomainRegisterHttp,
    paramSchema: route53RegisterParamSchema,
    timeoutMs: 60_000,
    canRollback: true
  },
  "upsert_dns_route53": {
    handler: handleRoute53DnsUpsertHttp,
    paramSchema: route53UpsertParamSchema,
    timeoutMs: 30_000,
    canRollback: true
  },
  "upsert_dns_ionos": {
    handler: handleIonosDnsUpsertHttp,
    paramSchema: ionosUpsertParamSchema,
    timeoutMs: 30_000,
    canRollback: true
  },
  "create_webdock_server": {
    handler: handleWebdockServerCreateHttp,
    paramSchema: webdockCreateParamSchema,
    timeoutMs: 120_000,
    canRollback: false  // crear server NO revierte automáticamente; usa kill switch + delete manual
  },
  "provision_smtp_postfix": {
    handler: handleSmtpProvisioningHttp,
    paramSchema: smtpProvisionParamSchema,
    timeoutMs: 90_000,
    canRollback: true  // restore via snapshot pre-mutation
  },
  "configure_email_auth": {
    handler: handleDomainsEmailAuthHttp,
    paramSchema: emailAuthParamSchema,
    timeoutMs: 30_000,
    canRollback: true
  },
  "bind_domain_to_server": {
    handler: handleDomainsBindHttp,
    paramSchema: bindDomainParamSchema,
    timeoutMs: 15_000,
    canRollback: true
  },
  "seed_warmup_pool": {
    handler: handleWarmupHttp,
    paramSchema: warmupSeedParamSchema,
    timeoutMs: 30_000,
    canRollback: false  // seeds no se deshacen, se pausan via SenderPool
  }
};
```

**Función `dispatchSkillHandler`:**

```typescript
export async function dispatchSkillHandler(input: {
  skill: string;
  params: unknown;
  actorId: string;
  approvalToken: ApprovalToken;
  timeoutMs?: number;
}): Promise<DispatchResult> {
  const entry = SKILL_HANDLER_MAP[input.skill];
  if (!entry) {
    return {
      ok: false,
      statusCode: 404,
      summary: { error: "unknown_skill", skill: input.skill },
      durationMs: 0
    };
  }

  // 1. Validar params contra schema
  const paramsValidation = entry.paramSchema.safeParse(input.params);
  if (!paramsValidation.success) {
    return {
      ok: false,
      statusCode: 400,
      summary: { error: "params_validation_failed", details: paramsValidation.error.format() },
      durationMs: 0
    };
  }

  // 2. Build inyectable body (handler espera approvalToken + actorId + params skill)
  const body = {
    ...paramsValidation.data,
    actorId: input.actorId,
    approvalToken: input.approvalToken.tokenId  // handlers leen tokenId, no signature
  };

  // 3. Build mock IncomingMessage/ServerResponse adapter
  const start = Date.now();
  const { request, response, getResponse } = createInternalHttpAdapter(body);

  // 4. Invoke handler con timeout
  const timeoutMs = input.timeoutMs ?? entry.timeoutMs;
  try {
    await withTimeout(
      entry.handler({ request, response, ...sharedDeps }),
      timeoutMs
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        ok: false,
        statusCode: 504,
        summary: { error: "handler_timeout", timeoutMs },
        durationMs: Date.now() - start
      };
    }
    throw err;
  }

  // 5. Read response
  const captured = getResponse();
  const durationMs = Date.now() - start;

  return {
    ok: captured.statusCode >= 200 && captured.statusCode < 300,
    statusCode: captured.statusCode,
    summary: captured.body,
    durationMs
  };
}
```

**Adapter interno (`createInternalHttpAdapter`):** monta un `IncomingMessage`/`ServerResponse` de mentira con streams in-memory para que los handlers existentes funcionen sin HTTP real. Esto es **clave**: NO toques los handlers, solo los invocas.

---

## Tarea 4 — Schemas zod por skill

**Archivo nuevo:** `apps/gateway-api/src/skill-schemas.ts`.

Para cada uno de los 8 skills del map, definir un schema zod canónico **leyendo el código del handler existente** (NO inventar). Ejemplo:

```typescript
import { z } from "zod";

export const route53RegisterParamSchema = z.object({
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i),
  years: z.number().int().min(1).max(10),
  autoRenew: z.boolean().default(false)
});

export const route53UpsertParamSchema = z.object({
  zoneName: z.string(),
  records: z.array(z.object({
    name: z.string(),
    type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]),
    ttl: z.number().int().min(60).max(86400),
    values: z.array(z.string()).min(1)
  })).min(1).max(50)
});

// ... etc para los 8 skills
```

**Importante:** lee cada handler existente y extrae los campos requeridos. NO copiar de memoria. Si encuentras divergencia entre lo que el handler espera y lo que el OPS A3 mandaba, **alinea al handler** y deja una nota en el commit message.

---

## Tarea 5 — Tests

**Archivo nuevo:** `apps/gateway-api/src/routes/proposals-sign.test.ts`.

Cubrir mínimo 20 casos:

1. ✅ Happy path: sign → dispatcher mock returns ok → 200 con outcome.
2. ✅ Kill switch armed → 423.
3. ✅ proposalId no UUID → 400.
4. ✅ proposalId no existe → 404.
5. ✅ Propuesta status=rejected → 409.
6. ✅ Propuesta expirada → 410.
7. ✅ Propuesta !requiresApproval → 409.
8. ✅ Audit chain broken → 503.
9. ✅ HMAC inválido (si presente) → 401.
10. ✅ Body schema fail → 400.
11. ✅ actorId regex fail → 400.
12. ✅ reason < 10 chars → 400.
13. ✅ reason > 500 chars → 400.
14. ✅ Dispatcher returns timeout → 202 con pollEndpoint.
15. ✅ Dispatcher returns 502 (handler falla) → 502 con summary.
16. ✅ Webhook broadcast falla → no bloquea (return 200, lastDeliveryStatus.error registrado).
17. ✅ Replay: firmar misma proposal 2 veces → segunda da 409 (status=signed).
18. ✅ Audit chain prevHash matches → eventos linked.
19. ✅ Canvas state actualizado correctamente (artifact.approvalStatus="approved").
20. ✅ Secrets en handler response redactados en metadata.

**Archivo nuevo:** `apps/gateway-api/src/routes/proposals-reject.test.ts` (10 tests análogos).

**Archivo nuevo:** `apps/gateway-api/src/skill-dispatcher.test.ts` (12 tests con handlers mock).

---

## Tarea 6 — Wire en `main.ts`

Localizar el bloque que despacha rutas `/v1/agent/proposals/`. Añadir SIN modificar:

```typescript
// Sign endpoint (cambio norte 2026-05-29: 1 firma operador)
if (request.method === "POST") {
  const signMatch = requestUrl(request).pathname.match(
    /^\/v1\/openclaw\/proposals\/([^/]+)\/sign$/
  );
  if (signMatch) {
    return handleProposalSign({
      request,
      response,
      proposalId: signMatch[1],
      auditLog,
      auditChain,
      proposalsStore: getProposalsStoreRef(),
      canvasState,
      webhookBroadcaster,
      dispatcher: skillDispatcher,
      env: process.env,
      now: () => new Date()
    });
  }

  const rejectMatch = requestUrl(request).pathname.match(
    /^\/v1\/openclaw\/proposals\/([^/]+)\/reject$/
  );
  if (rejectMatch) {
    return handleProposalReject({
      request,
      response,
      proposalId: rejectMatch[1],
      auditLog,
      auditChain,
      proposalsStore: getProposalsStoreRef(),
      canvasState,
      webhookBroadcaster,
      env: process.env,
      now: () => new Date()
    });
  }
}
```

**NO duplicar `getProposalsStoreRef`** — si no existe, exportarlo del bloque de submit que ya lo usa.

---

## Tarea 7 — Smoke E2E con $25 USD (post-merge)

Una vez todo lo anterior cierre (tests verdes, tsc clean, push):

```bash
export GATEWAY_BASE=http://127.0.0.1:3000
export ACTOR_ID=operator-juanes
export DOMAIN_TEST=delivrix-smoke-2026-06-01.com   # cambiar a algo único

# Step 1: Health
curl -s "$GATEWAY_BASE/health" | jq

# Step 2: Audit chain íntegra ANTES
curl -s "$GATEWAY_BASE/v1/audit-chain/verify" | jq

# Step 3: OpenClaw propone (vía chat o directo)
PROPOSAL_ID=$(curl -s -X POST "$GATEWAY_BASE/v1/agent/proposals/submit" \
  -H "x-openclaw-signature: ..." \
  -d '{"proposal":{"skillSlug":"register_domain_route53","params":{"domain":"'$DOMAIN_TEST'","years":1,"autoRenew":false},"category":"supervised_local_state","severity":"high","runbookRef":"register_domain","targetRef":{"type":"domain","id":"'$DOMAIN_TEST'"}}}' \
  | jq -r .proposalId)

echo "Proposal: $PROPOSAL_ID"

# Step 4: Firmar
RESULT=$(curl -s -X POST "$GATEWAY_BASE/v1/openclaw/proposals/$PROPOSAL_ID/sign" \
  -d '{"actorId":"'$ACTOR_ID'","reason":"Smoke E2E Fase 0.5 — registrar dominio descartable"}')

echo "Sign result:"; echo "$RESULT" | jq

# Step 5: Audit chain íntegra DESPUÉS
curl -s "$GATEWAY_BASE/v1/audit-chain/verify" | jq

# Step 6: Anchor HMAC post-smoke (guardar firma en lugar seguro)
curl -s "$GATEWAY_BASE/v1/audit-chain/anchor" | jq > runtime/audit-anchor-post-smoke.json
```

**HARD STOP si:**
- Costo acumulado > $25 USD (chequear `monthSpendUsd` en respuesta del handler).
- `audit-chain/verify` devuelve `ok:false` en cualquier punto.
- Cualquier handler retorna 5xx sin auto-rollback exitoso.

**NO destruir el dominio comprado** — queda en pool de smoke testing. Documentar en `runtime/smoke-domains.jsonl`.

---

## Tarea 8 — Limpieza worktree (pre-flight)

Antes de arrancar, Codex debe:

1. `git status` para ver el árbol sucio (frontend/docs ajenos al sprint).
2. Si hay cambios sin commit que NO son de Fase 0.5, hacer `git stash` con mensaje descriptivo.
3. Confirmar que está en branch `main` actualizado (`git fetch origin main && git rebase origin/main`).
4. Si hay conflictos, parar y reportar a PM.

---

## Sign-off requerido

- [ ] Codex confirma SHA final + tests verdes (mínimo 42 nuevos).
- [ ] `tsc --noEmit` clean en gateway-api + admin-panel.
- [ ] `curl /v1/openclaw/proposals/{id}/sign` con propuesta dummy responde 200/202 ok.
- [ ] Audit chain verify post-merge: `ok:true`.
- [ ] Anchor HMAC capturado y guardado.
- [ ] PM (Claude) revisa diff antes de smoke real con $25.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `createInternalHttpAdapter` mock no replica edge cases reales | Tests cubren errores comunes (timeout, throw, response not closed). Si en smoke E2E aparece nuevo edge case, OPS Fase 0.6. |
| Schema zod por skill diverge del handler real | Cada schema se valida leyendo el handler. Si divergencia, alinear al handler (no al OPS A3). |
| Webhook broadcast bloqueante en handler lento | Webhook es fire-and-forget (Promise.race con 5s timeout). No espera ACK del receptor. |
| Replay attack: firmar 2x → 2x cobros | El step 5 (proposal.status=signed) + audit chain hacen replay imposible. Tests cubren caso 17. |
| Audit chain rota durante dispatch | Si chain falla entre paso 2 y paso 7, queda en estado inconsistente. Mitigación: paso 8 valida chain y emite `oc.audit.chain_inconsistent` si falla. |

---

## Entregables

1. **Código:**
   - `apps/gateway-api/src/routes/proposals-sign.ts`
   - `apps/gateway-api/src/routes/proposals-reject.ts`
   - `apps/gateway-api/src/skill-dispatcher.ts`
   - `apps/gateway-api/src/skill-schemas.ts`
   - `apps/gateway-api/src/internal-http-adapter.ts` (helper para mock)
   - Wire en `main.ts` (mínimo diff).

2. **Tests:** mínimo 42 nuevos verdes.

3. **Docs:**
   - `DOCUMENTACION/FASE_0_5_RESULT_2026_06_01.md` con SHA, tests, smoke outcome.
   - Actualizar `OPENCLAW_PERMISSIONS_MATRIX.md` si algún skill cambia su categoría tras tests.

4. **Smoke E2E:** evidencia en `runtime/smoke-fase-0-5-{timestamp}.jsonl` + anchor firmado.

---

## Notas finales del PM

- **NO toques `main.ts` si es deuda preexistente.** El wire de las 2 rutas nuevas debe ser mínimo.
- **NO crear cuenta de servicios externos.** El smoke usa AWS Route53 con la cuenta `delivrix-ops` ya configurada.
- **Audit log append-only inviolable.** Si necesitas backfill, hablar con PM antes.
- **Kill switch sigue siendo el último gate.** No bypaseable.
- **Reportar a las 9:30 COT** con SHA tarea 1+2+3 (sin smoke). Smoke se hace tras review PM.
- Si descubres bug en Fase 0 (audit-chain, auto-rollback, etc.) durante Fase 0.5, NO lo arregles inline. Crear `OPS_CODEX_FASE_0_HOTFIX_xxx.md` para que lo veamos juntos primero.

— Claude PM
