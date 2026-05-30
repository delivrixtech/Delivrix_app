# Bitácora — Cambio de norte: 1 firma operador + audit chain SHA-256

**Fecha:** 2026-05-29 viernes ~12:30 COT (post-demo Hostinger).
**Tipo:** Decisión arquitectónica de norte operativo.
**Status:** Aplicada en main. SHA `91d020b`.
**Reversibilidad:** Media — reversa requeriría re-arquitectura del flow de aprobaciones + reactivar UI/backend del 2° firmante (~2 días de trabajo).

---

## Contexto

Antes del demo del 2026-05-29 a Hostinger, el norte operativo de Delivrix incluía una "regla de 2 personas": para cualquier acción crítica (registro de dominio, mutación DNS, provisioning SMTP, warmup ramp), un operador proponía via UI/audit y un segundo operador con rol elevado firmaba la ejecución. La regla estaba codificada en:

- `findRecentApproval` de 7 handlers (busca `oc.artifact.approved` con `executionId` reciente).
- `OPENCLAW_PERMISSIONS_MATRIX.md` categoría `supervised_local_state` requería `requiredApprovals: 2`.
- UI de panel mostraba "Regla de 2 personas" en sidebar + Clusters + Safety.
- Tests de gateway-api asumían 2 audit events distintos antes de ejecución (submit → approve).

Durante la demo, el norte funcionó: los 3 dry-runs encadenados (Postfix + DNS + register_sender_node) mostraban claramente la cadena propuesta → aprobada → ejecutable. CTO Hostinger validó el diseño.

**Trigger del cambio:** ~12:00 COT, post-demo, Juanes (CTO Delivrix) escribe:

> *"no creo que necesitaremos dos humanos para firmar, eso suena burocracia. Necesitamos que OpenClaw lo pueda hacer por sí solo con permisos, botones de autorización y consulta y ya está. Buscamos autonomía 100% que lo pueda ejecutar en la configuración inicial de un dominio, hasta configuración de un VPS, hasta que se convierta en un SMTP y se caliente las bandejas. Y todo ese proceso lo necesita ver mi jefe. Buscamos multiagentes haciéndolo en tiempo real, trabajando fuertemente e inteligentemente."*

El requerimiento es claro: **autonomía 100% con 1 firma de operador, visible en tiempo real, sin burocracia de 2°firmante**.

---

## Opciones consideradas

### Opción A — Mantener regla de 2 personas

**Pros:**
- Doble validación humana = menor riesgo de error operacional o impersonation.
- Modelo conocido (financial, healthcare, infra crítica).
- Auditoría externa más fácil de justificar.

**Contras:**
- **Bloquea autonomía 100%.** Si OpenClaw E2E necesita firmar él mismo paso 1 y paso 2, eso requiere 2 agentes distintos (no es realista en el corto plazo).
- Burocracia para operación de empresa chica. Juanes opera Delivrix con equipo de 1-3 personas, NO con 2 SREs disponibles 24/7.
- Ralentiza demo final con CTO Hostinger: "mi jefe ve a 5 agentes" requiere flow continuo, no pausas para 2° firma.
- En el modelo norte 2026-05-29, el 2° firmante no aportaba valor real — solo confirmaba lo que el primero ya había aprobado en UI.

### Opción B — Quitar firma humana completamente (autonomía pura)

**Pros:**
- Máxima velocidad. Agente decide y ejecuta.
- Alineado con visión "5 agentes trabajando fuertemente".

**Contras:**
- **Inaceptable para acciones con costo o irreversibles.** Comprar dominio ($15-30), provisionar VPS ($5-20/mes), enviar email warmup (riesgo reputacional) — todo necesita gate humano.
- Imposible justificar a CTO Hostinger / stakeholders externos.
- Imposible de auditar legalmente (ningún humano firma).
- Una alucinación del agente = daño operacional sin checkpoint.

### Opción C — 1 firma operador + compensaciones de seguridad robustas (ELEGIDA)

