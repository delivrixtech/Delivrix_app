# Roadmap del runtime multi-agente — 2026-07-28

Objetivo de producto: **varios subagentes de IA calentando bandejas y creando SMTPs en
simultáneo, sin cometer errores.**

Este documento es el plan de ejecución. Cada hito dice qué entra, qué NO entra, y cómo se prueba.

- Rama base: `produ` (`85c46ff`)
- Runtime existente: `apps/gateway-api/src/agents/` — 2123 líneas, 31 tests en verde
- Decisión E-08 (2026-07-28): **se termina, no se borra**

---

## Dónde estamos parados

Lo medido, no lo supuesto:

| | Estado |
|---|---|
| El runtime está construido y testeado | ✅ 6 módulos, 31 tests verdes |
| `main.ts` lo instancia | ❌ no importa nada de `agents/` |
| Los 5 system prompts existen | ❌ ninguno de los 5 está en el repo |
| Las 55 tools declaradas tienen handler | ❌ **cero**. Los nombres son inventados |
| Hay 45 tools reales y probadas | ✅ en `openclaw-tools-builder.ts` |

**El trabajo es re-apuntar, no construir.** Excepto tres cosas que sí son nuevas: el cliente
Bedrock del agente, el fan-out, y el mecanismo de delegación (este último, mucho más adelante).

### La restricción que define la arquitectura

**Managed Agents de Anthropic no está disponible en Amazon Bedrock.** No hay atajo hospedado:
el harness de orquestación tiene que ser propio. Eso valida que terminar `agents/` es el camino.

---

## El principio que ordena todo el roadmap

Los dos casos de uso tienen propiedades **opuestas**, y confundirlos es lo que produce errores:

| | Paralelismo | Por qué |
|---|---|---|
| **Diagnóstico y warmup por dominio** | ✅ real | Cada dominio es independiente: no comparten recursos |
| **Creación de SMTPs** | ❌ falso | Comparten cuota de Route53, zonas DNS, asignación de IP y un ApprovalGate que asume **un** actor |

No se resuelve con un prompt mejor. Se resuelve **partiendo el trabajo para que no colisione**, y
donde deba colisionar, poniendo una cola con lease — que ya existe escrita
(`acquireSmtpRunStateLock`, lease de 40 min).

---

## FASE 1 · Abanico de diagnóstico (read-only)

**Un agente por dominio, N en paralelo, cero escrituras.**

### Por qué diagnóstico y no warmup

El planteo original era "un agente por dominio calentando bandejas". **Se cayó al medirlo:**

| tool | estado real hoy |
|---|---|
| `send_real_email` | **apagada** — `SMTP_SEND_REAL_EMAIL_ENABLE=false`. Ni entra al catálogo del modelo |
| `seed_warmup_pool` | **no-op permanente** — 65/65 runs en `status:'started'` y el tipo solo admite ese valor: el run nunca transiciona, la idempotencia es para siempre |
| `read_delivery_reason` | funciona |

Un agente con una tool que anda no es un agente. Y las dos que escriben piden **una firma humana
por llamada**: 30 dominios = 30 modales.

### Lo que entrega

Responde la pregunta que hoy está abierta: **Gmail rechaza el 59% de la flota con `550-5.7.1` y
todas las IPs están limpias en listas negras — ¿por qué?**

Un agente por dominio que lee el `mail.log` real y distingue los dos modos de falla ya
documentados: **nodo incomunicado** (la VM corre, el proveedor la da `running`, pero perdió la
red) vs **rechazado por destino** (reputación interna de Google, invisible al chequeo de
blacklists).

El multi-agente arranca dando una respuesta que no tenemos, no un demo.

### Las 5 tools del Warmup Senior

Verificadas como habilitadas en el env canónico, read-only, sin ApprovalGate:

```
read_smtp_reachability   ¿el nodo puede ENTREGAR? inbound vs outbound separados
read_delivery_reason     el DSN/código SMTP real del mail.log, por messageId
read_dkim_status         SPF/DKIM/DMARC efectivamente publicados
read_mxtoolbox_health    blacklists — para poder DESCARTARLAS con evidencia
inspect_smtp_inventory   estado declarado del dominio/servidor
```

Registry: 16+9+10+**5**+12 = **52** tools (era 55).

### Hitos

| # | Hito | Entrega |
|---|---|---|
| **M1** | Fan-out + executor + fuente de dominios, con `MULTI_AGENT_MODE=mock` | **El mapa de la flota, sin cliente Bedrock.** El `MockAgentModelClient` corre una secuencia guionada de las 5 tools contra los 59 dominios. No razona, pero prueba fan-out, semáforo, executor y las tools reales de punta a punta — y produce el dato |
| **M2** | Cliente Bedrock del agente + traducción de turns | El agente razona de verdad. Es la mitad del riesgo del proyecto |
| **M3** | Hardening de `agents/` | try/catch en la invocación, `delete` de sesiones, `abortSignal`, `maxIterations`, `promptPath`, actor `supervisor` |
| **M4** | System prompt + ruta + montaje en `main.ts` | `POST /v1/openclaw/agents/warmup/audit` |
| **M5** | Dry-run escalonado nivel 0 → 1 → 2 | 1 dominio, después 4, después la flota |

**M1 es el camino corto a valor.** Si querés validar antes de invertir en el cliente Bedrock,
M1 solo ya te da el mapa de la flota.

### Estimación honesta

~6 días de trabajo. El 50% del riesgo está en M2 (el cliente Bedrock no existe); el resto es
mecánico porque `processToolUse` ya resuelve validación, kill switch y gating.

### Gates que respeta

