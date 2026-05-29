# Reporte de readiness — Demo viernes 29-may 11h Colombia

**Auditor:** Claude (QA + PM + frontend senior).
**Fecha:** 2026-05-28 jueves, tarde.
**Método:** auditoría profunda de los 7 gates del flow E2E real (compra dominio → DNS → VPS → SMTP → bind → warmup → chat OpenClaw) cruzando código + executions del workspace + .env.local + tests.
**Pedido explícito Juanes:** "esto debe funcionar, debe funcionar... sin excusas". El demo es **Final.0** y el jefe quiere ver el flujo entero en tiempo real.

---

## TL;DR — Decisivo

**Estado:** **2 BLOQUEANTES CRÍTICOS + 1 RIESGO ALTO antes del demo.**

| Gate del demo | Probado E2E | Estado | Riesgo |
|---|---|---|---|
| 1. Comprar dominio Route53 | ✓ 28-may 00:07h | ✓ funciona | Bajo |
| 2. Configurar DNS (DKIM/SPF/DMARC) | ✓ 28-may 00:08h y 00:10h | ✓ funciona | Bajo |
| 3. Provisionar VPS Webdock | ✓ 28-may 00:09h y 00:10h | ✓ funciona | Bajo |
| 4. Install SMTP stack (postfix+DKIM+TLS) | ✓ 28-may 01:13h (al 4to intento) | ⚠️ **flaky** | **ALTO** |
| 5. Bind dominio ↔ servidor | ✓ 28-may 01:13h | ✓ funciona | Bajo |
| 6. **Warmup seed (calentamiento del inbox)** | **✗ NUNCA** | 🔴 **NO PROBADO** | **BLOQUEANTE** |
| 7. Chat OpenClaw vivo con Bedrock | ⚠️ panel renderiza pero no validé respuestas | 🟡 verificar | Medio |

**Para que el demo del viernes funcione:**

1. **Codex ahora (~1.5h):** habilitar warmup + estabilizar SMTP install
2. **Juanes ahora (~10 min):** agregar 3 env vars al `.env.local`
3. **Practice run E2E completo (~30 min):** vos comprás dominio descartable + todo el flow corriendo, yo monitoreando

Si arrancamos en los próximos 30 min, llegamos limpios al viernes.

---

## Bloqueantes detallados

### 🔴 BLOQUEANTE B-DEMO-01 — Warmup seed NO está armado para correr

**Vista del usuario:** el Acto 3 del demo del viernes es "darle start para calentamiento de bandeja, calentamiento del inbox". Hoy si vos disparás eso, el sistema responde con `warmup_send_flag_disabled` y bloquea la ejecución antes de mandar el primer email.

**Evidencia técnica:**

`apps/gateway-api/src/routes/warmup.ts` línea 130:

```typescript
if (env.WARMUP_ENABLE_SEND !== "true") blockers.push("warmup_send_flag_disabled");
if (!deps.sshRunner.isConfigured()) blockers.push("warmup_ssh_runner_missing");
if (!approval) blockers.push("approval_not_found_or_expired");
if (!serverIp) blockers.push("server_ip_missing");
if (seedInboxes.length !== 3) blockers.push("seed_inboxes_must_be_exactly_3");
```

**En .env.local hoy NO hay:**
- `WARMUP_ENABLE_SEND`
- 3 seed inboxes configuradas (vienen del body de la request, pero el panel necesita defaults)
- Probable: `WARMUP_SSH_KEY_PATH` o similar para el runner

**Confirmación adicional:** nunca se ejecutó `start_warmup_seed` en el workspace (`find runtime/openclaw-workspace/executions -name "*warmup*"` → 0 resultados).

**Remediación:**

1. **Codex** (~30 min):
   - Agregar a `WARMUP_ENABLE_SEND` el chequeo en `.env.local.example` con documentación.
   - Verificar que el `sshRunner` para warmup esté wireado al mismo SSH config que SMTP provisioning (probable que sí pero confirmar).
   - Smoke E2E del warmup contra el server69 reactivado: crear 3 seed inboxes Mailtrap.io o similar (~5 min Mailtrap free tier) + correr `POST /v1/warmup/seed` con esos seeds → debe llegar 3 emails al inbox y emitir `oc.warmup.seed_sent`.

2. **Juanes** (~10 min):
   - Crear cuenta Mailtrap.io (free tier, sandbox) + crear inbox de pruebas.
   - Generar 3 direcciones únicas que reciban en ese sandbox (Mailtrap genera direcciones random).
   - Agregar a `.env.local`:
     ```
     WARMUP_ENABLE_SEND=true
     WARMUP_DEFAULT_SEED_INBOXES=seed-1@xxxxx.mailtrap.io,seed-2@xxxxx.mailtrap.io,seed-3@xxxxx.mailtrap.io
     ```
   - Si Codex prefiere otro nombre de var, ajustar.

