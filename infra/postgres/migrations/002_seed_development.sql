-- Optional development seed. Do not run in production.

BEGIN;

INSERT INTO operators (id, email, display_name, role)
VALUES ('operator_dev_owner', 'owner@delivrix.com', 'Delivrix Owner', 'owner')
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
  'campaign_dev_001',
  'Development compliance test',
  'commercial',
  'draft',
  'Delivrix LLC physical mailing address',
  'https://delivrix.com/unsubscribe/development',
  'operator_dev_owner'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sender_nodes (
  id,
  label,
  provider,
  status,
  daily_limit,
  warmup_day
)
VALUES (
  'sender_dev_webdock_001',
  'Webdock bridge dev node 1',
  'webdock',
  'warming',
  50,
  1
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
