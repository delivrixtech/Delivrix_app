# OPS Codex Bloque 4 — Webdock multi-cuenta + SSH bridge OpenClaw chat

**Fecha:** 2026-05-24
**Worktree:** `/Users/juanescanar/Documents/delivrix app`
**Branch base:** `main` (HEAD `5420654` o el último que esté en main al recibir esto)
**Trabajo paralelo:** Claude refina el UI del feature Infrastructure y resto del panel (no toca `apps/gateway-api/`, `packages/adapters/`, ni `packages/domain/`).

## Contexto

Bloque 3 (commit `c972b15`) implementó `GET /v1/infrastructure/inventory` con `WebdockRealAdapter` que conecta a Webdock real **pero solo soporta una cuenta**. El usuario tiene **3 cuentas Webdock distintas** que necesitan aparecer como 3 providers separados en el inventory.

Bloque 3 T1 quedó deferred a humano (issue público pendiente decisión). Aprovechamos para implementar **SSH bridge OpenClaw chat** como workaround temporal que desbloquea chat real en el panel sin esperar el bridge HTTP Hostinger.

## Tareas

### T1 — Webdock multi-cuenta

Extender `WebdockRealAdapter` y el handler `/v1/infrastructure/inventory` para soportar 3 cuentas Webdock con tokens independientes.

**Convención de env propuesta** (Codex puede ajustar si prefiere otra forma):

```bash
WEBDOCK_API_KEY_PRIMARY="<token cuenta 1>"
WEBDOCK_API_KEY_SECONDARY="<token cuenta 2>"
WEBDOCK_API_KEY_TERTIARY="<token cuenta 3>"

WEBDOCK_ACCOUNT_PRIMARY_LABEL="Delivrix Primary"
WEBDOCK_ACCOUNT_SECONDARY_LABEL="Delivrix Secondary"
WEBDOCK_ACCOUNT_TERTIARY_LABEL="Delivrix Tertiary"
```

Si `_PRIMARY` no está, fallback al `WEBDOCK_API_KEY` viejo (1 sola cuenta) para no romper setup local actual.

**Cambios backend:**

1. **Refactor `packages/adapters/src/webdock-real-adapter.ts`:**
   - `class WebdockRealAdapter` constructor toma `{ apiKey, baseUrl?, cacheTtlMs?, accountLabel? }`.
   - El singleton actual sigue existiendo para compatibility, pero ahora cada instancia mantiene cache separado.
   - Agregar `accountLabel: string` al `WebdockServer.detail` para diferenciación en UI.

2. **Nuevo helper `createWebdockAdaptersFromEnv()`:**
   - Lee `WEBDOCK_API_KEY_PRIMARY/SECONDARY/TERTIARY` + `WEBDOCK_ACCOUNT_*_LABEL`.
   - Devuelve array de `{ id, label, adapter }`.
   - Si solo está `WEBDOCK_API_KEY` viejo, devuelve 1 entrada con id `webdock-default`.

3. **Refactor `apps/gateway-api/src/routes/infrastructure.ts`:**
   - `webdockListServers` cambia de `() => Promise<WebdockInventoryResult>` a `() => Promise<Array<{ accountId, accountLabel, result }>>`.
   - `buildInfrastructureInventoryPayload` itera array Webdock y agrega 1 provider por cuenta:
     - `id: "webdock-${accountId}"`, `displayName: accountLabel`, `kind: "compute"`.
     - Status según server statuses dentro de esa cuenta.

4. **Test `apps/gateway-api/src/routes/infrastructure.test.ts`:**
   - Caso "tres cuentas activas" → 3 providers separados con counts distintos.
   - Caso "una sola cuenta legacy" → 1 provider `webdock-default` con label "Webdock".
   - Caso "una cuenta falla, otras dos OK" → provider con status `error` + errorReason, otras `active`.

**No tocar:**
- El front Infrastructure feature. Claude lo adapta cuando T1 esté pusheado.
- Audit chain — el evento `oc.infrastructure.inventory.fetch` ya existe, solo el providerCount cambia.

---

### T2 — SSH bridge OpenClaw chat (workaround temporal)

**Contexto:** el bridge HTTP del contenedor Hostinger no existe. El gateway local Delivrix ya devuelve HTTP 502 explícito (mitigación de bloque 2). Pero el RPC interno funciona — `openclaw gateway call chat.send/chat.history` ejecutado DENTRO del container responde con `provider: amazon-bedrock`.

