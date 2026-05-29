# OPS Codex — Sprint paralelo total HOY (4 trazos)

**Para:** Codex.
**De:** Juanes (CTO) + Claude (PM).
**Fecha:** 2026-05-27 tarde.
**Decisión CTO:** los 4 trazos en paralelo HOY, demo viernes 11am funcional con todo blindado.
**Asunción de riesgo:** firmada por Juanes. Si algo rompe el flow E2E que ya funciona, rollback inmediato del trazo causante.

---

## Reglas no negociables (guardrails)

1. **Cada trazo en su rama dedicada.** Cero cross-contamination entre los 4.
2. **Trazo 1 (flow E2E) tiene prioridad absoluta.** Si Trazo 3 o 4 quiere mergear algo a `main`, primero corré el smoke completo del flow E2E. Si pasa → merge. Si falla → revert y reportá.
3. **Tests existentes deben seguir pasando** (337 npm test al cierre Bloque 10). Cualquier cambio que rompa tests verdes se devuelve a su rama.
4. **Feature flags donde aplique** para que el rollback sea 1 línea de .env, no un revert.
5. **Reportá fin de cada trazo individualmente**, no esperes a tener los 4 listos.

---

## TRAZO 1 — Flow E2E real (T4 del OPS anterior)

**Rama:** `main` (en este trazo sí se puede tocar main porque es el que va al demo).

**Tareas (las mismas del OPS_CODEX_TEST_E2E_HOY_2026_05_27.md, sin cambios):**

1. **T2 hosted zone** con dominio existente — `POST /v1/domains/route53/dns/upsert`. Reportá HTTP status + zoneId.
2. **T3 email auth** — `POST /v1/domains/auth/configure`. Reportá DKIM key + 3 records DNS creados.
3. **T4 Webdock VPS** — `POST /v1/webdock/servers/create` profile bit, location `dk`, hostname FQDN `mail.<dominio-existente>`. Reportá serverSlug + IP.
4. **T5 install SMTP** — `POST /v1/servers/{slug}/provision-smtp`. Postfix + opendkim + certbot. Reportá duración + logs.
5. **T6 bind** — `POST /v1/domains/bind`. Records MX + A. Reportá records creados.
6. **Cleanup VPS al final** — `DELETE /v1/webdock/servers/{slug}`.

**Bugs encontrados → reportá lista priorizada, no intentes arreglar todo de una.**

Costo estimado: $0.20 USD (1 VPS Webdock prorrateado 1h). Usá dominio que YA tenemos en cuenta (revisá inventario IONOS o Route53).

---

## TRAZO 2 — Threat Model formal consolidado

**Quién:** Claude lo redacta en paralelo. Vos (Codex) NO tocás esto.

**Output:** `DOCUMENTACION/THREAT_MODEL_DELIVRIX_2026_05_27.md` consolidando los 13 docs de seguridad existentes (permissions matrix, kill switch, audit chain HMAC, safety realtime, C2 audit override, etc.) en un threat model formal con:

- Superficies de ataque (gateway public, panel admin, WSS streams, runtime OpenClaw, container Hostinger, AWS Route53, Webdock API, SSH bridges)
- Controles aplicados por superficie
- Gaps identificados con plazo de cierre
- Ejercicios de threat-hunting recomendados

Codex puede referenciar este doc cuando trabaje en Trazo 3 (containerización endurecida) y Trazo 4 (Postgres con cifrado at-rest).

---

## TRAZO 3 — Containerización OrbStack

**Rama:** `feat/containerize-orbstack` (NO se mergea a main hasta post-demo o hasta validación CTO).

**Tareas:**

