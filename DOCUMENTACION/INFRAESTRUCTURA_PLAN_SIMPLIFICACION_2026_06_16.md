# Infraestructura — Plan de simplificación (por qué sigue confundiendo)

Fecha: 2026-06-16 · Equipo: PM (Claude) + QA interactivo en vivo + 2 subagentes senior (UX/UI designer + frontend) · Método: Chrome en vivo + lectura de código · Read-only.
Componente: `apps/admin-panel/src/v5/views/Infrastructure.tsx`. Backend: `apps/gateway-api/src/routes/infrastructure.ts`, `packages/adapters/src/webdock-real-adapter.ts`.

## La regla que resuelve casi todo

> **Tinta plena solo para lo real y `live`. Todo lo demás (mock, planeado, error sin dato) va apagado, colapsado y SIN números.**

Hoy la sección viola esa regla en cada renglón: los 12 proveedores pesan visualmente igual cuando solo ~4 son reales, y los conteos demo se muestran como reales.

## Causa raíz del peor síntoma (BACKEND, P0)

Las cuentas en error muestran "3 servidores" porque el adapter de Webdock, ante un 401/error de red, **devuelve 3 servidores mock** (`webdock-real-adapter.ts:311-314` y `:329-333`: `servers: mockWebdockServers()` con `source.kind:"mock"`, `responseOk:false`), y `buildWebdockProvider` (`infrastructure.ts:227-232`) los copia como `itemCount:3` + `items:[mocks]`. La UI los renderiza fielmente. Resultado: **"Credencial rechazada · 3 servidores"** en la misma línea, y el drill-down de esa cuenta muestra servidores fantasma. El test `infrastructure.test.ts:143` no lo detecta porque inyecta lista vacía en vez de ejercitar el fallback real → falsa confianza.

QA interactivo (en vivo): el único botón vivo de toda la sección es "Ver detalle" (solo en filas de Atención); los otros 5 (Reautenticar, Marcar online, Preparar plan, Abrir chat, Docs) están permanentemente `disabled`. Las filas de Compute/DNS no expanden — el drill-down solo existe en las cuentas rotas, no en las activas. Tener 5 de 6 botones muertos es, en sí, fuente de confusión.

## Lo que confunde (cross-confirmado) y el corte

1. **Conteo demo como real** (P0) → suprimir `itemCount` cuando `fetchSourceKind !== "live"` o `status==="error"`: "conteo no disponible" / "sin recursos reales". Fix real en backend (no servir mock en 401); parche defensivo en front (`resourceLabel` `:260`, `byKind` `:627`, disclosure `:769`).
2. **Rol repetido** ("VPS de operación autorizada" en ~6 filas, "Registrador de dominios" 3x) → eliminar la columna central de rol (`ProviderList` `:937`); el SectionHead ya dice la categoría. Conservar rol solo donde diferencia (Bedrock).
3. **8 de 12 proveedores no productivos pesan igual** → colapsar planeados/mock/0-item en un disclosure "En cola / sin conectar" plegado por sección (DNS pasa de 4 filas a "Route53 + 3 en cola").
4. **Webdock = 5 filas planas** → agrupar por marca: 1 cabecera "Webdock · 5 cuentas · 9 servidores reales [2 activas · 2 error · 1 en cola]" + sub-filas; monograma 1 vez. El conteo de cabecera suma solo cuentas `live`.
5. **KPIs inflados** ("12 proveedores · 4 activos", "42 recursos" incluye mocks) → stats real-first: "Servidores reales 9 · Dominios reales 13 · Atención 3 · No productivo 8". El 12 y el 42 dejan de ser números-héroe.
6. **Colisión "Host Latam"** (cuenta Webdock + cuenta Contabo) → se disuelve al agrupar por marca (queda "Host Latam" dentro de Webdock y dentro de Contabo, contenedores distintos); además desambiguar el sufijo por `provider.id`, no por string.
7. **Mock invisible** ("modo demo" es caption 10px gris) → badge explícito "MODO DEMO/EN COLA" + opacity en la fila + monograma en outline. Apagado = no real.
8. **Vocabulario y tokens crudos** ("cuenta operativa" oculta que emael está vacía; "not_online_yet" token crudo) → estado real "en cola"; mapear tokens a copy humano.
9. **Drill-down inconsistente** → o todas las filas reales expanden (usando `provider.items`, que YA viene poblado y el front descarta), o ninguna; los placeholders no expanden (su detalle es mock).
10. **Botones muertos** → quitarlos o convertirlos en texto + pill "pendiente"; `aria-label` con el motivo si se quedan.

## Layout final propuesto (de ~12 filas densas a ~6 entidades reales)

```
KPIs: Servidores reales 9 · Dominios reales 13 · Atención 3 · No productivo 8
Atención requerida (3)  → con "conteo no disponible" (no "3 servidores")
Compute
  ▸ Webdock · 5 cuentas · 9 servidores reales [2 activas · 2 error↑ · 1 en cola]
       Dep Infraestructura 9 · activo   |   InfraVPS 13 · pausado   |   (emael → en cola)
  · Contabo · Host Latam · "Conectado sin VPS" · activo
  · AWS Bedrock us-east-1 · 1 modelo · dato viejo (29d)
DNS y dominios
  · AWS Route 53 · 13 dominios · activo
  ▸ 3 en cola (Porkbun, IONOS Cloud DNS, IONOS Domains — modo demo)  [plegado]
Hardware
  · Servidor físico Medellín  [si no está ya en Atención]
Footer: GET /v1/infrastructure/inventory · 6 live · 6 mock
```

## Reparto e implementación

**Backend (Codex, P0):** no inyectar `mockWebdockServers()` en error (`webdock-real-adapter.ts:313/:332` → `servers:[]`); forzar `itemCount:0/items:[]` si `!responseOk` en `buildWebdockProvider`; test que ejercite el fallback 401 real; (opcional) `brandKey` por provider para no adivinar marca por string.

**Front-only (Claude):** parche defensivo del conteo mock; eliminar columna de rol repetido; KPIs real-first; disclosure "En cola"; agrupar Webdock por marca (`groupByBrand` + `<ProviderGroup>` + extraer `<ProviderRow>`/`<ProviderDetail>`); drill-down universal con `provider.items`; badges de mock; quitar/etiquetar botones muertos.

**Orden:** P0 (backend mock + parche front) → quick wins front (rol, KPIs, badges, botones) → disclosure "En cola" → agrupación Webdock + drill-down universal. Los quick wins solos bajan el ruido ~60%.
