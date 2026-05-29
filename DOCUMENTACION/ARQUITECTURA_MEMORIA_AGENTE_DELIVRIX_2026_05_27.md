# Arquitectura de memoria del agente — Delivrix

**Versión:** 1.0
**Autor:** Claude (PM asistente) bajo decisión CTO Juanes.
**Fecha:** 2026-05-27.
**Estado:** tesis de fundamentos del sistema de memoria de OpenClaw y futuros agentes Delivrix.
**Alcance:** define cómo OpenClaw aprende, recuerda, razona y proyecta — y cómo nuevos agentes se suman a la plataforma sin romper cimientos.

---

## 1. Principios rectores

Estos no son ideales — son **restricciones de diseño**. Cualquier cambio que viole uno requiere actualizar este documento primero.

1. **Memoria viva.** La BD almacena algoritmos, decisiones y reflexiones de forma legible por máquinas y por humanos. El agente puede leerla, interpretarla, analizarla, corregirla y proyectarse desde ella. No es un dump pasivo.
2. **Multi-agente desde el día uno.** El schema soporta N agentes con scope aislado pero pool compartido cuando aplica. No vamos a refactorizar mañana para meter sub-agentes.
3. **Crecimiento modular.** Capas nuevas (knowledge graph, long-term consolidation, semantic routing) se agregan como tablas o extensions, sin migrar el core.
4. **Auditable + reversible.** Cada memoria tiene origen, autor (agent o human), timestamp, y cadena de modificaciones. Sin ediciones destructivas.
5. **OpenClaw como ingeniero senior.** El agente puede SQL-query su propia memoria, mejorar prompts basado en learnings, sugerir skills nuevas, y proyectar próximos pasos.

---

## 2. Capas de memoria

Cinco capas, todas persistidas en Postgres + pgvector, con función específica.

### 2.1 Memoria episódica

**Qué guarda:** cada ejecución concreta de una skill. Inputs, outputs, evidencia, duración, audit hash.

**Tabla:** `agent_executions`

**Búsqueda:** por agent_id + skill + dominio + fecha. También semántica: "ejecuciones parecidas a esta query".

**Uso típico:** el agente antes de invocar `install_smtp_stack` busca ejecuciones previas de la misma skill para el mismo dominio o uno similar.

### 2.2 Memoria procedural

**Qué guarda:** definiciones de skills reusables. Pre-conditions, args, outputs esperados, post-conditions, errores típicos.

**Tabla:** `agent_skills`

**Búsqueda:** por nombre, por versión, por categoría. Semántica: "skills relacionadas con DNS write".

**Uso típico:** el agente decide qué skill invocar a partir de la intención del operador. La búsqueda semántica le permite descubrir skills aunque la query no use el nombre exacto.

### 2.3 Memoria reflexiva (learnings)

**Qué guarda:** lecciones aprendidas después de un fallo o de un éxito notable. Root cause, fix sugerido, contexto, generalidad.

**Tabla:** `agent_learnings`

**Búsqueda:** semántica casi exclusivamente. "Lecciones aplicables a este problema actual".

**Uso típico:** antes de cada acción crítica, el agente busca learnings relevantes y los inyecta en el prompt como contexto. Esto es el mecanismo principal de "no repetir errores que ya documentó".

### 2.4 Memoria de inventario

**Qué guarda:** estado del mundo según el agente. Qué dominios existen, qué servers están vivos, qué warmup status tiene cada uno.

**Tabla:** `agent_inventory`

**Búsqueda:** SQL relacional clásico, no necesita semántica.

**Uso típico:** el agente consulta inventario antes de proponer acciones para evitar duplicar (ej. no proponer comprar un dominio que ya tenemos).

### 2.5 Memoria de conversación (chat)

**Qué guarda:** mensajes intercambiados entre operador y agente, con contexto temporal y session.

**Tabla:** `agent_conversations`