**Aceptación:** mañana en el demo, cuando dispares el Acto 3 con OpenClaw, debe:
- Crear task "Warmup seed · <dominio>"
- Conectarse vía SSH al VPS
- Mandar 3 emails reales a los seed inboxes
- Que vos veas los 3 emails llegar en Mailtrap (compartible en pantalla con el jefe)

---

### ⚠️ BLOQUEANTE B-DEMO-02 — SMTP install es flaky (3 fallos antes de éxito)

**Vista del usuario:** el Acto 2/3 del demo es "configurar servidor, conectarlo con el dominio". Si OpenClaw falla 3 veces antes del éxito, son **~5 minutos** de tu jefe viendo retries en pantalla.

**Evidencia técnica del run del 28-may madrugada:**

```
010522 install_smtp_stack · FAILED   (SSH command timed out)   50s
010617 install_smtp_stack · FAILED   (SSH command timed out)   145s
010924 install_smtp_stack · FAILED   (SSH command exit 1)      144s
011308 install_smtp_stack · SUCCESS  (48s)  ← 4to intento
```

Total tiempo perdido: ~5 minutos de retries.

**Causa raíz probable:** el primer comando del script es `wait-cloud-init` — el VPS recién creado por Webdock todavía no terminó cloud-init cuando OpenClaw intentó SSH. Los timeouts SSH (no exit code) confirman conexión rechazada o stalled.

**Remediación:**

1. **Codex** (~20 min):
   - Aumentar `WEBDOCK_SSH_ACCESS_SETTLE_MS` de su valor actual a algo más conservador (ej. 120s).
   - O agregar al `install_smtp_stack` un wait inicial dedicado de 60s antes del primer SSH connect.
   - Implementar **retry transparente con backoff** dentro del adapter SMTP: si SSH timeout o exit 255, esperar 30s y reintentar internamente hasta 3 veces. Que el operador NO vea los retries — solo el resultado final.
   - Agregar telemetría `cloud-init.elapsed_seconds_at_first_ssh` para diagnosticar futuras flakiness.

2. **Juanes** (~5 min):
   - Verificar que el plan Webdock que estamos usando tiene cloud-init razonablemente rápido (el `WEBDOCK_DEFAULT_LOCATION_ID` actual). Si es muy lento, considerar moverse a un plan más rápido para el demo.

**Aceptación:** corrida E2E hoy con OpenClaw aprovisionando + instalando SMTP debe completar **sin retries visibles** en el Canvas Live. Si hay retry, debe ser silencioso dentro del adapter.

---

### 🟡 RIESGO R-DEMO-03 — Chat OpenClaw vivo no validado E2E hoy

**Vista del usuario:** el demo arranca con vos chateando con OpenClaw — pedirle que aprovisione el dominio, que apruebe el plan, etc. Si el bridge SSH al container está caído o latente, OpenClaw no responde y el demo se queda mudo.

**Evidencia técnica:**

- `OPENCLAW_BRIDGE_KIND=ssh` (no WSS directo)
- `OPENCLAW_SSH_HOST=2.24.223.240` (probable Hostinger VPS)
- `OPENCLAW_CONTAINER_ID=openclaw-dtsf-openclaw-1`
- El panel renderiza "OpenClaw está listo · feed actualizado hace Xs" pero yo no validé que el agente responde a un prompt real hoy.
- Memoria previa nota "Hostinger bridge HTTP/WSS no implementa contrato Delivrix; chat real bloqueado hasta nuevo deploy en imagen (2026-05-24)" — esto necesita confirmación.

**Remediación:**

1. **Juanes ahora** (~5 min):
   - Abrir el chat de OpenClaw en el panel.
   - Mandar un prompt simple: "Hola, ¿qué tareas tienes asignadas hoy?".
   - Confirmar que responde en <10s sin error.

2. **Si no responde:**
   - Codex revisa el bridge en el VPS (`ssh root@2.24.223.240` → `docker ps | grep openclaw`) y reinicia el container si está down.
   - Si el bridge está roto a nivel deploy, **fallback al demo: tener un canvas pre-grabado** con la conversación que querías mostrar.

**Aceptación:** durante practice run hoy, vos chateás 3 veces con OpenClaw y las 3 respuestas llegan en <10s sin error visible.

---

## Cosas que NO son bloqueante pero hay que limpiar

### A-LIMP-01 — Webdock-Account key 401 Unauthorized

Visible en `/infrastructure` ahora mismo. La key Account devuelve 401. Esa key solo se usa para gestión de SSH keys de billing, no para el flow del demo. Pero un jefe que vea el panel verá la card en rojo.

