# Arquitectura: Delivrix QA Senior (auditor automático de PR y deploys)

Autor: JECT. Estado: implementación inicial lista y verificada (33/33 tests
nativos en verde). Repositorio base: `delivrixtech/Delivrix_app`.

---

## 1. Resumen ejecutivo

Sistema que audita automáticamente cada Pull Request y cada despliegue del repo
mediante un agente de QA senior. Un agente **orquestador** ("QA Senior") coordina
**3 subagentes especializados**, cada uno revisa una dimensión distinta del
cambio, y el sistema produce un reporte con hallazgos, severidad, evidencia y
recomendaciones accionables, publicado como comentario del Pull Request y como
*check run*.

Decisiones de diseño confirmadas con el CTO antes de implementar:

- **Runtime: GitHub Actions.** No hay servidor que hostear ni endpoint público
  que asegurar; los secretos son nativos del repo/organización.
- **Modelo: API de Anthropic directa** (`claude-sonnet-4-6` por defecto,
  configurable). Aislada del presupuesto Bedrock de mailops.
- **Alcance v1: PR + deploy real** (eventos `pull_request`, `deployment` y
  `push` a `produ`).
- **Entregable: diseño + código ejecutable.** Lo que describe este documento ya
  está construido en `tools/qa-auditor/` y `.github/workflows/qa-audit.yml`,
  con cero dependencias de runtime (Node 24 + `fetch` nativo) y suite de tests.

El sistema se alinea con el ADN del repo descrito en `AGENTS.md`: módulos con
contratos estables y adaptadores reemplazables, seguridad y auditabilidad en el
camino principal, *kill-switch*, postura *dry-run* y *fail-open* ante problemas
de infraestructura.

---

## 2. Enfoque y supuestos

### Enfoque

El "agente QA Senior" es el **orquestador** (`orchestrator.ts`): no razona él
mismo sobre el código, sino que reparte el trabajo a tres subagentes, agrega y
normaliza sus hallazgos, calcula el veredicto y arma el reporte. Cada subagente
es una **invocación aislada** al modelo con su *system prompt* especializado y
**salida estructurada forzada** vía `tool_use` (en vez de parsear texto). Los
tres corren en paralelo.

Se eligió GitHub Actions sobre un servicio persistente porque reduce superficie:
sin hosting, sin endpoint de webhook que firmar y rotar, sin proceso que vigilar;
GitHub dispara el workflow internamente y entrega el token con permisos mínimos.

### Supuestos importantes

1. **Repositorio privado de la organización.** Los PR de *fork* son poco
   probables; aun así el diseño es seguro ante ellos (ver sección 10): los forks
   corren sin secretos y la auditoría se omite con elegancia.
2. **El despliegue se audita estáticamente desde el diff** del commit desplegado
   (migraciones, configuración, variables, rollback). No se inspecciona el
   entorno de ejecución en vivo; eso sería una fase posterior.
3. **El veredicto es *advisory*.** El auditor nunca aprueba ni mergea. Puede,
   opcionalmente, marcar un *check* en `failure` para que *branch protection*
   exija intervención humana, pero la decisión de mergear/desplegar es de una
   persona.
4. **La GitHub App es opcional.** v1 funciona con el `GITHUB_TOKEN` del workflow
   (cero registro). La GitHub App aporta identidad de bot e instalación
   multi-repo y se documenta como camino de producción.
5. **Presupuesto de tokens acotado.** El contexto enviado al modelo se limita
   (máximo de archivos, bytes de diff, truncado de lockfiles/binarios) para
   controlar costo y latencia.

---

## 3. Entregable 1 - Diseño del MCP/Connector

En el runtime de GitHub Actions, el "connector" no es un servidor MCP separado,
sino un **adaptador delgado de GitHub** (`github/client.ts`) más el **cliente de
Anthropic** (`anthropic/client.ts`), ambos sobre `fetch` nativo. El "agente" es
el orquestador. Esto evita correr un proceso MCP adicional: el *loop* de uso de
herramientas lo provee la propia Messages API de Anthropic.

Componentes y responsabilidad única:

