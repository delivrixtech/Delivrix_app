# v1.0 — 2026-08-05

Primera versión declarada. El sistema existía desde hace meses; esta es la primera vez que
se le pone número, y coincide con el día en que producción dejó de ser una laptop.

- **Producción vive en la Mac Studio, 24/7.** El cerebro (gateway, panel, warmup, OpenClaw,
  PostgreSQL) corre bajo launchd en `/Users/Shared/delivrix`: arranca sin que nadie inicie
  sesión y se relanza solo si algo muere. Medido: tras un reinicio, todo volvió en 20 segundos
  sin intervención humana.
- **El lock anti-duplicados del warmup, arreglado.** Duraba unos 10 segundos (se tomaba sobre el
  pool de conexiones, y pg-pool cierra las ociosas): desde entonces, un segundo daemon podía
  correr y duplicar el volumen hacia Gmail. Ahora es un cliente dedicado, se revalida en cada
  vuelta, y ante la duda no envía.
- **Despliegue de una sola línea.** `scripts/produccion/desplegar.sh` lleva `produ` a producción,
  reinicia solo los servicios cuyos archivos cambiaron y verifica que el gateway responda con el
  commit nuevo antes de darse por bueno.
- **Versión visible.** Este archivo es la fuente: su primer encabezado es la versión que reporta
  `/health`, muestra el panel y reciben los agentes internos en cada turno.
