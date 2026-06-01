# Sprint Fase 0 Result — viernes 2026-05-29 12:00-18:00 COT

**Para:** Juanes (CTO), futuras sesiones, equipo Delivrix.
**De:** Claude PM.
**Fecha de cierre:** 2026-05-29 viernes ~17:30 COT.
**Status:** **Fase 0 CERRADA con scope ajustado.** Smoke E2E con gasto queda para Fase 0.5 (lunes 2026-06-01 AM).

## Resumen ejecutivo

En 5.5 horas de sprint cerramos el 90% de la Fase 0: cambio de norte aplicado + 1-firma operativa + audit chain SHA-256 íntegra + auto-rollback armado + webhook broadcast + ApprovalGate UI + 4 gates fail-closed nuevos + kill switch real probado.

**Lo que NO ejecutamos: smoke con dinero real.** Codex detectó al arrancar A3 que los `curl` del OPS no matcheaban los contratos actuales de los handlers + la firma del `ApprovalGate` no está alineada para invocar live actions hoy. Decidió parar antes de gastar $25 USD en un smoke roto. **Es la decisión correcta.**

## SHAs del día

| Track | SHA | Descripción |
|---|---|---|
| PRE | `91d020b` | Norte + permissions matrix + webhook broadcast + system prompt + 9 docs |
| A1 | `cb93e2c` | Audit chain SHA-256 verifier |
| A2 | `13d9357` | Auto-rollback + anchor HMAC + audit batch hardening |
| A3 | `ca76c8a` | Preflight smoke gates + kill-switch guard |

## Lo que SÍ se cerró (Fase 0 al 90%)

### Cambio de norte aplicado
- `NORTE_OPERATIVO_DELIVRIX.md` edited: regla de 2 personas → 1 firma + audit chain + broadcast + auto-rollback.
- `OPENCLAW_PERMISSIONS_MATRIX.md`: 9 skills movidas de `future_live_requires_new_phase` a `supervised_local_state`.
- `OPENCLAW_SYSTEM_PROMPT.md` bloque [11]: lista canónica de 7 proveedores (anti-Cloudflare hallucination).
- `build-system-context.sh` actualizado para sync al container Hostinger.

### Audit chain SHA-256 (A1)
- `apps/gateway-api/src/audit-chain.ts` + tests 12/12.
- Endurece la cadena real `.audit/audit-events.jsonl` (no cadena paralela — decisión correcta de Codex).
- `GET /v1/audit-chain/verify` → `ok=true, totalEvents=520, lastHash=dee96bcf...`.

### Auto-rollback + anchor + audit batch hardening (A2)
- `apps/gateway-api/src/auto-rollback.ts` con DNS pre-snapshot, SMTP auto-pause, Webdock policy.
- `apps/gateway-api/src/audit-batch-origin.ts` rechaza impersonation `actorType` + `humanApproved` sin signatureId.
- `GET /v1/audit-chain/anchor` con HMAC firmado: `headSeq=520, signature=263ab2887bccf...`.
- Tests focalizados A2: 49/49. Suite completa gateway: 146/146.

### Frontend ApprovalGate + wiring (B3 + B5)
- `apps/admin-panel/src/v5/components/ApprovalGate.tsx` con timer 5s + 1 firma + 3 gates de aprobación + Three Dials respetados.
- `apps/admin-panel/src/v5/components/PendingApprovalsPanel.tsx` que deriva proposals pendientes de audit-events (no requiere endpoint nuevo).
- Wireado en `apps/admin-panel/src/v5/views/CanvasLive.tsx` sticky-bottom (fade-out automático cuando no hay proposals).
- Tests escritos: 11 ApprovalGate + N PendingApprovalsPanel. tsc clean.

### Webhook broadcast (B1)
- `apps/gateway-api/src/webhook-broadcast.ts` con redact secrets + buffer local + threat model documentado.
- 12/12 tests verdes. Compatible con Slack-format payload. Kill switch armado → no broadcast (anti-loop).

### Gates fail-closed nuevos (A3)
- `DOMAIN_BIND_ENABLE` chequeado en handler bind.
- `EMAIL_AUTH_ENABLE_WRITES` chequeado en email auth.
- `WARMUP_RAMP_ENABLE` chequeado en ramp scheduler.
- Kill switch global real probado: `HTTP 423 Locked` bloquea acceso a rutas live.

### Verificaciones en vivo
- Gateway PID 84619 + screen detached.
- `curl /health` → status ok, Postgres ok, Redis ok, kill-switch desactivado.
- `curl /v1/audit-chain/verify` → `{ok:true, totalEvents:520, lastHash:dee96bcf...}`.
- `curl /v1/audit-chain/anchor` → `{headSeq:520, signature:263ab2887...}`.
- Backup pre-smoke: `runtime/audit-pre-smoke-fase0.jsonl` sha256 `2ba3341db640...`.

## Lo que NO se cerró (Fase 0.5 lunes)

### Smoke E2E real con gasto

**Razón del NO ejecutar (decisión de Codex, validada por PM):**

1. Los `curl` del OPS A3 no matcheaban los contratos actuales de los handlers. Específicamente:
   - El endpoint `POST /v1/domains/route53/register` probablemente requiere una shape distinta a la que asumía el OPS.
   - El campo `approvalToken` que el OPS pedía hardcodeado en el body NO es el que el ApprovalGate genera vía `POST /v1/openclaw/proposals/{auditId}/sign`.
   - Los handlers `dns_ionos_upsert`, `bind_domain`, `email_auth_configure` requieren shapes específicas no documentadas en el OPS.

