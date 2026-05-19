#!/usr/bin/env bash
set -Eeuo pipefail

REGION="us-east-1"
ACCOUNT_ID="397450413307"
USER_NAME="delivrix-openclaw-prod"
DENY_POLICY_NAME="DelivrixOpenClawBedrockDeny"
BUDGET_NAME="delivrix-openclaw-monthly-cap"
BUDGET_ROLE_NAME="DelivrixBudgetActionRole"
BUDGET_AMOUNT="100"
OPERATOR_EMAIL="infra@delivrix.com"

echo "=== Delivrix OpenClaw Bedrock BudgetAction setup ==="

CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
echo "caller=${CALLER_ARN}"

if [ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "FAIL: cuenta esperada ${ACCOUNT_ID}, actual ${CALLER_ACCOUNT}" >&2
  exit 1
fi

aws iam get-user --user-name "$USER_NAME" >/dev/null
echo "ok: IAM user existe: ${USER_NAME}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

DENY_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${DENY_POLICY_NAME}"

if aws iam get-policy --policy-arn "$DENY_POLICY_ARN" >/dev/null 2>&1; then
  echo "ok: deny policy ya existe: ${DENY_POLICY_ARN}"
else
  cat > "${WORKDIR}/bedrock-deny-policy.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DelivrixBudgetGateDenyAllBedrock",
      "Effect": "Deny",
      "Action": "bedrock:*",
      "Resource": "*"
    }
  ]
}
JSON

  aws iam create-policy \
    --policy-name "$DENY_POLICY_NAME" \
    --description "Attached automatically by AWS Budgets when Delivrix OpenClaw reaches the monthly Bedrock cap." \
    --policy-document "file://${WORKDIR}/bedrock-deny-policy.json" \
    >/dev/null
  echo "ok: deny policy creada: ${DENY_POLICY_ARN}"
fi

if aws iam get-role --role-name "$BUDGET_ROLE_NAME" >/dev/null 2>&1; then
  ROLE_ARN="$(aws iam get-role --role-name "$BUDGET_ROLE_NAME" --query Role.Arn --output text)"
  echo "ok: role ya existe: ${ROLE_ARN}"
else
  cat > "${WORKDIR}/budget-trust-policy.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "budgets.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

  ROLE_ARN="$(aws iam create-role \
    --role-name "$BUDGET_ROLE_NAME" \
    --assume-role-policy-document "file://${WORKDIR}/budget-trust-policy.json" \
    --description "Allows AWS Budgets to apply Bedrock deny policy to Delivrix OpenClaw at cost threshold." \
    --query Role.Arn \
    --output text)"
  echo "ok: role creado: ${ROLE_ARN}"
fi

aws iam attach-role-policy \
  --role-name "$BUDGET_ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM" \
  >/dev/null
echo "ok: role policy attached"

if aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
  echo "ok: budget ya existe: ${BUDGET_NAME}"
else
  cat > "${WORKDIR}/budget.json" <<JSON
{
  "BudgetName": "${BUDGET_NAME}",
  "BudgetLimit": {
    "Amount": "${BUDGET_AMOUNT}",
    "Unit": "USD"
  },
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
JSON

  cat > "${WORKDIR}/budget-notifications.json" <<JSON
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      {
        "SubscriptionType": "EMAIL",
        "Address": "${OPERATOR_EMAIL}"
      }
    ]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      {
        "SubscriptionType": "EMAIL",
        "Address": "${OPERATOR_EMAIL}"
      }
    ]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 95,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      {
        "SubscriptionType": "EMAIL",
        "Address": "${OPERATOR_EMAIL}"
      }
    ]
  }
]
JSON

  aws budgets create-budget \
    --account-id "$ACCOUNT_ID" \
    --budget "file://${WORKDIR}/budget.json" \
    --notifications-with-subscribers "file://${WORKDIR}/budget-notifications.json"
  echo "ok: budget creado: ${BUDGET_NAME}"
fi

cat > "${WORKDIR}/budget-action-definition.json" <<JSON
{
  "IamActionDefinition": {
    "PolicyArn": "${DENY_POLICY_ARN}",
    "Users": ["${USER_NAME}"]
  }
}
JSON

EXISTING_ACTIONS="$(aws budgets describe-budget-actions-for-budget \
  --account-id "$ACCOUNT_ID" \
  --budget-name "$BUDGET_NAME" \
  --query 'Actions[].ActionId' \
  --output text 2>/dev/null || true)"

if [ -n "$EXISTING_ACTIONS" ] && [ "$EXISTING_ACTIONS" != "None" ]; then
  echo "ok: budget action ya existe: ${EXISTING_ACTIONS}"
else
  aws budgets create-budget-action \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$BUDGET_NAME" \
    --notification-type ACTUAL \
    --action-type APPLY_IAM_POLICY \
    --action-threshold "ActionThresholdValue=95,ActionThresholdType=PERCENTAGE" \
    --definition "file://${WORKDIR}/budget-action-definition.json" \
    --execution-role-arn "$ROLE_ARN" \
    --approval-model AUTOMATIC \
    --subscribers "SubscriptionType=EMAIL,Address=${OPERATOR_EMAIL}" \
    >/dev/null
  echo "ok: budget action creado: 95pct -> ${DENY_POLICY_NAME} sobre ${USER_NAME}"
fi

echo "=== OK: Bedrock BudgetAction listo ==="
echo "budget=${BUDGET_NAME}"
echo "amount_usd=${BUDGET_AMOUNT}"
echo "email=${OPERATOR_EMAIL}"
echo "deny_policy=${DENY_POLICY_ARN}"
echo "target_user=${USER_NAME}"
