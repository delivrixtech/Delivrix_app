# Brief — OpenClaw gestiona el ciclo de vida de sus SMTPs (no solo los crea)

> Para desarrollo backend. Fecha: 2026-06-30. Prioridad: alta (Track O — confiabilidad del agente).
> Norte del CTO: "el agente que crea los SMTPs debe poder cambiarlos, modificarlos, actualizarlos, reorganizar y limpiar su propio inventario — sin que cada lío de estado escale al operador o a desarrollo."

## 0. Contexto y el incidente que lo motiva

OpenClaw hoy **crea** SMTPs (`configure_complete_smtp`, 14 pasos) pero **no puede gestionarlos**: no sabe deduplicar, reasignar, retirar ni sanear su propio inventario. Cada inconsistencia de estado se convierte en una escalada al operador. Esto rompe la autonomía del agente y carga al CTO.

**Incidente del 2026-06-30 (caso real):** OpenClaw reportó `ambiguous_domain` en `enable_smtp_auth` para 4 dominios y **diagnosticó mal la causa** — culpó a "4 runs con `lastCompletedStep:14` + `status:failed`" y pidió al operador marcarlos como `completed`. Pero el resolvedor `listSmtpSaslRetrofitCandidates` (`apps/gateway-api/src/routes/smtp-sasl-retrofit.ts:252-261`) **nunca lee los SmtpRunState**: solo lee `inventory/smtp-provisioning.json`, filtra `status==="configured"` + `domain`, y si hay `>1` candidato lanza HTTP 409 `ambiguous_domain` (ver test `enable-smtp-auth.test.ts:290-321`).

**Causa raíz real:** el inventario tenía **2 entradas `configured` por dominio** (server60+server92, server68+server94, server69+server93, server84+server96) porque reintentos de `configure_complete_smtp` con slug nuevo dejaron la entrada vieja sin retirar. Se saneó a mano (se eliminaron las 4 espurias). Pero esto **no debe requerir intervención manual** la próxima vez.

## 1. Bug a corregir (la causa de la duplicación)

`configure_complete_smtp` / el paso que persiste el inventario (`apps/gateway-api/src/routes/orchestrator-smtp.ts`, persistencia de `smtp-provisioning.json`) **deja entradas duplicadas por dominio** cuando un run se reintenta con un `serverSlug` distinto: la entrada vieja (mismo `domain`, otro `serverSlug`) queda `configured` y nunca se retira.

**Fix:** al registrar/actualizar un server `configured` para un dominio, **retirar o reemplazar** las entradas previas del MISMO `domain` con distinto `serverSlug` (marcarlas `superseded`/`retired`, o reemplazarlas). Invariante a garantizar: **a lo sumo 1 entrada `configured` por `domain`** en `smtp-provisioning.json`.

## 2. Capacidad nueva: tools de gestión de inventario para OpenClaw

Dar a OpenClaw herramientas para **operar su inventario SMTP**, todas **gobernadas** (1 firma del operador + audit chain + kill-switch + matriz de permisos, igual que las mutaciones existentes). Registrar en `apps/gateway-api/src/openclaw-tools-builder.ts`:

1. **`inspect_smtp_inventory`** (read-only) — lista el inventario por dominio/server con su `status`, detecta duplicados/ambigüedad, cruza con el power state (running/stopped) y con la salud de la cuenta. Es la fuente correcta que OpenClaw debe mirar (hoy mira el lifecycle/los runs, que no son la causa).
2. **`resolve_ambiguous_domain`** — ante `>1` server `configured` por dominio: elegir el canónico (el que existe en la flota viva + tiene run completed) y **retirar** los demás. Debe verificar contra el inventario real de la cuenta (no adivinar). Esto es lo que se hizo a mano hoy.
3. **`reassign_domain_server`** — mover un dominio de un server a otro (actualiza la entrada del inventario + dispara re-config si aplica).
4. **`retire_smtp_entry`** — marcar una entrada como `retired`/`archived` (deja de ser candidata en el resolvedor) sin perder el registro histórico.
5. **`update_smtp_entry`** — actualizar campos de una entrada (selector, status, tlsStatus) de forma auditada.

## 3. Desambiguación en `enable_smtp_auth` (defensa en profundidad)

Hoy `enable_smtp_auth` solo acepta `domain` (`skill-schemas.ts`, required `["domain"]`) y falla con 409 si hay ambigüedad. El filtro ya soporta `serverSlug` (`smtp-sasl-retrofit.ts:261`). **Exponer `serverSlug` opcional en el schema** de `enable_smtp_auth`: cuando hay ambigüedad, OpenClaw puede pasar el slug canónico explícito (resuelto vía `resolve_ambiguous_domain`) en vez de fallar a ciegas. El comportamiento por defecto (rechazar ambigüedad sin slug) se conserva — es correcto y seguro.

## 4. Guardrails (no negociable)

- Toda mutación de inventario = 1 firma del operador + audit chain SHA-256 + broadcast + kill-switch (como las demás acciones).
- `resolve_ambiguous_domain` y `retire_smtp_entry` **verifican contra la fuente real** (inventario de la cuenta / power state) antes de actuar — nunca adivinan cuál server retirar.
- Idempotencia + dry-run disponible para revisar el plan antes de firmar.

## 5. Archivos clave
- `apps/gateway-api/src/routes/smtp-sasl-retrofit.ts:252-291` (resolvedor `listSmtpSaslRetrofitCandidates`)
- `apps/gateway-api/src/routes/enable-smtp-auth.ts:46,79` (handler + 409 ambiguous_domain)
- `apps/gateway-api/src/routes/orchestrator-smtp.ts` (persistencia del inventario — el bug de duplicados)
- `apps/gateway-api/src/openclaw-tools-builder.ts` (registrar las tools nuevas)
- `…/skill-schemas.ts` (schema enable_smtp_auth + serverSlug opcional)
- inventario: `runtime/openclaw-workspace/inventory/smtp-provisioning.json`