Implementar bridge SSH como capa temporal: el gateway local hace SSH al container y ejecuta el RPC. El panel sigue consumiendo `POST /v1/openclaw/chat/send` igual que ahora; solo cambia la implementación interna.

**Estructura propuesta:**

1. **Nuevo adapter `apps/gateway-api/src/openclaw-ssh-bridge.ts`:**
   - Constructor: `{ sshHost, sshUser, sshKey, containerId, timeoutMs }`.
   - Método `sendMessage(msg: ChatSendRequest): Promise<{ msgId, queued: true }>`:
     - Ejecuta `ssh ... docker exec ${containerId} openclaw gateway call chat.send --json '{msgId, actor, text, context}'`.
     - Parsea stdout, valida `status === "started"`.
     - Devuelve ACK con el msgId enviado.
   - Método `streamHistory(msgId: string, opts: { onDelta, onDone, signal }): Promise<void>`:
     - Polling cada 500ms vía `ssh ... docker exec ${containerId} openclaw gateway call chat.history --json '{since: lastTs}'`.
     - Detecta mensajes con role `assistant` y status `done`.
     - Emite eventos `ASSISTANT_TYPING` / `ASSISTANT_DELTA` / `ASSISTANT_DONE` simulados al panel via WSS.
     - Abandona después de timeoutMs (default 60s) emitiendo `ASSISTANT_BLOCKED` con reason `ssh_timeout`.

2. **Conmutación en main.ts:**
   - Si `OPENCLAW_BRIDGE_KIND=ssh` en env → usar SSH adapter.
   - Si `OPENCLAW_BRIDGE_KIND=http` o default → seguir intentando HTTP (que sigue dando 502).
   - Si `OPENCLAW_BRIDGE_KIND=ssh` pero SSH falla 3 veces consecutivas → fallback automático a HTTP (que devolverá 502 → panel ve `✕ offline` como hasta ahora).

3. **Env required:**
   ```
   OPENCLAW_BRIDGE_KIND=ssh
   OPENCLAW_SSH_HOST=2.24.223.240
   OPENCLAW_SSH_PORT=22
   OPENCLAW_SSH_USER=root
   OPENCLAW_SSH_KEY_PATH=~/.ssh/openclaw-hostinger
   OPENCLAW_CONTAINER_ID=openclaw-dtsf-openclaw-1
   ```

4. **Tests:**
   - Mock del exec spawn. Verificar que el SSH adapter parsea `status: started` correctamente.
   - Verificar que polling chat.history detecta `done` y emite ASSISTANT_DONE.
   - Verificar que después de N timeouts hace fallback a HTTP.

5. **Documentar la limitación claramente en código y RESULT:**
   - SSH es frágil: depende de que la key esté presente, que el container esté corriendo, que docker exec no tenga rate limit.
   - Latencia 200-500ms peor que HTTP nativo.
   - **No es producción**. Se reemplaza cuando Hostinger entregue el bridge HTTP real.

**Bonus si hay tiempo:**
- Logging del SSH command y exit code en audit chain (`oc.chat.ssh_bridge.invoke`).
- Métrica de éxito/fallo SSH últimas 24h para que el panel pueda mostrar "bridge degradado" si hay muchos timeouts.

---

## Coordinación con Claude

Claude trabaja en paralelo en:
- Refinar UI Infrastructure feature (drilldown rich, ya consume el contract que Codex hizo en Bloque 3).
- Adaptar UI cuando T1 multi-cuenta esté pusheado (Provider.id ahora es `webdock-${accountId}` en lugar de `webdock-bridge`).
- Cleanup de hardcodeo restante en otras features.

Claude NO toca:
- `packages/adapters/` (Codex)
- `packages/domain/src/infrastructure-inventory.ts` (Codex extiende si necesario)
- `apps/gateway-api/` (Codex)

Si Codex necesita un cambio del front (improbable), avisar antes para evitar conflict.

## Verificación final esperada

Codex publica `DOCUMENTACION/OPS_CODEX_BLOQUE_4_RESULT_2026_05_24.md` con:
- T1: SHA commit del multi-cuenta. Ejemplo curl que muestre 3 providers Webdock separados con counts distintos.
- T2: SHA commit del SSH bridge. Smoke test desde gateway local apuntando al container — `curl localhost:3000/v1/openclaw/chat/send` con auth ahora debe devolver `{ msgId, queued: true }` REAL si las creds SSH están bien.
- `npm test` clean.
- Tiempo aproximado: T1 ~2h, T2 ~3-4h.
