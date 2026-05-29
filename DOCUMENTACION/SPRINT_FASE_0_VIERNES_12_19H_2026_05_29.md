# Sprint Fase 0 — viernes 12:00-19:00 COT

**Owner:** Juanes (CTO) + Claude (PM orquestador) + Codex (implementador Mac) + sub-agentes Claude (paralelos).
**Duración:** 7 horas.
**Objetivo:** cerrar Fase 0 del roadmap autonomía 100% (cambio de norte aplicado + 1 firma operativa + audit chain SHA-256 + smoke E2E real).

## Estado pre-sprint (12:00 COT)

✅ Demo Hostinger cerrado con éxito.
✅ Bedrock direct + live context vivo.
✅ Audit del día completo.
✅ Roadmap autonomía 100% documentado (5 fases, 7 semanas).
✅ Arquitectura multi-agent runtime documentada.
✅ Cambio de norte documentado (esperando commit firmado).
⏳ NORTE_OPERATIVO_DELIVRIX.md sigue con "regla de 2 personas".
⏳ Skills críticas siguen en `future_live_requires_new_phase`.

## Esquema de paralelización

```
┌──────────────────────────────────────────────────────────────────┐
│ PM (Claude) — orquesta + arma OPS + recibe reportes + decide     │
└────────────┬────────────────────────────────┬────────────────────┘
             │                                │
             ▼                                ▼
┌────────────────────────────┐    ┌──────────────────────────────┐
│ CODEX (Mac de Juanes)      │    │ SUB-AGENTES CLAUDE (sandbox) │
│ Acceso real .env + AWS     │    │ Mejor para code gen aislado  │
│ Smoke contra gateway local │    │ Diseño + tests + docs        │
└────────────────────────────┘    └──────────────────────────────┘
```

## Pre-condición humana (Juanes, 5 min)

**Paso bloqueante #0**: aplicar diff del cambio de norte.

```bash
cd "/Users/juanescanar/Documents/delivrix app"

# 1. Editar manualmente DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md
#    aplicando el diff de CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md
#    (sección "Diff del norte")

# 2. Editar manualmente DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md
#    reclasificando las 9 skills críticas a supervised_local_state
#    (tabla en CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md sección
#    "Categorías de permisos — reclasificación")

# 3. Commit firmado:
git add DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md \
       DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md
git commit -m "norte(operativo): replace 2-person rule with 1-signature + robust audit chain

Aplica diff documentado en CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md.

- Acciones supervised: 1 firma del operador + audit chain SHA-256
- 9 skills criticas movidas de future_live_requires_new_phase a
  supervised_local_state
- 8 compensaciones de seguridad documentadas
- Skills destructivas (delete_domain, wipe_server) siguen bloqueadas

Firmado por: juanescanar-cto.
Roadmap: ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md"

git push origin main
```

**Sin este commit, el resto del sprint queda bloqueado** porque las skills siguen en `future_live_requires_new_phase` y el agente sigue rechazando ejecución real.

## Tracks paralelos (12:00-18:00)

### Track A — Codex (Mac, 6h netas)

**Owner:** Codex CLI usando sub-agentes seniors según `PROTOCOLO_CODEX_SUB_AGENTES_SENIORS.md`.

#### A1 — Audit chain SHA-256 (12:00-14:00, 2h)

**Tareas Codex:**
1. Crear `apps/gateway-api/src/audit-chain.ts` con clase `AuditChainStore` que envuelve `LocalFileAuditLog`.
2. Cada append calcula: `event.hash = SHA256(prevHash + canonicalEvent)`.
3. Endpoint `GET /v1/audit-chain/verify` recorre la cadena, devuelve `{ ok, brokenAt? }`.
4. Backfill de eventos existentes con `prevHash` calculado en orden cronológico.
5. Tests: corromper un evento → verify devuelve `ok: false, brokenAt: <id>`.

