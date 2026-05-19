# OPS · Diagnosticar agente OpenClaw que responde vacío

> Operación supervisada — Codex en host. **No** ejecutar acciones que
> muten infraestructura sin autorización. Pasos en orden, capturar
> evidencia, reportar hallazgos al operador antes de aplicar fixes.

## Contexto

Servidor OpenClaw: `root@2.24.223.240` (VPS Hostinger).
Container: `openclaw-dtsf-openclaw-1` (imagen `ghcr.io/hostinger/hvps-openclaw:latest`).
URL pública: `http://2.24.223.240:61175`.
Gateway interno: `127.0.0.1:18789` dentro del container.

**Síntoma reportado por operador (2026-05-18 ~02:50 UTC):**

- WebSocket al gateway acepta `chat.send`.
- Mensaje enviado con sessionKey `agent:main:main`, msgId `e7a6966f-de00-4f73-943e-56bd84de9c20`.
- OpenClaw **no devolvió** `HEARTBEAT_OK` después del envío.
- `sessions.list` marca la sesión como `failed`.
- La sesión muestra el `user` message pero `assistant` con respuesta vacía.

**Conclusión preliminar:** transport OK, modelo fallando. Las causas
más probables, en orden de frecuencia, son:

1. **AI provider no configurado o sin credits** — sin API key/credits
   válidos para Anthropic/OpenAI, OpenClaw acepta el chat pero el run
   del agente falla silenciosamente.
2. **Rate limit / cuota del provider** — la cuenta excedió el límite.
3. **Modelo solicitado no disponible** — la sesión pide un modelo que
   el provider ya no expone (deprecación) o que el plan no incluye.
4. **Red bloqueada hacia el provider** — la VPS no resuelve
   `api.anthropic.com` o `api.openai.com`.
5. **Skill o plugin custom rompiendo el handler** — alguna extensión
   instalada está lanzando excepción en el agent loop.
6. **Token contextual excedido** — sesión con historial muy largo.

## Fase 1 — Capturar evidencia (read-only)

> Estos comandos solo leen. No mutan estado. Capturar todo el output
> en un archivo que se adjunta al issue de Notion / commit.

```bash
ssh root@2.24.223.240

# 1.1 — Estado del container
docker ps -a --filter "name=openclaw" \
  --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Ports}}"

# 1.2 — Últimas 200 líneas de log del container, buscando errores
docker logs --tail 200 openclaw-dtsf-openclaw-1 2>&1 | \
  grep -iE "error|fail|exception|warn|cannot|missing|quota|rate|denied|unauthorized|timeout|model|provider|anthropic|openai" \
  | tail -80

# 1.3 — Log completo de los últimos 5 min para correlacionar con el msgId del operador
docker logs --since 5m openclaw-dtsf-openclaw-1 2>&1 \
  | grep -F "e7a6966f-de00-4f73-943e-56bd84de9c20" \
  || echo "msgId no aparece en logs recientes — verificar timestamps"

# 1.4 — Configuración de provider AI (solo nombres, no valores)
docker exec openclaw-dtsf-openclaw-1 env \
  | awk -F= '{print $1}' \
  | grep -iE "anthropic|openai|model|provider|llm|ai_|claude|gpt" \
  || echo "no hay env vars de provider AI"

# 1.5 — Archivos de config dentro del container
docker exec openclaw-dtsf-openclaw-1 sh -c '
  for dir in /app /openclaw /data /config; do
    if [ -d "$dir" ]; then
      echo "--- $dir ---"
      ls -la "$dir" 2>/dev/null | head -30
    fi
  done
'

# 1.6 — Salud del gateway interno (debe responder algo, aunque sea 401)
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -o /dev/null -w "gateway_interno=%{http_code}\n" \
    http://127.0.0.1:18789/health \
  || echo "gateway interno no responde"

# 1.7 — Resolución DNS y red hacia providers (no autenticado, solo conectividad)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  for host in api.anthropic.com api.openai.com generativelanguage.googleapis.com; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "https://$host/" 2>/dev/null || echo "fail")
    echo "$host -> $code"
  done
'
```

