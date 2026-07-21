# BRIEF CODEX — Artefacto `smtp_credential` en el preview: boton "Descargar credencial" + link "Ir a Sender Pool"

Fecha: 2026-06-23 · Ejecuta: **Codex** (frontend + backend + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (anclas verificadas) · Despues: **deploy local + Hostinger con commits; NO merge sin OK**

## Contexto (auditado 2026-06-23)

El feature `enable_smtp_auth` ya anda E2E (credencial creada + descargada desde Sender Pool). PERO cuando OpenClaw confirma la credencial, el **preview/artefacto** del Canvas muestra solo **texto** ("Descarga tu credencial -> Sender Pool -> <dominio> -> Credencial") — **no hay link ni boton clickeable**, asi que el operador tiene que ir a Sender Pool y buscar la fila a mano. Mala UX.

**Causa (verificada):** ese resultado se renderiza como reporte **markdown** generado por OpenClaw, NO como un artefacto estructurado. El preview tiene un renderer type-aware con 4 kinds estructurados (`inventory`, `blacklist_report`, `dns_zone`, `smtp_run`) que SI pueden tener botones; la credencial no es uno de ellos.

## Objetivo

Nuevo tipo de artefacto **`smtp_credential`** con su renderer en el preview, que muestre la metadata de la credencial + **boton "Descargar credencial"** (mismo endpoint gateado, NO el chat) + **link "Ir a Sender Pool"** (navega al dominio). Consistente con los 4 kinds existentes.

## Lo que se cablea

### Tipos (wire)
1. Agregar `"smtp_credential"` a **`CanvasLiveArtifactKindWire`** (`apps/admin-panel/src/features/canvas/live-tool-types.ts:17`) y la variante a **`CanvasLiveArtifactPayloadWire`** (`:241`): `{ kind: "smtp_credential"; domain: string; host: string; username: string; ports: { submission: 587; smtps: 465 }; hasCredential: boolean }`. **SIN password, SIN ciphertext, SIN authTag.**
2. Espejar el kind en el tipo backend `CanvasLiveArtifactPayload` (el que usa `openclaw-bedrock-bridge.ts:1606` via `Extract<..., { kind: "blacklist_report" }>`).

### Backend (emision)
3. Emitir el artefacto estructurado cuando `enable_smtp_auth` devuelve `hasCredential: true`. Modelo: como se emiten `inventory` (`openclaw-bedrock-bridge.ts:1591`) y `blacklist_report` (`:1606`) via `canvasLiveEvents.upsertArtifactSnapshot(...)` (tambien en `main.ts:708/3810/3831`). El payload se deriva sin secretos: `host = smtp.<domain>`, `username = mailer@<domain>`, `ports {587,465}`, `domain`, `hasCredential`. **Nunca el password.**

### Frontend (renderer)
4. En `apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx`: agregar `SmtpCredentialArtifact` (modelo: `InventoryArtifact` `:330`, `BlacklistArtifact` `:350`, `SmtpRunArtifactView` `:390`), registrar en `kindMeta` (`:435`, p.ej. label "Credencial SMTP", icon KeyRound) y en el switch de render (`:454-457`). El renderer muestra:
   - tabla metadata (dominio, host, usuario, puertos, estado),
   - **boton "Descargar credencial"** -> reusa la descarga gateada,
   - **link/boton "Ir a Sender Pool"** -> navega a la seccion sender-pool (idealmente deep-link al dominio).
5. **Extraer** `downloadSmtpCredential(domain)` de `SenderPool.tsx:337` a un util compartido (p.ej. `shared/api/smtp-credentials.ts`) y usarlo en ambos (SenderPool + el nuevo renderer). NO duplicar el fetch.
6. Navegacion "Ir a Sender Pool": usar el mecanismo existente (`OpenClawIntentProvider onNavigate`, `App.tsx:170`, o el router de secciones). Si hay deep-link por dominio, resaltar/scrollear esa fila (opcional).

## Invariantes (no romper nada, no filtrar)

1. **El payload del artefacto NUNCA contiene el password / ciphertext / authTag** — solo metadata (domain/host/username/ports/hasCredential). La redaccion (`isSensitiveLiveContextKey`) sigue intacta.
2. **El boton "Descargar" usa el MISMO endpoint gateado** `GET /v1/sender-pool/credentials/{domain}/download` (read-boundary) — no un path nuevo, no imprime el secreto en chat/artefacto. El secreto solo viaja en el archivo descargado.
3. "Ir a Sender Pool" es **solo navegacion** (sin secreto).
4. Consistente con los 4 kinds existentes; no romper el render de los otros artefactos ni canvas-v5/chat-history.
5. Sin emojis; ASCII en codigo; espanol formal en docs.

## No-regresion (CRITICO — pedido explicito de Juanes: "no puede fallar nada de lo que ya funciona")

Este cambio es **100% aditivo: solo agrega presentacion.** Reglas duras, verificadas contra el codigo (2026-06-23):

1. **Degradacion graciosa (verificado, `CanvasV5Preview.tsx:453-458`):** el switch de render cae a `<ProseArtifact>` (markdown) para cualquier kind no reconocido. Agregar el branch `if (p?.kind === "smtp_credential") return <SmtpCredentialArtifact .../>;` **ANTES** del `return <ProseArtifact>` default, **sin tocar los 4 branches existentes ni el default**. Consecuencia: si el backend emite el kind antes de que el frontend lo conozca, cae al markdown de hoy — **nunca crashea**, y el deploy BE/FE puede ir en cualquier orden.
2. **Renderer defensivo (CRITICO — NO hay ErrorBoundary a nivel artefacto en v5; verificado):** un throw en `SmtpCredentialArtifact` romperia TODO el preview (solo lo atrapa el `PanelErrorBoundary` de `App.tsx` -> Canvas muestra error). El renderer DEBE tolerar payload parcial/null/campos faltantes sin lanzar (optional chaining + defaults). **Recomendado: envolver el cuerpo del artefacto en un ErrorBoundary chico en v5** (proteje tambien a los otros 4 kinds).
3. **Emit best-effort (no bloqueante):** emitir el artefacto NO puede fallar la creacion de la credencial. El `upsertArtifactSnapshot` va en try/catch que se traga el error; `enable_smtp_auth` devuelve su resultado igual. La credencial + la descarga por Sender Pool funcionan **aunque el artefacto no se emita**.
4. **Descarga existente byte-identica:** extraer `downloadSmtpCredential` debe ser **verbatim** (mover la funcion + re-importarla en `SenderPool.tsx`). El boton de descarga de Sender Pool (que YA funciona, verificado en produccion con corpfiling-ops.com) queda igual.
5. **Endpoint sin cambios:** se reusa `GET /v1/sender-pool/credentials/{domain}/download` tal cual. Cero paths nuevos.
6. **El pipeline gateado NO se toca:** `enable_smtp_auth`, propose/approve/sign, el retrofit, el no-leak del password — nada de eso cambia.
7. **Respaldo antes de tocar:** tag de la rama + rollback en 1 comando (como en integraciones previas).

## DoD

- Tras generar una credencial, el preview muestra un artefacto `smtp_credential` con: metadata, boton **"Descargar credencial"** (baja el `.md`, 200) y link **"Ir a Sender Pool"** (navega al dominio).
- El payload del artefacto **no** contiene el password (test que lo verifique).
- `downloadSmtpCredential` reusado (SenderPool + renderer), sin duplicar.
- Los otros 4 artefactos siguen renderizando igual.
- `npm test` + `npm run test:admin` verdes + Vite build.
- **Aceptacion de NO-REGRESION (re-correr lo que ya anda, obligatorio):**
  - Generar credencial E2E (propose -> aprobar -> retrofit -> `configured`) sigue funcionando igual.
  - El boton de descarga de **Sender Pool** sigue bajando el `.md` (200).
  - Los 4 artefactos (`inventory`/`blacklist_report`/`dns_zone`/`smtp_run`) renderizan **identico**.
  - Con el emit del artefacto fallando a proposito, la credencial **igual se crea y se descarga** (best-effort).
  - Un artefacto con kind desconocido sigue cayendo a `ProseArtifact` (no crash).
- Deploy a local Y Hostinger con commits; rebuild system-context si el prompt de OpenClaw debe mencionar el artefacto. **NO merge a produ sin review.**

## Anclas (verificadas 2026-06-23)

- Tipos: `apps/admin-panel/src/features/canvas/live-tool-types.ts:17` (`CanvasLiveArtifactKindWire`), `:241` (`CanvasLiveArtifactPayloadWire`). Backend espejo: tipo usado en `openclaw-bedrock-bridge.ts:1606`.
- Emision: `canvasLiveEvents.upsertArtifactSnapshot(...)` (`main.ts:708/3810/3831`; `openclaw-bedrock-bridge.ts:831`); modelos `inventory` `:1591`, `blacklist_report` `:1606`.
- Renderer: `CanvasV5Preview.tsx` — `InventoryArtifact:330`, `BlacklistArtifact:350`, `SmtpRunArtifactView:390`, `kindMeta:435`, switch `:454-457`.
- Descarga a reusar: `SenderPool.tsx:337` `downloadSmtpCredential` -> `GET /v1/sender-pool/credentials/{domain}/download`.
- Nav: `OpenClawIntentProvider` (`App.tsx:170`).
- Handler que dispara: `apps/gateway-api/src/routes/enable-smtp-auth.ts` (devuelve `{ ok, domain, status, hasCredential }`).