## 6. DoD
- `configure_complete_smtp` nunca deja `>1` entrada `configured` por dominio (test).
- Ante un `ambiguous_domain`, OpenClaw lo **resuelve solo** (deduplica/desambigua con firma), sin escalar al operador.
- OpenClaw puede inspeccionar, reasignar, retirar y actualizar entradas de su inventario SMTP, todo auditado.
- El resolvedor sigue rechazando ambigüedad cuando no se le da slug (sin regresión).

---

## 7. Plan de implementación (orden + código estratégico)

> Empezar por P1 (corta la causa de raíz) y P2 (autonomía del agente). Todo en TypeScript, `node --test`, sin romper el comportamiento single-candidate.

### P1 — Fix del bug de duplicados (la causa). `orchestrator-smtp.ts` (persistencia del inventario)
Antes de marcar un server `configured` para un dominio, **retirar** las entradas previas del MISMO `domain` con distinto `serverSlug`:

```ts
// donde se hace upsert de la entrada en smtp-provisioning.json tras el bind/provision
function upsertConfiguredServer(inv: SmtpProvisioningInventory, entry: SmtpProvisioningServer): void {
  for (const s of inv.servers) {
    if (s.domain === entry.domain && s.serverSlug !== entry.serverSlug && s.status === "configured") {
      s.status = "superseded";          // deja de ser candidato del resolvedor
      s.supersededBy = entry.serverSlug;
      s.supersededAt = new Date().toISOString();
    }
  }
  const i = inv.servers.findIndex(s => s.serverSlug === entry.serverSlug && s.domain === entry.domain);
  if (i >= 0) inv.servers[i] = { ...inv.servers[i], ...entry, status: "configured" };
  else inv.servers.push({ ...entry, status: "configured" });
}
```
**Invariante (test nuevo):** tras dos runs del mismo dominio con slug distinto, `servers.filter(s => s.domain===D && s.status==="configured").length === 1`. El `listSmtpSaslRetrofitCandidates` ya filtra `status==="configured"`, así que `superseded` sale solo de candidatos sin tocar el resolvedor.

### P2 — Tools de gestión para OpenClaw. Registrar en `openclaw-tools-builder.ts`, despachar en `skill-dispatcher.ts`, schema en `skill-schemas.ts`
Firmas mínimas (cada mutación gobernada: 1 firma + audit chain + kill-switch + dry-run):

```ts
// READ-ONLY — la fuente CORRECTA que OpenClaw debe mirar (hoy mira lifecycle/runs, que no son la causa)
inspect_smtp_inventory(input: { domain?: string }):
  // devuelve por dominio: [{ serverSlug, status, ip, hasCredential, powerState }], y flag `ambiguous: boolean`
  // cruza smtp-provisioning.json + smtp-credentials.json + listServers() (power running/stopped)

// DESAMBIGUAR (lo que se hizo a mano hoy)
resolve_ambiguous_domain(input: { domain: string, keepServerSlug?: string }):
  // si keepServerSlug ausente -> elige canónico = configured ∩ existe-en-flota-viva ∩ (run completed | único vivo)
  // marca los demás del dominio status="superseded"; FIRMADO + audit "oc.smtp_inventory.resolved"

retire_smtp_entry(input: { serverSlug: string, domain: string }):     // status="retired"; FIRMADO
reassign_domain_server(input: { domain: string, fromSlug: string, toSlug: string }): // FIRMADO
```
Y en `enable_smtp_auth`: añadir `serverSlug?: string` OPCIONAL al schema (el filtro `smtp-sasl-retrofit.ts:261` ya lo soporta) para que OpenClaw desambigüe pasando el canónico, en vez de fallar con 409.

### P0 — Desbloqueo de hoy (ya aplicado a mano, NO recodificar)
Las 4 entradas espurias (server92/93/94/96) ya se eliminaron de `runtime/openclaw-workspace/inventory/smtp-provisioning.json` (local). Esto desbloquea el `ambiguous_domain` actual sin esperar P1/P2. **Pendiente operativo (no de Codex):** encender server60/68/69/84 (stopped) y que OpenClaw re-invoque `enable_smtp_auth`.

### Matriz de permisos
`resolve_ambiguous_domain`/`retire_smtp_entry`/`reassign_domain_server` = categoría `supervised_local_state` (firma humana + kill-switch off). `inspect_smtp_inventory` = `allowed_read_only`.

---

## 8. Deploy — NO olvidar (regla deploy sync local + Hostinger)
1. **Tests verdes:** `node --test` (suite completa) + los nuevos (invariante P1, tools P2).
2. **commit + push** a la rama; **merge a `produ`**.
3. **Sincronizar a Hostinger:** desplegar el gateway + correr `scripts/openclaw/build-system-context.sh` para que el system prompt de OpenClaw incluya las tools nuevas (si no, el agente no las "ve").
4. **Reiniciar el gateway** (local y, si aplica, el container).
5. **OJO — inventario en 2 lugares:** `smtp-provisioning.json` vive en local (`runtime/openclaw-workspace/inventory/`) Y en Hostinger (`/data/.openclaw/workspace/inventory/`, ver `openclaw-workspace.ts:45-47`). La dedup de hoy fue en **local**. Verificar/deduplicar también el de Hostinger si el OpenClaw productivo lee de ahí — o que P1 lo sanee al siguiente run.

**Track:** O (OpenClaw confiable). Prioridad: alta — esto es lo que convierte a OpenClaw en un operador senior que sanea su propio inventario sin escalar al CTO.
