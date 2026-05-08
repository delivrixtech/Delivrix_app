# Delivrix Admin Panel

React/Vite read-only frontend for the Delivrix control plane.

## Boundary

- The panel is separate from Gateway, Worker, domain, stores and adapters.
- The panel only calls `GET` endpoints.
- The panel never reads `runtime/` files.
- The panel never imports backend domain services.
- The panel does not send email, run SSH, mutate DNS, mutate Proxmox or write to NFC.
- Runtime data comes from Gateway contracts. The frontend does not calculate readiness, permissions or safety gates.

## Local run

```bash
npm run dev:gateway
npm run dev:admin
```

Open:

```txt
http://127.0.0.1:5173
```

Vite serves the React app and proxies only approved `GET` requests to Gateway. The approved boundary lives in:

```txt
src/shared/api/read-boundary.ts
```

Any non-GET request through the panel proxy returns `405`.

## Build and serve

```bash
npm --workspace @delivrix/admin-panel run build
npm run serve:admin
```

`server.mjs` serves the built `dist/` bundle and keeps the same `GET-only` proxy boundary.

## Check

```bash
npm --workspace @delivrix/admin-panel run check
```