```
Evento GitHub
    |
    v
[event.ts]  parsea PR / deployment / push  -> AuditTarget normalizado
    |
    v
[collect.ts + budget.ts]  consulta a GitHub lo mínimo y acota el diff -> AuditContext
    |
    v
[orchestrator.ts] "QA Senior"
    |-> [subagents/run.ts] Calidad de Codigo  --\
    |-> [subagents/run.ts] Seguridad/Compliance --> (Anthropic, tool_use forzado)
    |-> [subagents/run.ts] QA Funcional/Deploy --/
    |
    v
agrega + dedupe + veredicto (verdict.ts) + render (render.ts)
    |
    v
[github/client.ts] comentario idempotente del PR + check run + artefacto JSON
```

Decisión deliberada: el "cerebro" de auditoría (`subagents/` + `report/`) no
depende de Actions ni de GitHub. Si más adelante se quiere invocar la misma
lógica desde OpenClaw o desde Claude Desktop, se puede envolver `orchestrator.ts`
en un **servidor MCP** exponiendo una herramienta `audit_pull_request` sin
reescribir la lógica. El connector de Actions y un eventual servidor MCP
comparten el núcleo.

---

## 4. Entregable 2 - Flujo completo del webhook

### Flujo en GitHub Actions (v1)

1. Ocurre un evento: PR `opened/synchronize/reopened/ready_for_review`,
   `deployment`, o `push` a `produ`.
2. GitHub evalúa el `workflow` `qa-audit.yml`. El job sólo corre si
   `vars.QA_AUDITOR_ENABLED != 'false'` (kill-switch).
3. `actions/checkout` trae el auditor **desde la rama base** (no el HEAD del PR):
   un PR no puede modificar el propio auditor para exfiltrar secretos.
4. `actions/setup-node` instala Node 24 (necesario para *type-stripping*).
5. Opcional: si existen `QA_APP_ID` + `QA_APP_PRIVATE_KEY`, se acuña un token de
   instalación de la GitHub App (`actions/create-github-app-token`). Si no, se
   usa el `GITHUB_TOKEN` del job.
6. `node tools/qa-auditor/src/main.ts`: lee el evento desde `GITHUB_EVENT_PATH`,
   recolecta el contexto, corre los 3 subagentes, arma el reporte y publica
   (comentario + check run + *step summary*). Escribe `qa-audit-report.json`.
7. `actions/upload-artifact` guarda el reporte como artefacto del run.

**Forks (defensa):** con el evento `pull_request`, GitHub **no** entrega los
secretos del repo a workflows disparados por forks. El auditor detecta la
ausencia de `ANTHROPIC_API_KEY`, registra `anthropic_key_ausente` y termina en 0
sin auditar. Nunca se usa `pull_request_target`, que sí expondría secretos a
código no confiable.

### Alternativa: GitHub App como servicio (con HMAC)

Si en el futuro se corre la GitHub App como **servicio** fuera de Actions (por
ejemplo embebida en `apps/gateway-api`), el contrato del webhook entrante es:

- Endpoint `POST /webhooks/github`.
- Verificar la cabecera `X-Hub-Signature-256: sha256=<hmac>` calculando
  `HMAC-SHA256(webhook_secret, rawBody)` y comparando en **tiempo constante**.
  Esto reutiliza exactamente el patrón ya existente en el repo
  (`apps/gateway-api/src/security/hmac.ts`, `timingSafeEqual`).
- Responder `2xx` de inmediato y procesar la auditoría de forma asíncrona
  (encolar) para no exceder el timeout del webhook.
- Validar `X-GitHub-Event` y el `delivery id` para idempotencia.

En el runtime de Actions este paso **no aplica** (no hay endpoint público:
GitHub dispara el workflow internamente), por eso v1 no necesita HMAC. La sección
se incluye para cubrir el requisito de "seguridad del webhook" en el camino de
servicio.

---

## 5. Entregable 3 - Permisos de la GitHub App

Principio de **mínimo privilegio**: sólo lo necesario para leer el cambio y
publicar el reporte.

| Permiso (repository) | Nivel | Por qué |
| --- | --- | --- |
| Contents | Read-only | Leer el diff del PR, los archivos cambiados y el commit desplegado. |
| Pull requests | Read & write | Leer metadata del PR y publicar/actualizar el comentario del reporte. |
| Checks | Read & write | Crear el *check run* con el veredicto (gateable por branch protection). |
| Deployments | Read-only | Auditar despliegues (evento `deployment`). |
| Metadata | Read-only | Obligatorio por defecto en toda GitHub App. |

