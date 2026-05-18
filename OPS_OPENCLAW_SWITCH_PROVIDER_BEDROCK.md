# OPS · Cambiar provider OpenClaw a Amazon Bedrock (Anthropic)

> Operación supervisada. Decisión del operador 2026-05-18.
> Razón: budget Nexos (USD 5) agotado + ganancia de control AWS-nativo,
> billing centralizado + region pinning + IAM granular.
> **Reemplaza** el OPS anterior `OPS_OPENCLAW_SWITCH_PROVIDER_ANTHROPIC.md`
> (no se aplicó). El operador ya tiene credenciales Bedrock.

## Contexto

- Estado actual: `provider=nexos`, error 402 budget reached.
- Estado destino: `provider=bedrock`, `model=anthropic.claude-sonnet-4-6-...`,
  región AWS (a confirmar por operador, default `us-east-1`).
- Container: `openclaw-dtsf-openclaw-1` en VPS `2.24.223.240`.
- Túnel local activo: `http://127.0.0.1:61175`.
- AI provider: **AWS Bedrock**, modelo **Claude Sonnet 4.6**.

## Por qué Bedrock vs Anthropic directo

| Dimensión | Bedrock | Anthropic directo |
| --- | --- | --- |
| Billing | AWS console (consolidado con todo lo demás) | Anthropic console separado |
| Control de costo | AWS Budgets + Cost Anomaly Detection | Spending limit del workspace |
| Auth | IAM (granular) o Bedrock API keys | API key Anthropic |
| Region pinning | Sí (regulatorio importante) | Limitado |
| Audit | CloudTrail (toda llamada queda en AWS) | Anthropic logs |
| Same model? | Sí, Anthropic vía Bedrock | Sí, Anthropic directo |
| Costo | +0-10% según región vs Anthropic puro | base |
| Cross-region inference | Sí, con inference profiles `us.*` `eu.*` | N/A |

Para Delivrix con audit log estricto (Doc 8) y compliance (Doc 5 §[8]),
Bedrock + CloudTrail da una capa extra de evidencia auditable.

## Modelo recomendado: Claude Sonnet 4.6

Precios literales (archivo `Precios de Amazon Bedrock – AWS.html` provisto
por operador 2026-05-18):

| Modelo | Input/1M | Output/1M | Cache write/1M | Cache read/1M |
| --- | --- | --- | --- | --- |
| **Claude Sonnet 4.6** ← elegido | USD 3.00 | USD 15.00 | USD 3.75 | USD 0.30 |
| Claude Haiku 4.5 | USD 1.00 | USD 5.00 | USD 1.25 | USD 0.10 |
| Claude Opus 4.6 | USD 5.00 | USD 25.00 | USD 6.25 | USD 0.50 |

**Decisión**: Sonnet 4.6 como modelo único en Hito 5.11.B. Estrategia
híbrida (Sonnet + Haiku) queda agendada para 5.11.C si costo excede
USD 100/mes (umbral del contrato §11.3 Doc 1).

Cross-region inference (+10% por habilitar `us.*` profile): se evalúa
después del primer mes con datos reales de carga.

## Gates duros para esta operación

- Las credenciales AWS (Access Key ID, Secret Access Key, o Bedrock API key)
  **NUNCA** se pegan en chat ni se commitean al repo.
- El operador genera/usa credenciales en su consola AWS, Codex solo recibe
  confirmación de que están cargadas.
- Después del cambio, audit `oc.provider.switched` con `fromProvider=nexos`,
  `toProvider=bedrock`, `toModel=anthropic.claude-sonnet-4-6`, `actorId` del
  operador, `awsRegion`, `awsAccountId` (último opcional pero útil).
- Si smoke falla → rollback inmediato a Nexos (aunque budget=0, estado
  conocido) + audit `oc.provider.switch_reverted`.
- AWS Budget de USD 100/mes con alertas 50%/80%/95% configurado **antes**
  del primer smoke (gate de costo).

## Paso 1 — Operador prepara la cuenta AWS

Acciones humanas en https://console.aws.amazon.com . Solo el operador.

