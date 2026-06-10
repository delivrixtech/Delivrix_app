# Diseño profundo: conectar cuentas/proveedores a Delivrix (7 agentes, 2026-06-09)

Investigación profunda (read-only) sobre cómo agregar cuentas/proveedores VPS de forma fácil **y segura**. Va mucho más allá del análisis previo (`ANALISIS_MULTI_PROVIDER_CONEXIONES_2026_06_09.md`): diseña el motor de selección, el porqué de deliverability, la UX real, un prototipo concreto, el modelo operativo, secretos a escala, y la matriz por proveedor.

## TL;DR — el reframe importante
"Agregar una cuenta fácil" es la mitad **chica y fácil** (registry + CLI). El **valor real y el trabajo real** están en otras dos capas que el análisis previo no desarrolló:
- **El MOTOR DE SELECCIÓN** (decidir EN QUÉ cuenta/proveedor construir cada SMTP) — hoy NO existe; el `provider` es decorativo y todo va a una sola cuenta.
- **La COLUMNA VERTEBRAL operativa** (account ↔ server ↔ sender-node) — hoy NO existe; por eso aparecen los 6 sender huérfanos y por eso el drift es single-account.

Y el **PORQUÉ** no es capacidad — es **aislamiento de reputación y blast-radius**. Con una sola cuenta/ASN, un solo evento de reputación (blacklist de rango, política de puerto 25, queja de un cliente) hunde a **todos** los clientes a la vez. Multi-cuenta/proveedor es supervivencia del producto, no optimización.

Las 3 capas: **(1) Registrar** (fácil — CLI) → **(2) Enrutar/Seleccionar** (el valor — selección deliverability-aware) → **(3) Operar** (la columna account↔server↔sender + drift + capacidad).

---

## 1. PORQUÉ multi-cuenta/proveedor (deliverability — el norte que guía todo)
Delivrix hace **cold outbound desde dominios frescos en VPS propios** (sin los IP pools de Google/MS que dan trust heredado). Eso hace que la diversidad sea **load-bearing**, no opcional. El blast-radius escala por capa:
- **IP** (gatekeeper de aceptación SMTP): una IP en blacklist → rechazo. Dedicada = controlás vos.
- **/24 subnet**: `ivmSIP/24` lista rangos enteros — un vecino sucio arrastra tu /24.
- **ASN/proveedor**: el riesgo real NO es UCEPROTECT L3 (Gmail/Outlook NO lo consultan, expira en 7d) — es que **los propios mailbox providers hornean reputación de red/ASN en sus filtros opacos**. Un ASN de VPS barato saturado de spam carga peor baseline en Gmail, sin blacklist pública. Eso NO se ve con MXToolbox.
- **Reputación de dominio** (el sorter inbox/spam): domina el placement en Gmail; una IP limpia con dominio quemado igual cae a spam.

**Reglas que la selección DEBE imponer** (de la teoría a constraints):
- 1 IP dedicada por dominio (ya lo hace); **máx ~3 (tope 5) mailboxes/dominio, 30-50 envíos/inbox/día**.
- **Esparcir dominios nuevos entre ASN/proveedores/subnets** — nunca apilar en un ASN.
- **Aislamiento por cliente NO negociable**: nunca 2 clientes en la misma IP/subnet/dominio. El error más caro de las agencias es consolidar dominios ($10-50K/mes en pérdida + 40-60% caída de placement en días).
- **Burn-aware**: ~10-20% de dominios se queman al mes bajo carga; rotar antes de que dañen, **nunca reusar una IP quemada** (la cicatriz IP↔dominio persiste). → necesita un pool entre proveedores + una primitiva de retiro (que hoy NO existe).
- **Pre-flight puerto 25** (el killer silencioso): hoy `port25UnlockRequired` está hardcodeado y nunca se prueba.

**El caso estratégico:** multi-cuenta/proveedor es el sustrato que hace cumplibles (a) esparcir por ASN/subnet, (b) aislar por cliente, (c) rotar fuera de IPs quemadas. Sin la Capa 2 (selección), cuentas extra = filas de inventario inertes y el blast-radius single-ASN queda 100% expuesto.