1. **Dockerfile gateway-api** — Node 22 alpine, multi-stage build, runs `apps/gateway-api/src/main.ts` con `node --env-file=.env.local`. Healthcheck `/health`. Exposición 3000.
2. **Dockerfile admin-panel dev** — Node 22 alpine, vite dev server expose 5173, hot reload working. (Producción es otro Dockerfile, no urgente hoy.)
3. **Dockerfile openclaw-runtime** — Python 3.11 slim si aplica, o reuso del container Hostinger actual. Verificá qué imagen está corriendo en `2.24.223.240` y replicá localmente.
4. **`infra/docker-compose.dev.yml` ampliado** sobre el actual (Postgres + Redis ya están). Agregá: gateway, panel, runtime. Red interna `delivrix-net`. Secretos via `.env.local` montado read-only. Volumen `openclaw_workspace` mapeado a `/data/.openclaw/workspace/`.
5. **Smoke test desde OrbStack:** `orb start delivrix` → todo arriba en 30s → `/health` OK desde fuera del compose → smoke onboarding sigue funcionando como en native.

Si alguna pieza no cierra en 2-3h, reportala y la dejamos pendiente para mañana. NO bloquea Trazo 1.

---

## TRAZO 4 — Postgres + pgvector + mem0 + arquitectura memoria multi-agente

**Rama:** `feat/postgres-vector-memory` (NO se mergea hasta validación CTO + Trazo 1 verde).

**Decisión CTO Juanes (2026-05-27 tarde):** la BD debe ser inteligente desde fundamentos. OpenClaw como ingeniero senior de Delivrix necesita memoria semántica + multi-agente desde el día uno. No es invento de hoy — es arquitectura citable que aguanta crecimiento modular.

**Spec canónico:** `DOCUMENTACION/ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md` (Claude lo entregó hoy). **Leelo antes de tocar código.** Define las 5 capas de memoria (episódica, procedural, reflexiva, inventario, conversación), el modelo multi-agente con visibility scopes, el schema Postgres + pgvector canónico, la integración mem0, y el plan de migración.

### Guardrails extremos para no romper demo

1. **Feature flag obligatorio:** `STORAGE_BACKEND=files|postgres-vector` en `.env.local`. Default `files`. Postgres-vector solo activa cuando se setea explícitamente.
2. **Doble escritura durante validación:** cada nueva memoria se escribe en filesystem (legacy, evidence layer) Y en Postgres (nueva). Si Postgres falla, filesystem es source of truth.
3. **Cero cambio de shape en los 8 JSON files actuales.** Siguen funcionando como hoy con flag default.
4. **NO migrar `gateway.sqlite`** (approval tokens HMAC + rollback snapshots). Eso se queda en SQLite por latencia y estado crítico de auth.
5. **Migración bidireccional:** scripts `migrate-workspace-to-postgres.ts` Y `migrate-postgres-to-workspace.ts` para rollback en 5 minutos si algo falla.
6. **Tests existentes (337) corren en ambos modos.** Tests parametrizados con cada backend.

### Tareas en orden

1. **Postgres setup con pgvector:**
   - Cambiar `infra/docker-compose.yml` image a `pgvector/pgvector:pg16`.
   - Migration inicial con: `CREATE EXTENSION vector;`, `CREATE EXTENSION pgcrypto;`, tipos custom (`embedding_v1`, `memory_visibility`, `memory_authorship`).
   - Schema completo de `agent_memories`, `agent_inventory`, `agent_skills`, `agent_conversations` exactamente como aparece en `ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md` §4.
   - Indexes: ivfflat para embedding, GIN para metadata, B-tree para filtros frecuentes.
   - Trigger `compute_memory_audit_hash` (§4.4 del spec) para cadena SHA-256.
   - Columna generada `content_tsv` para full-text fallback (§5.3 del spec).

2. **Embedder Bedrock Titan v2:**
   - Adapter en `packages/adapters/src/bedrock-embeddings-adapter.ts` que llame `amazon.titan-embed-text-v2:0` región `us-east-1`.
   - Reutilizar credentials Bedrock que OpenClaw ya tiene configuradas.
   - Async embedding worker: lee filas con `embedding IS NULL`, popula en batch de 50, escribe audit event `oc.memory.embedding_generated`.

3. **Storage adapter interface:**
   - Interface `StorageAdapter` en `packages/adapters/src/storage-adapter.ts` con métodos `addMemory`, `searchMemories`, `getInventory`, `updateInventory`, etc.
   - Implementaciones: `FilesStorageAdapter` (lee/escribe JSON+markdown actual) y `PostgresVectorStorageAdapter` (lee/escribe Postgres).
   - Inyección via DI en gateway handlers (NO cambiar logic, solo storage layer).