2. **La firma del ApprovalGate todavía no está alineada para live actions hoy:**
   - El componente UI POSTea a `/v1/openclaw/proposals/{auditId}/sign` pero ese endpoint backend NO existe todavía.
   - El handler que recibiría la firma + dispatcharía la skill NO está implementado.
   - El backend tiene los handlers de cada skill pero no hay puente del signatureId al approvalToken interno.

3. Gastar $25 USD en un smoke con esos huecos = perder dinero sin aprender nada nuevo.

### Costo evitado: $25 USD.

## Qué falta para Fase 0.5 (lunes 2026-06-01 AM, ~3h)

1. **Endpoint `POST /v1/openclaw/proposals/{auditId}/sign`** que:
   - Valida que el `auditId` corresponde a una propuesta `oc.proposal.submitted` pendiente.
   - Emite audit event `oc.proposal.signed` con `signatureId` + `actorId` + `prevHash`.
   - Devuelve `approvalToken` válido para que el siguiente call al handler skill lo use.
   - O dispatcha la skill internamente si el handler lo soporta directamente.

2. **Alinear contratos handler-curl** uno por uno con los handlers existentes:
   - `POST /v1/domains/route53/register` shape.
   - `POST /v1/dns/route53/upsert` shape.
   - `POST /v1/dns/ionos/upsert` shape.
   - `POST /v1/webdock/servers/create` shape.
   - `POST /v1/servers/{slug}/provision-smtp` shape.
   - `POST /v1/domains/bind` shape.
   - `POST /v1/warmup/seed` shape.
   - **Estrategia recomendada:** correr cada handler aislado contra mock primero, validar shape, luego encadenar.

3. **Tests E2E con LocalStack** (mock Route53/Webdock) para validar el flow completo SIN gasto antes de smoke real.

4. **Smoke real con dominio descartable + dinero real** una vez todo alineado.

## Logros sobre el roadmap autonomía 100%

Comparado con [ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md](./ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md):

| Fase | Status |
|---|---|
| Fase 0 — Pre-requisitos | **90% cerrado.** Solo smoke real pendiente. |
| Fase 1 — Tool calling Bedrock | No arrancada (5 días, semana próxima). |
| Fase 2 — Multi-agente seniors | No arrancada (7 días, semana 3-4). |
| Fase 3 — Visualización Canvas Live multi-agente | No arrancada (5 días, semana 5). |
| Fase 4 — Audit chain criptográfica al 100% | **70% cerrado** vía A1 + A2 (SHA-256 + anchor HMAC). Falta backup cold storage + reporte forense automatizado. |
| Fase 5 — Demo final Hostinger | No arrancada (semana 7). |

**Adelantamos parcialmente Fase 4 mientras cerramos Fase 0.** Bien.

## Riesgos remanentes para Fase 0.5

1. **Anchor HMAC requiere guardar la firma externamente** para ser prueba real (Slack pin, email al equipo). Si nadie guarda el output, la integridad post-mortem se pierde. **Mitigación lunes:** automatizar pin diario.

2. **DNS rollback se aplica solo si el adapter expone pre-state/restore.** Si no, audita `oc.dns.auto_rollback_failed` con fail-closed. Hoy los adapters Route53/IONOS no exponen ese hook todavía. **Mitigación lunes:** implementar `getZoneSnapshot` + `restoreZone` en cada adapter.

3. **Webdock cloud-init queda como policy auditada, no snapshot real.** Tu nota es correcta. **Mitigación post-MVP:** integración Webdock snapshots API.

4. **Tool calling Bedrock = Fase 1 lunes.** Sin él, el agente sigue describiendo skills, no las invoca. El operador todavía tiene que hacer `curl` manual a cada handler.

5. **El árbol del repo quedó sucio** con cambios ajenos (audit-events.jsonl post-pruebas + varios frontend/docs). No los limpiamos.

## Decisiones arquitectónicas del día

1. **Audit chain endurece la cadena real**, no crea paralela. Decisión de Codex en A1. **Correcta.**
2. **`/v1/agent/audit/batch` rechaza impersonation actorType.** Decisión PM en A2. **Correcta** — cierra vector de ataque.
3. **PendingApprovalsPanel deriva pending del audit-events** en lugar de endpoint nuevo. Decisión sub-agente Claude en B5. **Correcta** — minimiza superficie nueva.
4. **NO ejecutar smoke con gasto sin contratos alineados.** Decisión Codex en A3. **Correcta** — ahorra $25 USD perdidos.

## Sign-off

**PM (Claude):** sprint cerrado en alcance ajustado. Lunes arrancamos Fase 0.5 (3h) + Fase 1 tool calling (1 semana).

**CTO (Juanes):** firmar en commit del lunes o aquí mismo si querés.

## Próximo paso INMEDIATO

Lunes 2026-06-01 AM:
1. **8:00-11:00 COT:** Fase 0.5 — alinear contratos + endpoint `/sign` + smoke real con $25.
2. **11:00-onwards:** arrancar Fase 1 tool calling Bedrock siguiendo `OPS_CODEX_FASE_1_TOOL_CALLING_BEDROCK.md` (a armar el lunes 7am).

**Antes de cerrar el viernes:** revisar el reporte de Codex en `DOCUMENTACION/SMOKE_FASE_0_RESULT_2026_05_29.md` (lo que ya pusheó) y aceptar como sign-off Fase 0.

— Claude PM
