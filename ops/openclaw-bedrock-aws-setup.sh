#!/usr/bin/env bash
set -Eeuo pipefail

WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
AUDIT_DIR="${WORKTREE}/.audit"
SECRETS_DIR="${HOME}/.aws-secrets"

AWS_PYTHON=""
if ! command -v aws >/dev/null 2>&1 && [ -x "${WORKTREE}/.venv-awscli/bin/python" ]; then
  AWS_PYTHON="${WORKTREE}/.venv-awscli/bin/python"
fi

REGION="us-east-1"
ACCOUNT_ID="397450413307"
PROFILE=""
OPERATOR_EMAIL=""
POLICY_NAME="DelivrixOpenClawBedrockInvoke"
DENY_POLICY_NAME="DelivrixOpenClawBedrockDeny"
USER_NAME="delivrix-openclaw-prod"
BUDGET_NAME="delivrix-openclaw-monthly-cap"
BUDGET_ROLE_NAME="DelivrixBudgetActionRole"
BUDGET_AMOUNT="100"
MODEL_ID=""
ROLLBACK_ON_FAILURE="true"

POLICY_ARN=""
DENY_POLICY_ARN=""
ROLE_ARN=""
ACCESS_KEY_ID=""
KEYS_FILE=""

CREATED_POLICY="false"
CREATED_DENY_POLICY="false"
CREATED_USER="false"
CREATED_ACCESS_KEY="false"
CREATED_BUDGET="false"
CREATED_BUDGET_ACTION="false"
CREATED_ROLE="false"

usage() {
  cat <<'EOF'
Usage:
  ops/openclaw-bedrock-aws-setup.sh --operator-email EMAIL [options]

Options:
  --profile NAME             AWS CLI profile to use. Defaults to AWS default provider chain.
  --region REGION            AWS region. Default: us-east-1.
  --account-id ID            Expected AWS account ID. Default: 397450413307.
  --budget-amount USD        Monthly Bedrock budget cap. Default: 100.
  --model-id MODEL_ID        Exact Bedrock model ID. If omitted, script discovers Claude Sonnet 4.6.
  --no-rollback-on-failure   Leave resources in place if a later step fails.
  -h, --help                 Show help.

Secrets:
  The generated IAM secret access key is written only to:
    ~/.aws-secrets/delivrix-openclaw-keys.txt
  It is never printed to stdout.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --operator-email)
      OPERATOR_EMAIL="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --budget-amount)
      BUDGET_AMOUNT="${2:-}"
      shift 2
      ;;
    --model-id)
      MODEL_ID="${2:-}"
      shift 2
      ;;
    --no-rollback-on-failure)
      ROLLBACK_ON_FAILURE="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

aws_cmd() {
  if [ -n "$AWS_PYTHON" ]; then
    if [ -n "$PROFILE" ]; then
      "$AWS_PYTHON" -m awscli --profile "$PROFILE" "$@"
    else
      "$AWS_PYTHON" -m awscli "$@"
    fi
  else
    if [ -n "$PROFILE" ]; then
      aws --profile "$PROFILE" "$@"
    else
      aws "$@"
    fi
  fi
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "FAIL: required command not found: $1" >&2
    exit 127
  }
}

audit_event() {
  local action="$1"
  local target_type="$2"
  local target_id="$3"
  local metadata_json="$4"

  mkdir -p "$AUDIT_DIR"
  jq -c -n \
    --arg id "$(uuidgen)" \
    --arg occurredAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$action" \
    --arg targetType "$target_type" \
    --arg targetId "$target_id" \
    --argjson metadata "$metadata_json" \
    '{
      id: $id,
      occurredAt: $occurredAt,
      actorType: "system",
      actorId: "codex@host",
      action: $action,
      targetType: $targetType,
      targetId: $targetId,
      decision: "n/a",
      humanApproved: true,
      approverIds: ["juanes@delivrix"],
      schemaVersion: "2026-05-18.v1",
      metadata: $metadata,
      prevHash: "PENDING_CHAIN_BOOTSTRAP",
      hash: "PENDING_CHAIN_BOOTSTRAP"
    }' >> "${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
}

