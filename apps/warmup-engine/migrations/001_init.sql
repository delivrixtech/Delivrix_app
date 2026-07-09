-- Warmup engine — esquema inicial (§7 de Delivrix-Warmup-Sistema-AI.md).
-- Mesh propio de nodos Postfix/Dovecot: nodes ↔ pairings, placement por seed_checks,
-- hilos conversacionales para replies coherentes multi-turno.

CREATE TABLE IF NOT EXISTS warmup_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox         text NOT NULL UNIQUE,                 -- dirección del buzón (nodo del mesh)
  domain          text NOT NULL,
  esp             text NOT NULL DEFAULT 'generic',      -- gmail | outlook | yahoo | generic (proveedor destino que emula)
  state           text NOT NULL DEFAULT 'fresh',        -- fresh | warming | warm | paused
  daily_limit     integer NOT NULL DEFAULT 10,          -- tope de warmup emails/día (§2)
  increase_by_day integer NOT NULL DEFAULT 1,           -- rampa: +N por día hasta daily_limit
  day_index       integer NOT NULL DEFAULT 0,           -- días dentro del ciclo de warmup
  weekdays_only   boolean NOT NULL DEFAULT false,       -- patrón más natural (§2)
  warmup_tag      text NOT NULL,                        -- header/tag oculto para identificar warmup entrante
  health_score    numeric,                              -- % de warmup que llegó a inbox vs spam (score interno, 7d)
  placement_score numeric,                              -- % inbox REAL medido contra seed inboxes (gatea todo)
  paused_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_nodes_state_chk CHECK (state IN ('fresh', 'warming', 'warm', 'paused'))
);

CREATE TABLE IF NOT EXISTS warmup_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  ai_context  jsonb,                                    -- contexto para que la AI mantenga replies coherentes
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warmup_pairings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node          uuid NOT NULL REFERENCES warmup_nodes(id),
  to_node            uuid NOT NULL REFERENCES warmup_nodes(id),
  thread_id          uuid REFERENCES warmup_threads(id),
  sent_at            timestamptz,
  opened             boolean NOT NULL DEFAULT false,
  replied            boolean NOT NULL DEFAULT false,
  rescued_from_spam  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_pairings_distinct_chk CHECK (from_node <> to_node)
);

-- Evita repetir el mismo par en el mismo día (regla del pair-matcher).
CREATE UNIQUE INDEX IF NOT EXISTS warmup_pairings_daily_uq
  ON warmup_pairings (from_node, to_node, (date_trunc('day', COALESCE(sent_at, created_at))));

CREATE INDEX IF NOT EXISTS warmup_pairings_from_idx ON warmup_pairings (from_node, created_at DESC);
CREATE INDEX IF NOT EXISTS warmup_pairings_to_idx ON warmup_pairings (to_node, created_at DESC);

CREATE TABLE IF NOT EXISTS warmup_seed_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     uuid NOT NULL REFERENCES warmup_nodes(id),
  seed_inbox  text NOT NULL,                            -- dirección del seed inbox real (Gmail/Outlook/…)
  sent_at     timestamptz NOT NULL DEFAULT now(),
  landed_in   text,                                     -- primary | promotions | spam | missing (NULL = pendiente de lectura)
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_seed_checks_landed_chk
    CHECK (landed_in IS NULL OR landed_in IN ('primary', 'promotions', 'spam', 'missing'))
);

CREATE INDEX IF NOT EXISTS warmup_seed_checks_node_idx ON warmup_seed_checks (node_id, sent_at DESC);
