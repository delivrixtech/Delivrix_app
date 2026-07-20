-- Warmup v1 — feed de ACTIVIDAD del loop de calentamiento (visualización en vivo del panel).
-- Cada vuelta real del ciclo (① SEND → ② MEASURE → ③ ENGAGE → ④ REPLY) escribe una fila por
-- etapa. Es un LOG append-only de eventos REALES: el panel lo lee (GET /v1/warmup/activity) y pinta
-- el feed en tiempo real. No inventa nada — si no hay filas, el panel muestra "sin actividad aún".
-- Nunca guarda secretos (ni credenciales, ni cuerpos completos): sólo metadatos observables.

CREATE TABLE IF NOT EXISTS warmup_activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- Agrupa las 4 etapas de una misma vuelta del ciclo.
  cycle_id     text NOT NULL,
  -- Emisor (box) y bandeja seed que participaron en esta vuelta.
  node_domain  text NOT NULL,
  seed_inbox   text NOT NULL,
  -- Etapa del loop: sent | measured | engaged | replied | error.
  kind         text NOT NULL,
  -- Placement medido en 'measured'/'engaged' (INBOX | SPAM | PROMOTIONS). NULL en otras etapas.
  placement    text,
  -- Asunto de la conversación cotidiana (natural, sin marketing) — para que el feed sea legible.
  subject      text,
  -- Metadatos observables adicionales (respuesta SMTP, ids cortos, nota). NUNCA secretos.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  test_id      text,
  CONSTRAINT warmup_activity_kind_chk CHECK (kind IN ('sent','measured','engaged','replied','error'))
);

CREATE INDEX IF NOT EXISTS warmup_activity_occurred_idx ON warmup_activity (occurred_at DESC);
CREATE INDEX IF NOT EXISTS warmup_activity_cycle_idx ON warmup_activity (cycle_id);