**Pros:**
- Mantiene checkpoint humano en cada acción crítica (no se pierde el gate).
- Elimina burocracia 2° firmante.
- Compensaciones técnicas reemplazan el rol de seguridad del 2° firmante:
  1. **Audit chain SHA-256 append-only.** Cada evento linked a prevHash. Inmutable.
  2. **Anchor HMAC firmado.** Snapshot del head + cold storage externo (Slack/email/S3).
  3. **Webhook broadcast.** Cada acción crítica notificada en tiempo real a equipo (Slack/Discord). 2° par de ojos asíncrono.
  4. **Auto-rollback DNS/SMTP.** Snapshot pre-mutation + restore automático si falla health check.
  5. **Fail-closed flags.** DOMAIN_BIND_ENABLE / EMAIL_AUTH_ENABLE_WRITES / WARMUP_RAMP_ENABLE deben estar explícitamente `1` para que handler ejecute.
  6. **Kill switch global.** Cualquier acción crítica bloqueada con HTTP 423 cuando armed.
  7. **Replay protection.** Approval token con nonce + expiración 5min + replay-detection vía SQLite.
  8. **Skills destructivas siguen bloqueadas.** delete_domain, wipe_server, mass_dns_change → categoría `future_live_requires_new_phase` (no se pueden invocar todavía).

- Habilita autonomía 100% para el roadmap de 7 semanas a demo final Hostinger.
- Compatible con tool calling Bedrock (Fase 1) sin cambios al modelo de seguridad.

**Contras:**
- Requiere implementación de las 8 compensaciones (5 nuevas, 3 ya existentes).
- Auditoría externa tendrá que entender chain SHA-256 + anchor como "proof" en lugar de "2° firma".
- Si el operador único es comprometido (cuenta robada), no hay 2° gate humano. **Mitigación:** auth panel con MFA obligatorio + anchor diario externo.

### Opción D — 1 firma operador SIN compensaciones extras

**Pros:**
- Más rápido de implementar.

**Contras:**
- **Inaceptable.** Quita todo el peso de seguridad del modelo. Equivale a Opción B con UI extra.

---

## Decisión

**Adoptada Opción C.**

Cambio de norte aplicado en commit SHA `91d020b`:

### Cambios concretos

1. `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`:
   - Sección "Fase supervised": regla 2 personas → 1 firma + audit chain SHA-256 + broadcast.
   - Sección "Fase autónoma habilitada": nueva, define auto-rollback como segunda red.
   - Decálogo punto 6: "Un humano (UN operador, no dos) firma toda mutación crítica".
   - Nueva sección "8 compensaciones de seguridad" reemplazando 2° firma.

2. `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md`:
   - 9 skills reclasificadas de `future_live_requires_new_phase` → `supervised_local_state`:
     - register_domain_route53, register_domain_porkbun
     - upsert_dns_route53, upsert_dns_ionos
     - create_webdock_server, provision_smtp_postfix
     - configure_email_auth, bind_domain_to_server, seed_warmup_pool
   - Skills destructivas (delete_*, wipe_*, mass_*) NO se movieron.
   - `requiredApprovals: 2` → `requiredApprovals: 1` para `supervised_local_state`.

3. `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md`:
   - Nuevo bloque [11] LISTA CANÓNICA DE PROVEEDORES (anti-hallucination, evita que OpenClaw proponga Cloudflare/DigitalOcean/Vultr cuando solo trabajamos con Webdock + AWS Route53/Bedrock + IONOS + Porkbun + servidor físico Medellín + Gmail IMAP).

4. `scripts/openclaw/build-system-context.sh`:
   - AGENTS.md bootstrap actualizado con lista canónica.

5. Backend (Sprint Fase 0 SHAs cb93e2c + 13d9357 + ca76c8a):
   - `audit-chain.ts` con SHA-256 prevHash + verifier endpoint.
   - `auto-rollback.ts` con DNS/SMTP/Webdock policies.
   - `audit-batch-origin.ts` con anti-impersonation.
   - 4 fail-closed flags wireados en handlers.
   - Anchor HMAC endpoint.
   - Webhook broadcast con redact secrets.

6. Frontend (sub-agentes B1+B3+B5):
   - ApprovalGate.tsx con timer 5s + 1 firma + 3 gates + Three Dials.
   - PendingApprovalsPanel deriva propuestas de audit-events (no requiere endpoint nuevo).
   - Sticky-bottom en Canvas Live.

