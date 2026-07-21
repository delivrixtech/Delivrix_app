# BRIEF CODEX — Fix: el artifact `smtp_credential` (con boton) queda tapado por el `report` prose en el preview

Fecha: 2026-06-23 · Ejecuta: **Codex** (frontend + posible backend/prompt + deploy) · Coordina: Juanes (CTO) · Auditado por Claude (empirico + codigo) · Despues: **deploy local + Hostinger con commits; NO merge sin OK**

## Contexto (auditado en vivo + empirico, 2026-06-23)

El artifact `smtp_credential` (con boton "Descargar credencial" + link a Sender Pool) **se genera bien** — confirmado consultando `/v1/canvas/live/state`: existe 1 artifact `smtp_credential` (controlnational.com), `hasSmtpCredentialArtifact: true`. **PERO en el preview se ve por un instante y queda tapado** por el reporte markdown de OpenClaw.

**Sintoma:** tras aprobar, el banner con boton aparece, pero apenas OpenClaw termina su resumen, el preview salta al texto markdown "SMTP AUTH configurada — <dominio>" (un artifact `kind: report`, **sin boton**).

## Causa raiz (confirmada)

- El preview muestra **el ultimo artifact**: `const selArt = runIds.length === 0 ? (live.latestArtifact ?? live.artifact) : null;` (`CanvasV5Preview.tsx:612`).
- En el turno de credencial se emiten **DOS** artifacts: (1) el `smtp_credential` tipado (con boton), y (2) un `report` prose con el resumen de OpenClaw ("SMTP AUTH configurada… Credenciales generadas hoy…"). El `report` queda **ultimo** -> gana como `latestArtifact` -> tapa al `smtp_credential`.
- El guard que deberia evitar el prose, `emittedTypedArtifact` (`openclaw-bedrock-bridge.ts:482` decl por-turno, `:519` guard del prose, `:600` emite el typed), es **por-turno de Bedrock**. El typed se emite en el turno de ejecucion de la tool; el **resumen** de OpenClaw es un **turno de texto posterior** donde `emittedTypedArtifact` arranca en `false` -> emite el `report` prose. (Tambien influye la doble ruta: ejecucion via dispatcher de firma tras "aprobado" vs tool_use de Bedrock.)
- Empirico: `/v1/canvas/live/state` tiene **919 artifacts** acumulados (report 174, proposal 538, template 81, plan 105, blacklist_report 20, **smtp_credential 1**). El credential existe pero no es el `latestArtifact`.

**NO es problema de dato ni de seguridad:** la credencial, el boton y la descarga funcionan (Sender Pool siempre la tiene; el `.md` baja 200). Es solo **que artifact gana en el preview**.

## Dato verificado que define el fix (2026-06-23)

- `latestArtifact` = el artifact global mas reciente por `createdAt` (`canvas-live-client.ts:534`). El propio codigo comenta el problema: *"typed usan `bedrock:<msgId>`, prose `chat:<msgId>`, titulos distintos que nunca matchean"* (`:531-533`).
- Empirico (`/v1/canvas/live/state`): el `smtp_credential` tiene `taskId = bedrock:0c783c78-...`; el `report` que lo tapa tiene `taskId = chat-0c783c78-...` (5s despues). **Los `taskId` NO matchean, pero comparten el `<msgId>` (`0c783c78`).**
- Implicacion: correlacionar por `taskId` NO sirve; correlacionar por el **`<msgId>` embebido** SI (es deterministico, ambos formatos lo llevan).

## Fix (primario = frontend display-only, el de MENOR riesgo de regresion)

