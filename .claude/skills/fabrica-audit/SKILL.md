---
name: fabrica-audit
description: Gate de auditoría multi-agente sobre el diff de trabajo antes de commitear a produ. Corre 5 lentes independientes (correctness, seguridad, integración de tools, cobertura de tests, invariantes de dominio) sobre lo que cambió, verifica adversarialmente cada hallazgo, y devuelve un reporte rankeado. Usar antes de commitear cambios en la fábrica (cuota/medición/warmup/tools de OpenClaw), o cuando el usuario pida "auditá esto", "corré el gate de auditoría", "/fabrica-audit".
---

# Gate de auditoría de la fábrica

Objetivo: cazar bugs en **código nuevo** antes de que llegue a produ, con los mismos lentes que
el 2026-07-31 encontraron 5 defectos reales alrededor del umbral permanente de Google. NO es un
linter ni un formateador: busca defectos que cambian el comportamiento, con foco en las
invariantes que este sistema NO puede violar.

## Cuándo corre y sobre qué

Corré esto ANTES de commitear a produ cuando el diff toca la fábrica (sender-quota, sender-measurement,
sender-inventory, warmup-ramp, las tools de OpenClaw, los proxys del panel). El alcance NO se
adivina: sale de `scripts/audit/diff-scope.sh`.

```
bash scripts/audit/diff-scope.sh                 # árbol de trabajo vs HEAD (antes de commit)
bash scripts/audit/diff-scope.sh origin/produ    # todo lo que produ local tiene de más
bash scripts/audit/diff-scope.sh <base> <head>   # un rango puntual
```

Parseá su salida: `=== FILES ===` (código a auditar, incluye untracked bajo apps/packages),
`=== TESTS ===` (¿protegen las invariantes?), `=== OTHER ===` (config/docs), `=== DIFF ===` (el
cambio real). Si `code_files=0` Y no hay tests ni config relevante cambiada, no hay nada que
auditar: decilo y terminá.

**El scope tiene un perímetro — miralo:** un cambio en `config/gateway.env` o en un default de
flag (que arma o desarma un gate: `SENDER_QUOTA_DAILY_MAX`, `WARMUP_ENABLE_SEND`, flags de
escritura de Route53/Webdock/SSH) cae en `=== OTHER ===`. Eso NO es "no auditable": pasá los
archivos `*.env`/config de OTHER al lente de seguridad y tratá un cambio de flag como cambio de
comportamiento — ahí es donde se abren agujeros sin tocar una línea de código.

## Cómo correr el gate (recipe)

1. **Scope.** Corré `diff-scope.sh` con el argumento que corresponda. Guardá la lista de archivos
   de código y el diff.

2. **Fan-out: 5 lentes en paralelo**, un subagente `general-purpose` por lente, TODOS lanzados en
   un mismo mensaje (varias tool calls Agent juntas) para que corran concurrentes. A cada uno se le
   pasa: la lista de archivos de código cambiados, y la instrucción de leer el diff + el código
   actual con sus propias tools. Cada lente reporta SOLO su tipo de defecto, con `archivo:línea`,
   escenario concreto de entrada→salida incorrecta, y nada de estilo/refactors. Los lentes:

   - **correctness** — bugs que cambian el resultado: bordes, null vs 0, orden de precedencia,
     estados no manejados, condiciones de carrera entre lecturas independientes.
   - **seguridad** — auth/control de acceso: fail-closed real, comparación timing-safe de tokens,
     read-only que no puede mutar, inyección de token solo en la ruta correcta, fuga de secretos
     en logs/errores. Vector de ataque concreto: quién, con qué credencial, logra qué.
   - **integración de tools** — si el diff toca tools de OpenClaw, verificá los 7 puntos de
     registro (ver invariante I5). La trampa `semantic_*` (definida pero fuera de
     `openClawToolNames()`, invisible al modelo un mes) NO se puede repetir.
   - **cobertura de tests** — ¿los tests nuevos protegen las invariantes de abajo, o dan falsa
     seguridad? Buscá ramas sin test, tests tautológicos, y fixtures que comparten la suposición
     equivocada del código (la lección del wire de Bedrock). Corré los tests y confirmá que pasan.
   - **invariantes de dominio** — las reglas de la sección siguiente, una por una, con el diff en
     la mano. Este lente es el que un code-review genérico no tiene.

3. **Verificación adversarial.** Por cada hallazgo que sobrevive, verificá el escenario contra el
   código real (leelo, no asumas) antes de reportarlo. Si podés, reproducilo (un test mínimo, o
   corriendo la función). Un hallazgo plausible-pero-falso es peor que ninguno: descartalo si no
   se sostiene. Marcá cada hallazgo confirmado como CONFIRMADO (reproducido) o PLAUSIBLE (razonado
   pero no reproducido).

4. **Reporte rankeado.** Dedup entre lentes (el mismo bug lo encuentran dos). Ordená por gravedad:
   ALTA (viola una invariante de dominio / cruza el umbral permanente / rompe fail-closed),
   MEDIA (correctness real sin impacto de umbral), BAJA (UX, hardening, edge de baja probabilidad).
   Para cada uno: `archivo:línea`, una frase del defecto, el escenario concreto, y el fix sugerido.
   Cerrá con qué invariantes quedaron SIN cubrir por tests.

## Las invariantes de dominio (lo que NO se puede violar)

Estas son las reglas que costó sangre aprender. El lente de dominio las chequea una por una.