rollback_current_run() {
  set +e
  if [ "$CREATED_POLICY" != "true" ] \
    && [ "$CREATED_DENY_POLICY" != "true" ] \
    && [ "$CREATED_USER" != "true" ] \
    && [ "$CREATED_ACCESS_KEY" != "true" ] \
    && [ "$CREATED_BUDGET" != "true" ] \
    && [ "$CREATED_BUDGET_ACTION" != "true" ] \
    && [ "$CREATED_ROLE" != "true" ]; then
    return 0
  fi

  echo "WARN: failure detected; rolling back resources created in this run"

  if [ "$CREATED_BUDGET_ACTION" = "true" ]; then
    aws_cmd budgets describe-budget-actions-for-budget \
      --account-id "$ACCOUNT_ID" \
      --budget-name "$BUDGET_NAME" \
      --output json 2>/dev/null \
      | jq -r '.Actions[].ActionId' \
      | while IFS= read -r action_id; do
          [ -n "$action_id" ] || continue
          aws_cmd budgets delete-budget-action \
            --account-id "$ACCOUNT_ID" \
            --budget-name "$BUDGET_NAME" \
            --action-id "$action_id" >/dev/null 2>&1
        done
  fi

  if [ "$CREATED_BUDGET" = "true" ]; then
    aws_cmd budgets delete-budget \
      --account-id "$ACCOUNT_ID" \
      --budget-name "$BUDGET_NAME" >/dev/null 2>&1
  fi

  if [ "$CREATED_ACCESS_KEY" = "true" ] && [ -n "$ACCESS_KEY_ID" ]; then
    aws_cmd iam delete-access-key \
      --user-name "$USER_NAME" \
      --access-key-id "$ACCESS_KEY_ID" >/dev/null 2>&1
  fi

  if [ "$CREATED_USER" = "true" ]; then
    aws_cmd iam detach-user-policy \
      --user-name "$USER_NAME" \
      --policy-arn "$POLICY_ARN" >/dev/null 2>&1
    aws_cmd iam delete-user --user-name "$USER_NAME" >/dev/null 2>&1
  fi

  if [ "$CREATED_ROLE" = "true" ]; then
    aws_cmd iam detach-role-policy \
      --role-name "$BUDGET_ROLE_NAME" \
      --policy-arn "arn:aws:iam::aws:policy/AWSBudgetsActionsRolePolicyForResourceAdministrationWithSSM" >/dev/null 2>&1
    aws_cmd iam delete-role --role-name "$BUDGET_ROLE_NAME" >/dev/null 2>&1
  fi

  if [ "$CREATED_DENY_POLICY" = "true" ] && [ -n "$DENY_POLICY_ARN" ]; then
    aws_cmd iam delete-policy --policy-arn "$DENY_POLICY_ARN" >/dev/null 2>&1
  fi

  if [ "$CREATED_POLICY" = "true" ] && [ -n "$POLICY_ARN" ]; then
    aws_cmd iam delete-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1
  fi

  if [ -n "$KEYS_FILE" ] && [ -f "$KEYS_FILE" ]; then
    rm -f "$KEYS_FILE"
  fi

  audit_event "oc.aws.setup.rolled_back" "openclaw_bedrock_setup" "current_run" \
    "$(jq -c -n --arg reason "setup_failure" '{reason:$reason}')"
}

on_error() {
  local exit_code=$?
  trap - ERR
  if [ "$ROLLBACK_ON_FAILURE" = "true" ]; then
    rollback_current_run
  fi
  echo "FAIL: setup aborted with exit code ${exit_code}" >&2
  exit "$exit_code"
}

trap on_error ERR

validate_inputs() {
  if [ -z "$OPERATOR_EMAIL" ]; then
    echo "FAIL: --operator-email is required" >&2
    exit 2
  fi

  case "$OPERATOR_EMAIL" in
    *@*.*) ;;
    *)
      echo "FAIL: invalid operator email: $OPERATOR_EMAIL" >&2
      exit 2
      ;;
  esac

  case "$ACCOUNT_ID" in
    ''|*[!0-9]*)
      echo "FAIL: --account-id must be numeric" >&2
      exit 2
      ;;
  esac

  if [ "${#ACCOUNT_ID}" -ne 12 ]; then
    echo "FAIL: --account-id must have 12 digits" >&2
    exit 2
  fi
}