**Capturar el output completo de Fase 1 antes de avanzar.** Si algo
ya es obvio en Fase 1, saltar a la sección de fix correspondiente.

## Fase 2 — Inspeccionar la sesión fallida específicamente

```bash
# 2.1 — Si hay endpoint admin para sessions, listarlas (usar gateway token desde env del container)
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 sh -c '
  printenv GATEWAY_TOKEN || \
  printenv OPENCLAW_GATEWAY_TOKEN || \
  printenv OC_GATEWAY_TOKEN || \
  printenv ADMIN_TOKEN || \
  echo ""
')

if [ -z "$GW_TOKEN" ]; then
  echo "Token no encontrado en env. Buscar en archivos:"
  docker exec openclaw-dtsf-openclaw-1 sh -c '
    grep -RIlE "GATEWAY_TOKEN|gatewayToken|adminToken" /app /openclaw /config 2>/dev/null | head -5
  '
else
  echo "Token disponible en env."

  # Sessions list (ajustar path real según UI muestre)
  docker exec openclaw-dtsf-openclaw-1 \
    curl -s -H "Authorization: Bearer $GW_TOKEN" \
      http://127.0.0.1:18789/api/sessions \
    | head -c 2000

  # Detalle de la sesión failed
  docker exec openclaw-dtsf-openclaw-1 \
    curl -s -H "Authorization: Bearer $GW_TOKEN" \
      "http://127.0.0.1:18789/api/sessions/agent:main:main/history" \
    | head -c 2000
fi
```

## Fase 3 — Diagnóstico por escenario

### Escenario A — Sin AI provider configurado

**Síntoma en Fase 1.4:** no aparecen env vars con `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` ni equivalentes. **Síntoma en logs:** mensajes tipo
*"no model configured"*, *"missing provider"*, *"AI credits required"*.

**Acción supervisada** (requiere confirmación del operador antes de
ejecutar): abrir la UI de OpenClaw en navegador
(`http://2.24.223.240:61175`) y configurar provider AI desde el panel.
Tres opciones:

1. **Hostinger AI credits**: si el plan de la VPS incluye créditos
   pre-pagados, activarlos desde hPanel → OpenClaw → Credits. No
   requiere API key externa.
2. **API key propia de Anthropic**: generar en `console.anthropic.com`
   con permisos mínimos, pegarla en la UI de OpenClaw (Settings →
   Providers → Anthropic). Guardar como secret en el container.
3. **API key propia de OpenAI**: ídem en `platform.openai.com`.

Después de configurar, reiniciar agent loop:

```bash
# Reload sin perder sesiones (si OpenClaw lo soporta)
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)" \
  || docker restart openclaw-dtsf-openclaw-1
```

### Escenario B — Provider configurado pero sin créditos / 401 / 403

**Síntoma en Fase 1.2:** errores `401 Unauthorized`, `403 Forbidden`,
`quota_exceeded`, `insufficient_credits`.

**Acción:**
- Verificar saldo del provider (Anthropic console, OpenAI dashboard,
  Hostinger hPanel).
- Si la key está revocada/rotada, regenerar y actualizar.
- **No** rotar credenciales desde Codex sin orden explícita del operador.

### Escenario C — Modelo no disponible / deprecado

**Síntoma en Fase 1.2:** errores `model not found`, `model deprecated`,
`invalid model id`.

**Acción:**
- Localizar config de sesión con el modelo solicitado:
  ```bash
  docker exec openclaw-dtsf-openclaw-1 sh -c '
    grep -RIE "model.*:" /app /openclaw /config 2>/dev/null | head -20
  '
  ```
- Reportar al operador qué modelo está pidiendo. **No** cambiarlo
  silenciosamente. Documentar la propuesta y esperar visto bueno.

