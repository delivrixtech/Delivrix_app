# OPS · Setup AWS Bedrock via Codex CLI

> Directriz ejecutable para Codex desde el host del operador.
> Reemplaza la ejecución manual de
> `OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md` por automatización
> auditada usando AWS CLI con credenciales admin del operador.
> Resultado: policy + user + access keys + budget + budget action,
> todo en ~5 minutos, reproducible y trazable.

## Estado Codex 2026-05-18

Codex aterrizo una version ejecutable y segura del playbook en:

```bash
ops/openclaw-bedrock-aws-setup.sh
```

Uso esperado:

```bash
ops/openclaw-bedrock-aws-setup.sh \
  --operator-email "TU_EMAIL_AWS_BUDGETS" \
  --profile default \
  --region us-east-1
```

Mejoras frente al bloque Markdown original:

- No imprime Access Keys ni Secret Access Key; las escribe solo en
  `~/.aws-secrets/delivrix-openclaw-keys.txt` con `chmod 600`.
- Recibe el email del operador por argumento, sin placeholders
  `OPERATOR_EMAIL_REPLACE_ME`.
- Corrige el pre-flight de Bedrock: `list-foundation-models` no usa
  `--max-results`.
- Descubre el `modelId` real de Claude Sonnet 4.6 desde
  `list-foundation-models`; si no aparece, aborta antes de crear IAM.
- Audita cada recurso creado en `.audit/openclaw-bedrock-setup.jsonl`.
- Hace rollback automatico solo de recursos creados en este run si un
  paso posterior falla.

Bloqueos actuales detectados en el host:

- `aws` CLI no esta instalado globalmente, pero Codex instalo una copia
  local en `.venv-awscli/` y el script la usa via `python -m awscli`
  para evitar problemas por el espacio en la ruta `delivrix app`.
- No existe `~/.aws/`.
- No hay variables de entorno `AWS_*` cargadas en la sesion de Codex.

Por tanto, el script ya esta listo, pero no se puede ejecutar contra AWS
hasta configurar credenciales admin del operador.

## Gates duros (no negociables)

1. **Las Access Keys generadas NUNCA aparecen en el output normal de
   Codex.** Se escriben a un archivo `~/.aws-secrets/delivrix-openclaw-keys.txt`
   con `chmod 600` que el operador abre, copia al password manager y
   borra. No al chat. No al stdout permanente.
2. **Codex usa credenciales admin del operador previamente configuradas**
   (`aws configure` en el Mac, perfil `default` o un perfil dedicado).
   Codex NO genera, NO rota, NO toca esas credenciales admin.
3. **El Model Access (§1 del doc detallado) se sigue haciendo en
   consola web** porque requiere aceptar el EULA de Anthropic, lo cual
   no es API-callable. Codex valida que esté concedido antes de seguir.
4. **Si cualquier comando falla → abort + rollback** de los recursos
   ya creados en este run. No dejar estado intermedio.
5. **Cada acción emite audit local** en
   `.audit/openclaw-bedrock-setup.jsonl` con timestamp, comando
   (redactado para secrets) y resultado.
6. **Después del setup, Codex audita la creación y la operación queda
   firmada** con `actorId=juanes@delivrix` (autorización explícita
   2026-05-18) — pero la *ejecución técnica* es del system actor
   `codex@host`.

## Pre-flight (Codex ejecuta, sin necesitar input adicional)