**Búsqueda:** por session_id, por timestamp. Semántica: "conversaciones donde el operador pidió algo parecido".

**Uso típico:** el agente recuerda lo que el operador ya pidió/aprobó en sesiones anteriores. Cross-session memory real.

---

## 3. Modelo multi-agente

### 3.1 Identidad del agente

Cada agente tiene un `agent_id` único en formato slug (`openclaw`, `openclaw-sub-domains`, `delivrix-warmup-orchestrator`, etc.). Los sub-agentes spawneados por el supervisor (T7C) heredan el prefijo del padre + un sufijo único por instancia.

### 3.2 Scope de acceso a memoria

Cada memoria tiene `agent_id` + `visibility`:

| Visibility | Quién puede leer | Quién puede escribir | Uso |
|------------|------------------|----------------------|-----|
| `private` | Solo `agent_id` | Solo `agent_id` | Sub-agente con tareas aisladas |
| `shared:family` | Agentes que comparten prefijo (`openclaw-*`) | Solo `agent_id` | Sub-agentes del mismo supervisor leen entre sí |
| `shared:global` | Todos los agentes | El agente que la escribió | Learnings que aplican a toda la plataforma |
| `human-authored` | Todos los agentes (read-only) | Solo humanos (operadores) | Skills curadas, políticas, decisiones del CTO |

Esto se enforce a nivel de query — cada select del agente filtra por su `agent_id` + visibility según matriz.

### 3.3 Coordinación entre agentes

Sub-agentes spawneados por el supervisor (`supervisor_onboard_batch`) ya tienen `parentTaskId` (Bloque 10 T7C). Para coordinarse vía memoria:

- Cada sub-agente escribe sus executions con `visibility='shared:family'`.
- El supervisor padre lee todas las executions de su familia cuando consolida resultados.
- Si un sub-agente descubre un learning útil para sus hermanos, lo escribe con `visibility='shared:family'` y aparece inmediatamente en sus búsquedas.

### 3.4 Crecimiento futuro

Agregar un nuevo agente (ej. `delivrix-blacklist-monitor`) requiere:

1. Asignar `agent_id` slug único.
2. Definir su set de skills (entries en `agent_skills` con `agent_id` del nuevo agente o `shared:global` si reutiliza skills existentes).
3. Definir su scope de memoria (qué visibility usa por default).
4. Listo. No requiere migration de schema. La tabla soporta N agentes desde el día uno.

---

## 4. Schema Postgres + pgvector (canónico)

### 4.1 Extension y tipos

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- para gen_random_uuid

-- Embeddings de Bedrock Titan Embed Text v2 son 1024 dimensiones, multilingüe básico.
-- Si migramos a Cohere multilingual v3, también es 1024 dims. Compatible.
CREATE DOMAIN embedding_v1 AS vector(1024);

CREATE TYPE memory_visibility AS ENUM (
  'private',
  'shared:family',
  'shared:global',
  'human-authored'
);

CREATE TYPE memory_authorship AS ENUM ('agent', 'human', 'system');
```

### 4.2 Tabla canónica de memorias (vectorizada)

```sql
CREATE TABLE agent_memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  visibility      memory_visibility NOT NULL DEFAULT 'private',
  authorship      memory_authorship NOT NULL DEFAULT 'agent',
  memory_type     TEXT NOT NULL,   -- 'execution' | 'skill' | 'learning' | 'inventory' | 'conversation'
  source_path     TEXT,            -- path del archivo MD original si fue migrado de filesystem
  content         TEXT NOT NULL,   -- texto humano-readable (markdown OK)
  embedding       embedding_v1,    -- nullable mientras se computa async
  metadata        JSONB NOT NULL DEFAULT '{}',
  task_id         TEXT,            -- correlación con Canvas Live task
  parent_memory   UUID REFERENCES agent_memories(id),  -- chain de derivación (consolidaciones)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_hash      TEXT NOT NULL,   -- hash SHA-256 cadena audit
  CONSTRAINT agent_memories_content_not_empty CHECK (length(content) > 0)
);