Eventos a suscribir (webhook de la App): **Pull request**, **Deployment**,
**Deployment status**, **Push**.

No se solicita ningún permiso de organización, miembros, administración, ni
escritura de contenidos. La App no puede empujar código, cambiar settings ni
aprobar PRs.

**Equivalente con el `GITHUB_TOKEN` del workflow** (camino sin App), ya
declarado en `qa-audit.yml`:

```yaml
permissions:
  contents: read
  pull-requests: write
  checks: write
```

Recomendación: para un solo repo y arranque rápido, el `GITHUB_TOKEN` basta.
Para identidad de bot propia (comentarios como "Delivrix QA Senior") o
instalación en varios repos de la organización, registrar la GitHub App y cargar
`QA_APP_ID` + `QA_APP_PRIVATE_KEY` como secretos.

---

## 6. Entregable 4 - Estructura de archivos

```
.github/
  workflows/
    qa-audit.yml              workflow: triggers, permisos mínimos, kill-switch, pasos

tools/qa-auditor/             paquete aislado (fuera de workspaces; cero deps runtime)
  package.json
  tsconfig.json
  README.md
  src/
    main.ts                   entrypoint: config -> evento -> contexto -> audit -> publicar
    config.ts                 env, kill-switch, presupuestos, umbral failOn
    logging.ts                log JSON con redacción de secretos
    github/
      event.ts                parseo de PR / deployment / push -> AuditTarget
      event.test.ts
      client.ts               REST de GitHub (fetch), upsert de comentario, check run, retries
      client.test.ts
    anthropic/
      client.ts               Messages API con tool_use forzado (JSON estructurado), retries
      client.test.ts
    context/
      budget.ts               clasifica archivos y acota el diff por presupuesto
      budget.test.ts
      collect.ts              arma el AuditContext que ven los subagentes
    subagents/
      schema.ts               contrato de Finding + normalización defensiva
      schema.test.ts
      prompts.ts              system prompts de los 3 subagentes (anti prompt-injection)
      run.ts                  runner: corre los subagentes en paralelo
    orchestrator.ts           agrega, dedupe, veredicto, arma el reporte
    orchestrator.test.ts
    report/
      verdict.ts              severidad -> veredicto -> conclusión del check
      verdict.test.ts
      render.ts               reporte Markdown + marcador del comentario
      render.test.ts

DOCUMENTACION/QA_AUDITOR/
  ARQUITECTURA.md             este documento
```

Convenciones respetadas del repo: ESM con extensiones `.ts` explícitas en los
imports, *type-stripping* de Node 24 (sin paso de build), tests nativos
`node:test`, TypeScript erasable (sin `enum`), y código/prompts en ASCII puro
(sin emojis ni tildes; las tildes se reservan para docs formales como éste).

---

## 7. Entregable 5 - Implementación (estado actual)

Construido y verificado en esta entrega:

- Workflow `qa-audit.yml` con los 3 triggers, permisos mínimos y kill-switch.
- 16 módulos de `src` + 8 archivos de test. **33/33 tests nativos en verde.**
- `main.ts` validado de extremo a extremo en los caminos de salida temprana
  (kill-switch y *fail-open* sin API key) con eventos reales simulados.

Cómo corre (dry-run local, no publica nada):

```bash
export GITHUB_REPOSITORY=delivrixtech/Delivrix_app
export GITHUB_TOKEN=...            # token con read del repo
export ANTHROPIC_API_KEY=...
export GITHUB_EVENT_NAME=pull_request
export GITHUB_EVENT_PATH=/ruta/evento.json
node tools/qa-auditor/src/main.ts --dry-run
```

Configuración (variables de entorno / *Actions variables*):

