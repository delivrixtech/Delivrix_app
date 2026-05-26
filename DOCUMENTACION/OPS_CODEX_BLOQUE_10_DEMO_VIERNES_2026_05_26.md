# OPS Codex Bloque 10 — Demo viernes 29 may: flujo end-to-end REAL

**Fecha:** martes 26 de mayo de 2026
**Entrega:** viernes 29 de mayo de 2026 — 3 días hábiles
**Objetivo:** demostrar en vivo, sin teatro, el ciclo completo de aprovisionar un dominio sender pool en Delivrix. Comprar → configurar DNS → SPF/DKIM/DMARC → provisionar VPS Webdock → configurar SMTP → conectar → iniciar warmup. Todo materializado en Canvas Live en tiempo real.

---

## Principio arquitectural · no negociable

**OpenClaw NO ejecuta scripts cerrados, ejecuta skills reusables que aprenden.** Cada skill que implementamos esta semana debe cumplir 3 reglas:

1. **Reusable** — recibe parámetros, no asume contexto. La skill `provision_smtp_server(domain, server_ip)` corre igual para `delivrix-mail.com` con server X que para `nfcfilings.com` con server Y. Cero hardcoding.

2. **Memoria persistente** — escribe el resultado a `/data/.openclaw/workspace/`. Cada ejecución deja: `{skill}/{domain}/{timestamp}-{outcome}.md` con qué hizo, qué decidió, qué falló. Estos archivos se leen antes de la siguiente ejecución para no repetir errores.

3. **Idempotente y supervisable** — si la skill se invoca dos veces con los mismos args, no rompe nada (verifica estado antes de modificar). Si falla a medias, deja el sistema en estado limpio y emite post-mortem automático.

**Esto es lo que separa Delivrix de un script de bash bonito.** Si las skills cumplen las 3 reglas, escalar de 1 dominio a 6 simultáneos es trivial (correr la skill 6 veces en paralelo, cada una con sus params). Si NO las cumplen, cada nuevo cliente requiere reescribir.

## Disciplina de scope · cero negociable

**Lo que SÍ entra en la demo viernes:**
- **1 ciclo individual** ejecutado en vivo, real, end-to-end (dominio + VPS + SMTP + warmup seed).
- **Demostración de aprendizaje** — abrir `/data/.openclaw/workspace/` en pantalla, mostrar que las skills dejaron rastro de qué hicieron y qué aprendieron.
- **Escalamiento visible** — disparar onboarding de **3 dominios en paralelo** después del primero. Canvas Live muestra 3 sub-agentes corriendo simultáneos.
- **Plan B documentado** — si falla 1 de los 3, el supervisor reasigna o marca bloqueado, sin caerse el flow general.

**Lo que NO entra (al backlog):**
- Más de 6 simultáneos en demo (la arquitectura lo permite, no hace falta demostrarlo el viernes).
- Warmup completo (proceso de 14-30 días).
- Reverse DNS / PTR (latencia 24-72h por proveedor).
- Bounces / replies handling (worker maduro, hito siguiente).
- Curación de inboxes seed con SeedList comercial.
- Cualquier feature que no esté en este OPS.

Si Codex o Claude proponen "y de paso agregamos X", la respuesta es no. Backlog.

---

## El flujo de la demo · 8 fases

| # | Fase | Real / Simulada | Owner skill |
|---|---|---|---|
| 1 | Operador pide propuesta de dominio | Real (existe) | Bloque 9 (en curso) |
| 2 | Aprobar propuesta y ejecutar compra Route53 | **REAL** ($11 USD) | Codex T1 |
| 3 | Crear hosted zone + records básicos en Route53 | **REAL** | Codex T2 |
| 4 | Generar SPF/DKIM/DMARC + escribir TXT records | **REAL** | Codex T3 |
| 5 | Provisionar VPS Webdock | **REAL** (~$5-10 USD) | Codex T4 |
| 6 | SSH provisioning postfix + opendkim + TLS | **REAL** | Codex T5 |
| 7 | Bind dominio↔servidor (MX + A) | **REAL** | Codex T6 |
| 8 | Iniciar warmup con 3 emails seed | **REAL** | Codex T7 + worker |

Costo monetario demo: ~$16-21 USD (1 dominio + 1 VPS mes). Documentar como "demo run cost" para reembolso interno.

---

## Tareas

### T1 — Skill `register_domain_route53` + endpoint POST

**Codex implementa:**

`packages/adapters/src/aws-route53-domains-adapter.ts` ya tiene cliente. Agregar:

