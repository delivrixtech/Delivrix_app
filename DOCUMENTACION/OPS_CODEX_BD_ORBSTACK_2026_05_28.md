# OPS Codex — Configurar BD en OrbStack mega organizada

**Para:** Codex.
**De:** Claude (PM + Frontend, escribiendo este OPS a pedido directo de Juanes).
**Fecha:** 2026-05-28 jueves, tarde.
**Prioridad:** Alta — pedido directo del CTO ("necesito tener eso mega organizado").
**Tiempo estimado:** 2–3 h end-to-end.

---

## Contexto

Juanes pidió expresamente: configurar la base de datos en OrbStack y dejarla "mega organizada". Hoy tenemos 3 docker-compose distintos en el repo y eso es exactamente lo que **no** queremos:

| Ubicación | Imagen Postgres | Notas |
|---|---|---|
| `infra/docker-compose.yml` (main) | `postgres:16-alpine` | Sin pgvector — bloquea Trazo 4 memoria semántica |
| `.worktrees/feat-postgres-vector-memory/infra/docker-compose.yml` | `pgvector/pgvector:pg16` | Pgvector activo, sin gateway containerizado |
| `.worktrees/feat-containerize-orbstack/infra/docker-compose.dev.yml` | `postgres:16-alpine` | Full stack containerizado (gateway-api incluido) |

Estos tres archivos contienen 3 verdades distintas y van a divergir más a medida que cualquiera de las dos worktrees toque el compose. **Hay que consolidar uno solo** que sirva para dev en OrbStack y para Trazo 4 (memoria semántica con pgvector + mem0).

OrbStack es Docker Desktop drop-in para Mac, pero más rápido y con soporte nativo de macOS. No requiere docker-compose patches — `docker compose up` funciona idéntico. Lo que cambia es la integración: OrbStack te da:

- Hostnames automáticos por contenedor (ej. `delivrix-postgres.orb.local`).
- Acceso al filesystem del contenedor desde Finder.
- Volúmenes con bind mounts que no sufren el penalti de filesystem de Docker Desktop.

---

## Objetivo final

Un solo comando que un dev nuevo (o yo en otra máquina) pueda correr y tenga **toda la BD lista**:

```bash
cd infra
docker compose up -d
npm run db:migrate
npm run db:seed
```

Resultado: Postgres 16 + pgvector + Redis 7 + (opcional) gateway containerizado, todos corriendo en OrbStack, con schema migrado, seed data cargado, conexión verificada desde el gateway local.

---

## Tareas

### Tarea 1 — Consolidar a UN solo docker-compose canónico (30 min)

**Acción:**

1. Mergear `feat-postgres-vector-memory` → `main` (la imagen `pgvector/pgvector:pg16` es necesaria para Trazo 4 y backward compat con Postgres 16 normal).
2. Eliminar las copias de `infra/docker-compose.yml` de las otras worktrees o convertirlas en symlinks/imports si la worktree necesita override (ej. la de orbstack agrega gateway-api containerizado).
3. Estructura final esperada:

```
infra/
├── docker-compose.yml          # base — postgres + redis (canónico, único)
├── docker-compose.dev.yml      # override — agrega gateway-api containerizado
├── postgres/
│   ├── migrations/             # *.sql ejecutados por entrypoint
│   │   ├── 001_init.sql
│   │   ├── 002_pgvector.sql    # CREATE EXTENSION pgvector
│   │   ├── 003_audit_log.sql
│   │   └── ...
│   └── seed/
│       └── seed-dev.sql        # datos demo para arrancar
└── README.md                   # cómo levantarlo + commandos comunes
```

Comando para levantar solo BD + Redis (lo más común en dev):

```bash
docker compose -f infra/docker-compose.yml up -d
```

Comando para levantar TODO containerizado (cuando Juanes quiera testear el flow E2E sin tocar su Node local):

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d
```

### Tarea 2 — Schema + migraciones reproducibles (45 min)

**Acción:**

1. Revisar qué schemas/tablas necesita Delivrix HOY:
   - `audit_events` (append-only, ya existe en `.audit/audit-events.jsonl` — migrar a Postgres).
   - `canvas_live_snapshots` (estados del Canvas para resume tras restart).
   - `openclaw_memory_vectors` (pgvector — embeddings para mem0, Trazo 4).
   - `iam_sessions`.
   - `kill_switch_events`.
   - (otros que el código del gateway ya espera — buscar con `grep -r "INSERT INTO\|SELECT.*FROM" apps/gateway-api/src/`).
2. Generar migraciones SQL versionadas en `infra/postgres/migrations/` con prefijo numérico:

```sql
-- 001_init.sql
CREATE SCHEMA IF NOT EXISTS delivrix;
SET search_path TO delivrix, public;

-- 002_pgvector.sql
CREATE EXTENSION IF NOT EXISTS vector;

-- 003_audit_log.sql
CREATE TABLE audit_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL,
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  resource     TEXT,
  detail       JSONB,
  signature    TEXT NOT NULL,
  prev_hash    TEXT,
  hash         TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at DESC);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_id, occurred_at DESC);
