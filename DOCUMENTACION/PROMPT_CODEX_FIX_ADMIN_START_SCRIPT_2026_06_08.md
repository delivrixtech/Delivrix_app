# Codex — FIX `scripts/delivrix-admin-start.sh`: arranque fiable + garantía de token del WS

> **Estado:** auditado a fondo con 5 subagentes (2026-06-08) contra el script real, `.env.local`, `vite.config.ts`, el gateway WS y el bundle de Vite 8.0.11. Es el follow-up del "Canvas en `reconnecting`". **NO es regresión de los 3 commits previos** (vite.config/WS client/WS auth/script predan a ellos). El script corre en **macOS** (`screen`, `lsof`, BSD `awk`, bash 3.2) bajo `set -euo pipefail`. **No se puede unit-testear en sandbox Linux** (runtime macOS + levanta Vite real) → la verificación final la corre Codex en el Mac de Juanes.
>
> **Subagentes OBLIGATORIO:** un subagente aplica y un Auditor INDEPENDIENTE revisa ANTES del commit (set -e safety, flags macOS, %q, que NO se imprima ningún valor de token, que el fail-fast NO use el `VITE_` ausente). Stop-and-report si algo no aplica limpio.

## Causa raíz (verificada)
El WS `/v1/canvas/live/stream` exige token; el gateway lo rechaza con **401** si falta (`apps/gateway-api/src/services/canvas-live-events.ts:82,917-926`, fail-closed). El token llega por DOS vías:
1. **Cliente** `VITE_CANVAS_LIVE_STREAM_TOKEN` (`canvas-live-client.ts:30`) → **no existe en ningún `.env`, por diseño.**
2. **Proxy Vite** inyecta `?token=` en el **upgrade** (`vite.config.ts:13-17,193-208`; el `rewrite` SÍ corre en el upgrade, verificado en `node_modules/vite/.../node.js:17864`) con `canvasLiveProxyToken = CANVAS_LIVE_STREAM_TOKEN ?? DELIVRIX_READ_BOUNDARY_TOKEN ?? OPENCLAW_GATEWAY_TOKEN`.

En `.env.local` solo está **`OPENCLAW_GATEWAY_TOKEN`** (los otros ausentes). Entonces el WS depende de que **ese token esté en el env del proceso Vite** al arrancar. Arrancado por el script (carga `.env.local`) → funciona. Arrancado manual (`npm run dev` suelto) → proxy sin token → **401 → reconnecting**.

El **gatillo** que llevó al arranque manual: el loop de readiness del script son **~6s** (`for _ in {1..30}; sleep 0.2`, líneas 127-134) pero Vite tarda **40-100s** en el optimize en frío/re-optimize (PROBADO: 35 `node_modules/.vite/deps_temp_*` huérfanas + triple "header→silencio→re-run" en `runtime/logs/admin-panel-2026-06-08.log`). El script reporta `PID: pending` a los 6s aunque Vite siga subiendo → el operador lo da por muerto y va a manual → tokenless → reconnecting.

## Objetivo
(A) El script **nunca** arranca un panel cuyo WS no pueda autenticar (fail-fast sobre el token **efectivo**), y (B) deja un dev server **vivo y listo** en el primer intento (readiness real + diagnóstico), para que nadie tenga que caer a un `npm run dev` manual tokenless.

## CORRECCIÓN crítica (no hacer)
El fail-fast **NO** debe chequear `VITE_CANVAS_LIVE_STREAM_TOKEN` (está ausente por diseño → daría falso-fallo y rompería el setup que HOY funciona vía `OPENCLAW_GATEWAY_TOKEN`). Debe chequear el **token efectivo** = `CANVAS_LIVE_STREAM_TOKEN ?? DELIVRIX_READ_BOUNDARY_TOKEN ?? OPENCLAW_GATEWAY_TOKEN` (el mismo fallback que resuelve el proxy y el gateway).

## Las 5 ediciones EXACTAS (anclas = substrings reales del archivo)

