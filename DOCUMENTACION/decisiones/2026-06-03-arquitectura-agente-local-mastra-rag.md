# ADR — Arquitectura del agente local: Workflow determinístico + RAG-gated memory (Mastra à la carte)

- **Fecha:** 2026-06-03
- **Tipo:** Decisión arquitectónica de norte (agente OpenClaw + memoria + ejecución).
- **Status:** Adoptada. Pendiente de PoC (ver §8).
- **Decisión:** Juanes (CTO). Arquitectura/auditoría: Claude (AI eng). Implementación: Codex.
- **Reversibilidad:** Alta para Mastra (à la carte, Apache-2.0, escape hatch trivial); media para la consolidación de estado en Postgres.

---

## 1. Contexto

OpenClaw (Claude Sonnet 4.6 vía Amazon Bedrock) es el agente operacional que provisiona infraestructura SMTP de Delivrix: compra de dominios, DNS, VPS, DKIM/SPF/DMARC, warmup. Hoy corre como contenedor hospedado en Hostinger (`ghcr.io/hostinger/hvps-openclaw`) hablando con el gateway TypeScript propio de Delivrix; **más adelante se migrará a correr local en una Mac Mini**.

Dos problemas reales, confirmados por auditoría de código + literatura:

1. **El agente "delira" (divaga/alucina).** Causa raíz: el loop de ejecución es **LLM-driven** — el modelo decide el plan entero y diverge. Lo amplifica el "context rot" (a más tokens, peor recall).
2. **Consulta mal su memoria.** Causa raíz: recuperación por exact-match / similitud sin **evaluador de confianza**, y reinyección de texto libre (superficie de poisoning, OWASP ASI06 — hay un paper, *"Taming OpenClaw"* arXiv 2603.11619, sobre este mismo agente).

Auditoría previa del subsistema de memoria (`AUDITORIA_MEMORIA_OPENCLAW_2026-06-03.md`) confirmó: lo único vivo es una tabla episódica (`openclaw_episodic_scratch`) con recall exact-match y scoring lineal mal calibrado; pgvector está **muerto** (sin embedder); hueco de auth fail-open en `/scratch`; TTL que borra todo incluida memoria humana; sin write-gate, sin provenance≠fiabilidad, sin bi-temporalidad.

**AgentCore descartado** por infraestructura: es cloud-AWS, no se autohospeda en Mac Mini; y su Memory gestionada no da hash-chain/provenance/exactly-once → sería un downgrade de gobierno.

## 2. Decisión (una línea)

**Workflow determinístico gobernado + memoria de dos planos con RAG-gated, corriendo local en TypeScript sobre Postgres+pgvector, con Claude por Bedrock.** Mastra se adopta **à la carte** (Workflows + RAG), nunca como runtime/loop/memoria-fuente-de-verdad. El gobierno (firma humana, audit chain, exactly-once) se queda en nuestra capa.

Principio rector: **la memoria informa, nunca autoriza; la autorización es política estática determinística.**

## 3. Arquitectura (7 componentes)

**C1 — Control de flujo = Workflow determinístico, no loop libre.** El flujo SMTP (dominio→DNS→VPS→DKIM/SPF/DMARC→warmup) se modela como pasos fijos en código (`@mastra/core/workflows` à la carte, o patrón replicado). El LLM solo rellena cada paso acotado; no inventa el plan. `suspend()` en el paso de aprobación = ApprovalGate; snapshots durables para reanudar tras crash. *Por qué:* ataca la causa raíz del delirio. El `orchestrator-smtp.ts` (14 steps) ya es el embrión.

**C2 — Grounding agéntico: verificar estado real antes de cada acción.** Tras cada paso, el agente confirma con read-tools el estado real (DNS propagado, VPS arriba, DKIM válido) antes de avanzar (ReAct/ReflAct). Salidas estructuradas (Zod) + validación de contenido propia. Step budget duro + detección de acción duplicada (misma tool+args 3× → abortar y escalar). *Por qué:* enforce del principio "no adivinar, consultar el API real"; frena loops.

**C3 — Memoria de dos planos con retrieval gated.** Sobre Postgres+pgvector:
- **Hechos verificados** (confirmados por tool determinística u operador) → único plano que alimenta decisiones.
- **Observaciones** (crudo del agente/tools) → no confiable, cuarentenada, estructurada, nunca reinyectada como texto libre.
- **Retrieval estilo CRAG:** query-rewrite → híbrido (semántico+keyword/RRF) → rerank → **umbral de confianza** (Correcto inyecta / Incorrecto descarta / Ambiguo busca-más o se abstiene).
- **Write-gate** antes de commitear (rechaza prosa libre, valida contra hechos verificados, registra provenance). El agente **no sube su propio reliability**.
- **Bi-temporalidad** (`valid_at`/`invalid_at`): un bounce real invalida un hecho, no lo borra. TTL excluye `operator`.
*Por qué:* arregla "consulta mal la memoria" y cierra el borde de escritura (ASI06).

