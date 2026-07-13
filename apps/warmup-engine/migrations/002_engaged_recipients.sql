-- Warmup v1 — lista curada de destinatarios "engaged" (estrategia A+B del §5 Diseño-v1).
-- El warmup v1 se calienta con tráfico real: los seeds miden placement, y esta lista de humanos
-- reales (equipo/partners/opt-in) aporta el volumen de engagement real. NO es una lista de cold:
-- son destinatarios que abren/responden de verdad. El scheduler la usa como fuente de pickRecipient.

CREATE TABLE IF NOT EXISTS warmup_engaged_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address      text NOT NULL UNIQUE,
  label        text,                                  -- p.ej. "equipo", "partner", "newsletter opt-in"
  enabled      boolean NOT NULL DEFAULT true,
  -- Peso relativo para la rotación (más peso = elegido más seguido). Default 1.
  weight       integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warmup_engaged_weight_chk CHECK (weight >= 1)
);

CREATE INDEX IF NOT EXISTS warmup_engaged_enabled_idx ON warmup_engaged_recipients (enabled);