**Sub-agentes Codex:**
- Backend Senior: implementa + tests.
- QA Senior: valida casos edge (cadena vacía, corrupción en último vs intermedio).
- Security Senior: revisa que `canonicalEvent` sea determinístico (orden de keys JSON).

**Criterio de aceptación:** `node --test src/audit-chain.test.ts` 100% verde + `curl /v1/audit-chain/verify` devuelve `{ok:true, totalEvents:N}` con N > 0.

**Reporte a PM:** SHA del commit + output del test + curl response.

#### A2 — Auto-rollback DNS + SMTP (14:00-16:00, 2h)

**Tareas Codex:**
1. Crear `apps/gateway-api/src/auto-rollback.ts` con interfaz `RollbackManager`.
2. **Rollback DNS:** antes de cualquier `route53_dns_upsert` o `ionos_dns_upsert`, guardar snapshot de la zona (`GET .../records`) en `runtime/rollback-snapshots/{auditId}.json`. Si propagación no se confirma en 5 min (poll DNS con `dig` equivalente JS), aplicar snapshot.
3. **Rollback SMTP:** después de `install_smtp_stack`, monitorear bounce rate primeros N envíos. Si bounce > 5%, ejecutar `stop_warmup` automático + audit event `oc.warmup.auto_paused`.
4. Tests unit con mocks + integration con LocalStack.

**Sub-agentes Codex:**
- Backend Senior: implementa.
- QA Senior: simula propagación fallida en mock Route53, verifica que rollback se aplique.
- Security Senior: revisa que los snapshots NO incluyan datos sensibles (DKIM private keys, etc.).

**Criterio de aceptación:** test E2E (mock) de mutación DNS + propagación fallida → snapshot aplicado + audit `oc.dns.rolled_back` emitido.

#### A3 — Smoke E2E con 1 firma real (16:00-18:00, 2h)

**Pre-condición:** sub-agentes Claude entregaron `ApprovalGate.tsx` (Track B3) + webhook broadcast funcional (Track B1).

**Tareas Codex:**
1. Levantar gateway con flags habilitados: `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` + `WEBDOCK_SERVERS_ENABLE_CREATE=true` + `SMTP_PROVISIONING_ENABLE_SSH=true` + `WARMUP_ENABLE_SEND=true` + `DOMAIN_BIND_ENABLE=true` + `EMAIL_AUTH_ENABLE_WRITES=true` + `WARMUP_RAMP_ENABLE=true`.
2. Pedir a OpenClaw via chat: "comprá `delivrix-fase0-{timestamp}.click` y configurá DNS + VPS + SMTP + warmup seed con 3 emails a `jectcode+fase0-1@gmail.com, +fase0-2, +fase0-3`".
3. Cuando el agente proponga, **Juanes firma con 1 click** vía `ApprovalGate.tsx`.
4. Verificar:
   - Dominio comprado real en Route53.
   - DNS publicado (A, MX, SPF, DKIM, DMARC).
   - VPS Webdock provisionado.
   - SMTP stack instalado.
   - 3 emails llegan al Gmail.
   - Webhook al equipo recibió las notificaciones.
   - Audit chain SHA-256 íntegra.
5. Reporte en `DOCUMENTACION/SMOKE_FASE_0_RESULT_2026_05_29.md`.

**Criterio de aceptación:** smoke E2E verde, 1 firma, tiempo total <15 min, 3 emails llegan, audit chain íntegra.

### Track B — Sub-agentes Claude (sandbox, paralelos, 5h netas)

**Owner:** Claude PM lanzando sub-agentes en paralelo.

#### B1 — Webhook broadcast equipo (12:00-13:30, 1.5h)

**Sub-agente Backend Senior Claude:**
- Crear `apps/gateway-api/src/webhook-broadcast.ts` con clase `EquipoWebhookBroadcaster`.
- Por cada audit event con categoría `supervised_local_state` o más crítica, pushear payload a `EQUIPO_WEBHOOK_URL` (Slack-compatible).
- Payload: `{ text, blocks: [resumen + audit ID + dominio + servidor + categoría + diff dry-run + link al panel] }`.
- Backoff exponencial si webhook falla, max 3 retries.
- Queue local para retries diferidos.
- Tests con mock fetch + verificación de payload shape.

