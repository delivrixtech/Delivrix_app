# OPS Codex — Cierre demo viernes Final.0 (último OPS pre-demo)

**Para:** Codex.
**De:** Claude (QA + PM + frontend senior).
**Fecha:** 2026-05-28 jueves, noche.
**Prioridad:** **CRÍTICA** — el demo es mañana 11am COT.
**Tiempo estimado total Codex:** **~40-60 min** (smoke E2E + cierre administrativo).

## Resumen del estado

Hice diagnóstico paralelo de OpenClaw + bloqueantes via 2 sub-agentes esta noche. Resultado:

| Componente | Estado | Confianza |
|---|---|---|
| Skills directas (register_domain, dns_upsert, provision_vps, install_smtp_stack, bind_domain, start_warmup_seed) | ✓ Funcionan E2E | Alta — executions 28-may 01:13 confirman |
| Adapter SMTP con retry interno (`runSmtpStepWithCloudInitRetry`) | ✓ Código + tests cerrados (commit `484f399`) | Alta |
| Handler warmup con `resolveSeedInboxes` fallback a env | ✓ Código + tests cerrados (commit `484f399`) | Alta |
| `.env.local` WARMUP_ENABLE_SEND, WEBDOCK_SSH_ACCESS_SETTLE_MS | ✓ Setteados | Alta |
| `.env.local` WARMUP_DEFAULT_SEED_INBOXES | 🔴 **Placeholders literales** del `.env.example` — Juanes debe reemplazar | Alta |
| Smoke E2E completo (SMTP + warmup) post-484f399 | 🟡 **No ejecutado** | Bloqueante |
| Chat OpenClaw conversacional (bridge SSH → container Hostinger) | 🔴 **Container `openclaw-dtsf-openclaw-1` no implementa contrato Delivrix desde 24-may** — diagnóstico del 24-may sigue válido, 0 executions de chat en workspace toda la semana | Media-Alta |
| Skills directas vía panel (botones, no chat) | ✓ Funcionan | Alta |

**Decisión narrativa para el demo:** el **Acto 3 conversacional con chat** está en riesgo si el container Hostinger no responde. Las **skills directas vía panel** son el plan B y están probadas. El OPS de hoy NO te pide arreglar el container Hostinger (out of scope sin acceso al equipo Webdock); te pide cerrar el smoke E2E y dejar el demo listo en modo skills-directas. Vos decidís si querés intentar reactivar el container Hostinger en paralelo (instrucciones al final, opcional).

---

## Tarea 1 — Smoke E2E completo post-484f399 (~25 min, BLOQUEANTE)

### Pre-condición Juanes (5 min)

Juanes te tiene que entregar antes:
1. `.env.local` con 3 inboxes reales de Mailtrap reemplazando los placeholders `seed-N@xxxxx.mailtrap.io`.
2. Confirmación de que `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` y `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50` (kill switch presupuestario).

Si te falta cualquiera, **escala a Juanes inmediato** y para acá hasta que llegue.

### Sub-tarea 1.1 — Provisionar VPS Webdock fresh (5 min)

```bash
curl -X POST http://localhost:3000/v1/webdock/provision \
  -H "content-type: application/json" \
  -d '{
    "label": "demo-smoke-2026-05-28",
    "approvalToken": "<token vigente del audit chain>",
    "actorId": "codex-smoke-friday"
  }'
```

**Criterio:** status 200 + workspace execution `2026-05-28/HHMMSS-provision_webdock_vps-*-success.md` + telemetría `cloudInitSettleSeconds` registrada en evidence.

### Sub-tarea 1.2 — Install SMTP stack contra el VPS fresh (5-15 min)

```bash
curl -X POST http://localhost:3000/v1/smtp/install \
  -H "content-type: application/json" \
  -d '{
    "serverSlug": "<slug devuelto en 1.1>",
    "domain": "<dominio-descartable.click>",
    "approvalToken": "<token vigente>",
    "actorId": "codex-smoke-friday"
  }'
```

**Criterio:**
- Status 200 sin error visible al usuario (los retries internos no deben aparecer en respuesta exitosa).
- Workspace execution `*-install_smtp_stack-*-success.md` con `sshConnectAttempts ≥ 1` registrado en evidence.
- Si hubo retries internos (`sshConnectAttempts > 1`), confirma que NO se emitieron `*-failed.md` previos en este invocation — el retry debe ser silencioso dentro del adapter.

### Sub-tarea 1.3 — Bind dominio ↔ servidor (2 min)

```bash
curl -X POST http://localhost:3000/v1/bind \
  -H "content-type: application/json" \
  -d '{
    "domain": "<dominio>",
    "serverSlug": "<slug>",
    "approvalToken": "<token>",
    "actorId": "codex-smoke-friday"
  }'
```

**Criterio:** status 200 + audit event `oc.bind.completed`.

### Sub-tarea 1.4 — Warmup seed E2E (5 min) — el gate más crítico

```bash
curl -X POST http://localhost:3000/v1/warmup/seed \
  -H "content-type: application/json" \
  -d '{
    "domain": "<dominio>",
    "serverSlug": "<slug>",
    "actorId": "codex-smoke-friday",
    "approvalToken": "<token>"
  }'
```

