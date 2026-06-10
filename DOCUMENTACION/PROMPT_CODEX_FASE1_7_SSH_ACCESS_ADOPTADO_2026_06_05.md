# Codex — FASE 1.7 (endurecida): SSH access del runner en servers adoptados, con diagnóstico claro

> **Por qué:** `provision_smtp_postfix` falla con **SSH exit 255** en server10 (adoptado). Auditoría adversarial: wirear `ensureServerSshAccess` es **necesario pero no suficiente** — `exit 255` es ambiguo (auth vs red), no se valida el par de llaves, y falta el settle delay en el flujo de provision. Este prompt cubre todo + falla **fuerte y claro** en vez de 255 opaco.
> **Base:** `produ` con Fase 1.6 desplegada. Rama `codex/fase1.7-ssh-access`. Subagentes + Auditor. Stop-and-report.

## Lo que YA existe y sirve (NO rehacer)
`packages/adapters/src/webdock-real-adapter.ts:393` `ensureServerSshAccess({serverSlug, username, publicKey})` vía Webdock API (sin SSH): registra account public key (`:700`), crea/parchea el shell user **con `group:"sudo"` (`:437`) y `passwordlessSudoEnabled:true` (`:459`)**. Idempotente. → el sudo del provision (`sudo -n`, `smtp-provisioning.ts:771`) queda cubierto.

## Fix (wiring + 5 guardas; orden importa)
En el flujo de provision (`orchestrator-smtp.ts` step 9 / `smtp-provisioning.ts`, antes del SSH runner):

1. **Server state pre-check:** `getServer(serverSlug).status === "running"`. Si no → blocker `server_not_running` (no asumir listo).
2. **Username consistente:** el `username` que se pasa a `ensureServerSshAccess` DEBE ser el mismo `SMTP_PROVISION_SSH_USER` (default `delivrixops`) que usa el runner. Si difieren → blocker `ssh_user_mismatch`.
3. **Key-pair match (CRÍTICO):** validar que la **pública derivada de** `SMTP_PROVISION_SSH_KEY_PATH` (private, `~/.ssh/delivrix-ops`) **coincide** con la que se va a instalar (`WEBDOCK_OPERATOR_SSH_PUBLIC_KEY`). Derivar la pública del private (ssh-keygen -y / node:crypto) y comparar el material de la key. Si NO coinciden → blocker `ssh_key_pair_mismatch` (instalar la operator key NO serviría). Idealmente: instalar **la pública que corresponde al private del runner**, no asumir que el env es el par.
4. **Ensure access:** `ensureServerSshAccess({ serverSlug, username, publicKey })` (la que matchea el private del runner).
5. **Settle delay:** tras ensure, **esperar `WEBDOCK_SSH_ACCESS_SETTLE_MS`** (default 120000) — el flujo de provision NO lo tiene hoy; agregarlo. (Webdock tarda en sincronizar el authorized_keys.)
6. **Pre-flight connectivity/diagnóstico (distinguir auth vs red ANTES de los 3 reintentos ciegos):** un `ssh -o ConnectTimeout=8 -o BatchMode=yes -i <key> <user>@<ip> 'echo ok'`:
   - timeout/refused → blocker `ssh_network_unreachable` (puerto 22/sshd/firewall — NO reintentar 3×; es infra Webdock, avisar al operador).
   - permission denied → blocker `ssh_auth_denied` (key no aceptada pese a ensure — revisar par/usuario).
   - ok → seguir con el provision real.
   Esto reemplaza el `exit 255` opaco por un motivo claro.

## Tests (node:test, run real)
- Adoptado sin key, par correcto → ensure instala (mock API) → settle → pre-flight ok → provision procede.
- Key-pair mismatch (private ≠ pública env) → blocker `ssh_key_pair_mismatch` ANTES de tocar el server.
- Red caída (pre-flight timeout) → blocker `ssh_network_unreachable` (sin 3 reintentos ciegos).
- Username distinto → `ssh_user_mismatch`. Server no running → `server_not_running`.
- Idempotente: key ya presente → no-op. No-regresión create fresco / Fase 1.5 / 1.6.

## Deploy
Código → local (restart gateway). Sin cambio de prompt → Hostinger no se toca. Merge tras verde + firma.

## Hecho cuando
Adoptar/reusar un server instala el SSH access del runner solo (vía Webdock API, con sudo), valida el par de llaves, espera el settle, y **distingue auth vs red con blocker claro** (nunca más `exit 255` opaco). controldelivrix retoma `provision_smtp_postfix` sin paso manual **si el fallo era auth**; si era red, te lo dice explícito para arreglarlo en Webdock. Reportá SHA + qué blocker/medición dio en server10.