### Escenario D — Red bloqueada hacia el provider

**Síntoma en Fase 1.7:** `fail` o códigos `000` contra
`api.anthropic.com` / `api.openai.com`.

**Acción:**
- Verificar reglas de firewall de Hostinger (iptables/ufw) en la VPS:
  ```bash
  ufw status verbose || iptables -L OUTPUT -v -n | head -30
  ```
- Si hay regla de salida bloqueando 443, reportar al operador
  (probablemente fue una mitigación de abuso). No abrir reglas sin
  autorización.

### Escenario E — Skill o plugin custom rompiendo el agent

**Síntoma en Fase 1.2:** stack traces de JavaScript, errores de
plugins, *"Cannot read property X of undefined"* dentro de un
plugin TS.

**Acción:**
- Identificar plugin culpable en el stack trace.
- Listar plugins instalados:
  ```bash
  docker exec openclaw-dtsf-openclaw-1 sh -c '
    ls -la /app/plugins /openclaw/plugins /data/plugins 2>/dev/null
  '
  ```
- Reportar al operador. Si fue un plugin recién agregado, **proponer**
  deshabilitarlo (mover fuera del directorio + reload), no eliminarlo.

## Fase 4 — Validación post-fix

Después de aplicar el fix correspondiente:

```bash
# 4.1 — Container vivo
docker ps --filter "name=openclaw" --format "{{.Status}}"

# 4.2 — Log limpio durante 30s
timeout 30 docker logs -f openclaw-dtsf-openclaw-1 2>&1 | \
  grep -iE "error|fail" || echo "limpio"

# 4.3 — Enviar otro chat de prueba (el operador hace esto, no Codex)
#    desde el cliente WebSocket que ya tiene configurado, con un
#    msgId nuevo. Verificar que regrese HEARTBEAT_OK + respuesta
#    assistant no vacía.

# 4.4 — Confirmar que la sesión queda en estado `running` o
#    `completed`, no `failed`.
```

## Fase 5 — Reporte al operador

Codex entrega al operador:

1. **Output de Fase 1 completo** (sin secretos — censurar valores de
   env vars que contengan token/key/secret antes de pegar).
2. **Escenario identificado** (A, B, C, D, o E).
3. **Fix propuesto** sin ejecutarlo todavía si toca infraestructura,
   network, o credenciales.
4. **Riesgos del fix** y rollback.
5. **Pregunta explícita: ¿procedemos?**

Una vez el operador autoriza, aplicar el fix, correr Fase 4 y
documentar el resultado en `DOCUMENTACION/OPS_OPENCLAW_INCIDENT_LOG.md`
con timestamp, hallazgo, fix y validación.

## Gates duros (no romper)

- **No** pegar credenciales (tokens, API keys, passwords) en el output
  que regresa Codex al chat. Censurar siempre.
- **No** modificar configuración del container ni de la VPS sin
  autorización explícita del operador.
- **No** ejecutar `docker rm`, `docker volume rm`, ni borrar archivos
  de `/data`, `/openclaw`, `/app` bajo ninguna circunstancia.
- **No** rotar credenciales del provider sin que el operador confirme.
- **No** abrir reglas de firewall sin autorización.
- **Sí** capturar evidencia (logs, configs, env names) en read-only.
- **Sí** proponer fixes con su rollback antes de aplicar.

## Salida esperada

Cuando el agente vuelva a responder, queda como evidencia:

- Un commit en el worktree con `OPS_OPENCLAW_INCIDENT_LOG.md`
  actualizado.
- La env var del provider AI (si fue Escenario A/B) referenciada por
  nombre, no por valor.
- Una sesión de prueba `agent:main:main` exitosa con su `msgId` y
  el contenido truncado del assistant para mostrar que responde.

Con eso, el siguiente paso del proyecto (cablear las skills
`delivrix-fleet-ops`, `delivrix-alert-ops`, `delivrix-report-ops`)
puede arrancar.
