#!/usr/bin/env bash
set -Eeuo pipefail

POLICY_NAME="DelivrixRoute53DiscoverPolicy"
USER_NAME="delivrix-route53-discover"
REGION="us-east-1"
PROFILE=""
SECRETS_DIR="${HOME}/.aws-secrets"
OUTPUT_FILE="${SECRETS_DIR}/delivrix-route53-keys.txt"
POLICY_FILE="ops/aws-route53-domain-discovery-policy.json"

usage() {
  cat <<'EOF'
Usage:
  ops/aws-route53-domain-discovery-setup.sh [--profile NAME] [--region REGION]

Creates a discovery-only IAM user for Delivrix Route 53 Domains:
  - Can check availability, suggestions, prices and list registered domains.
  - Explicitly cannot register/transfer/renew domains or mutate DNS.

The generated access key secret is written only to:
  ~/.aws-secrets/delivrix-route53-keys.txt

It is never printed to stdout.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
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
  if [ -n "$PROFILE" ]; then
    aws --profile "$PROFILE" "$@"
  else
    aws "$@"
  fi
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "FAIL: required command not found: $1" >&2
    exit 127
  }
}

require_bin aws
require_bin jq

if [ ! -f "$POLICY_FILE" ]; then
  echo "FAIL: missing $POLICY_FILE" >&2
  exit 2
fi

ACCOUNT_ID="$(aws_cmd sts get-caller-identity --query Account --output text)"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "Using AWS account ${ACCOUNT_ID}"

if ! aws_cmd iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  aws_cmd iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "file://${POLICY_FILE}" >/dev/null
  echo "Created policy ${POLICY_NAME}"
else
  DEFAULT_VERSION_ID="$(aws_cmd iam get-policy --policy-arn "$POLICY_ARN" --query 'Policy.DefaultVersionId' --output text)"
  VERSION_COUNT="$(aws_cmd iam list-policy-versions --policy-arn "$POLICY_ARN" --query 'length(Versions)' --output text)"
  if [ "$VERSION_COUNT" -ge 5 ]; then
    OLDEST_NON_DEFAULT="$(aws_cmd iam list-policy-versions --policy-arn "$POLICY_ARN" \
      --query 'Versions[?IsDefaultVersion==`false`] | sort_by(@,&CreateDate)[0].VersionId' \
      --output text)"
    if [ -n "$OLDEST_NON_DEFAULT" ] && [ "$OLDEST_NON_DEFAULT" != "None" ]; then
      aws_cmd iam delete-policy-version \
        --policy-arn "$POLICY_ARN" \
        --version-id "$OLDEST_NON_DEFAULT" >/dev/null
    fi
  fi
  aws_cmd iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "file://${POLICY_FILE}" \
    --set-as-default >/dev/null
  echo "Updated policy ${POLICY_NAME} (previous default ${DEFAULT_VERSION_ID})"
fi

if ! aws_cmd iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws_cmd iam create-user --user-name "$USER_NAME" >/dev/null
  echo "Created user ${USER_NAME}"
fi

ATTACHED="$(aws_cmd iam list-attached-user-policies \
  --user-name "$USER_NAME" \
  --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'].PolicyArn | [0]" \
  --output text)"
if [ "$ATTACHED" = "None" ] || [ -z "$ATTACHED" ]; then
  aws_cmd iam attach-user-policy \
    --user-name "$USER_NAME" \
    --policy-arn "$POLICY_ARN"
  echo "Attached policy to ${USER_NAME}"
fi

KEY_COUNT="$(aws_cmd iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)"
if [ "$KEY_COUNT" -ge 2 ]; then
  echo "FAIL: ${USER_NAME} already has two access keys. Rotate/delete one before creating another." >&2
  exit 1
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
KEY_JSON="$(aws_cmd iam create-access-key --user-name "$USER_NAME" --output json)"
ACCESS_KEY_ID="$(printf '%s' "$KEY_JSON" | jq -r '.AccessKey.AccessKeyId')"
SECRET_ACCESS_KEY="$(printf '%s' "$KEY_JSON" | jq -r '.AccessKey.SecretAccessKey')"

umask 077
cat > "$OUTPUT_FILE" <<EOF
AWS_ROUTE53_ACCESS_KEY_ID=${ACCESS_KEY_ID}
AWS_ROUTE53_SECRET_ACCESS_KEY=${SECRET_ACCESS_KEY}
AWS_ROUTE53_REGION=${REGION}
AWS_ROUTE53_CACHE_TTL_MS=300000
AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=false
EOF

echo "Wrote discovery credentials to ${OUTPUT_FILE}"
echo "Add those env vars to .env.local when ready. Keep purchase disabled until the approval runbook exists."
