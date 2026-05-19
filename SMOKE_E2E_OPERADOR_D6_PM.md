# Smoke E2E del operador · D+6 PM Hito 5.11.B

> Esto NO es un OPS para Codex. Es tu guion como operador para hacer el
> ciclo end-to-end que cierra el hito.

## Qué estás probando

Que el sistema OpenClaw + Delivrix funciona como un todo, no como piezas
sueltas. Hasta ayer cada milestone validó una pieza: HMAC, hash chain,
runbooks individuales. Hoy validas la **conexión real** entre ellas.

El ciclo canónico del cronograma rector:

```
Vos preguntás algo natural en OpenClaw chat
  → Agente lee fleet (delega a skills delivrix-fleet-ops / drift-monitor)
  → Agente razona y propone vía canvas.prompt del panel
  → Vos firmás desde el admin panel
  → Gateway ejecuta el runbook
  → State local muta (registry actualizado)
  → Audit chain extiende SHA-256
  → [opcional] Vos revertís y el state vuelve atrás
```

## Pre-flight (5 min antes de empezar)

Codex dejó el Gateway local detenido al cerrar D+6 AM. Levantar todo:

```bash
WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
cd "${WORKTREE}"

# 1. Gateway local + admin panel
bash restart-gateway.sh   # gateway-api en :3000
npm --workspace @delivrix/admin-panel run dev  # panel en :5173 (otra terminal)

# 2. Reverse SSH tunnel (container → tu Gateway)
ssh -fNT -R 3000:127.0.0.1:3000 root@2.24.223.240

# 3. Verificar que OpenClaw responde
ssh root@2.24.223.240 'docker exec openclaw-dtsf-openclaw-1 curl -sf http://127.0.0.1:3000/health'
# Esperado: {"ok":true}

# 4. Verificar chain íntegra pre-smoke
node --import tsx scripts/audit/verify-chain.ts
# Esperado: OK exit 0 (events_total = 163 al cierre de D+6 AM, puede ser mayor)
```

Tener abiertos:
- Terminal con tail del audit: `tail -f .audit/audit-events.jsonl`
- Admin panel en navegador (`http://localhost:5173`)
- OpenClaw chat (dashboard Hostinger o como lo abras vos)

## Paso 1 — Pregunta natural al agente

Abrí el chat de OpenClaw y escribí algo como:

> "Qué hay raro en la flota hoy?"

o

> "Mostrame el estado de los sender nodes y decime si hay algo que requiera atención"

Lo que esperás ver:

- El agente debería invocar `delivrix-fleet-ops` y/o `drift-monitor` y/o
  `delivrix-alert-ops`.
- Respuesta en chat: resumen del fleet (svc-mvp-test-01 en warming día 2,
  svc-mvp-test-02 retired, svc-mvp-test-03 active tras smoke OH).
- En el audit tail debés ver eventos `oc.skill.fleet_ops.invoke`,
  `oc.read.sender_nodes`, etc.

Si el agente no invoca ninguna skill (responde solo desde KB), reformulá
más específico: "consultá el registry actual de sender nodes via skill".

## Paso 2 — Pedir una acción concreta

Una vez veas el estado en chat, pedile algo accionable. Opciones naturales:

**Opción A (warming, 2 firmas):**
> "svc-mvp-test-01 está en warming día 2. Si la reputación está limpia, proponé subirlo a día 3."

**Opción B (pause, 1 firma):**
> "svc-mvp-test-03 está active. Proponé pausarlo, simulamos detección de spike."

**Opción C (quarantine, 1 o 2 según hora):**
> "Detectaste blacklist hit en svc-mvp-test-03. Proponé cuarentena urgente."

Lo que esperás ver:

- El agente razona en chat: cita preconditions, evidence, runbook ref.
- Internamente hace `POST /v1/agent/proposals` con HMAC firmado.
- En el audit tail: `oc.proposal.submitted` con `severity` y `targetRef`.

## Paso 3 — Verificar el canvas.prompt en el panel

Abrí el admin panel → sección **Canvas** → mirá el strip del prompt
debajo del swimlane.

Esperás ver:

- Cajita con la propuesta del agente (gradient amber para warming/pause,
  badge rojo crítico para quarantine).
- Headline + body con la justificación.
- Botón primario "Revisar plan dry-run" o "Cuarentena urgente".
- Si requiere 2 firmas (warming o quarantine off-hours): contador "0/2 firmas".

Si no aparece, esperá 30s (el polling del panel) o recargá. Si sigue sin
aparecer, mirá en chat si Codex configuró el endpoint bien — el
`buildOpenClawLiveCanvas` debe estar leyendo del `proposalsStore`.

## Paso 4 — Firmar

Para opciones A o C-off-hours: tenés que firmar 2 veces con identidades
distintas (`op-juanes-a` y `op-juanes-b`).

Forma fácil con curl si el botón del panel no acepta cambiar approverId:

```bash
# Firma A
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/<proposalId>/approve \
  -H "X-Operator-Id: op-juanes-a" | jq

# Firma B (solo si requiere 2)
curl -s -X POST http://127.0.0.1:3000/v1/agent/proposals/<proposalId>/approve \
  -H "X-Operator-Id: op-juanes-b" | jq
```