```typescript
async registerDomain(opts: {
  domain: string;
  years: number;
  autoRenew: boolean;
  adminContact: ContactDetail;  // viene de env DELIVRIX_ADMIN_CONTACT_JSON
  privacyProtection?: boolean;
}): Promise<{ operationId: string; expectedExpiry: string }>
```

`apps/gateway-api/src/routes/domains-purchase.ts` (nuevo):

```
POST /v1/domains/route53/register
Body: {
  domain: string,
  years: number,
  autoRenew: boolean,
  actorId: string,
  approvalToken: string  // generado por POST /v1/canvas/artifact/:id/approve
}
Response: { operationId, expectedExpiry, costUsd, status: "pending" | "completed" }
```

**Reglas obligatorias:**
- Habilitar permiso AWS `route53domains:RegisterDomain` en IAM user `delivrix-route53-discover` (renombrar a `delivrix-route53-ops` si se prefiere).
- Quitar flag `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=false`, agregar `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50` como guardrail.
- Validar approvalToken contra audit chain: solo ejecuta si hay `oc.artifact.approved` reciente para ese artifactId.
- Emit audit critical: `oc.domain.registered` con cost, registrar, operationId.

**Juanes (operador) provee:**
- `DELIVRIX_ADMIN_CONTACT_JSON` con: FirstName, LastName, ContactType, AddressLine1, City, State, CountryCode, ZipCode, PhoneNumber, Email. Si no quiere exponer datos personales, usar persona legal de Delivrix.

### T2 — Skills DNS Route53 + endpoint

**Codex implementa:**

Adapter:
```typescript
async createHostedZone(domain: string): Promise<{ zoneId: string; nameServers: string[] }>
async upsertRecord(zoneId: string, opts: {
  name: string;
  type: "A" | "MX" | "TXT" | "CNAME";
  ttl: number;
  values: string[];
}): Promise<{ changeId: string }>
async deleteRecord(zoneId: string, opts: { name: string; type: string }): Promise<void>
```

Endpoint:
```
POST /v1/domains/route53/dns/upsert
Body: {
  domain: string,
  records: Array<{ name, type, ttl, values }>,
  actorId: string,
  approvalToken: string
}
```

**Permisos AWS:** agregar a IAM policy:
- `route53:CreateHostedZone`
- `route53:ChangeResourceRecordSets`
- `route53:GetHostedZone`
- `route53:ListResourceRecordSets`

Audit: `oc.dns.records_updated` con domain + count records.

### T3 — Skill `configure_email_auth` (SPF/DKIM/DMARC)

**Codex implementa:**

`bridge/skills/email_auth.py` (o equivalente):

```python
async def configure_email_auth(domain: str, mx_server_ip: str, task_id: str):
    # 1. SPF: v=spf1 ip4:<ip> -all
    await emit_artifact_block(task_id, "configurando SPF")
    spf_value = f"v=spf1 ip4:{mx_server_ip} -all"
    await upsert_dns_record(domain, "TXT", "@", [spf_value])

    # 2. DKIM: generar par RSA 2048
    await emit_artifact_block(task_id, "generando llaves DKIM RSA 2048")
    keypair = generate_dkim_keypair()
    selector = "default"
    dkim_value = f"v=DKIM1; k=rsa; p={keypair.public_key_b64}"
    await upsert_dns_record(domain, "TXT", f"{selector}._domainkey", [dkim_value])
    # guardar private key en /etc/opendkim/keys/{domain}/default.private para SSH provisioning
    await save_dkim_private_key(domain, selector, keypair.private_key_pem)

    # 3. DMARC: empezar en p=none con reports
    await emit_artifact_block(task_id, "publicando política DMARC")
    dmarc_value = (
        "v=DMARC1; p=none; "
        "rua=mailto:dmarc-reports@delivrix.com; "
        "ruf=mailto:dmarc-forensics@delivrix.com; "
        "fo=1"
    )
    await upsert_dns_record(domain, "TXT", "_dmarc", [dmarc_value])

    # 4. Validar publicación
    await emit_artifact_block(task_id, "validando publicación con dig")
    await validate_all_records(domain, selector)

    return {"spf": "ok", "dkim_selector": selector, "dmarc": "ok"}
```

Endpoint: `POST /v1/domains/auth/configure` con audit `oc.email_auth.configured`.

**Decisión a confirmar antes de implementar:**
- DMARC arranca en `p=none` (modo reporte, no rechazo) para no quemar el dominio durante warmup. Subir a `p=quarantine` después de 30 días.

### T4 — Skill `provision_webdock_vps` + endpoint

