# Delivrix Admin Panel

Read-only frontend shell for the Delivrix control plane.

## Boundary

- The panel is separate from Gateway, Worker, domain, stores and adapters.
- The panel only calls `GET` endpoints.
- The panel never reads `runtime/` files.
- The panel never imports backend domain services.
- The panel does not send email, run SSH, mutate DNS, mutate Proxmox or write to NFC.

## Local run

```bash
node apps/gateway-api/src/main.ts
node apps/admin-panel/server.mjs
```

Open:

```txt
http://127.0.0.1:5173
```

The local server serves static frontend files and proxies only `GET` requests to Gateway:

- `GET /health`
- `GET /v1/admin/clusters`
- `GET /v1/admin/overview`
- `GET /v1/admin/workflow`
- `GET /v1/openclaw/learning-plan`
- `GET /v1/operating-north`
- `GET /v1/kill-switch`

Any non-GET request through the panel proxy returns `405`.

## Check

```bash
node --test apps/admin-panel/src/shared/api/client.test.mjs apps/admin-panel/src/shared/lib/formatters.test.mjs
```
