# RUNBOOK CODEX — Merge + deploy de Contabo provider

Objetivo: mergear `feature/contabo-provider` a `produ` y desplegar (gateway local). Ejecuta en el host macOS, desde la raiz del repo. Sigue los pasos EN ORDEN. Si cualquier paso falla su check, NO continues: anda a la seccion ROLLBACK.

Repo: `/Users/juanescanar/Documents/delivrix app`
Rama a mergear: `feature/contabo-provider` (2 commits: `3c9e80c` core seam+adapter, `4c45c0e` step-8 bind + fixes), fast-forward sobre `produ` (`49cfac1`).
Regla dura del repo: ASCII puro, sin emojis. NO `git checkout <ref> -- .` (rompe staged). NO tocar el camino Webdock (ya quedo byte-identico).

## QUE ES (contexto en 30s)
Agrega Contabo como 2do proveedor de VPS al flujo SMTP, en paralelo a Webdock, via:
- `VpsProvider` (interface que `WebdockRealAdapter` satisface sin cambios) + canal paralelo `providerId` (hermano de `serverAccountId`, NUNCA en `params` -> `inputHash`/plan-signature Webdock intactos).
- `ContaboAdapter` (OAuth2 + refresh, createInstance, poll IP, SSH via Secrets API, cancel, clasificacion de pago) + `createContaboAdaptersFromEnv`.
- Step-8 bind Contabo (hostname por SSH + PTR manual via audit + gate FCrDNS).
Invariante ya verificado (3 auditorias senior + diff): con `providerId` ausente/"webdock" o sin creds Contabo, el camino Webdock es BYTE-IDENTICO. Tests: 184/0 dirigidos. tsc gateway: 107 errores = baseline (0 nuevos).

---

## PASO 0 — PRE-FLIGHT (verificar antes de tocar nada)

```
cd "/Users/juanescanar/Documents/delivrix app"

# 0.1 estar en produ
git branch --show-current          # ESPERADO: produ

# 0.2 el branch existe y es FF (produ es ancestro)
git rev-parse --verify feature/contabo-provider   # imprime un sha (4c45c0e...)
git merge-base --is-ancestor produ feature/contabo-provider && echo "FF-OK" || echo "NO-FF"   # ESPERADO: FF-OK

# 0.3 ver exactamente los 2 commits y el changeset
git log --oneline produ..feature/contabo-provider                 # ESPERADO: 4c45c0e + 3c9e80c
git diff --stat produ feature/contabo-provider                    # 14 archivos, ~2845 ins / 25 del

# 0.4 que TU trabajo en curso no choque: ninguno de los 14 archivos del feature debe estar modificado sin commitear
git status --porcelain
```
CHECK Paso 0: `FF-OK` y ninguno de estos 14 archivos aparece en `git status` con ` M`/`MM`/`A`:
`apps/gateway-api/src/main.ts`, `apps/gateway-api/src/routes/orchestrator-smtp.ts`, `apps/gateway-api/src/routes/webdock-bind-domain.ts`, `apps/gateway-api/src/routes/webdock-servers.ts`, `apps/gateway-api/src/skill-dispatcher.ts`, `apps/gateway-api/src/skill-schemas.ts`, `packages/adapters/src/index.ts`, `packages/adapters/src/vps-provider.ts`, `packages/adapters/src/contabo-adapter.ts`, y los 3 `*.test.ts` correspondientes.
Si TENES cambios sin commitear en esos archivos: commitea o `git stash` TU trabajo primero. (`.audit/audit-events.jsonl` modificado o docs untracked NO importan, no chocan.)
ABORT si: `NO-FF` (el branch divergio; avisar, no mergear a ciegas).

---

## PASO 1 — MERGE (fast-forward, sin merge commit)

```
git merge --ff-only feature/contabo-provider
git log --oneline -1               # ESPERADO: 4c45c0e ... (produ ahora apunta ahi)
```
`--ff-only` es a proposito: si por lo que sea NO es FF, falla solo y no genera un merge a medias. CHECK: HEAD de produ = `4c45c0e`.

---

## PASO 2 — VERIFICACION POST-MERGE (en produ, antes de desplegar)

