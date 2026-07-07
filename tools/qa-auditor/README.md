# Delivrix QA Senior - Auditor automatico de PR y deploys

Agente de QA que audita cada Pull Request y cada despliegue del repo. Un agente
orquestador ("QA Senior") coordina 3 subagentes especializados, agrega los
hallazgos y publica un reporte como comentario del PR + check run.

Corre en GitHub Actions. Llama a la API de Anthropic directamente. Cero
dependencias en runtime (solo Node 24 + fetch nativo).

Diseno completo: `DOCUMENTACION/QA_AUDITOR/ARQUITECTURA.md`.

## Subagentes

- Calidad de Codigo: bugs, regresiones, deuda tecnica, duplicacion, legibilidad.
- Seguridad y Compliance: secretos, validacion, inyeccion, permisos, dependencias.
- QA Funcional y Deploy: pruebas faltantes, migraciones, rollback, config, deploy.

## Requisitos

- Node >= 24 (type-stripping nativo: se ejecuta `.ts` sin build).

## Configuracion (en GitHub: Settings -> Secrets and variables -> Actions)

Secrets:

- `ANTHROPIC_API_KEY` (obligatorio): clave de la API de Anthropic.
- `QA_APP_ID`, `QA_APP_PRIVATE_KEY` (opcional): credenciales de la GitHub App
  para que el bot comente con identidad propia. Si faltan, se usa el
  `GITHUB_TOKEN` del workflow.

Variables (opcionales, con default):

- `QA_AUDITOR_ENABLED` (`true`): kill-switch. Poner `false` apaga el job.
- `QA_MODEL` (`claude-sonnet-4-6`): modelo de los subagentes.
- `QA_FAIL_ON` (`blocker`): umbral para marcar el check como failure.
- `QA_EXIT_ON_FAIL` (`false`): si `true`, el job falla cuando el check seria failure.
- `QA_MAX_FILES` (`60`), `QA_MAX_DIFF_BYTES` (`240000`): presupuesto de contexto.

## Correr en local (dry-run, no publica nada)

```bash
export GITHUB_REPOSITORY=delivrixtech/Delivrix_app
export GITHUB_TOKEN=...          # token con read del repo
export ANTHROPIC_API_KEY=...
export GITHUB_EVENT_NAME=pull_request
export GITHUB_EVENT_PATH=/ruta/al/evento.json   # payload de PR de GitHub
node tools/qa-auditor/src/main.ts --dry-run
```

En dry-run se imprime el reporte y se escribe `qa-audit-report.md` /
`qa-audit-report.json`, pero no se comenta el PR ni se crea check run.

## Tests

```bash
cd tools/qa-auditor && npm test
# o: node --test "src/**/*.test.ts"
```

## Estructura

```
tools/qa-auditor/
  src/
    main.ts                entrypoint (config -> evento -> contexto -> audit -> publicar)
    config.ts              lee env, kill-switch, presupuestos, umbrales
    logging.ts             log JSON con redaccion de secretos
    github/
      event.ts             parseo de PR / deployment / push
      client.ts            REST de GitHub (fetch nativo), upsert de comentario, check run
    anthropic/
      client.ts            Messages API con tool_use forzado (JSON estructurado)
    context/
      budget.ts            clasifica archivos y acota el diff
      collect.ts           arma el contexto que ven los subagentes
    subagents/
      schema.ts            contrato de findings + normalizacion
      prompts.ts           system prompts de los 3 subagentes (anti prompt-injection)
      run.ts               runner: corre los subagentes en paralelo
    orchestrator.ts        agrega, dedupe, veredicto, arma el reporte
    report/
      verdict.ts           severidad -> veredicto -> conclusion del check
      render.ts            reporte Markdown + marcador de comentario
```

## Seguridad (resumen)

No usa `pull_request_target`. Los PR de fork corren sin secretos (no se expone
la API key) y el auditor solo LEE texto del diff (nunca ejecuta el codigo del
PR). El checkout usa la rama base, asi un PR no puede alterar el propio auditor.
Permisos minimos del token. El contenido del PR se trata como dato no confiable.
Detalle en el documento de arquitectura.