## 2. El MOTOR DE SELECCIÓN (la parte difícil, hoy inexistente)
Hoy: paso 4 hardcodea `profile:"bit"`, `locationId:"dk"`, dispatcher → único `webdockOpsAdapter`. `provider` no selecciona nada. La selección va **antes del paso 4** y **congela** la elección en run-state.

**Algoritmo (filtro duro → score ponderado → tie-break determinista → fallback):**
- **Pin explícito:** si viene `accountId` → validar y honrar (solo vetar por seguridad: blocked/port25/full).
- **Filtros duros:** enabled; provider match; no-blocked; **port25 unlocked**; **capacidad** (servers usados < maxServers); región.
- **Score:** `0.45·diversidad + 0.30·headroom + 0.15·salud + 0.10·costo`. **Diversidad pesa más** (no clusterizar dominios de un brand en un /24 es el mayor self-own de deliverability).
- **Tie-break:** score → headroom → menos usados → `lastUsedAt` más viejo (round-robin) → accountId (estable).
- **Fallback ladder:** relajar región → si todos blocked/port25 → REJECT `no_validated_account` (con razones por cuenta, accionable) → si todos full → REJECT `all_accounts_full` → registry vacío/flag off → cuenta ops legacy (idéntico).
- **Split crítico pre-check/bind:** como se **paga el dominio en el paso 2**, el *gate* ("¿hay alguna cuenta usable?") corre **read-only en el paso 1**, antes de comprar; el *binding* (qué cuenta) en el paso 4. Así un "sin cuenta" no deja un dominio pago varado.
- **Pinning al resume:** una vez creado el server (paso 4), el run queda **soldado** a su cuenta (run-state `accountId` + inputHash). Falla mid-build → rollback + **run nuevo** (nuevo runId + re-firma), NO migración silenciosa (rompería exactly-once + el scope firmado). Esto calza con la máquina de resume existente.
- **Scope de aprobación liga a `accountId`** (no solo `provider`): el `scopeHash` incluye accountId → cambiar de cuenta **fuerza re-firma**. Drift-check gana la dimensión accountId.

**Modelo de datos (3 fuentes, cada una su verdad):** registry = *política* (qué se permite, tope, defaults) · inventory = *realidad* (qué existe, cuán lleno, en qué subnet) · health-cache = *aptitud* (puede enviar ahora, último uso). **Capacidad = derivada (contar filas vivas), nunca un contador almacenado** (evita drift contador-vs-realidad).

## 3. UX para agregar — CLI gana (el boundary read-only del panel lo decide)
El panel es **read-only por diseño, enforced en DOS capas** (`vite.config.ts` dev + `server.mjs` prod; prod aún más estricto: solo sign/reject/canvas). Todos los writes que el panel hace llevan solo `{actorId, signature}` o `{reason}` — **nunca un secreto**. El código ya lo dice textual: *"El App Password jamás se envía desde el panel; el adapter lo carga del .env del gateway"*. Los secretos se leen **solo al boot, de `process.env`**; no hay endpoint de escritura de env ni hot-reload de secretos.

- **(a) CLI** — el secreto se escribe por prompt OCULTO directo a `.env.local` (chmod 600), nunca toca browser/proxy/logs/LLM. `provider test` valida con una lectura barata. **Más fácil + más seguro + repetible.** ✅
- **(b) Panel UI** — un form de *metadata* es factible (write allowlisted + audit, como kill-switch) pero **inútil solo** (la cuenta no autentica sin el secreto out-of-band). Un form que *tome el secreto* es **peligroso** (secreto por el proxy read-only + logs, o construir el endpoint de inyección de secretos que el gateway deliberadamente NO tiene = la peor superficie de ataque). **Net negativo** — mismos pasos reales que el CLI + 3 archivos + endpoint riesgoso.
- **(c) OpenClaw** — `register_provider_account` con metadata + **secretRef** (nunca el valor), vía ApprovalGate. Buena capa autónoma futura; no elimina el paste del secreto.
- **Híbrido** (panel da el snippet exacto de `.env.local` + comando de restart + botón "Validar" post-restart) = polish útil para multi-operador, pero strictly más código por el mismo paste manual.

