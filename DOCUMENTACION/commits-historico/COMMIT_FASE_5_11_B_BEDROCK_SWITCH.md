# COMMIT FASE 5.11.B — Switch provider OpenClaw a Bedrock

## Resumen

Aterriza el switch del provider AI de OpenClaw de Nexos (Hostinger
default) a Amazon Bedrock con Claude Sonnet 4.6 cross-region.

- Provider activo: `amazon-bedrock`
- Model: `us.anthropic.claude-sonnet-4-6`
- Región AWS: `us-east-1`
- BudgetAction: USD 100/mes con deny automático al 95%
- Smoke real OK (`OPENCLAW_BEDROCK_OK`, runId `453189ff-70ce-4305-a26b-c8a4641dc716`)

Este commit es **selectivo**: solo agrega archivos relacionados con el
switch a Bedrock. No incluye cambios untracked ajenos del worktree
(otros docs, scripts u OPS files pendientes).

## Archivos a commitear (8)

### Documentación OPS (docs guía)

- `OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md` — playbook principal del switch
- `OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md` — walkthrough manual paso a paso AWS console
- `OPS_OPENCLAW_BEDROCK_AWS_SETUP_VIA_CODEX.md` — directriz ejecutable para Codex CLI

### Script ejecutable y artefactos

- `ops/openclaw-bedrock-aws-setup.sh` — script automatizado de setup AWS
- `.audit/openclaw-bedrock-setup.jsonl` — audit local del setup (sin secrets)
- `.audit/bedrock-policy.json` — policy IAM principal
- `.audit/bedrock-deny-policy.json` — deny policy para budget gate
- `.audit/budget.json`, `.audit/budget-notifications.json`, `.audit/budget-action-definition.json` — artefactos JSON usados por aws cli
- `.audit/budget-trust-policy.json` — trust policy del role para BudgetActions

### NO se incluye (intencional)

- `~/.aws-secrets/delivrix-openclaw-keys.txt` — credenciales, viven solo
  en el Mac del operador, NUNCA en repo (ya marcadas para borrar tras
  pasar al password manager).
- `.venv-awscli/` — instalación local de awscli, ajena al proyecto.
- Cualquier `node_modules/`, `dist/`, archivos de build.

## Pre-flight (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

# 1. Verificar rama
git branch --show-current   # debe imprimir: youthful-mirzakhani-c517de

# 2. Confirmar archivos existen
for f in \
  OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md \
  OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md \
  OPS_OPENCLAW_BEDROCK_AWS_SETUP_VIA_CODEX.md \
  ops/openclaw-bedrock-aws-setup.sh \
  .audit/openclaw-bedrock-setup.jsonl ; do
  [ -e "$f" ] && echo "ok   $f" || echo "miss $f"
done

# 3. Confirmar que las keys NO están trackeadas
git check-ignore -v ~/.aws-secrets/delivrix-openclaw-keys.txt 2>/dev/null || \
  echo "ok: secrets fuera del worktree (no aplica gitignore)"