4. **mem0 integration en runtime OpenClaw (Python):**
   - Verificá la versión actual de Python en el container Hostinger (`docker exec openclaw-dtsf-openclaw-1 python --version`).
   - Instalar `mem0ai` en el container: `pip install mem0ai`.
   - Wrapper `DelivrixMemory` exactamente como aparece en `ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md` §6.3 con el visibility filter multi-agente.
   - Integrar en el loop del agente: antes de cada skill, hacer `m.search()` para inyectar contexto relevante en el prompt.

5. **Migration scripts bidireccionales:**
   - `scripts/migrate-workspace-to-postgres.ts` — recorre `runtime/openclaw-workspace/` y crea entries en `agent_memories` con `source_path` apuntando al archivo MD original.
   - `scripts/migrate-postgres-to-workspace.ts` — extrae de Postgres y reescribe los 4 folders. Para rollback de emergencia.

6. **Tests parametrizados:**
   - Mismo test suite corre 2 veces: una con `STORAGE_BACKEND=files`, otra con `STORAGE_BACKEND=postgres-vector`.
   - Esperás 337 tests verdes en ambos modos.

7. **Smoke flow E2E con Postgres activo:**
   - Setear `STORAGE_BACKEND=postgres-vector` en `.env.local` de test.
   - Correr `bash DOCUMENTACION/runbooks-demo-viernes/smoke-test-onboarding.sh`.
   - Esperás mismos 2 blockers esperados (`purchase_flag_disabled` + `approval_not_found_or_expired`).
   - Verificás que los memories se escribieron en `agent_memories` Y en filesystem (doble escritura).

### Si algo no cierra hoy

NO lo metas en main. La rama queda lista para validación CTO mañana jueves o post-demo. **El demo viernes corre con `STORAGE_BACKEND=files` (default actual) si algo del Trazo 4 no quedó estable.** Cero presión sobre Trazo 1.

### Capacidades nuevas que esto habilita (mostrar el viernes si está estable)

Cuando esté funcionando, OpenClaw puede:

- **Buscar semánticamente:** "¿he visto un caso parecido a este antes?" → top 5 memorias por similaridad coseno.
- **Cross-skill reasoning:** un learning de `install_smtp_stack` aparece cuando trabaja en `configure_email_auth` si el contenido es relevante.
- **Análisis de fallos propios:** detecta skills con `failures > successes` y genera plan de mejora.
- **Consolidación de patrones:** worker que agrupa N learnings similares en uno consolidado (memoria long-term).
- **Multi-agente coordinado:** sub-agentes del supervisor leen learnings de hermanos vía `visibility='shared:family'` automáticamente.

---

## Decisión CTO firmada

Juanes asume el riesgo de los 4 trazos en paralelo. Si Trazo 3 o 4 amenaza al demo:

- Rollback inmediato del trazo causante.
- Volvemos a estado anterior (commit conocido del Trazo 1).
- Reportás formalmente qué pasó.

Demo viernes 11am no se mueve.

---

## Reporte esperado por trazo

Cada trazo cuando termine, formato:

```
## Trazo N — <nombre>

Estado: [completed | partial | blocked]
Branch: <branch>
Commits: <hash1, hash2, ...>

Lo que funciona:
- ...

Lo que NO funciona (bugs):
- ...

Cambio de scope vs OPS:
- ...

Siguiente paso recomendado:
- ...
```

---

## Coordinación

- **Cada hora**, ping rápido en chat con vos a Juanes diciendo "Trazo X: <status>". Sin acumular sorpresas para reportar al final del día.
- **Si dos trazos chocan** (ej. Trazo 4 modifica el mismo archivo que Trazo 1), priorizá Trazo 1 y abrí discusión en chat.
- **Final del día (~6pm hora Colombia):** consolidación. Si todo verde, mañana jueves arrancamos test de demo en práctica. Si algo rojo, decidimos rollback o seguir.

Gracias. Acuso recibo si tenés objeción al alcance — vos sos quien implementa.