**Codex implementa:**

`packages/adapters/src/webdock-adapter.ts` agregar:

```typescript
async createServer(opts: {
  profile: "bit" | "nibble" | "byte" | "kilobyte";  // tier
  locationId: string;  // ej. "fi" (Finland), "eu" (Europe)
  hostname: string;
  imageSlug: "ubuntu-2404" | "debian-12";
  publicKey: string;  // SSH key del operator
  callbackUrl?: string;
}): Promise<{ serverSlug: string; eventId: string; ipv4: string | null }>
```

Endpoint:
```
POST /v1/webdock/servers/create
Body: { profile, locationId, hostname, imageSlug, actorId, approvalToken }
Response: { serverSlug, eventId, ipv4, status: "provisioning" }
```

**Webdock API key:** Juanes tiene que generar en una de las 3 cuentas Webdock una API key con scope `servers:write`. Stash en `WEBDOCK_API_KEY_OPS` env var.

**Polling de provisioning:** después del create, Codex hace `GET /v1/webdock/events/{eventId}` cada 5s hasta `status: "finished"` (típicamente 60-120s). Emit `oc.action.now` por cada poll para visualización.

**Important:** Webdock bloquea **puerto 25 por defecto** en cuentas nuevas. Después del provisioning, Codex tiene que enviar ticket via `POST /v1/webdock/tickets` pidiendo desbloqueo de port 25. Esto puede tomar 1-24h de respuesta humana del soporte Webdock. **Bloqueante crítico de la demo.**

**Mitigación bloqueante port 25:**
- Juanes pide el desbloqueo del port 25 HOY (martes), no el viernes.
- Si Webdock no responde antes del viernes, demo se ejecuta hasta T6 (configuración SMTP) y T7-T8 se demuestran con un VPS pre-aprobado de las cuentas existentes.

### T5 — SSH provisioning skills

**Codex implementa** (`bridge/skills/smtp_provisioning.py`):

```python
async def install_smtp_stack(server_ip: str, domain: str, dkim_private_key: str, task_id: str):
    # 1. SSH wait until ready
    await wait_for_ssh(server_ip, timeout=180)
    await emit_action(task_id, "ssh", f"connected to {server_ip}")

    # 2. apt update + install
    await ssh_exec(server_ip, "apt-get update -qq")
    await ssh_exec(server_ip, "DEBIAN_FRONTEND=noninteractive apt-get install -y postfix opendkim opendkim-tools certbot")
    await emit_action(task_id, "command", "postfix + opendkim installed")

    # 3. configure postfix
    main_cf = generate_postfix_main_cf(domain)
    await ssh_write_file(server_ip, "/etc/postfix/main.cf", main_cf)

    # 4. configure opendkim
    dkim_table = f"default._domainkey.{domain} {domain}:default:/etc/opendkim/keys/{domain}/default.private"
    await ssh_write_file(server_ip, "/etc/opendkim/key.table", dkim_table)
    await ssh_write_file(server_ip, f"/etc/opendkim/keys/{domain}/default.private", dkim_private_key, mode=0o600)

    # 5. TLS via Let's Encrypt
    await ssh_exec(server_ip, f"certbot certonly --standalone -d mail.{domain} --non-interactive --agree-tos -m dmarc-reports@delivrix.com")

    # 6. restart services
    await ssh_exec(server_ip, "systemctl restart opendkim postfix")

    # 7. validate handshake
    handshake = await validate_smtp_handshake(server_ip, port=25)
    return handshake
```

Endpoint: `POST /v1/servers/{serverSlug}/provision-smtp`. Emite eventos `oc.action.now kind=command` por cada comando SSH ejecutado, así Canvas Live tab Terminal se llena en vivo.

### T6 — Bind dominio↔servidor

**Codex implementa:**

`bridge/skills/bind_domain.py`:

```python
async def bind_domain_to_server(domain: str, server_ip: str, task_id: str):
    # Apuntar mail.<domain> al servidor + MX al servidor
    await upsert_dns_record(domain, "A", f"mail.{domain}", [server_ip])
    await upsert_dns_record(domain, "MX", "@", [f"10 mail.{domain}"])
    await emit_artifact_block(task_id, f"MX configurado: @ → mail.{domain} → {server_ip}")
    # Validar propagación
    await wait_for_dns_propagation(domain, "MX", timeout=120)
    return {"mx": f"mail.{domain}", "ip": server_ip}
```

Endpoint: `POST /v1/domains/bind` con audit `oc.domain.bound_to_server`.

### T7 — Start warmup con emails seed

