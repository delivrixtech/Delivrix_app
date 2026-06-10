# Análisis: cómo agregar más cuentas/proveedores VPS "fácil" (7 agentes, 2026-06-09)

Objetivo: una forma simple y repetible de conectar más cuentas Webdock + nuevos proveedores (RackNerd, Contabo, SMTPVPS). Auditado read-only con 7 agentes.

## El hallazgo de fondo (importante)
**Agregar una cuenta NO es solo "meter una API key" hoy** — porque el camino de **escritura/provisión está hardcodeado a Webdock + una sola cuenta**:
- El parámetro `provider` del `configure_complete_smtp` es **decorativo**: se valida (id-safe) y entra al scope de aprobación, pero **NO selecciona adapter ni cuenta**. Todo VPS se crea con el único `webdockOpsAdapter` (`main.ts:333`).
- El multi-cuenta SÍ existe (5 slots: `WEBDOCK_API_KEY_PRIMARY/OPS/ACCOUNT/SECONDARY/TERTIARY`) pero solo alimenta el **inventario de lectura** (`/v1/infrastructure/inventory`), no la provisión.
- NO hay interfaz genérica de proveedor (cada adapter es bespoke); `SenderNode.provider` ya lista `webdock|proxmox|racknerd|manual` pero solo Webdock tiene path real.
- **Dato vivo:** `WEBDOCK_API_KEY_TRABAJO` y `_BILLING` están en `.env.local` pero **ningún adapter los lee** (keys muertas) — exactamente la trampa de "agregué algo y no hace nada".

→ Por eso hay **dos capas**: (1) **registrar** la cuenta (fácil, config) y (2) **enrutar** la build a esa cuenta (el trabajo real, hoy no existe).

## Capa 1 — la forma "fácil" de agregar (lo que pediste)
**Recomendado: híbrido registry + env por referencia.**
- `config/provider-accounts.json` (metadata, SIN secretos): `{accountId, provider, label, region, defaultPlan, credsRef, capabilities, capacity, enabled}`.
- `.env.local` (gitignored): el secreto real, una línea por `credsRef` (ej. `WEBDOCK_API_KEY_TRABAJO=…`, `CONTABO_CLIENT_ID/SECRET/…`).
- **Ritual repetible:** pegar 1 bloque JSON + 1 línea de env + reiniciar gateway. Misma forma para TODO proveedor, sin techo de slots, secretos nunca salen de env gitignored.

### ¿CLI, bash, u otra? (tu pregunta directa)
| Opción | Fácil | Seguro | Repetible | Veredicto |
|---|---|---|---|---|
| **CLI** `npm run provider -- add/list/test/rm` | Alta (un comando, prompts) | Alta (secreto por prompt oculto, chmod 600, enmascara, valida) | Alta (registry autoritativo + idempotente) | **MEJOR** |
| **Bash** (`export …`/editar `.env.local`) | Rápida one-off | Pobre (secreto a shell history/`ps`, typo silencioso, sin validación) | Baja | OK solo para pegar el secreto |
| **Editar JSON a mano** | Media | Media (2 archivos sincronizados a mano) | Media (versionable pero frágil) | Aceptable |

El CLI no reemplaza los archivos — es un **escritor disciplinado** de los mismos dos archivos (valida nombre↔env, no filtra a history, asegura gitignore). `provider test <id>` hace una **lectura barata** contra la API del proveedor para confirmar las credenciales ANTES de confiar en la cuenta. Pickup: el gateway construye adapters al boot → **una cuenta nueva entra al reiniciar** (correcto; el hot-reloader solo recarga flags, nunca secretos).

> **Sobre bash:** la memoria del proyecto lo sancion­a explícitamente para "setup inicial de credentials/env + restart". La línea: **pegar el secreto + reiniciar = ok**; validar/seleccionar/debuggear la cuenta = debe ser tool, no bash.

