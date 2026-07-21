# BRIEF CODEX — 502 intermitente en /v1/route53/domain-detail (resiliencia)

Fecha: 2026-06-17 · Auditado (2 subagentes + evidencia en logs vivos) · Ejecuta: Codex (backend) · Rama: `produ`.

## Qué pasa (causa raíz, auditada)

`read_route53_domain_detail` (OpenClaw) → `GET /v1/route53/domain-detail` devuelve **502 intermitente**. **NO es un sistema roto ni un bug de credenciales/región: es THROTTLING transitorio de AWS** sobre la operación `GetDomainDetail`, mal manejado por el handler.

- El handler (`apps/gateway-api/src/routes/route53-domain-detail.ts:102-108`) tiene un catch-all que mapea **cualquier** excepción de `client.send(new GetDomainDetailCommand(...))` (L66-71) a un **502 ciego**, sin retry, sin backoff, sin clasificación y **sin loguear el error real de AWS**.
- `GetDomainDetail` tiene rate-limits agresivos. Cuando OpenClaw dispara el detail en **ráfaga** (hoy: 4 dominios en <2s), AWS responde `ThrottlingException`/timeout y el handler lo propaga como 502.
- Es la **misma IAM/región** que `ListDomains` (que funciona) → creds OK. La diferencia es de operación + resiliencia del código.
- **Por qué el LIST funciona y el DETAIL no:** `listInventory` (`packages/adapters/src/aws-route53-domains-adapter.ts:385-416`) **cachea 5min y degrada a HTTP 200 con lista vacía/stale** ante error; el detail pega a AWS en vivo cada vez y **rompe a 502**.

Evidencia: `runtime/logs/gateway-2026-06-17.log:72-85` (8 fallos hoy 22:43Z sobre annualcorpfilings.com, corpyearlyreport.com, nfcfilings.com, nationalbizrenewal.com); 200s históricos en `.audit/` hasta 06-11; el MISMO dominio da 200 unas veces y 502 otras (firma de transitorio). El mensaje real de AWS no aparece en ningún log (hueco de observabilidad).

## Tareas (handler `route53-domain-detail.ts`)

1. **Clasificar el error** en vez de 502 ciego (L102-108), inspeccionando `error.name` / `error.$metadata?.httpStatusCode`:
   - `ThrottlingException` / `TooManyRequestsException` / `OperationLimitExceeded` → **429** (transitorio, reintentable).
   - `DomainNotFound` / `InvalidInput` "not found" → **404** "dato no disponible" (no es de esta cuenta).
   - timeout de red / `TimeoutError` / 5xx de AWS → **503** (o 502 con flag `transient:true`).
2. **Retry con backoff + jitter** para errores throttle/timeout: lo más simple es instanciar el cliente con `new Route53DomainsClient({ ...route53DomainDetailClientConfigFromEnv(env), maxAttempts: 5, retryMode: "adaptive" })` — `adaptive` agrega rate-limiting client-side específico anti-throttle. (Alternativa: retry propio 2-3 intentos, backoff exp 200ms·2^n + jitter, solo throttle/timeout.)
3. **Loguear el error real ANTES de responder** (cierra el hueco): `logger.warn("route53.domain_detail_failed", { domain, awsError: error.name, httpStatus: error.$metadata?.httpStatusCode })`. Sin esto, todo 502 futuro vuelve a ser opaco.
4. **(Opcional) degradar suave:** cachear el último-OK por dominio (como hace `listInventory`) y servir `{ stale:true, ...lastOk }` cuando AWS falle, en vez de romper la respuesta de OpenClaw.
5. **(Opcional) bridge OpenClaw** (`tool-use-processor.ts:615/671`): incluir el body en el Error (`HTTP ${status}: ${body}`) para que el mensaje de AWS llegue al razonamiento del agente y a los logs.

## DoD

- Una ráfaga de N domain-detail seguidos ya no rompe (reintenta/clasifica); el endpoint responde 200 (o 429/404/503 honesto), no 502 ciego.
- Los logs muestran el `awsError` real (name + httpStatus) en cada fallo.
- Tests del handler en verde (cubrir: throttle → 429/retry, not-found → 404, éxito).
- `npm --workspace @delivrix/gateway-api run build` OK.
- **Reiniciar el gateway** (cambio de backend). Verificar con OpenClaw: el read de domain-detail ya no tira 502 bajo ráfaga.

## Commit
Commit standalone de backend (handler + el bridge si se toca + tests). Stage selectivo por paths explícitos (no `git add -A`: `.audit/*`, `runtime/logs/*`, docs, `config/*.bak-*` con secretos quedan afuera). Push a `origin/produ`.