```bash
set -euo pipefail

WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
AUDIT_DIR="${WORKTREE}/.audit"
SECRETS_DIR="${HOME}/.aws-secrets"
mkdir -p "${AUDIT_DIR}" "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# Vars del setup (NO secrets)
REGION="us-east-1"
ACCOUNT_ID="397450413307"
POLICY_NAME="DelivrixOpenClawBedrockInvoke"
DENY_POLICY_NAME="DelivrixOpenClawBedrockDeny"
USER_NAME="delivrix-openclaw-prod"
BUDGET_NAME="delivrix-openclaw-monthly-cap"
BUDGET_ROLE_NAME="DelivrixBudgetActionRole"
BUDGET_AMOUNT="100"

echo "=== Pre-flight checks ==="

# 1. AWS CLI instalado
command -v aws >/dev/null 2>&1 || { echo "FAIL: AWS CLI no instalado"; exit 1; }
echo "ok: aws cli $(aws --version 2>&1 | head -1)"

# 2. Credenciales admin configuradas y válidas
CALLER=$(aws sts get-caller-identity --output json 2>&1) || { echo "FAIL: aws sts get-caller-identity"; echo "$CALLER"; exit 1; }
CALLER_ARN=$(echo "$CALLER" | jq -r '.Arn')
CALLER_ACCOUNT=$(echo "$CALLER" | jq -r '.Account')
echo "ok: identidad AWS = ${CALLER_ARN}"
[ "${CALLER_ACCOUNT}" = "${ACCOUNT_ID}" ] || { echo "FAIL: cuenta esperada ${ACCOUNT_ID}, actual ${CALLER_ACCOUNT}"; exit 1; }
echo "ok: cuenta correcta = ${ACCOUNT_ID}"

# 3. Región alcanzable
aws bedrock list-foundation-models --region "${REGION}" --max-results 1 >/dev/null 2>&1 \
  || { echo "FAIL: bedrock no responde en ${REGION}, verificar Model Access en consola web primero"; exit 1; }
echo "ok: bedrock alcanzable en ${REGION}"

# 4. Model Access para Claude Sonnet 4.6 concedido
# Listar foundation models y filtrar Anthropic. Si Sonnet 4.6 está y inferenceTypesSupported incluye ON_DEMAND, OK.
MODELS=$(aws bedrock list-foundation-models --region "${REGION}" --by-provider anthropic --output json)
SONNET_FOUND=$(echo "$MODELS" | jq -r '.modelSummaries[] | select(.modelId | contains("claude-sonnet-4-6")) | .modelId' | head -1)
if [ -z "$SONNET_FOUND" ]; then
  echo "FAIL: Claude Sonnet 4.6 no aparece en list-foundation-models"
  echo "      Habilitar Model Access en https://${REGION}.console.aws.amazon.com/bedrock/home?region=${REGION}#/modelaccess"
  exit 1
fi
echo "ok: Sonnet 4.6 visible (modelId=${SONNET_FOUND})"

# 5. Verificar que no existen ya recursos con esos nombres (evitar duplicados)
for resource in \
  "iam.policy:${POLICY_NAME}" \
  "iam.policy:${DENY_POLICY_NAME}" \
  "iam.user:${USER_NAME}" \
  "iam.role:${BUDGET_ROLE_NAME}"; do
  type=$(echo "$resource" | cut -d. -f1-2)
  name=$(echo "$resource" | cut -d: -f2)
  case "$type" in
    iam.policy)
      aws iam get-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${name}" >/dev/null 2>&1 \
        && { echo "WARN: policy ${name} ya existe — abort o usar suffix"; exit 1; } || echo "ok: ${name} no existe"
      ;;
    iam.user)
      aws iam get-user --user-name "${name}" >/dev/null 2>&1 \
        && { echo "WARN: user ${name} ya existe — abort o usar suffix"; exit 1; } || echo "ok: ${name} no existe"
      ;;
    iam.role)
      aws iam get-role --role-name "${name}" >/dev/null 2>&1 \
        && echo "ok: role ${name} ya existe (se reusa)" \
        || echo "ok: ${name} no existe (se creará)"
      ;;
  esac
done

echo "=== Pre-flight OK ==="
```

Si algo de pre-flight falla, **abort** y reportar al operador. NO continuar al siguiente paso.

## Paso 1 — Crear la policy IAM principal

```bash
echo "=== Paso 1: Crear policy ${POLICY_NAME} ==="

cat > "${AUDIT_DIR}/bedrock-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DelivrixOpenClawInvokeBedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-4-6-*",
        "arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-haiku-4-5-*",
        "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/us.anthropic.claude-sonnet-4-6-*",
        "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/us.anthropic.claude-haiku-4-5-*"
      ]
    },
    {
      "Sid": "DelivrixOpenClawListBedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    }
  ]
}
EOF

POLICY_ARN=$(aws iam create-policy \
  --policy-name "${POLICY_NAME}" \
  --description "Allows OpenClaw to invoke Anthropic Claude Sonnet 4.6 and Haiku 4.5 on Bedrock ${REGION}. Restricted per Hito 5.11.B contract." \
  --policy-document "file://${AUDIT_DIR}/bedrock-policy.json" \
  --output json | jq -r '.Policy.Arn')

echo "ok: policy creada arn=${POLICY_ARN}"

# Audit
echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.iam.policy_created\",\"targetType\":\"iam_policy\",\"targetId\":\"${POLICY_NAME}\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"policyArn\":\"${POLICY_ARN}\",\"region\":\"${REGION}\"},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 2 — Crear el deny policy (para el budget action)

```bash
echo "=== Paso 2: Crear policy ${DENY_POLICY_NAME} ==="