Esperás ver en la respuesta:

- `quorum.current` incrementando
- `quorum.reached: true` cuando alcanzás el N requerido
- En el audit tail: `oc.approval_token.issued` + (cuando reached)
  `oc.approval.quorum_reached`

## Paso 5 — Ejecutar el runbook

Si el panel del D+5 PM/D+6 AM cabló el auto-execute post-quorum, debería
dispararse solo. Si no, lo hacés vía curl con HMAC firmado:

```bash
HMAC_SECRET=$(grep OPENCLAW_HMAC_SECRET .env.local | cut -d= -f2)

# Para warming
BODY='{"proposalId":"<proposalId>","runbookId":"warming-step","input":{"nodeId":"svc-mvp-test-01"}}'

# Para pause
# BODY='{"proposalId":"<proposalId>","runbookId":"pause-ip","input":{"nodeId":"svc-mvp-test-03","reason":"Smoke E2E"}}'

# Para quarantine
# BODY='{"proposalId":"<proposalId>","runbookId":"incident-quarantine","input":{"nodeId":"svc-mvp-test-03","reason":"Blacklist hit Spamhaus","evidenceRefs":["sha:smoke-e2e"]}}'

TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')
curl -s -X POST http://127.0.0.1:3000/v1/agent/runbook/execute \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Signature: ${SIG}" \
  -H "X-OpenClaw-Timestamp: ${TS}" \
  -d "$BODY" | jq
```

Esperás:

- HTTP 200 con `rollbackToken` y `newState`
- En el audit: `oc.runbook.<id>.executed` con `approverIds` y `rollbackToken`
- Verificar el state mutó: `curl http://127.0.0.1:3000/v1/sender-nodes -H "Authorization: Bearer $DELIVRIX_OPENCLAW_TOKEN" | jq`

## Paso 6 — Revertir (opcional pero recomendado)

Con el `rollbackToken` del paso 5:

```bash
# Para warming/pause/quarantine
curl -s -X POST http://127.0.0.1:3000/v1/agent/runbook/revert \
  -H "X-Operator-Id: op-juanes-a" \
  -H "Content-Type: application/json" \
  -d '{"rollbackToken":"<token>","reason":"Smoke E2E rollback"}' | jq

# Para quarantine con target específico:
# -d '{"rollbackToken":"<token>","reason":"Smoke E2E","metadata":{"targetStatus":"active"}}'
```

Esperás:

- HTTP 200 `{"reverted":true,"restoredState":{...}}`
- En el audit: `oc.runbook.<id>.reverted`
- State del nodo restaurado al `prevState`

## Paso 7 — Verificar chain íntegra

```bash
node --import tsx scripts/audit/verify-chain.ts
```

Esperás:

```
events_total=<N>     # mayor que pre-smoke
chain_ok=<N>
chain_broken=0
missing_prev_hash=0
OK
```

Exit code 0.

## Criterios de éxito del smoke E2E

Verde si los 6 puntos pasan:

1. ✅ Pregunta natural en chat → agente invoca skill(s) y responde con
   data del registry
2. ✅ Pedido accionable → propuesta llega a canvas.prompt del panel
3. ✅ Firma(s) → `quorum.reached: true` (1 o 2 según runbook)
4. ✅ Execute → HTTP 200 con rollbackToken + state mutado verificable en
   `/v1/sender-nodes`
5. ✅ Revert (si lo hiciste) → state restaurado al prev
6. ✅ `verify-chain.ts` post-smoke → exit 0

## Lo que validás con esto

- **Que el agente sabe usar sus skills.** Si en paso 1 no invocó ninguna,
  el system prompt no está cabeado bien al runtime real.
- **Que la cadena HMAC funciona end-to-end.** El agente firma su POST,
  el Gateway valida, los smokes anteriores ya probaron unitario pero acá
  va con tráfico real del LLM.
- **Que el canvas se actualiza con propuestas vivas.** El polling del
  panel + el `proposalsStore` + el `buildOpenClawLiveCanvas` funcionan
  conectados.
- **Que el operador puede firmar y ejecutar desde el panel.** Esto
  cierra el bucle UI ↔ backend.
- **Que el audit chain crece y verifica.** Compliance foundation activa.
- **Que el rollback restaura sin romper la chain.** El sistema es
  reversible.

## Si algo sale rojo

No es el fin del mundo — el smoke E2E está para revelar gaps de
integración. Anotá:

- En qué paso falló (1-7)
- Output exacto del error / observación
- Estado del audit tail en ese momento
- Estado del nodo en `/v1/sender-nodes`

Me lo pasás y diagnosticamos. Probablemente sea algo del panel
polling, del runtime del agente eligiendo skills, o de un env var
que se cayó.

## Después de cerrar verde

Avisame y arrancamos **D+7 — Cierre formal del Hito 5.11.B**:

- Verificar los 7 criterios del §4 del rector
- Tildar D+6 PM + D+7 en Notion master
- Pasar Status de la tarjeta a Done
- Commit final + opcional release script a main
- Snapshot final del estado de los gates norte

Después de eso quedan 4 días del MVP (27-30) para handoff demo.
