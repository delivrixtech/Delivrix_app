# Runbook OpenClaw — Adopción de servers huérfanos y rescate de dominios (2026-07-02)

> Para la KB capa1 de OpenClaw. Receta autónoma con firma humana por paso (ApprovalGate se mantiene siempre).

## Cuándo aplica

Hay un VPS Webdock vivo (running) en la flota multi-cuenta (p.ej. cuenta `quinary` / InfraVPS) que NO está en `webdock-servers.json` (server "huérfano"), y un dominio owned en Route53 que necesita stack SMTP (dominio libre, o dominio zombie cuya entrada apunta a un server muerto).

## Secuencia por dominio (máx 2-3 SMTPs por día — regla anti-snowshoe)

1. **Descubrir**: `read_infrastructure_inventory` / `read_webdock_servers` para confirmar slug, IP y cuenta del huérfano; `inspect_smtp_inventory` para el estado del dominio.
2. **Si el dominio es zombie** (entrada `configured` apuntando a server muerto): `retire_smtp_entry` de la entrada vieja (dry-run → firmado).
3. **Adoptar el server**: `adopt_webdock_server { serverSlug, serverIp, serverAccountId, reason }` (dry-run → firmado). Valida contra la flota viva (slug+IP+cuenta+running+cuenta sana) y registra la entrada en `webdock-servers.json`. Es create-only: `server_already_adopted` significa que ya está registrado (no es error de flujo).
4. **Prerequisito SSH (humano, una sola vez por server)**: la pubkey del operador (`WEBDOCK_OPERATOR_SSH_PUBLIC_KEY`) debe estar instalada en el server adoptado; si el paso 9 del orquestador falla con Permission denied, pedir al operador instalarla por consola Webdock.
5. **Configurar el stack completo**: `configure_complete_smtp { domain, requireExistingDomain: true, reuseServerSlug: <slug>, serverAccountId: <cuenta>, ... }`.
   - `requireExistingDomain: true` es OBLIGATORIO en rescates: evita compras de dominio accidentales.
   - El guard temprano valida el slug ANTES de cualquier paso con costo; un slug malo falla a costo $0.
   - Al completar, el orquestador escribe la entrada `configured` en `smtp-provisioning.json`.
6. **SASL**: `enable_smtp_auth { domain, serverSlug }` (firmado).
7. **Smoke**: envío real a un destinatario NO-Gmail primero (Gmail después, según warmup/reputación).

## Prioridades vigentes (matriz 2026-07-02)

1. Zombies con DNS público apuntando a IP muerta (riesgo activo de bounces): `controlnational.com` (ex server88), `corpfiling-infra.com` (ex server91). Candidatos de adopción: `server57` / `server58` — verificar identidades antes (server58 duplica hostname de server60; server57 anuncia controldelivrix.app).
2. Dominios libres: `controlnationalcorp.com`, `delivrix-notify.com`, `controldelivrix.app` (warmup desde cero: sin reputación previa).
3. `filing-ops.com` al final: su IP vieja (server139) está listada en Spamhaus — warmup desde cero obligatorio.
4. NO tocar los 4 huérfanos legacy con identidad IONOS activa (`nationalcorp`→nationalcorphub.app, `swiftcorpdoc`, `annualcorpfi`, `nfcorprepor1`) sin decisión de negocio: son stacks de producción viejos.
5. `server10` (stopped) queda fuera hasta que un operador lo arranque.

## Guardrails que este flujo respeta (no intentar saltarlos)

- `adopt_webdock_server` y todos los pasos mutantes requieren propuesta firmada (ApprovalGate) y kill switch desarmado.
- `serverAccountId` desconocido → `unknown_server_account` (fail-closed; no hay fallback silencioso a otra cuenta).
- Cuenta con `accountHealthStatus` distinto de healthy → `account_not_healthy` (no adoptar sobre cuentas degradadas).
- El rollback de una adopción es manual (retirar la entrada de `webdock-servers.json`); la adopción en sí no toca DNS/SSH/proveedor.