cat > "${AUDIT_DIR}/bedrock-deny-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DelivrixBudgetGateDenyAll",
    "Effect": "Deny",
    "Action": "bedrock:*",
    "Resource": "*"
  }]
}
EOF

DENY_POLICY_ARN=$(aws iam create-policy \
  --policy-name "${DENY_POLICY_NAME}" \
  --description "Attached automatically by BudgetAction when USD ${BUDGET_AMOUNT}/month threshold is hit." \
  --policy-document "file://${AUDIT_DIR}/bedrock-deny-policy.json" \
  --output json | jq -r '.Policy.Arn')

echo "ok: deny policy creada arn=${DENY_POLICY_ARN}"

echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.iam.policy_created\",\"targetType\":\"iam_policy\",\"targetId\":\"${DENY_POLICY_NAME}\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"policyArn\":\"${DENY_POLICY_ARN}\",\"purpose\":\"budget_gate\"},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 3 — Crear el IAM User y attachear la policy

```bash
echo "=== Paso 3: Crear user ${USER_NAME} ==="

aws iam create-user \
  --user-name "${USER_NAME}" \
  --tags "Key=Project,Value=Delivrix" "Key=Hito,Value=5.11.B" "Key=Owner,Value=ops" "Key=ManagedBy,Value=codex-cli" \
  >/dev/null

aws iam attach-user-policy \
  --user-name "${USER_NAME}" \
  --policy-arn "${POLICY_ARN}"

echo "ok: user ${USER_NAME} creado y policy attached"

echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.iam.user_created\",\"targetType\":\"iam_user\",\"targetId\":\"${USER_NAME}\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"attachedPolicies\":[\"${POLICY_ARN}\"],\"tags\":{\"Project\":\"Delivrix\",\"Hito\":\"5.11.B\"}},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 4 — Generar Access Keys (CRÍTICO: entrega segura)

```bash
echo "=== Paso 4: Crear Access Keys (entrega segura) ==="

KEYS_FILE="${SECRETS_DIR}/delivrix-openclaw-keys.txt"
KEYS_JSON=$(aws iam create-access-key --user-name "${USER_NAME}" --output json)

ACCESS_KEY_ID=$(echo "$KEYS_JSON" | jq -r '.AccessKey.AccessKeyId')
SECRET_ACCESS_KEY=$(echo "$KEYS_JSON" | jq -r '.AccessKey.SecretAccessKey')

# Escribir a archivo seguro, NUNCA a stdout
cat > "${KEYS_FILE}" <<EOF
# Delivrix OpenClaw Bedrock — Access Keys generadas $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Operador: copia estas dos líneas a tu password manager y BORRA este archivo.
# Comando para borrar: rm "${KEYS_FILE}"

AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${SECRET_ACCESS_KEY}
AWS_REGION=${REGION}

# Modelo recomendado para OpenClaw:
BEDROCK_MODEL_ID=${SONNET_FOUND}

# Pasos siguientes:
# 1. Abrir password manager.
# 2. Crear entrada "delivrix-openclaw-hostinger-prod-2026-05".
# 3. Pegar Access Key ID, Secret Access Key y Region.
# 4. Cargar al container OpenClaw (sección §7 del doc detallado).
# 5. Borrar este archivo: rm "${KEYS_FILE}"
EOF

chmod 600 "${KEYS_FILE}"

# Limpiar variables de la sesión bash de Codex
unset SECRET_ACCESS_KEY KEYS_JSON

