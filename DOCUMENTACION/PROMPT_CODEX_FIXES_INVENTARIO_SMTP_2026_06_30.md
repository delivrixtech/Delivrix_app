# Correcciones al PR "Gestión de inventario SMTP para OpenClaw" (antes del merge)

> Auditoría profunda con 3 frentes (correctitud / seguridad / wiring-tests), 2026-06-30. Veredicto: **PR sólido y bien cableado — invariante P1 correcto en todos los caminos, gobierno completo (firma HMAC + ApprovalGate + kill-switch + audit chain), endpoint read-only autenticado sin fuga de secretos, wiring completo, sin regresiones.** Mergeable **tras** estos fixes. Prioridad: FIX1 (es el DoD de la visión del CTO).

## FIX 1 — [LO MÁS IMPORTANTE] El auto-resolve NO cubre el caso real → OpenClaw todavía escala
`chooseCanonicalServer` (`smtp-inventory-management.ts:378-394`): sin `keepServerSlug`, solo auto-elige si hay **exactamente 1** server `configured` que existe en la flota viva; con 0 o ≥2 vivos → `canonical_server_required` (no resuelve). Problema: en el incidente real las entradas canónicas (server60/68/69/84) estaban **stopped pero existían**, y las espurias (server92/93/94/96) también podían existir → **2 "vivos" → no auto-resuelve** → OpenClaw queda obligado a pedir `keepServerSlug` al operador. Eso **no cumple el DoD** "OpenClaw lo resuelve solo sin escalar". Además `existsInLiveInventory` (`main.ts:525-558`) mide **presencia, no power state** (no distingue running/stopped).

**Qué hacer:** implementar el **desempate** que el brief original pedía ("configured ∩ flota viva ∩ **run completed**") cuando hay ≥2 configured vivos. Orden de desempate sugerido: (1) el que tenga un `SmtpRunState` con `status:"completed"` para ese dominio gana; (2) si empata o ninguno, el más reciente por `configuredAt`/`updatedAt`; (3) solo si sigue ambiguo → `canonical_server_required`. **DoD:** el caso `server60 (run completed) + server92 (run failed/espurio)` se auto-resuelve a `server60` **sin** `keepServerSlug`, retirando server92. Con test que lo pruebe (justo el escenario del incidente).

## FIX 2 — [MEDIO] La metadata de rollback promete un backup que no existe
`smtpInventoryRollbackPlan` (`skill-dispatcher.ts:982-991`) dice *"Restore inventory/smtp-provisioning.json from backup..."*, pero **no se crea ningún backup** antes de mutar (el único backup automatizado del repo es el de la audit chain, no el inventario). Además solo `retire` captura `previousStatus`; `resolve_ambiguous_domain` y `update_smtp_entry` **no** lo capturan, así que ni el "inverse status change" es reconstruible para esas dos.

**Qué hacer (elegir uno):** (a) crear un backup real `smtp-provisioning.json.bak-<ts>` antes del primer write de cada mutación; **o** (b) corregir el texto del `rollbackPlan` a la verdad operacional (revertir vía `update_smtp_entry` al status previo) **y capturar `previousStatus`** de cada entrada tocada en `resolve` y `update` (no solo en `retire`). Las mutaciones son no-destructivas (solo cambian `status`), así que el dato no se pierde — pero la metadata no debe mentir sobre el camino de recuperación.

## FIX 3 — [COBERTURA] Faltan tests de los guardrails de seguridad (no-negociables del brief §4)
El invariante P1 está bien testeado (2 niveles, incluida la ruta E2E real). Pero `1342/1342 verde` NO prueba los guardrails. Agregar tests de:
1. **`resolve_ambiguous_domain` sin slug con ≥2 vivos** → el nuevo desempate de FIX1 (o `canonical_server_required` si sigue ambiguo). Es el guardrail "no adivinar cuál retirar".
2. **`requested_server_not_live` / `target_server_not_live`** (resolve con keep no-vivo; reassign a destino no-vivo) — la verificación "contra la fuente real".
3. **503 `smtp_inventory_live_source_missing`** cuando falta la live source (fail-closed).
4. **Rechazo de mutación SIN firma / con kill-switch armado** para los 4 mutadores nuevos (que hoy se gatean por exclusión de la allowlist read-only — conviene un test explícito de que NO se ejecutan sin ApprovalGate).
5. **`dryRun`** de resolve/retire/update → devuelve `plan` y NO muta (hoy solo reassign lo testea).

## Nits (no bloqueantes, pero limpios de cerrar)
- `reassign_domain_server`: `supersededServerSlugs` reporta siempre `[fromSlug]` aunque el upsert pudo superseder otras entradas; y con `from===to` reporta "reassigned"+superseded sin haber superseded nada. Reflejar lo realmente superseded.
- `updateSmtpInventory` (`smtp-provisioning.ts:894`) llama al upsert **sin propagar `deps.now`** → `supersededAt`/`updatedAt` usan wall-clock real en tests deterministas. Propagar `now`.
- `inspect_smtp_inventory`: `hasCredential` se deriva del flag persistido en el inventario (puede estar stale), no del record vivo de `smtp-credentials.json`. Documentar o releer.
- `humanApproved:true` hardcodeado en el audit del dispatcher: patrón preexistente del repo (también en `enable_smtp_auth`); no es agujero (el dispatcher solo corre post-firma), pero idealmente derivarlo de la verificación.

## Scope creep a separar
El PR mezcla un cambio que **no es del brief de inventario SMTP**: `resolveLegacyWebdockInventory` (`webdock-legacy-inventory.ts`, untracked) + modificación de `GET /v1/webdock/inventory` (`main.ts:1659`). Es bienvenido (justo el problema de la tool legacy mono-cuenta que confundía a OpenClaw), pero **conviene separarlo en su propio commit/PR** para que la revisión y el rollback sean limpios. Como mínimo, documentarlo.

## Deploy (tras los fixes) — regla deploy sync
1. Tests verdes (incluidos los nuevos de FIX1 y FIX3).
2. commit + push + **merge a `produ`**.
3. **Sincronizar a Hostinger** + correr `scripts/openclaw/build-system-context.sh` (sin esto, OpenClaw NO "ve" las 5 tools nuevas — su system prompt productivo no las incluye todavía).
4. Reiniciar el gateway.
5. Deduplicar/verificar el `smtp-provisioning.json` de Hostinger (las entradas espurias preexistentes allá no se limpian solas; usar `resolve_ambiguous_domain` ya cableado, o dedup manual).
