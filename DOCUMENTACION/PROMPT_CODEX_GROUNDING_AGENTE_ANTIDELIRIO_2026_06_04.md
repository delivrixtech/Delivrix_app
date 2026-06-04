# Codex — Anti-delirio del agente: conectar grounding al contexto + guard de entidades

> Rama: partí de `codex/poc-grounded-allowlist-guard` (commit `fef4cb1`, tiene todo). Trabajá en rama hija `codex/poc-grounded-agent-context`. **NADA de push, merge a main/produ/audit.**
> Orquestación OBLIGATORIA: **AI Engineer Senior + Backend Senior + QA Senior + Auditor de Errores** (actualiza `POC_GROUNDED_DEFECT_LEDGER.md`, run real, bloquea regresión). Reportá plan de subagentes antes de tocar código.

## Problema (visto EN VIVO, causa raíz verificada)
Preguntado por "¿tenemos un SMTP configurado?", el agente respondió con `"domain": "37.842Z"` — que **no es un dominio**, es un fragmento del timestamp `2026-06-04T12:26:37.842Z`. El agente **fabricó la entidad desde el ruido de su contexto** porque:
- `fetchLiveContext` (`apps/gateway-api/src/openclaw-bedrock-bridge.ts:595-655`) inyecta hoy **solo**: `/v1/admin/overview`, `/v1/kill-switch`, `/v1/canvas/live/state`, `/v1/audit-events?limit=10`. **NO inyecta el inventario real (dominios/servidores) ni los hechos verificados** del subsistema de memoria grounded que ya construimos.
- Sin datos reales en contexto, el modelo rellena con lo que ve (el canvas, que traía el timestamp). Es exactamente el "delira" que el grounding debe matar — pero el grounding nunca se cableó al agente.

## Fix (3 partes, en orden de impacto)

### PARTE A — Cablear contexto grounded al agente (el fix de raíz)  ·  AI Engineer + Backend Senior
En `fetchLiveContext` (`openclaw-bedrock-bridge.ts:595`), **además** de lo actual, inyectar:
1. **Inventario real (entidades canónicas):** un snapshot conciso de **dominios** y **servidores** reales desde el inventario (`packages/domain/src/infrastructure-inventory.ts`, `apps/gateway-api/src/routes/webdock-servers.ts`, el inventario de dominios). El agente debe VER los dominios/servidores que existen, para no inventarlos.
2. **Hechos verificados (memoria grounded):** llamar `retrieveGroundedDecisionMemory` (de `packages/storage/src/episodic-scratch.ts`) y, si hay hechos verificados relevantes, inyectarlos como un bloque `## verified_facts` (datos estructurados, no prosa). Si abstiene, inyectar explícitamente "sin hechos verificados relevantes" — **no** rellenar.
3. Mantener el presupuesto de contexto (cap, no reventar la ventana). Etiquetar las fuentes claramente (`## inventory_domains`, `## inventory_servers`, `## verified_facts`).

*Por qué:* esto le da al agente las entidades reales y los hechos verificados, así deja de raspar el canvas. **Es la conexión que faltaba entre la memoria grounded y el agente.**

### PARTE B — Guard server-side de entidades (la red de seguridad)  ·  Backend Senior
Cuando una skill/acción real usa `domain`/`serverSlug`/`ip` (provision-smtp, register_domain, dns upsert, bind, warmup…), el gateway debe **resolver y validar** la entidad **antes** de aceptarla:
- `domain`: validar formato estricto de dominio (rechazar fragmentos como `37.842Z`, timestamps, basura) **y**, para acciones reales, que exista/resuelva contra inventario o input explícito del operador.
- `serverSlug`/`ip`: resolver contra `inventory/webdock-servers` (ya existe `findServerIp` en `smtp-provisioning.ts:137` — generalizar el patrón).
- Si no resuelve → **bloqueo auditado** `entity_not_resolved` (evento en la cadena, visible en Canvas), nunca ejecutar. El agente recibe ese bloqueo como señal clara ("no tengo un X verificado").

*Por qué:* hace **inofensivo** el delirio sin importar qué build del agente hable — un `domain` alucinado se bloquea en el gateway.

### PARTE C — Comportamiento del agente (system prompt) + nota de deploy  ·  AI Engineer
- Regla en el system context: **resolver entidades con read-tools/inventario antes de proponer; si no hay una entidad verificada, ABSTENERSE y preguntar al operador — NUNCA fabricar** un `domain`/`serverSlug` desde el contexto.
- Actualizar el bloque correspondiente y regenerar vía `scripts/openclaw/build-system-context.sh`.
- **Nota de deploy (fuera del código):** el OpenClaw que corre en Hostinger es el build viejo y el bridge remoto está degradado. Las Partes A y B toman efecto al correr el gateway nuevo; la Parte C requiere **redesplegar el system context al agente** y **reparar el bridge** (ver `delivrix_hostinger_bridge_pendiente`). Dejá esto documentado como gate de operador.

## Tests (node:test, run real)
- **Parte A:** test que `fetchLiveContext` incluye `inventory_domains`/`inventory_servers`/`verified_facts` con datos reales (fake de inventario), y que abstiene explícitamente cuando no hay hechos.
- **Parte B:** test que un `domain` inválido/timestamp (`37.842Z`) es **rechazado** con `entity_not_resolved`; que un serverSlug inexistente se bloquea; que entidades reales pasan.
- Sin regresión: I3-I7/B1/HMAC intactos.

## Hecho cuando
Parte A + B con tests verdes (run real), Parte C + deploy documentados, Defect Ledger actualizado, sin regresión. Reportá SHA y conteo real. El objetivo medible: **el agente ya no puede fabricar un `domain` desde el contexto, y un dominio alucinado se bloquea en el gateway.**
