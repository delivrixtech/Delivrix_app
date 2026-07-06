# Delivrix MailOps Platform

Control plane de Delivrix para onboarding inteligente con OpenClaw, preparacion de clusters/VPS/sender nodes, warming, reputacion, auditoria y gobierno de capacidad de mailing autorizado.

## Propiedad intelectual

Copyright (c) 2026 Delivrix LLC. Todos los derechos reservados.  
Desarrollado por JECT.

Ver `NOTICE.md`.

## Norte

Delivrix gobierna infraestructura real, pero ninguna mutacion contra el mundo
ocurre sin pasar por tres candados independientes:

- **Kill switch** centralizado (fail-closed): clasifica toda accion live y
  bloquea con `423` antes de ejecutar.
- **Flags de runtime** por operacion (`*_ENABLE_*` en `.env.local`, hot-reload
  ~1s sin redeploy): las escrituras nacen en `false`.
- **ApprovalGate humano**: cada mutacion real exige firma del operador.

Todo queda en audit chain append-only. Documento rector:
`DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`.

## Flujo de ramas

- **`produ`** es la rama de integracion. Todo feature nace de `produ` y vuelve
  a `produ` por Pull Request (con la suite verde).
- **`main`** es espejo estable de `produ`: se sincroniza por fast-forward
  periodico (`git push origin origin/produ:main`). No se commitea directo.
- Las ramas de feature se borran despues del merge. No se acumulan ramas
  muertas: si esta mergeada, se borra; si tiene trabajo unico, tiene dueno y
  destino (PR o archivo).

## Estructura

- `apps/gateway-api`: API HTTP del control plane.
- `apps/worker`: worker local seguro, sin SMTP real.
- `apps/admin-panel`: UI local read-only separada del backend.
- `packages/domain`: reglas, contratos, gates, auditoria y decisiones.
- `packages/adapters`: adaptadores de proveedores externos.
- `packages/local-store`: persistencia local de desarrollo.
- `packages/queue`: cola local de desarrollo.
- `services/openclaw-skills`: skills del agente OpenClaw.
- `DOCUMENTACION`: documentos rectores, fases e hitos.

## Proveedores (multi-provider / multicuenta)

Inventario unificado en `GET /v1/infrastructure/inventory` y panel
Infraestructura. Lecturas degradan a mock si un proveedor falla; escrituras
siempre gated.

| Capa | Proveedores |
|---|---|
| Compute (VPS) | Webdock (multicuenta), Contabo (multicuenta: flat + `CONTABO_ACCOUNT_{n}_*`) |
| Registradores de dominio | AWS Route53, Namecheap (multicuenta `NAMECHEAP_ACCOUNT_{n}_*`), Porkbun, IONOS |
| DNS | AWS Route53, IONOS Cloud DNS |
| Salud/reputacion | MXToolbox |
| Fisico | Servidor propio (placeholder; Tampa/colo en camino) |

Las cuentas se agregan por variables de entorno indexadas (ver
`.env.example`), sin tocar codigo. Namecheap exige whitelistear la IP del
gateway en cada cuenta. Llamadas nuevas van por `provider-fetch` (timeout,
retry idempotente, circuit breaker por cuenta). Spec:
`DOCUMENTACION/HITO_PROVIDER_FABRIC_2026_07_06.md`.

## Comandos

```bash
npm test               # suite completa (domain + adapters + storage + gateway)
npm run test:admin     # panel: tsc + tests + build

npm run dev:gateway    # gateway en http://127.0.0.1:3000
npm run dev:worker
npm run dev:admin      # panel en http://127.0.0.1:5173
```

Requiere Node >= 24 (local con Node 22 reciente tambien corre la suite).

## URLs locales

Gateway:

```txt
http://127.0.0.1:3000/health
```

Admin panel:

```txt
http://127.0.0.1:5173
```

## Admin panel

El panel vive separado del backend y consume solo contratos `GET`:

- `GET /health`
- `GET /v1/admin/clusters`
- `GET /v1/admin/overview`
- `GET /v1/admin/workflow`
- `GET /v1/infrastructure/inventory`
- `GET /v1/openclaw/learning-plan`
- `GET /v1/operating-north`
- `GET /v1/kill-switch`

El proxy local del panel bloquea `POST`, `PUT`, `PATCH` y `DELETE` con `405`
(salvo rutas explicitamente permitidas en `allowedWritePaths`, con audit y
gate en backend).

## Documentacion principal

Leer en este orden:

1. `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`
2. `DOCUMENTACION/INDICE_DOCUMENTACION.md`
3. `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
4. `DOCUMENTACION/ROADMAP_PROYECTO.md`
5. `DOCUMENTACION/ESTANDARES_INGENIERIA.md`
6. Documento del hito en curso.

Los documentos de hito son historicos/operativos. El README no duplica sus
endpoints ni sus notas de seguridad para evitar ruido.
