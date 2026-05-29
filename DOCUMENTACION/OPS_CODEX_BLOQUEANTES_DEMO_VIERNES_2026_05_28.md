# OPS Codex — Bloqueantes demo viernes Final.0 (URGENTE)

**Para:** Codex.
**De:** Claude (QA + PM).
**Fecha:** 2026-05-28 jueves, tarde.
**Prioridad:** **CRÍTICA** — sin estos 2 fixes el demo del viernes con el jefe del CTO **NO funciona**.
**Tiempo estimado:** **~1h 30min total**.

## Contexto

Juanes hizo una llamada decisiva: el viernes el jefe quiere ver **el flujo entero en tiempo real**: comprar dominio + configurar DNS + DKIM + servidor + Webdock + conectar dominio + start de calentamiento de bandeja + **calentamiento del inbox**.

Hice una auditoría profunda de los 7 gates cruzando código + executions + .env.local. Reporte completo en `REPORTE_READINESS_DEMO_VIERNES_2026_05_28.md`.

**Resultado:** 2 bloqueantes activos. Este OPS los cubre con specs precisas.

---

## B-DEMO-01 — Warmup seed NO está armado para correr (30 min)

### Problema

`apps/gateway-api/src/routes/warmup.ts` línea 130 chequea 5 blockers para `POST /v1/warmup/seed`:

```typescript
if (env.WARMUP_ENABLE_SEND !== "true") blockers.push("warmup_send_flag_disabled");
if (!deps.sshRunner.isConfigured()) blockers.push("warmup_ssh_runner_missing");
if (!approval) blockers.push("approval_not_found_or_expired");
if (!serverIp) blockers.push("server_ip_missing");
if (seedInboxes.length !== 3) blockers.push("seed_inboxes_must_be_exactly_3");
```

Hoy NO existe en `.env.local`:
- `WARMUP_ENABLE_SEND`

Y nunca se ejecutó `start_warmup_seed` en el workspace (`find runtime/openclaw-workspace/executions -name "*warmup*"` → 0 resultados).

### Tareas

#### Tarea 1.1 — Confirmar el sshRunner del warmup (5 min)

Leer `apps/gateway-api/src/main.ts` y verificar cómo se inyecta `deps.sshRunner` en el handler de `warmup.ts`. Si reusa el mismo runner que `install_smtp_stack` (probable porque ambos usan SSH al VPS), no hay trabajo aquí. Si es runner separado, agregar wiring.

#### Tarea 1.2 — Definir contrato de seed inboxes (10 min)

El handler hoy lee `body.seedInboxes` desde el request body. Para el demo necesitamos defaults estables. Decisión:

- **Opción A (recomendada):** agregar env var `WARMUP_DEFAULT_SEED_INBOXES` que sea CSV de 3 direcciones. El handler usa esos si `body.seedInboxes` no viene o viene incompleto. Simple, seguro.

- **Opción B:** dejar como está y que el panel siempre los mande. Más trabajo frontend.

**Implementar Opción A.** En `warmup.ts`:

```typescript
function resolveSeedInboxes(body: WarmupSeedBody, env: ProcessEnv): string[] {
  const fromBody = parseSeedInboxes(body.seedInboxes);
  if (fromBody.length === 3) return fromBody;
  const fromEnv = (env.WARMUP_DEFAULT_SEED_INBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (fromEnv.length === 3) return fromEnv;
  return fromBody;
}
```

#### Tarea 1.3 — Documentar las nuevas env vars en .env.local.example (2 min)

Agregar:

```bash
# Warmup del inbox — gate del Acto 3 demo
WARMUP_ENABLE_SEND=true
WARMUP_DEFAULT_SEED_INBOXES=seed-1@xxxxx.mailtrap.io,seed-2@xxxxx.mailtrap.io,seed-3@xxxxx.mailtrap.io
```

Juanes va a poblarlos con sus credenciales reales de Mailtrap.

#### Tarea 1.4 — Smoke E2E warmup contra server69 reactivado (15 min)

```bash
# 0. Provisionar un VPS Webdock temporal o reusar uno existente
# 1. Mailtrap free tier: crear sandbox + tomar 3 direcciones
# 2. Set .env.local con las 3 direcciones
# 3. Curl al endpoint:

curl -X POST http://localhost:3000/v1/warmup/seed \
  -H "content-type: application/json" \
  -d '{
    "domain": "delivrix-warmup-smoke.click",
    "serverSlug": "<slug del server>",
    "actorId": "codex-smoke",
    "approvalToken": "<token válido del audit chain>"
  }'

# 4. Verificar:
#    - Status 200 con execution writeup
#    - 3 emails llegan al inbox Mailtrap
#    - oc.warmup.seed_sent emitido en audit chain
#    - Workspace executions/2026-05-28/HHMMSS-start_warmup_seed-*-success.md creado
```

**Aceptación:** los 3 emails aparecen en Mailtrap con remitente del dominio del demo.

---

## B-DEMO-02 — SMTP install flaky (3 retries antes de éxito) (45 min)

