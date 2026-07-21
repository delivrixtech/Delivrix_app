# HANDOFF A CODEX — Baja de cuentas (URGENTE) + automatizar verificacion live

Fecha: 2026-06-24. Estado: PR #18 y PR #21 MERGEADOS a produ (OpenClaw ya ve las cuentas vivas con
etiqueta tras deploy+restart). Quedan 2 trabajos de implementacion para Codex.

## CONTEXTO QUE LO HACE URGENTE

Dos cuentas Webdock estan PERDIDAS, no caidas: `pep.prz001` (slot SECONDARY) y `Host Latam` Webdock
(slot TERTIARY). El operador YA NO PUEDE INGRESAR a ellas -> no son reautenticables -> dan HTTP 401
permanente y ensucian el inventario (badge "Credencial rechazada / atencion" en el panel).

El sistema HOY no sabe darlas de baja: las cuentas son env-driven (slots fijos primary..quinary en
`createWebdockAdaptersFromEnv`, webdock-real-adapter.ts:929-976), no hay disable/remove/retire, y no
distingue "token expirado" de "cuenta muerta" (todo cae en status "error"). Esto convierte el brief de
baja de cuentas de "nice to have" en **P1 con caso de uso real**.

OJO (no confundir): hay DOS "Host Latam". El de **Webdock** (TERTIARY, 401, perdido) y el de
**Contabo** (8 servidores, ACTIVO, sano) son cuentas DISTINTAS en proveedores distintos aunque
compartan el email hostlatam@proton.me. La baja aplica SOLO a la de Webdock; Contabo no se toca.

## MITIGACION OPERATIVA INMEDIATA (mientras Codex implementa la baja real)

Para que las 2 cuentas muertas dejen de aparecer en 401 ya mismo, el operador comenta sus variables
en `config/gateway.env` Y `.env.local` (hacer backup antes) y reinicia:

- SECONDARY (pep.prz001): `WEBDOCK_API_KEY_SECONDARY`, `WEBDOCK_API_KEY_SECONDARY_WRITE`,
  `WEBDOCK_API_KEY_SECONDARY_ACCOUNT`, `WEBDOCK_ACCOUNT_SECONDARY_LABEL`.
- TERTIARY (Host Latam Webdock): `WEBDOCK_API_KEY_TERTIARY`, `_TERTIARY_WRITE`, `_TERTIARY_ACCOUNT`,
  `WEBDOCK_ACCOUNT_TERTIARY_LABEL`.
- `./restart-gateway.sh`

Efecto: `createWebdockAdaptersFromEnv` deja de cablearlas -> el inventario pasa de 5 a 3 cuentas
Webdock vivas (madre Dep Infraestructura + InfraVPS + emael/quaternary) + Contabo. Reversible. Esto es
un parche; la baja con auditoria (BRIEF 1) es la solucion correcta.

## BRIEF 1 (P1) — Baja de cuentas + reporte de huerfanos

Spec completo ya escrito: `DOCUMENTACION/PROMPT_CODEX_BAJA_CUENTAS_Y_HUERFANOS_2026_06_24.md`.
Resumen del alcance (4 piezas): (1) estado fino de cuenta (active|paused|unauthorized|suspended|
retired, no solo "error"); (2) persistencia de lifecycle de cuenta fuera del env; (3) accion de baja
con ApprovalGate (soft-retire reversible, nunca borrado fisico); (4) reporte de cuentas caidas +
servers/sender-nodes huerfanos. Elevar a P1 por las 2 cuentas muertas reales. DoD en ese doc.

## BRIEF 2 (P2) — Automatizar la verificacion live (el runbook manual hecho capacidad)

Hoy la verificacion del estado de cuentas + memoria episodica es un RUNBOOK MANUAL
(`DOCUMENTACION/runbooks/RUNBOOK_VERIFICACION_LIVE_Y_REAUTH_2026-06-24.md`: el operador corre curls a
mano). Convertirlo en capacidad del sistema:

B2.1 Healthcheck por cuenta (boot + cada poll): distinguir cuenta-perdida/suspendida de
     401-token-transitorio. Hoy el pre-flight es ESTATICO (solo presencia/formato de env, nunca llama
     al API) y CIEGO a las 4 cuentas distintas + Contabo (env-preflight.ts:289-352). Que valide cada
     cuenta en vivo y reporte su estado real.
B2.2 Auditar la TRANSICION de salud de cuenta (evento `oc.webdock.account_unhealthy` con accountId +
     httpStatus + timestamp la primera vez que entra en 401), para tener timeline de "caida desde T".
     Hoy no existe (solo snapshots agregados que se sobrescriben).
B2.3 Telemetria de la memoria episodica 503: confirmar que el catch de `episodic-scratch.ts` loguea
     postgresCode/postgresMessage (parcialmente abordado en #18) y exponer un check de salud de la
     memoria, para no diagnosticar el 503 a ciegas. NOTA OPERATIVA pendiente: el 503 actual es muy
     probablemente esquema NO migrado de `openclaw_episodic_scratch` (42P01/42703), no Postgres caido
     -> correr/verificar migraciones (operador), no es codigo.
B2.4 Endpoint/skill de diagnostico read-only que devuelva, de una, el estado de las N cuentas (vivas/
     perdidas/en cola) + salud de memoria, para que OpenClaw y el operador lo lean sin curls a mano.

## DEPLOY (operador, no Codex)

Para que OpenClaw empiece a ver las cuentas vivas con etiqueta: traer `produ` (ya con #18+#21) a la
rama desde la que corre el gateway local y `./restart-gateway.sh`. El working tree esta hoy en
`codex/pr18-nits`; coordinar el cambio de rama con Codex para no pisar trabajo en curso.

## ORDEN SUGERIDO
1. (operador, ya) Mitigacion env de las 2 cuentas muertas + restart -> inventario limpio.
2. (operador, ya) Deploy produ + restart -> OpenClaw ve 3 Webdock vivas + Contabo etiquetadas.
3. (operador) Verificar/migrar esquema episodico (cierra el 503).
4. (Codex) BRIEF 1 baja de cuentas (P1).
5. (Codex) BRIEF 2 healthcheck/diagnostico live (P2).