**Codex implementa** (`bridge/skills/warmup.py`):

```python
async def start_warmup_seed(domain: str, server_ip: str, seed_inboxes: list[str], task_id: str):
    # Enviar 3 emails de seed a inboxes preconfiguradas (que Juanes confirma)
    sent = []
    for inbox in seed_inboxes:
        msg_id = await send_email_via_postfix(
            server_ip=server_ip,
            from_addr=f"noreply@{domain}",
            to_addr=inbox,
            subject=f"Delivrix warmup seed · {domain}",
            body="This is a seed email from Delivrix warmup. Reply with 'ok' to confirm receipt."
        )
        await emit_action(task_id, "api", f"email enviado a {inbox}", details={"msg_id": msg_id})
        sent.append({"to": inbox, "msg_id": msg_id, "sent_at": now_iso()})

    return {"sent": sent, "count": len(sent)}
```

**Seed inboxes:** Juanes provee 3 emails de prueba (Gmail / Outlook / propio Delivrix) que él puede revisar durante la demo para mostrar inbox real con el email entregado.

Endpoint: `POST /v1/warmup/start` con `oc.warmup.started`.

### T7B — Memoria persistente del agente (CRÍTICO ARQUITECTURAL)

**Codex implementa** (`bridge/memory/workspace_writer.py`):

OpenClaw mantiene `/data/.openclaw/workspace/` como cerebro persistente. Cada skill que ejecuta escribe al menos 3 cosas:

```
/data/.openclaw/workspace/
├── skills/                          # Definiciones de skills y su versión
│   ├── register_domain_route53.v1.md
│   ├── provision_webdock_vps.v1.md
│   └── ...
├── executions/                      # Cada invocación de skill
│   └── 2026-05-29/
│       ├── 1100-register_domain_route53-delivrix-mail.com-success.md
│       ├── 1102-provision_webdock_vps-mail-delivrix-1-success.md
│       └── ...
├── learnings/                       # Lecciones extraídas de fallas + éxitos
│   ├── webdock-port-25-blocked-by-default.md
│   ├── route53-tld-net-confirmation-time.md
│   └── ...
└── inventory/                       # Estado actual del mundo según OpenClaw
    ├── domains.json
    ├── servers.json
    └── warmup-progress.json
```

**Cada skill obligada a:**

1. **Pre-flight read** — antes de ejecutar, leer learnings relevantes:

```python
async def provision_smtp_server(domain: str, server_ip: str, task_id: str):
    relevant_learnings = await workspace.read_learnings(skill="provision_smtp_server")
    # Si hay learnings tipo "postfix install fails on debian-12 sin libsasl2", aplicar fix preventivo
    for lesson in relevant_learnings:
        if lesson.applies_to(domain=domain, server_ip=server_ip):
            await apply_preventive_fix(lesson)
    # ... resto del flow
```

2. **Post-execution write** — al terminar, escribir resultado:

```python
async def write_execution_record(skill: str, params: dict, outcome: str, duration_ms: int, evidence: dict):
    path = f"executions/{date_today()}/{time_now()}-{skill}-{params['domain']}-{outcome}.md"
    content = render_execution_md(skill, params, outcome, duration_ms, evidence)
    await workspace.write(path, content)
    await emit_action(task_id, "file", "write", path)  # también va a Canvas Live
```

3. **Failure → automatic lesson** — si la skill falla, OpenClaw escribe lesson automática:

```python
async def on_skill_failure(skill: str, params: dict, error: Exception, context: dict):
    lesson_md = await generate_lesson_via_llm(
        prompt=f"Skill {skill} falló con {error}. Context: {context}. Genera lección con root cause + fix sugerido."
    )
    path = f"learnings/auto-{date_today()}-{skill}-{slugify(error.message)}.md"
    await workspace.write(path, lesson_md)
    await emit_artifact_block(task_id, kind="report", title=f"Lección aprendida: {skill}", content=lesson_md)
```

4. **Inventory snapshot** — cada vez que el mundo cambia (dominio nuevo, server nuevo, warmup status), actualizar `inventory/*.json`. Este JSON es lo que OpenClaw lee cuando alguien le pregunta "qué dominios tenemos".

**System prompt update:** el system prompt de OpenClaw debe instruir explícitamente:

> "Antes de ejecutar cualquier skill operativa, lee `/data/.openclaw/workspace/learnings/` filtrando por la skill que vas a usar. Aplica fixes preventivos si hay lecciones relevantes. Después de ejecutar, escribe el resultado a `/executions/` y actualiza `/inventory/` si el estado del mundo cambió. Si falla, genera lesson automática con root cause."