| Variable | Default | Función |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (secreto) | Clave de la API. Sin ella se omite la auditoría. |
| `QA_AUDITOR_ENABLED` | `true` | Kill-switch. `false` apaga el job. |
| `QA_MODEL` | `claude-sonnet-4-6` | Modelo de los subagentes. |
| `QA_FAIL_ON` | `blocker` | Severidad mínima para `check = failure`. |
| `QA_EXIT_ON_FAIL` | `false` | Si `true`, el job falla cuando el check sería failure. |
| `QA_MAX_FILES` | `60` | Tope de archivos cambiados a considerar. |
| `QA_MAX_DIFF_BYTES` | `240000` | Tope global de bytes de diff enviados al modelo. |
| `QA_MAX_FILE_PATCH_BYTES` | `24000` | Tope por archivo. |
| `QA_POST_COMMENT` / `QA_CREATE_CHECK_RUN` | `true` | Toggles de publicación. |

Pendiente / siguientes fases: registrar la GitHub App (si se opta por ella),
*golden fixtures* de reportes, comparación `base...head` para auditar el rango
completo de un despliegue, y el envoltorio de servidor MCP opcional.

---

## 8. Entregable 6 - Formato del reporte de auditoría

**Severidad** (5 niveles): `blocker`, `high`, `medium`, `low`, `info`.
`blocker` se reserva para algo que no debe llegar a producción.

**Veredicto** derivado: `blocked` (hay blockers), `attention` (hay high/medium),
`clean` (sólo low/info o nada).

**Conclusión del check**: `failure` cuando el hallazgo más grave es al menos tan
severo como `QA_FAIL_ON`; si no, `neutral`/`success`. Así *branch protection*
puede exigir el check sin que el auditor decida el merge.

El comentario del PR (idempotente: se actualiza en cada *synchronize* por un
marcador HTML oculto `<!-- delivrix-qa-auditor -->`) tiene esta forma:

~~~text
## Delivrix QA Senior - Auditoria automatica

Objetivo: PR #42 (pull_request)
Veredicto: BLOCKED (hay bloqueantes)
Severidad: blocker 1 - high 0 - medium 2 - low 1 - info 0
Cobertura: 12/12 archivos en el diff
Motor: claude-sonnet-4-6 - subagentes 3/3 OK

### Resumen por dimension
| Dimension | Estado | Hallazgos | Resumen |
| --- | --- | --- | --- |
| Seguridad y Compliance | OK | 1 | ... |
| QA Funcional y Deploy  | OK | 2 | ... |
| Calidad de Codigo      | OK | 1 | ... |

### Hallazgos
#### 1. [BLOCKER] API key hardcodeada
Dimension: Seguridad y Compliance - Categoria: secret-exposure - Confianza: high
Evidencia: `src/secrets.ts` (lineas 3-3)
<detalle: que es y por que importa antes de produccion>
Recomendacion: Mover a variable de entorno y rotar la clave.
  [snippet diff] const KEY = 'sk-...'
...
---
Este reporte es advisory. La decision de mergear o desplegar es humana.
~~~

Salidas paralelas para máquinas y trazabilidad:

- `qa-audit-report.json`: veredicto, conteos, hallazgos y resumen por dimensión
  (artefacto del run, consumible por dashboards).
- *Check run* "Delivrix QA Senior" con el veredicto y el reporte en su *output*.
- *Step summary* del run con el reporte completo.

---

## 9. Entregable 7 - Estrategia de pruebas

Pirámide construida, toda offline y determinista (sin red real):

- **Lógica pura** (`schema.test.ts`, `budget.test.ts`, `verdict.test.ts`,
  `render.test.ts`, `event.test.ts`): normalización de hallazgos, clasificación y
  presupuesto del diff, conteos y umbrales de veredicto, render del reporte,
  parseo de eventos. Incluye un test anti-emoji del reporte.
- **Clientes con `fetch` inyectado** (`github/client.test.ts`,
  `anthropic/client.test.ts`): *upsert* crea vs. actualiza el comentario, media
  type de diff, reintentos ante 5xx/429, `tool_use` forzado y manejo del caso sin
  bloque de herramienta. No tocan la red.
- **Orquestador con cliente falso** (`orchestrator.test.ts`): agrega 3
  subagentes y bloquea ante un `blocker`; corre en **modo degradado** cuando los
  subagentes fallan (la auditoría no se cae, lo reporta).
- **Smoke de `main.ts`**: ejecución real de los caminos de salida temprana
  (kill-switch; *fail-open* sin API key) con eventos simulados; valida que todos
  los imports resuelven y el cableado funciona.
