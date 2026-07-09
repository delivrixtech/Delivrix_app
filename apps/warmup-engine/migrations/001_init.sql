-- Warmup engine v1 (Postfix-only, Track A) — esquema inicial.
-- Source of truth: Delivrix-Warmup-Diseno-v1.md §12 ("Modelo de datos", bloque v1).
-- v1 NO tiene mesh/AI: nada de pairings/threads/variant_bank/tenants — eso es v2.
-- El warmup v1 se calienta con tráfico transaccional real + medición de placement (§4, §6).

-- Núcleo: el nodo (buzón) y su estado de auth + placement.
CREATE TABLE IF NOT EXISTS warmup_nodes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox             text NOT NULL UNIQUE,
  domain              text NOT NULL,
  infra_type          text NOT NULL DEFAULT 'postfix',   -- postfix (v1) | m365 (v2)
  state               text NOT NULL DEFAULT 'blocked',   -- blocked|fresh|warm|paused|quarantined
  auth_ready          boolean NOT NULL DEFAULT false,    -- gate fail-closed (§8): sin ready no envía
  contract_expires_at timestamptz,                       -- TTL del contrato de auth
  sending_ip          inet,                              -- IP saliente (reputación self-hosted, §4)
  helo_fqdn           text,
  daily_limit         integer NOT NULL DEFAULT 10,       -- §10
  increase_by_day     integer NOT NULL DEFAULT 1,
  day_index           integer NOT NULL DEFAULT 0,
  weekdays_only       boolean NOT NULL DEFAULT false,
  health_score        numeric,                           -- diagnóstico, NO gatea (§3)
  placement_score     numeric,                           -- Wilson-LB de inbox; gatea todo (§9)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_nodes_infra_chk CHECK (infra_type IN ('postfix', 'm365')),
  CONSTRAINT warmup_nodes_state_chk CHECK (state IN ('blocked', 'fresh', 'warm', 'paused', 'quarantined'))
);

-- Fiabilidad: cada envío es idempotente por slot (exactly-once) + soporta DLQ (§7, §12).
CREATE TABLE IF NOT EXISTS warmup_sends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id      uuid NOT NULL REFERENCES warmup_nodes(id),
  slot_key     text NOT NULL,                            -- clave idempotente por slot programado
  to_address   text NOT NULL,
  status       text NOT NULL DEFAULT 'queued',           -- queued|sent|bounced|failed|dead_lettered
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_sends_status_chk CHECK (status IN ('queued', 'sent', 'bounced', 'failed', 'dead_lettered')),
  CONSTRAINT warmup_sends_slot_uq UNIQUE (node_id, slot_key)   -- idempotencia exactly-once por slot
);

CREATE INDEX IF NOT EXISTS warmup_sends_node_idx ON warmup_sends (node_id, created_at DESC);

-- Señales de fiabilidad: bounces (Postmaster/SNDS entran con hosted en v2).
CREATE TABLE IF NOT EXISTS warmup_signals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id      uuid NOT NULL REFERENCES warmup_nodes(id),
  kind         text NOT NULL,                            -- bounce | complaint | deferral
  detail       jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warmup_signals_node_idx ON warmup_signals (node_id, occurred_at DESC);

-- Medición de placement (§9): el gate REAL. Panel propio de seeds → tests → resultados → rollup.
CREATE TABLE IF NOT EXISTS warmup_seed_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address       text NOT NULL UNIQUE,
  provider      text NOT NULL,                           -- gmail|workspace|outlook|m365|yahoo|gmx|webde
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_seed_provider_chk
    CHECK (provider IN ('gmail', 'workspace', 'outlook', 'm365', 'yahoo', 'gmx', 'webde'))
);

CREATE TABLE IF NOT EXISTS warmup_placement_tests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       uuid NOT NULL REFERENCES warmup_nodes(id),
  seed_id       uuid NOT NULL REFERENCES warmup_seed_accounts(id),
  test_id       text NOT NULL UNIQUE,                    -- X-Delivrix-Test-Id (header oculto)
  sent_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warmup_placement_tests_node_idx ON warmup_placement_tests (node_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS warmup_placement_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       text NOT NULL REFERENCES warmup_placement_tests(test_id),
  node_id       uuid NOT NULL REFERENCES warmup_nodes(id),
  provider      text NOT NULL,
  landed_in     text,                                    -- primary|tabs|spam|missing (NULL = pendiente)
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_placement_landed_chk
    CHECK (landed_in IS NULL OR landed_in IN ('primary', 'tabs', 'spam', 'missing'))
);

CREATE INDEX IF NOT EXISTS warmup_placement_results_node_idx ON warmup_placement_results (node_id, created_at DESC);

-- Rollup por nodo/ventana: Wilson-LB + EWMA que maneja la FSM (§9).
CREATE TABLE IF NOT EXISTS warmup_placement_rollups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id           uuid NOT NULL REFERENCES warmup_nodes(id),
  window_start      date NOT NULL,
  window_end        date NOT NULL,
  samples           integer NOT NULL DEFAULT 0,
  inbox_count       integer NOT NULL DEFAULT 0,          -- primary + tabs (tabs cuenta como inbox, §9)
  spam_count        integer NOT NULL DEFAULT 0,
  missing_count     integer NOT NULL DEFAULT 0,
  inbox_wilson_lb   numeric,                             -- lower bound del intervalo de Wilson
  inbox_ewma        numeric,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_rollup_window_uq UNIQUE (node_id, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS warmup_placement_rollups_node_idx ON warmup_placement_rollups (node_id, window_end DESC);
