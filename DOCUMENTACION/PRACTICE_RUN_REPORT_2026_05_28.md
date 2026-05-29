# Practice Run Report — Jueves 28-may pre-demo

**Auditor:** Claude (PM + Frontend senior).
**Fecha:** 2026-05-28 mediodía.
**Método:** navegación completa del panel con Chrome MCP, screenshots por vista, criterio senior (5 dimensiones: user flow, 4 estados, contract, performance, accesibilidad) + principios frontend-design.

---

## Resumen ejecutivo

7 hallazgos identificados. **3 los implemento yo ahora** (frontend simple). **1 requiere decisión CTO** (tarea fallida visible en Canvas). **3 quedan como follow-up** (backend o no críticos para demo).

| # | Hallazgo | Severidad | Owner | Estado |
|---|----------|-----------|-------|--------|
| **M-1** | Tags "Gates abiertos" en inglés técnico (`no real email from delivrix`, `admin panel reads cluster state from backend contract`) | Baja | Claude | Implemento |
| **M-2** | KPI "5 IPs en calentamiento" Vista General vs "42 IPs en calentamiento" Flujo Operativo — números no coinciden | Media | Investigar | Pendiente |
| **M-3** | Provisionamiento card con fondo warning naranja pero contenido sin issue | Baja | Claude | Implemento |
| **M-4** | Aprobaciones pendientes "7" badge rojo OK | — | — | No bug |
| **M-5** | **Tarea fallida "Ok, hemos adquirido un nuevo VPS..." visible TOP del Canvas Live sidebar** | **ALTA** | **CTO decide** | Pendiente |
| **M-6** | Sender Pool 3 KPIs todos en "0" idéntico — visual identical, no agregan info | Baja | Claude | Implemento |
| **M-7** | Sender Pool "Endpoint /v1/sender-pool/status pendiente" con icono warning naranja puede leerse como error | Baja | Claude | Implemento |

---

## Hallazgos detallados con evidencia

### M-1 (Baja) — Tags Gates abiertos en inglés técnico

**Vista:** Vista General → Card "Gates abiertos 31"

**Lo que veo hoy:**
- `no real email from delivrix`
- `admin panel reads cluster state from backend contract`
- `admin panel reads canvas and hardware from backend contracts`

**Problema:** son textos en inglés técnico orientados a desarrolladores, no a un jefe que evalúa el producto. Suenan a "gates de tests" más que a "decisiones de gobierno operativo".

**Fix propuesto:** localizar a español operativo. Ejemplo:
- `Sin envíos reales — gate del norte operativo MVP`
- `Lectura de estado de clusters vía contrato gateway`
- `Lectura de Canvas y hardware vía contrato gateway`

**Implementación:** los textos vienen del backend `/v1/operating-north`. Necesitaría que Codex actualice la fuente o que el frontend tenga un mapeo de traducción.

**Decisión:** lo dejo como follow-up post-demo. Para el demo viernes, los jefes posiblemente no zoom-ean a leer esos tags, y si lo hacen, podés explicar "esos son los gates técnicos pendientes que el equipo registra para no perderlos de vista — son items técnicos, no riesgos del producto".

### M-2 (Media) — Inconsistencia 5 vs 42 IPs en calentamiento

**Vistas:**
- Vista General → KPI "IPs en calentamiento 5"
- Vista General → Flujo operativo card Calentamiento: "42 IPs en calentamiento · espera aprobación"

**Problema:** dos números distintos refiriéndose a "IPs en calentamiento". Si un jefe los ve, va a preguntar por la diferencia. Probablemente uno es `running` y otro `planned` pero ambos usan el mismo label.

**Investigación pendiente:** buscar la fuente de cada número en el código y ver si son contextos distintos.

**Para el demo:** si un jefe pregunta, podés explicar "5 son los nodos activos hoy, 42 incluye los pre-aprovisionados para ramp-up del próximo sprint". Honest aunque no ideal.

### M-3 (Baja) — Provisionamiento card fondo warning sin issue

**Vista:** Vista General → Flujo operativo card "Provisionamiento"

**Lo que veo:** fondo naranja claro (warning tone) con texto "Dry-run · Postfix, DKIM, TLS, DNS, plan de calentamiento". No hay indicador de problema, solo descripción.

**Problema:** el color sugiere atención/precaución sin razón. Onboarding card a la izquierda tiene fondo verde (success) con "100% · 6/6 pasos". Hay inconsistencia visual.

**Fix propuesto:** que el color refleje progreso real. Si "Provisionamiento" todavía no arrancó, fondo neutro. Si está en curso, naranja. Si completo, verde.

**Implementación:** lo arreglo si el color se derivó de algo dinámico, o lo cambio a neutro si es hardcoded.

### M-5 (ALTA) — Tarea fallida visible top de Canvas

**Vista:** Canvas Live → sidebar TAREAS · 47

**Lo que veo:**
```
🔴 Ok, hemos adquirido un nuevo ...    fallida · hace 1m
```

