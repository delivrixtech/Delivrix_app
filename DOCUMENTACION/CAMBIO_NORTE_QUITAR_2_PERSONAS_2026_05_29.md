# Cambio de Norte Operativo — Quitar regla de 2 personas

**Para:** Codex, Juanes, futuros operadores.
**De:** Claude (PM).
**Fecha:** 2026-05-29 viernes post-demo.
**Status:** **DECISIÓN APROBADA POR CTO**, requiere commit explícito en `NORTE_OPERATIVO_DELIVRIX.md` para activar.
**Bloquea:** roadmap autonomía 100%, tool calling, multi-agente, ejecución real de SMTP/DNS.

## Por qué cambia el norte

El demo del 2026-05-29 mostró tres dry-runs encadenados perfectos pero **NO mostró ejecución real** porque las skills críticas están en `future_live_requires_new_phase` esperando "regla de 2 personas + hito posterior". El CTO Juanes lo dijo textual post-demo:

> "no creo que necesitaremos dos humanos para firmar, eso suena burocracia. Necesitamos que OpenClaw lo pueda hacer por sí solo con permisos, botones de autorización y consulta y ya está."

Norte real: **autonomía 100% E2E (compra dominio → DNS → VPS → SMTP → warmup), con 1 firma del operador y audit chain robusta como compensación.**

## Diff del norte

### Sección "Acciones supervisadas" (líneas 50-51 del actual)

**Antes:**
```
- Fase supervised: proponer acciones y esperar aprobacion humana.
- Fase limitada: ejecutar solo acciones reversibles, acotadas y auditadas
  despues de runbook, permisos, aprobacion humana y kill switch probado.
```

**Después:**
```
- Fase supervised: proponer acciones, recibir UNA firma del operador
  via panel, ejecutar con audit chain y broadcast a webhook del equipo.
- Fase autónoma habilitada: ejecutar acciones reversibles, acotadas y
  auditadas con UNA firma del operador + auto-rollback si bounce > 5%
  en los primeros N minutos + alerta inmediata al equipo via webhook.
```

### Sección "Decálogo operativo" punto 6 (línea 63)

**Antes:**
```
6. Un humano aprueba cualquier accion real.
```

**Después:**
```
6. Un humano (UN operador, no dos) firma cualquier accion real via
   panel. La firma queda en audit chain con SHA-256 link al evento
   anterior. El equipo recibe broadcast inmediato (webhook Slack/Discord)
   en cada accion critical.
```

### Sección "Reglas duras" (líneas 111-113)

**Antes:**
```
- No hay escritura en sistemas externos de produccion sin contrato aprobado.
- No hay SSH real sin aprobacion humana.
- No hay cambios DNS reales sin dry-run y aprobacion.
```

**Después:**
```
- No hay escritura en sistemas externos de produccion sin contrato
  aprobado.
- No hay SSH real sin UNA firma del operador + audit chain SHA-256.
- No hay cambios DNS reales sin dry-run + UNA firma del operador +
  rollback automático preparado en caso de fallo de propagación.
- TODA accion critica emite broadcast inmediato a webhook del equipo,
  con: actor agente + actor humano firmante + categoria matrix +
  audit ID + diff (dry-run completo).
```

### Sección nueva — Compensaciones de seguridad

Agregar después de la sección "Reglas duras":

```
## Compensaciones de seguridad (reemplazan la 2da firma)

Al pasar de "2 personas firman" a "1 firma + audit chain", agregamos
estas barandillas para mantener el mismo nivel de seguridad operativa:

1. AUDIT CHAIN SHA-256 LINKED — cada evento incluye prevHash. Una
   alteracion del log se detecta inmediato.

2. BROADCAST INMEDIATO AL EQUIPO — webhook a Slack/Discord en cada
   accion critical. Mensaje incluye: que skill, que dominio, que
   servidor, audit ID, link al dry-run, link al evento ejecutado.
   Si la accion fue ilegitima, el equipo se entera en <30 segundos.

3. AUTO-ROLLBACK AUTOMATICO — para mutaciones reversibles:
   - DNS: si propagacion no se confirma en 5 min, rollback automatico
     a estado anterior.
   - SMTP send: si bounce rate > 5% en primeros N envios, auto-pause
     + alerta humana.
   - Webdock VPS create: si cloud-init no termina en 15 min, snapshot
     + reportar a equipo (no destruir).

4. KILL SWITCH SIGUE — sigue siendo el ultimo gate. Cuando enabled=true,
   TODA accion no read-only se rechaza. Sin cambios.

5. CATEGORIAS MATRIX RESPETADAS — el agente sigue declarando
   categoria explicita antes de pedir firma. La firma del operador
   solo aplica a la categoria declarada. Si la skill resulta ser mas
   riesgosa (escalation), el sistema rechaza y pide nueva firma.

6. KEY ROTATION PROGRAMADA — credenciales SSH/AWS/IONOS rotadas
   trimestralmente. Si una se filtra, el atacante tiene <90 dias.

7. RATE LIMITS POR OPERADOR — un mismo humano no puede firmar mas de
   N acciones criticas por minuto (defensa contra cuenta tomada que
   intenta ejecutar muchas cosas rapido).

8. REVIEW PERIODICA DE AUDIT CHAIN — el equipo (humanos) revisa el
   audit chain semanalmente buscando patrones anomalos.
```

