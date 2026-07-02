# Runbook OpenClaw — Adopción de servers huérfanos y rescate de dominios (2026-07-02)

> Para la KB capa1 de OpenClaw. Receta autónoma con firma humana por paso (ApprovalGate se mantiene siempre).

## Cuándo aplica

Hay un VPS Webdock vivo (running) en la flota multi-cuenta (p.ej. cuenta `quinary` / InfraVPS) que NO está en `webdock-servers.json` (server "huérfano"), y un dominio owned en Route53 que necesita stack SMTP (dominio libre, o dominio zombie cuya entrada apunta a un server muerto).

## Secuencia por dominio (máx 2-3 SMTPs por día — regla anti-snowshoe)

1. **Descubrir**: `read_infrastructure_inventory` / `read_webdock_servers` para confirmar slug, IP y cuenta del huérfano; `inspect_smtp_inventory` para el estado del dominio.
2. **Si el dominio es zombie** (entrada `configured` apuntando a server muerto): `retire_smtp_entry` de la entrada vieja (dry-run → firmado).
3. **Adoptar el server**: `adopt_webdock_server { serverSlug, serverIp, serverAccountId, reason }` (dry-run → firmado). Valida contra la flota viva (slug+IP+cuenta+running+cuenta sana) y registra la entrada en `webdock-servers.json`. Es create-only: `server_already_adopted` significa que ya está registrado (no es error de flujo).
4. **Verificación post-adopción (obligatoria, read-only)**: volver a invocar `read_webdock_servers` y confirmar que `slug`, `ipv4` y `accountId` coinciden con lo adoptado. Si no coinciden, NO usar `configure_complete_smtp`; abrir rollback manual auditado y corregir el inventario antes de cualquier paso con costo.
5. **Instalar la clave SSH del operador (AUTÓNOMO — no manual)**: `ensure_server_ssh_access { serverSlug, serverAccountId, reason }` (dry-run → firmado). Instala/asegura la pubkey `WEBDOCK_OPERATOR_SSH_PUBLIC_KEY` en el server adoptado **vía la API de Webdock** (crea el shell user `delivrixops`, adjunta la key, fija sshSettings) — NO requiere acceso SSH previo. Es el eslabón que hace el rescate autónomo: ya no hace falta entrar a la consola Webdock a mano. Devuelve `server_not_in_inventory` si no se adoptó primero, `unknown_server_account` si la cuenta no es write-capable, `operator_pubkey_unconfigured` si falta la pubkey en el env. Es una escritura REAL en el proveedor (ApprovalGate, audit critical). Verificación opcional post-instalación: `ssh -o BatchMode=yes <usuario>@<ip> 'echo ok'`.
6. **Configurar el stack completo**: `configure_complete_smtp { domain, requireExistingDomain: true, reuseServerSlug: <slug>, serverAccountId: <cuenta>, ... }`.
   - `requireExistingDomain: true` es OBLIGATORIO en rescates: evita compras de dominio accidentales.
   - El guard temprano valida el slug ANTES de cualquier paso con costo; un slug malo falla a costo $0.
   - Al completar, el orquestador escribe la entrada `configured` en `smtp-provisioning.json`.
7. **SASL**: `enable_smtp_auth { domain, serverSlug }` (firmado).
8. **Smoke**: envío real a un destinatario NO-Gmail primero (Gmail después, según warmup/reputación).

## Prioridades vigentes (matriz 2026-07-02)

1. Zombies con DNS público apuntando a IP muerta (riesgo activo de bounces): `controlnational.com` (ex server88), `corpfiling-infra.com` (ex server91). Candidatos de adopción: `server57` / `server58` — verificar identidades antes (server58 duplica hostname de server60; server57 anuncia controldelivrix.app).
2. Dominios libres: `controlnationalcorp.com`, `delivrix-notify.com`, `controldelivrix.app` (warmup desde cero: sin reputación previa).
3. `filing-ops.com` al final: su IP vieja (server139) está listada en Spamhaus — warmup desde cero obligatorio.
4. NO tocar los 4 huérfanos legacy con identidad IONOS activa (`nationalcorp`→nationalcorphub.app, `swiftcorpdoc`, `annualcorpfi`, `nfcorprepor1`) sin decisión de negocio: son stacks de producción viejos.
5. `server10` (stopped) queda fuera hasta que un operador lo arranque.

## Guardrails que este flujo respeta (no intentar saltarlos)

- `adopt_webdock_server` y todos los pasos mutantes requieren propuesta firmada (ApprovalGate) y kill switch desarmado.
- Los `serverSlug` adoptados deben ser únicos operacionalmente; si aparece una colisión o ambigüedad entre proveedores/cuentas, detener y resolver identidad antes de firmar.
- `serverAccountId` desconocido → `unknown_server_account` (fail-closed; no hay fallback silencioso a otra cuenta).
- Cuenta con `accountHealthStatus` distinto de healthy → `account_not_healthy` (no adoptar sobre cuentas degradadas).
- El rollback de una adopción es manual (retirar la entrada de `webdock-servers.json`); la adopción en sí no toca DNS/SSH/proveedor.
