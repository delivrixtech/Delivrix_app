# Codex — FIX edge cosmético "orphan-tree" del Canvas Live (re-root en buildTaskTree)

> **Estado: VERIFICADO GO en worktree aislado (HEAD `62ff51e`, 2026-06-08).** Edge cosmético hallado en el audit 3× del memleak (`62ff51e`): la evicción puede borrar un task **padre** y conservar un **hijo completado** más nuevo; ese hijo queda huérfano e **invisible** en la lista "Tareas" + descuadra el contador `Tareas · N`. NO es crash, NO afecta el leak ni las tasks activas/running. Fix mínimo de **capa de vista** (solo `live-tool.tsx`). **Aplicá EXACTAMENTE este diff + 2 tests. No re-derivar.** Resultados de la verificación: `tsc --noEmit` 0; `npm --workspace @delivrix/admin-panel run check` **44/44** + vite build OK; `live-tool.test.ts` **5/5** (3 previos + 2 nuevos); `canvas-live-client.test.ts` **9/9** (intacto). Test nuevo **load-bearing** (sin el fix, falla: el huérfano no aparece). Árbol compartido intacto.
>
> **Subagentes OBLIGATORIO:** un subagente aplica el diff y otro subagente Auditor INDEPENDIENTE revisa ANTES del commit (confirma: solo se tocó `live-tool.tsx`, no se tocó `evictLiveState`/`dedupAndSort`/`buildNode`, el caso normal queda byte-equivalente, y las suites verdes). Stop-and-report si algo no aplica limpio.

## Causa raíz (verificada)
`buildTaskTree` en `apps/admin-panel/src/features/canvas/live-tool.tsx` (~:150) arma el árbol SOLO desde raíces con `parentTaskId == null` (`childrenByParent.get(null)`, ~:203). Cuando `evictLiveState` (del fix de memleak) borra un padre pero conserva un hijo COMPLETADO más nuevo, el hijo queda en `childrenByParent.get(<idAusente>)` y nunca se visita → invisible en "Tareas" + no contado en `totalShown` (~:243). (Un hijo *running* nunca se orfana: su padre se preserva vía el ancestor-walk de `evictLiveState`.)

## El fix EXACTO (2 hunks, solo `live-tool.tsx`)
Exportar `buildTaskTree` (para test, igual que `evictLiveState` es `export function` en `canvas-live-client.ts`) + re-rootear huérfanos: tratar un `parentTaskId` que NO esté en `byId` como `null`. `byId` ya está completo (líneas 152-153) antes del loop de agrupación.

```diff
@@ -147,7 +147,7 @@ interface TaskNode extends LiveTask {
  *    Esto evita el caso "Inventario IONOS ×6" cuando el operador pregunta
  *    lo mismo varias veces.
  */
-function buildTaskTree(tasks: LiveTask[]): TaskNode[] {
+export function buildTaskTree(tasks: LiveTask[]): TaskNode[] {
   // Index por id para resolver parents rápido
   const byId = new Map<string, LiveTask>();
   for (const t of tasks) byId.set(t.id, t);
@@ -155,7 +155,9 @@ function buildTaskTree(tasks: LiveTask[]): TaskNode[] {
   // Agrupar por parentTaskId
   const childrenByParent = new Map<string | null, LiveTask[]>();
   for (const t of tasks) {
-    const parent = t.parentTaskId ?? null;
+    const rawParent = t.parentTaskId ?? null;
+    // Re-root orphans: si el padre fue evictado (no está en byId), tratar como raíz.
+    const parent = rawParent !== null && byId.has(rawParent) ? rawParent : null;
     const arr = childrenByParent.get(parent);
     if (arr) arr.push(t);
     else childrenByParent.set(parent, [t]);
   }
```
Caso normal (padre presente): `byId.has(rawParent)` true → `parent === rawParent`, **idéntico** al original. Solo cambian los huérfanos.

## NO TOCAR
- NO `evictLiveState`, NO `dedupAndSort`, NO `buildNode`, NO `countDescendants`, NO `TaskNode`.
- NO exportar nada más que `buildTaskTree`.
- NINGÚN otro archivo (esto es solo `live-tool.tsx` + su test).

## Tests nuevos — en `apps/admin-panel/src/features/canvas/live-tool.test.ts`, pegar verbatim

**1) Cambiar la línea de import** (agregar `LiveTask` al import type-only existente):
```ts
import type { LiveAction, LiveTask } from "./live-tool-types.ts";
```

