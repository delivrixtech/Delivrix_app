# Sprint Demo Viernes — Status

**Demo:** viernes 29-may 2026, 11:00 am hora Colombia.
**Living doc:** se actualiza tras cada reporte de Codex o decisión CTO.
**Última actualización:** 2026-05-27, 17:30 COT.

---

## North del sprint

OpenClaw ejecuta autónomamente la cadena completa **adquirir dominio → configurar DNS → comprar VPS Webdock → instalar SMTP → SPF/DKIM/DMARC validados → warmup gradual sin afectar reputación**, todo visible en Canvas Live + Workspace Browser + Sender Pool.

Pivote de scope acordado HOY: foco demo viernes en **"OpenClaw crea SMTP desde 0"** (T1-T6). Warmup (T7) y envío real quedan post-demo — Sau cierra la otra semana.

---

## Estado actual por trazo (2026-05-27, 17:30 COT)

### Trazo 1 — Flow E2E real (main)

**Estado:** smokes blockeados confirmados, comportamiento esperado. Pendiente fixes pequeños + activar flags writes.

- Gateway corriendo PID 45809 con env nueva (admin contact + Webdock OPS key + AWS IAM ampliado + monthly cap $50).
- Smokes ejecutados sin writes reales (flags `ENABLE_WRITES` apagados por seguridad). Errores esperados: `dns_write_flag_disabled`, `webdock_create_flag_disabled`, `smtp_ssh_flag_disabled` + `approval_not_found_or_expired`.
- **Bugs encontrados por Codex en el smoke:**
  - **B1.** Hostname `mail-delivrix-smoke-1` no pasa validación FQDN. Hay que pasar nombre completo (`mail-delivrix-smoke-1.delivrix.local`).
  - **B2.** No existe `DELETE /v1/webdock/servers/{slug}` para cleanup post-test. Si dejamos VPS reales prendidos, gastan plata mensualmente.
- **Próximo paso Codex:** fix B1 + B2 antes de activar flags writes.

### Trazo 2 — Threat Model formal

**Estado:** ENTREGADO ✅

- `DOCUMENTACION/THREAT_MODEL_DELIVRIX_2026_05_27.md` (Claude).
- 8 superficies de ataque mapeadas.
- 23 gaps numerados (G1-G23) priorizados en 4 tiers.
- Roadmap hardening por sprint.
- 8 ejercicios threat-hunting recomendados.
- Compliance footprint (GDPR/CAN-SPAM/CASL).

### Trazo 3 — Containerización OrbStack

**Estado:** primer corte listo en rama aparte. Pendiente prueba local.

- Branch + worktree: `feat/containerize-orbstack` en `.worktrees/feat-containerize-orbstack`.
- Dockerfiles: gateway-api + admin-panel + openclaw-runtime.
- `infra/docker-compose.dev.yml` ampliado (Postgres + Redis + gateway + panel + runtime).
- Checks Codex: `node --check`, `docker compose config`, `git diff --check` todos OK.
- Smoke con listener local bloqueado por sandbox EPERM (no es bug, es restricción entorno Codex).
- **Validación pendiente:** Juanes prueba localmente con OrbStack desde Mac.

### Trazo 4 — Postgres + pgvector + mem0 (memoria semántica multi-agente)

**Estado:** primer corte listo en rama aparte. Tests verdes.

- Branch + worktree: `feat/postgres-vector-memory` en `.worktrees/feat-postgres-vector-memory`.
- Adapter `apps/gateway-api/src/openclaw-memory-store.ts`.
- Migración pgvector (schema canónico de `ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md`).
- Doble escritura opt-in con `STORAGE_BACKEND=postgres-vector` (default `files`, sin breaking change).
- Wrapper mem0 Python integrado en runtime OpenClaw.
- Scripts migración ida + vuelta (filesystem ↔ Postgres).
- Tests: **7 focused tests passing + 341 npm test completo passing** (subió de 337 a 341).

### Trazo 5 — RBAC (POSTPONED post-demo)

**Estado:** decisión CTO Juanes 2026-05-27 tarde — fuera del sprint actual.

- Demo viernes usa shim de 2 actorIds (CTO + 2do aprobador a definir).
- RBAC completo (users, roles, sessions, login, perfil, audit, 2FA) entra en sprint S1 post-demo.
- Tiempo estimado: ~25-30h Codex.
- Spec arquitectural se escribe cuando arranque el sprint S1.
- Capturado como task tracking #146.