preflight() {
  echo "=== Pre-flight checks ==="
  if [ -z "$AWS_PYTHON" ]; then
    require_bin aws
  fi
  require_bin jq
  require_bin uuidgen

  mkdir -p "$AUDIT_DIR" "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"

  echo "ok: aws cli $(aws_cmd --version 2>&1 | head -1)"

  local caller caller_arn caller_account
  caller="$(aws_cmd sts get-caller-identity --output json)"
  caller_arn="$(echo "$caller" | jq -r '.Arn')"
  caller_account="$(echo "$caller" | jq -r '.Account')"
  echo "ok: identidad AWS = ${caller_arn}"

  if [ "$caller_account" != "$ACCOUNT_ID" ]; then
    echo "FAIL: cuenta esperada ${ACCOUNT_ID}, actual ${caller_account}" >&2
    exit 1
  fi
  echo "ok: cuenta correcta = ${ACCOUNT_ID}"

  local models_json
  models_json="$(aws_cmd bedrock list-foundation-models --region "$REGION" --output json)"
  echo "ok: bedrock responde en ${REGION}"

  if [ -z "$MODEL_ID" ]; then
    MODEL_ID="$(echo "$models_json" | jq -r '
      .modelSummaries[]
      | select((.providerName // "" | ascii_downcase) == "anthropic")
      | select(.modelId | contains("claude-sonnet-4-6"))
      | .modelId
    ' | head -1)"
  fi

  if [ -z "$MODEL_ID" ]; then
    echo "FAIL: Claude Sonnet 4.6 no aparece en list-foundation-models para ${REGION}" >&2
    echo "Modelos Anthropic visibles:" >&2
    echo "$models_json" | jq -r '
      .modelSummaries[]
      | select((.providerName // "" | ascii_downcase) == "anthropic")
      | "  - \(.modelId)"
    ' >&2
    echo "Habilita Model Access en Bedrock o pasa --model-id con el ID exacto." >&2
    exit 1
  fi

  echo "ok: modelId destino = ${MODEL_ID}"

  if aws_cmd iam get-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}" >/dev/null 2>&1; then
    echo "FAIL: policy ${POLICY_NAME} ya existe; abortando para evitar duplicados" >&2
    exit 1
  fi
  echo "ok: ${POLICY_NAME} no existe"

  if aws_cmd iam get-policy --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${DENY_POLICY_NAME}" >/dev/null 2>&1; then
    echo "FAIL: policy ${DENY_POLICY_NAME} ya existe; abortando para evitar duplicados" >&2
    exit 1
  fi
  echo "ok: ${DENY_POLICY_NAME} no existe"

  if aws_cmd iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
    echo "FAIL: user ${USER_NAME} ya existe; abortando para evitar duplicados" >&2
    exit 1
  fi
  echo "ok: ${USER_NAME} no existe"

  if aws_cmd budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
    echo "FAIL: budget ${BUDGET_NAME} ya existe; abortando para evitar duplicados" >&2
    exit 1
  fi
  echo "ok: ${BUDGET_NAME} no existe"

  if aws_cmd iam get-role --role-name "$BUDGET_ROLE_NAME" >/dev/null 2>&1; then
    ROLE_ARN="$(aws_cmd iam get-role --role-name "$BUDGET_ROLE_NAME" --output json | jq -r '.Role.Arn')"
    echo "ok: role ${BUDGET_ROLE_NAME} ya existe y se reusa"
  else
    echo "ok: ${BUDGET_ROLE_NAME} no existe y se creara"
  fi

  echo "=== Pre-flight OK ==="
}

create_invoke_policy() {
  echo "=== Paso 1: Crear policy ${POLICY_NAME} ==="

  jq -n \
    --arg region "$REGION" \
    --arg accountId "$ACCOUNT_ID" \
    --arg modelId "$MODEL_ID" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DelivrixOpenClawInvokeBedrockModels",
          Effect: "Allow",
          Action: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream"
          ],
          Resource: [
            ("arn:aws:bedrock:" + $region + "::foundation-model/" + $modelId),
            ("arn:aws:bedrock:" + $region + "::foundation-model/anthropic.claude-sonnet-4-6-*"),
            ("arn:aws:bedrock:" + $region + "::foundation-model/anthropic.claude-haiku-4-5-*"),
            ("arn:aws:bedrock:" + $region + ":" + $accountId + ":inference-profile/us.anthropic.claude-sonnet-4-6-*"),
            ("arn:aws:bedrock:" + $region + ":" + $accountId + ":inference-profile/us.anthropic.claude-haiku-4-5-*")
          ]
        },
        {
          Sid: "DelivrixOpenClawListBedrockModels",
          Effect: "Allow",
          Action: [
            "bedrock:ListFoundationModels",
            "bedrock:GetFoundationModel",
            "bedrock:ListInferenceProfiles",
            "bedrock:GetInferenceProfile"
          ],
          Resource: "*"
        }
      ]
    }' > "${AUDIT_DIR}/bedrock-policy.json"

  POLICY_ARN="$(aws_cmd iam create-policy \
    --policy-name "$POLICY_NAME" \
    --description "Allows OpenClaw to invoke approved Anthropic models on Bedrock ${REGION}. Restricted per Hito 5.11.B contract." \
    --policy-document "file://${AUDIT_DIR}/bedrock-policy.json" \
    --output json | jq -r '.Policy.Arn')"
  CREATED_POLICY="true"

  echo "ok: policy creada arn=${POLICY_ARN}"
  audit_event "oc.aws.iam.policy_created" "iam_policy" "$POLICY_NAME" \
    "$(jq -c -n --arg policyArn "$POLICY_ARN" --arg region "$REGION" --arg modelId "$MODEL_ID" '{policyArn:$policyArn,region:$region,modelId:$modelId}')"
}