**Criterio (sin saltarse ninguno):**
- Status 200.
- Body contiene `sent.length === 3`.
- Workspace execution `*-start_warmup_seed-*-success.md`.
- Audit event `oc.warmup.seed_sent` emitido.
- **3 emails reales llegan al inbox Mailtrap de Juanes** — verificable abriendo Mailtrap sandbox.

Si falla con `seed_inboxes_must_be_exactly_3` → Juanes no reemplazó los placeholders, escalá.
Si falla con `server_ip_missing` → el server slug del 1.1 no propagó, revisar.
Si falla con `approval_not_found_or_expired` → tomar nuevo token del audit chain.

### Sub-tarea 1.5 — Reportar (5 min)

Crea `DOCUMENTACION/SMOKE_DEMO_VIERNES_RESULT_2026_05_28.md` con:
- Listado de los 5 executions con sha hash, status, duration.
- Screenshot del inbox Mailtrap con los 3 emails (o link al sandbox).
- Telemetría observada: `cloudInitSettleSeconds`, `sshConnectAttempts`, retries silenciosos sí/no.
- Observaciones para el demo en vivo (qué tarda más, qué watch out).
- Si algo falla, **detalle preciso de qué falla** + propuesta de fix antes del viernes 10h.

---

## Tarea 2 — Cierre administrativo OPS bloqueantes ayer (~10 min)

Crear `DOCUMENTACION/OPS_CODEX_BLOQUEANTES_DEMO_VIERNES_2026_05_28_RESULT.md` con:

```markdown
# RESULT — OPS Codex bloqueantes demo viernes (cierre)

Sha de cierre: 484f399 fix(gateway): unblock demo warmup and smtp retry

## B-DEMO-01 Warmup seed — CERRADO en código
- Helper resolveSeedInboxes + parseSeedInboxCsv en routes/warmup.ts
- Action renombrado oc.warmup.seed_sent
- Test warmup.test.ts verde
- .env.local.example documentado
- Smoke E2E: ver SMOKE_DEMO_VIERNES_RESULT.md

## B-DEMO-02 SMTP retry — CERRADO en código + telemetría
- runSmtpStepWithCloudInitRetry: 3 intentos, backoffs [30s, 60s]
- Telemetría sshConnectAttempts + cloudInitSettleSeconds en evidence/audit
- progressDetail visible para operador ("esperando cloud-init... intento N de 3")
- Test smtp-provisioning.test.ts verde
- Smoke E2E: ver SMOKE_DEMO_VIERNES_RESULT.md
```

---

## Tarea 3 (opcional, si te queda tiempo) — Verificar container Hostinger

**Solo si terminás T1 y T2 con tiempo de sobra antes de las 22h jueves.**

```bash
# Desde el Mac de Juanes (no desde tu shell de Codex si no tenés la llave):
ssh -i ~/.ssh/delivrix-ops root@2.24.223.240 \
  'docker ps --format "{{.Names}} | {{.Status}}" | grep openclaw'
```

Si `Up X minutes`: probar el ack del contrato:
```bash
ssh -i ~/.ssh/delivrix-ops root@2.24.223.240 \
  'docker exec openclaw-dtsf-openclaw-1 openclaw gateway call chat.send \
    --json --timeout 20 \
    --params "{\"sessionKey\":\"agent:main:operator\",\"message\":\"ping diag\",\"idempotencyKey\":\"diag-$(date +%s)\"}"'
```

Si stdout parsea JSON con `"status":"started"` → el bridge ESTÁ vivo, el Acto 3 chat del demo es viable.
Si stdout es HTML/login o el container está `Restarting` → el bridge sigue roto del 24-may; **demo va en modo skills-directas** (yo armo el guion ajustado).

Reportar resultado en SMOKE_DEMO_VIERNES_RESULT.md sección "Estado container Hostinger".

---

## Reglas duras

1. **NO toques el frontend** — Juanes ya validó las 11 vistas v5 esta tarde.
2. **NO modifiques tokens de aprobación existentes** — usá los del audit chain vivo.
3. **NO hagas commits que toquen `.env.local`** (está en gitignore, pero por si las moscas).
4. **Si algo no compila o un test rojo**, parar y reportar antes de seguir.
5. **Ventana de trabajo**: hasta las 22h del jueves para los smoke results. Después de eso, Juanes y yo armamos el plan B narrativo.

---

## Quién hace qué — visión global

| Carril | Owner | Tiempo | Status |
|---|---|---|---|
| Reemplazar 3 inboxes Mailtrap en `.env.local` | Juanes | 5 min | Pre-condición T1 |
| Verificar bridge Hostinger (4 cmds ssh) | Juanes | 5 min | T3 |
| Smoke E2E completo (provision → SMTP → bind → warmup → 3 emails Mailtrap) | Codex | 25 min | T1 |
| Cierre administrativo OPS bloqueantes | Codex | 10 min | T2 |
| Verificar container Hostinger (si T1 + T2 cerrados) | Codex (opcional) | 5 min | T3 |
| Guion demo Actos 1-2-3 + plan B narrativo | Claude | 30 min | Paralelo |
| Pre-flight checklist viernes 10h | Claude | 15 min | Paralelo |

Cuando T1 esté cerrado y reportado, Juanes y yo arrancamos practice run E2E real (~30 min) con un dominio descartable. Si eso queda limpio, mañana 10am el pre-flight es solo checklist, no debug.

— Claude