### Sección "Preguntas que debe responder" (línea 149)

Agregar al final:

```
- Quien firmó esta accion y cuando?
- El audit chain SHA-256 esta intacto desde el ultimo commit del norte?
- Que skills tiene el operador autorizadas para firmar autonomamente?
- Cuanto tiempo tardó la accion desde firma a ejecucion confirmada?
- Hubo rollback automatico? Por que?
```

## Categorías de permisos — reclasificación

Junto con el cambio de norte, **mover skills críticas de `future_live_requires_new_phase` a `supervised_local_state`** con autonomía habilitada por flag operativo.

| Skill | Categoría vieja | Categoría nueva | Flag operativo nuevo |
|---|---|---|---|
| `register_domain_route53` | future_live | supervised_local_state | `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` (ya existe) |
| `route53_dns_upsert` | future_live | supervised_local_state | `AWS_ROUTE53_DNS_ENABLE_WRITES=true` (ya existe) |
| `ionos_dns_upsert` | future_live | supervised_local_state | `IONOS_DNS_ENABLE_WRITES=true` (NUEVO) |
| `provision_webdock_vps` | future_live | supervised_local_state | `WEBDOCK_SERVERS_ENABLE_CREATE=true` (ya existe) |
| `install_smtp_stack` | future_live | supervised_local_state | `SMTP_PROVISIONING_ENABLE_SSH=true` (ya existe) |
| `start_warmup_seed` | future_live | supervised_local_state | `WARMUP_ENABLE_SEND=true` (ya existe) |
| `start_warmup_ramp` | future_live | supervised_local_state | `WARMUP_RAMP_ENABLE=true` (NUEVO) |
| `bind_domain_to_server` | future_live | supervised_local_state | `DOMAIN_BIND_ENABLE=true` (NUEVO) |
| `configure_email_auth` | future_live | supervised_local_state | `EMAIL_AUTH_ENABLE_WRITES=true` (NUEVO) |

**Skills que SIGUEN bloqueadas en `future_live_requires_new_phase`** (no se activan con 1 firma):

| Skill | Razón |
|---|---|
| `nfc_production_writes` | Producto distinto (NFC bridge), no email |
| `delete_domain_route53` | Destructivo irreversible. Sigue requiriendo proceso especial. |
| `wipe_server` | Destructivo irreversible. |
| `mass_dns_change` (>10 dominios simultáneos) | Riesgo sistémico. |

**Skills que SE PROHIBEN explícitamente** (no se activan jamás):

| Skill | Razón |
|---|---|
| `auto_promote_model` | El agente nunca se auto-promociona. |
| `modify_audit_log` | Audit chain es append-only inviolable. |
| `bypass_kill_switch` | El kill switch no tiene bypass. |
| `silently_send_email` | Todo envío firma + audit + broadcast. |

## Flujo del operador con 1 firma (UX)

Comparación lado a lado:

### Antes (regla de 2 personas)

```
Operador A → panel → "Aprobar dry-run" → estado "esperando 2da firma"
Operador B → panel → recibe notificación → ve dry-run completo →
                     "Confirmar firma" → estado "aprobado"
Sistema → ejecuta skill → audit chain firmada por [A, B]
Tiempo total: variable (depende de Operador B disponible)
```

### Después (1 firma + audit chain)

```
Operador → panel → ve dry-run completo del agente con audit ID +
                   categoria matrix + gates pendientes →
                   "Firmar y ejecutar" → 1 click
Sistema → ejecuta skill → audit chain firmada por operador único
       → broadcast inmediato webhook equipo (Slack/Discord) con todo
         el contexto
       → auto-rollback armado (si DNS o SMTP)
Tiempo total: <5 segundos desde firma a ejecución
```

