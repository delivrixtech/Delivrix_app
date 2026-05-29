# OPS Codex — Exponer endpoints workspace para WorkspaceBrowser

**Para:** Codex.
**De:** Claude (PM + Frontend senior).
**Fecha:** 2026-05-28 jueves, post-auditoría visual.
**Prioridad:** Alta — sin esto el demo viernes muestra dataset DEMO en lugar de los archivos reales que vos generaste con tus smokes.
**Estimado:** ~1.5h.

---

## Contexto

Hoy hice auditoría visual del panel post-push del WalletWidget (c535e3d). Detecté 5 hallazgos:

- B-A1 a B-A4: bugs frontend pequeños, ya los cerré en commit aparte (`push_audit_fixes.sh`).
- B-A5: falso positivo (comando palette tenía Dominios y Sender Pool, solo requería scroll).
- **B-A6 (este OPS):** WorkspaceBrowser del tab Archivos del Canvas Live **cae al fallback DEMO_TREE** porque el endpoint backend no existe.

Tu workspace `runtime/openclaw-workspace/` tiene evidencia REAL de los smokes que corriste ayer (D10) — archivos como `executions/2026-05-27/010215-register_domain_route53-delivrix-demo-d10-20260527.click-success.md`, `executions/2026-05-28/...`, etc. El panel debería mostrarlos pero muestra los archivos DEMO que yo había inventado en Pieza 4 (`2026-05-29/1100-...md` que no existen en disco).

Para el demo viernes Acto 2 (memoria persistente del agente), tenemos que poder mostrar los archivos REALES.

## Lo que el frontend espera

El componente `apps/admin-panel/src/features/canvas/workspace-browser.tsx` hace fetch de 2 endpoints:

### Endpoint 1 — Listar contenido de un path

```
GET /v1/openclaw/workspace/tree?path=<dir>
```

**Path semantics:** path relativo dentro de `runtime/openclaw-workspace/`. Ej:

- `path=/` → lista root (executions, learnings, skills, inventory).
- `path=/executions` → lista subcarpetas por fecha (`2026-05-27/`, `2026-05-28/`).
- `path=/executions/2026-05-27` → lista archivos `.md` dentro.

**Response esperado:**

```typescript
interface WorkspaceTreeResponse {
  path: string;
  nodes: Array<{
    name: string;          // "executions" o "010215-register_domain_route53-...-success.md"
    path: string;          // "/executions" o "/executions/2026-05-27/010215-...md"
    kind: "directory" | "file";
    size?: number;         // bytes, solo para files
    mimeType?: string;     // "text/markdown", "application/json"
    modifiedAt?: string;   // ISO 8601 timestamp
  }>;
  source: {
    kind: "live" | "mock";
    trusted: boolean;
  };
}
```

Cuando `source.kind === "live"`, el frontend quita el badge "mock" amarillo del header de preview.

### Endpoint 2 — Leer contenido de un archivo

```
GET /v1/openclaw/workspace/file?path=<file>
```

**Response esperado:**

```typescript
interface WorkspaceFileResponse {
  path: string;
  content: string;       // raw markdown o JSON stringified
  mimeType: string;      // "text/markdown" | "application/json"
  size: number;
  source: {
    kind: "live" | "mock";
    trusted: boolean;
  };
}
```

El frontend ya hace JSON pretty-print si `mimeType === "application/json"`.

---

## Guardrails de seguridad

Estos endpoints leen del filesystem local. Aplicá:

1. **Path traversal guard:** rechazar paths con `..` o que escapen del root permitido. Solo permitir paths relativos dentro de `OPENCLAW_WORKSPACE_DIR` (env var, default `runtime/openclaw-workspace`).
2. **Cap de tamaño:** rechazar archivos >1MB con error `file_too_large`. Si un agente genera un MD enorme, no lo metemos en JSON response.
3. **Solo lectura:** estos endpoints son `allowed_read_only` en la matrix. **NO** exponer mutations (`POST/DELETE/PUT`) — el agente escribe en el workspace via Python directo, no por HTTP.
4. **Audit chain:** opcional pero ideal — emitir `oc.workspace.read_tree` o `oc.workspace.read_file` con `actorId=operator-via-panel` para tener auditoría de qué archivos lee el operador desde el panel.
5. **Rate limit razonable:** el panel hace polling cada 30s en tree + 15s staleTime. No deberías recibir más de 4 requests/min de un operador.

---

## Tareas

1. **Implementar handler `apps/gateway-api/src/routes/openclaw-workspace.ts`** (o donde te parezca, no impongo paths).
2. **Registrar rutas en `apps/gateway-api/src/main.ts`** como `GET /v1/openclaw/workspace/tree` y `/file`.
3. **Agregar al read-boundary** `apps/admin-panel/src/shared/api/read-boundary.ts` los 2 endpoints. El frontend tiene un guard automático que rechaza fetchs a paths no listados.
4. **Tests:** smoke contra fixtures + smoke contra workspace real (cuando tengamos los archivos del run de ayer).
5. **Smoke E2E:** después de implementar, navegá a `localhost:5173/canvas` tab Archivos y verificá que muestra `executions/2026-05-27/` y `executions/2026-05-28/` con los archivos reales (no el dataset demo del fallback).

---

## Lo que no toques

- El componente `workspace-browser.tsx` del frontend NO se modifica (su fallback a demo dataset es feature, no bug — funciona como degradación si los endpoints fallan).
- No cambiar el shape del response (el frontend ya lo espera tal como está en este OPS).
- No agregar autenticación per-operator todavía — sigue lo que ya hace el resto del gateway hoy.

---

## Verificación esperada al cerrar el OPS

```
✓ Endpoint /v1/openclaw/workspace/tree?path=/
  - Status 200
  - Response incluye nodes con executions/, learnings/, skills/, inventory/
  - source.kind = "live"

✓ Endpoint /v1/openclaw/workspace/tree?path=/executions
  - Status 200
  - Response incluye 2026-05-27/, 2026-05-28/ (las fechas reales del run D10)

✓ Endpoint /v1/openclaw/workspace/file?path=/executions/2026-05-27/<file real>.md
  - Status 200
  - Response.content tiene el markdown real escrito por el agente

✓ Path traversal blocked:
  - GET /v1/openclaw/workspace/tree?path=../../../etc/passwd → 400 invalid_path
  - GET /v1/openclaw/workspace/file?path=/../../etc/passwd → 400 invalid_path

✓ File too large blocked:
  - GET /v1/openclaw/workspace/file con archivo >1MB → 413 file_too_large

✓ Smoke E2E visual:
  - localhost:5173/canvas tab Archivos muestra los archivos REALES
  - Sin badge "mock" amarillo en el preview

→ Demo viernes Acto 2 (memoria persistente) muestra evidencia real, no
  dataset inventado.
```

Gracias. Próximo paso post-OPS: practice run del demo end-to-end visual.
