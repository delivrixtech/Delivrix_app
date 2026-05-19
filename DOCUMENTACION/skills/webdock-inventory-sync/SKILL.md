---
slug: webdock-inventory-sync
version: 1.0.0
trigger: "qué servidores tengo en Webdock | inventario | cuántos VPS | muéstrame el inventario"
delivrix_actions:
  - read_webdock_inventory
returns: structured-markdown
audit_id_prefix: oc.skill.webdock_sync
fallback: mock-canonical
hito: 5.11.A (cabling) + 5.11.B (uso como skill)
---

# Webdock Inventory Sync

## Propósito

Lee el inventario de servers Webdock pasando por el Gateway Delivrix (no
directo al proveedor). El Gateway aplica cache 60s, audit log y rules
engine de drift; esta skill solo expone el resultado al agente para que
lo razone.

## Cuándo se invoca

- Operador pregunta sobre el inventario.
- Otra skill (typically `delivrix-fleet-ops` o `drift-monitor`) necesita
  el inventario fresco.
- Cron del agente cada 5 min como input al drift monitor.

## Endpoints que consume

| Orden | Endpoint | Por qué |
| --- | --- | --- |
| 1 | `GET /v1/webdock/inventory` | Inventario + drift detectado |

## Formato de respuesta

```markdown
## Webdock — inventario {ISO}

**Fuente: {live | mock}** {advertencia si mock}

**Resumen**
- Total: {N}
- Running: {N}
- Stopped: {N}
- Suspended: {N}
- Otros: {N}

**Servers**
{tabla: slug | name | status | ipv4 | location | profileSlug | lastDataReceived}

**Drift detectado por rules engine**
{lista de propuestas con severidad o "ninguno"}

_Evidencia_: `oc.read.webdock#{hash}`
```

## Errores y fallback

| Escenario | Acción |
| --- | --- |
| Gateway responde `source.kind: mock` | Lo anuncia explícitamente en respuesta; recomienda activar `WEBDOCK_API_KEY` env |
| Gateway 503 (Webdock API caída) | Reporta degradación, no inventa datos |
| Gateway responde lista vacía | Lo reporta literal ("no hay servers"); no invocar fallback de mock automáticamente |

## Gates duros

- Esta skill no llama directo a `api.webdock.io`. Solo al Gateway local.
  Esto centraliza auth, audit y rate limiting.
- No expone tokens del proveedor en respuesta. Solo metadata pública.
- No propone acciones; solo informa. Las propuestas las hace `drift-monitor`.

## Ejemplo de prompt del operador

> "qué tengo en Webdock?"

## Ejemplo de respuesta esperada (modo live)

```markdown
## Webdock — inventario 2026-05-18T03:30:00Z

**Fuente: live**

**Resumen**
- Total: 3
- Running: 2
- Stopped: 1
- Suspended: 0
- Otros: 0

**Servers**
| slug | name | status | ipv4 | location | profile | lastDataReceived |
|---|---|---|---|---|---|---|
| svc-warmup-01 | svc-warmup-01 | running | 185.243.12.31 | fi-hel-2 | webdockepyc-bit-2 | 2026-05-18T03:25Z |
| svc-warmup-02 | svc-warmup-02 | running | 185.243.12.32 | fi-hel-2 | webdockepyc-bit-2 | 2026-05-18T03:25Z |
| svc-prod-eu-01 | svc-prod-eu-01 | stopped | 185.243.12.40 | fi-hel-2 | webdockepyc-bit-4 | 2026-05-15T22:00Z |

**Drift detectado por rules engine**
- `node_register_proposed` (low) — svc-prod-eu-01 existe en Webdock pero no
  en sender_node registry. Considera registrarlo si planeas usarlo.

_Evidencia_: `oc.read.webdock#a7c9e1`
```

## Implementación (Codex)

- `SKILL.md` puro: lógica simple, una llamada HTTP + render Markdown.
  No requiere plugin TypeScript.
- Cache local 30s en el container OpenClaw.
- Si `oc.read.webdock` falla 3 veces consecutivas, escalar a `alert-ops`.
