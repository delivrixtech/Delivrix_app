#!/usr/bin/env bash
# Despliega el QA Auditor a AWS: bundlea los 2 Lambdas con esbuild y corre
# `sam deploy`. Requiere AWS CLI + SAM CLI configurados con tus credenciales.
# No empaqueta el AWS SDK (lo provee el runtime de Lambda).
set -euo pipefail

cd "$(dirname "$0")/.."   # -> tools/qa-auditor

REGION="${AWS_REGION:-us-east-1}"
STACK="${QA_STACK:-delivrix-qa-auditor}"

echo "[1/3] Bundling Lambdas con esbuild..."
rm -rf dist && mkdir -p dist
npx --yes esbuild src/aws/receiver.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=dist/receiver.mjs --external:@aws-sdk/*
npx --yes esbuild src/aws/worker.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=dist/worker.mjs --external:@aws-sdk/*

echo "[2/3] sam deploy (stack: $STACK, region: $REGION)..."
sam deploy \
  --template-file infra/template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides QaModel=us.anthropic.claude-sonnet-4-5-20250929-v1:0

echo "[3/3] URL del webhook (API Gateway; pegar en la GitHub App):"
aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ReceiverFunctionUrl'].OutputValue" \
  --output text