create_deny_policy() {
  echo "=== Paso 2: Crear policy ${DENY_POLICY_NAME} ==="

  jq -n '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DelivrixBudgetGateDenyAll",
        Effect: "Deny",
        Action: "bedrock:*",
        Resource: "*"
      }
    ]
  }' > "${AUDIT_DIR}/bedrock-deny-policy.json"

  DENY_POLICY_ARN="$(aws_cmd iam create-policy \
    --policy-name "$DENY_POLICY_NAME" \
    --description "Attached automatically by BudgetAction when the monthly Bedrock threshold is hit." \
    --policy-document "file://${AUDIT_DIR}/bedrock-deny-policy.json" \
    --output json | jq -r '.Policy.Arn')"
  CREATED_DENY_POLICY="true"

  echo "ok: deny policy creada arn=${DENY_POLICY_ARN}"
  audit_event "oc.aws.iam.policy_created" "iam_policy" "$DENY_POLICY_NAME" \
    "$(jq -c -n --arg policyArn "$DENY_POLICY_ARN" '{policyArn:$policyArn,purpose:"budget_gate"}')"
}

create_user_and_key() {
  echo "=== Paso 3: Crear user ${USER_NAME} ==="

  aws_cmd iam create-user \
    --user-name "$USER_NAME" \
    --tags "Key=Project,Value=Delivrix" "Key=Hito,Value=5.11.B" "Key=Owner,Value=ops" "Key=ManagedBy,Value=codex-cli" \
    >/dev/null
  CREATED_USER="true"

  aws_cmd iam attach-user-policy \
    --user-name "$USER_NAME" \
    --policy-arn "$POLICY_ARN"

  echo "ok: user ${USER_NAME} creado y policy attached"
  audit_event "oc.aws.iam.user_created" "iam_user" "$USER_NAME" \
    "$(jq -c -n --arg policyArn "$POLICY_ARN" '{attachedPolicies:[$policyArn],tags:{Project:"Delivrix",Hito:"5.11.B"}}')"

  echo "=== Paso 4: Crear Access Keys (entrega segura) ==="
  KEYS_FILE="${SECRETS_DIR}/delivrix-openclaw-keys.txt"

  local keys_json secret_access_key
  keys_json="$(aws_cmd iam create-access-key --user-name "$USER_NAME" --output json)"
  ACCESS_KEY_ID="$(echo "$keys_json" | jq -r '.AccessKey.AccessKeyId')"
  secret_access_key="$(echo "$keys_json" | jq -r '.AccessKey.SecretAccessKey')"
  CREATED_ACCESS_KEY="true"

  umask 077
  {
    echo "# Delivrix OpenClaw Bedrock - Access Keys generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Copy these values to the password manager and delete this file."
    echo "# Delete command: rm \"${KEYS_FILE}\""
    echo
    echo "AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}"
    echo "AWS_SECRET_ACCESS_KEY=${secret_access_key}"
    echo "AWS_REGION=${REGION}"
    echo "BEDROCK_MODEL_ID=${MODEL_ID}"
  } > "$KEYS_FILE"
  chmod 600 "$KEYS_FILE"

  unset secret_access_key keys_json

  echo "ok: Access Keys generadas y escritas a ${KEYS_FILE}"
  echo "    Permisos: $(stat -f '%Sp %Su:%Sg' "$KEYS_FILE" 2>/dev/null || stat -c '%A %U:%G' "$KEYS_FILE")"
  echo "    El secret NO se imprimio."

  audit_event "oc.aws.iam.access_key_created" "iam_access_key" "$ACCESS_KEY_ID" \
    "$(jq -c -n --arg userName "$USER_NAME" --arg filePath "$KEYS_FILE" '{userName:$userName,deliveredVia:"local_file_chmod_600",filePath:$filePath,secretAccessKeyExposed:false}')"
}

