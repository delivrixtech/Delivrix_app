# Roadmap: Terminal embebido en Canvas Live (post-demo)

**Para:** Codex, Juanes.
**De:** Claude.
**Fecha:** 2026-05-29 viernes mañana, pre-demo.
**Status:** **NO para demo viernes** · activación post-MVP.

## Problema observado por el CTO (2026-05-29)

> "tampoco entiendo porque openclaw esta sacando estas ventanas en la terminal de mi mac y no desde la misma plataforma de su propia terminal en canvas live"

Hoy el gateway local arranca con `delivrix-gateway.command` que abre **una ventana Terminal nativa del Mac por cada invocación**. Cada vez que Juanes reinicia o arrastra el script, queda otra ventana viva. Resultado: 5+ terminales apiladas, logs mezclados, ningún cierre limpio.

Eso NO es lo que Delivrix promete vender: el panel admin tiene su propio Canvas Live con tabs `Live / Lecturas / Terminal / Diff / Topología`. El operador espera que todo viva ahí, no en el Terminal de macOS.

## Estado actual del Canvas Live

`apps/admin-panel/src/features/canvas/` ya tiene la sección `Terminal` con tab + diseño visual, pero está hoy poblada con `actions` simuladas (los `oc.read.*`, `oc.exec.*` del feed). NO conecta a un stream real de logs del gateway.

## Por qué NO entra al demo viernes

1. Implementar terminal embebido vivo requiere:
   - Stream de logs del gateway (stdout + stderr) por WSS.
   - Cliente xterm.js o equivalente en el frontend.
   - Backpressure + filtro por nivel (info/warn/error).
   - Resizable, scrollable, copyable.
2. Eso es 4-6h de trabajo limpio. No demo-viable a 1h del demo.
3. El demo se vende con el feed live + skills directas + panel — el Terminal nativo abierto detrás de la pantalla NO se ve si no minimizás Chrome.

## Workaround inmediato para el demo de hoy (3 min, opcional)

Antes del demo, cerrá todas las ventanas Terminal abiertas y arrancá el gateway con `nohup` en background:

```bash
# Cerrar todas las terminales viejas:
osascript -e 'tell app "Terminal" to close every window saving no' 2>/dev/null

# Arrancar gateway en background (logs a archivo, no a ventana):
cd "/Users/juanescanar/Documents/delivrix app"
mkdir -p logs
nohup node --env-file=.env.local apps/gateway-api/src/main.ts \
  > logs/gateway-$(date +%Y%m%d-%H%M%S).log 2>&1 &
echo "Gateway PID: $!"
```

Ahora durante el demo solo abrís Chrome con el panel — el Terminal no se ve. Si necesitás revisar logs después del demo: `tail -f logs/gateway-*.log`.

## Roadmap post-demo

### Fase 1 — Daemon proceso del gateway (~30 min)

**Objetivo:** evitar que el gateway abra ventana Terminal nueva por arranque.

**Tareas:**
1. Reemplazar `delivrix-gateway.command` por `delivrix-gateway-start.sh` que usa `nohup` + PID file en `runtime/gateway.pid`.
2. Crear `delivrix-gateway-stop.sh` que lee el PID y hace `kill`.
3. Logs estructurados a `runtime/logs/gateway.log` rotando diariamente.
4. App de macOS opcional (Automator wrapper) que ejecuta start/stop desde el dock sin abrir Terminal.

**Criterio de aceptación:** arrancar gateway = 0 ventanas Terminal nuevas. Reiniciar = 1 nueva instancia que reemplaza la vieja, no apilada.

### Fase 2 — Terminal embebido en Canvas Live (~4-6h)

**Objetivo:** el tab `Terminal` del Canvas Live muestra logs del gateway en vivo, con UX de terminal real (scroll, búsqueda, copy/paste).

**Tareas backend (~2h):**
1. **Stream WSS de logs**: endpoint `WSS /v1/gateway/logs/stream` que sigue `runtime/logs/gateway.log` con `tail -F` equivalente y emite eventos `{ ts, level, message }`.
2. **Filtro por nivel** server-side: query param `?level=info|warn|error`.
3. **Backpressure**: buffer max 5000 líneas por cliente; descartar más viejas si cliente lento.
4. **Auth**: requiere `DELIVRIX_OPENCLAW_TOKEN` (mismo Bearer que el panel admin usa).

**Tareas frontend (~2h):**
1. **Instalar `xterm.js`** + `@xterm/addon-fit` + `@xterm/addon-search`.
2. **Componente `<EmbeddedTerminal>`** en `apps/admin-panel/src/v5/components/`:
   - Container fit-to-parent.
   - Conectar a `WSS /v1/gateway/logs/stream`.
   - Auto-scroll on new line.
   - Toolbar: clear / pause / level filter / search (Cmd+F).
3. **Reemplazar el tab `Terminal`** del Canvas Live con `<EmbeddedTerminal>`.
4. **Toggle** "Mostrar logs del gateway" vs "Mostrar feed de ejecuciones" (lo que ya hay).

**Tareas QA (~1h):**
1. Test que conecta al stream y verifica que un `console.log` del gateway aparece en <1s.
2. Test de backpressure: 10k líneas rápidas no rompe cliente.
3. Test de reconexión: bajar gateway → terminal muestra "disconnected", subirlo → reconecta.

**Criterio de aceptación:**
- Operador abre panel → /canvas → tab Terminal → ve logs del gateway en vivo, formato `[12:34:56.789] [info] gateway-api listening on http://127.0.0.1:3000`.
- Cero ventanas Terminal nativas en el Mac.
- Demo full-screen del panel cubre todos los logs operativos.

### Fase 3 — Multi-source terminal (~6h, Hito 5.13+)

Extender el terminal embebido para mostrar:
- Logs del gateway.
- Logs del SSH runner cuando se conecta al VPS (postfix install, dovecot setup).
- Logs del IMAP placement-check (sin secrets).
- Output de skills E2E con sintaxis highlighting.

Eso convierte el Canvas Live en una **observability suite real**, no solo un visualizador de tasks.

## Notas de implementación

- `xterm.js` es estándar de industria (VS Code, Hyper, GitHub Codespaces lo usan).
- WSS de logs es patrón conocido — Cloudflare Workers logs, GitHub Actions, Vercel ya lo hacen igual.
- El backend ya tiene infraestructura WSS (canvas-live.ts emite eventos) — extensión natural.
- Privacidad: NUNCA streamear secrets. Pasar todo log por un filtro `redactSecrets()` que reemplaza tokens/API keys con `[REDACTED]` antes de emitir.

## Referencias

- `apps/admin-panel/src/features/canvas/canvas-v4.tsx` — implementación actual del Canvas Live con tabs.
- `apps/gateway-api/src/canvas-live.ts` — emitter WSS existente, base para extender a logs.
- `REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §16` (comandos manuales de monitoreo) — equivalente de los logs que el terminal embebido debería surfacear.

— Claude