### 1.1 Habilitar Model Access en Bedrock

1. Console AWS → **Bedrock** → región (recomendado `us-east-1` o `us-west-2`,
   donde Anthropic tiene mejor disponibilidad).
2. **Model access** (sidebar izquierdo) → **Manage model access**.
3. Marcar:
   - ✅ Anthropic · Claude Sonnet 4.6
   - ✅ Anthropic · Claude Haiku 4.5 (para futuro, sin costo si no se usa)
4. Save / Request access. La aprobación de Anthropic en Bedrock es
   típicamente instantánea, ocasionalmente toma minutos.

### 1.2 Configurar AWS Budgets (gate de costo blindado)

1. Console AWS → **Billing & Cost Management** → **Budgets** → **Create budget**.
2. Tipo: **Cost budget**.
3. Configuración:
   - Name: `delivrix-openclaw-monthly-cap`
   - Period: Monthly
   - Budget amount: **USD 100**
   - Cost types: filtrar por service = `Amazon Bedrock`
4. Alerts:
   - 50% → email del operador
   - 80% → email del operador + (opcional) SNS topic
   - 95% → email + SNS + acción automática `BudgetActions` que **deshabilita
     el IAM user/policy de Bedrock** (gate duro pre-overrun). Esto requiere
     configurar `AWSBudgetsActionsServiceRolePolicy`.
5. Save.

> Si el operador no quiere configurar BudgetActions automáticas en este
> paso, mínimo deja los 3 emails. El gate manual queda: si llega el 95%,
> el operador rota la key.

### 1.3 Credenciales AWS para OpenClaw

El operador escoge **una** de las dos opciones:

#### Opción A — Bedrock API key (recomendada para MVP, más simple)

Las Bedrock API keys son tokens long-lived específicos para Bedrock
(lanzadas por AWS recientemente, equivalente conceptual a una API key
tradicional pero scoped a Bedrock).

1. Console AWS → **Bedrock** → **API keys** (sidebar) → **Create API key**.
2. Name: `delivrix-openclaw-bedrock-2026-05`
3. Expiration: 90 días (rota cada trimestre).
4. Permissions: solo `bedrock-runtime:InvokeModel` y
   `bedrock-runtime:InvokeModelWithResponseStream` sobre los modelos
   habilitados en 1.1 (Sonnet 4.6 + Haiku 4.5).
5. Copiar la key una vez. Guardarla en password manager del operador.
6. Variable de entorno destino: `AWS_BEARER_TOKEN_BEDROCK`.

#### Opción B — IAM credentials clásicas (más granular)

1. Console AWS → **IAM** → **Users** → **Create user**.
2. Name: `delivrix-openclaw-prod`.
3. Permissions: Crear policy custom con principio de mínimo privilegio:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": [
         "bedrock:InvokeModel",
         "bedrock:InvokeModelWithResponseStream"
       ],
       "Resource": [
         "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6-*",
         "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-*",
         "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6-*"
       ]
     }]
   }
   ```
4. Crear **Access keys** para el user → tipo "Third-party service".
5. Copiar `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` una sola vez.
6. Variables de entorno destino: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `AWS_REGION` (ej `us-east-1`).

> Para MVP recomiendo Opción A (Bedrock API key). Menos cosas que rotar,
> scope ya limitado a Bedrock por diseño. Opción B es mejor para producción
> con auditoría granular de AWS sobre cada InvokeModel call.

## Paso 2 — Cargar credenciales al container (operador)

> Codex NO ve los valores. Solo confirma que existen en env.

### Opción preferida: UI de OpenClaw

1. Abrir `http://127.0.0.1:61175` (vía túnel SSH).
2. Login con gateway token.
3. **Settings → Providers**:
   - Disable: `nexos` (no borrar, deja inactivo para rollback)
   - Enable: `bedrock`
   - Selección credenciales según opción de §1.3:
     - **Opción A**: campo "Bedrock API Key" → pegar
     - **Opción B**: campos "AWS Access Key ID", "AWS Secret Access Key",
       "AWS Region"
   - Region: `us-east-1` (recomendado para MVP, mejor disponibilidad Sonnet 4.6)
   - Model default: `anthropic.claude-sonnet-4-6-20250514-v1:0`
     (verificar ID exacto en console Bedrock → Foundation models →
     Claude Sonnet 4.6 → copy model ID; el ID puede variar levemente
     con la fecha del release)
   - Max tokens response: 4096
   - Temperature: 0.2