```
# 2.1 suite DIRIGIDA del write-path + Contabo (rapida) -> debe dar 184/0
node --test \
  apps/gateway-api/src/routes/orchestrator-smtp.test.ts \
  apps/gateway-api/src/skill-dispatcher.test.ts \
  apps/gateway-api/src/routes/webdock-servers.test.ts \
  apps/gateway-api/src/routes/webdock-bind-domain.test.ts \
  apps/gateway-api/src/skill-schemas.test.ts \
  packages/domain/src/creation-rate-governor.test.ts \
  packages/adapters/src/webdock-real-adapter.test.ts \
  packages/adapters/src/contabo-adapter.test.ts 2>&1 | tail -6
# ESPERADO: # pass 184  # fail 0

# 2.2 suite COMPLETA (la del repo). En macOS NO deberia reproducir la unica falla ambiental del sandbox
#     (approval-token.test.ts daba EACCES mkdir /private/tmp en Linux; en mac /private/tmp existe).
npm test 2>&1 | tail -15
# ESPERADO: todo verde. Si aparece approval-token.test.ts fallando por /private/tmp, es ambiental (ignorable).
#           CUALQUIER otra falla -> ROLLBACK.

# 2.3 smoke de boot/resolucion: el gateway carga el nuevo import sin romper y el provider Contabo se arma desde env
node --env-file=config/gateway.env --input-type=module -e \
  'import {createContaboAdaptersFromEnv} from "./packages/adapters/src/index.ts"; const e=createContaboAdaptersFromEnv(); console.log("contabo entries:", e.map(x=>x.id), "| isLive:", e[0]?.adapter?.isLive?.(), "canCreate:", e[0]?.adapter?.canCreate?.());'
# ESPERADO: contabo entries: [ 'contabo' ] | isLive: true canCreate: true
```
CHECK Paso 2: 2.1 = 184/0; 2.2 = verde (salvo la ambiental conocida); 2.3 imprime `[ 'contabo' ] ... true true`.
ABORT -> ROLLBACK si: 2.1 tiene fails, 2.2 tiene una falla NO ambiental, o 2.3 no arma el provider.

---

## PASO 3 — DEPLOY (solo gateway LOCAL)

Este cambio es codigo del GATEWAY (orquestador/adapter) que corre LOCAL. NO toca el prompt de OpenClaw -> NO va a Hostinger en este deploy. (La regla "local + Hostinger juntos" aplica a cambios del agente; este no lo es.)

```
# Reiniciar el gateway con el procedimiento habitual (el que levanta
# apps/gateway-api/src/main.ts con --env-file=config/gateway.env).
# Al bootear, el pre-flight de env debe listar las CONTABO_* presentes y
# el log debe poblar vpsProviderAdapters con la key "contabo".
```
CHECK Paso 3: el gateway levanta sin errores de import; el pre-flight de env muestra `CONTABO_CLIENT_ID/CLIENT_SECRET/API_USER/API_PASSWORD` OK; no hay regresion en el arranque (Webdock sigue igual).

---

## ROLLBACK (si cualquier check fallo)

Mientras NO hayas publicado/compartido produ a otros (solo local):
```
git reset --hard 49cfac1     # vuelve produ al estado pre-merge exacto
git log --oneline -1          # ESPERADO: 49cfac1
```
Reinicia el gateway sobre `49cfac1`. El branch `feature/contabo-provider` queda intacto para reintentar tras corregir. Reporta el error exacto (el output del check que fallo).

---

## FUERA DE ALCANCE DE ESTE MERGE (follow-ups, NO hacer ahora)

1. **E2E real**: crear 1 VPS Contabo via el flujo = COMPRA real (~EUR 4.50). Requiere OK de Juanes + saldo en la cuenta Host Latam + que Juanes setee el PTR en el panel Contabo cuando el flujo lo pida (FCrDNS gatea). Antes de E2E, confirmar contra la cuenta: region exacta `US-east`, specs reales de `V45` (subir a `CONTABO_PRODUCT_ID=V48` si poco vCPU/RAM), el lookup de imagen Ubuntu 22.04, que la SSH key del operador entra al box como root (provisioning Y bind usan la misma), puerto 25 saliente. Esos valores son config por env (`CONTABO_REGION`, `CONTABO_PRODUCT_ID`, `CONTABO_IMAGE_ID`) -> ajustables sin tocar codigo.
2. **OpenClaw que ELIJA Contabo solo**: hay que ensenarle el param `vpsProviderId:"contabo"` en su prompt/guia (cuando usar Contabo vs Webdock). ESO si va a Hostinger (cambio de agente). Para un E2E disparado a mano (un run con `vpsProviderId:"contabo"`) NO hace falta.

## INVARIANTES A NO ROMPER (si tocas algo)
- `providerId`/`vpsProviderId` NUNCA dentro de `params` de un step (rompe `inputHash` + plan-signature).
- El camino Webdock (create, bind step-8, delete, rollback) debe quedar byte-identico cuando `providerId` ausente/"webdock".
- No reusar el campo `provider` (ese es el registrar DNS = route53), distinto de `vpsProviderId` (proveedor de VPS).
