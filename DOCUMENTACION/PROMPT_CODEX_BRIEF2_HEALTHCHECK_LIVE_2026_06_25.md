# PROMPT CODEX — Brief 2: Healthcheck de cuentas EN VIVO (construir SOBRE #22)

Contexto: #18 + #21 + #22 ya estan en produ. El PR #22 dejo CASI todo el aparato de salud de cuentas
ya hecho; este brief es SOLO lo que falta para que sea "en vivo". NO reimplementar lo de #22.

## YA CUBIERTO por #22 (no tocar, reusar):
- Auditar transicion de salud (Webdock): observe() calcula la arista healthy<->unhealthy una vez
  (local-file-infrastructure-account-lifecycle-store.ts:278-287) y emite
  oc.webdock.account_unhealthy / account_recovered con accountId + httpStatus + errorCode + timestamps
  (infrastructure.ts:498-562). Clasificacion fina: classifyWebdockAccountHealth (infrastructure.ts:
  680-697) distingue unauthorized (401/403) vs degraded (5xx/red) vs suspended_candidate vs healthy.
- Telemetria memoria 503: episodic-scratch.ts:111-118 loguea postgresCode/postgresMessage (redactado);
  checkEpisodicScratchHealth (dependency-health.ts:56-120) distingue ok/missing_table(42P01)/
  schema_drift(42703)/down; expuesto en GET /v1/openclaw/scratch/health (main.ts:1783) y embebido en
  account-health.
- Endpoint/skill de diagnostico read-only: GET /v1/infrastructure/account-health (main.ts:1998 ->
  infrastructure.ts:246-295) + skill read_infrastructure_account_health (openclaw-tools-builder.ts:
  501-518, read-only, token-gated). Devuelve accountHealth + orphanReport + scratchHealth con partial/
  integrity.

## LO QUE FALTA (este brief). Hilo transversal: todo lo de #22 corre SOLO on-demand (cuando llega un
## GET al inventario) y SOLO cubre Webdock (Contabo/vpsProviders nunca se clasifica ni observa).

### P0 (el corazon de "en vivo") — disparador activo del healthcheck
Hoy observe()->transicion->evento solo se ejecuta dentro de handleInfrastructureInventoryHttp cuando
alguien hace GET (infrastructure.ts:180-193). NO hay job periodico (el unico es MXtoolbox,
main.ts:5424-5431). Resultado: account_unhealthy se emite cuando alguien abre el panel, no cuando la
cuenta cae.
FIX: agregar un scheduler (setInterval(...).unref(), espejo del patron MXtoolbox) + un disparo al boot
(despues del listen, main.ts:~5356) que llame a listWebdockInventoryAccounts() +
accountLifecycleStore.observe(...) + auditWebdockAccountHealthTransitions(...). REUTILIZA todo #22; solo
agrega el trigger. Cadencia por env (WEBDOCK_HEALTH_POLL_MS, default ~5-10 min).
Invariante: unref + no bloquear el boot + respetar el dedupe de audit existente (no spamear).

### P1 — extender el healthcheck a Contabo (VpsProvider)
vpsProviders se renderiza como inventario (infrastructure.ts:412-415) pero NUNCA se clasifica ni
observa: buildAccountHealthReport (:572) y auditWebdockAccountHealthTransitions (:504) iteran SOLO
webdockAccounts. Por omision, el healthcheck MIENTE para Contabo (2o proveedor productivo, 8 servers).
FIX: classifyVpsProviderHealth analogo a classifyWebdockAccountHealth; incluir vpsProviders en el
health report y en el audit de transiciones, parametrizando providerId (observe() YA acepta providerId
arbitrario, local-file-...:49).

### P2 — pre-flight live al boot
checkEnvPreflight sigue 100% estatico (presencia/formato de env, env-preflight.ts:289-352, corre 1 vez
en main.ts:5356) y CIEGO a las 4 cuentas distintas + Contabo. NO bloquear el boot por un 401
transitorio: dejar el pre-flight estatico como gate de arranque y anadir DESPUES del listen una
verificacion viva read-only por cuenta (puede ser la primera corrida del job P0) que loguee el estado
real de las N cuentas.

### P3 (enabler) — modelar la racha / consumir consecutiveFailures
El store YA persiste consecutiveFailures (local-file-...:135) pero NADIE lo lee. Agregar
firstUnhealthyAt al record (cuando action === "unhealthy") y exponer la racha en el account-health
report. Es el enabler del auto-propose-retire.

### FASE POSTERIOR (encadenada a P0+P3) — auto-propose-retire (cierra el loop con #22)
Cuando una cuenta lleva N polls/dias SOSTENIDOS en failureKind === "unauthorized" (no transitorio):
que OpenClaw PROPONGA (gated, NO ejecute) darla de baja, reusando el soft-retire de #22
(retire_infrastructure_account / ApprovalGate). NO reimplementar retire. Falta solo: (1) evaluador de
umbral que LEA consecutiveFailures + firstUnhealthyAt; (2) emision de la propuesta gated
(oc.webdock.account_retire_proposed o reusar ApprovalGate). Guardia: exigir unauthorized sostenido N
polls (la distincion ya la hace classifyWebdockAccountHealth) para no auto-proponer ante un 401
transitorio (token rotado / rate-limit). Esto convierte el caso real (pep.prz001 / Host Latam muertas)
en: el sistema las detecta caidas, acumula racha y PROPONE la baja para tu firma -- sin parche de env
manual.

## INVARIANTES
No romper #18/#21/#22 (inventario multi-cuenta, redaccion, lifecycle/soft-retire). El job es read-only
salvo la propuesta gated (que NO ejecuta sin firma humana). No spamear audit (dedupe existente). unref
+ no bloquear boot. Scope limpio (sin .audit/config/state/runtime).

## DoD
- Una cuenta que cae a 401 emite account_unhealthy SIN que nadie abra el panel (job activo), con
  timeline. Test del scheduler con fake timers.
- Contabo aparece en account-health con su health y emite transiciones igual que Webdock.
- Pre-flight live loguea el estado real de las N cuentas al boot.
- (Fase posterior) una cuenta N polls en unauthorized genera UNA propuesta gated de baja; un 401
  transitorio NO la genera.
- tsc verde, suite verde, scope limpio.