Sin esto, OpenClaw vuelve a tropezar con el mismo error en cada ejecución. Con esto, cada falla aporta a la inteligencia del sistema.

### T7C — Multi-agent orquestación (escalamiento 1→N)

**Codex implementa** (`bridge/orchestration/supervisor.py`):

Skill `supervisor_onboard_batch(domains: list[str], profile: str)`:

```python
async def supervisor_onboard_batch(domains: list[str], profile: str, parent_task_id: str):
    """
    Recibe N dominios. Spawnea N sub-agentes (uno por dominio).
    Cada sub-agente corre onboard_sender_domain() de forma independiente.
    El supervisor monitorea, reasigna en caso de falla, agrega progreso global.
    """
    # Declarar task padre supervisor
    await emit_task_declare(parent_task_id, title=f"Onboarding batch · {len(domains)} dominios")

    # Spawn sub-agents en paralelo
    sub_tasks = []
    for domain in domains:
        sub_task_id = f"{parent_task_id}-sub-{slugify(domain)}"
        await emit_task_declare(sub_task_id, title=f"Onboarding · {domain}", parent_task_id=parent_task_id)
        coro = onboard_sender_domain(domain, profile, task_id=sub_task_id)
        sub_tasks.append(asyncio.create_task(coro))

    # Esperar todos, con retries por fallas individuales
    results = await asyncio.gather(*sub_tasks, return_exceptions=True)

    successful = []
    failed = []
    for domain, result in zip(domains, results):
        if isinstance(result, Exception):
            failed.append({"domain": domain, "error": str(result)})
            # Decisión del supervisor: reintentar o marcar bloqueado
            decision = await supervisor_decide_retry(domain, result)
            if decision == "retry":
                # Re-ejecutar una vez con lessons aprendidas hace 1 minuto
                try:
                    result = await onboard_sender_domain(domain, profile, task_id=f"{parent_task_id}-retry-{slugify(domain)}")
                    successful.append({"domain": domain, "result": result})
                except Exception as e2:
                    failed[-1]["retry_error"] = str(e2)
        else:
            successful.append({"domain": domain, "result": result})

    # Artifact consolidado del batch
    await emit_artifact_block(
        parent_task_id,
        kind="report",
        title=f"Resultado batch: {len(successful)} ok · {len(failed)} fallaron",
        content=render_batch_report(successful, failed)
    )

    return {"successful": successful, "failed": failed}
```

**Canvas Live muestra:**

- 1 task padre en sidebar: "Onboarding batch · 3 dominios"
- 3 sub-tasks anidadas (con indent visual): "Onboarding · delivrix-mail.com", "Onboarding · delivrix-send.com", "Onboarding · delivrix-relay.com"
- Cada sub-task tiene su propio estado, sus propios eventos action.now, su propio artifact
- El operador puede click en cualquier sub-task para ver su progreso individual
- El supervisor reporta agregado al final

**Endpoint:**
```
POST /v1/flows/onboard-batch
Body: {
  domains: ["delivrix-mail.com", "delivrix-send.com", "delivrix-relay.com"],
  profile: "bit",
  actorId: string,
  approvalToken: string
}
Response: { parentTaskId, subTaskIds: string[] }
```

**Frontend (Claude implementa):** TasksColumn del LiveTool muestra jerarquía. Sub-tasks con indent 16px y línea vertical visual conectando al padre. El operador click padre = ve progreso agregado; click sub = ve detalle individual.

### T8 — Eventos canvas-live para cada paso del flujo

**Codex implementa el flujo completo en Bridge:**

`bridge/flows/onboard_new_sender_domain.py`:

```python
async def onboard_new_sender_domain(domain: str, profile: str, task_id: str):
    """
    Flujo orquestador del demo. Cada subskill emite a Canvas Live.
    """
    # Fase 1-4: dominio + DNS + auth (no requiere servidor todavía)
    operation = await register_domain_route53(domain, years=1, auto_renew=True, task_id=task_id)
    await wait_for_route53_operation(operation.operation_id)

    zone = await create_hosted_zone_route53(domain, task_id=task_id)

    # Fase 5-6: servidor + SSH
    server = await provision_webdock_vps(
        profile=profile, hostname=f"mail-{domain}", task_id=task_id
    )
    await wait_for_webdock_event(server.event_id)

    # Fase 4 deferred hasta tener IP del server
    auth_result = await configure_email_auth(domain, server.ipv4, task_id=task_id)
    await install_smtp_stack(server.ipv4, domain, auth_result.dkim_private_key, task_id=task_id)

    # Fase 7: bind
    await bind_domain_to_server(domain, server.ipv4, task_id=task_id)

    # Fase 8: warmup seed
    seed_result = await start_warmup_seed(
        domain, server.ipv4,
        seed_inboxes=os.environ["DELIVRIX_DEMO_SEED_INBOXES"].split(","),
        task_id=task_id
    )

    # Artifact final consolidado
    await emit_consolidated_report(task_id, domain, server, auth_result, seed_result)
```

