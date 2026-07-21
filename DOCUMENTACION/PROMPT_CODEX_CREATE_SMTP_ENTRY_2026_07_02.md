# Brief Codex - Exponer tool `create_smtp_entry` (romper el deadlock de inventario SMTP)

> Track O / autonomia OpenClaw. 2026-07-02. Prioridad ALTA (bloquea terminar los SMTP de quinary).

## 0. El deadlock (auditado en vivo, read-only)

Para terminar un SMTP (registrar la entrada de inventario `configured` y luego `send_real_email`) hoy no hay salida con las tools desplegadas:

- `update_smtp_entry` es **update-only**: si la entrada no existe devuelve `entry_not_found` (409). Verificado en `smtp-inventory-management.ts:373`.
- `configure_complete_smtp` (unico path que CREA la entrada `configured`, via `upsertConfiguredSmtpInventoryEntry` en `routes/smtp-provisioning.ts:898`) esta fallando en el step de adopcion/creacion de server (la lectura del inventario Webdock legacy devuelve `responseOk=false` por auth error -> `webdock_inventory_degraded`, `routes/webdock-servers.ts:944-955`), asi que nunca llega a escribir la entrada.
- **No existe** ninguna tool `create_smtp_entry` / `addSmtpEntry` en el catalogo (barrido exhaustivo: cero matches). Las 4 mutadoras de inventario (`resolve_ambiguous_domain`, `retire_smtp_entry`, `reassign_domain_server`, `update_smtp_entry`) son todas update/mutate-only.
- `send_real_email` queda bloqueado por el guard de orquestacion (`use_configure_complete_smtp`, `tool-use-processor.ts:180-194`).

Resultado: OpenClaw no puede materializar la entrada `configured` para un server que SI esta vivo y verificado en el inventario multi-proveedor (`GET /v1/infrastructure/inventory`), y todo el flujo se traba. Caso real: `controlcorpfiling.com` / `server58` (45.136.70.174, quinary, `ipVerified=true`) - DNS/SPF/DKIM/DMARC/PTR 5/5 correctos, Postfix vivo, pero sin entrada de inventario y sin forma de crearla.

## 1. FIX - nueva tool `create_smtp_entry` (envuelve el upsert que YA existe)

`upsertConfiguredSmtpInventoryEntry` (`smtp-inventory-management.ts:65-95`) ya es un **upsert real** (crea si no existe), estado local puro sobre `inventory/smtp-provisioning.json`, sin dependencia de Webdock ni SSH, y ya aplica el invariante "un solo `configured` por dominio" (supersede los demas). Es el primitivo que usan `reassignSmtpDomainServer` y `updateSmtpInventoryEntry`.

Exponerla como tool nueva, clonando 1:1 el patron de `update_smtp_entry`:

- Handler en `skill-dispatcher.ts` (patron identico a `updateSmtpEntry`, ~`:849-877`). Recibe `liveServers` de `readRequiredSmtpLiveServers` / `listSmtpInventoryLiveServers` (`main.ts:525`), que ya es el inventario multi-proveedor vivo (Webdock multicuenta + Contabo). **NO** consultar la API legacy Webdock.
- ParamSchema en `skill-schemas.ts` (clon de `updateSmtpEntryParamSchema`, ~`:547`): `domain`, `serverSlug`, `serverIp`, `selector`, `status` (fijo `configured`), `dryRun`.
- Spec en `openclaw-tools-builder.ts` (clon del bloque `:1057-1083`), y registrarla en: union type `:84`, lista de nombres `:1370`.
- Registro en el mapa de handlers (`skill-dispatcher.ts:911-913`), permisos (`main.ts:1273`), c2-detector (`c2-detector.ts:66`), skill-contracts (`skill-contracts.ts:117`), y allowlist de firma (`proposals-sign.ts`).

## 2. Invariante de seguridad (no negociable)

- Exigir **liveness del server** antes de crear la entrada `configured` (mismo criterio que `update_smtp_entry` cuando `status=configured`, `smtp-inventory-management.ts:375`): validar que `serverSlug`/`serverIp` existan en `listSmtpInventoryLiveServers` con `ipVerified`/running. Asi no se crean entradas `configured` apuntando a servers muertos.
- Gobernada igual que las demas mutadoras: ApprovalGate + firma operador + audit chain `critical` + kill-switch + `dryRun` default-safe. Rollback manual documentado.
- No tocar el core: reusar `upsertConfiguredSmtpInventoryEntry` sin modificarla.

## 3. Por que este fix y no el del reuse-lookup

El fix alternativo (que el reuse-lookup caiga a `infrastructure/inventory` cuando el token Webdock legacy falla, `webdock-servers.ts:944-967`) toca el **path critico de creacion/adopcion de VPS** (compartido Webdock+Contabo, byte-identico, fuertemente testeado) y requiere mapear shapes distintos + cambiar la clave de match (hostname vs slug) -> riesgo de regresion medio-alto. `create_smtp_entry` es una **tool nueva aislada** que no toca ningun path existente -> riesgo bajo. Es el camino mas chico y seguro para desbloquear el E2E, y ademas sirve para los 6 dominios de quinary y futuros.

(Opcional, menor prioridad, en un PR aparte: agregar el fallback del reuse-lookup a `infrastructure/inventory`. No es necesario para desbloquear si existe `create_smtp_entry`.)

## 4. DoD

- Existe `create_smtp_entry` declarada en el catalogo, con permisos + firma + c2 + contracts + allowlist.
- Crea la entrada `configured` para un dominio+server vivo (test: tras el create, `inspect_smtp_inventory` la devuelve; `send_real_email` deja de dar `use_configure_complete_smtp` por ese lado del inventario).
- Rechaza (o exige override explicito) si el server no esta vivo/verificado en el inventario multi-proveedor.
- `dryRun` soportado; sin efecto de escritura en dryRun.
- Sin regresion en las 4 tools de inventario existentes ni en el catalogo (actualizar los tests que enumeran el set de tools: `openclaw-tools-builder.test.ts`, `skill-contracts.test.ts`, etc.).

## 5. Deploy (regla sync local + Hostinger)

tests verdes -> commit + push + merge produ -> Hostinger sync + `scripts/openclaw/build-system-context.sh` (para que OpenClaw vea la tool nueva en su system prompt) -> restart gateway. Recien ahi OpenClaw puede crear la entrada y terminar el E2E.

## 6. Nota operativa (fuera de este fix)

Independiente del tooling: `server58` (y los 4 servers quinary probados) dan **timeout al MX de Google** en outbound :25. Eso NO lo resuelve este PR. Para probar que el SMTP envia, el primer smoke conviene mandarlo a un destinatario **no-Gmail**; la entrega a Gmail depende de resolver reachability/reputacion de las IPs quinary por separado.