- **I1 — Fail-closed de la cuota.** Una bandeja que no está medida-y-entregando vende 0. Rojo
  (cola atascada, bloqueo, rechazo, umbral cruzado) → `hoyPuede: 0`. Gris (sin medir, conflicto,
  sin binding) → 0. Verde sin cuota asignada → 0. NUNCA un número por defecto. Ningún camino nuevo
  puede devolver `hoyPuede > 0` sin una medición verde detrás.

- **I2 — El cruce del umbral permanente es irreversible y gana SIEMPRE.** Cruzar ~5.000/día a
  Google clasifica el dominio para siempre. Por eso: (a) `cruzados` se evalúa ANTES de la lectura
  de salud y de la rampa, y NO puede quedar detrás de un gate de otra lectura (viene de la lectura
  de volumen, independiente de la de salud). Ojo: `sin_binding` y `conflicto` sí se resuelven antes
  y devuelven gris — sigue fail-closed (0 en todos los casos y `cruzados` se preserva en `base`),
  pero un dominio cruzado-y-en-conflicto muestra "en conflicto", enmascarando el motivo más grave;
  no es una violación de fail-closed pero vale marcarlo. (b) Un cruce conocido NUNCA se olvida
  entre corridas (cruce pegajoso: se une con la medición previa, solo se agrega). (c) Nada — ni una
  rampa activa — puede vender cupo sobre un dominio cruzado.

- **I3 — No doble-envío en warmup.** Mientras una bandeja calienta, la rampa YA envía su cupo
  (runBatch → sendmail). NFC debe vender 0 en esa bandeja (`hoyPuede: 0`), o el dominio recibe el
  volumen de la rampa MÁS el de NFC y cruza el umbral. El cupo de la rampa es solo informativo.

- **I4 — Null con motivo, nunca 0.** Un dato que no se pudo medir es `null` con el motivo al lado,
  jamás `0` (un 0 se lee como "todo bien" / "no rebota nada"). Aplica a contadores de entrega, a
  `medidoEn`, y a "volumen no leído" (que NO es "cero cruces").

- **I5 — Paridad del catálogo de tools (7 puntos).** Una tool de OpenClaw nueva debe estar en:
  (1) el union `OpenClawToolName`, (2) el objeto `toolDefinitions`, (3) la lista
  `openClawToolNames()` — la que VE el modelo, (4) el handler de ejecución en `tool-use-processor`,
  (5) `isReadOnlyToolUse` si es de lectura, (6) el `permission(...)` en `main.ts`, (7) el
  `paramSchema` en `skill-schemas`. Si es de diagnóstico, además en `WARMUP_DIAGNOSTIC_TOOLS`.
  **CUIDADO — el test de paridad NO alcanza:** `openclaw-tools-builder.test.ts` solo cubre los
  puntos 1-3 (nombres) y 7 (paramSchema). Los puntos 4, 5 y 6 son MANUALES y no tienen test. La
  falla grave y silenciosa es el punto 5 al revés: **una tool de ESCRITURA marcada por error como
  read-only en `isReadOnlyToolUse` saltea el ApprovalGate** y nada automático lo caza. Verificá esa
  lista a mano: toda tool en `isReadOnlyToolUse` tiene que ser `permission(..., "allowed_read_only")`
  y no mutar; cruzá contra `severity` y el handler (que debe rutear a un GET). Y todo payload que
  la tool devuelve debe caber en el límite (4096 chars) — si no, se trunca a JSON roto y el modelo
  trabaja con datos a medias; usar la proyección compacta.

- **I6 — El techo se rechaza, no se clampa.** Superar el techo diario (default 2.000, tope
  absoluto 4.000) se rechaza con error explícito, nunca se recorta en silencio (un recorte
  callado le miente al operador sobre lo que guardó). El techo capa lo que se SIRVE, siempre.

- **I7 — La escritura es fail-closed contra el token del operador.** Cambiar cuota exige el token
  del emisor OpenClaw; la llave de sólo-lectura (NFC) NUNCA alcanza para escribir. Cada cambio va
  al audit log con antes/después. El `action` del audit debe llevar puntos
  (`^[a-z]+(\.[a-z]+)+$`) o revienta con `schema_mismatch` — y los tests con audit fake NO lo
  cazan, solo el camino de producción.

## Alcance de las invariantes: hoy es FÁBRICA (cuota/medición/warmup/tools)

I1–I7 son de la fábrica. Los otros 4 lentes (correctness, seguridad, tools, tests) sirven para
cualquier cambio bajo apps/packages, pero el lente de dominio **no tiene nada que chequear** en un
cambio de DNS o Webdock, y ahí el gate degrada a un code-review genérico de 4 lentes. Si el diff
toca `routes/dns-*`, `route53-*`, `webdock-*`, `smtp-provisioning*` u otros subsistemas fuera de
cuota/medición/warmup, decilo explícito en el reporte: *"lente de dominio no aplica a este scope"*,
y NO des falsa confianza de que las invariantes de la fábrica lo protegen. Extensión pendiente
(materia prima ya en la memoria del proyecto): packs `INV-DNS` (NS autoritativo, no regenerar DKIM
en silencio, zoneId no-stale) y `INV-WEBDOCK` (rol PRIMARY/OPS fuente única, fail-clean multicuenta,
`serverAccountId` solo Webdock), seleccionados por lo que toca el diff.

## Regla de oro

Verificá por el camino de producción, no por fuera. Un test que comparte el error del código no
salva de nada. Un `npm test | tail` devuelve el exit de `tail` (0) y oculta fallas: corré el gate
a archivo y chequeá el exit real + `grep "not ok"`.