**2) Reemplazar el bloque `interface LiveToolModule { ... }` por esto** (agrega el shape del nodo, extiende la interfaz con `buildTaskTree`, y los helpers `totalShown`/`makeTask`):
```ts
/** Estructura mínima del nodo del árbol que asertamos (mirror de TaskNode interno). */
interface TaskNodeShape {
  id: string;
  title: string;
  repeatCount: number;
  children: TaskNodeShape[];
}

interface LiveToolModule {
  CommandActionView: React.ComponentType<{ action: Extract<LiveAction, { kind: "command" }> }>;
  commitEditableTitleText: (textContent: string | null, title: string, onChange: (value: string) => void) => string;
  buildTaskTree: (tasks: LiveTask[]) => TaskNodeShape[];
}

/**
 * Replica EXACTA de la fórmula `totalShown` del header "Tareas · N"
 * (live-tool.tsx ~:243): raíces + descendientes. Sirve para probar que un
 * huérfano re-rooteado queda CONTADO en el badge.
 */
function totalShown(tree: TaskNodeShape[]): number {
  const countDescendants = (n: TaskNodeShape): number =>
    n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);
  return tree.length + tree.reduce((acc, n) => acc + countDescendants(n), 0);
}

function makeTask(over: Partial<LiveTask> & Pick<LiveTask, "id" | "title">): LiveTask {
  return {
    status: "completed",
    createdAt: "2026-06-08T00:00:00.000Z",
    actorId: "agent-1",
    ...over
  };
}
```
> Nota: el test asserta la matemática del badge `Tareas · N` replicando la fórmula `totalShown` inline (porque `countDescendants` es módulo-privado y NO debe exportarse). Así prueba que el huérfano queda **visible** (raíz) y **contado** sin ampliar la superficie de export. Si tu `LiveToolModule` actual tiene otros miembros, conservalos y solo AGREGÁ `buildTaskTree`.

**3) Agregar estos 2 tests al final del archivo:**
```ts
test("buildTaskTree re-roots an orphan whose parent was evicted so it stays visible and counted", async () => {
  const { buildTaskTree } = await loadModule();

  // Padre normal + su hijo (anidamiento que NO debe cambiar).
  const parent = makeTask({ id: "p", title: "Supervisor", status: "running", createdAt: "2026-06-08T00:00:03.000Z" });
  const child = makeTask({ id: "c", title: "Sub normal", parentTaskId: "p", createdAt: "2026-06-08T00:00:02.000Z" });
  // Huérfano: su parentTaskId apunta a un id que NO está en la lista (padre evictado).
  const orphan = makeTask({ id: "o", title: "Sub huérfano", parentTaskId: "ghost-evicted", createdAt: "2026-06-08T00:00:01.000Z" });

  const tree = buildTaskTree([parent, child, orphan]);

  // (a) El huérfano aparece como nodo RAÍZ (visible en la lista).
  const rootIds = tree.map((n) => n.id);
  assert.ok(rootIds.includes("o"), `orphan debe ser raíz; roots=${JSON.stringify(rootIds)}`);

  // (b) Está CONTADO: 2 raíces (Supervisor + huérfano) + 1 descendiente (Sub normal) = 3.
  assert.equal(tree.length, 2);
  assert.equal(totalShown(tree), 3);

  // (c) El anidamiento normal padre→hijo sigue intacto: el huérfano NO se cuela ahí.
  const supervisor = tree.find((n) => n.id === "p");
  assert.ok(supervisor, "supervisor presente");
  assert.deepEqual(supervisor.children.map((c2) => c2.id), ["c"]);
  // Y el huérfano-raíz no arrastra hijos espurios.
  const orphanRoot = tree.find((n) => n.id === "o");
  assert.ok(orphanRoot, "orphan root presente");
  assert.equal(orphanRoot.children.length, 0);
});

test("buildTaskTree leaves a normal present-parent tree unchanged (no regression)", async () => {
  const { buildTaskTree } = await loadModule();

  const parent = makeTask({ id: "p", title: "Supervisor", status: "running", createdAt: "2026-06-08T00:00:02.000Z" });
  const child = makeTask({ id: "c", title: "Sub", parentTaskId: "p", createdAt: "2026-06-08T00:00:01.000Z" });

  const tree = buildTaskTree([parent, child]);

  // Una sola raíz con un hijo anidado; total = 2.
  assert.deepEqual(tree.map((n) => n.id), ["p"]);
  assert.deepEqual(tree[0].children.map((c2) => c2.id), ["c"]);
  assert.equal(totalShown(tree), 2);
});
```

## DoD (Codex)
1. Aplicar el diff (2 hunks) + los 2 tests + el cambio de import/interfaz.
2. `cd apps/admin-panel && npx tsc --noEmit` → 0. `npm --workspace @delivrix/admin-panel run check` → 0 (**44/44** + vite build). `node --test apps/admin-panel/src/features/canvas/live-tool.test.ts` → **5/5**. `node --test apps/admin-panel/src/features/canvas/canvas-live-client.test.ts` → **9/9** (intacto).
3. **Commit atómico:** "Re-root orphaned tasks in Canvas Live tree (fix evicted-parent invisibility)".
4. **Deploy local del panel:** rebuild/restart del serve del admin-panel (`delivrix-admin-start.sh` / `npm run dev:admin`). **NO** toca gateway, NO Hostinger/system-context (es solo `live-tool.tsx`, vista del panel). **Push `origin produ`** (FF).
5. Esto deja la QA-visual del memleak limpia: el ítem (b) "el árbol no pierde sub-tasks" ya no puede dar falso positivo por un huérfano.

## Reportá
SHA del commit + EXIT de los gates (tsc/check/live-tool/canvas-live-client) + confirmación de deploy local + push, y que solo tocaste `live-tool.tsx` (+ su test), sin tocar `evictLiveState`/`dedupAndSort`/`buildNode` ni otro archivo.