4. Save.

### Opción alternativa: env vars en el container

Si la UI no expone Bedrock explícitamente (depende de la versión de
hvps-openclaw):

```bash
ssh root@2.24.223.240
# Espacio inicial evita HISTSIZE
 export AWS_BEARER_TOKEN_BEDROCK='<key opción A>'
# o:
 export AWS_ACCESS_KEY_ID='<key opción B>'
 export AWS_SECRET_ACCESS_KEY='<secret opción B>'
 export AWS_REGION='us-east-1'

docker exec openclaw-dtsf-openclaw-1 sh -c "
  cat > /etc/openclaw/providers.env <<'ENV'
# Bedrock provider config (Delivrix Hito 5.11.B switch)
AWS_BEARER_TOKEN_BEDROCK=$AWS_BEARER_TOKEN_BEDROCK
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6-20250514-v1:0
BEDROCK_MAX_TOKENS=4096
BEDROCK_TEMPERATURE=0.2
ENV
  # OpenClaw lee este file en el boot del proceso node server.mjs
"

# Limpiar de la sesión bash inmediato
unset AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
exit
```

## Paso 3 — Codex: validar y reiniciar (sin tocar credenciales)

```bash
# 3.1 — Confirmar env vars presentes (NO imprimir valores)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  ok=0
  if env | grep -q "^AWS_BEARER_TOKEN_BEDROCK="; then
    echo "ok: AWS_BEARER_TOKEN_BEDROCK presente"
    ok=1
  fi
  if env | grep -q "^AWS_ACCESS_KEY_ID="; then
    echo "ok: AWS_ACCESS_KEY_ID presente"
    ok=1
  fi
  if env | grep -q "^AWS_REGION="; then
    echo "ok: AWS_REGION = $(printenv AWS_REGION)"
  else
    echo "warn: AWS_REGION ausente, usando default us-east-1"
  fi
  if env | grep -q "^BEDROCK_MODEL_ID="; then
    echo "ok: BEDROCK_MODEL_ID = $(printenv BEDROCK_MODEL_ID)"
  fi
  [ $ok -eq 1 ] || { echo "FAIL: ninguna credencial Bedrock encontrada"; exit 1; }
'

# 3.2 — Confirmar provider config actual en OpenClaw
docker exec openclaw-dtsf-openclaw-1 sh -c '
  cat /etc/openclaw/providers.json 2>/dev/null | jq "{active, defaults}" || \
  cat /openclaw/config/providers.yaml 2>/dev/null
'
# Esperado: "active": "bedrock", "defaults.bedrock.model": "anthropic.claude-sonnet-4-6-..."

# 3.3 — Reload del agent loop
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)" \
  || docker restart openclaw-dtsf-openclaw-1

# 3.4 — Esperar healthy
sleep 5
docker ps --filter "name=openclaw" --format "{{.Status}}"

# 3.5 — Verificar que NO quedan referencias a Nexos en logs recientes
docker logs --since 1m openclaw-dtsf-openclaw-1 2>&1 \
  | grep -iE "nexos|bedrock|aws|anthropic" | tail -20
```

## Paso 4 — Smoke test (Codex)