**C4 — Gobierno intacto, en nuestra capa.** ApprovalGate (1 firma vía `suspend()`), audit chain SHA-256 (append dentro de la misma transacción), exactly-once (Postgres `UNIQUE(proposal_id)` + CAS + outbox drain), kill-switch fail-closed, HMAC, approval-token nonces. *Por qué:* Mastra no da hash-chain ni exactly-once; no se cede.

**C5 — Sub-agentes acotados (supervisor + especialistas).** Supervisor orquesta el workflow; especialistas (domain/dns/smtp/warmup) corren con **ventana limpia** y devuelven solo un resumen destilado (~1-2k tokens). Hechos verificados centralizados en el supervisor; memoria de trabajo por sub-agente aislada (namespace agent_id+session). Los especialistas **solo proponen**; nada irreversible sin firma. *Por qué:* ventana limpia es la técnica de Anthropic contra context-rot; acotar evita que el enjambre delire.

**C6 — Inferencia: Claude por Bedrock (fallback Anthropic/Ollama).** Corre local en Mac Mini, pero la inferencia sigue siendo Claude Sonnet por calidad; Ollama local solo como red de respaldo de conectividad, nunca primario. *Por qué:* un modelo local en Mac Mini no iguala a Sonnet para razonar, y el razonamiento es lo que evita el delirio.

**C7 — Evals de grounding como sistema.** Golden set de 20-50 tareas SMTP reales + graders code-based (outcome verification: ¿el registro DNS existe de verdad?, tool-calls verification) + LLM-judge calibrado + RAGAS (faithfulness, context precision/recall). Métrica de fiabilidad: **pass^k** (pasar las k veces, no "1 de 10"). Capability + regression en CI. *Por qué:* sin medir faithfulness/outcome, "no alucina" es fe.

## 4. Stack (por capa)

| Capa | Tecnología | Nota Hostinger↔Mac Mini |
|---|---|---|
| Runtime | **Node.js 22 LTS** + TypeScript | ARM64-nativo en Mac Mini |
| Borde | Gateway HTTP propio | Mastra entra como librería, no toma el servidor |
| Framework | **`@mastra/core/workflows`** + **`@mastra/rag`** + **`@mastra/pg`** + **`@mastra/evals`** (à la carte, versión pinneada) | Apache-2.0, escape hatch trivial |
| LLM | **Claude Sonnet vía Bedrock** (`@ai-sdk/amazon-bedrock`); fallback Anthropic API (`@ai-sdk/anthropic`); respaldo local Ollama (Metal) | API de red → idéntico en ambos hosts |
| Embeddings | **Bedrock Cohere Embed Multilingual v3** (ES/EN); opción local **`bge-m3`** en Mac Mini | Pluggable por AI SDK |
| Datos | **PostgreSQL 16 + pgvector (HNSW)** — sustrato único (proposals, audit, memoria 2-planos, vector store) | Docker o Postgres.app+pgvector |
| Cache/cola | Redis (opcional) | Docker |
| Reranker | **Cohere Rerank v3** (API); opción local `bge-reranker` | — |
| Gate confianza | CRAG-style propio (lógica chica) | — |
| Gobierno | ApprovalGate + audit-chain SHA-256 + exactly-once + HMAC + kill-switch (propios) | — |
| Observabilidad | `@mastra/observability` (OTEL) opcional; o logs del gateway + audit chain + Canvas Live | — |
| Empaque | **Docker / docker-compose** | Migrar = mover contenedores + túnel, cero reescritura |
| Acceso Mac Mini | **Tailscale/WireGuard** (NAT), siempre-encendida, backups, UPS | — |
| Process mgr | pm2 o `launchd` + scripts start/stop graceful (SIGTERM + verificación PID) | — |

**Resumen:** Node 22 + TS · Mastra (Workflows + RAG) à la carte · Claude Sonnet por Bedrock · Postgres 16 + pgvector HNSW como sustrato único · gobierno propio · Docker para portar.

## 5. Matriz de invariantes (un test por defensa)