create_budget_role() {
  echo "=== Paso 5: Service role ${BUDGET_ROLE_NAME} ==="

  if [ -z "$ROLE_ARN" ]; then
    jq -n '{
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {Service: "budgets.amazonaws.com"},
          Action: "sts:AssumeRole"
        }
      ]
    }' > "${AUDIT_DIR}/budget-trust-policy.json"

    ROLE_ARN="$(aws_cmd iam create-role \
      --role-name "$BUDGET_ROLE_NAME" \
      --assume-role-policy-document "file://${AUDIT_DIR}/budget-trust-policy.json" \
      --description "Allows AWS Budgets to apply deny policies to the OpenClaw Bedrock user when the cap is exceeded." \
      --output json | jq -r '.Role.Arn')"
    CREATED_ROLE="true"
    echo "ok: role creado arn=${ROLE_ARN}"
  else
    echo "ok: role existente arn=${ROLE_ARN}"
  fi

  aws_cmd iam attach-role-policy \
    --role-name "$BUDGET_ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/AWSBudgetsActionsRolePolicyForResourceAdministrationWithSSM"

  echo "ok: role ${BUDGET_ROLE_NAME} con policy gestionada"
}

create_budget_and_action() {
  echo "=== Paso 6: Budget ${BUDGET_NAME} USD ${BUDGET_AMOUNT}/mes ==="

  jq -n \
    --arg budgetName "$BUDGET_NAME" \
    --arg amount "$BUDGET_AMOUNT" \
    '{
      BudgetName: $budgetName,
      BudgetLimit: {Amount: $amount, Unit: "USD"},
      TimeUnit: "MONTHLY",
      BudgetType: "COST",
      CostFilters: {Service: ["Amazon Bedrock"]},
      CostTypes: {
        IncludeTax: true,
        IncludeSubscription: true,
        UseBlended: false,
        IncludeRefund: false,
        IncludeCredit: false,
        IncludeUpfront: true,
        IncludeRecurring: true,
        IncludeOtherSubscription: true,
        IncludeSupport: true,
        IncludeDiscount: true,
        UseAmortized: false
      }
    }' > "${AUDIT_DIR}/budget.json"

  jq -n \
    --arg email "$OPERATOR_EMAIL" \
    '[
      {
        Notification: {
          NotificationType: "ACTUAL",
          ComparisonOperator: "GREATER_THAN",
          Threshold: 50,
          ThresholdType: "PERCENTAGE",
          NotificationState: "ALARM"
        },
        Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]
      },
      {
        Notification: {
          NotificationType: "ACTUAL",
          ComparisonOperator: "GREATER_THAN",
          Threshold: 80,
          ThresholdType: "PERCENTAGE",
          NotificationState: "ALARM"
        },
        Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]
      },
      {
        Notification: {
          NotificationType: "ACTUAL",
          ComparisonOperator: "GREATER_THAN",
          Threshold: 95,
          ThresholdType: "PERCENTAGE",
          NotificationState: "ALARM"
        },
        Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]
      }
    ]' > "${AUDIT_DIR}/budget-notifications.json"

  aws_cmd budgets create-budget \
    --account-id "$ACCOUNT_ID" \
    --budget "file://${AUDIT_DIR}/budget.json" \
    --notifications-with-subscribers "file://${AUDIT_DIR}/budget-notifications.json"
  CREATED_BUDGET="true"

  echo "ok: budget ${BUDGET_NAME} creado"
  audit_event "oc.aws.budget.created" "aws_budget" "$BUDGET_NAME" \
    "$(jq -c -n --argjson amount "$BUDGET_AMOUNT" '{amount:$amount,unit:"USD",timeUnit:"MONTHLY",service:"Amazon Bedrock",alertThresholds:[50,80,95]}')"

  echo "=== Paso 7: BudgetAction (deny Bedrock al 95%) ==="

  jq -n \
    --arg policyArn "$DENY_POLICY_ARN" \
    --arg userName "$USER_NAME" \
    '{IamActionDefinition: {PolicyArn: $policyArn, Users: [$userName]}}' \
    > "${AUDIT_DIR}/budget-action-definition.json"

  aws_cmd budgets create-budget-action \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$BUDGET_NAME" \
    --notification-type ACTUAL \
    --action-type APPLY_IAM_POLICY \
    --action-threshold "ActionThresholdValue=95,ActionThresholdType=PERCENTAGE" \
    --definition "file://${AUDIT_DIR}/budget-action-definition.json" \
    --execution-role-arn "$ROLE_ARN" \
    --approval-model AUTOMATIC \
    --subscribers "SubscriptionType=EMAIL,Address=${OPERATOR_EMAIL}"
  CREATED_BUDGET_ACTION="true"

  echo "ok: budget action creado; al 95% adjunta ${DENY_POLICY_NAME} al user"
  audit_event "oc.aws.budget_action.created" "aws_budget_action" "${BUDGET_NAME}:95pct" \
    "$(jq -c -n --arg denyPolicy "$DENY_POLICY_NAME" --arg userName "$USER_NAME" '{threshold:95,action:"APPLY_IAM_POLICY",denyPolicy:$denyPolicy,targetUser:$userName,approvalModel:"AUTOMATIC"}')"
}