```bash
# 4.1 — Token del gateway
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

# 4.2 — Enviar mensaje de prueba
curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:bedrock-switch",
    "msgId": "smoke-2026-05-18-bedrock",
    "message": {
      "role": "user",
      "content": "Test post-switch a Bedrock. Responde exactamente: PROVIDER_SWITCH_OK_BEDROCK"
    }
  }'

# 4.3 — Recuperar respuesta
sleep 6
docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:bedrock-switch/history" \
  | jq '.messages[-1]'

# Esperado:
#   { "role": "assistant", "content": "PROVIDER_SWITCH_OK_BEDROCK",
#     "status": "completed", "metadata": { "provider": "bedrock",
#     "model": "anthropic.claude-sonnet-4-6-...", "tokensUsed": N } }
#
# Errores comunes y diagnóstico:
# - "Could not load credentials" → revisar Paso 3.1 (env vars no cargadas)
# - "AccessDeniedException: model access not granted" → revisar Paso 1.1
#   (Model access en console Bedrock)
# - "ValidationException: invalid model ID" → ID incorrecto, verificar en
#   console Bedrock → Foundation models → copy model ID
# - "ThrottlingException" → cuota AWS, esperar y reintentar
# - "BudgetExceeded" simulado → si AWS Budget BudgetActions disparó
```

## Paso 5 — Smoke 2: identidad + gates (Codex)

```bash
curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:identity-bedrock",
    "msgId": "smoke-identity-bedrock-'$(date +%s)'",
    "message": {
      "role": "user",
      "content": "¿Quién eres y qué gates del MVP recuerdas? Lista al menos 5 prohibiciones del norte. Responde corto."
    }
  }'

sleep 10

docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:identity-bedrock/history" \
  | jq '.messages[-1].content'

# Esperado: respuesta menciona "OpenClaw", "senior SRE Delivrix" y
# al menos 5 prohibiciones del norte:
#   - SSH automático
#   - Proxmox live mutation
#   - DNS live changes
#   - SMTP real
#   - NFC production writes
#   - auto-promoción ML
#
# Si la respuesta es genérica ("soy un asistente AI", "no tengo info de
# Delivrix"), el system prompt + workspace docs NO se cargaron.
# Investigar /data/.openclaw/workspace/ + BOOTSTRAP.md desactivado.
```

## Paso 6 — Auditar el cambio (Codex)

```bash
mkdir -p "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.audit"

cat >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/openclaw-provider-switches.jsonl" <<EOF
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"operator","actorId":"juanes@delivrix","action":"oc.provider.switched","targetType":"openclaw_agent","targetId":"openclaw-hostinger-prod","decision":"n/a","humanApproved":true,"approverIds":["juanes@delivrix"],"killSwitchState":"armed","schemaVersion":"2026-05-18.v1","metadata":{"fromProvider":"nexos","fromModel":"09f434cd-5610-419a-8962-0d71b86027d9","toProvider":"bedrock","toModel":"anthropic.claude-sonnet-4-6-20250514-v1:0","awsRegion":"us-east-1","credentialsType":"bedrock_api_key_or_iam","spendingLimitUsdMonth":100,"budgetActionConfigured":true,"reason":"nexos_budget_exhausted_+_aws_native_billing_+_cloudtrail_audit"},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
EOF
```

## Paso 7 — Actualizar Notion (Codex)

Tarjeta en `🐛 Bugs & Blockers`:

```python
flag_issue(
  issue_title="Provider AI cambiado: Nexos → Amazon Bedrock (Anthropic)",
  category="Agent Error",
  severity="Medium",
  affected_server="openclaw-hostinger-prod (2.24.223.240)",
  description="""
Razón: budget Nexos USD 5 agotado + ganancia de control AWS-nativo
(billing centralizado, CloudTrail audit, region pinning, IAM granular).
Decisión: operador autorizó cambio 2026-05-18.

Nuevo provider: Amazon Bedrock
Nuevo modelo: anthropic.claude-sonnet-4-6-20250514-v1:0
Región AWS: us-east-1
Credenciales: Bedrock API key (Opción A) o IAM access keys (Opción B)
Spending limit: USD 100/mes vía AWS Budgets con alertas 50/80/95%
BudgetAction: deshabilita IAM al 95% (gate automático de costo)
Audit ref: .audit/openclaw-provider-switches.jsonl
Costo proyectado MVP: ~USD 0.012/llamada Sonnet 4.6, monitorear primera semana.
Smoke 1 (PROVIDER_SWITCH_OK_BEDROCK): pass
Smoke 2 (identidad + gates): pass

Status: RESOLVED, agente vivo con personalidad senior SRE en Bedrock.
"""
)
```