| # | Invariante | Test |
|---|---|---|
| I1 | Doble firma concurrente del mismo `proposalId` → exactamente 1 dispatch | Test de concurrencia (`Promise.all` 2× `/sign`) |
| I2 | Crash entre `signed` y `executed` → no re-ejecuta tras restart | Matar proceso, reiniciar, verificar |
| I3 | `GET /v1/openclaw/scratch` sin token → 401 (fail-closed) | curl sin token |
| I4 | TTL no borra `source=operator`/hechos verificados | Insertar+expirar, verificar persistencia |
| I5 | Write-gate rechaza prosa libre / instrucción inyectada (ASI06) | Intentar escribir observación con payload |
| I6 | El agente no puede subir su propio `reliability` | Intento de auto-promoción → rechazado |
| I7 | Bounce real invalida un hecho (`invalid_at`) sin borrarlo | Simular bounce, verificar `invalid_at` + fila presente |
| I8 | Retrieval descarta memorias bajo umbral de confianza (CRAG) | Inyectar memoria irrelevante, verificar que no entra al prompt |
| I9 | Acción irreversible (Tier C) sin firma → bloqueada | Intento de compra sin firma → 423/rechazo |
| I10 | Step budget / acción duplicada 3× → aborta y escala | Forzar loop, verificar corte |

## 6. Gobierno que NO se cede

Toda acción irreversible/real (compra dominio, VPS, SSH real, cambio DNS real, envío) sigue exigiendo **1 firma humana + audit chain SHA-256 + broadcast + rollback preparado**. Es el norte (`NORTE_OPERATIVO_DELIVRIX.md`) y esta arquitectura lo respeta al pie de la letra; solo lo vuelve exactly-once, durable y a prueba de carreras.

## 7. Diferido (futuro, con trigger)

- Write-gate completo + reliability ganada por evidencia externa → cuando el flujo base esté grounded.
- Embeddings + HNSW productivo → cuando el volumen lo pida (hoy exact-match alcanza).
- Multi-agente supervisor completo → cuando el workflow de un dominio sea sólido.
- Consolidar file-stores (kill-switch, rate-limit) a Postgres → cuando haya multi-proceso.
- Modelo local primario → solo si la calidad alcanza (hoy no).

## 8. Plan de PoC (primer experimento medible)

No reescribir: **evolucionar `orchestrator-smtp.ts`** (ya tiene 14 steps gated).

1. Convertir el flujo de provisión SMTP de un dominio a **workflow determinístico con verify-after-step** (C1+C2). *Gate:* el flujo no diverge; cada paso verifica estado real.
2. Cablear la consulta de memoria por el **gate de confianza CRAG sobre hechos verificados** (C3 lectura). *Gate:* no inyecta memorias bajo umbral.
3. Medir con **golden set ~20 tareas + outcome verification** (C7). *Gate:* baja la divagación; `pass^k` sube vs baseline.

Todo local, Claude por Bedrock, gobierno intacto. Es el experimento que prueba con datos antes de comprometer el resto.

### 8.1 Corte B1 memoria grounded — 2026-06-03

Este corte implementa solo B1 local y testeable: retrieval de decision sobre `openclaw_episodic_scratch` sin embeddings, recuperando unicamente `plane='verified_fact' AND invalid_at IS NULL`, con relevancia por keywords/query, recencia, reliability como multiplicador acotado, salida tipada y abstencion cuando no hay memoria verificada relevante. Las observaciones quedan fuera de la ruta que alimenta decisiones.

Parte 4 queda diferida: Bedrock Cohere Embed Multilingual v3, pgvector/HNSW, busqueda hibrida vector+keyword/RRF y rerank. Ese corte requiere infra/Bedrock y no se mezcla con B1 para mantener la prueba local sin dependencia externa.

## 9. Riesgos remanentes

- Mastra v1 mueve API rápido → pinnear versión, aislar tras adaptadores propios.
- Embeddings/rerank por API (Cohere) = dependencia de red → fallback local en Mac Mini.
- Operador único comprometido (riesgo ya admitido en el cambio de norte) → MFA panel + anchor externo del audit chain (pendientes, alta prioridad).
- La alucinación se acota, no se elimina → por eso lo irreversible mantiene firma humana.

## 10. Referencias

- `NORTE_OPERATIVO_DELIVRIX.md`, `decisiones/2026-05-29-cambio-norte-1-firma-audit-chain.md`, `AUDITORIA_MEMORIA_OPENCLAW_2026-06-03.md`.
- Mastra: Workflows / RAG / Memory / Storage / Providers (mastra.ai/docs).
- Grounding: Anthropic "Effective context engineering" + "Demystifying evals"; CRAG (arXiv 2401.15884); ReAct (2210.03629); ReflAct (2505.15182); RAGAS; VeriCite (2510.11394).
- Memoria/seguridad: OWASP Top 10 Agentic / ASI06; "Taming OpenClaw" (2603.11619); Zep/Graphiti (2501.13956); CaMeL (2503.18813).

— Claude (AI eng) · 2026-06-03