Endpoint disparador: `POST /v1/flows/onboard-sender-domain` con body `{ domain, profile, actorId, approvalToken }`. El POST devuelve `taskId` inmediato y la ejecución corre async; el operador ve todo en Canvas Live.

---

## Cronograma 3 días

### Martes 26 (hoy) — preparación bloqueantes

| Owner | Tarea | Estado |
|---|---|---|
| **Juanes** | Conseguir desbloqueo port 25 Webdock (abrir ticket YA) | Bloqueante |
| **Juanes** | Stash `DELIVRIX_ADMIN_CONTACT_JSON` en `.env.local` | 30 min |
| **Juanes** | Generar API key Webdock con scope write | 15 min |
| **Juanes** | Definir 3 seed inboxes (`DELIVRIX_DEMO_SEED_INBOXES`) | 5 min |
| **Juanes** | Habilitar permiso `route53domains:RegisterDomain` en IAM | 10 min |
| **Codex** | Arrancar Bloque 9 (extractor universal artifacts) | Crítico — Canvas Live espectacular depende de esto |
| **Claude** | Pulir P0 frontend (ApprovalRow humanize, Onboarding readonly chips, Canvas tabs empty state honesto) | 2h |

### Miércoles 27 — arquitectura + skills core

| Owner | Tarea | Tiempo estimado |
|---|---|---|
| Codex | **T7B workspace_writer + memoria persistente (HACER PRIMERO)** | 3h |
| Codex | T1 register_domain reusable + endpoint | 2h |
| Codex | T2 hosted zone + upsert records reusables | 2h |
| Codex | T3 configure_email_auth con DKIM keygen + workspace write | 3h |
| Codex | T4 provision_webdock_vps + polling + workspace write | 3h |
| Codex | T5 install_smtp_stack idempotente + workspace write | 4h |
| Claude | Sección "Sender Pool" en panel (lista de dominios provisioned) | 3h |
| Claude | Cablear botón "Onboard new sender domain" en sección Dominios | 1h |
| Claude | TasksColumn jerarquía padre/sub (preparar para T7C) | 2h |

**Fin miércoles:** workspace writer operativo. 1 onboarding individual ejecutado en staging end-to-end. Cada skill dejó rastro en `/workspace/executions/`.

### Jueves 28 — multi-agent + integración

| Owner | Tarea | Tiempo estimado |
|---|---|---|
| Codex | T6 bind_domain_to_server idempotente | 2h |
| Codex | T7 start_warmup_seed + workspace write | 2h |
| Codex | **T7C supervisor_onboard_batch (multi-agent)** | 4h |
| Codex | T8 emisión canvas-live para sub-tasks anidadas | 2h |
| Codex | Smoke test batch 3 dominios paralelos en staging | 2h |
| Codex | Generar 2-3 lecciones simuladas en `/workspace/learnings/` para demo Acto 2 | 1h |
| Claude | Renderer de sub-tasks anidadas en TasksColumn del LiveTool | 3h |
| Claude | Vista de `/workspace/` browseable en tab Archivos del Canvas | 3h |
| Claude | QA visual completo + grabar video demo de respaldo | 2h |

**Fin jueves:** demo completa funcional en staging. 1 individual + 3 paralelos + memoria visible.

### Viernes 29 — demo + entrega

| Hora | Actividad |
|---|---|
| 9:00 | Validación final · health check de todos los componentes |
| 9:30 | Smoke test con dominio descartable (no el de la demo) |
| 10:30 | Reset audit logs · limpieza de estado |
| 11:00 | **DEMO** |

---

## Guión de la demo (25 minutos · 3 actos)

**Acto 1 (15 min):** ciclo individual end-to-end. Acto 2 (5 min): mostrar memoria persistente. Acto 3 (5 min): escalamiento a 3 simultáneos.

### ACTO 1 · Ciclo individual

**0:00 — Apertura (1 min)**
> "Esto es Delivrix. Un panel de control con asistencia de IA supervisada. Vamos a ver el ciclo completo: comprar un dominio nuevo, configurarlo, provisionar el servidor de envío, conectar todo, e iniciar warmup. Todo real, en vivo, con cada acción crítica requiriendo aprobación humana."