### Problema

El run del 28-may madrugada tardó 4 intentos en instalar SMTP:

```
010522 install_smtp_stack · FAILED   "SSH command timed out"        50s
010617 install_smtp_stack · FAILED   "SSH command timed out"        145s
010924 install_smtp_stack · FAILED   "SSH command failed with exit 1"  144s
011308 install_smtp_stack · SUCCESS  (48s)
```

Total tiempo perdido: ~5 min. En el demo del viernes frente al jefe del CTO esto es catastrófico.

**Causa raíz probable:** el primer comando del script es `wait-cloud-init`. El VPS Webdock recién creado todavía no terminó cloud-init cuando OpenClaw intentó SSH. Los 2 primeros timeouts SSH (no exit code) confirman conexión rechazada o stalled.

### Tareas

#### Tarea 2.1 — Subir WEBDOCK_SSH_ACCESS_SETTLE_MS al doble (2 min)

Hoy en `.env.local`:
```
WEBDOCK_SSH_ACCESS_SETTLE_MS=<valor actual>
```

Subirlo (o documentar en `.env.local.example`) a:
```
WEBDOCK_SSH_ACCESS_SETTLE_MS=120000   # 2 minutos
```

Esto agrega tiempo de gracia para que cloud-init termine antes del primer SSH attempt.

#### Tarea 2.2 — Retry transparente dentro del adapter SMTP (30 min)

En `packages/adapters/src/` (el adapter que ejecuta `install_smtp_stack`):

- Envolver el primer SSH connect en un retry con backoff:
  - Intento 1: directo
  - Si timeout o exit 255 → wait 30s → intento 2
  - Si timeout o exit 255 → wait 60s → intento 3
  - Si sigue fallando → fail real con detalle de los 3 intentos

- **CRÍTICO:** que el operador NO vea los retries en el Canvas Live. Emitir un solo `oc.action.now` con sub-status "esperando cloud-init... intento 2 de 3" en `progressDetail`, pero la task externa sigue siendo una sola.

- Telemetría: agregar al success payload `cloudInitSettleSeconds: number` y `sshConnectAttempts: number`.

#### Tarea 2.3 — Smoke E2E install_smtp con un VPS recién creado (10 min)

```bash
# 1. Crear un VPS Webdock nuevo (sí, real, $X que va al cap)
# 2. Inmediatamente correr install_smtp_stack contra ese VPS (sin wait manual)
# 3. Esperar resultado
```

**Aceptación:** completa al primer intento sin retry visible al operador. Si tuvo que reintentar internamente, queda en `evidence.sshConnectAttempts` para auditoría.

#### Tarea 2.4 — Documentar en runbooks (3 min)

Actualizar `DOCUMENTACION/runbooks/register-sender-node-local-runbook.md` (o equivalente) mencionando que el adapter ahora retry internamente y cuándo el operador debe preocuparse (si vey `sshConnectAttempts > 2`).

---

## Lo que NO toques

- No tocar el frontend (`apps/admin-panel/`) — yo tengo cambios sin pushear.
- No tocar otras env vars de `.env.local` — solo agregar las nuevas.
- No tocar el OPS de OrbStack que ya estás corriendo en paralelo.

---

## Orden sugerido

**Sesión Codex (~1h 30min):**

1. **Inmediato:** Tareas 1.1 + 1.2 + 1.3 (warmup wiring + env vars) — 17 min.
2. Pinguear a Juanes para que cree Mailtrap + pueble env vars.
3. Mientras Juanes hace eso: Tareas 2.1 + 2.2 (SMTP retry adapter) — 32 min.
4. Cuando Juanes confirme env vars: Tarea 1.4 (smoke warmup) — 15 min.
5. Smoke E2E completo Tarea 2.3 (~10 min) + Tarea 2.4 docs (3 min).
6. Cierre + commit + push.

---

## Verificación esperada al cerrar el OPS

```
✓ POST /v1/warmup/seed con dominio + serverSlug + approval válido →
  3 emails llegan a Mailtrap, status 200, execution success en workspace.

✓ install_smtp_stack contra VPS recién creado → success al primer
  intento externo (con retries internos transparentes si fueron necesarios).

✓ Frontend Canvas Live no muestra retries durante install_smtp_stack —
  una sola task progresando.

✓ Telemetría: success payload incluye sshConnectAttempts +
  cloudInitSettleSeconds para auditar futuras flakiness.

✓ .env.local.example documenta WARMUP_ENABLE_SEND +
  WARMUP_DEFAULT_SEED_INBOXES.

✓ Smoke E2E completo (compra → DNS → VPS → SMTP → bind → warmup)
  corre sin retries visibles y los 3 seed emails llegan.

✓ Notion entry actualizada con "Bloqueantes demo viernes resueltos".
```

Cuando cierres pingueá a Juanes y a Claude. Yo (Claude) hago practice run #3 visual completo con vos y Juanes para validar la narrativa antes del viernes 11h.

Gracias. Esto es decisivo.
