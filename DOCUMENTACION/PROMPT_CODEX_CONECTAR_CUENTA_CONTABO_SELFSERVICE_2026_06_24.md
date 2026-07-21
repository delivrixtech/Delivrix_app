# BRIEF CODEX — Conectar cuentas Contabo self-service desde el panel (validacion en vivo, multi-cuenta, sin romper lo actual)

Fecha: 2026-06-24 · Ejecuta: **Codex** (backend) + **Claude** (frontend) · Coordina: Juanes (CTO) · Disenado y aterrizado en codigo vivo por Claude · Severidad: media (mejora de operabilidad; NO debe tocar el camino que ya funciona)

## Problema (auditado en vivo 2026-06-24)

Hoy agregar una cuenta Contabo = cirugia de env + codigo, y "siempre se rompe algo". Causa raiz confirmada:

- `packages/adapters/src/contabo-adapter.ts:844` `createContaboAdaptersFromEnv()` lee **UN solo** juego de env (`CONTABO_CLIENT_ID/CLIENT_SECRET/API_USER/API_PASSWORD` + `CONTABO_ACCOUNT_LABEL`) y devuelve **UNA** entrada hardcodeada `{ id: "contabo", ... }`. No hay forma data-driven de sumar otra cuenta.
- **NO hay validacion al agregar:** una cred con typo o sin scope queda a medio-cablear y corrompe el run. Ese es el origen real del "se rompe algo".

**Buena noticia (lo que NO hay que reconstruir):** el registry de abajo (`vpsProviderEntries` en `main.ts:390/867`, mapa `providerId -> adapter`) **YA soporta N entradas**. El cuello de botella es SOLO el parseo. Y el `ContaboAdapter` ya tiene `listServers()` (GET /v1/compute/instances) + token OAuth (auth.contabo.com) -> hook listo para validar.

## Objetivo

Un boton "Conectar cuenta Contabo" en el panel (seccion Infraestructura): el operador pega label + las 4 creds OAuth, el gateway las **VALIDA en vivo ANTES de registrar**, y si pasan, persiste la cuenta en un registry durable y la activa. Cero bash/Codex para sumar cuentas. Multi-cuenta real. El camino single-account de hoy queda **byte-identico**.

## Backend (Codex)

1. **Registry durable de cuentas Contabo (encriptado).** Store dedicado (reusar el cifrado de credenciales SMTP / `CREDENTIAL_ENCRYPTION_KEY`, AES-256-GCM) con N cuentas `{ id, label, clientId, clientSecret, apiUser, apiPassword, region }`. Un loader construye un `ContaboAdapter` por cuenta -> entrada de registry `{ id: "contabo-<slug>", label, adapter }`.
   - **INVARIANTE:** el path existente de env `CONTABO_*` sigue cargando byte-identico como `id: "contabo"`. El registry nuevo es **ADITIVO** (cuentas de env + cuentas del store, ambas se registran). Si el store esta vacio -> comportamiento de hoy intacto.
2. **Endpoint validate** `POST /v1/providers/contabo/validate` (gated): recibe `{ clientId, clientSecret, apiUser, apiPassword, region? }`; instancia un `ContaboAdapter` efimero; llama `listServers()` (token + lectura). Devuelve `{ ok, instanceCount?, error? }` **SIN persistir**. Auth error -> `ok:false` con mensaje claro. Esta es la compuerta que evita el "se rompe".
3. **Endpoint register** `POST /v1/providers/contabo/accounts` (gated, `supervised_local_state` -> aprobacion del operador): re-valida (paso 2), persiste encriptado al registry, y activa el adapter (hot-add al mapa en memoria; si es mas seguro, devolver "reiniciar para activar" — elegir lo robusto). Idempotente por label/slug.
4. **Secretos:** las 4 creds son SECRETOS -> store encriptado, **NUNCA** en logs/audit/chat/respuestas. Las respuestas de validate/register devuelven SOLO metadata no-secreta (ok, label, instanceCount, slug). El operador las ingresa en su propio panel; ni Claude ni OpenClaw las ven ni las imprimen.
5. **Aislamiento write-key (BUG latente conocido):** cada cuenta debe crear VPS con SUS PROPIAS creds (hubo un bug donde la secundaria escribia en la cuenta-1). Test explicito: un create ruteado a `contabo-B` usa el adapter de B, no el de A.

## Frontend (Claude)

- Seccion Infraestructura: tarjeta/boton "Conectar cuenta Contabo".
- Form: `label` + 4 campos de cred (`type=password`), boton **"Validar"** -> llama validate -> muestra verde (instanceCount) o rojo (error) inline.
- Boton **"Conectar"** (habilitado solo tras validar OK) -> register (gated -> aprobacion). Al confirmar, la cuenta aparece en la lista de providers.
- Estilos 100% tokens.css (monocromatico, `.cv5`); sin secretos en el DOM tras submit.

## Fuera de alcance v1 (anotar, no construir)

- **Seleccion de cuenta por create:** que cuenta Contabo usa cada VPS nuevo. Hoy el governor esta short-circuiteado para no-Webdock (single). v1: el operador elige el `providerId` por run (el canal ya existe). Selector automatico multi-Contabo = follow-up.

## Invariantes / no-regresion (CRITICO)

1. Cuenta Contabo actual (de env, `id:"contabo"`) **sin cambios** — carga y crea igual.
2. Webdock multi-cuenta y el flujo `configure_complete_smtp` **sin cambios** (camino de creacion byte-identico para cuentas existentes).
3. Secretos nunca a logs/audit/chat. Cifrado en reposo.
4. register gateado por aprobacion humana (`supervised_local_state`).
5. Sin emojis; ASCII en codigo; espanol formal en docs.

## DoD

- Agregar una 2da cuenta Contabo 100% desde el panel: Validar **rechaza** una cred mala (sin persistir); con creds buenas, Conectar persiste + activa.
- La cuenta actual de env queda intacta (test byte-identico del path env single-account).
- Un create puede targetear la cuenta nueva (su `providerId`) y usa SUS creds (test de aislamiento write-key).
- Secretos nunca en logs/audit/respuestas (test que serializa y verifica ausencia de clientSecret/apiPassword).
- `npm test` + `npm run test:admin` verdes + tests nuevos. Deploy local + Hostinger. **NO merge a produ sin review + auditoria en vivo de Claude.**

## Anclas (verificadas 2026-06-24)

- Parseo single hardcoded: `packages/adapters/src/contabo-adapter.ts:844` `createContaboAdaptersFromEnv` (return `[{ id: "contabo", ... }]`).
- Registry multi-entry: `apps/gateway-api/src/main.ts:390` (`vpsProviderEntries = createContaboAdaptersFromEnv()`) + `:867` (registry `providerId -> adapter`).
- Hook de validacion: `ContaboAdapter.listServers()` (GET /v1/compute/instances) + token OAuth (auth.contabo.com); capacidades `isLive()/canWrite()/canCreate()`.
- Routing de provider: `apps/gateway-api/src/server-provider.ts` `getProviderFromServerIdentity` (matchea `accountId==="contabo"` / slug `contabo-`).
- Cifrado a reusar: el store de credenciales SMTP (`smtp-credentials.ts`, AES-256-GCM con `CREDENTIAL_ENCRYPTION_KEY`).
- Riesgo write-key per-account: ver memoria multicuenta (la secundaria no debe escribir en cuenta-1).
