# RUNBOOK — Integrar produ (#14/#15) al gateway + organizar Canvas v5 (deploy-safe)

Fecha: 2026-06-22 · Ejecuta: **Codex** (es dueño del WIP sin commitear del working tree) · Coordina: Juanes (CTO) · Base del gateway: working tree de `feature/canvas-v5-preview`

> Objetivo: que el gateway local corra #14 (PTR automático) y #15 (resiliencia del token), y que el Canvas v5 sea el canvas real (sin el flag `?canvasv5`), **sin perder trabajo ni romper lo que funciona**.

---

## 0. Estado auditado (2026-06-22) — por qué este runbook existe

- **Merge colgado SIN terminar:** `.git/MERGE_HEAD` = `95dbcd4` (PR#10). `git status` dice *"All conflicts fixed but you are still merging"*. Hay 15 archivos staged (267 ins / 51 del). No se puede mergear ni cherry-pickear nada hasta cerrar esto.
- **69 archivos sin commitear** (16 de código fuente, 3 en `.audit/`, 50 otros).
- **El sign-fix vive SOLO en disco, sin commitear:** `proposals-sign.ts` con `provider ?? vpsProviderId` → HEAD=0, disco=2. Es lo que desbloquea la firma (run v12). **produ SÍ lo tiene committeado (PR#12/#13)** — esa es la fuente de verdad. Tras integrar produ queda a salvo.
- **produ está 14 commits adelante** y el branch 14 adelante (divergencia 14/14). produ trae #10-#15 (incluye #14 PTR-auto y #15 resiliencia). El branch NO los tiene en disco (`setReverseDns`=0, `tokenPromise`=0).
- **v5 es exclusivo del branch:** `CanvasV5Preview.tsx`, `openclaw-chat-history.ts`, `openclaw-chat-history-store.ts` **no existen en produ**. Un merge mal resuelto los borra.
- **Los 2 SMTP que entregan** (annualcorpfilings, nationalbizrenewal) corren en VPS Contabo independientes — **no dependen de este merge** y no se tocan.

## 1. Invariantes (no romper bajo ninguna circunstancia)

1. **NUNCA** `git reset --hard`, `git checkout -- .` ni `git clean` antes de que produ esté integrado y verificado. Borrarían el sign-fix sin commitear y el WIP.
2. Preservar el trabajo branch-only: Canvas v5 + chat-history (son additive).
3. Webdock byte-idéntico (ya verificado en #14/#15; mantenerlo en la resolución de conflictos).
4. Tag de respaldo ANTES de tocar nada (ver Fase 2). El rollback debe ser 1 comando.
5. Hacerlo con el gateway brevemente detenido y fuera de un run de OpenClaw en curso.

## 2. Fase 0 — Respaldo + foto (NO destructivo)

```
git tag pre-integracion-2026-06-22          # respaldo de la HISTORIA commiteada
git status                                  # confirmar "still merging" + dirty
git diff --cached --stat                    # que trae el merge colgado staged
git stash list
git log --oneline origin/produ ^HEAD        # los 14 commits que entran (#10..#15)
```

> **CRÍTICO — el tag NO salva los 69 archivos sin commitear ni el estado del merge colgado.** Antes de abortar/resetear NADA, preservar el árbol sucio + el merge a medias en una rama de snapshot, así todo es 100% reversible:
> ```
> git add -A && git commit -m "snapshot WIP + cierre merge colgado pre-integracion"   # captura TODO (concluye el merge colgado y guarda los 69 archivos)
> git branch wip/snapshot-pre-integracion-2026-06-22                                   # puntero de rescate a ese snapshot
> ```
> Con eso, cualquier `git merge --abort` / `git reset` posterior es recuperable (el snapshot tiene el sign-fix, el WIP y el #10 staged).

Decisión con Codex (tiene el contexto del WIP): **¿el merge colgado + los 69 archivos son WIP valioso, o residuo de produ viejo (#10) recuperable vía el merge nuevo?**
- **Dato del audit:** el merge colgado es `MERGE_HEAD=95dbcd4` (#10), y la base es #9 → todo su contenido (ssh-retry, server-provider, smtp-provisioning, etc.) **ya está en produ #10-#15**. El sign-fix sin commitear **también está en produ** (#12/#13). Por eso, tras el snapshot, **abortar es seguro**: nada se pierde que produ no restaure.
- Si Codex detecta WIP genuinamente único (no en produ) entre los 69, queda en el snapshot branch para reincorporar después.

## 3. Fase 1 — Dejar el árbol limpio (cerrar el merge colgado)

Meta: `git status` sin pendientes antes de Fase 2.

- **El sign-fix NO requiere rescate manual**: produ lo tiene committeado, así que se restaura solo al mergear produ. Si un `git merge --abort` lo descarta del disco, es esperado y se recupera en Fase 3 (verificar en Fase 5).
- Cerrar el merge colgado según Fase 0:
  - Si el staged es recuperable / residuo:  `git merge --abort`  (vuelve a HEAD limpio).
  - Si hay WIP único que conservar:  `git commit -m "wip: cierre merge colgado pre-integracion"`  (o moverlo a rama `wip/pre-integracion`).
- Confirmar:  `git status`  → *nothing to commit, working tree clean*.

## 4. Fase 2 — Merge de produ

```
git merge origin/produ
```

**Conflictos REALES del merge: SOLO 2 archivos** (verificado 2026-06-22 — archivos que AMBOS lados modificaron desde el merge-base `a186fa5`/#9). Todo lo demás entra limpio.

- **`apps/gateway-api/src/main.ts`** — branch +61/-21 (wiring canvas-live + bedrock-bridge + rutas chat-history), produ +2/-1 (un toque de log de #13). Resolución: **conservar la versión del branch + reaplicar el +2/-1 de produ** (el log). Trivial.
- **`apps/gateway-api/src/routes/orchestrator-smtp.ts`** — branch +8/0, produ +68/-1 (mejoras de flujo #11/#14/#15). Resolución: **base = produ (+68) + reaplicar los +8 del branch**, verificando que no se pisen.

**Todo lo demás NO conflicta (verificado con `git diff merge-base`):**

- **#14/#15 entran LIMPIOS desde produ** (el branch no tocó esos archivos en su historia commiteada): `contabo-adapter.ts` (+308), `webdock-bind-domain.ts` (+171), `webdock-servers.ts` (+103), `smtp-provisioning.ts` (+55), `skill-dispatcher.ts`, `vps-provider.ts`, `ssh-retry.ts` y `server-provider.ts` (nuevos de produ), `warmup*.ts`, `send-email.ts`, `episodic-scratch.ts` (+81, scratch 503→200), `canvas-v4.tsx` (+88, ErrorBoundary). El merge los toma de produ tal cual.
- **`proposals-sign.ts`**: produ lo trae con el sign-fix committeado (`provider ?? vpsProviderId` + test del `scopeHash`). Entra limpio; la versión local sin commitear se descarta (produ es la fuente de verdad).
- **v5 + chat-history SOBREVIVEN solos** (produ no los tiene ni los toca): `CanvasV5Preview.tsx` (+725), `openclaw-chat-history.ts` (+93), `openclaw-chat-history-store.ts`, `canvas-live-client.ts` (+20). El merge los conserva sin tocar.
- **`App.tsx`: NO conflicta** — produ NO lo modificó (0 cambios desde base); el wiring del v5 del branch (+18) queda intacto automáticamente. El flip a v5-default (Fase 3) es una edición limpia aparte, sin conflicto de merge.

## 5. Fase 3 — Organizar el Canvas (retirar el andamio `?canvasv5`)

Lo que pidió Juanes: que el v5 sea el canvas por defecto, sin flag, apto para deploy.

Bloque actual en `apps/admin-panel/src/app/App.tsx` (`:689-705`): default = `CanvasV4`, v5 detrás de `?canvasv5` sticky. Reemplazar el `case "canvas"` por (v5 default, `?canvasv4` como escape temporal):

```tsx
    case "canvas": {
      // v5 es el canvas por defecto (deploy-safe). ?canvasv4 = escape temporal de rollback
      // mientras se retira canvas-v4; sticky en la sesion como antes lo era canvasv5.
      let useV4 = false;
      if (typeof window !== "undefined") {
        try {
          const search = window.location.search;
          if (search.includes("canvasv5")) window.sessionStorage.removeItem("canvasv4");
          else if (search.includes("canvasv4")) window.sessionStorage.setItem("canvasv4", "1");
          useV4 = window.sessionStorage.getItem("canvasv4") === "1";
        } catch {
          useV4 = window.location.search.includes("canvasv4");
        }
      }
      return <Suspense fallback={<SectionLoadingState />}>{useV4 ? <CanvasV4 /> : <CanvasV5Preview />}</Suspense>;
    }
```

- **Cosmético (opcional, se puede diferir):** renombrar `CanvasV5Preview` → `Canvas` (archivo + export en `CanvasV5Preview.tsx:459` y `:725` + import en `App.tsx:52`), para que no diga "Preview" en producción.
- **DECISIÓN DE JUANES — disposición de v4:** ¿borrar `canvas-v4.tsx` ya, o dejarlo como `?canvasv4` de respaldo?
  - **Recomendado (default de este runbook):** dejarlo como `?canvasv4` 1-2 semanas; si nadie lo necesita, borrar después (import `App.tsx:51` + `features/canvas/canvas-v4.tsx`).

## 6. Fase 4 — Verificación (gates obligatorios, no saltar ninguno)

```
# lo nuevo de produ quedo en disco:
grep -c setReverseDns packages/adapters/src/contabo-adapter.ts                 # > 0  (#14)
grep -c tokenPromise packages/adapters/src/contabo-adapter.ts                  # > 0  (#15)
grep -c runBindingMatchesScope apps/gateway-api/src/routes/webdock-servers.ts  # > 0  (#15)
# el sign-fix sigue (via produ):
grep -c "vpsProviderId" apps/gateway-api/src/routes/proposals-sign.ts          # > 0
# el v5 sobrevivio:
ls apps/admin-panel/src/features/canvas/CanvasV5Preview.tsx                    # existe
# compila + tests:
node --check apps/gateway-api/src/main.ts
npm test                                                                       # verde (esperado ~1108+)
git diff --check
```

- **Reiniciar el gateway** (corre el working tree → hay que reiniciarlo para tomar el código nuevo).
- En el navegador, `/canvas` debe mostrar el **v5 sin flag**. `?canvasv4` debe mostrar el v4.
- **Smoke de firma:** proponer un run y firmarlo — confirmar que **NO da 422** (`plan_scope_missing`).
- Confirmar que el reporte ya no trae `webdock_inventory_degraded` como blocker estructural (resiliencia #15 activa).

## 7. Rollback (si algo sale mal)

- Si seguís en medio del merge nuevo:  `git merge --abort`.
- Para volver a la HISTORIA commiteada de hoy:  `git reset --hard pre-integracion-2026-06-22`  (OJO: el tag NO restaura los 69 archivos sin commitear).
- Para recuperar el árbol sucio + el merge colgado tal como estaban hoy: la rama `wip/snapshot-pre-integracion-2026-06-22` (creada en Fase 0) los tiene committeados. Ese es el respaldo COMPLETO — entre el tag y la rama snapshot, el estado de hoy es 100% reconstruible.

## 8. Resultado esperado

Con esto, en un solo paso de integración quedan resueltas TRES cosas:
1. **#14** — PTR de Contabo automático (los SMTP nuevos dejan de necesitar el PTR manual).
2. **#15** — resiliencia del token (se acaba el `webdock_inventory_degraded` por churn del token).
3. **Canvas v5** como canvas real, sin `?canvasv5`, listo para deploy.

Los 2 SMTP productivos siguen intactos (VPS aparte). El warm-up / reputación (5 nodes en cuarentena, 4 complaints) es tema operativo separado, no de este merge.