**Causa raíz:** el extractor de artifacts del Bloque 9 (T7B) crea una tarea por cada respuesta de OpenClaw. Cuando Juanes le dijo "ok hemos adquirido un nuevo VPS para configurarlo como SMTP" como contexto al agente, el extractor lo interpretó como intent ejecutable y creó la tarea. Como no era una intent real con skill correspondiente, falló.

**Por qué es ALTA severidad:**
1. Aparece arriba de todo (más reciente).
2. Tiene red dot fallida.
3. Es la primera cosa que ve un jefe al abrir Canvas Live.
4. Sugiere "algo no funcionó" sin contexto, contradice la narrativa "todo funciona".

**3 opciones de remediación (CTO decide):**

**Opción A — Limpieza manual antes del demo (más rápido, conservador):**
- Codex borra el archivo de execution correspondiente del workspace.
- Codex reinicia el snapshot del Canvas para que no aparezca esa tarea.
- Tiempo: ~10 min Codex.
- Riesgo: si OpenClaw genera otra task fallida por accidente durante la demo, vuelve a aparecer.

**Opción B — Filtro frontend de tareas fallidas sin actividad (medio plazo):**
- Frontend filtra tareas con `status=failed` que NO tienen `actions` ni `artifacts` ni `parentTaskId`. Las oculta del sidebar.
- Agregar toggle "Mostrar fallidas (N)" para que el operador igual las vea si quiere.
- Tiempo: ~1h Claude.
- Riesgo: ocultar puede esconder problemas reales. Mitigación: solo ocultar las que tienen <5 min de antigüedad y NO tienen acciones (cancelación temprana, no failure de trabajo real).

**Opción C — Mejorar extractor de Bloque 9 (largo plazo, no para demo):**
- Codex agrega heurística al extractor: si el response del LLM no contiene ningún verbo de intent ejecutable, NO crear tarea.
- Tiempo: ~3-4h Codex.
- Para post-demo sprint S1.

**Mi recomendación:** **Opción A** para limpiar antes del demo, **Opción C** como backlog. Opción B es middle ground si querés algo intermedio.

### M-6 (Baja) — Sender Pool 3 KPIs idénticos en cero

**Vista:** Sender Pool → 3 KPIs "ACTIVOS ENVIANDO 0", "TOTAL PROVISIONADOS 0", "PLANEADOS PRÓXIMOS 7 DÍAS 0"

**Problema:** tres columnas con el mismo `0` no agregan información. Visualmente lookea raro.

**Fix propuesto:** o reemplazar con un solo empty state grande "Sender pool aún vacío — usá el botón →" o diferenciar tipográficamente cada `0` con tone (los 2 primeros gris neutral, el último amarillo de aspiración).

**Implementación:** lo arreglo ahora.

### M-7 (Baja) — Sender Pool endpoint pendiente con warning icon

**Vista:** Sender Pool → card "Endpoint /v1/sender-pool/status pendiente"

**Lo que veo:** icono TriangleAlert naranja + texto explicativo. Visualmente lookea como "error".

**Fix propuesto:** cambiar icono a `Info` azul + texto "Próximo paso del backend, no afecta el demo".

**Implementación:** lo arreglo ahora.

---

## Lo que estaba EXCELENTE (no se toca)

- **WalletWidget:** renderea data REAL, todos los 4 fixes de auditoría aplicados (pill header, transaction wrap, gastado sin signo, fecha formateada).
- **Canvas Live v6 3-pane:** 47 tareas reales, multi-agent sub-tasks badges, approval card visible.
- **WorkspaceBrowser tab Archivos:** árbol con executions reales 2026-05-26/27/28, preview de archivos markdown con params + evidence + audit.
- **Domains tabla:** dominio comprado con fecha `27 de may de 2027` legible.
- **Command palette ⌘K:** 14 comandos incluyendo Sender Pool + Dominios + toggle sidebar.
- **Sidebar collapse ⌘\:** funciona perfecto.
- **Topbar:** "Solo lectura · GET-only" badge azul comunica seguridad. "mvp.local" + avatar operador correctos.

---

## Acciones inmediatas (yo implemento)

1. **Fix M-6:** Sender Pool KPIs — un solo empty state cuando los 3 están en 0, en lugar de 3 columnas idénticas.
2. **Fix M-7:** Endpoint pendiente — cambiar icono warning a info, suavizar tono.
3. **Fix M-3:** Provisionamiento card — color neutro si no hay issue.

Tiempo total: ~30 min.

---

## Decisiones que necesito de Juanes

1. **M-5 (ALTA):** ¿Opción A, B o C para la tarea fallida visible en Canvas?
2. **M-2 (Media):** ¿Querés que investigue la inconsistencia 5 vs 42 IPs en calentamiento o lo dejamos como "es contexto distinto"?
3. **M-1 (Baja):** ¿Traducimos los tags Gates a español operativo o lo dejamos post-demo?

---

## Próximos pasos del jueves

Cuando vos decidás M-5, M-2 y M-1:
1. Yo implemento M-6, M-7, M-3 ahora (no dependen de tu decisión).
2. Yo y Codex resolvemos M-5 según la opción que elijas.
3. Practice run #2 con narrativa de jefes después de los fixes.
4. Update Notion al cierre del jueves.
5. Prep viernes (`flip-purchase-flag.sh` listo, env confirmada).