echo "ok: Access Keys generadas y escritas a ${KEYS_FILE}"
echo "    Permisos: $(stat -f '%Sp %Su:%Sg' "${KEYS_FILE}" 2>/dev/null || stat -c '%A %U:%G' "${KEYS_FILE}")"
echo ""
echo "ACCIÓN HUMANA REQUERIDA:"
echo "  1. Abre ${KEYS_FILE} con un editor"
echo "  2. Copia ambas líneas a tu password manager"
echo "  3. Borra el archivo: rm ${KEYS_FILE}"
echo ""

# Audit SIN imprimir las keys
echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.iam.access_key_created\",\"targetType\":\"iam_access_key\",\"targetId\":\"${ACCESS_KEY_ID}\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"userName\":\"${USER_NAME}\",\"deliveredVia\":\"local_file_chmod_600\",\"filePath\":\"${KEYS_FILE}\",\"secretAccessKeyExposed\":false},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 5 — Crear el service role para BudgetActions

```bash
echo "=== Paso 5: Service role ${BUDGET_ROLE_NAME} ==="

# Trust policy: AWS Budgets puede asumir este role
cat > "${AUDIT_DIR}/budget-trust-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "budgets.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

# Crear role si no existe
if ! aws iam get-role --role-name "${BUDGET_ROLE_NAME}" >/dev/null 2>&1; then
  ROLE_ARN=$(aws iam create-role \
    --role-name "${BUDGET_ROLE_NAME}" \
    --assume-role-policy-document "file://${AUDIT_DIR}/budget-trust-policy.json" \
    --description "Permite a AWS Budgets adjuntar deny policies al user OpenClaw cuando se exceda el cap" \
    --output json | jq -r '.Role.Arn')
  echo "ok: role creado arn=${ROLE_ARN}"
else
  ROLE_ARN=$(aws iam get-role --role-name "${BUDGET_ROLE_NAME}" --output json | jq -r '.Role.Arn')
  echo "ok: role ya existía arn=${ROLE_ARN}"
fi

# Attachear la policy gestionada que permite BudgetActions
aws iam attach-role-policy \
  --role-name "${BUDGET_ROLE_NAME}" \
  --policy-arn "arn:aws:iam::aws:policy/AWSBudgetsActionsRolePolicyForResourceAdministrationWithSSM"

echo "ok: role ${BUDGET_ROLE_NAME} con policy gestionada"
```

## Paso 6 — Crear el AWS Budget

```bash
echo "=== Paso 6: Budget ${BUDGET_NAME} USD ${BUDGET_AMOUNT}/mes ==="

cat > "${AUDIT_DIR}/budget.json" <<EOF
{
  "BudgetName": "${BUDGET_NAME}",
  "BudgetLimit": { "Amount": "${BUDGET_AMOUNT}", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "Service": ["Amazon Bedrock"]
  },
  "CostTypes": {
    "IncludeTax": true,
    "IncludeSubscription": true,
    "UseBlended": false,
    "IncludeRefund": false,
    "IncludeCredit": false,
    "IncludeUpfront": true,
    "IncludeRecurring": true,
    "IncludeOtherSubscription": true,
    "IncludeSupport": true,
    "IncludeDiscount": true,
    "UseAmortized": false
  }
}
EOF

cat > "${AUDIT_DIR}/budget-notifications.json" <<EOF
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "OPERATOR_EMAIL_REPLACE_ME" }]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "OPERATOR_EMAIL_REPLACE_ME" }]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 95,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "OPERATOR_EMAIL_REPLACE_ME" }]
  }
]
EOF

echo ""
echo "ACCIÓN HUMANA REQUERIDA:"
echo "  Edita ${AUDIT_DIR}/budget-notifications.json y reemplaza"
echo "  OPERATOR_EMAIL_REPLACE_ME por tu email real (3 ocurrencias)."
echo "  Después continúa con el siguiente comando manualmente o re-ejecuta este script."
echo ""
read -p "Presiona ENTER cuando hayas reemplazado el email..." dummy

aws budgets create-budget \
  --account-id "${ACCOUNT_ID}" \
  --budget "file://${AUDIT_DIR}/budget.json" \
  --notifications-with-subscribers "file://${AUDIT_DIR}/budget-notifications.json"

echo "ok: budget ${BUDGET_NAME} creado"

echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.budget.created\",\"targetType\":\"aws_budget\",\"targetId\":\"${BUDGET_NAME}\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"amount\":${BUDGET_AMOUNT},\"unit\":\"USD\",\"timeUnit\":\"MONTHLY\",\"service\":\"Amazon Bedrock\",\"alertThresholds\":[50,80,95]},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 7 — Crear el BudgetAction (gate automático al 95%)

```bash
echo "=== Paso 7: BudgetAction (deshabilita user al 95%) ==="

