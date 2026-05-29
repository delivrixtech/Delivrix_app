# Resultado: Terminal embebido en Canvas Live

Fecha: 2026-05-29

## Implementado

- `scripts/delivrix-gateway-start.sh` arranca el gateway con `nohup`, PID file en `runtime/gateway.pid` y logs en `runtime/logs/gateway-YYYY-MM-DD.log`.
- `scripts/delivrix-gateway-stop.sh` detiene solo el PID registrado del gateway.
- `runtime/logs/gateway.log` queda como symlink al log diario actual para consumo estable.
- `WSS /v1/gateway/logs/stream` sigue `runtime/logs/gateway.log`, emite eventos JSON de logs, filtra por `level=info|warn|error`, limita backlog y redacted secrets antes de enviar al panel.
- El tab `Terminal` de Canvas Live consume el WSS real del gateway en modo read-only, con pausa, clear, busqueda local y filtro de nivel.
- El proxy local de Vite y el servidor standalone del admin-panel aceptan el upgrade WSS del nuevo stream.

## Seguridad

- El terminal embebido no ejecuta comandos y no expone input shell.
- El frontend no lee `runtime/` directamente; consume contrato `/v1/gateway/logs/stream`.
- Si `GATEWAY_LOG_STREAM_TOKEN` o `DELIVRIX_OPENCLAW_TOKEN` existe, el stream exige Bearer token o `?token=`.
- Si no hay token configurado en local, el stream queda abierto para desarrollo en `127.0.0.1`.
- Los logs pasan por `redactGatewayLogSecrets()` antes de salir por WSS.

## Pendiente post-MVP

- Reemplazar el render terminal-like por `xterm.js` con addon fit/search.
- Agregar prueba browser de reconexion visual dentro de Canvas.
- Rotacion automatica real a medianoche si el gateway queda vivo varios dias.