## Implementación técnica del cambio

### Backend

**Archivos a tocar:**

1. `apps/gateway-api/src/audit-chain.ts` (crear si no existe) — implementar SHA-256 chain con `prevHash` por evento.
2. `apps/gateway-api/src/webhook-broadcast.ts` (crear) — pushear cada acción `supervised_local_state` o más crítica a webhook configurado por env `EQUIPO_WEBHOOK_URL`.
3. `apps/gateway-api/src/auto-rollback.ts` (crear) — handlers para DNS, SMTP, Webdock que disparan rollback automático según criterio.
4. `apps/gateway-api/src/routes/*.ts` — quitar checks de "2 firmas", agregar checks de "1 firma + audit chain SHA-256 íntegro".

**Tests obligatorios:**

- Audit chain SHA-256 íntegro: corromper un evento → detectar.
- Broadcast webhook: cada acción crítica emite payload completo.
- Auto-rollback DNS: simular propagación fallida → rollback automático.
- Rate limit firma: 1 operador no puede firmar más de N acciones críticas/min.

### Frontend

**Archivos a tocar:**

1. `apps/admin-panel/src/v5/components/ApprovalGate.tsx` (crear) — modal que muestra dry-run completo + categoría matrix + gates + 1 botón "Firmar y ejecutar".
2. `apps/admin-panel/src/v5/views/Canvas Live` — los artifacts de propuesta dry-run del agente se renderizan con botón "Firmar y ejecutar" en lugar de "Esperar 2da firma".
3. `apps/admin-panel/src/v5/views/Safety` — quitar referencia "Regla de 2 personas", agregar "Audit chain · Append-only · Broadcast inmediato".
4. `apps/admin-panel/src/v5/shell/Shell.tsx` — footer ya minimal, no cambia.

### Documentación

**Archivos a tocar:**

1. `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md` — aplicar diff de este doc.
2. `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` — reclasificar las 9 skills de la tabla arriba.
3. `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` — bloque [10] mantiene la disciplina del flow real; agregar bloque [11] explicando que "regla de 2 personas se reemplaza por audit chain robusta + 1 firma + auto-rollback".
4. `scripts/openclaw/build-system-context.sh` — actualizar AGENTS.md bootstrap.

## Plan de migración (sin downtime)

**Día 1 (post commit del norte):**
- Audit chain SHA-256 + webhook broadcast en backend.
- Reclasificación de skills en `OPENCLAW_PERMISSIONS_MATRIX.md`.

**Día 2:**
- Frontend `ApprovalGate.tsx` reemplaza "Esperar 2da firma".
- Tests E2E.

**Día 3:**
- Auto-rollback DNS + SMTP.
- Smoke real: compra dominio + DNS + VPS + SMTP install + warmup seed con 1 firma del operador.

**Día 4:**
- Demo interno al equipo Delivrix (CTO + colaboradores).
- Sign-off.

**Día 5:**
- Producción habilitada.

**Total: 5 días laborales (1 semana).**

## Riesgos identificados

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Operador firma sin leer | Media | Alto | Dry-run COMPLETO visible siempre + tiempo mínimo de visualización antes de habilitar botón |
| Webhook se cae | Baja | Medio | Queue local + retry con backoff. NO bloquea ejecución, solo difiere notificación. |
| Rollback DNS no funciona | Baja | Alto | Pre-snapshot de zona antes de mutación. Si falla, el snapshot se puede aplicar manualmente. |
| Audit chain se corrompe | Baja | Crítico | Backup en cold storage cada hora. Verificación de integridad nightly. |
| Cuenta operador comprometida | Baja | Crítico | Rate limit + alerta al equipo cuando hay >3 firmas críticas en <5 min |

## Checklist para Juanes antes de aprobar este cambio

- [ ] Lee este documento entero
- [ ] Lee la tabla de reclasificación de skills (sección "Categorías de permisos")
- [ ] Confirma que está de acuerdo con las 8 compensaciones de seguridad
- [ ] Confirma que el webhook a Slack/Discord del equipo será operativo
- [ ] Confirma que está OK con plan de migración de 5 días
- [ ] Commit firmado en `NORTE_OPERATIVO_DELIVRIX.md` aplicando el diff
- [ ] Comunica al equipo (si hay otros operadores) que cambia el norte

Una vez firmado el commit del norte, **destrabamos todo el roadmap de autonomía 100%**.

— Claude PM