cat > "${AUDIT_DIR}/budget-action-definition.json" <<EOF
{
  "IamActionDefinition": {
    "PolicyArn": "${DENY_POLICY_ARN}",
    "Users": ["${USER_NAME}"]
  }
}
EOF

aws budgets create-budget-action \
  --account-id "${ACCOUNT_ID}" \
  --budget-name "${BUDGET_NAME}" \
  --notification-type ACTUAL \
  --action-type APPLY_IAM_POLICY \
  --action-threshold "ActionThresholdValue=95,ActionThresholdType=PERCENTAGE" \
  --definition "file://${AUDIT_DIR}/budget-action-definition.json" \
  --execution-role-arn "${ROLE_ARN}" \
  --approval-model AUTOMATIC \
  --subscribers "SubscriptionType=EMAIL,Address=OPERATOR_EMAIL_REPLACE_ME"
  # NOTE: si Codex pidió el email en Paso 6, lo reutiliza aquí

echo "ok: budget action creado — al 95% se adjunta ${DENY_POLICY_NAME} al user"

echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.budget_action.created\",\"targetType\":\"aws_budget_action\",\"targetId\":\"${BUDGET_NAME}:95pct\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"threshold\":95,\"action\":\"APPLY_IAM_POLICY\",\"denyPolicy\":\"${DENY_POLICY_NAME}\",\"targetUser\":\"${USER_NAME}\",\"approvalModel\":\"AUTOMATIC\"},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
```

## Paso 8 — Smoke test (validar que las keys funcionan)

```bash
echo "=== Paso 8: Smoke test ==="
echo ""
echo "Antes de seguir, el operador debe:"
echo "  1. Abrir ${KEYS_FILE}"
echo "  2. Configurar perfil temporal en su Mac:"
echo "     aws configure --profile delivrix-openclaw"
echo "     (pegar Access Key, Secret, region us-east-1)"
echo "  3. Probar invoke real:"
echo ""
cat <<'TESTCMD'
aws bedrock-runtime invoke-model \
  --profile delivrix-openclaw \
  --region us-east-1 \
  --model-id 'anthropic.claude-sonnet-4-6-20250514-v1:0' \
  --body "$(printf '{"anthropic_version":"bedrock-2023-05-31","max_tokens":50,"messages":[{"role":"user","content":"Responde literal: SMOKE_OK_BEDROCK"}]}' | base64)" \
  --cli-binary-format raw-in-base64-out \
  /tmp/bedrock-smoke-out.json && cat /tmp/bedrock-smoke-out.json | jq '.content[0].text'
TESTCMD
echo ""
echo "Esperado: \"SMOKE_OK_BEDROCK\""
echo ""
echo "Si OK: las credenciales funcionan. Pasar a cargar al container (§7 del doc detallado)."
echo "Si falla con AccessDenied: revisar Model Access en consola."
echo "Si falla con InvalidClientTokenId: revisar que las keys del archivo están bien copiadas."
```

## Paso 9 — Reporte de cierre

```bash
echo ""
echo "============================================"
echo "  AWS Bedrock setup completo — resumen"
echo "============================================"
echo "  Cuenta:           ${ACCOUNT_ID} (Infradelivrix)"
echo "  Región:           ${REGION}"
echo "  Policy invoke:    ${POLICY_NAME}"
echo "  Policy deny:      ${DENY_POLICY_NAME}"
echo "  User:             ${USER_NAME}"
echo "  Budget:           ${BUDGET_NAME} (USD ${BUDGET_AMOUNT}/mes)"
echo "  Budget action:    95% threshold → adjunta deny al user"
echo "  Service role:     ${BUDGET_ROLE_NAME}"
echo "  Modelo:           ${SONNET_FOUND}"
echo ""
echo "  Access Keys:      ${KEYS_FILE}  (chmod 600)"
echo "  Audit log:        ${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
echo ""
echo "  Próximos pasos:"
echo "  1. Operador copia keys al password manager y borra ${KEYS_FILE}"
echo "  2. Operador o Codex carga keys al container OpenClaw (§7 doc detallado)"
echo "  3. Smoke test desde OpenClaw (§8 del playbook principal)"
echo "============================================"
```

## Rollback completo (si algo falla a la mitad)

Si Codex aborta en el medio del setup, ejecutar este script de cleanup
**solo si el operador autoriza el rollback**:

```bash
set -uo pipefail

