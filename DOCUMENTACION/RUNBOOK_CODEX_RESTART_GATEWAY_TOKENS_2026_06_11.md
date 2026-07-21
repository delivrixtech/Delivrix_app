# RUNBOOK CODEX — Restart del gateway para aplicar los 2 tokens rotados

Objetivo: reiniciar el gateway local para que tome los 2 tokens que se rotaron de placeholder a secreto fuerte, y verificar que arranca limpio (0 warnings del pre-flight) sin romper Canvas/chat. Ejecutar en el host macOS, desde la raiz del repo. ASCII puro, sin emojis.

## CONTEXTO (que cambio y por que)
- Se rotaron `DELIVRIX_READ_BOUNDARY_TOKEN` y `DELIVRIX_OPENCLAW_TOKEN` de placeholder (32 chars con patron) a **secreto fuerte de 64 hex**, en `config/gateway.env` Y `.env.local`.
- `scripts/delivrix-env-doctor.sh` (mismo pre-flight, en frio) ya da **29/29 OK | 0 fatal | 0 warning** sobre el archivo. Falta que el PROCESO vivo (corre con los placeholders viejos en memoria, PID que escucha en :3000) tome los nuevos -> por eso este restart.
- AUDITORIA previa: nada estaba roto. Los criticos (`OPENCLAW_GATEWAY_TOKEN`, `CANVAS_LIVE_STREAM_TOKEN`, `GATEWAY_LOG_STREAM_TOKEN`) ya eran 64hex reales y van primero en toda cadena de fallback. `READ_BOUNDARY` era read-boundary INTERNO del gateway (presenter+validator = mismo proceso/env -> auto-consistente); `DELIVRIX_OPENCLAW_TOKEN` era fallback muerto. Esto es higiene (quitar tokens predecibles), no un fix de una falla. El restart es seguro.

---

## PASO 0 — PRE-CHECK (en frio, antes de tocar el proceso)
```
cd "/Users/juanescanar/Documents/delivrix app"

# 0.1 el archivo ya esta limpio (debe decir 29/29 OK, 0 warning)
bash scripts/delivrix-env-doctor.sh 2>&1 | tail -3

# 0.2 ver que hay corriendo en :3000 (el PID actual que se va a reemplazar)
lsof -ti :3000 || echo "  (nada en :3000)"
```
CHECK 0: env-doctor = `29/29 OK | 0 fatal | 0 warning`. Hay un PID en :3000 (el gateway actual). Si env-doctor mostrara algun warning/fatal, NO reinicies: reporta cual.

---

## PASO 1 — RESTART (script canonico: mata :3000 + relanza en screen + health-check)
```
bash scripts/gateway-restart.sh
```
Esto: (1) mata el screen `delivrix-gateway` y CUALQUIER PID en :3000 (kill -9), (2) relanza `node --env-file=config/gateway.env apps/gateway-api/src/main.ts` en screen `delivrix-gateway` con log en `runtime/gateway-smoke.log`, (3) hace polling a `/health`.
CHECK 1: la salida del script debe decir `OK levantado en ~Ns`, mostrar el screen `delivrix-gateway` activo y un PID escuchando en :3000. Si dice `NADA ESCUCHANDO` o `NO SCREEN`, el boot fallo -> mira `runtime/gateway-smoke.log` (PASO 3).

---

## PASO 2 — VERIFICAR (los 3 puntos)
```
# 2.1 /health del gateway
curl -s http://127.0.0.1:3000/health | head -c 400; echo
# ESPERADO: {"status":"ok", ... postgres/redis ok, flags SMTP/autonomia ON}

# 2.2 pre-flight del BOOT = 0 warnings (lo imprime main.ts via console.log(envPreflight.report))
grep -nE "pre-flight|OK \||fatal|warning|READ_BOUNDARY|OPENCLAW_TOKEN" runtime/gateway-smoke.log | tail -20
# ESPERADO: el resumen del pre-flight con 0 fatal / 0 warning; NINGUNA linea marcando
#           DELIVRIX_READ_BOUNDARY_TOKEN ni DELIVRIX_OPENCLAW_TOKEN como placeholder.

# 2.3 (sanity de la feature) Canvas Live + chat siguen autenticando
#     Abri el panel admin (http://127.0.0.1:5173) y confirma:
#     - Canvas Live conecta (NO queda en "reconnecting"/401).
#     - El chat autenticado responde.
#     Nota: el panel usa CANVAS_LIVE_STREAM_TOKEN (64hex real, NO se toco), asi que
#     deberia andar identico a antes del restart.
```
CHECK 2: 2.1 `status: ok`; 2.2 pre-flight sin fatal ni warning y sin los 2 tokens marcados; 2.3 Canvas Live conecta y chat responde.

---

## PASO 3 — SI ALGO FALLA (diagnostico, NO revertir a ciegas)
```
# log completo del boot (incluye el pre-flight y cualquier stack)
tail -60 runtime/gateway-smoke.log
```
- Los placeholders viejos ya NO existen en el archivo (se sobrescribieron), asi que no hay "revert" a placeholder y no hace falta: la rotacion es gateway-interna y auto-consistente.
- Si el boot falla, casi seguro es por OTRA cosa (no por estos 2 tokens). Captura el error exacto del log y reporta. Flag de escape SOLO si el pre-flight diera un fatal nuevo inesperado y hay que arrancar igual: `GATEWAY_ENV_PREFLIGHT_ENFORCE=false` (no recomendado; mejor arreglar la var).
- Si Canvas Live quedara en "reconnecting" (improbable): es un mismatch de `CANVAS_LIVE_STREAM_TOKEN` entre panel y gateway, NO de los tokens rotados. Compara que el panel y el gateway lean el mismo `CANVAS_LIVE_STREAM_TOKEN`.

## NOTA HOSTINGER (no urge, no es parte de este restart)
`DELIVRIX_OPENCLAW_TOKEN` es fallback muerto en el codigo actual del gateway (el chat valida con `OPENCLAW_GATEWAY_TOKEN`, ya real). La vieja nota "debe coincidir con Hostinger" es vestigial. Si en el futuro se reactiva el bridge de Hostinger y usa `DELIVRIX_OPENCLAW_TOKEN`, setear el MISMO valor de 64hex en el env del container Hostinger.
