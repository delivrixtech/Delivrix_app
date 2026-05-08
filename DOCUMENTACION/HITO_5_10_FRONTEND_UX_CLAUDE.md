# Hito 5.10: Frontend UX profesional con Claude

Fecha: 2026-05-08

Estado: planificado.

Documentos rectores:

- `NORTE_OPERATIVO_DELIVRIX.md`
- `RESUMEN_RUTA_PROYECTO.md`
- `FRONTEND_UX_CONTRACT_GUIDE.md`
- `HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md`

## Objetivo

Usar a Claude como senior frontend owner para elevar el admin panel de Delivrix a una experiencia profesional, clara, usable y visualmente fuerte, sin romper contratos, arquitectura ni seguridad.

Este hito no cambia el norte del producto:

- Delivrix sigue siendo un control plane.
- OpenClaw sigue observando, proponiendo y esperando aprobacion humana.
- El panel sigue consumiendo contratos del Gateway.
- El MVP no envia correo real.
- El MVP no ejecuta infraestructura live.
- La UI sigue `GET-only` hasta que existan autenticacion, autorizacion, aprobacion humana, auditoria, dry-run y rollback.

## Division de responsabilidades

### Claude: senior frontend owner

Claude se usa para:

- UX/UI profesional del admin panel.
- Layout, navegacion, jerarquia visual y responsive.
- Componentizacion frontend.
- Mejora visual de Canvas, Hardware, Collector, Ruta, Clusters, Aprendizaje y Seguridad.
- Mejor lectura del onboarding, bloqueos, gates, evidencia, aprobaciones humanas y seguridad.
- Proponer visualizaciones graficas mas claras.
- Detectar deuda visual o experiencia confusa.
- Proponer contratos backend cuando falte informacion para una UI real.

Claude puede tocar:

- `apps/admin-panel/src/app/App.tsx`
- `apps/admin-panel/src/app/styles.css`
- componentes nuevos dentro de `apps/admin-panel/src/app/` o `apps/admin-panel/src/shared/`
- tests frontend cuando aplique
- documentacion frontend si su cambio introduce convenciones nuevas

Claude no debe tocar sin aprobacion de Codex:

- reglas de dominio;
- `packages/domain` salvo que proponga contrato y Codex lo implemente/revise;
- Gateway endpoints;
- stores locales;
- `runtime/`;
- secretos;
- infraestructura;
- scripts operativos;
- cualquier `POST`, `PUT`, `PATCH` o `DELETE` desde el admin panel.

### Codex: senior full stack, arquitectura y gatekeeper

Codex se usa para:

- arquitectura full stack;
- contratos Gateway/frontend;
- dominio y reglas de negocio;
- seguridad, compliance, auditoria y kill switch;
- validacion de que el panel siga contract-first;
- tests;
- documentacion oficial de hitos;
- Git/GitHub;
- revision final antes de subir o integrar cambios.

Codex puede tambien trabajar frontend, pero en este hito su rol principal es proteger el norte tecnico y revisar que el trabajo de Claude no introduzca hardcoding, mutaciones indebidas ni deuda de arquitectura.

## Repositorio y rama

Repositorio:

```txt
git@github.com:delivrixtech/Delivrix_app.git
```

Rama base actual:

```txt
main
```

Rama recomendada para Claude:

```txt
claude/hito-5-10-frontend-ux
```

Regla:

- Claude no debe trabajar directo sobre `main`.
- Si Claude implementa cambios, deben llegar como rama separada o diff revisable.
- Codex revisa, ejecuta validaciones, ajusta documentacion y decide si se integra.

## Reglas no negociables para Claude

- No hardcodear estado operativo.
- No inventar datos de hardware, clusters, OpenClaw, permisos, gates ni acciones.
- Todo estado debe venir de contratos del Gateway.
- No agregar `POST`, `PUT`, `PATCH` ni `DELETE` al admin panel.
- El panel sigue `GET-only`.
- No mover reglas de negocio al frontend.
- No leer `runtime/`.
- No tocar secretos.
- No implementar acciones reales.
- No conectar SSH, Proxmox, DNS, SMTP ni NFC.
- Si falta informacion para una UI, proponer contrato backend primero.

## Documentacion que Claude debe leer

Antes de proponer o implementar cambios:

