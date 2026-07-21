# PR — OpenClaw confiable y observable (Track O + Warmup W3/W4)

> Resumen del bloque de 6 commits sobre `feat/openclaw-track-o` (encima de `produ` post-PR #33).
> Estado: listo para push → PR → QA Auditor + CI → merge → deploy → verificación en vivo.

## 1. Qué entra (6 commits)

| Commit | Item | Entrega |
|---|---|---|
| `060b03b` | **O3** | `read_delivery_reason` — motivo de rebote por mensaje |
| `3560c5a` | **O4** | `read_smtp_reachability` + `read_dkim_status` |
| `d645807` | **W3** | Motor de circuit-breaker de warmup (spam + placement) |
| `66bb670` | **W4-seam** | Breaker cableado al scheduler (auto-pausa por spam/placement) |
| `ffd48b2` | **W4-feed** | Feed de placement al scheduler desde el audit log |
| `f3eb8c0` | **O5/#6** | `read_run_state_integrity` — dominios que envían sin run |

## 2. Tools nuevas del agente (read-only, gated, auditadas)

Todas son lectura: no envían ni mutan, no requieren ApprovalGate, y el gateway hace el trabajo (el agente nunca ejecuta SSH/DNS).

- **`read_delivery_reason`** (serverSlug, serverIp, messageId): lee `mail.log` por SSH en 2 etapas (message-id → queue-id → línea `status=`) y devuelve status final + código SMTP/DSN + motivo. Mata el "puerto 25 bloqueado" sin evidencia.
- **`read_smtp_reachability`** (serverSlug, serverIp): separa **inbound** (¿escucha en :25?) de **outbound** (¿conecta a un MX en :25?). Si el probe no corre → `unknown`, nunca un `blocked` falso.
- **`read_dkim_status`** (domain, expectedSelector?): prueba la convención real `s<año>a`/`s2026a` + comunes; distingue **valid / revoked / absent / unknown**. Mata el falso "DKIM missing" por consultar `default`.
- **`read_run_state_integrity`** (sin params): cruza dominios que enviaron contra los runs registrados → lista los que **envían sin run** (caso `annualcorpfilings`) + runs `failed`/`cancelled`.

## 3. Warmup (W3 + W4)

- **Breaker** (`warmup-breaker.ts`): pesa bounce + spam-complaint (~0.30%) + placement (piso inbox 80%) → continue / throttle / pause con razón (`auto_bounce_rate` / `auto_spam_rate` / `auto_placement`).
- **Lazo cerrado**: el scheduler corre el breaker tras cada batch y auto-pausa por spam/placement, leyendo el último `oc.placement.checked` del audit por `rampId` (sin IMAP en el hot path). **Sin señales de placement → comportamiento idéntico al previo (cero regresión).**

## 4. Tests

- Suite completa: **1316 pass**. La única falla (`security/approval-token.test.ts`) es **ambiental del sandbox** (SQLite escribe en `/private/tmp`); en CI/Mac pasa → debería dar **1317/1317**.
- Cobertura nueva: motores puros (delivery-reason, reachability, dkim, breaker, run-state) + handlers de ruta (auth/params) + 2 tests de integración del scheduler (pausa por placement y por spam) + registries (catálogo, dispatch, bridge, C2).

## 5. Verificación EN VIVO (post-deploy) — lo que importa confirmar

1. **`read_smtp_reachability`** contra un server real → el outbound :25 se reporta **aparte** del inbound; un server con egress bloqueado da `canSend:false` (no un falso "todo bien").
2. **`read_delivery_reason`** con un `messageId` que rebotó → devuelve el `5xx` / DSN real del log.
3. **`read_dkim_status`** de un dominio firmado con `s2026a` → `valid` (no el viejo falso "missing").
4. **`read_run_state_integrity`** → lista `annualcorpfilings` (o cualquier dominio que envió sin run).
5. **Warmup**: correr un `placement-check` con el `rampId` de un ramp activo y placement malo → el ramp auto-pausa con `auto_placement`.

## 6. Riesgo / rollback

- Todo **aditivo**: tools read-only gated (`hmac` + `ssh`/`dns`); el breaker sin señales = solo bounce (como antes). **Sin migraciones nuevas.** Sin secretos en el diff.
- Rollback = `git revert` de los 6 commits (o no-merge del PR).
- Excluido del PR (no commitear nunca): `config/gateway.env.bak*`, `.audit/`, `state/`, docs ajenos.