**1:00 — Abrir Canvas, mostrar el flujo (1 min)**
> "El operador conversa con OpenClaw. A la derecha, Canvas Live muestra qué hace el agente en tiempo real."

**2:00 — Pedir propuesta (2 min)**
Operador escribe: `"Necesitamos un dominio nuevo para sender pool. Propon un .net disponible y prepara el plan completo de onboarding."`

OpenClaw responde con propuesta (Bloque 9 garantiza que esto aparece en Canvas Live como artifact tipo `proposal`).

**4:00 — Aprobar propuesta (1 min)**
> "El operador aprueba con un click. Esto dispara el flow real."

Click en "Aprobar". Audit chain firma. Canvas Live muestra la task corriendo.

**5:00 — Fases 1-4 ejecutándose (4 min)**

Canvas Live muestra:
- "Comprando dominio en Route53… $11 USD…" → check
- "Creando hosted zone… name servers asignados…" → check
- "Generando llaves DKIM RSA 2048…" → check
- "Publicando SPF/DKIM/DMARC TXT records…" → check

Operador puede mostrar tab "Archivos" del Canvas: el .key DKIM aparece escrito en `/etc/opendkim/keys/...`.

**9:00 — Fase 5-6 (4 min)**

Canvas Live:
- "Provisionando VPS Webdock profile=bit Finland…" → polling 60-120s con animación
- "VPS listo. IP: X.X.X.X. Conectando SSH…" → check
- Tab Terminal del Canvas se llena en vivo con cada comando: `apt-get install postfix`, `certbot…`, `systemctl restart postfix`

**13:00 — Fase 7-8 (1.5 min)**

Canvas Live:
- "Conectando dominio al servidor: MX @ → mail.X.com → IP" → check
- "Enviando seed email a gmail-test@delivrix.com…" → check
- "Enviando seed email a outlook-test@delivrix.com…" → check
- "Enviando seed email a yahoo-test@delivrix.com…" → check

Operador abre su Gmail en pantalla y muestra el email recibido con header SPF=pass, DKIM=pass, DMARC=pass.

**14:30 — Fin Acto 1 (0:30)**
> "El dominio está comprado, configurado y enviando. Cero líneas de código tipeadas por el operador. Cada paso quedó en audit chain. Pero esto es solo el principio."

### ACTO 2 · Memoria persistente (5 min)

**15:00 — Abrir workspace del agente (2 min)**

Operador abre tab Archivos del Canvas Live. Navega a `/data/.openclaw/workspace/`:

> "OpenClaw no ejecuta scripts ciegos. Cada cosa que hizo quedó registrada acá. Lo abrimos."

Mostrar:
- `executions/2026-05-29/1102-provision_webdock_vps-mail-delivrix-1-success.md` — qué decidió, qué params usó, cuánto tardó, evidencia
- `inventory/domains.json` — actualizado con el dominio nuevo
- `learnings/2026-05-27-webdock-port-25-blocked.md` (lección que aprendimos el miércoles)

**17:00 — Demostrar aprendizaje preventivo (2 min)**

> "Esta lección la generó OpenClaw automáticamente el miércoles cuando un VPS de prueba tuvo el port 25 bloqueado. Hoy, antes de provisionar el VPS del demo, la skill la leyó y aplicó el fix preventivo (abrir ticket Webdock al inicio en vez del final). Por eso no nos pegó."

**19:00 — Operador pregunta al agente (1 min)**

Operador escribe: `"¿qué dominios tenemos hoy bajo gestión?"`

OpenClaw responde leyendo `inventory/domains.json` — lista 17 dominios (16 viejos + 1 nuevo del demo). Canvas Live muestra artifact tipo report con la tabla.

> "El agente no inventa. Lee de su propia memoria. Si yo le pregunto mañana, va a saber lo mismo porque está persistido en disco."

### ACTO 3 · Escalamiento a 3 simultáneos (5 min)

**20:00 — Disparar batch (1 min)**

Operador escribe: `"Necesitamos 3 dominios más para sender pool. Onboarda en paralelo: delivrix-send.com, delivrix-relay.com, delivrix-mta.com"`

OpenClaw propone batch. Operador aprueba con un click.

**21:00 — Canvas Live muestra 3 sub-agentes en paralelo (3 min)**