**Recomendación:** **CLI ahora**; panel-guidance (metadata + validar) como polish futuro; OpenClaw metadata+ref como capa autónoma eventual. El acto irreducible (un humano pega el secreto en el env del host) el CLI lo hace lo más seguro (prompt oculto, chmod, gitignore-guard, validación read-only) y barato (un comando) posible.

## 4. Prototipo concreto (ver agente — artefactos, NO código commiteado)
Lo clave que el prototipo hace visceral: **una "cuenta Webdock" NO es una key — es un TRIPLE** (read/ops/account). Por eso `credsRef` es una forma POR-proveedor: Webdock=3 nombres env, Contabo=4 (OAuth), RackNerd=key+hash+panelUrl. Y el `WEBDOCK_API_KEY_TRABAJO` que ya tenés está MUERTO (ningún adapter lo lee); una 2ª cuenta real necesita SUS PROPIOS `_TRABAJO_READ/_OPS/_ACCOUNT`. El prototipo completo (JSON real + líneas .env + transcript del CLI + sketch TypeScript de `VpsProvider`/`ProviderAccount`/`ProviderRegistry`/wrapper Webdock) está en el reporte del agente — listo para copiar al armar el enabler.

## 5. Modelo OPERATIVO — la columna vertebral que falta (hallazgo importante)
**Hoy hay DOS formas de inventario que se contradicen** sobre si las cuentas existen: `WebdockServer` (adapter) SÍ tiene `accountId`; `WebdockInventoryServer` (contrato dominio) NO; `SenderNode` NO (solo `provider`, sin account ni link al server). `/v1/infrastructure/inventory` es multi-cuenta; `/v1/webdock/inventory` (que alimenta el DRIFT) es **single-account**. Y `webdock-servers.json` (servers reales) y `sender-nodes.json` (fixtures) están **disjuntos, sin clave que los una** — el drift FINGE que `senderNode.id === server.slug` (nunca cierto) → de ahí los **falsos huérfanos**.

**La columna que falta (prerequisito de TODO lo cross-account):**
1. `SenderNode.accountId` + `serverSlug` (la join real) + `WebdockInventoryServer.accountId`.
2. **El slug NO es único global** — `server10` puede existir en 2 cuentas. La clave real debe ser `provider:accountId:slug` (hoy todo dedupe por slug bare → colisión silenciosa).
3. `withAccount(provider, accountId)` resolver (hoy no existe — solo una lista) que los handlers de create/delete usan.
4. **Capacidad de flota** (servers usados vs maxServers) — hoy NO existe (solo capacidad de *envío* per-node). Feed al selector como filtro duro + blocker `account_full`.
5. **Drift cross-account**: alimentar el drift con TODAS las cuentas + join por `(accountId, serverSlug)`. Huérfano real = sin server en NINGUNA cuenta **y** todas las lecturas OK (si una cuenta está degraded → abstenerse, no falso-prune).
6. **Prune** (no existe primitiva): `prune_sender_node` tool + ApprovalGate, gated en huérfano-confirmado-cross-account + todas-las-cuentas-sanas + status terminal. (Resuelve los 6 huérfanos correctamente.)
7. **Clusters UI** agrupa por `provider` solo → un blob "Webdock" para todas las cuentas. Cambiar a `provider+accountId` → una card por cuenta con medidor de capacidad.

**Orden de dependencias:** (1) la columna account+slug → (2) fan-out de `/v1/webdock/inventory` → (3) drift cross-account → (4) prune tool → (5) capacidad+selector+Clusters. La topología (Canvas) puede quedar account-implícita hasta que haya builds concurrentes.

