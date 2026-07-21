# ADR: Modo "reconfigurar dominio sobre VPS existente"

Fecha: 2026-06-10. Estado: DISEÑO (auditado, sin implementar). Branch base: produ HEAD ea778a5.

## Objetivo

Reutilizar VPS Webdock que tienen el dominio DESCARTADO `controldelivrix.app` (5 servers, IPs limpias en blacklists) montandoles un dominio NUEVO, en vez de crear un VPS desde cero. Aprovecha la IP ya warmeada + el hardware ya pagado.

## Hallazgo base (verificado en codigo)

El orquestador `configure_complete_smtp` tiene 14 steps. **Solo el step 4 (`create_webdock_server`) crea**; produce `serverSlug`+`serverIpv4` (orchestrator-smtp.ts:708-712) y los steps 5-14 reconfiguran el VPS sobre esas dos variables (DNS, bind+identity, Postfix, DKIM, warmup, smoke). El reuse actual (`resolveExistingServerForCreate`, webdock-servers.ts:857) solo matchea por hostname EXACTO -> con dominio nuevo NO reusa, crea uno nuevo. Por eso el modo no existe y hay que inyectarlo.

## Contrato (opt-in, no rompe produccion)

Nuevo campo opcional `existingServerSlug?: string` (+ se reusa el `serverAccountId` ya existente para saber en que cuenta vive) en `ConfigureCompleteSmtpSkillParams` (skill-schemas.ts). Ausente = flujo crear-nuevo IDENTICO. Presente = modo adoptar.

## Cambios por archivo

1. **skill-schemas.ts** (~159-171, ~391-410): agregar `existingServerSlug?` top-level con guard `undefined -> {}` (mismo patron que runId/provider). NUNCA insertarlo en un `params:{}` de step (asi queda fuera de todo inputHash).

2. **orchestrator-smtp.ts step 4 (entre :683 y :685)**: branch opt-in.
   - Si `existingServerSlug`: ADOPTAR. Resolver el adapter por `serverAccountId` (skill-dispatcher resolveWebdockCreateAdapter), llamar `getServer(slug)`, validar `status==="running"` y `ipv4` presente (rechazar si no). Setear serverSlug/serverIpv4 desde el server real. Marcar step 4 `done` en runState.steps con inputHash PROPIO `hashInput({adopt: existingServerSlug})` (no el de create) para que el resume lo salte sin re-adoptar.
   - Si ausente: el bloque create_webdock_server ACTUAL sin tocar (:685-712).
   - Seleccion SIEMPRE por slug explicito, nunca por hostname (server58 y server95 comparten hostname smtp.controldelivrix.app -> ambiguo).

3. **orchestrator-smtp.ts SmtpRunState (~400-410)**: agregar `adoptedExistingServer?: boolean` + `existingServerSlug?: string` (opcionales, backward-compat). Persistir ANTES de tocar el VPS (igual que serverAccountId :682-683). El resume rehidrata en :565-566.

4. **orchestrator-smtp.ts ROLLBACK (:973) [P0 - CRITICO]**: guard
   `if (serverSlug && failure.step >= 6 && !runState?.adoptedExistingServer && deps.submitRollbackProposal)`.
   En modo adoptar NUNCA se emite la propuesta `delete_webdock_server` (destruiria un VPS preexistente warmeado). Usar el campo del runState (no closure) para que el resume herede el modo. HOY submitRollbackProposal es stub (solo audita), pero es una mina: cuando el pipeline ejecute deletes, un fallo del reconfigurar borraria un server productivo.

5. **(Defensa en profundidad, P0 server-side)**: gatear el handler `delete_webdock_server`: antes de `deleteServer(slug)`, rechazar si el server esta marcado adoptado (audit `oc.rollback.delete_blocked_adopted_server`). Cierra el hueco de "operador firma a ciegas".

## Lo que el modo necesita ADEMAS del step 4 (no es solo saltar el create)

- **FCrDNS/PTR (P0-1)**: el step 8 (bind_webdock_main_domain) ya setea Server Identity = PTR (setServerIdentity -> rDNS) y verifica FCrDNS con retry 15min (webdock-bind-domain.ts:300-364). En modo adoptar el step 8 corre IGUAL y realinea el PTR del VPS (de default/controldelivrix a smtp.<nuevo>). NO saltar el step 8. Riesgo = timing de propagacion rDNS; mitiga el retry existente. Pre-flight recomendado: `dig -x IP == smtp.<nuevo>` antes de confiar.
- **Limpieza DNS vieja (P1)**: los registros de `controldelivrix.app` (A smtp., MX, DKIM s2026a, SPF, DMARC) quedan en su zona apuntando a la IP reusada; el flujo NUNCA los borra (cleanupSuggested es decorativo, email-auth solo UPSERT). Agregar una fase de limpieza Route53 de la zona vieja para los records que apuntan a la IP. No bloquea el envio del dominio nuevo (zonas distintas) pero deja basura DNS-visible que debilita la postura de la IP.
- **Re-provision forzada (P2)**: el step 9 podria idempotent-skip si detecta provision previa -> quedaria con config de controldelivrix. El modo adoptar debe FORZAR re-provision (myhostname/main.cf/DKIM al dominio nuevo). Verificado: el provision sobrescribe limpio (install -m truncate), solo hay que asegurar que no salte.
- **Power-on (P2)**: server58 esta STOPPED. No hay step de power-on en los 14. Prender el VPS (adapter) antes de adoptar, o exigir running.
- **Residuos VPS inertes (P2)**: DKIM key vieja en /etc/opendkim/keys/controldelivrix.app/ + cert Let's Encrypt viejo. Inofensivos (OpenDKIM no los carga, main.cf no los referencia). Limpieza opcional de higiene.

## Invariante de no-regresion (garantizado por los 3 auditores)

Con `existingServerSlug` ausente: effectiveInput identico, branch else byte-identico (:685-712), campo nunca en params -> los 14 inputHash IDENTICOS -> firmas de plan existentes siguen validando, idempotencia/resume intactos. Los campos nuevos de runState quedan undefined en runs crear-nuevo y runStates viejos.

## Plan de implementacion (worktree aislado, fases)

- **F0**: worktree nuevo sobre produ. 
- **F1 (core)**: schema + step 4 adopt + state + rollback guard P0. Tests de no-regresion (crear-nuevo byte-identico) + test nuevo (adoptar no emite delete en fallo step>=6).
- **F2 (robustez)**: limpieza DNS zona vieja + re-provision forzada + power-on + defensa server-side delete.
- **F3 (validacion)**: 1 VPS real (server58 o server10) con dominio nuevo, E2E, antes de escalar a los 5.

## Decisiones abiertas para Juanes

- Confirmar "pep" y "smtpsinfrade" (genericos) comerciales o reciclables.
- F2 (limpieza DNS vieja) se hace en el mismo run o como paso separado.
- Que proveedor de dominio para los nuevos (Route53 confirmado en flujo / Porkbun).