## Capa 2 — el trabajo real (enrutar + validar)
1. **Abstracción `VpsProvider`** (interfaz: `createServer/getServer/deleteServer` + opcionales `setMainDomain/setPtr/unlockPort25` con **capability flags**). Webdock pasa a ser el **adapter #1, comportamiento idéntico**. Solo **4 de los 14 pasos** están acoplados a proveedor (registro/VPS/bind/PTR); los pasos 9-14 (Postfix/DKIM/warmup/envío) ya son agnósticos (SSH). Refactor mínimo no-breaking: 3 touch-points (dispatcher, registry en main.ts, tipo del skill de rollback).
2. **`validateAccount(account)` (lo de MAYOR valor, hoy NO existe):** probe read-only de credenciales + assert de capacidad + **pre-check de puerto 25** (hoy `port25UnlockRequired` está hardcodeado, nunca se prueba → un host que bloquea el 25 da un SMTP que NO puede enviar) + sanity de región/plan. Convierte 4 fallas de mitad-de-build en bloqueos pre-firma.

## Nuevos proveedores — factibilidad (research web)
| Proveedor | API | Crear VPS | Gestionar (status/power) | Borrar | rDNS por API | Puerto 25 | Veredicto |
|---|---|---|---|---|---|---|---|
| **Contabo** | **Sí (REST + OAuth2)** | ✅ `POST /v1/compute/instances` | ✅ | ✅ | ❌ (panel manual, igual que Webdock) | Abierto, ~25/min | **Full-auto — próximo adapter** |
| **RackNerd** | Parcial (SolusVM **client** API) | ❌ se compra manual en WHMCS | ✅ status/reboot/info | ❌ (admin-only) | ❌ panel | Abierto (verificar por cuenta) | **Comprar-manual-luego-API** (manage-only) |
| **SMTPVPS** (smtpvps.com) | **No** | ❌ orden de venta | ❌ | ❌ | ❌ (lo setea su equipo) | Abierto (es el producto) | **Sin adapter — orden manual + SSH; redundante con nuestra skill SMTP** |

**Secuencia sugerida de adapters:** Contabo (espejo de Webdock, calza directo) → RackNerd (adapter liviano de control, key/hash por VPS) → SMTPVPS NO es target de adapter (mail-stack gestionado, se solapa con lo que ya hacemos).

## Opción autónoma (OpenClaw)
Un tool `register_provider_account` es **factible para la metadata** (provider+accountId+label+**secretRef**) vía ApprovalGate (1 firma), PERO **el secreto NO puede pasar por el agente** (el write-gate episódico prohíbe secretos/free-text + riesgo de leak en el contexto del LLM). Patrón correcto = **split**: OpenClaw registra metadata + la *referencia* al env; el humano/CLI pone el secreto real en `.env.local`. Consistente con cómo el código ya maneja llaves SSH/DKIM (refs/paths, nunca el valor). Opcional, a futuro.

## Recomendación (fases)
1. **Registry + CLI + secretos por credsRef** → la "forma fácil" que pediste (empieza con multi-cuenta Webdock, que ya tiene los slots).
2. **`VpsProvider` + enrutamiento por cuenta + `validateAccount` (con pre-check puerto 25)** → la parte que hace que agregar cuentas sirva de verdad (sin esto son filas de inventario inertes).
3. **Adapter Contabo** (full API). RackNerd = adapter manage-only. SMTPVPS = fuera.
4. (Futuro) tool OpenClaw `register_provider_account` (metadata + ref) para registro autónomo.

## Nota lateral — drift de sender nodes (la pregunta de Juanes)
**Confirmado: NO existe tool de prune del sender-pool** (el registry no tiene primitiva de delete ni en storage). Los 6 huérfanos (`sender_health_complaint_001`, etc., fixtures de prueba, no bloquean) **NO los puede limpiar OpenClaw solo hoy** — es un *gap de tool*. Por la regla de autonomía: se cierra con una tool chica de prune + ApprovalGate (Codex), **no con bash manual**. O se dejan (no bloquean) para un hito separado, como sugirió el propio OpenClaw.