-- Búsqueda semántica vectorial
CREATE INDEX idx_agent_memories_embedding
  ON agent_memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Filtros frecuentes
CREATE INDEX idx_agent_memories_agent_type
  ON agent_memories (agent_id, memory_type, created_at DESC);

CREATE INDEX idx_agent_memories_visibility
  ON agent_memories (visibility, agent_id);

CREATE INDEX idx_agent_memories_metadata
  ON agent_memories
  USING GIN (metadata);

CREATE INDEX idx_agent_memories_task
  ON agent_memories (task_id)
  WHERE task_id IS NOT NULL;
```

### 4.3 Tablas especializadas (vistas relacionales sobre `agent_memories`)

Para queries relacionales rápidas sin tocar el vector:

```sql
-- Estado del inventario (dominios, servers, warmup) en formato JSON estructurado
CREATE TABLE agent_inventory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  entity_type     TEXT NOT NULL,   -- 'domain' | 'server' | 'warmup_progress' | 'ip_reputation'
  entity_id       TEXT NOT NULL,   -- 'delivrix-mail.com' | 'webdock-vps-87421' | etc.
  state           JSONB NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_memory   UUID REFERENCES agent_memories(id),
  UNIQUE (agent_id, entity_type, entity_id)
);

CREATE INDEX idx_agent_inventory_lookup
  ON agent_inventory (entity_type, entity_id);

-- Skills versionadas con su definición y stats
CREATE TABLE agent_skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name      TEXT NOT NULL,
  version         TEXT NOT NULL,   -- 'v1', 'v2', etc.
  agent_id        TEXT NOT NULL,   -- agente owner; usar 'shared:global' para skills compartidas
  definition      JSONB NOT NULL,  -- args, pre/post conditions, audit events
  source_memory   UUID REFERENCES agent_memories(id),
  invocations     INTEGER NOT NULL DEFAULT 0,
  successes       INTEGER NOT NULL DEFAULT 0,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  UNIQUE (skill_name, version, agent_id)
);

