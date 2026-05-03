# Hito 5.2: Demo OpenClaw con incidente simulado

Fecha: 2026-05-03

Propiedad: Delivrix LLC.
Desarrollado por JECT.

Documento rector: `NORTE_OPERATIVO_DELIVRIX.md`.
Documento de fase: `FASE_5_MVP_DEMOSTRABLE.md`.
Hito anterior: `HITO_5_1_DEMO_RUNNER_LOCAL.md`.

## Objetivo

Demostrar que OpenClaw actua como operador inteligente y supervisado cuando aparece un incidente de reputacion simulado.

El hito usa la ruta del Hito 5.1, pero fuerza un resultado `bounce`, `complaint`, `deferred` o `failed`. Luego OpenClaw:

- observa el resultado simulado;
- clasifica el riesgo;
- propone una accion local;
- valida permisos del runbook;
- demuestra que sin humano no actua;
- demuestra que el kill switch bloquea;
- aplica solo estado local si existe aprobacion humana.

No se envia correo real, no se abre SMTP, no se toca Proxmox, no se abre SSH, no se cambia DNS y no se escribe en NFC.

## Cambios implementados

### 1. Dominio de incidente OpenClaw

Archivo:

- `packages/domain/src/openclaw-incident-demo.ts`

Expone:

- `buildOpenClawIncidentDemoReport`

El reporte contiene:

- deteccion del incidente;
- propuesta `alert-ops`;
- decision sin aprobacion humana;
- decision con aprobacion humana;
- decision con kill switch activo;
- accion local aplicada o pendiente;
- gates y safety.

### 2. Endpoint Gateway

Endpoint nuevo:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/demo/openclaw/incident \
  -H 'content-type: application/json' \
  -d '{"actorId":"operator_local","incidentStatus":"complaint"}'
```

Campos relevantes:

| Campo | Uso |
| --- | --- |
| `incidentStatus` | `bounce`, `complaint`, `deferred` o `failed`; por defecto `complaint` |
| `humanApproved` | si es `false`, OpenClaw propone pero no aplica |
| `applyLocalAction` | si es `false`, deja la accion como pendiente |

Flujo:

1. Ejecuta una demo local con resultado simulado de incidente.
2. Evalua health/reputation del sender node usado por la demo.
3. OpenClaw `alert-ops` detecta el incidente.
4. Propone `quarantine_local_sender_node` para `complaint`/critico.
5. Propone `degrade_local_sender_node` para incidentes no criticos.
6. Runbook bloquea la accion sin humano.
7. Runbook permite la accion con humano si kill switch esta inactivo.
8. Runbook demuestra que kill switch activo bloquea.
9. Gateway aplica solo cambio local de estado cuando procede.

## Decision del hito

Estados posibles:

| Estado | Significado |
| --- | --- |
| `completed` | OpenClaw detecto, propuso, valido permisos, probo kill switch y aplico solo estado local |
| `needs_review` | OpenClaw detecto y propuso, pero falta aprobacion o aplicacion local |
| `blocked` | no hubo incidente, el runbook bloqueo, el kill switch esta activo o el resultado no fue simulado |

Aunque sea `completed`, el reporte mantiene:

- `canSendRealEmail: false`;
- `canMutateLiveInfrastructure: false`;
- `sideEffects: local-state-only`.

## Frontera de responsabilidades

| Pregunta | Respuesta |
| --- | --- |
| Quien detecta? | OpenClaw `alert-ops` sobre resultados simulados |
| Quien decide permisos? | Runbook de OpenClaw |
| Quien aprueba? | Operador humano |
| Que accion se aplica? | Solo estado local del sender node |
| Que queda prohibido? | SMTP real, infraestructura live, SSH, DNS live y NFC production writes |
| Como se demuestra seguridad? | decisiones sin humano y con kill switch activo quedan bloqueadas |

## Gates

- Incidente debe ser simulado.
- OpenClaw observa antes de proponer.
- `alert-ops` propone solo accion local.
- Runbook evalua permiso antes de actuar.
- Humano aprueba antes de accion supervisada.
- Kill switch bloquea accion supervisada.
- Auditoria en deteccion, propuesta, permiso y accion.
- Sin email real.
- Sin infraestructura live.
- Sin NFC production write.

## Criterio de salida

Hito 5.2 queda cerrado si:

- existe dominio `openclaw-incident-demo`;
- existe endpoint `POST /v1/demo/openclaw/incident`;
- una `complaint` simulada genera propuesta de cuarentena local;
- sin humano la accion no se aplica;
- con humano y kill switch inactivo la accion local se aplica;
- con kill switch activo la accion queda bloqueada;
- auditoria enlaza demo, incidente y accion;
- las pruebas pasan.

## Pruebas

Comando:

```bash
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
```

Resultado esperado:

- pruebas de dominio y adaptadores pasando;
- endpoint `POST /v1/demo/openclaw/incident` respondiendo `decision.status: completed` para `complaint` con aprobacion humana;
- `canSendRealEmail: false`.

## Que sigue

Hito 5.3: Demo report final. Detalle en `HITO_5_3_DEMO_REPORT_FINAL.md`.

Ese hito debe empaquetar la evidencia de 5.0, 5.1 y 5.2 en un reporte ejecutivo para sponsor: que se vio, que quedo probado, que sigue bloqueado y cual es la ruta segura hacia una produccion limitada futura.