---

## Bloqueantes externos pendientes para que el flow real corra

Todos requieren acción CTO. Sin presión hasta jueves:

| # | Bloqueante | Detalle | Estado |
|---|------------|---------|--------|
| 1 | **2do aprobador** | Humano del equipo Delivrix con actorId distinto a Juanes para regla 2-personas | Pendiente decisión CTO |
| 2 | **Flags writes** | `AWS_ROUTE53_DNS_ENABLE_WRITES=true`, `WEBDOCK_SERVERS_ENABLE_CREATE=true`, `SMTP_PROVISIONING_ENABLE_SSH=true` en `.env.local` | Apagados por seguridad. Activar para test real T2-T6 |
| 3 | **SSH key para T5** | Para que Codex pueda hacer SSH install_smtp_stack en VPS aprovisionado | Pendiente generación |
| 4 | **Dominio para test T2-T6** | Identificar dominio que YA tengamos (IONOS o Route53) para probar el flow sin gastar en compra | Pendiente decisión CTO |
| 5 | **Flag purchase** | `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` | Activar SOLO el viernes 10:30am con `flip-purchase-flag.sh on` |

---

## Bitácora de decisiones CTO (2026-05-27)

Cada entrada con formato canónico: contexto → decisión → razón → reversibilidad.

### D1. Pivote scope demo viernes

- **Contexto:** Sau aún no tiene los SMTP listos, port 25 puede o no estar abierto en Webdock, warmup requiere seed inboxes reales.
- **Decisión:** demo viernes se enfoca en "OpenClaw crea SMTP desde 0" (T1-T6). T7 warmup queda post-demo.
- **Razón:** narrativa más fuerte (agente autónomo crea infra) sin depender de soporte Webdock ni de bandejas seed reales. Plan B robusto si algo falla.
- **Reversibilidad:** alta. Si el viernes tenemos tiempo y todo funciona, podemos mostrar también el inicio de warmup como bonus.

### D2. Sprint paralelo total HOY

- **Contexto:** demo está a 48h. Falta flow E2E + threat model + containerización + storage layer Postgres.
- **Decisión:** ejecutar los 4 trazos en paralelo HOY, Codex en ramas dedicadas, Claude en docs y QA.
- **Razón:** Codex Max maneja la carga, las ramas separadas evitan contaminación, Trazo 1 prioridad absoluta para no comprometer el demo.
- **Reversibilidad:** alta. Trazos 3 y 4 viven en ramas separadas, no se mergean a main hasta validación CTO. Si rompen algo, rollback es un revert.

### D3. Memoria semántica con pgvector + mem0 + Bedrock Titan

- **Contexto:** memoria filesystem actual funciona pero no permite búsqueda semántica ni razonamiento cross-skill. Para que OpenClaw sea "ingeniero senior de Delivrix" necesita memoria inteligente.
- **Decisión:** implementar Postgres + pgvector como storage, mem0 como capa de abstracción Python, Titan Embed v2 como embedder. Schema multi-agente con visibility scopes desde el día uno.
- **Razón:** arquitectura citable que aguanta crecimiento modular. Sub-agentes futuros (otros bots) reutilizan el mismo schema sin migrations destructivas.
- **Reversibilidad:** alta hoy (feature flag `STORAGE_BACKEND=files|postgres-vector`, scripts ida/vuelta). Una vez en producción, baja (cualquier rollback requiere migration script).

### D4. RBAC postpuesto a sprint S1 post-demo

- **Contexto:** Juanes propuso sumar panel administrativo con auth/roles/login en paralelo a los 4 trazos.
- **Decisión:** RBAC NO entra HOY. Demo viernes usa shim de 2 actorIds. RBAC completo en sprint S1 post-demo con tiempo apropiado (~25-30h Codex).
- **Razón:** sumar RBAC a 4 trazos ya activos arriesga romper el demo. Hacerlo bien vale más que rápido. Los jefes pueden esperar 1-2 semanas más para ver login real; lo que NO pueden ver es un demo roto.
- **Reversibilidad:** total. Solo es postergación, no decisión técnica irreversible.

### D5. Tier de roles operativos del equipo

