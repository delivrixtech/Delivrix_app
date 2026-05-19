# OPS · Cambiar provider OpenClaw a Anthropic API propia

> Operación supervisada. Autorización firmada por operador 2026-05-18.
> Razón: budget Nexos (USD 5) agotado + ganar control de costo, modelo y
> trazabilidad. Cumple norte: cambio de provider/modelo con aprobación
> humana explícita.

## Contexto

- Estado actual: `provider=nexos`, `model=09f434cd-5610-419a-8962-0d71b86027d9`, error 402 budget reached.
- Estado destino: `provider=anthropic`, `model=claude-sonnet-4-6`.
- Container: `openclaw-dtsf-openclaw-1` en VPS `2.24.223.240`.
- Túnel local activo: `http://127.0.0.1:61175` (Codex ya lo montó).

## Gates duros para esta operación

- La API key de Anthropic NUNCA se pega en chat ni se commitea al repo.
- La generación de la API key la hace el **operador**, no Codex.
- Codex solo recibe el path donde está guardada o le pasa el operador la
  key vía mecanismo seguro (env del container directo o secret manager).
- Después del cambio, el audit log debe registrar `oc.provider.switched`
  con `fromProvider`, `toProvider` y el `actorId` del operador.
- Si el smoke post-cambio falla, rollback inmediato: restaurar config
  previa Nexos (aunque el budget esté en 0, queda el rastro).

## Paso 1 — Operador genera la API key en Anthropic

Acción humana, fuera del control de Codex:

1. Login en https://console.anthropic.com
2. Workspaces → escoger o crear `Delivrix MVP`
3. **Settings → Limits** del workspace:
   - Spending limit: **USD 100/mes** (techo blindado del contrato §11.3 Doc 1)
   - Alerts: 50%, 80%, 95% por email
4. **API Keys → Create Key**:
   - Name: `delivrix-openclaw-prod-2026-05`
   - Workspace: el creado arriba
   - Permissions: solo lo necesario (Read + Write para messages API, sin
     admin)
5. Copiar la key una vez. **Guardarla en gestor de contraseñas del
   operador.** NO en chat, NO en repo, NO en notas planas.

## Paso 2 — Cargar la key al container (operador en hPanel)

Opción preferida (UI de OpenClaw):

1. Abrir `http://127.0.0.1:61175` (vía túnel SSH ya montado por Codex).
2. Login con gateway token de OpenClaw.
3. **Settings → Providers**:
   - Disable: `nexos` (no se borra, solo se deja inactivo por si hay que
     volver con rollback)
   - Enable: `anthropic`
   - Pegar API key generada en Paso 1
   - Modelo default: `claude-sonnet-4-6`
   - Max tokens response: 4096 (suficiente para nuestras skills)
   - Temperature: 0.2 (operativo, no creativo)
4. Save.

Opción alternativa (env var del container, si la UI no expone Anthropic):

```bash
# Operador conecta y agrega env var sin que Codex vea el valor
ssh root@2.24.223.240
# El operador inyecta la key con un editor o con un comando que NO la
# escriba al historial bash (espacio inicial):
 export ANTHROPIC_API_KEY='<key>'   # ojo: espacio inicial evita HISTSIZE
docker exec openclaw-dtsf-openclaw-1 sh -c "
  if [ -f /etc/openclaw/providers.env ]; then
    grep -q '^ANTHROPIC_API_KEY=' /etc/openclaw/providers.env \
      && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY='\"\$ANTHROPIC_API_KEY\"'|' /etc/openclaw/providers.env \
      || echo \"ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY\" >> /etc/openclaw/providers.env
  fi
"
unset ANTHROPIC_API_KEY   # limpiar de la sesión bash inmediato
```

## Paso 3 — Codex: validar y reiniciar (sin tocar la key)

```bash
# 3.1 — Confirmar que la env quedó cargada (NO imprimir el valor)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  if env | grep -q "^ANTHROPIC_API_KEY="; then
    echo "ok: ANTHROPIC_API_KEY presente (****$(env | grep ^ANTHROPIC_API_KEY= | cut -c-30 | rev | cut -c1-4 | rev))"
  else
    echo "fail: ANTHROPIC_API_KEY no encontrada"
    exit 1
  fi
'

# 3.2 — Confirmar provider config actual
docker exec openclaw-dtsf-openclaw-1 sh -c '
  cat /etc/openclaw/providers.json 2>/dev/null | jq "{active, defaults}" || \
  cat /openclaw/config/providers.yaml 2>/dev/null
'

# 3.3 — Reload del agent loop sin reiniciar container completo
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)" \
  || docker restart openclaw-dtsf-openclaw-1

# 3.4 — Esperar a que el container vuelva healthy
sleep 5
docker ps --filter "name=openclaw" --format "{{.Status}}"
```

## Paso 4 — Smoke test (Codex en host)

```bash
# 4.1 — Verificar que la sesión acepta y responde no-vacío
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:provider-switch",
    "msgId": "smoke-2026-05-18-anthropic",
    "message": { "role": "user", "content": "Test post-switch. Responde exactamente: PROVIDER_SWITCH_OK" }
  }'

# 4.2 — Esperar respuesta vía sessions history (o WSS si Codex lo tiene)
sleep 6
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:provider-switch/history" \
  | jq '.messages[-1]'

# Esperado:
#   { "role": "assistant", "content": "PROVIDER_SWITCH_OK", "status": "completed", ... }
# Si content vacío o status="failed", abortar y rollback (Paso 7).
```

