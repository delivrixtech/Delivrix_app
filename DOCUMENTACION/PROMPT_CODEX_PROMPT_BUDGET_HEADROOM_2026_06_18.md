# BRIEF CODEX — Crear headroom en el budget del system-context (trim seguro)

Fecha: 2026-06-18 · Auditado en código por Claude · Ejecuta: Codex con subagentes · Rama: `produ`.

## Problema
`scripts/openclaw/build-system-context.sh` impone `TOKEN_EST = CHAR_COUNT/4 ≤ 11800` (`:314/:326`) y `AGENTS_CHARS ≤ 11500` (`:330`). Tras el fix de ruteo MXtoolbox (`7449def`) quedamos en **11796/11800 — 4 tokens de aire**. La próxima adición al prompt (regla, provider nuevo tipo Contabo/multi-provider 5.12, skill) **rompe el build**. Hay que crear margen, **sin degradar** el comportamiento del agente.

## GOTCHA CRÍTICO — qué se embarca (NO es el `.md` entero)
El bundle `.audit/system-context.txt` (lo que lee el bridge Bedrock, `openclaw-bedrock-bridge.ts:214/871`) se **arma extrayendo SECCIONES de 6 docs** (`build-system-context.sh:73-130`, función `section()`):
1. `OPENCLAW_SYSTEM_PROMPT.md` → **solo `## 4. System prompt literal`** (líneas ~37-331 del `.md`). El changelog, `## 5 Anotaciones`, `## 8 Ejemplos`, etc. **NO se embarcan** → trimearlos no baja el cap.
2. `OPENCLAW_PERMISSIONS_MATRIX.md` → §2 categorías + §3 matriz literal (ya `compact_lines(..., 5600)`) + §7 gates.
3. `OPENCLAW_SKILLS_CATALOG.md` → §3 skills iniciales + §6 gates.
4. `NORTE_OPERATIVO_DELIVRIX.md` → definición + regla principal + qué debe hacer + gates.
5. `OPENCLAW_DELIVRIX_API_CONTRACT.md` → §2 topología + §3 dir A + §4 dir B + §10 gates.
6. `OPENCLAW_VERIFICATION_PROTOCOL.md` → §1-§5.

→ El peso real está repartido entre esas 6 fuentes. **El trim debe ocurrir DENTRO de las secciones embarcadas**, no en partes del `.md` que no shippean.

## Objetivo
Bajar `TOKEN_EST` a **≤ ~11450** (≥ ~350 tokens de headroom) trimando **redundancia**, sin tocar contenido load-bearing.

## FASE 1 — MEDIR (subagente, no adivinar)
Instrumentar/medir la contribución por sección al bundle: para cada una de las 6 fuentes, el largo (chars) de la(s) sección(es) que `build-system-context.sh` extrae. (Se puede correr el script y agregar prints temporales del `len()` por bloque, o computar las mismas `section()` en un script aparte.) Entregar un ranking "sección → chars → % del bundle". Eso dice dónde recortar con impacto real.

## FASE 2 — TRIMEAR (redundancia, no sustancia)
Recortar dentro de las secciones embarcadas: frases duplicadas, instrucciones repetidas entre docs, ejemplos verbosos comprimibles, prosa redundante. Palancas adicionales: ajustar los presupuestos de `compact_lines` (p.ej. el `5600` de la matriz) si hay holgura semántica.

**NO TOCAR (load-bearing — romper esto es peor que el cap):**
- Gates: §7 de permisos, §6 de skills, gates de norte, §10 de API, y `[10] Disciplina del flow real` + `[13] Reglas naming` dentro de §4.
- La **regla de ruteo MXtoolbox** recién agregada (`7449def`): blacklist/reputación → `read_mxtoolbox_health`.
- Listas canónicas de proveedores (Webdock/Contabo/Route53/IONOS/Porkbun) y reglas de naming anti-spam.
- La matriz de permisos en lo que define categorías/decisiones (compactar formato sí, borrar filas no).

Si algún recorte cae en el §4 embebido del AGENTS bootstrap (`build-system-context.sh:133-135`), sincronizar esa copia (dual-source).

## FASE 3 — REBUILD + VERIFICAR (DoD; sin adivinar)
- `bash scripts/openclaw/build-system-context.sh` pasa con `TOKEN_EST ≤ ~11450` y `AGENTS_CHARS ≤ 11500`. Reportar el número final.
- **Regresión obligatoria** (trimear un prompt load-bearing es delicado): un subagente hace `diff` semántico antes/después y marca cualquier pérdida de sustancia; correr el smoke + 2-3 turnos reales por `/v1/openclaw/chat/send` incluyendo la prueba de ruteo MXtoolbox ("¿está en blacklist X?") → sigue usando `read_mxtoolbox_health`, gates intactos.
- Restart del gateway; `HTTP 200`. Local-only (panel canónico) salvo que se decida pushear a Hostinger.

## Alternativa a evaluar (no aplicar a ciegas)
Subir `MAX_CONTEXT_TOKEN_EST` por encima de 11800. El cap existe por el presupuesto de Capa 1 del container; subirlo cambia cuánto contexto fijo carga el agente. Si Codex lo propone, que **documente el rationale** (por qué es seguro para la ventana del modelo y el container) en vez de bumpearlo sin más. Preferible el trim.

## Subagentes (como pide el CTO)
(1) Medición por sección de las 6 fuentes. (2) Trim de redundancia + ajuste de `compact_lines`. (3) Regresión (diff semántico + smoke + ruteo MXtoolbox + gates). Cambios mínimos, sin tocar secretos/artefactos (`.audit/*`, `config/*.bak-*`).