- **Contexto:** confusión sobre alcance de Codex. Memoria genérica decía "Codex solo backend".
- **Decisión:** roles confirmados para Delivrix — Juanes CTO; Codex backend + infra/DevOps + QA; Claude frontend + QA visual + PM asistente.
- **Razón:** asignar tareas mal cuesta tiempo. Codex tiene credenciales y skills para infra/DevOps que Claude no.
- **Reversibilidad:** total. Convención organizacional, no técnica.

---

## Cronograma restante

### Miércoles 27 (hoy, en curso)

- Codex termina los 4 trazos. Próximos reportes: 18:00, 19:00.
- Claude termina threat model ✅, status doc (este), stand-by para QA visual.
- Juanes decide 2do aprobador + activación flags si quiere test real hoy.

### Jueves 28

- **Mañana:** validar lo que cerró Codex hoy. Practice run del flow real T2-T6 con dominio existente.
- **Tarde:** bug fixing de lo que apareció. Push del frontend si todavía no está pusheado.
- **Noche:** practice run completo del demo (Acto 1 multi-agent + Acto 2 memoria + Acto 3 sender pool).

### Viernes 29 — Demo day

- **9:00:** validación final. Gateway running, frontend pusheado, env correcta.
- **10:30:** flip `ENABLE_PURCHASE=true` con `flip-purchase-flag.sh on`.
- **11:00:** demo en vivo a jefes (25 min según OPS Bloque 10).
- **11:30:** flip `ENABLE_PURCHASE=false` para volver a estado seguro.

---

## Plan B por fase (si algo falla viernes)

Heredado de OPS Bloque 10 + actualizado:

- **Falla T1 (RegisterDomain):** mostrar el flow blocked con audit event explicado. Operador explica que es seguridad funcionando.
- **Falla T2-T6:** WorkspaceBrowser tab Archivos muestra el dataset demo + learnings reales que Codex generó hoy. Acto 2 (memoria persistente) sostiene la narrativa.
- **Falla Postgres+pgvector:** demo corre con `STORAGE_BACKEND=files` default. Memoria semántica queda como "siguiente fase".
- **Falla containerización:** demo corre con gateway native en Mac. OrbStack queda como "siguiente fase".

---

## Backlog post-demo (capturado para no perderlo)

- **Sprint S1:** RBAC completo (auth + roles + login + sessions + 2FA + profile + admin CRUD). ~25-30h Codex.
- **Sprint S1:** Hardening pre-exposición — gaps G2, G5, G13, G21 del threat model (TLS, auth panel, AWS secrets manager, cifrado at-rest).
- **Sprint S2:** Operaciones seguras — gaps G1, G4, G7, G10, G15, G22 (rate limit, rotation, 2FA op, SSH no-root, backup workspace).
- **Sprint S3:** Defensa en profundidad — gaps G3, G6, G8, G9, G11, G14, G16, G17.
- **Sprint S4+:** T7 warmup completo + seed inboxes + envío real validado. Coordinar con Sau.
- **Backlog operacional:** gaps G12, G18, G19, G20, G23.

---

## Referencias activas

- `OPS_CODEX_SPRINT_PARALELO_HOY_2026_05_27.md` — Codex ejecuta de acá
- `OPS_CODEX_SPRINT_PARALELO_HOY_2026_05_27_REPORTE_1700_COT.md` — reporte horario Codex
- `ARQUITECTURA_MEMORIA_AGENTE_DELIVRIX_2026_05_27.md` — spec canónico Trazo 4
- `THREAT_MODEL_DELIVRIX_2026_05_27.md` — gaps numerados + roadmap
- `runbooks-demo-viernes/RUNBOOK_DESTRABAR_6_ITEMS.md` — proceso original 6 items (4 cerrados, 1 postponed, 1 flip viernes)
- `runbooks-demo-viernes/flip-purchase-flag.sh` — script viernes 10:30am
- `runbooks-demo-viernes/smoke-test-onboarding.sh` — script test repetible
- `push_canvas_v6.sh` — push del frontend (pendiente correr cuando main esté limpio)

---

## Ownership

- **CTO:** Juanes — decisiones, asunción de riesgo.
- **Backend + Infra + QA:** Codex — los 4 trazos, reportes horarios.
- **Frontend + QA visual + PM:** Claude — este doc, threat model, arquitectura memoria, OPS docs, stand-by frontend.

Próxima actualización: tras reporte Codex 18:00 COT, o si Juanes toma decisión nueva.