### EDIT 1 — Token efectivo + fail-fast. Insertar DESPUÉS del bloque `NODE_BIN_DIR` (línea 80), ANTES del `if screen -ls` (línea 82).
```bash
# --- Token efectivo del Canvas Live WS (espejo del fallback de vite.config.ts) ---
# El proxy resuelve canvasLiveProxyToken = CANVAS_LIVE_STREAM_TOKEN ?? DELIVRIX_READ_BOUNDARY_TOKEN ?? OPENCLAW_GATEWAY_TOKEN
# Fail-fast: nunca lanzar un panel cuyo WS no pueda autenticar (= "reconnecting" perpetuo).
CANVAS_LIVE_EFFECTIVE_TOKEN="${CANVAS_LIVE_STREAM_TOKEN:-${DELIVRIX_READ_BOUNDARY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}}"
if [[ -z "${CANVAS_LIVE_EFFECTIVE_TOKEN}" ]]; then
  echo "FATAL: no hay token para el Canvas Live WS." >&2
  echo "  Definí CANVAS_LIVE_STREAM_TOKEN (o DELIVRIX_READ_BOUNDARY_TOKEN u OPENCLAW_GATEWAY_TOKEN) en ${ROOT_DIR}/.env.local antes de arrancar el panel." >&2
  exit 1
fi
```

### EDIT 2 — Esperar liberación del puerto tras matar el holder. Reemplazar el bloque de puerto (líneas 98-110) por el mismo + este loop al final del `if`:
```bash
  # Esperar a que :PORT quede realmente libre antes de que Vite haga bind
  # (evita EADDRINUSE y que Vite con strictPort:false agarre :PORT+1 en silencio).
  for _ in {1..50}; do
    [[ -z "$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)" ]] && break
    sleep 0.2
  done
  if [[ -n "$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)" ]]; then
    echo "Puerto ${PORT} sigue ocupado tras ~10s. Abortando." >&2
    exit 1
  fi
```
(Insertar inmediatamente después del `stop_admin_pid`/`else…exit 1` existente, DENTRO del `if [[ -n "${port_pid}" ]]`.)

### EDIT 3 — Propagación EXPLÍCITA del env al screen hijo (no depender de herencia/login-profile). Reemplazar la línea 122 (`printf -v start_cmd ...`) por:
```bash
printf -v start_cmd 'export PATH=%q:"$PATH"; export ADMIN_PANEL_HOST=%q; export ADMIN_PANEL_PORT=%q; export ADMIN_PANEL_GATEWAY_ORIGIN=%q; export CANVAS_LIVE_STREAM_TOKEN=%q; export GATEWAY_LOG_STREAM_TOKEN=%q; export DELIVRIX_READ_BOUNDARY_TOKEN=%q; export DELIVRIX_OPENCLAW_TOKEN=%q; export OPENCLAW_GATEWAY_TOKEN=%q; export VITE_CANVAS_LIVE_STREAM_TOKEN=%q; export VITE_GATEWAY_LOG_STREAM_TOKEN=%q; export VITE_DELIVRIX_READ_BOUNDARY_TOKEN=%q; export VITE_DELIVRIX_OPENCLAW_TOKEN=%q; cd %q && exec npm run dev >> %q 2>&1' \
  "${NODE_BIN_DIR}" "${HOST}" "${PORT}" \
  "${ADMIN_PANEL_GATEWAY_ORIGIN:-}" \
  "${CANVAS_LIVE_STREAM_TOKEN:-}" "${GATEWAY_LOG_STREAM_TOKEN:-}" \
  "${DELIVRIX_READ_BOUNDARY_TOKEN:-}" "${DELIVRIX_OPENCLAW_TOKEN:-}" "${OPENCLAW_GATEWAY_TOKEN:-}" \
  "${VITE_CANVAS_LIVE_STREAM_TOKEN:-}" "${VITE_GATEWAY_LOG_STREAM_TOKEN:-}" \
  "${VITE_DELIVRIX_READ_BOUNDARY_TOKEN:-}" "${VITE_DELIVRIX_OPENCLAW_TOKEN:-}" \
  "${APP_DIR}" "${LOG_FILE}"
```
- Cada valor con `%q` (round-trip seguro por `bash -lc`, incluso con `"`, `$`, `;`, backticks). **NUNCA se imprime un valor en logs** — solo entran al exec del screen.
- Cada var es `${VAR:-}` (vacía si ausente; segura bajo `set -u`; inocua — el `??`/`||` de Vite cae igual que hoy). Es la misma allowlist que `load_admin_proxy_env` ya carga → el Vite hijo ve el MISMO env que el padre, inmune a clobbering del profile. Aditivo/idempotente → no rompe el camino que funciona.