```

3. Script `npm run db:migrate` que corra las migraciones en orden si no fueron aplicadas. Sugerencia: usar un tracking table simple:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

El script lee `infra/postgres/migrations/*.sql`, filtra los que no están en `schema_migrations`, los corre en orden alfabético, inserta el filename.

**No usar Prisma ni TypeORM** — son overkill para nuestro shape actual. Un script Node + `pg` library de ~80 líneas hace el trabajo y queda inspeccionable.

### Tarea 3 — Seed data dev reproducible (30 min)

**Acción:**

1. `infra/postgres/seed/seed-dev.sql` con datos suficientes para arrancar el panel sin que se vea vacío:
   - 1 servidor físico onboardeado (Popayán).
   - 3 clústeres (manual-sender, proxmox-sender, webdock-sender).
   - 11 nodos.
   - 1 wallet operativo con cap $50 + transaction inicial $3.
   - 5 audit events de ejemplo (firmados con chain válido).
   - Un kill switch en estado `armed`.
2. Comando `npm run db:seed` que ejecuta el `seed-dev.sql` después de migraciones.
3. Idempotente — si se corre dos veces no duplica (usar `ON CONFLICT DO NOTHING` o checks por `id`).

### Tarea 4 — Wiring de .env y conexión desde gateway (15 min)

**Acción:**

1. Verificar/agregar al `.env.local`:
   ```
   POSTGRES_URL=postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops
   REDIS_URL=redis://localhost:6379
   ```
2. En `apps/gateway-api/src/main.ts` agregar un health check al startup que haga `SELECT 1` a Postgres + `PING` a Redis. Si falla, **NO crashear el gateway** — pero loggear un warning visible que avise al dev:
   ```
   [gateway] WARN: Postgres no responde en POSTGRES_URL. ¿Levantaste `infra/docker compose up`?
   ```
3. Endpoint `/health` debe reportar también `postgres: "ok" | "down"` y `redis: "ok" | "down"` para que el panel pueda mostrarlo (yo en frontend ya tengo el chip de gateway, agrego los otros 2 si exponés el shape).

### Tarea 5 — README operativo para Juanes (10 min)

**Acción:** crear `infra/README.md` con secciones:

```markdown
# Infraestructura local Delivrix

## Levantar BD + Redis (común en dev)
docker compose -f infra/docker-compose.yml up -d

## Levantar full stack containerizado (BD + Redis + gateway)
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d

## Migraciones
npm run db:migrate

## Seed datos demo
npm run db:seed

## Resetear todo (DROP + CREATE + migrate + seed)
npm run db:reset

## Conexión psql interactiva
docker exec -it delivrix-postgres psql -U delivrix -d delivrix_mailops

## Backup snapshot del volumen
docker run --rm -v delivrix_postgres_data:/data -v $(pwd)/backups:/backup alpine \
  tar czf /backup/postgres-$(date +%Y%m%d-%H%M).tar.gz /data

## Hostnames OrbStack
- BD:        delivrix-postgres.orb.local:5432
- Redis:     delivrix-redis.orb.local:6379
- Gateway:   delivrix-dev-gateway-api.orb.local:3000 (si lo levantás containerizado)
```

### Tarea 6 — Verificación E2E (15 min)

**Acción:**

```bash
# 1. Limpiar todo
docker compose -f infra/docker-compose.yml down -v

# 2. Levantar
docker compose -f infra/docker-compose.yml up -d

# 3. Esperar healthchecks
docker compose ps  # ambos deben estar (healthy)

# 4. Migrar
npm run db:migrate

# 5. Seed
npm run db:seed

# 6. Verificar tablas
docker exec delivrix-postgres psql -U delivrix -d delivrix_mailops -c "\dt"
docker exec delivrix-postgres psql -U delivrix -d delivrix_mailops -c "\dx"  # debe listar `vector`

# 7. Restart gateway local
pkill -f "node.*gateway-api" || true
npm run dev:gateway

# 8. Curl
curl http://localhost:3000/health
# Esperado: { "status": "ok", "postgres": "ok", "redis": "ok", ... }
```

---

## Plus mencionable al cierre

- **Si OrbStack no está instalado** en la máquina del dev: el compose funciona idéntico con Docker Desktop. OrbStack solo agrega los hostnames `*.orb.local` y la velocidad. Ningún breaking change.
- **Backup**: el volumen `delivrix_postgres_data` persiste entre `compose down/up`. Solo se borra con `compose down -v`. Para snapshots manuales usar el comando del README.
- **pgvector confirmado funcionando** debe ser parte del PR. Test smoke:
  ```sql
  CREATE TABLE _test_vec (id int, v vector(3));
  INSERT INTO _test_vec VALUES (1, '[1,2,3]');
  SELECT * FROM _test_vec WHERE v <-> '[1,2,2]' < 1;
  DROP TABLE _test_vec;
  ```

---

## Lo que NO toques

- No tocar `apps/admin-panel/` (frontend).
- No tocar credenciales Webdock / AWS / OpenAI / Bedrock en `.env.local` — solo agregar `POSTGRES_URL` y `REDIS_URL` si no están.
- No mergear las worktrees `feat-postgres-vector-memory` ni `feat-containerize-orbstack` enteras — solo extraer el compose canónico. Las features dentro de esas branches están en backlog separado.

---

## Verificación esperada al cerrar el OPS

```
✓ Un solo compose canónico (infra/docker-compose.yml + override .dev.yml).
✓ `docker compose up -d` levanta postgres (pgvector) + redis healthy.
✓ `npm run db:migrate` aplica migraciones de forma idempotente.
✓ `npm run db:seed` carga data demo.
✓ Gateway local conecta a Postgres + Redis al iniciar.
✓ /health reporta status de los 2 nuevos componentes.
✓ infra/README.md documenta los 7 comandos comunes.
✓ Smoke pgvector con CREATE EXTENSION + query distance.
✓ Notion entry actualizada con "BD organizada en OrbStack" (Sprint S1).
```

Cuando cierres, pingueame para yo agregar al panel `/health` los chips de `postgres` y `redis` (15 min de mi lado).

Gracias.
