# RELEASE Hito 5.10 — Frontend UX panel Delivrix

> Doc de release · 2026-05-17 · ejecutar en orden estricto

## 0. Pre-flight (host, en la rama de trabajo)

```bash
cd "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"

# Verificar que estamos en la rama correcta y limpia
git status
git branch --show-current   # debe imprimir: youthful-mirzakhani-c517de

# Suite completa
rm -rf apps/admin-panel/dist
npm test                                       # debe pasar 138/138
npm --workspace @delivrix/admin-panel run check # tsc + tests + vite build
```

Si algo falla aquí, **NO continuar**. Revisar el log antes de mergear.

## 1. Aplicar commits H.20 y H.21

```bash
# H.20 — Wave 3A backend mocks IAM + compliance + evidence
bash -c "$(awk '/^```bash/{flag=1;next}/^```/{flag=0}flag' COMMIT_FASE_H_20.md)"

# H.21 — Responsive base + auditoría variantes Pencil
bash -c "$(awk '/^```bash/{flag=1;next}/^```/{flag=0}flag' COMMIT_FASE_H_21.md)"

git log --oneline -5
```

Confirmar que los 2 commits aparecen con sus mensajes correctos.

## 2. Smoke test del gateway

```bash
# Levantar gateway en otra terminal
GATEWAY_PORT=3399 node apps/gateway-api/src/main.ts &
GW_PID=$!
sleep 2

# Verificar los 27 endpoints GET
for path in \
  /health \
  /v1/admin/clusters /v1/admin/overview /v1/admin/workflow \
  /v1/audit-events /v1/compliance/status \
  /v1/devops/collector/snapshot-ingestion /v1/devops/collector/status /v1/devops/collector/supervised-plan \
  /v1/hardware/physical-host /v1/hardware/telemetry/history /v1/hardware/telemetry/latest \
  /v1/iam/roles /v1/iam/sessions \
  /v1/ip-reputation/reports /v1/kill-switch \
  /v1/openclaw/evidence /v1/openclaw/learning-plan /v1/openclaw/live-canvas \
  /v1/openclaw/onboarding/state /v1/openclaw/provisioning/state \
  /v1/openclaw/readiness-signals /v1/openclaw/skills/audit \
  /v1/operating-north /v1/operational-summary \
  /v1/send-results /v1/sender-nodes /v1/stuck-jobs ; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 3 "http://127.0.0.1:3399${path}")
  [ "$code" = "200" ] && echo "ok  ${path}" || echo "FAIL ${code}  ${path}"
done

kill $GW_PID 2>/dev/null
```

Esperar: 27 líneas `ok` y 0 `FAIL`.

## 3. Levantar admin panel en local

```bash
# Terminal 1
GATEWAY_PORT=3000 node apps/gateway-api/src/main.ts

# Terminal 2
npm --workspace @delivrix/admin-panel run dev
# abre http://127.0.0.1:5173
```

Recorrido manual (10 minutos):

1. Overview — todos los KPIs con valor numérico, sin "—"
2. Onboarding — wizard con 5 pasos, sin warnings inesperados
3. OpenClaw Canvas — autolayout dagre, 6 nodos visibles, edges con etiqueta
4. Hardware — KPIs con valores, telemetría con timestamps reales
5. Collector — 5 fuentes con freshness chip, ningún placeholder
6. Clusters — 3 clusters, sender nodes con IP/dominio reales
7. Aprendizaje — 4 hitos del plan, evidencia curada (6 filas con sha256:),
   bitácora con 5 sha256: eventos
8. Seguridad — KillSwitch grande (ARMADO), 4 roles, 3 sesiones, 3
   compliance cards, audit log con 6 filas

Verificar: light/dark toggle (chrome + sidebar invierten; features quedan
en light hasta H.22).

## 4. Merge a main

```bash
# Volver a la rama main del repo principal (no del worktree)
cd "/Users/juanescanar/Documents/delivrix app"
git fetch origin
git switch main
git pull --ff-only

# Merge fast-forward del worktree
git merge --ff-only youthful-mirzakhani-c517de

git log --oneline -10
```

Si no es fast-forward, **NO forzar**. Revisar qué commits aparecieron en
main mientras tanto y hacer rebase del worktree primero.

## 5. Tag y push

```bash
cd "/Users/juanescanar/Documents/delivrix app"

git tag -a hito-5.10 -m "Hito 5.10 — Frontend UX panel Delivrix (GET-only, 8 secciones, 27 contratos)"
git push origin main
git push origin hito-5.10
```

## 6. Cleanup del worktree

Solo después de confirmar que el push llegó al remote:

```bash
git worktree list
git worktree remove ".claude/worktrees/youthful-mirzakhani-c517de"
git branch -d youthful-mirzakhani-c517de
```

## 7. Notion handoff

- **Task Board**: mover "Hito 5.10 — Frontend UX panel" a `Done`
  con etiqueta del commit hash.
- **Daily Reports**: agregar entrada día 17 con resumen:
  - Wave 3A landed (IAM + compliance + evidence cabling)
  - Auditoría completa de variantes Pencil (dark + tablet + mobile)
  - Hito 5.10 cerrado con 138/138 tests, 27 contratos GET, 0 mutaciones
    en el bundle frontend.
- **Hito 5.11 backlog**: copiar contenidos de
  `DOCUMENTACION/BACKLOG_CONTRATOS_5_11.md` y abrir tickets:
  - H.22 Theme tokenization sweep
  - H.22 Sidebar icon-rail + mobile drawer
  - Contratos backend reales para IAM / Compliance / OpenClaw skills
    audit / evidence (los mocks H.20 se reemplazan cuando el backend
    real exista).

## 8. Demo MVP día 17/30

Plan corto:

1. Abrir admin panel en una pestaña, gateway corriendo en `localhost:3000`.
2. Mostrar las 8 secciones secuencialmente (cada una 60-90 segundos).
3. Enfatizar:
   - "Solo lectura — GET-only" badge presente siempre.
   - Kill switch grande visible desde Seguridad y desde la sidebar.
   - Audit log encadenado (sha256:) en Seguridad y Aprendizaje.
   - 0 botones POST en el panel — todas las acciones reales se ejecutan
     fuera del panel con regla de 2 personas firmada.
4. Cerrar con la captura de pantalla del Canvas autolayout (es la imagen
   más fuerte del MVP).

> Cualquier issue durante el release se reporta al canal #ops-mvp con el
> commit hash de la cabeza de `main`.
