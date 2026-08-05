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

## Donde corre esto (topologia real)

No hay servidor de aplicacion. El control plane corre en la **maquina del
operador**; los 58 nodos SMTP son servidores, pero solo mandan correo y no
ejecutan nada de este repo.

| Pieza | Donde | Siempre encendida |
|---|---|---|
| Gateway API (`:3000`) | Mac del operador | no |
| Admin panel (`:5173`) | Mac del operador | no |
| Postgres (`127.0.0.1:5432`) | Mac del operador | no |
| Warmup: daemon, agente y medicion de cupo | Mac del operador | no |
| Modelo local de inferencia (`:1234`) | Mac mini, por Tailscale | si |
| Nodos SMTP (Postfix + OpenDKIM) | 58 VPS Contabo/Webdock | si |

**Consecuencia operativa, medida el 2026-08-05:** en macOS los temporizadores no
corren mientras la maquina duerme. Una noche con la Mac suspendida dejo al daemon
12,7 h sin una vuelta y a la medicion del cupo vencida 14,6 h, con los procesos
vivos y sin un solo error. El sistema lo declara (`status` avisa "medicion
VENCIDA") y el loop de medicion ahora chequea la edad real del archivo en vez de
confiar en el temporizador, asi que al despertar remide enseguida. Pero **mientras
la maquina duerme no sale correo**: un warmup 24/7 exige un host que no se
suspenda.

Lo que ata el control plane a esa maquina, y hay que mover junto si alguna vez se
migra: la base Postgres (local), la llave SSH de los nodos
(`SMTP_PROVISION_SSH_KEY_PATH`) y el workspace de inventario en `runtime/`
(`OPENCLAW_WORKSPACE_DIR`).

### Que se puede desplegar y que no

| Componente | Serverless (Vercel) | Por que |
|---|---|---|
| Admin panel (build estatico) | si | Es una SPA; solo necesita un gateway alcanzable |
| Gateway API | no | Estado en archivos, llave SSH, y proxy same-origin que inyecta tokens |
| Daemon del warmup | no | Proceso largo con intervalos de 90 min; una funcion efimera no lo sostiene |
| Agente monitor / medicion de cupo | no | Loops permanentes + SSH a 58 nodos + modelo local |
| Postgres | no | Hoy es local; iria a un Postgres administrado |

Desplegar solo el panel no sirve por si solo: sin un gateway alcanzable, la
pantalla queda vacia. Y **nada de esto arregla la suspension** — eso se resuelve
con un host encendido, no con serverless.

## Warmup (calentamiento de bandejas)

Motor autonomo que calienta la reputacion de dominios nuevos mandando correo real
a bandejas semilla y midiendo por IMAP donde cae. Diseno v1 en
`apps/warmup-engine/README.md`.

Tres procesos, gestionados por `scripts/warmup-servicios.sh`:

```bash
scripts/warmup-servicios.sh start|stop|restart|status [daemon|monitor|cupo]
```

- **daemon** (`apps/warmup-engine/src/service/live-warmup-daemon.ts`): corre las
  vueltas reales (envio -> medicion -> senal -> respuesta) y continua las
  conversaciones abiertas. Es el unico que manda correo.
- **monitor** (`scripts/ops/warmup-monitor.ts --loop`): el agente que mira cada
  10 min sobre el modelo local, reporta cuatro campos verificados contra los
  hechos, y ejecuta acciones que solo REDUCEN (frenar, pausar, anotar).
- **cupo** (`scripts/ops/limite-fisico.ts --status --cada=6`): remide el limite
  fisico instalado en cada nodo. Si se cae, la medicion vence a las 12 h y el
  motor decide sin saber el cupo — el `status` lo avisa.

Barreras, todas verificadas en cada vuelta: `WARMUP_LIVE_ENABLE` (default OFF),
kill-file (`runtime/warmup-live.kill`), tope diario de vueltas **de toda la
flota** (`WARMUP_LIVE_MAX_PER_DAY`), piso de placement, y el cap fisico de Postfix
por nodo, que es la unica pared que no depende de este codigo.

El volumen por dominio lo decide la evidencia
(`apps/warmup-engine/src/domain/decision-diaria.ts`): arranca chico, no se mueve
con menos de 4 mediciones, sube con la rampa lineal del diseno, **baja a la mitad
y sigue mandando** cuando el placement flojea, y frena cuando seguir profundiza el
pozo. `GET /v1/warmup/plan` sirve esa misma decision, no una reconstruccion.

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

Arranque canonico del gateway (carga `config/gateway.env`, que trae la llave de
cifrado de credenciales; el `npm run dev:gateway` pelado NO la carga):

```bash
bash scripts/delivrix-gateway-start.sh
```

El panel necesita el mismo entorno o su proxy no inyecta el token y la pantalla
queda vacia sin decir por que:

```bash
cd apps/admin-panel && node --env-file=../../config/gateway.env \
  ../../node_modules/.bin/vite --host 127.0.0.1 --port 5173
```

Warmup:

```bash
scripts/warmup-servicios.sh status     # cual vive, desde cuando, y si la medicion vencio
scripts/warmup-servicios.sh start
```

**Un proceso largo no se entera de un commit.** Despues de cambiar codigo del
daemon, del agente o del gateway hay que reiniciarlos, o siguen corriendo la
version que tenian en memoria.

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