7. UI text (Fase 0.5 bugs #1+#3):
   - "Regla de 2 personas" → "1 firma operador · audit SHA-256" en Shell + Clusters (3 puntos UI).
   - Vite proxy: regex whitelist para `/v1/openclaw/proposals/{id}/{sign,reject}`.

---

## Razón

1. **Velocidad operativa.** Equipo chico (1-3 personas) no puede tener 2 SREs disponibles 24/7 para firmar cada acción.
2. **Autonomía 100% es el norte requerido.** Demo final Hostinger requiere 5 agentes E2E sin interrumpir flow.
3. **Las 8 compensaciones son MÁS robustas que un 2° firmante.** Un humano con prisa firma sin leer. Un audit chain SHA-256 + anchor HMAC externo no se puede "saltear".
4. **Costo de oportunidad.** Cada hora gastada en mantener 2° firma es una hora menos en tool calling Bedrock + multi-agente.
5. **Compatible con tool calling Bedrock (Fase 1).** El modelo de aprobación 1 firma encaja directo con `tool_use` blocks de Bedrock. El de 2 firmas habría requerido orquestación adicional.

---

## Reversibilidad

**Reversa parcial (1 humano puede firmar todo):** trivial, ya implementada (este cambio).

**Reversa total (volver a 2 personas):** ~2 días de trabajo:
1. `OPENCLAW_PERMISSIONS_MATRIX.md` → `requiredApprovals: 2` para `supervised_local_state`.
2. `findRecentApproval` requiere 2 events `oc.artifact.approved` distintos (diferentes `actorId`) en ventana de 15min.
3. UI: ApprovalGate.tsx muestra 2 slots de firma, "esperando 2° firmante".
4. PendingApprovalsPanel: filtra propuestas con 1 firma como "pending 2nd".
5. Tests gateway-api: 7 handlers + 2 nuevas suites de "single-signature rejection".
6. Migración audit-events viejos: backfill `requiredApprovals=2` para queries históricas.

**Trigger plausible de reversa:**
- Incidente de seguridad con operador único comprometido (cuenta robada, deepfake voice attack).
- Auditoría externa rechaza chain SHA-256 + anchor como prueba equivalente.
- Cliente enterprise (no Hostinger) exige 2-person rule por compliance.

---

## Riesgos remanentes

1. **Operador único comprometido.** Si la cuenta del operador (Juanes) se compromete (cuenta robada, sesión secuestrada en panel), el atacante puede firmar acciones.
   **Mitigación:**
   - MFA obligatorio en panel (pendiente — alta prioridad post-Fase 1).
   - Anchor diario pinned externamente (Slack/email) para que un humano externo vea si la cadena diverge.
   - Webhook broadcast en tiempo real al equipo.
   - Auto-rollback DNS si health check falla post-mutation.

2. **Audit chain corrupta no detectada.** Si el verifier no se ejecuta diariamente, una corrupción podría pasar desapercibida.
   **Mitigación:** scheduled task ejecuta `/v1/audit-chain/verify` cada 6h + emite webhook si `ok:false`.

3. **Anchor HMAC se pierde si no se guarda externamente.** El backend genera la firma pero alguien tiene que guardarla en Slack/email/S3.
   **Mitigación:** Fase 4 automatiza daily anchor pin a Slack #delivrix-audit (pendiente).

4. **Auto-rollback no cubre todos los handlers todavía.** Webdock create_server no se reverte automáticamente (requiere DELETE API + delete propio + audit del delete).
   **Mitigación:** kill switch + manual cleanup. Aceptable porque crear server es idempotente con `clientToken`.

5. **Compensación legal.** Si Delivrix tiene clientes EU/US con compliance estricto, el modelo "1 firma + audit chain" puede no ser suficiente para ciertas auditorías.
   **Mitigación:** documentar formalmente el modelo + tener Opción C reverse-plan listo.

---

## Métricas de éxito (revisar a 30 días)

- [ ] 0 incidentes de seguridad atribuibles a falta de 2° firma.
- [ ] ≥ 95% de smoke E2E completados sin intervención humana (excepto 1 firma inicial).
- [ ] Anchor HMAC pinned diariamente sin gaps.
- [ ] Audit chain verify ok=true en cada check (cada 6h).
- [ ] Demo final Hostinger ejecutado con CTO viendo 5 agentes E2E.

---

## Stakeholders y firmas

- **Decisión:** Juanes (CTO Delivrix).
- **Documentación:** Claude (PM).
- **Implementación backend:** Codex.
- **Implementación frontend:** Claude (sub-agentes B1+B3+B5).
- **Sign-off pendiente:** Hostinger (validación post demo final Fase 5).

---

## Referencias

- `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md` — norte vigente.
- `DOCUMENTACION/CAMBIO_NORTE_QUITAR_2_PERSONAS_2026_05_29.md` — diff completo y plan migración.
- `DOCUMENTACION/ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md` — 5 fases / 7 semanas.
- `DOCUMENTACION/ARQUITECTURA_MULTI_AGENT_RUNTIME_2026_05_29.md` — diseño técnico.
- `DOCUMENTACION/SPRINT_FASE_0_RESULT_2026_05_29.md` — sprint que implementó las compensaciones.
- `DOCUMENTACION/AUDIT_PM_POST_DEMO_VIERNES_2026_05_29.md` — auditoría PM día completo.

— Claude PM