1. **PRIMARIO — frontend, solo display (no puede romper el pipeline):** en la seleccion del preview (`CanvasV5Preview.tsx:612`), si el `latestArtifact` es un `report` prose Y existe un artifact `smtp_credential` con el **mismo `<msgId>` embebido** (extraer `<msgId>` de `bedrock:<msgId>` y de `chat-<msgId>-<ts>`), mostrar el `smtp_credential` (con boton) en su lugar. Scope estricto: solo intercambia cuando el report mas reciente tiene un credential hermano del mismo `<msgId>` -> NO muestra credenciales viejas (cuando el operador pasa a otra cosa, el nuevo latest gana) y NO afecta a ningun otro tipo de artifact. Respeta el gate de recencia existente. **Blast radius = solo que se muestra; cero riesgo sobre creacion/descarga/pipeline.**
2. **Secundario/opcional (backend o prompt) — eliminar la duplicacion en origen:** que el turno de resumen no emita un `report` redundante cuando ya se emitio el `smtp_credential` del mismo `<msgId>` (persistir el flag por conversacion, no por turno de Bedrock), o que el prompt (v2.13) de una confirmacion corta en chat en vez de un reporte markdown. **Nota:** esto toca la logica de emision compartida por TODOS los flujos -> mayor blast radius; hacerlo solo si el #1 no alcanza, y con su propia bateria de no-regresion.

> Recomendacion: implementar SOLO el #1 primero (display-only, minimo riesgo). El #2 queda documentado pero no es necesario para resolver el sintoma.

## Invariantes / NO-regresion (CRITICO — pedido permanente de Juanes)

1. **No tocar lo que ya anda:** la credencial sigue creandose igual (`enable_smtp_auth` gateado), el boton de Sender Pool sigue bajando el `.md`, el no-leak (sin password en chat/artifact) intacto.
2. **No romper otros artifacts:** los `report`/`inventory`/`blacklist_report`/`dns_zone`/`smtp_run`/`plan`/`proposal` deben seguir mostrandose normal cuando NO hay credencial. El cambio de seleccion debe ser **scopeado** (solo cuando coexisten credential+report del mismo turno), no un "siempre preferir typed".
3. **Degradacion graciosa intacta:** kind desconocido sigue cayendo a `ProseArtifact` (`:572`); el `ArtifactErrorBoundary` queda.
4. **Sin password/ciphertext** en ningun payload nuevo.
5. **Aditivo y reversible;** tag de respaldo + rollback 1 comando.
6. Sin emojis; ASCII en codigo; espanol formal en docs.

## Observacion secundaria (no es el fix, pero anotala)

`/v1/canvas/live/state` acumulo **919 artifacts**. Revisar que la eviccion del canvas-live siga acotada (hubo fixes previos de memleak). No abordar en este brief salvo que sea trivial; solo verificar que no crece sin tope.

## DoD

- Tras generar una credencial, el preview **queda mostrando el artifact `smtp_credential`** (con boton "Descargar credencial" + link "Ir a Sender Pool") — no lo tapa el resumen markdown.
- Generar una credencial nueva sigue funcionando E2E (propose -> aprobar -> retrofit -> configured) + el `.md` baja desde el boton del preview Y desde Sender Pool.
- Los demas artifacts (report/inventory/blacklist/dns_zone/smtp_run/plan/proposal) se muestran igual que antes (test de no-regresion).
- Sin password en chat/artifact (test anti-leak sigue verde).
- `npm test` + `npm run test:admin` verdes + Vite build.
- Deploy local Y Hostinger con commits. NO merge a produ sin review.

## Anclas (verificadas 2026-06-23)

- Seleccion del preview: `apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx:612` (`selArt = live.latestArtifact`), render switch `:567-572`, `ArtifactErrorBoundary` + `SmtpCredentialArtifact`.
- Emision/guard: `apps/gateway-api/src/openclaw-bedrock-bridge.ts:482` (`emittedTypedArtifact` por-turno), `:519` (guard prose `!emittedTypedArtifact`), `:600` (emite typed), `:794` (`emitTypedArtifactFromToolResult`), `:1556` (`enable_smtp_auth` -> `smtpCredentialArtifactFromToolResult`), `:1668` (builder, sin password).
- Estado live: `GET /v1/canvas/live/state` (`tasks` + `artifacts`).
- Prompt: `OPENCLAW_SYSTEM_PROMPT.md` (v2.13 si se ajusta el resumen) + `scripts/openclaw/build-system-context.sh`.
