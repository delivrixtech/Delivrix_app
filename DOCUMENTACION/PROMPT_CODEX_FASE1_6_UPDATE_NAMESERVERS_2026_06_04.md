# Codex — FASE 1.6 (rediseñada): política unificada de resolución de zona + realineación NS

> **Por qué se rediseñó:** una auditoría adversarial encontró que el problema NO es solo "adoptar dominios" — es un **BUG de resolución de zona** que crea **zonas duplicadas** y puede morder a CUALQUIER dominio (nuevo o adoptado). El combo naive (tool de NS + reuse simple) trataba el síntoma y abría 3 modos de falla. Esto lo arregla de raíz.
> **Base:** `produ` (`f06cfe5`). Rama `codex/fase1.6-zone-policy`. Verificá `git log --oneline -1 produ` = `f06cfe5`.
> Subagentes senior + Auditor de Errores. Si choca → parar y reportar. Mantener Fase 1/1.5 intactas (aditivo).

## Causa raíz (verificada, con anclas)
- `apps/gateway-api/src/routes/domains-dns.ts:221` → `const zone = existingZone ?? await deps.adapter.createHostedZone(domain);` — **auto-crea zona si no la encuentra**.
- `existingZone` viene de `findWorkspaceZone` (`domains-dns.ts:743`) que lee **SOLO el inventario local** (`domains.json`, con `.catch(() => null)`), **nunca consulta AWS**. Mismo patrón en `domains-email-auth.ts` y `domains-bind.ts`.
- **No existe `listHostedZones`** en `packages/adapters/src/aws-route53-dns-adapter.ts` (sí están `createHostedZone:133`, `listResourceRecordSets:~175`, `deleteHostedZone:239`). → el Gateway no puede descubrir zonas existentes en AWS.
- **Resultado:** inventario local perdido/desincronizado → no encuentra la zona → **crea una nueva** (así apareció `Z05446832` el 06-04, distinta de `Z03595092` del 06-01). Proliferación de zonas + mismatch registrar↔zona. Afecta dominios nuevos también (si la zona auto-creada por RegisterDomain no quedó en el inventario).

## Fix 1 — `listHostedZones` en el adapter Route53 DNS
En `aws-route53-dns-adapter.ts`, agregar `listHostedZones(): Promise<{ zoneId, name, nameServers? }[]>` (Route53 `GET /<API>/hostedzone`, paginado). Es la pieza que falta para descubrir zonas reales.

## Fix 2 — Resolución de zona unificada (consultar AWS, reusar, no duplicar)
Reescribir la resolución de zona (en `domains-dns.ts` y reusada por email-auth/bind) con este orden:
1. **Inventario local** (fast path) → si hay match y la zona existe en AWS, usarla.
2. **Fallback AWS `listHostedZones`** filtrando por el nombre del dominio:
   - **0 zonas** → crear (flujo actual `createHostedZone`) + persistir en inventario.
   - **1 zona** → reusarla + persistir en inventario (esto elimina la duplicación).
   - **>1 zona** → **disambiguar por records**: la que tenga A+MX del dominio (vía `listResourceRecordSets`). Si exactamente una tiene records → usarla. Si varias o ninguna con records → **FAIL-CLOSED** (`zone_ambiguous_manual_review`, no crear ni adivinar) y reportar las zonas candidatas.
3. **Antes de crear**, SIEMPRE chequear AWS (no crear si ya existe) — mata la proliferación.
4. Persistir la decisión en `domains.json` para que el fast path quede consistente.

**Importante:** esto NO rompe el flujo de dominio nuevo — un dominio fresco tiene 0 zonas → crea (igual que hoy); solo agrega el descubrimiento AWS que evita duplicar cuando el inventario está desincronizado.

## Fix 3 — `update_domain_nameservers` (realinear registrar, gateado, con guardrail de records)
- **Adapter:** `updateDomainNameservers(domain, nameservers[])` en `aws-route53-domains-adapter.ts` vía `awsJson("UpdateDomainNameservers", { DomainName, Nameservers:[{Name}] })` (espejar `registerDomain:267/281`; `normalizeDomainName:519` ya valida scope estricto).
- **Tool** `update_domain_nameservers`: WRITE, gateada por firma canónica HMAC/ApprovalGate, `supervised_live_wallet`, severity crítico.
- **GUARDRAIL (clave, evita NXDOMAIN persistente):** antes de realinear, verificar que la zona destino (a) esté **en nuestra cuenta** (`listHostedZones`) y (b) **ya contenga los records A+MX** del dominio (`listResourceRecordSets`). Si está vacía o no es nuestra → **FAIL-CLOSED**, no realinear.
- **Scope** atado al dominio del plan; audit `oc.domain.nameservers_updated {from,to,domain,operationId}`; exactly-once; kill-switch fail-closed.

## Fix 4 — System prompt (v2.7) + orquestador
- Documentar la política: al adoptar/configurar, resolver zona vía AWS (reusar, no duplicar); si el registrar no apunta a la zona canónica con records → proponer `update_domain_nameservers` (1 firma); NUNCA pedir al operador correr `aws cli`.
- (Opcional) que `configure_complete_smtp`, al detectar el mismatch, proponga la realineación como sub-paso gateado en vez de fallar con NXDOMAIN.

## Limpieza de zonas (MANUAL — no automatizar)
`deleteHostedZone` existe (`aws-route53-dns-adapter.ts:239`) pero **borrar zonas es riesgoso** (puede romper DNS de otro stack). La política **solo reporta** las zonas duplicadas/huérfanas (`{cleanupSuggested:[zoneIds]}`) para revisión manual del operador. No auto-borrar.

## Tests (node:test, run real)
- Inventario vacío pero zona existe en AWS → **reusa** (no crea duplicado). ← el bug raíz.
- 0 zonas → crea. 1 zona → reusa. >1: una con records → usa esa; varias/ninguna con records → **fail-closed** (no crea).
- `update_domain_nameservers` a zona con A+MX en nuestra cuenta → ok; a zona vacía o ajena → **fail-closed**.
- Dominio NUEVO (fresh register) → flujo intacto (no-regresión Fase 1/1.5).
- Sin firma → bloqueado. proposals-sign/guardrails intactos.

## Deploy
Adapter+resolución+tool = código → **local** (reiniciar gateway, Node 24). System prompt v2.7 → **también Hostinger** (regla de sync). Mergeá a `produ` tras tests verdes + tu firma.

## Hecho cuando
La resolución de zona consulta AWS y **reusa** en vez de duplicar (fail-closed ante ambigüedad); `update_domain_nameservers` realinea autónomo **solo a una zona nuestra con records** (nunca vacía); limpieza queda manual con aviso. **Acceptance:** OpenClaw resuelve controldelivrix.app → detecta las zonas, usa Z05446832 (la que tiene los smtp. records), realinea el registrar a sus NS con tu firma, reanuda `configure_complete_smtp` y termina; y un dominio NUEVO sigue funcionando sin duplicar zonas. Reportá SHA + qué zonas detectó/reusó + operationId del cambio de NS.