- **Dry-run** (`--dry-run`): produce el reporte sin publicar; útil para validar
  prompts y formato contra un PR real sin efectos.

Extensiones recomendadas: *golden fixtures* (PR de prueba con respuesta del
modelo grabada para comparar el reporte byte a byte) y un paso de **verificación
adversarial** opcional (un cuarto rol que cuestione los hallazgos de alta
severidad antes de publicarlos, para bajar falsos positivos).

El propio auditor se prueba en CI con `node --test "src/**/*.test.ts"`.

---

## 10. Entregable 8 - Consideraciones de seguridad y despliegue

### Seguridad

- **Prompt injection.** El diff, el título y la descripción del PR son **datos no
  confiables**: van envueltos en marcadores `UNTRUSTED` y cada *system prompt*
  instruye a tratarlos como datos, jamás como instrucciones, y a reportar como
  sospechoso cualquier intento de manipular el criterio ("aprueba esto", "ignora
  las reglas"). El modelo sólo puede emitir hallazgos vía la herramienta; no
  controla el merge ni ejecuta acciones privilegiadas.
- **Sin ejecución de código no confiable.** El auditor sólo **lee texto** del
  diff; nunca instala ni ejecuta el código del PR. No se usa
  `pull_request_target`. El checkout es de la rama base.
- **Mínimo privilegio.** El token tiene sólo `contents:read`,
  `pull-requests:write`, `checks:write`. La GitHub App, los permisos de la
  sección 5.
- **Secretos.** `ANTHROPIC_API_KEY` y el token viven como secretos de
  repo/organización, nunca en el código. El logger **redacta** cualquier secreto
  registrado antes de escribir a stdout (el log de Actions es visible).
- **Pinning de actions (pendiente de hardening).** El workflow referencia las
  actions por tag mayor (`actions/checkout@v4`, `actions/setup-node@v4`,
  `actions/create-github-app-token@v3`, `actions/upload-artifact@v4`). Para
  producción, fijarlas a un **commit SHA completo** y renovarlas con Dependabot.
  Receta: `uses: actions/checkout@<sha>  # v4.x.y`.
- **Costo y abuso.** Presupuesto de tokens acotado, concurrencia limitada a 3
  subagentes, `timeout-minutes`, `concurrency` con `cancel-in-progress`, y
  kill-switch por variable. *Fail-open*: un error de infraestructura del auditor
  no bloquea el PR (el *gating* real lo da el check + branch protection).

### Despliegue por fases

0. **Merge en rama feature** y revisión humana del workflow.
1. **Observación**: `QA_FAIL_ON=blocker`, `QA_EXIT_ON_FAIL=false`. El bot sólo
   comenta y crea un check no bloqueante. Calibrar ruido durante unos días.
2. **Gating suave**: branch protection marca el check "Delivrix QA Senior" como
   requerido. Los blockers exigen intervención humana, pero se pueden *override*.
3. **Gating duro** (opcional): `QA_EXIT_ON_FAIL=true` para que el job falle ante
   blockers, o bajar `QA_FAIL_ON` a `high` según confianza.

Rollback inmediato: poner `QA_AUDITOR_ENABLED=false` (variable de repo) apaga
todo sin tocar código.

---

## 11. Roadmap

- *Golden fixtures* y métricas de hallazgos (tasa de falsos positivos por
  dimensión) para afinar prompts.
- GitHub App registrada para identidad de bot e instalación multi-repo.
- Auditoría de despliegue por rango `base...head` (no sólo el commit tip).
- Paso de verificación adversarial antes de publicar high/blocker.
- Envoltura como servidor MCP para invocar la misma auditoría desde OpenClaw.

---

## 12. Decisiones abiertas para el CTO

1. **GitHub App vs `GITHUB_TOKEN`**: ¿identidad de bot propia (App) o arranque
   rápido con el token del workflow?
2. **Umbral de gating**: ¿`QA_FAIL_ON=blocker` advisory, o gatear con branch
   protection / `QA_EXIT_ON_FAIL`?
3. **Modelo**: ¿Sonnet por costo en los tres subagentes, u Opus para una síntesis
   final más exigente?
4. **Verificación adversarial**: ¿se agrega el cuarto rol que cuestiona los
   hallazgos de alta severidad antes de comentar?