**Remediación:** Juanes regenera la key en panel Webdock (5 min) o quita la card del panel (otra opción menos limpia).

### A-LIMP-02 — Sigue diciendo "FASE DEL NORTE: 5.9-manual-snapshot-ingestion-ux" en /safety

Codex agregó `environment` y `releasePhase` separados, pero la card Kill Switch global todavía muestra el sprint phase como "fase". No es bloqueante, pero si el jefe pregunta es info técnica interna.

**Remediación:** Claude (15 min post-demo) o ignorar y explicar si pregunta.

### A-LIMP-03 — Tareas conversacionales fallidas en Canvas

Resuelto con filtro frontend que oculta las 6. Toggle "Mostrar 6 ocultas" disponible si vos querés mostrar la auditoría completa.

---

## Plan de remediación HOY (hasta cierre del jueves)

### Carril Codex (~1.5 h)

1. **B-DEMO-01 warmup seed (30 min):** habilitar `WARMUP_ENABLE_SEND`, validar `sshRunner` configurado para warmup, smoke E2E con 3 seed inboxes reales.
2. **B-DEMO-02 SMTP flakiness (30 min):** subir `WEBDOCK_SSH_ACCESS_SETTLE_MS`, implementar retry interno con backoff en el adapter SMTP, telemetría cloud-init.
3. **OPS BD OrbStack (~1 h):** sigue en background lo que ya pediste — no bloquea demo viernes pero es del CTO directo.

### Carril Juanes (~30 min)

1. **Crear cuenta Mailtrap.io** + 3 seed inboxes (10 min).
2. **Agregar 2 env vars** a `.env.local` (5 min):
   ```
   WARMUP_ENABLE_SEND=true
   WARMUP_DEFAULT_SEED_INBOXES=seed1@...,seed2@...,seed3@...
   ```
3. **Probar chat OpenClaw vivo** — un prompt para confirmar bridge OK (5 min).
4. **Regenerar Webdock-Account key** o aceptar que aparezca con 401 en el panel (5 min).
5. **Push frontend audit complete** que dejé listo (5 min):
   ```
   bash push_frontend_audit_complete.sh
   ```

### Carril Claude (yo, en paralelo, ~1 h)

1. **Mientras Codex repara, yo audito visualmente** el flow paso a paso.
2. **Armar guion del demo Actos 1-2-3** con CTAs, transiciones, qué decir, plan B narrativo.
3. **Armar pre-flight checklist viernes 10h** con todo lo que hay que verificar antes del 11h.
4. **Armar plan B narrativo** si algo falla en vivo.

### Practice run E2E real (~45 min, juntos)

1. Vos comprás dominio descartable (`delivrix-mail-prod-test-${timestamp}.click` o lo que elijas).
2. OpenClaw corre todo el flow: compra → DNS → VPS → SMTP → bind → warmup.
3. Yo monitoreo cada gate con Chrome MCP + screenshots.
4. Si algo falla, lo paramos, Codex arregla, retomamos.
5. **No paramos hasta que el flow corra sin fricciones visibles.**

---

## Pre-flight checklist viernes 10h Colombia

Cuando lo arme, va a tener algo así:

```
□ Gateway responde GET /health · postgres OK · redis OK
□ Panel admin levanta en localhost:5173 en <3s
□ Bedrock latencia <2s (probar 1 prompt)
□ Mailtrap inbox de seeds vacío y listo
□ Kill Switch en estado ARMED, no en ACTIVE
□ Wallet operativo cap $50 → gastado $3 → disponible $47
□ Demo dominio NUEVO elegido (no reusar el delivrix-demo-d10-20260527)
□ Backup screenshot del canvas live por si Bedrock se cae
□ OBS o ScreenShare probado
□ Audio del Mac probado
□ Network estable (no usar wifi compartida si hay alternativa)
□ Pestañas que NO deben estar abiertas cerradas
□ Notificaciones de Slack/Mail silenciadas
□ `flip-purchase-flag.sh` verificado (AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE ya en true)
□ Recordatorio: si algo falla, decir "pasame al siguiente acto y vuelvo a este" no improvisar
```

Lo termino cuando vos confirmes que arrancamos con el plan.

---

## Decisión inmediata que necesito de vos

¿Le mando estos 2 bloqueantes a Codex como OPS_CODEX_BLOQUEANTES_DEMO_HOY.md ahora mismo? Lo armo en 5 min con specs precisas, lo lees, y se lo das a Codex en paralelo a OrbStack para que ataque los dos.

O si querés priorizar OrbStack primero y demos viernes después, decime y reorganizo.

**Mi recomendación fuerte:** dos OPS Codex en paralelo (OrbStack + Bloqueantes demo) **ya**. Sin esto el viernes el Acto 3 NO funciona y se va a notar mucho frente al jefe.