1. `DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md`
2. `DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md`
3. `DOCUMENTACION/FRONTEND_UX_CONTRACT_GUIDE.md`
4. `DOCUMENTACION/HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md`
5. `DOCUMENTACION/HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md`
6. `DOCUMENTACION/HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md`

Archivos de codigo clave:

- `apps/admin-panel/src/app/App.tsx`
- `apps/admin-panel/src/app/styles.css`
- `apps/admin-panel/src/shared/api/client.ts`
- `apps/admin-panel/src/shared/api/read-boundary.ts`
- `packages/domain/src/admin-panel-workflow.ts`

## Prompt base para Claude

```txt
Actua como senior frontend engineer y product UX designer para Delivrix.

Objetivo:
Redisenar profesionalmente el admin panel frontend, manteniendo arquitectura contract-first y sin hardcoding operativo.

Repo:
git@github.com:delivrixtech/Delivrix_app.git

Rama base:
main

Crear rama:
claude/hito-5-10-frontend-ux

Contexto:
Delivrix es un control plane para preparar infraestructura propia de mailing autorizado con OpenClaw. El panel muestra onboarding, canvas operativo, hardware, collector, clusters, aprendizaje y seguridad. El MVP no envia correos reales ni ejecuta infraestructura live.

Reglas no negociables:
- No trabajar directo sobre main.
- No hardcodear estados, hardware, clusters, gates, permisos o datos operativos.
- Todo estado debe venir de contratos del Gateway.
- No agregar POST/PUT/PATCH/DELETE al admin panel.
- El panel sigue GET-only.
- No mover reglas de negocio al frontend.
- No leer runtime/.
- No tocar secretos.
- No implementar acciones reales.
- Si falta informacion para una UI, proponer contrato backend antes de inventarla.

Leer primero:
DOCUMENTACION/RESUMEN_RUTA_PROYECTO.md
DOCUMENTACION/NORTE_OPERATIVO_DELIVRIX.md
DOCUMENTACION/FRONTEND_UX_CONTRACT_GUIDE.md
DOCUMENTACION/HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md
DOCUMENTACION/HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md
DOCUMENTACION/HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md

Archivos frontend clave:
apps/admin-panel/src/app/App.tsx
apps/admin-panel/src/app/styles.css
apps/admin-panel/src/shared/api/client.ts
apps/admin-panel/src/shared/api/read-boundary.ts

Stack actual:
React + Vite + TypeScript
TanStack Query
React Flow
Lucide icons
CSS propio actual

Entregable:
- Mejorar UX/UI del admin panel.
- Crear componentes frontend reutilizables si hace falta.
- Mejorar Canvas, Hardware, Collector, Ruta, Clusters, Aprendizaje y Seguridad.
- Mejorar responsive.
- Mejorar jerarquia visual y lectura operativa.
- Mantener GET-only.
- Documentar brevemente los cambios o recomendaciones si encuentra necesidad de nuevos contratos.

Validacion:
npm --workspace @delivrix/admin-panel run check
```

## Flujo de trabajo recomendado

1. Claude lee documentacion y contratos.
2. Claude propone auditoria UX/UI por pantalla.
3. Claude implementa solo frontend en rama `claude/hito-5-10-frontend-ux`.
4. Codex revisa el diff.
5. Codex verifica que no haya hardcoding operativo ni mutaciones nuevas.
6. Codex corre validaciones.
7. Codex ajusta documentacion si cambia alguna convencion.
8. Codex sube o integra cambios.

## Validacion minima

Claude debe correr:

```txt
npm --workspace @delivrix/admin-panel run check
```

Codex debe correr antes de integrar:

```txt
node --test packages/domain/src/*.test.ts packages/adapters/src/*.test.ts
node --check apps/gateway-api/src/main.ts
npm --workspace @delivrix/admin-panel run check
git diff --check
```

Ademas, Codex debe revisar visualmente:

- desktop;
- mobile/tablet;
- que no haya solapes;
- que los estados `unknown`, `stale`, `needs_review`, `blocked`, `ready` se entiendan;
- que el panel siga `GET-only`;
- que no aparezcan acciones reales disfrazadas de UI.

## Criterio de cierre

Hito 5.10 queda listo cuando:

- Claude entrega un frontend mas claro y profesional;
- el panel sigue contract-first;
- no hay datos operativos hardcodeados;
- no hay nuevas mutaciones desde UI;
- la navegacion y jerarquia visual son mejores;
- las pantallas principales son entendibles para operador humano;
- Codex valida y documenta el resultado.
