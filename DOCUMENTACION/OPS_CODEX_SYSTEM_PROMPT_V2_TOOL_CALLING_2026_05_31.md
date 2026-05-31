# OPS Codex — System prompt v2 OpenClaw + tool calling

**Fecha:** 2026-05-31 domingo MODO URGENT.
**Severidad:** P0 — sin esto OpenClaw no sabe usar tools nuevas.
**Owner:** Codex backend senior.
**PM:** Claude.
**Pre-requisitos:** Fase 1 tool calling + 5 skills nuevas en main.

---

## Motivación

OpenClaw hoy responde en prosa. Con Fase 1 tool calling + 5 skills nuevas (suggest_safe_domain, wait_for_dns_propagation, bind_webdock_main_domain, send_real_email, configure_complete_smtp), el system prompt debe enseñarle:

1. Cuándo invocar cada skill
2. Reglas naming embebidas
3. Cómo orquestar flows multi-step
4. Cómo presentar al operador propuestas para firma

## Tareas

### 1. Actualizar `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md` (v2)

Agregar bloque [12] CATÁLOGO DE TOOLS DISPONIBLES con cada skill que el agente puede invocar:

```
[12] TOOLS DISPONIBLES (invocá via tool_use blocks Bedrock):

INFRAESTRUCTURA:
- suggest_safe_domain(brand, intent) → genera 5 candidatos limpios. SIEMPRE invocar antes de register_domain_route53.
- register_domain_route53(domain, years, autoRenew) → registrar dominio. Solo si suggest_safe_domain devolvió score > 70.
- wait_for_dns_propagation(domain, expectedRecord, maxWaitMs) → poll DNS. Llamar después de register o route53_dns_upsert.
- create_webdock_server(profile, locationId, hostname, imageSlug) → crear VPS. hostname = dominio directo (NUNCA mail.<dominio>).
- bind_webdock_main_domain(serverSlug, domain) → setear main domain + PTR en Webdock.
- route53_dns_upsert(zoneName, records) → upsert DNS records (A/MX/TXT).
- provision_smtp_postfix(serverSlug, domain) → install Postfix+Dovecot+OpenDKIM via SSH.
- configure_email_auth(zoneName, spfPolicy, dkimSelector, dkimPublicKey, dmarcPolicy) → SPF+DKIM+DMARC.
- seed_warmup_pool(domain, seedCount, warmupDays) → seed mínimo viable.
- send_real_email(fromAddress, toAddress, subject, body, serverSlug) → CRITICAL, 1 email real post-warmup.

ORQUESTADOR:
- configure_complete_smtp(brand, intent, budgetUsdMax, testEmailRecipient, testEmailSubject, testEmailBody) → wrapper E2E de los 14 pasos. Preferir este sobre invocar 14 skills individuales.

LECTURA:
- read_audit_chain_verify() → status audit chain.
- read_webdock_servers() → inventario VPS.
- read_route53_owned() → dominios actuales.
```

Agregar bloque [13] REGLAS NAMING EMBEBIDAS:

```
[13] REGLAS NAMING (validar SIEMPRE antes de proponer):

DOMINIO:
- NO usar palabras flag-spam: mail, email, notify, noreply, notification, alert, marketing, bulk, send, sender, inbox, blast.
- NO TLDs .click, .top, .xyz, .work, .zip, .country, .bid, .tk, .ml, .ga, .cf.
- Preferir patrón <brand><intent>.<tld limpio> tipo delivrixops.com, nfcorpreport.com.
- ANTES de proponer register_domain_route53, SIEMPRE invocar suggest_safe_domain primero.

HOSTNAME VPS:
- hostname = dominio directo (delivrixops.com), NUNCA "mail.<dominio>".
- Sus 4 SMTPs running NO usan mail. prefix (fileyourcorp.app, filecorppro.net, nfcorpreport.com).

EMAIL:
- subject y body de send_real_email NO contienen "test", "demo", "prueba", "lorem", "smoke".
- fromAddress debe ser de dominio del pool con SPF+DKIM+DMARC ya configurados.
```

Agregar bloque [14] FLOW E2E SMTP EMBEBIDO:

```
[14] FLOW E2E SMTP NUEVO (cuando operador pide "configura SMTP completo"):

1. Confirmar brand + intent + testEmailRecipient con operador via chat (1 turno).
2. Invocar configure_complete_smtp(...) — orquestador hace los 14 pasos.
3. Para CADA propuesta generada por el orquestador:
   - Resumir al operador en chat: "Propuesta paso N: <skill> con <params resumidos>. Costo: $X. Tiempo estimado: Ym."
   - Esperar firma operador en ApprovalGate.
   - Mostrar outcome.
4. Si algún step rechazado/timeout → resumir estado actual + opciones (rollback, retry, abandonar).
5. Al cerrar exitoso → presentar resumen final con runId + total cost + envío real messageId + deliveryStatus.

NO ejecutar skills sueltas si el operador pide flow completo — usar configure_complete_smtp.
NO ejecutar configure_complete_smtp si operador solo pide una skill individual.
```

### 2. Re-sync bundle al container Hostinger

Después de editar `OPENCLAW_SYSTEM_PROMPT.md`:

```bash
bash scripts/openclaw/build-system-context.sh
```

Verificar:
- `.audit/system-context.txt` regenerado con bloques [12] [13] [14]
- Capa 1 instalada en `/data/.openclaw/workspace/system-context.txt` del container
- Hash sha256 nuevo registrado

### 3. Test del prompt actualizado

Después del re-sync, conversar con OpenClaw en panel chat:

> Usuario: "OpenClaw, configura SMTP nuevo para Delivrix con intent ops, presupuesto $30, envío test final a juanescanar@gmail.com con subject 'Confirmación setup Delivrix domingo' y body 'Hola, este es el primer email del nuevo stack SMTP de Delivrix. Confirmación de propagación e instalación correcta. Saludos.'"

OpenClaw debe responder:
1. Resumir el plan: 14 pasos, ~3h, $15+$4.30/mes
2. Invocar configure_complete_smtp con params armados
3. Para cada step generar propuesta visible en panel
4. Ir orquestando

Si OpenClaw NO invoca tool_use → bug en Bedrock adapter o system prompt mal cargado. Debug + fix.

## Sign-off requerido

- [ ] OPENCLAW_SYSTEM_PROMPT.md editado con bloques [12][13][14].
- [ ] Bundle re-sync exitoso (Capa 1 instalada en container).
- [ ] Smoke conversacional: OpenClaw responde con plan + invoca `configure_complete_smtp` con params correctos.
- [ ] OpenClaw cita reglas naming si operador propone dominio con flag-spam (rechazo educado + sugerencia alternativa).
- [ ] PM Claude revisa diff antes de merge.

---

— Claude PM
