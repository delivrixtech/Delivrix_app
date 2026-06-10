# Codex - Recuperar/re-emitir llaves AWS y reconectar el bridge Bedrock (incidente env clobber)

> Contexto verificado (Claude, 2026-06-09): Vercel CLI piso `.env.local` a las 17:50Z (proyecto ajeno elranchopauto). Ya se restauro casi todo: tokens locales cosechados del panel vivo, audit chain re-apuntada a `.audit/audit-events.jsonl` (el example inyectaba el legacy `runtime/audit-events.json` formato array y rompia TODO lo auditado), gateway y panel reiniciados, canvas en verde. Lo UNICO que falta: las 4 llaves AWS. Sin ellas el bridge Bedrock no activa (`apps/gateway-api/src/openclaw-bedrock-bridge.ts:852` exige kind=bedrock + credenciales), el gateway cae a http y responde el fallback local de plantillas `delivrix.webdock_vps_planner` (`apps/gateway-api/src/openclaw-chat.ts:1884`, habilitado por default en `main.ts:787`) - por eso el chat "se volvio tonto".

## Objetivo
Conseguir credenciales AWS validas para los DOS roles y dejarlas funcionando en `.env.local`, con el gateway en `bridgeKind=bedrock`.

| Slot en .env.local | Usuario IAM | Proposito |
|---|---|---|
| `AWS_BEDROCK_ACCESS_KEY_ID` + `AWS_BEDROCK_SECRET_ACCESS_KEY` | `delivrix-openclaw-prod` | Cerebro OpenClaw (Bedrock us-east-1) |
| `AWS_ROUTE53_ACCESS_KEY_ID` + `AWS_ROUTE53_SECRET_ACCESS_KEY` | `delivrix-route53-discover` | Dominios/DNS Route53 |

`OPENCLAW_BRIDGE_KIND=bedrock`, `AWS_BEDROCK_REGION=us-east-1` y `AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6` YA estan en `.env.local` - no los toques.

## Reglas duras
1. NUNCA imprimas un secreto completo en chat, log o commit. Para reportar usa mascara `primeros2...ultimos4`.
2. `.env.local` NO se commitea (ya esta en .gitignore). No lo copies a ningun otro lado.
3. NO borres ni desactives access keys existentes en IAM. Si un usuario ya tiene 2 access keys (limite AWS) y no hay slot: STOP y reporta - la desactivacion la firma Juanes.
4. Nada de emojis en ningun output (regla del CTO).
5. Si un paso no aplica limpio: stop-and-report, no improvises.

## Pasos (en orden, parar en el primero que funcione)

### A. Buscar copias locales de las llaves originales
1. `find "$HOME" -maxdepth 4 -name "delivrix-*keys.txt" 2>/dev/null` (los setups `ops/openclaw-bedrock-aws-setup.sh:56` y `ops/aws-route53-domain-discovery-setup.sh:22` escribian a `~/.aws-secrets/`; en este Mac esa carpeta esta VACIA - verificado - pero pudo correr con otro HOME o quedar copia en otro lado).
2. `ls ~/.aws/ 2>/dev/null && aws configure list-profiles 2>/dev/null` - si hay perfiles, probar cada uno: `aws sts get-caller-identity --profile X`.
3. `grep -aE "AWS_(BEDROCK|ROUTE53)?_?(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=|aws configure" ~/.zsh_history ~/.bash_history 2>/dev/null | tail -20` (solo para localizar, no pegar valores en el reporte).
4. Si encontraste las llaves de los DOS usuarios: salta a D.

### B. Si hay un perfil AWS CLI funcional con permisos IAM
1. `aws iam list-access-keys --user-name delivrix-openclaw-prod --profile X` y lo mismo para `delivrix-route53-discover`.
2. Si hay slot libre (menos de 2 keys): `aws iam create-access-key --user-name <usuario> --profile X --output json` y captura AccessKeyId/SecretAccessKey directo a variables de shell (no a archivo plano, no a stdout del chat).
3. Si no hay slot libre: STOP y reporta cuantas keys tiene y sus fechas (`CreateDate`), sin borrar nada.

### C. Si no hay ningun acceso AWS local
Reporta exactamente: "No hay acceso AWS local. Se requiere login humano en consola: CloudShell -> cat ~/.aws-secrets/delivrix-openclaw-keys.txt ~/.aws-secrets/delivrix-route53-keys.txt, o IAM -> Users -> delivrix-openclaw-prod y delivrix-route53-discover -> Create access key". No intentes loguearte vos.

### D. Conectar las llaves
1. Edita `.env.local` (raiz del repo) reemplazando los valores de las 4 vars de la tabla. In-place, sin tocar ninguna otra linea, `chmod 600`.
2. Reinicia y verifica con el script existente: `bash ops/recuperar-env-delivrix.sh` (detecta que el env no es el clobbereado, no lo pisa; reinicia gateway+panel y valida /health + bridgeKind + canvas).
3. Verifica en el log: el ultimo `gateway.started` en `runtime/logs/gateway-$(date -u +%Y-%m-%d).log` debe decir `"bridgeKind":"bedrock"` y `bedrockModelId` poblado.
4. Smoke minimo de cerebro: que Juanes mande un mensaje al chat del Canvas; el log debe mostrar `openclaw.chat.received` con `bridgeKind:"bedrock"` y SIN `assistantSource:"delivrix.webdock_vps_planner"`.

## Objetivo secundario (NO bloqueante, solo si A/B dieron acceso rapido)
Buscar copias de `WEBDOCK_API_KEY*`, `IONOS_*`, `PORKBUN_*` en history/archivos locales con el mismo metodo de A.3. Si no aparecen en 5 minutos, reportar "no encontradas, re-emitir en dashboards" y seguir.

## Reporta
1. Que camino funciono (A copia local / B create-access-key / C sin acceso).
2. Las 4 vars conectadas con valores enmascarados.
3. Salida PASS/FAIL del script de recuperacion + la linea `gateway.started` final.
4. Si B: confirmacion de que NO se borro ninguna key existente.
5. Pendientes que queden (Webdock/IONOS/Porkbun si no aparecieron).

> Despues de esto sigue en cola: `DOCUMENTACION/PROMPT_CODEX_P1_1_GOVERNOR_SKIP_ON_RESUME_2026_06_09.md` (fix del governor, ya escrito y auditado). Primero esto, despues P1.1.