### EDIT 4 — Readiness robusto + liveness + tail del log. Reemplazar el loop (líneas 126-134) por:
```bash
admin_pid=""
# Hasta ~60s: (a) verifica que el screen siga vivo, (b) que el puerto escuche.
# screen -ls / lsof / grep / curl devuelven !=0 en casos normales → TODOS guardados bajo set -euo pipefail.
for _ in {1..60}; do
  if ! screen -ls 2>/dev/null | grep -q "[.]${SCREEN_NAME}"; then
    echo "El screen '${SCREEN_NAME}' murió durante el arranque." >&2
    echo "--- últimas 40 líneas de ${LOG_FILE} ---" >&2
    tail -n 40 "${LOG_FILE}" >&2 2>/dev/null || true
    exit 1
  fi
  admin_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "${admin_pid}" ]]; then
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsS -o /dev/null --max-time 2 "http://${HOST}:${PORT}/" 2>/dev/null; then
        sleep 1; continue
      fi
    fi
    echo "${admin_pid}" > "${PID_FILE}"
    break
  fi
  sleep 1
done

if [[ -z "${admin_pid}" ]]; then
  echo "El panel no quedó listo en :${PORT} tras ~60s." >&2
  echo "--- últimas 40 líneas de ${LOG_FILE} ---" >&2
  tail -n 40 "${LOG_FILE}" >&2 2>/dev/null || true
  exit 1
fi
```
- Liveness con `screen -ls | grep -q "[.]NAME"` (NO usar `screen -Q`: ausente en el screen 4.00.03 de macOS).
- `curl` opt-in (si no está, se salta; un no-200 transitorio solo hace `continue`, no falla) → un optimize lento no da falso-fallo. Flags `-f -s -S --max-time` portables a macOS.
- Presupuesto ~6s → ~60s: cierra el gatillo del "pending" prematuro.

### EDIT 5 — (opcional) el bloque final de `echo` (136-139) ya solo se alcanza en éxito (EDIT 4 hace `exit 1` en fallo). Dejarlo como está.

## PROHIBIDO
- NO chequear `VITE_CANVAS_LIVE_STREAM_TOKEN` en el fail-fast (ausente por diseño → falso-fallo).
- NO imprimir valores de tokens en stdout/stderr/logs (solo `%q` hacia el exec).
- NO usar flags GNU-only (`timeout`, `grep -P`, `readlink -f`, `screen -Q`). Todo BSD/macOS.
- NO dejar comandos no-cero sin guardar (`lsof`/`curl`/`grep`/`screen -ls` → `|| true` o dentro de `if`), o `set -e` aborta.
- NO tocar `vite.config.ts`, el WS client, ni el gateway (esto es solo el script).

## DoD (Codex — verifica EN EL MAC, no en CI)
1. Aplicar las 5 ediciones.
2. `bash -n scripts/delivrix-admin-start.sh` (sintaxis OK) + `shellcheck` si está disponible (reportar warnings).
3. **En el Mac:** matar cualquier panel manual, correr `./scripts/delivrix-admin-start.sh` → debe (a) NO reportar "pending" prematuro: esperar el optimize y reportar un **PID vivo** en el primer intento; (b) abrir `http://127.0.0.1:5173/canvas` → el chip pasa a **"connected"/Live** (no "reconnecting").
4. Probar el fail-fast: con un `.env.local` sin ninguno de los 3 tokens efectivos, el script debe `exit 1` con mensaje claro (revertir el `.env.local` después).
5. Confirmar que el **gateway** corre con `OPENCLAW_GATEWAY_TOKEN` (si su `streamToken` queda "", rechaza a TODOS — `canvas-live-events.ts:82,918`). Si el WS sigue en reconnecting tras el fix del script, ESA es la causa restante (env del gateway, fuera de este script).
6. Commit atómico: "Harden admin-panel start: effective-token fail-fast + explicit env propagation + robust readiness". Push `origin produ` (FF). (Solo script — no toca gateway/Hostinger.)

## Reportá
SHA + `bash -n`/shellcheck + resultado en el Mac (PID vivo al 1er intento + Canvas "connected") + que el fail-fast dispara + que el gateway tiene el token, y que NO imprimiste valores de tokens ni tocaste vite.config/WS/gateway.
