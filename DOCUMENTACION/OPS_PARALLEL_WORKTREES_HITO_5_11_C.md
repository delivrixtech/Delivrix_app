# OPS — Orquestación 3 worktrees paralelos Hito 5.11.C

**Fecha:** 2026-05-20
**Ejecutor:** Codex (en 3 sesiones CLI simultáneas)
**Decisor humano:** Juanes (operador)
**Objetivo:** ejecutar los 3 frentes restantes del 5.11.C en paralelo para acortar tiempo total de ~16-20 hrs secuencial a ~8-10 hrs en paralelo.

## 1. Los 3 frentes

| Worktree | Branch | OPS | Esfuerzo | Riesgo merge |
|---|---|---|---|---|
| **A** | `feature/chat-live-openclaw` | `OPS_OPENCLAW_CHAT_LIVE.md` | ~6-8 hrs | Bajo (carpeta nueva chat/ + 2 endpoints nuevos gateway) |
| **B** | `feature/panel-tokenization-cleanup` | `OPS_PANEL_TOKENIZATION_CLEANUP.md` | ~6-8 hrs | Alto (toca 8 features index.tsx) |
| **C** | `feature/cleanup-fallbacks` | `OPS_PANEL_CLEANUP_FALLBACKS.md` | ~2-3 hrs | Medio (toca learning + onboarding + safety index.tsx) |

## 2. Análisis de overlap de archivos

| Archivo | Worktree A | Worktree B | Worktree C |
|---|---|---|---|
| `apps/gateway-api/src/main.ts` | ✏️ (2 endpoints nuevos) | — | — |
| `apps/admin-panel/src/App.tsx` | ✏️ (toggle chat) | ✏️ (38 hex) | — |
| `apps/admin-panel/src/features/learning/index.tsx` | — | ✏️ (98 hex) | ✏️ (SKILLS_FALLBACK) |
| `apps/admin-panel/src/features/onboarding/index.tsx` | — | ✏️ (57 hex) | ✏️ (ONBOARDING_STEPS_FALLBACK) |
| `apps/admin-panel/src/features/safety/index.tsx` | — | ✏️ (117 hex) | ✏️ (AUDIT_ROWS_FALLBACK) |
| `apps/admin-panel/src/features/{canvas,clusters,collector,hardware,overview}/index.tsx` | — | ✏️ | — |
| `apps/admin-panel/src/features/chat/` (nueva) | ✏️ (crear) | — | — |
| `apps/admin-panel/src/shared/api/chat-client.ts` (nuevo) | ✏️ (crear) | — | — |
| `tailwind.config.ts` | — | ✏️ (si falta tokens) | — |

**Conflictos críticos:** B y C ambos modifican `learning`, `onboarding`, `safety` index.tsx. Sin orden controlado de merge, los cambios de B (hex → tokens) sobre las líneas que C modificó (los _FALLBACK arrays) van a chocar.

## 3. Orden de merge recomendado

```
1. C → main   (cleanup-fallbacks, primero porque más rápido y deja learning/onboarding/safety en su forma final)
2. A → main   (chat-live, independiente principalmente)
3. B → main   (tokenization cleanup, rebasea sobre A+C y aplica hex→tokens a la versión final de los 3 features)
```

Razones:
- **C primero:** ~2-3 hrs, deja los 3 features sin _FALLBACK. B después aplica solo el cleanup de hex.
- **A segundo:** carpeta nueva chat/ no choca con B. App.tsx tendrá +toggle (A) y +tokens (B); merge limpio si A va primero porque la línea del toggle es nueva.
- **B último:** rebasea sobre los 2 anteriores y aplica el cleanup hex sobre el árbol ya final. Codex de B debe pull antes de cada commit.

## 4. Setup de worktrees

```bash
# Desde el repo raíz, después de git pull origin main
cd "/Users/juanescanar/Documents/delivrix app"

git worktree add .claude/worktrees/chat-live -b feature/chat-live-openclaw
git worktree add .claude/worktrees/tokenization -b feature/panel-tokenization-cleanup
git worktree add .claude/worktrees/cleanup-fallbacks -b feature/cleanup-fallbacks

# Verificar
git worktree list
# Esperado: main + 3 worktrees nuevos
```