# Detach + delete access keys
KEYS=$(aws iam list-access-keys --user-name "${USER_NAME}" --output json 2>/dev/null | jq -r '.AccessKeyMetadata[].AccessKeyId')
for k in $KEYS; do
  aws iam delete-access-key --user-name "${USER_NAME}" --access-key-id "$k" 2>/dev/null || true
done

# Detach + delete user
aws iam list-attached-user-policies --user-name "${USER_NAME}" --output json 2>/dev/null | \
  jq -r '.AttachedPolicies[].PolicyArn' | \
  xargs -I {} aws iam detach-user-policy --user-name "${USER_NAME}" --policy-arn {} 2>/dev/null || true
aws iam delete-user --user-name "${USER_NAME}" 2>/dev/null || true

# Delete policies
aws iam delete-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}" 2>/dev/null || true
aws iam delete-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${DENY_POLICY_NAME}" 2>/dev/null || true

# Delete budget action and budget
aws budgets describe-budget-actions-for-budget \
  --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --output json 2>/dev/null | jq -r '.Actions[].ActionId' | \
  xargs -I {} aws budgets delete-budget-action \
    --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" --action-id {} 2>/dev/null || true

aws budgets delete-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" 2>/dev/null || true

# Service role (solo si no se usa para otra cosa)
aws iam detach-role-policy --role-name "${BUDGET_ROLE_NAME}" \
  --policy-arn "arn:aws:iam::aws:policy/AWSBudgetsActionsRolePolicyForResourceAdministrationWithSSM" 2>/dev/null || true
aws iam delete-role --role-name "${BUDGET_ROLE_NAME}" 2>/dev/null || true

# Local file con keys
shred -u "${KEYS_FILE}" 2>/dev/null || rm -f "${KEYS_FILE}"

# Audit del rollback
echo "{\"id\":\"$(uuidgen)\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"actorType\":\"system\",\"actorId\":\"codex@host\",\"action\":\"oc.aws.setup.rolled_back\",\"targetType\":\"openclaw_bedrock_setup\",\"targetId\":\"full\",\"decision\":\"n/a\",\"humanApproved\":true,\"approverIds\":[\"juanes@delivrix\"],\"schemaVersion\":\"2026-05-18.v1\",\"metadata\":{\"reason\":\"setup_failure_or_explicit_request\"},\"prevHash\":\"PENDING_CHAIN_BOOTSTRAP\",\"hash\":\"PENDING_CHAIN_BOOTSTRAP\"}" >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"

echo "Rollback completo."
```

## Resumen para el operador

| Quién | Qué hace |
| --- | --- |
| **Operador (tú, manual)** | §1 del doc detallado: habilitar Model Access en consola web (acepta EULA de Anthropic). Sin esto Codex falla en pre-flight. |
| **Codex (CLI automático)** | Pre-flight + §1-§7 de este doc: policy, deny policy, user, access keys, budget, budget action, service role. |
| **Operador (manual)** | Reemplazar `OPERATOR_EMAIL_REPLACE_ME` en el archivo de notificaciones del budget (Codex le pide ENTER cuando lo haga). Copiar Access Keys del archivo al password manager. Borrar el archivo. |
| **Codex** | Smoke test invoke-model con perfil temporal. |
| **Codex** | Cargar credenciales al container OpenClaw (Opción B del playbook principal §7). |
| **Codex** | Smokes en OpenClaw (PROVIDER_SWITCH_OK_BEDROCK + identidad + gates) y audit final. |

Total ejecución de Codex: ~3-5 minutos + las pausas humanas (~5 min totales del operador).

## Referencias

- Playbook principal: `OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md`
- Walkthrough manual equivalente: `OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md`
- Contrato secrets: `OPENCLAW_DELIVRIX_API_CONTRACT.md` §6
- Norte: `NORTE_OPERATIVO_DELIVRIX.md`