Status inicial `Open` → `Resolved` después del smoke OK.

## Paso 8 — Rollback si el smoke falla

```bash
# Reactivar Nexos como provider activo (estado conocido aunque budget=0)
docker exec openclaw-dtsf-openclaw-1 sh -c '
  # Restaurar config previa
'

docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f \"node server.mjs\" | head -1)"

# Audit del rollback
cat >> "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/openclaw-provider-switches.jsonl" <<EOF
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"operator","actorId":"juanes@delivrix","action":"oc.provider.switch_reverted","targetType":"openclaw_agent","targetId":"openclaw-hostinger-prod","decision":"n/a","humanApproved":true,"approverIds":["juanes@delivrix"],"killSwitchState":"armed","schemaVersion":"2026-05-18.v1","metadata":{"fromProvider":"bedrock","toProvider":"nexos","reason":"smoke_test_failed","errorClue":"<resumen del error>"},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
EOF

# Codex reporta logs sin imprimir credenciales
docker logs --since 5m openclaw-dtsf-openclaw-1 2>&1 \
  | grep -iE "bedrock|aws|invalid|error|denied|throttle" \
  | sed -E 's/(AKIA[0-9A-Z]{16,})/****REDACTED****/g' \
  | sed -E 's/(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/****REDACTED_JWT****/g' \
  | tail -30
```

## Reporte de cierre al operador (cuando todo OK)

```
[2026-05-18T??:??Z] OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK completado
Provider: nexos (disabled) → bedrock (active)
Modelo: anthropic.claude-sonnet-4-6-20250514-v1:0
Región AWS: us-east-1
Credenciales: Bedrock API key | IAM (operator confirma cuál usó)
AWS Budget: USD 100/mes con BudgetAction al 95% (kill IAM)
Smoke 1 (PROVIDER_SWITCH_OK_BEDROCK): pass
Smoke 2 (identity + gates): pass — listó 5+ prohibiciones del norte
Audit: .audit/openclaw-provider-switches.jsonl#<uuid>
Notion: <URL del bug resuelto>
Estado: agent vivo en Bedrock con personalidad senior SRE.

Costo observado en smokes: ~XXX tokens input + YYY tokens output ≈ USD 0.00X
Próximo cap check: 24h post-deploy revisar AWS Cost Explorer
```

## Próximo paso (después de éxito)

Una vez OpenClaw responde en Bedrock, arranca el **D+1 PM del cronograma**
del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`:

- Verificar `/data/.openclaw/workspace/` tiene los docs que Codex ya instaló
  (AGENTS, IDENTITY, SOUL, PERMISSIONS_MATRIX, SKILLS_CATALOG).
- Validar respuesta a "qué gates tiene el MVP" lista los 31 correctos del norte.
- Pasar a D+2 AM: build de KB Capa 2 con ChromaDB + métricas RAG.

Y un nuevo gate operativo permanente:

- **Cost monitor**: cron diario que lee AWS Cost Explorer API y emite
  audit `oc.cost.daily_check` con `usdToday`, `usdMonthToDate`, `projectedMonth`.
  Si `projectedMonth > 100` → alerta en Notion + considerar estrategia
  híbrida Sonnet + Haiku (Hito 5.11.C).

## Diferencias clave vs el OPS Anthropic anterior (referencia)

| Aspecto | Anthropic directo (anterior) | Bedrock (este doc) |
| --- | --- | --- |
| Console | console.anthropic.com | console.aws.amazon.com |
| Credenciales | `ANTHROPIC_API_KEY` | `AWS_BEARER_TOKEN_BEDROCK` o `AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY` |
| Modelo ID | `claude-sonnet-4-6` | `anthropic.claude-sonnet-4-6-20250514-v1:0` |
| Region pinning | No | Sí (`AWS_REGION`) |
| Spending cap | Anthropic spending limit | AWS Budgets + BudgetActions |
| Audit extra | Solo logs Anthropic | CloudTrail (todas las InvokeModel) |
| Cross-region | N/A | Inference profiles `us.*` (+10%) |
| Cuota gestión | Anthropic Usage Tier | AWS Service Quotas |
