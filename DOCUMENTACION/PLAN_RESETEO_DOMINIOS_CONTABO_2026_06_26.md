# PLAN DE RESETEO — Re-montar SMTPs de dominios huérfanos en Contabo

Fecha: 2026-06-26 · Basado en auditoría profunda (8 subagentes de disco + verificación live en panel Delivrix: blacklist de IPs + mapeo de cuentas Webdock).

## Contexto (por qué este plan)
- **Webdock NO está operativo:** ops y quaternary fueron **baneadas por Webdock** (401 `webdock_auth_failed` desde el 26-jun 07:55-08:00Z, confianza alta de que fue acción de Webdock por las IPs que cayeron en Spamhaus). quinary (InfraVPS) responde la API pero está **pausada con sus 13 servers `stopped`**. → Para envío real, **Contabo es la única vía operativa** hoy.
- Los dominios ya están pagados (Route53/IONOS) y son **reusables**. No hace falta comprar nuevos (además la cuota AWS está topada).
- Objetivo: re-montar los SMTPs huérfanos en Contabo, reusando los dominios.

## Clasificación (de la auditoría)

### NO TOCAR — 4 en uso (Contabo viva, entregando)
`controlcontrolledger.com` (IP 147.93.186.66, limpia), `bizreport-control.com` (86.48.29.176, limpia), `infranationalreport.com` (217.216.51.187, RATS-Dyna pero entrega), `corp-delivery.com` (217.216.53.43, RATS-Dyna pero entrega).

### RESETEAR — dominios huérfanos (montar SMTP desde 0 en Contabo)

**Tanda 1 — urgentes (binding activo en cuenta ops baneada):**
- `filing-ops.com` (server139, IP quemada Spamhaus + cuenta caída)
- `corpfiling-ops.com` (server85, IP limpia pero cuenta caída)

**Tanda 2 — huérfanos sin SMTP activo (server viejo apagado en quinary / caído en ops):**
- `controlcorpfiling.com`, `corpdocfiling-ledger.com`, `controlledgerdesk.com`, `corpfilingcontrol.com`, `nationalcorpops.com`, `corpfiling-delivery.com`, `controldelivrix.app`, `annualcorpfilings.com`, `controlnational.com`, `corpfiling-infra.com`

**Tanda 3 — libres del todo (sin ningún server):**
- `bizfiling-ops.com`, `controlcorpfilingpro.com`, `controlnationalcorp.com`, `controlnationalreport.com`, `delivrix-notify.com`, +otros que quieras activar.

(IONOS: 3 zonas reusables — `corpyearlyreport.com`, `nationalbizrenewal.com`, `nfcfilings.com`.)

## REGLAS DE EJECUCIÓN (críticas — para no quemar Contabo)

1. **GRADUAL, no en lote.** Máx **2-3 SMTPs nuevos por día** en Contabo. Montar 20 de golpe = patrón *snowshoe* = es justo lo que disparó el ban en Webdock. Contabo tiene GTC anti-spam (suspende 24h, puede terminar la cuenta).
2. **Verificar la IP de cada VPS apenas se cree** (`read_mxtoolbox_health`): si cae en `217.216.x` (RATS-Dyna) o cualquier blacklist, **abortar/recrear**; el rango limpio confirmado es `147.93.x` y `86.48.x`. El chequeo de IP en el flujo (FIX 4 pendiente) automatizaría esto.
3. **El governor NO gobierna Contabo todavía** (eso es el PR2 pendiente). → Por ahora el límite anti-snowshoe es **manual**: respetá el ritmo vos.
4. **PTR/rDNS manual** en el panel de Contabo por cada VPS (OpenClaw te dará el hostname y esperará tu confirmación).
5. **Warmup gradual** antes de volumen real en cada dominio nuevo.
6. **Diversificá.** Contabo es 1 ASN; concentrar 20 SMTPs ahí repite el riesgo estructural. Caminos para diversificar: despausar quinary en Webdock (otra cuenta), o infra propia (ver informe de infra propia). No pongas todos los huevos en Contabo.

## PROMPT REUTILIZABLE (uno por dominio)
Reemplazá `<DOMINIO>` por el dominio de la tanda:

> Creá un SMTP en **Contabo** (`vpsProviderId=contabo`). **No registres un dominio nuevo** — adoptá el dominio que ya tengo: **`<DOMINIO>`** (`requireExistingDomain=true`, `dnsProviderId=route53`) y re-apuntá su DNS al nuevo server. Hostname `smtp.<DOMINIO>`.
>
> **Salvaguarda de reputación:** apenas el VPS tenga IP, corré `read_mxtoolbox_health` sobre ella. Si aparece en Spamhaus o cualquier blacklist, **detente y avísame** (preferimos rango 147.93.x / 86.48.x; evitá 217.216.x). Si está limpia, seguí.
>
> **PTR/rDNS manual de Contabo:** cuando llegues a ese paso, dame el hostname exacto a configurar y **esperá mi confirmación** antes del FCrDNS gate.
>
> Si algo falla y hay que reanudar: mismo runId y scope firmado, no cambies `requireExistingDomain` ni pidas datos que ya estén en el run-state.

## LIMPIEZA DE COSTOS (aparte del reseteo)
- **16 servers Webdock viejos facturan sin uso.** Los de quinary (stopped) se borran al despausar/gestionar quinary; los de ops/quaternary (caídas) requieren el **panel de Webdock directo** (la API está bloqueada).
- Confirmar en el panel de Webdock el motivo del ban de ops/quaternary (¿abuse/Spamhaus? ¿recuperables?).

## PENDIENTES DE CÓDIGO (Codex) que apoyan este plan
- **FIX 4** — chequeo de blacklist en el flujo (antes de declarar completado) → evita gastar en IP quemada sin verificar manual.
- **PR2** — governor para Contabo (4/24h por cuenta) → freno anti-snowshoe automático.