## 6. Secretos a escala
**Quedate con `.env.local` AHORA** (1 operador, 1 Mac, ~60 líneas, chmod 600, gitignored, `--env-file`) — la memoria del proyecto lo endosa y el diseño ya es "secrets-manager-ready" (todo lee `process.env`, el registry guarda NOMBRES no valores → esa indirección ES el seam de rotación). **Acción YA (10 min, sin migrar):** excluir `.env.local` de Time Machine/iCloud/rsync (el vector de leak #1 real). **Trigger para migrar** (cuando UNO dispare): el archivo debe salir del Mac / 2º operador / ~40-50 secretos / compliance. **Target: sops+age** (archivo cifrado en git, key age en Keychain, wrapper de 1 línea, CERO cambios de app, rotación git-native). **1Password** si hace falta sharing+GUI+audit. **Skip Doppler/Vault/AWS** mientras sea local-first (ponen cloud en el boot path).

## 7. Matriz por proveedor (14 pasos × 4) — el esfuerzo HONESTO
**Solo 3 de 14 pasos tocan el proveedor VPS (4 crear, 5 wait, 6 bind/PTR).** DNS (2/7/10/11) es Route53-fijo; el mail-stack (9-14) corre sobre un **SSH runner agnóstico** (funciona en cualquier proveedor con IP + key + sudo). PTR es **manual incluso en Webdock** (`setServerPtr` es un stub que devuelve `supported:false`; el orquestador ya hace skip best-effort y continúa).

| Proveedor | Crear | Borrar | rDNS API | Puerto 25 | Toques MANUALES | Veredicto |
|---|---|---|---|---|---|---|
| **Webdock** | API (2-call) | API | ❌ panel | ticket 24-48h | **2** (PTR + ticket) | path actual |
| **Contabo** | API (cloud-init) | API | ❌ panel | abierto + throttle 1-conexión | **2** (PTR + quizá ticket) | **adapter #2 (drop-in)** |
| **RackNerd** | ❌ **MANUAL (WHMCS)** | ❌ manual | ❌ panel | verificar/cuenta | **3** (incl. compra bloqueante) | adapter manage-only liviano |
| **SMTPVPS** | ❌ orden manual | ❌ manual | vendor | abierto (es el producto) | mail-stack gestionado | **NO es adapter** (se solapa con nuestra skill) |

**Capability flags** que necesita `VpsProvider`: `create: api\|manual`, `ssh-key-at-create`, `wait-running: api\|manual`, `set-ptr: api\|manual\|vendor`, `unlock-port25: open\|ticket\|verify\|throttled`, `provision-stack: ssh\|managed`, `delete: api\|manual`. **Degrade en 2 modos** (ambos ya tienen precedente): (a) **skip-with-reason** (best-effort, nunca bloquea — el patrón PTR actual; aplica a PTR + port25-pending); (b) **hard-block "manual_step_required"** (RackNerd compra en paso 4 / delete manual — pausa el run, resume tras paste del operador; la máquina de resume ya soporta continuar el mismo runId).

## Plan de entrega (fases)
1. **Enabler + columna vertebral** (`PROMPT_CODEX_PROVIDER_ENABLER_WEBDOCK_2026_06_09.md` + agregar `SenderNode.accountId/serverSlug`, `accountId` en webdock-servers.json, clave `provider:accountId:slug`, `withAccount` resolver, `validateAccount` con pre-check puerto 25). Multi-cuenta **Webdock** usable. Flag-gated, backward-compat byte-idéntico.
2. **Motor de selección** (deliverability-aware: score diversidad/headroom/salud/costo + scope→accountId + pre-check paso 1) + **capacidad de flota** + **Clusters por accountId**.
3. **Drift cross-account + prune tool** (resuelve los huérfanos correctamente).
4. **Adapter Contabo** (full API, drop-in). Luego RackNerd (manage-only, compra manual).
5. (Futuro) tool OpenClaw `register_provider_account` (metadata+ref) + secretos sops+age cuando dispare el trigger.

Reportes completos de los 7 agentes (selección, deliverability con fuentes, UX, prototipo, ops, secretos, matriz) son la base de cada fase. Ver [[delivrix_multi_provider_conexiones_2026_06_09]] y [[delivrix_multi_provider_5_12]].
