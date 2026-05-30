# Fase 0.5 — Handoff fin de día viernes 2026-05-29

**Para:** Juanes (CTO), Codex (sesión lunes), futuras conversaciones Claude.
**De:** Claude PM.
**Estado al cierre:** Fase 0.5 arrancada parcialmente. 2 de 3 bugs cerrados en disco. OPS Codex armado y listo.

---

## TL;DR

Cerramos los 2 fixes de panel que estaban bloqueando ApprovalGate visible. El endpoint backend `/sign` queda armado vía OPS Codex para arrancar lunes 8am. **NO hago commit yo:** el árbol tiene `.git/index.lock` activo (Codex paralelo) + 80 archivos sin commitear mezclados, y un push mío encima corrompería el historial.

---

## Lo que SÍ cerré en disco (sin commit)

### Bug #1 — vite proxy bloqueaba `/sign`

**Archivo:** `apps/admin-panel/vite.config.ts`

**Cambio:** añadí `allowedWritePatterns: RegExp[]` con 2 patterns:
- `/^\/v1\/openclaw\/proposals\/[^/]+\/sign$/`
- `/^\/v1\/openclaw\/proposals\/[^/]+\/reject$/`

Y actualicé la lógica del middleware para chequear ambos:

```typescript
const isAllowedWrite =
  request.method === "POST" &&
  (allowedWritePaths.has(requestUrl.pathname) ||
    allowedWritePatterns.some((re) => re.test(requestUrl.pathname)));
```

**Doc inline actualizado** explicando por qué se whitelistea el regex (path con `{auditId}` dinámico) y la justificación post-cambio-norte.

### Bug #3 — Texto sidebar "Regla de 2 personas"

**Archivos modificados:**

1. `apps/admin-panel/src/v5/shell/Shell.tsx` línea 387:
   - Antes: `Regla de 2 personas · click para gestionar`
   - Después: `1 firma operador · audit SHA-256 · click para gestionar`

2. `apps/admin-panel/src/v5/views/Clusters.tsx`:
   - Línea 12 (comentario doc): `regla de 2 personas` → `1 firma + audit chain`
   - Línea 586 (UI viva): `Regla de 2 personas · rol elevado obligatorio.` → `1 firma operador · audit chain SHA-256 · rol elevado obligatorio.`
   - Línea 755 (label form): `Operador (regla de 2 personas)` → `Operador (1 firma + audit chain)`

**Mención restante (intencional):** Shell.tsx línea 593 dentro de comentario doc-only explicando "Antes vivían acá 'Audit chain · Append-only · Regla de 2 personas'". Es historia, no UI.

## Lo que NO cerré — pasa a Codex lunes

### Bug #2 — Endpoint `POST /v1/openclaw/proposals/{proposalId}/sign`

**OPS armado:** `DOCUMENTACION/OPS_CODEX_FASE_0_5_SIGN_ENDPOINT_2026_05_29.md`

**Resumen del OPS (~3h):**
1. Endpoint `/sign` con dispatch interno (no expone approvalToken al frontend).
2. Endpoint `/reject` análogo.
3. Dispatcher de 8 skills con map canónico + mock HTTP adapter.
4. Schemas zod por skill (leyendo handlers existentes, NO inventar).
5. ~42 tests nuevos.
6. Smoke E2E real con $25 USD post-merge.
7. Limpieza worktree pre-flight (resolver lock + revisar 80 archivos sueltos).

**Decisión arquitectónica clave:** el `/sign` dispatcha la skill internamente, retorna outcome al panel. Mejor que devolver token (menor superficie ataque + setea base Fase 1 tool calling).

---

## Estado del árbol (CRÍTICO)

```
80 archivos modificados o untracked
.git/index.lock activo (no puedo unlock — "Operation not permitted")
.worktrees/ activo (Codex sesión paralela)
```

**Archivos relevantes a Fase 0.5 (los míos de hoy):**
- M `apps/admin-panel/vite.config.ts`
- M `apps/admin-panel/src/v5/shell/Shell.tsx`
- ?? `apps/admin-panel/src/v5/views/Clusters.tsx` (untracked — el archivo lo creó alguien antes pero nunca se hizo `git add`)

**Archivos de Codex en vuelo (NO tocar):**
- M `.audit/audit-events.jsonl` (auditoría viva)
- Múltiples `apps/gateway-api/src/*` (auto-rollback A2, audit chain A1)
- `.worktrees/*` (sesión Codex)

**Basura para limpiar lunes pre-Fase 0.5:**
- `push_*.sh` (12 scripts viejos en raíz — basura semanas pasadas)
- `*.bak` (4 archivos `.bak` en features/)
- `screenlog.0` (log de screen)
- `Servidor Fisico /` (directorio raro con espacio + slash al final)

---

## Próximos pasos lunes 2026-06-01

### 7:30 COT — Pre-flight PM
1. `git status` para confirmar índice unlock.
2. Si `.git/index.lock` persiste y Codex no está activo, `rm .git/index.lock` (verificar con `lsof` antes).
3. Stash de los `.bak` + scripts `push_*.sh` con mensaje "WIP: basura semanas pasadas, revisar luego".
4. Commit limpio de mis 3 fixes (vite + Shell + Clusters) con mensaje:
   ```
   fix(admin-panel): fase 0.5 unblock approval gate

   - vite proxy: whitelist /v1/openclaw/proposals/{id}/{sign,reject} regex
   - shell: cambio norte 2026-05-29 → "1 firma operador · audit SHA-256"
   - clusters: actualizar 3 menciones "regla de 2 personas" → norte vigente

   Pendiente: endpoint backend /sign (ver OPS_CODEX_FASE_0_5_SIGN_ENDPOINT).

   Co-Authored-By: Claude <noreply@anthropic.com>
   ```

### 8:00 COT — Codex arranca OPS
- Ver `DOCUMENTACION/OPS_CODEX_FASE_0_5_SIGN_ENDPOINT_2026_05_29.md`.
- Reportar SHA tareas 1-6 a las 9:30.
- PM revisa diff.
- Smoke E2E con $25 entre 10:30-11:00 si todo verde.

### 11:00 COT — Arranque Fase 1
- Tool calling Bedrock (5 días estimados).
- Doc base: `ROADMAP_AUTONOMIA_100_AGENTES_2026_05_29.md`.

---

## Sign-off Fase 0.5 (parcial)

| Item | Status |
|---|---|
| Bug #1 vite proxy | ✅ FIXED en disco, pendiente commit |
| Bug #3 sidebar + Clusters | ✅ FIXED en disco, pendiente commit |
| Bug #2 endpoint /sign | 📋 OPS Codex armado, ejecución lunes |
| Limpieza árbol | 📋 Pendiente lunes pre-flight |
| Smoke E2E $25 USD | 📋 Pendiente post-Bug #2 |

---

**Costo del día viernes:** $0 USD ejecutados (smoke evitado por contratos misaligned).
**Costo proyectado lunes:** ≤$25 USD (smoke E2E real con dominio descartable).

— Claude PM