**Sub-agente QA Senior Claude:**
- Matrix de casos: webhook 200, 500, timeout, malformed, kill switch armado (no broadcastear).
- Tests E2E con MSW.

**Sub-agente Security Senior Claude:**
- Revisar que el payload NO incluya secrets ni PII.
- Verificar redacción (`token`, `password`, `secret`, `api_key` → `[REDACTED]`).
- Documentar threat model en comentarios.

**Entregable:** `webhook-broadcast.ts` + `webhook-broadcast.test.ts` + sign-off de QA + Security.

#### B2 — Endurecer system prompt con providers canónicos (12:00-13:00, 1h)

**Sub-agente PM (yo):**
- Editar `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` sección §4 bloque [10] (Disciplina del flow real).
- Agregar lista canónica de proveedores REALES (Webdock × 3, AWS Route53, AWS Bedrock, IONOS DNS, IONOS Domains, Porkbun, servidor físico Medellín).
- Agregar: "NO inventes proveedores (Cloudflare, Cloudflare Workers, Vercel, etc.). Si el operador pregunta por un proveedor que NO está en mi lista, decí explícito 'no usamos ese proveedor'."
- Actualizar `scripts/openclaw/build-system-context.sh` con la lista canónica también en AGENTS.md bootstrap.

**Entregable:** commit con system prompt actualizado.

#### B3 — ApprovalGate.tsx frontend (13:30-16:00, 2.5h)

**Sub-agente Full Stack Senior Claude:**
- Crear `apps/admin-panel/src/v5/components/ApprovalGate.tsx`.
- Recibe props: `auditId`, `dryRunSummary`, `category`, `gates[]`, `onApprove(token)`.
- Renderiza modal con:
  - Header: "Aprobación operador · {category}"
  - Cuerpo: dry-run completo con sintaxis-highlight (markdown rendering)
  - Tabla de gates con estado (✅ / ⚠️) + responsable
  - Audit ID + timestamp + actor agente que propuso
  - Timer de 5s deshabilitando el botón "Firmar y ejecutar" (forzando lectura)
  - Botón "Firmar y ejecutar" (única acción)
  - Botón "Rechazar" (cierra el modal, audit `oc.signature.rejected`)
- Llama a `POST /v1/openclaw/proposals/{auditId}/sign` cuando se firma.
- Tests unit con React Testing Library (renderiza, timer respeta 5s, click llama API).

**Sub-agente QA Senior Claude:**
- Cubre: render visual, timer respeta 5s, botón deshabilitado al inicio, sign call con token correcto, fallback de error.

**Entregable:** `ApprovalGate.tsx` + `ApprovalGate.test.tsx` + sign-off de QA.

#### B4 — Diff Permissions Matrix (16:00-17:00, 1h)

**Sub-agente PM (yo):**
- Aplicar la reclasificación de skills documentada en `CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md` (tabla "Categorías de permisos").
- 9 skills críticas pasan de `future_live_requires_new_phase` a `supervised_local_state`.
- Documentar el flag operativo nuevo que cada skill requiere (algunos ya existen, 4 son nuevos).
- Update `scripts/openclaw/build-system-context.sh` para reflejar la matriz nueva en Capa 1.

**Entregable:** `OPENCLAW_PERMISSIONS_MATRIX.md` actualizado + commit.

## Tracks NO bloqueantes para hoy (lunes-martes)

- Tool calling Bedrock (Fase 1, 5 días).
- Multi-agent seniors orquestados (Fase 2, 7 días).
- Visualización Canvas Live multi-agente (Fase 3, 5 días).

Estos arrancan **lunes** una vez Fase 0 cerrada.

## Check-ins cada 2h