## Paso 5 — Auditar el cambio (Codex en host)

Emitir el evento canónico `oc.provider.switched` al audit log de
Delivrix. Si el Gateway local todavía no tiene el endpoint
`/v1/agent/audit/batch` implementado (es código que llega después),
emitir manualmente en JSONL local del worktree:

```bash
cat >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/openclaw-provider-switches.jsonl" <<EOF
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"operator","actorId":"juanes@delivrix","action":"oc.provider.switched","targetType":"openclaw_agent","targetId":"openclaw-hostinger-prod","decision":"n/a","humanApproved":true,"approverIds":["juanes@delivrix"],"killSwitchState":"armed","schemaVersion":"2026-05-18.v1","metadata":{"fromProvider":"nexos","fromModel":"09f434cd-5610-419a-8962-0d71b86027d9","toProvider":"anthropic","toModel":"claude-sonnet-4-6","reason":"nexos_budget_exhausted_+_better_traceability","spendingLimitUsdMonth":100},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
EOF
```

> `PENDING_CHAIN_BOOTSTRAP` es placeholder hasta que se implemente la
> chain SHA-256 del Doc 8. El evento queda registrado y se reindexa cuando
> Codex implemente el audit batch endpoint en el cronograma.

## Paso 6 — Actualizar Notion (Codex en host)

Crear tarjeta en `🐛 Bugs & Blockers` documentando el switch:

```python
flag_issue(
  issue_title="Provider AI cambiado: Nexos → Anthropic API propia",
  category="Agent Error",   # o crear "Provider Switch" si se desea
  severity="Medium",
  affected_server="openclaw-hostinger-prod (2.24.223.240)",
  description="""
Razón: budget Nexos USD 5 agotado + ganancia de trazabilidad.
Decisión: operador autorizó cambio 2026-05-18.
Nuevo provider: Anthropic Direct API
Nuevo modelo: claude-sonnet-4-6
Spending limit: USD 100/mes en console.anthropic.com
Audit ref: .audit/openclaw-provider-switches.jsonl
Status: RESOLVED, smoke test OK.
"""
)
```

Status inicial `Open` → `Resolved` después del smoke OK.

## Paso 7 — Rollback si el smoke falla

Si el Paso 4 devuelve `content` vacío o `status: failed`:

```bash
# Reactivar Nexos como provider activo (aunque budget esté en 0, vuelve
# al estado conocido y se evita estado intermedio inconsistente)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  # Restaurar config previa según UI o file de providers
  # (depende de cómo se hizo la edición en Paso 2)
'

docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f \"node server.mjs\" | head -1)"

# Audit del rollback
echo '{"id":"...","action":"oc.provider.switch_reverted","reason":"smoke_failed", ...}' \
  >> .audit/openclaw-provider-switches.jsonl

# Codex reporta al operador con logs del intento fallido
docker logs --since 5m openclaw-dtsf-openclaw-1 2>&1 | grep -iE "anthropic|401|invalid|error" | tail -30
```

Si rollback OK: el agente sigue offline (Nexos budget=0), pero estado
conocido. El operador decide siguiente paso (recargar Nexos como fallback,
investigar config Anthropic, etc.).

## Validación final post-éxito (Codex)

Cuando Paso 4 retorne `PROVIDER_SWITCH_OK`:

```bash
# 1. Una pregunta real del contrato operativo para verificar identidad y prompt
curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:identity-check",
    "msgId": "smoke-identity-$(date +%s)",
    "message": { "role": "user", "content": "¿Quién eres y qué gates del MVP recuerdas? Responde corto." }
  }'

sleep 8

# Esperado: respuesta menciona "OpenClaw", "senior SRE Delivrix",
# y al menos 5 de los 31 gates del norte (SSH automático, Proxmox live,
# DNS live, SMTP real, NFC production, etc).
# Si respuesta es genérica tipo "soy un asistente AI", el system prompt
# NO se cargó correctamente. Investigar BOOTSTRAP.md vs AGENTS.md.
```

## Reporte de cierre al operador

Cuando todo OK, Codex reporta:

```
[2026-05-18T??:??Z] OPS_OPENCLAW_SWITCH_PROVIDER_ANTHROPIC completado
Provider: nexos (disabled) → anthropic (active)
Modelo: claude-sonnet-4-6
Spending limit Anthropic: USD 100/mes
Smoke 1 (PROVIDER_SWITCH_OK): pass
Smoke 2 (identity + gates): pass
Audit: .audit/openclaw-provider-switches.jsonl#<uuid>
Notion: <URL del bug resuelto>
Estado: agent vivo y respondiendo con personalidad senior SRE.
```

## Próximo paso (después de éxito)

Una vez OpenClaw responde, arranca el **D+1 PM del cronograma** del
`HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`:

- Verificar build script de Capa 1 (knowledge base núcleo).
- Confirmar que `/data/.openclaw/workspace/` tiene los docs que Codex
  ya instaló (AGENTS, IDENTITY, SOUL, PERMISSIONS_MATRIX, SKILLS_CATALOG).
- Validar respuesta a "qué gates tiene el MVP" (los 31 listados correctos).
- Pasar a D+2 AM: build de KB Capa 2 con ChromaDB.