1. **Kill switch** — gratis: `processToolUse` lo lee fail-closed antes de cada tool
2. **Semáforo obligatorio** — esas tools abren SSH contra la flota y **no hay pool en ningún
   lado**. Arrancar en **4**, medir, subir. Nunca 59
3. **Filtro del event bus** — `appendMany` relee el archivo entero para el prevHash y ese
   archivo pesa 6.5 MB. Sin filtro, ~1000 appends serializados
4. **Resultado por ítem, nunca agregado** — el camino de delegación devuelve `ok` aunque la
   hija falle; el fan-out no lo usa

### NO entra en la Fase 1

Ningún envío · ninguna delegación · los otros 4 roles siguen con nombres inventados · no se
cablea el canvas · no se tocan el panel ni el daemon LIVE · sin persistencia de sesiones ·
sin retry de Bedrock.

---

## FASE 1.5 · Aislar el estado por dominio

**Prerequisito de cualquier escritura.** Hoy "sin estado compartido" es falso:

| Recurso compartido | Consecuencia |
|---|---|
| `warmup-progress.json` es un archivo único global | Ver el bug de abajo |
| Los gates del daemon LIVE son globales, no por dominio | **Un dominio en spam pausa a los otros 58** |
| Una sola casilla Gmail de medición y una sola credencial OAuth | Cuello de botella y punto único de falla |

### 🐛 Bug encontrado, independiente del multi-agente

**Iniciar un warmup destruye todas las rampas activas.**

`openclaw-workspace.ts:424` lee las rampas de `inventory.ramps`. Y `warmup.ts:426` escribe:

```js
updateInventoryJson("warmup-progress.json", (current) => ({
  runs: [ ...current?.runs, input ]     // ← devuelve SOLO runs
}))
```

Objeto nuevo con **únicamente `runs`**: toda otra clave del archivo se borra en silencio. Cada
`seed_warmup_pool` se lleva puestas las rampas, y el `resumeRampsOnStartup()` del arranque
encuentra el archivo vacío.

**Ojo con la lectura tranquilizadora:** en el ledger figura que `ramps` está vacío y se usó como
"no hay nada corriendo, momento barato para decidir E-05". Puede que hubiera rampas y se hayan
perdido. **No es verificable** — no hay forma de saber si existieron — pero la conclusión era
ingenua.

Fix: una línea (`...current, runs: [...]`). Va aparte, no espera a la Fase 1.5.

---

## FASE 2 · SMTP en cola

**Los agentes se despachan en paralelo pero pasan por `acquireSmtpRunStateLock` antes de tocar
un recurso compartido.** Concurrencia acotada, no libre.

Lo que hay que resolver antes:

- **El ApprovalGate asume un actor.** N agentes pidiendo firma a la vez no está contemplado
- **`findRecentApproval` no consume el token** y la ventana es de 15 min → **una firma habilita
  N arranques**. `send-email.ts:251-258` ya lo arregló para su camino; warmup no
- **Cuotas de proveedor** — Route53 ya pegó contra `DomainLimitExceeded`

---

## FASE 3 · Delegación y QA

El orquestador reparte, y el **QA-Security Senior verifica lo que los otros afirman antes de
pedir firma**. Es lo que convierte "varios agentes" en "varios agentes que no meten la pata".

El patrón está validado: en la auditoría de esta rama, 6 lentes produjeron 44 hallazgos y un
refutador por hallazgo dejó **7**. Los 37 falsos positivos los filtró la estructura, no la
inteligencia del modelo. Sin esa capa, cinco de los fixes propuestos habrían roto producción.

Requiere el mecanismo de delegación (`delegate_to_*`), que no existe, y los 4 system prompts
restantes.

---

## Deuda que bloquea el escalado, medida

| Deuda | Dónde | Impacto |
|---|---|---|
| El bridge manda `temperature: 0.3` | `openclaw-bedrock-bridge.ts:1006` (default `:62`) | **Bloquea subir de modelo.** En Sonnet 5 y Opus 4.7+ un `temperature` no-default devuelve 400 |
| Modelo clavado en Sonnet 4.6 | `config/gateway.env` | Generación anterior. Sonnet 5 alcanza calidad casi-Opus en trabajo agéntico al mismo costo |
| `max_tokens: 4096` | `openclaw-bedrock-bridge.ts:61` | Corto para agentes que razonan y llaman tools. Y el tokenizer nuevo cuenta ~30% más |
| Sin retry/backoff de Bedrock | ningún lado | Un 429 = sesión muerta |
| El audit log pesa 6.5 MB y se relee entero por append | `local-file-audit-log.ts:39` | Cuello de botella del fan-out |

**El del `temperature` conviene resolverlo antes de poner 5 agentes en producción**, no después:
es de una línea, pero arrastra rebaselinear `max_tokens` con `count_tokens` y revisar que el
default de `thinking` cambia (en Sonnet 5, omitirlo = adaptive encendido).

---

## Cómo se prueba que no manda correo

Tres niveles, en orden:

| Nivel | Qué | Riesgo |
|---|---|---|
| **0** | `MULTI_AGENT_MODE=mock` + `fetchImpl` con fixtures | Cero red. Es el gate de CI |
| **1** | Bedrock real + infraestructura mock | El modelo entiende los schemas. No toca la flota |
| **2** | Todo real, **1 dominio**, `concurrency: 1` | Solo sesiones SSH de lectura |

**Prueba de que es dry-run y no una promesa:** `.audit/audit-events.jsonl` no debe tener ni un
`oc.warmup.*` ni un `oc.send.*` — solo `oc.agent.*` y los reads. Y `SMTP_SEND_REAL_EMAIL_ENABLE`
sigue en `false`, así que aunque el modelo pidiera la tool, `processToolUse` la rechaza como
`tool_disabled` antes de cualquier red.