Sidebar del Canvas Live muestra:
- Task padre: "Onboarding batch · 3 dominios · en curso"
- Sub-task 1: "Onboarding · delivrix-send.com · ejecutando provisión"
- Sub-task 2: "Onboarding · delivrix-relay.com · esperando Route53"
- Sub-task 3: "Onboarding · delivrix-mta.com · ejecutando DKIM"

Las 3 corren simultáneas, cada una con su propia API call visible en el centro, su propio artifact a la derecha.

**24:00 — Resumen del batch (0:30)**

Cuando los 3 terminen, el supervisor emite artifact consolidado: "3 dominios onboardeados con éxito en 4 min total. Costo: $33 USD. 4 emails seed enviados, todos con SPF/DKIM/DMARC pass. Sender pool ahora tiene 4 dominios listos para warmup."

**24:30 — Cierre (0:30)**
> "Lo que ven es la arquitectura completa: el agente aprende de cada ejecución, las skills son reusables, y escalar de 1 a 6 a 60 es solo correr más sub-agentes. Cada acción queda firmada en audit chain. Cero comandos shell tipeados por el operador. Eso es Delivrix."

---

## Plan B por fase

| Si falla… | Mitigación |
|---|---|
| T1 (compra Route53) | Pre-comprar dominio descartable el jueves, demostrar Fase 2-7 con ese dominio. Compra real queda como "lo hicimos ayer, miren el audit log". |
| T2-T3 (DNS + auth) | Usar dominio pre-configurado con records ya escritos. Mostrar el agente "validando" en lugar de "creando". |
| T4 (Webdock provisioning) | Pre-provisionar VPS el jueves. Demo arranca desde Fase 5 con servidor ya listo. |
| T5 (SSH provisioning) | Pre-instalar postfix en el VPS, demo arranca desde Fase 6 con servidor configurado. |
| T7 (port 25 bloqueado) | Mostrar configuración completa hasta validación handshake fail con mensaje "esperando aprobación Webdock para port 25, ticket #X abierto martes 26". Eso es honestidad de proceso. |
| T8 (warmup seed) | Email seed sale pero rebota. Demo el header DKIM=pass aunque el mensaje vuelva. La técnica funciona, el destino es seed. |

---

## Done criteria

**Ciclo individual:**
- 1 dominio nuevo registrado en Route53.
- 1 hosted zone Route53 con records (A, MX, TXT SPF, TXT DKIM, TXT DMARC).
- 1 VPS Webdock provisionado y operativo.
- 1 stack postfix + opendkim + TLS configurado y validado.
- 3 emails seed enviados con SPF=pass / DKIM=pass / DMARC=pass.

**Memoria persistente:**
- `/data/.openclaw/workspace/executions/` contiene records de las 8 fases del ciclo individual.
- `/data/.openclaw/workspace/learnings/` contiene al menos 2 lecciones (1 generada auto durante miércoles smoke, 1 escrita manualmente para demo).
- `/data/.openclaw/workspace/inventory/domains.json` actualizado con dominio nuevo.
- Operador pregunta "¿qué dominios tenemos?" y el agente responde leyendo el inventory.

**Multi-agent escalamiento:**
- Skill `supervisor_onboard_batch(domains: list, profile)` operativa.
- Batch de 3 dominios ejecuta en paralelo (no secuencial).
- Canvas Live muestra task padre + 3 sub-tasks anidadas con indent visual.
- Si 1 de 3 falla, supervisor decide retry o marca bloqueado sin caerse el flow.
- Artifact consolidado al final con resumen del batch.

**Arquitectural:**
- Cada skill cumple las 3 reglas (reusable, persiste memoria, idempotente).
- System prompt de OpenClaw instruye explícitamente a leer workspace antes de ejecutar.
- Cero hardcoding de dominios o IPs en código de skills.

**Audit y observabilidad:**
- Audit chain con todos los eventos críticos firmados.
- Canvas Live materializa cada paso en tiempo real durante la demo.
- Doc `OPS_CODEX_BLOQUE_10_RESULT_2026_05_29.md` con: SHAs, costo total demo (~$50 USD esperado por 4 dominios + 1-3 VPS), screenshots Canvas Live por fase, video grabado, listado de `/workspace/` final.

---

## Compromiso

Esto es ambicioso para 3 días pero realizable si:
1. Juanes resuelve los 5 bloqueantes hoy (martes).
2. Codex trabaja full-time en T1-T8 miércoles + jueves.
3. Claude trabaja paralelo en UI y QA.
4. Cero feature creep.

Si algún paso se atrasa, **se aplica plan B y la demo sigue adelante** con honestidad sobre qué quedó pre-cocinado vs real.