close_report() {
  echo
  echo "============================================"
  echo "  AWS Bedrock setup completo"
  echo "============================================"
  echo "  Cuenta:        ${ACCOUNT_ID}"
  echo "  Region:        ${REGION}"
  echo "  Policy invoke: ${POLICY_NAME}"
  echo "  Policy deny:   ${DENY_POLICY_NAME}"
  echo "  User:          ${USER_NAME}"
  echo "  Budget:        ${BUDGET_NAME} (USD ${BUDGET_AMOUNT}/mes)"
  echo "  Budget action: 95% -> deny policy al user"
  echo "  Service role:  ${BUDGET_ROLE_NAME}"
  echo "  Modelo:        ${MODEL_ID}"
  echo
  echo "  Access Keys:   ${KEYS_FILE} (chmod 600)"
  echo "  Audit log:     ${AUDIT_DIR}/openclaw-bedrock-setup.jsonl"
  echo
  echo "Proximos pasos:"
  echo "  1. Operador copia las keys al password manager."
  echo "  2. Operador borra ${KEYS_FILE}."
  echo "  3. Cargar credenciales al container OpenClaw."
  echo "  4. Ejecutar smoke del provider Bedrock."
  echo "============================================"
}

main() {
  validate_inputs
  preflight
  create_invoke_policy
  create_deny_policy
  create_user_and_key
  create_budget_role
  create_budget_and_action
  trap - ERR
  close_report
}

main "$@"
