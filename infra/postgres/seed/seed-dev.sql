-- Idempotent local development seed for OrbStack/Docker Desktop.

SET search_path TO delivrix, public;

INSERT INTO operators (id, email, display_name, role)
VALUES
  ('operator_juanes_dev', 'juanes@delivrix.local', 'Juanes · CTO', 'owner'),
  ('operator_claude_dev', 'claude@delivrix.local', 'Claude · PM Frontend', 'operator'),
  ('operator_codex_dev', 'codex@delivrix.local', 'Codex · Gateway', 'operator')
ON CONFLICT (id) DO NOTHING;

INSERT INTO campaigns (
  id,
  name,
  classification,
  status,
  physical_address,
  unsubscribe_url,
  created_by
)
VALUES (
  'campaign_demo_authorized_001',
  'Demo autorizada Delivrix',
  'commercial',
  'draft',
  'Delivrix LLC physical mailing address · demo',
  'https://delivrix.local/unsubscribe/demo',
  'operator_juanes_dev'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO physical_servers (id, label, location, model, status, metadata)
VALUES (
  'physical_popayan_primary',
  'Servidor físico Popayán',
  'Popayán, Colombia',
  'IBM System x3630 M4',
  'onboarded',
  '{"source":"seed-dev","purpose":"demo-orbstack"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO clusters (id, label, kind, provider, status, metadata)
VALUES
  ('cluster_manual_sender', 'manual-sender', 'manual-sender', 'manual', 'planned', '{"source":"seed-dev"}'::jsonb),
  ('cluster_proxmox_sender', 'proxmox-sender', 'proxmox-sender', 'proxmox', 'planned', '{"source":"seed-dev"}'::jsonb),
  ('cluster_webdock_sender', 'webdock-sender', 'webdock-sender', 'webdock', 'warming', '{"source":"seed-dev","bridge":"continuity"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cluster_nodes (id, cluster_id, label, status, daily_limit, metadata)
VALUES
  ('manual-node-01', 'cluster_manual_sender', 'manual node 01', 'planned', 0, '{"ip":"pending"}'::jsonb),
  ('manual-node-02', 'cluster_manual_sender', 'manual node 02', 'planned', 0, '{"ip":"pending"}'::jsonb),
  ('manual-node-03', 'cluster_manual_sender', 'manual node 03', 'planned', 0, '{"ip":"pending"}'::jsonb),
  ('proxmox-node-01', 'cluster_proxmox_sender', 'proxmox node 01', 'planned', 0, '{"lxc":"planned"}'::jsonb),
  ('proxmox-node-02', 'cluster_proxmox_sender', 'proxmox node 02', 'planned', 0, '{"lxc":"planned"}'::jsonb),
  ('proxmox-node-03', 'cluster_proxmox_sender', 'proxmox node 03', 'planned', 0, '{"lxc":"planned"}'::jsonb),
  ('proxmox-node-04', 'cluster_proxmox_sender', 'proxmox node 04', 'planned', 0, '{"lxc":"planned"}'::jsonb),
  ('webdock-node-01', 'cluster_webdock_sender', 'webdock bridge 01', 'warming', 50, '{"bridge":"primary"}'::jsonb),
  ('webdock-node-02', 'cluster_webdock_sender', 'webdock bridge 02', 'warming', 50, '{"bridge":"ops"}'::jsonb),
  ('webdock-node-03', 'cluster_webdock_sender', 'webdock bridge 03', 'warming', 50, '{"bridge":"account"}'::jsonb),
  ('webdock-node-04', 'cluster_webdock_sender', 'webdock bridge 04', 'paused', 0, '{"bridge":"reserve"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (id, label, cap_usd, balance_usd, status, metadata)
VALUES (
  'wallet_ops_demo',
  'Wallet operativo demo',
  50.00,
  47.00,
  'active',
  '{"approval":"CTO","scope":"demo-only"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallet_transactions (id, wallet_id, amount_usd, direction, reason, metadata)
VALUES (
  'wallet_tx_initial_3usd',
  'wallet_ops_demo',
  3.00,
  'debit',
  'Reserva inicial demo',
  '{"source":"seed-dev"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kill_switch_events (id, state, reason, actor_id, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000101',
  'armed',
  'Seed local: kill switch listo, no activado',
  'operator_codex_dev',
  '{"source":"seed-dev"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_events (
  id,
  occurred_at,
  actor_type,
  actor_id,
  action,
  resource,
  target_type,
  target_id,
  risk_level,
  detail,
  metadata,
  signature,
  prev_hash,
  hash
)
VALUES
  (
    '00000000-0000-4000-8000-000000000201',
    '2026-05-28T08:00:00Z',
    'system',
    'seed-dev',
    'db.seed.started',
    'postgres',
    'database',
    'delivrix_mailops',
    'low',
    '{"message":"Seed local iniciado"}'::jsonb,
    '{"chainIndex":1}'::jsonb,
    'dev-signature-001',
    NULL,
    'dev-audit-hash-001'
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    '2026-05-28T08:01:00Z',
    'operator',
    'operator_juanes_dev',
    'physical_server.onboarded',
    'physical_popayan_primary',
    'physical_server',
    'physical_popayan_primary',
    'medium',
    '{"location":"Popayán","model":"IBM System x3630 M4"}'::jsonb,
    '{"chainIndex":2}'::jsonb,
    'dev-signature-002',
    'dev-audit-hash-001',
    'dev-audit-hash-002'
  ),
  (
    '00000000-0000-4000-8000-000000000203',
    '2026-05-28T08:02:00Z',
    'openclaw',
    'openclaw-local',
    'clusters.seeded',
    'clusters',
    'cluster',
    'cluster_webdock_sender',
    'low',
    '{"count":3,"nodes":11}'::jsonb,
    '{"chainIndex":3}'::jsonb,
    'dev-signature-003',
    'dev-audit-hash-002',
    'dev-audit-hash-003'
  ),
  (
    '00000000-0000-4000-8000-000000000204',
    '2026-05-28T08:03:00Z',
    'operator',
    'operator_juanes_dev',
    'wallet.transaction.recorded',
    'wallet_ops_demo',
    'wallet',
    'wallet_ops_demo',
    'medium',
    '{"amountUsd":3,"capUsd":50}'::jsonb,
    '{"chainIndex":4}'::jsonb,
    'dev-signature-004',
    'dev-audit-hash-003',
    'dev-audit-hash-004'
  ),
  (
    '00000000-0000-4000-8000-000000000205',
    '2026-05-28T08:04:00Z',
    'system',
    'seed-dev',
    'kill_switch.armed',
    'kill_switch',
    'kill_switch',
    'global',
    'low',
    '{"state":"armed","liveActionsEnabled":false}'::jsonb,
    '{"chainIndex":5}'::jsonb,
    'dev-signature-005',
    'dev-audit-hash-004',
    'dev-audit-hash-005'
  )
ON CONFLICT (id) DO NOTHING;
