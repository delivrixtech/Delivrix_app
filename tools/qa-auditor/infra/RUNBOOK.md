# Runbook de despliegue - Delivrix QA Senior (AWS)

Receptor del webhook de la GitHub App `Delivrix QA Senior` (App ID 4090313,
instalada en `delivrixtech/Delivrix_app`). Arquitectura: Lambda receiver
(Function URL publica, verifica HMAC, ack 202) -> Lambda worker async (3
subagentes + flag de conflicto) -> comentario + check run. Secretos en Secrets
Manager.

NO commitear secretos reales. Los valores van solo a Secrets Manager.

## Prerrequisitos

- AWS CLI y AWS SAM CLI instalados y autenticados (`aws sts get-caller-identity` OK).
- Node 22+ (para `npx esbuild`).
- A mano: el `.pem` de la private key (en Descargas), el webhook secret (el que
  se genero al crear la App) y la `ANTHROPIC_API_KEY`.

## 1. Desplegar la infraestructura

```bash
cd tools/qa-auditor
AWS_REGION=us-east-1 ./infra/deploy.sh
```

Al final imprime la **Function URL** del receiver. Guardala: es la URL del webhook.

## 2. Cargar los secretos (una sola vez; se actualizan in-place)

Construye el JSON desde el `.pem` con `jq` (preserva los saltos de linea):

```bash
PEM_FILE=~/Downloads/delivrix-qa-senior.*.private-key.pem   # ajusta el nombre exacto

aws secretsmanager put-secret-value \
  --secret-id delivrix/qa-auditor \
  --region us-east-1 \
  --secret-string "$(jq -n \
    --arg api   "$ANTHROPIC_API_KEY" \
    --arg appid "4090313" \
    --arg hook  "$QA_WEBHOOK_SECRET" \
    --rawfile pem $PEM_FILE \
    '{ANTHROPIC_API_KEY:$api, GITHUB_APP_ID:$appid, GITHUB_WEBHOOK_SECRET:$hook, GITHUB_APP_PRIVATE_KEY:$pem}')"
```

Antes de correrlo, exporta los valores en tu shell (no quedan en disco ni en git):

```bash
export ANTHROPIC_API_KEY='...'
export QA_WEBHOOK_SECRET='...'   # el webhook secret generado al crear la App
```

## 3. Apuntar el webhook de la GitHub App a la Function URL

En https://github.com/settings/apps/delivrix-qa-senior -> seccion Webhook:
cambiar **Webhook URL** del placeholder a la Function URL del paso 1 y guardar.
(El secret ya quedo configurado al crear la App; debe ser el mismo que el del
paso 2.)

## 4. Probar

1. Abrir un PR de prueba contra `produ` (o hacer push a `produ`).
2. En segundos aparece el comentario "Delivrix QA Senior - Auditoria automatica"
   y un check run con el veredicto.
3. Si no aparece:
   - GitHub App -> Advanced -> Recent Deliveries: ver el POST y su respuesta (202 esperado).
   - CloudWatch Logs: grupos `/aws/lambda/delivrix-qa-auditor-receiver` y `-worker`.

## Operacion

- Apagar: cambiar el Webhook URL de la App a vacio/placeholder, o `sam delete`.
- Rotar webhook secret: actualizar en la App (Webhook -> Secret) y en Secrets
  Manager (paso 2) con el mismo valor.
- Cambiar modelo o umbral: `sam deploy` con `--parameter-overrides QaModel=... QaFailOn=...`.

## Seguridad

- La Function URL es publica (AuthType NONE) **a proposito**: GitHub no firma con
  IAM. La autenticidad se garantiza con la firma HMAC (X-Hub-Signature-256); todo
  request sin firma valida recibe 401.
- IAM minimo: el receiver solo puede leer el secret e invocar al worker; el
  worker solo puede leer el secret.
- El worker nunca ejecuta el codigo del PR: solo lee el texto del diff.
- Los logs redactan los secretos registrados.