-- Conversaciones (chat operador-agente) con session continuity
CREATE TABLE agent_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  operator_id     TEXT NOT NULL,
  role            TEXT NOT NULL,   -- 'user' | 'agent' | 'system'
  content         TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  source_memory   UUID REFERENCES agent_memories(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_conversations_session
  ON agent_conversations (session_id, created_at);
```

### 4.4 Trigger para mantener audit_hash en cadena

```sql
CREATE OR REPLACE FUNCTION compute_memory_audit_hash() RETURNS TRIGGER AS $$
DECLARE
  prev_hash TEXT;
BEGIN
  SELECT audit_hash INTO prev_hash
    FROM agent_memories
    WHERE agent_id = NEW.agent_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

  NEW.audit_hash := encode(
    digest(
      COALESCE(prev_hash, '') || NEW.agent_id || NEW.content || NEW.created_at::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_memories_audit_hash
  BEFORE INSERT ON agent_memories
  FOR EACH ROW
  EXECUTE FUNCTION compute_memory_audit_hash();
```

Esto garantiza que cualquier memoria tiene un hash que depende de la anterior — corruption detection se hace con un walk hacia atrás verificando hashes.

---

## 5. Generación de embeddings (Bedrock)

### 5.1 Modelo

- **Primario:** `amazon.titan-embed-text-v2:0` — 1024 dimensiones, soporta español, latencia baja, costo bajo, disponible en `us-east-1` (misma región del Bedrock que ya usa OpenClaw).
- **Alternativa:** `cohere.embed-multilingual-v3` si Titan da problemas con español técnico (jerga DevOps en mezcla EN/ES).

### 5.2 Estrategia de generación

Embedding NO se computa en el path crítico de la escritura. Async:

1. Agent escribe `agent_memories` con `embedding = NULL`.
2. Worker background lee memorias con `embedding IS NULL` cada 5s.
3. Llama Bedrock Titan, popula `embedding`.
4. Logs en audit chain (`oc.memory.embedding_generated`).

Si Bedrock falla, la memoria sigue siendo útil (texto + filtros metadata + búsqueda full-text fallback con `tsvector`).

### 5.3 Fallback con tsvector

Para resiliencia, además del embedding vectorial agregamos full-text search:

```sql
ALTER TABLE agent_memories ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', content)) STORED;

CREATE INDEX idx_agent_memories_fts ON agent_memories USING GIN (content_tsv);
```

Si el embedding no se computó aún (o Bedrock no responde), el agente cae a búsqueda léxica que igual da resultados aceptables.

---

## 6. mem0 integration en runtime OpenClaw (Python)

### 6.1 Decisión

Usar **mem0** (`mem0ai/mem0`) como capa de abstracción entre el agente Python y Postgres+pgvector. Apache 2.0, mantenido, API limpia.

### 6.2 Config sugerida

```python
from mem0 import Memory

config = {
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "user": os.environ["POSTGRES_USER"],
            "password": os.environ["POSTGRES_PASSWORD"],
            "host": os.environ["POSTGRES_HOST"],
            "port": int(os.environ.get("POSTGRES_PORT", 5432)),
            "dbname": os.environ["POSTGRES_DB"],
            "collection_name": "agent_memories",
            "embedding_model_dims": 1024,
        }
    },
    "embedder": {
        "provider": "aws_bedrock",
        "config": {
            "model": "amazon.titan-embed-text-v2:0",
            "region": "us-east-1",
        }
    },
    "llm": {
        "provider": "aws_bedrock",
        "config": {
            "model": "anthropic.claude-sonnet-4-6-v1:0",  # mismo que OpenClaw ya usa
            "region": "us-east-1",
        }
    }
}

m = Memory.from_config(config)

# Uso:
m.add(
    "El comando install_smtp_stack requiere libsasl2-modules en Ubuntu 24.04",
    user_id="openclaw",
    metadata={"memory_type": "learning", "skill": "install_smtp_stack", "severity": "high"}
)

results = m.search(
    "estoy por instalar SMTP en Ubuntu, qué debo tener en cuenta",
    user_id="openclaw",
    limit=5
)
```

### 6.3 Wrapper Delivrix

mem0 directo no respeta nuestro modelo de visibility multi-agente. Wrapper thin:

```python
class DelivrixMemory:
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.m = Memory.from_config(config)

    def add(self, content: str, *, memory_type: str, visibility: str = "private", **metadata):
        metadata = {
            **metadata,
            "memory_type": memory_type,
            "visibility": visibility,
            "agent_id": self.agent_id,
        }
        return self.m.add(content, user_id=self.agent_id, metadata=metadata)

    def search(self, query: str, *, limit: int = 5, memory_type: str | None = None):
        # Filtro visibility: lee private del agente + shared:family de su familia + shared:global + human-authored
        filters = self._visibility_filter()
        if memory_type:
            filters["memory_type"] = memory_type
        return self.m.search(query, user_id=self.agent_id, limit=limit, filters=filters)

    def _visibility_filter(self):
        family_prefix = self.agent_id.split("-")[0] + "-"
        return {
            "$or": [
                {"agent_id": self.agent_id, "visibility": "private"},
                {"agent_id": {"$startswith": family_prefix}, "visibility": "shared:family"},
                {"visibility": "shared:global"},
                {"visibility": "human-authored"},
            ]
        }
```

---

## 7. Migración desde filesystem actual

Codex ya implementó `runtime/openclaw-workspace/` filesystem-based. NO se borra. Se migra:

1. Script `scripts/migrate-workspace-to-postgres.ts` que recorre los 4 folders (executions, learnings, skills, inventory) y crea entries en `agent_memories` con `source_path` apuntando al archivo MD original.
2. Embeddings se computan async post-migration por el worker.
3. El filesystem queda como **evidence layer** legible por humanos (operadores leen markdown en su editor). Postgres es para búsquedas del agente.
4. Doble escritura mientras dura validation: cada nueva memoria se escribe en filesystem (legacy) Y en Postgres (nueva). Después de N días estables, decidimos si filesystem queda read-only o se discontinúa.

---

## 8. Crecimiento futuro previsto

Esto es lo que el schema soporta sin migrations destructivas:

| Capacidad | Cómo se agrega |
|-----------|----------------|
| **Long-term consolidation** | Worker que agrupa N learnings similares y crea uno consolidado con `parent_memory` apuntando a los originales |
| **Knowledge graph** | Tabla `agent_relations(from_memory_id, to_memory_id, relation_type)` que conecta memorias relacionadas. Ej.: `learning_X --derived_from--> execution_Y` |
| **Semantic routing entre sub-agentes** | Query semántica filtrada por `visibility='shared:family'` retorna learnings de hermanos al supervisor |
| **Cross-tenant aislamiento** | Agregar columna `tenant_id` y filtros — pero NO necesario hasta que Delivrix tenga multi-cliente |
| **Memory pruning** | Worker que archiva memorias antiguas con baja `invocations` (skills no usadas, executions de hace 6+ meses sin retrieval) |
| **Análisis cross-agent del CTO** | Vista SQL que cruza skills, executions, learnings, conversations para reportes ejecutivos |

---

## 9. Capacidad "OpenClaw como ingeniero senior"

Específicamente lo que esta arquitectura habilita (que no era posible con filesystem markdown):

| Capacidad de OpenClaw | Mecanismo |
|----------------------|-----------|
| **Interpretar** su propia memoria | SQL queries sobre `agent_memories`, joins con `agent_inventory` y `agent_skills` |
| **Leer** memorias semánticamente | `m.search("texto natural")` retorna top-K por similaridad |
| **Analizar** patrones de fallo | Query agrupando learnings por skill + root cause: `SELECT skill, count(*), array_agg(content) FROM agent_memories WHERE memory_type='learning' GROUP BY skill` |
| **Entender** el estado del mundo | `SELECT * FROM agent_inventory WHERE entity_type='domain'` antes de cualquier acción |
| **Corregir** skills propias | Detecta skills con `failures > successes` en `agent_skills` y genera draft de fix |
| **Sugerir** próximos pasos | LLM con prompt que incluye top learnings + inventario + history de conversación |
| **Informarse** sobre cambios externos | Memorias `authorship='human'` capturan decisiones del CTO; agente las lee antes de proponer |
| **Proyectarse** a estados futuros | Simulaciones que escriben memorias `memory_type='projection'` con probabilidad estimada |

---

## 10. Ownership y revisión

- **CTO Juanes** firma este modelo arquitectural. Cambios al schema requieren su aprobación.
- **Codex** implementa con feature flag `STORAGE_BACKEND=postgres-vector` y migration bidireccional.
- **Claude (PM)** mantiene este doc vivo, actualiza con cada cambio que Codex haga al schema.

**Próxima revisión:** al cierre del Trazo 4 del sprint paralelo de hoy. Luego en retro del demo viernes.

---

## 11. Referencias

- `THREAT_MODEL_DELIVRIX_2026_05_27.md` (este sprint) — gaps G13, G21, G22 cubiertos por esta arquitectura
- `OPENCLAW_PERMISSIONS_MATRIX.md` v2.0 — define qué memorias el agente puede leer/escribir según categoría
- `OPS_CODEX_SPRINT_PARALELO_HOY_2026_05_27.md` — Trazo 4 ampliado con este alcance
- mem0 docs: https://docs.mem0.ai/
- pgvector: https://github.com/pgvector/pgvector
- AWS Bedrock Titan Embeddings: https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