| Hora | Reporte que el PM (yo) recibe | Acción del PM |
|---|---|---|
| 14:00 | Codex: SHA audit chain + tests / Sub-agentes: webhook broadcast + system prompt | Verificar reportes, marcar tasks completed, despachar Track B3 ApprovalGate |
| 16:00 | Codex: SHA auto-rollback + tests / Sub-agentes: ApprovalGate + Permissions Matrix | Verificar, despachar Track A3 smoke E2E + escribir OPS final si necesario |
| 18:00 | Codex: smoke E2E result | Validar smoke verde, armar reporte de cierre + post a Juanes con TL;DR + push final |

## Cierre de sprint (18:00-19:00, 1h)

**Owner: PM (yo)**

1. Compilar `DOCUMENTACION/SPRINT_FASE_0_RESULT_2026_05_29.md` con:
   - SHAs de todos los commits del día.
   - Tests totales verdes (gateway-api + admin-panel).
   - Smoke E2E result.
   - Riesgos identificados.
   - Lo que queda para Fase 1.

2. Actualizar memoria persistente:
   - `delivrix_fase_0_cerrada.md`
   - `delivrix_norte_actualizado_1_firma.md`
   - `delivrix_audit_chain_sha256.md`

3. Sign-off del CTO Juanes para arrancar Fase 1 lunes.

## Riesgos identificados pre-sprint

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Smoke E2E real cuesta dinero (~$15 dominio + ~$5 Webdock + Bedrock) | Alta | Bajo (~$25) | Usar dominio descartable barato (.click, .xyz) |
| Audit chain backfill rompe events existentes | Media | Medio | Backup `.audit/audit-events.jsonl` antes de mutar |
| Webhook URL del equipo no existe todavía | Alta | Bajo | Fallback a archivo `runtime/webhook-buffer.jsonl` si EQUIPO_WEBHOOK_URL no está set |
| Codex satura por trabajar 6h continuas | Media | Alto | Pausas de 10 min cada 2h durante check-ins |
| Algún flag operativo nuevo (DOMAIN_BIND_ENABLE, etc.) requiere implementación previa | Media | Medio | Si bloquea, Codex implementa rápido el chequeo del flag en el handler |

## OPS pre-armados para Codex

Codex recibirá 3 OPS específicos durante el sprint:

1. **`OPS_CODEX_FASE_0_A1_AUDIT_CHAIN.md`** (12:00) — implementa audit chain SHA-256.
2. **`OPS_CODEX_FASE_0_A2_AUTO_ROLLBACK.md`** (14:00) — implementa auto-rollback DNS + SMTP.
3. **`OPS_CODEX_FASE_0_A3_SMOKE_E2E.md`** (16:00) — corre smoke E2E con 1 firma.

PM armará cada OPS justo antes de despacharlo, incorporando feedback de los tracks paralelos.

## Reglas duras del sprint

1. **Codex usa sub-agentes seniors** según `PROTOCOLO_CODEX_SUB_AGENTES_SENIORS.md`. Cada track tiene Backend + QA + Security mínimo.
2. **NO push directo a main sin sign-off de QA + Security.**
3. **NO disable de tests existentes para que pasen los nuevos.**
4. **Si un sub-agente reporta bloqueante crítico, PM escala a Juanes.**
5. **Si Bedrock cuesta más de $5 en el sprint, PM escala.**
6. **Si smoke E2E falla, NO se commitea el código nuevo hasta diagnosticar.**
7. **Audit chain íntegra al final del día** verificado con `curl /v1/audit-chain/verify`.

## Pregunta para Juanes antes de arrancar

- [ ] ¿Tenés URL del webhook del equipo (Slack/Discord) lista? Si no, ¿la creás ahora o usamos buffer local?
- [ ] ¿Estás OK con gastar ~$25 USD en el smoke E2E real (dominio descartable + VPS + Bedrock)?
- [ ] ¿Confirmás que aplicás el commit del cambio de norte AHORA (5 min)?

Respondé las 3 y arrancamos.

— Claude PM