# 4. Asegurar que .aws-secrets/ y .venv-awscli/ están en .gitignore (si están en el worktree)
grep -q '^\.aws-secrets/' .gitignore || echo '.aws-secrets/' >> .gitignore
grep -q '^\.venv-awscli/' .gitignore || echo '.venv-awscli/' >> .gitignore
grep -q '^\.audit/.*\.txt$' .gitignore || true   # opcional: ignorar txt en .audit/ si tienen secrets
```

## Commit (Codex en host)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

# Add explícito de los 8 archivos del switch
git add \
  OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md \
  OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md \
  OPS_OPENCLAW_BEDROCK_AWS_SETUP_VIA_CODEX.md \
  ops/openclaw-bedrock-aws-setup.sh \
  .audit/openclaw-bedrock-setup.jsonl \
  .audit/bedrock-policy.json \
  .audit/bedrock-deny-policy.json \
  .audit/budget.json \
  .audit/budget-notifications.json \
  .audit/budget-action-definition.json \
  .audit/budget-trust-policy.json \
  .gitignore \
  COMMIT_FASE_5_11_B_BEDROCK_SWITCH.md

# Verificar qué quedará en el commit antes de confirmar
git status
git diff --cached --stat

# Si todo OK, commit
git commit -m "feat(openclaw): switch provider AI de Nexos a Amazon Bedrock

Migra OpenClaw (agente Hostinger 2.24.223.240:61175) de Nexos a Amazon
Bedrock con Claude Sonnet 4.6 cross-region inference profile. Norte
operativo intacto: panel sigue GET-only, kill switch sin bypass, audit
append-only.

Razón: budget Nexos USD 5 agotado + control AWS-nativo (billing
centralizado, CloudTrail audit, region pinning, IAM granular).

Estado post-switch verificado por Codex 2026-05-18:
- Provider: amazon-bedrock
- Modelo: us.anthropic.claude-sonnet-4-6
- Región: us-east-1
- Cuenta AWS: 397450413307 (Infradelivrix)
- IAM user: delivrix-openclaw-prod
- Policy invoke: DelivrixOpenClawBedrockInvoke
- Policy deny (budget gate): DelivrixOpenClawBedrockDeny
- Service role: DelivrixBudgetActionRole
- Budget: delivrix-openclaw-monthly-cap USD 100/mes
  alertas 50/80/95% via email infra@delivrix.com
  BudgetAction 95% threshold -> adjunta deny policy al user
- Smoke 1 real OK: respuesta OPENCLAW_BEDROCK_OK
  provider=amazon-bedrock model=us.anthropic.claude-sonnet-4-6
  fallbackUsed=false runId=453189ff-70ce-4305-a26b-c8a4641dc716

Gates duros respetados:
- Access Keys generadas viven solo en ~/.aws-secrets/ con chmod 600,
  nunca en repo ni en chat. Operador las copia al password manager
  y borra el archivo.
- Auditoria local sin secrets en .audit/openclaw-bedrock-setup.jsonl
  con eventos oc.aws.iam.policy_created, oc.aws.iam.user_created,
  oc.aws.iam.access_key_created (sin valores), oc.aws.budget.created,
  oc.aws.budget_action.created.
- BudgetAction auto-deshabilita el user al 95% del cap mensual sin
  intervencion humana, asegurando que USD 100/mes nunca se exceda
  por accidente.

Pendiente (no en este commit):
- Smoke 2: verificacion de identidad + 5 gates del norte por el agente
  (validar que system prompt + workspace docs cargaron OK).
- Investigar y posiblemente deshabilitar plugin
  oxylabs-ai-studio-openclaw (no usado por skills de Delivrix).
- D+2 AM cronograma: build script Capa 1 + ChromaDB Capa 2 con los
  63 docs literales del KB.

Refs:
- Doc OPS principal: OPS_OPENCLAW_SWITCH_PROVIDER_BEDROCK.md
- Walkthrough manual: OPS_OPENCLAW_BEDROCK_AWS_SETUP_DETALLADO.md
- Script Codex: OPS_OPENCLAW_BEDROCK_AWS_SETUP_VIA_CODEX.md
- Permissions matrix: DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md
- Audit integration: DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md
- Cronograma: DOCUMENTACION/HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md
"
```

## Validación post-commit

```bash
git log -1 --stat | head -25
git log --oneline -3
```

Esperar: ver el commit con los 12 archivos listados, hash nuevo, mensaje
completo.

## Reparto del trabajo después de este commit

| Tarea | Quién |
| --- | --- |
| Smoke 2 (identidad + gates) | Codex |
| Decidir si deshabilitamos `oxylabs-ai-studio-openclaw` | Operador + Codex |
| Commit selectivo del switch (este doc) | Codex |
| Próximo milestone D+2 AM (KB Capa 1 + ChromaDB Capa 2) | Codex (backend) + Claude (planning/scripts) |

## Riesgo conocido

Algunos archivos del setup (`.audit/budget-notifications.json` por
ejemplo) podrían contener `infra@delivrix.com`. Si el email es
considerado sensible internamente, considerar agregarlo a `.gitignore`
o redactarlo del JSON antes del commit:

```bash
# Si decides redactar el email del repo:
jq '(.[].Subscribers[].Address) |= "REDACTED"' \
  .audit/budget-notifications.json > .audit/budget-notifications.redacted.json
git add .audit/budget-notifications.redacted.json
# y NO incluir budget-notifications.json en git add
```

Por defecto este commit lo incluye porque el email institucional no es
información personal sensible.