Cada Codex CLI session apunta a uno:
- Sesión 1: `cd .claude/worktrees/chat-live` + lee OPS_OPENCLAW_CHAT_LIVE.md
- Sesión 2: `cd .claude/worktrees/tokenization` + lee OPS_PANEL_TOKENIZATION_CLEANUP.md
- Sesión 3: `cd .claude/worktrees/cleanup-fallbacks` + lee OPS_PANEL_CLEANUP_FALLBACKS.md

## 5. Coordinación de audit chain

⚠️ **Crítico:** los 3 worktrees comparten el mismo audit chain (`.audit/audit-events.jsonl`). Si los 3 corren tests/gateway local simultáneo, hay race condition.

Soluciones:
- **Solución A (recomendada):** los 3 worktrees apuntan al mismo `.audit/` real. Los tests usan audit temporal en `/private/tmp/` (patrón ya usado por Codex en Ola 2). Solo el push de A y la verificación final pueden tocar el `.audit/` oficial.
- **Solución B:** cada worktree tiene su propio `.audit/audit-events.jsonl` independiente, se reconcilian al merge. Más complejo pero más aislado.

**Recomendación: A.** Codex ya implementó el patrón temp en Ola 2.

## 6. Merge protocol

Después de cada worktree completo:

```bash
# Codex (en el worktree completado)
git push origin <branch>

# Coordinator (Juanes o Codex en main)
cd /path/to/main
git pull origin main
git merge --ff-only origin/<branch>  # debería ser fast-forward si el orden se respetó
# Si NO es ff-only → conflicto. Resolver merge manual, smoke test, commit.
node --experimental-strip-types scripts/audit/verify-chain.ts  # debe seguir verde
git push origin main

# Borrar worktree completado
git worktree remove .claude/worktrees/<name>
git branch -d feature/<name>
```

## 7. Punto de retorno

Antes de empezar:
```bash
git tag pre-parallel-hito-5-11-c
git push --tags
```

Si algún worktree va mal: `git checkout main && git reset --hard pre-parallel-hito-5-11-c` (NO force push) + recrear el worktree con el OPS revisado.

## 8. Reporte final esperado

Tras los 3 merges:

```
HITO 5.11.C — 3 WORKTREES PARALELOS COMPLETADO

merge order: C → A → B
commits totales: ~15-20 entre los 3 frentes
tests finales: N/N verdes (npm test + npm run test:admin + playwright)
verify-chain: events_total=N, chain_ok=N, OK
build vite: OK
visual smoke: 8 features tokenizadas + 0 _FALLBACK activos + chat live funcional

next action: operator review final (visual panel + chat real con OpenClaw)
```

## 9. Restricciones

- **No** mergear B antes que C (chocan en learning/onboarding/safety).
- **No** intentar merge concurrente — uno a la vez con orden controlado.
- **No** force push en ningún punto.
- **No** ejecutar los 3 worktrees con gateway local simultáneo sin la solución de audit temp.
- **No** crear sub-worktrees dentro de los 3 (mantener jerarquía simple).
- **No** modificar OPS individuales (chat live, tokenization, fallbacks) sin sincronizar con los demás worktrees activos.

## 10. Referencias

- 3 specs individuales:
  - `DOCUMENTACION/OPS_OPENCLAW_CHAT_LIVE.md`
  - `DOCUMENTACION/OPS_PANEL_TOKENIZATION_CLEANUP.md`
  - `DOCUMENTACION/OPS_PANEL_CLEANUP_FALLBACKS.md`
- Hito 5.11.C master Notion: https://www.notion.so/3667932c3b4281e5b815d3b527d18f3c
- Patrón worktree exitoso previo: `.claude/worktrees/youthful-mirzakhani-c517de` (Hito 5.10)
- Audit chain spec: `DOCUMENTACION/OPENCLAW_AUDIT_INTEGRATION.md`
