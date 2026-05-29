# Referencias del flow real — cómo Juanes lo hace manualmente

**Para:** Codex, OpenClaw, cualquier sub-agente que toque skills de aprovisionamiento.
**Por qué existe:** capturar la ingeniería real de email transaccional que el CTO Juanes ya ejecutó en 7 dominios en producción con `smtp_stack_provision.sh`, IONOS DNS, Webdock VPS, y disciplina operativa documentada. Es la base de verdad contra la cual se mide cualquier skill de OpenClaw.

---

## Documentos

### [SMTP_STACK_AUDIT_JUANES_2026_05_28.md](./SMTP_STACK_AUDIT_JUANES_2026_05_28.md)

Auditoría completa del stack SMTP propio (1780 líneas, fecha 2026-05-28). Cubre arquitectura, aprovisionamiento, DNS, autenticación, certificados, firewall, runtime, reputación, monitoreo, comandos exactos de remediación. Resumen ejecutivo en §1, veredicto en §22.

**Cuándo consultarlo:**
- Antes de modificar `apps/gateway-api/src/routes/smtp-provisioning.ts` o el script SSH que corre en el VPS.
- Antes de pisar config Postfix / Dovecot / OpenDKIM / Fail2Ban / UFW.
- Cuando un dominio recién aprovisionado falle delivery a Gmail/Outlook y haya que diagnosticar.
- Cuando se diseñen skills nuevos de warmup, monitoreo de reputación, o rotación de credenciales.
- Cuando se hable de DNS records (SPF/DKIM/DMARC/PTR) y haya duda del shape correcto.

---

## Mapeo informe → componentes Delivrix

| Sección del informe | Skill / handler Delivrix | Estado actual |
|---|---|---|
| §4 Arquitectura (Postfix + Dovecot + OpenDKIM + Let's Encrypt + UFW + Fail2Ban + nginx) | `install_smtp_stack` (skill) + `smtp-provisioning.ts` (handler) | Implementado, probado E2E 28-may 01:13 |
| §5 Flujo de envío (587 STARTTLS / 465 TLS, SASL Dovecot, restricción remitente) | mismo skill, decisiones embebidas en el script SSH | Implementado |
| §6.1-6.13 Aprovisionamiento paso a paso | `install_smtp_stack` + adapter Webdock | Implementado |
| §7 DNS (SPF/DKIM/DMARC/PTR/MX) | `route53_dns_upsert` + `configure_email_auth` (Route53) y nuevo `IonosDnsActuator` (Carril B esta noche) | Route53 OK; IONOS write nuevo, pendiente smoke |
| §13 Cumplimiento Gmail/Yahoo/Microsoft (DKIM, PTR/FCrDNS, TLS, DMARC alineado, `List-Unsubscribe`, RFC 8058) | mismo bundle DNS + futuro skill `compliance_check` | Falta verificación automática |
| §14 Warm-up disciplinado (envío gradual, monitoreo de Gmail/Postmaster, no listas frías) | `start_warmup_seed` (3 emails) + nuevo `RampScheduler` (Carril C esta noche, curva demo-fast 3→9→27→81→150 en 10 min) | Seed OK; ramp implementado, pendiente smoke |
| §14.3 Disciplina por dominio (no enviar desde laptop, controlar rebotes, escalar despacio) | producto pendiente — debería ser sección "Disciplina operativa" en el panel Sender Pool | No implementado |
| §15.1-15.10 Postura encontrada (Postfix, Dovecot, OpenDKIM, Fail2Ban activos) | output del `install_smtp_stack` debería poder reportarse y mostrarse en panel Hardware/Recolector | Parcial — `cloudInitSettleSeconds`, `sshConnectAttempts` ya emitidos por adapter; falta reporte de estado de servicios |
| §16 Comandos de mantenimiento manual | producto pendiente — skill `vps_health_check` (postfix queue + opendkim test + cert renew dry-run + fail2ban status) | No implementado |
| §17 Procedimiento ante spam / 5xx / DKIM falla / credencial filtrada | producto pendiente — runbooks como skills `diagnose_placement`, `rotate_smtp_password`, `disable_smtp_user` | No implementado |
| §17.1 Si Gmail manda a spam → revisar Authentication-Results + SPF/DKIM/DMARC pass + PTR + volumen + repetición + blacklists + quejas | nuevo `placement-check` Gmail IMAP (Carril D esta noche) cubre el SUBSET "dónde cayó el email", el resto sigue pendiente | IMAP implementado, pendiente smoke; el diagnóstico completo es producto pendiente |
| §18 Política de seguridad (rotación trimestral, password manager, RSA 2048, DMARC `rua`) | producto pendiente — skill `rotate_dkim_selector`, política de secret store, recordatorios programados | No implementado |
| §19 Checklist remediación (PTR, DMARC `p=quarantine`, SPF `-all`, `milter_default_action=tempfail`, rate limits) | mismas decisiones deben estar embebidas en el script de provisión nuevo + checks de salud | Parcial — embebido en `smtp_stack_provision.sh`; falta verificación post-deploy |
| §20.1-20.6 Comandos exactos de corrección | repository de comandos en `runtime/openclaw-workspace/recipes/` (no existe) | No existe |

---

## Disciplina operativa que OpenClaw DEBE respetar

Estos puntos del informe son **gates no negociables**. Cualquier skill que los viole tiene que escalar a humano antes de ejecutar.

### Reputación y warm-up (§14)
1. **No escalar volumen sin warm-up gradual.** Curva: 3 → 9 → 27 → 81 → 150 → 270 con monitoreo de placement entre cada batch. Si bounce >5%, auto-pause y escalar.
2. **No enviar desde laptops, IPs residenciales, hostnames `.local`.** Todo el envío sale desde el VPS Webdock con PTR válido.
3. **No usar `From` de otro dominio que el firmado por DKIM.** El `smtpd_sender_login_maps` lo restringe a nivel Postfix.
4. **No cold email, no listas compradas.** Si la lista de seeds incluye direcciones cuyo opt-in no se pueda probar, escalar.
5. **No reutilizar asuntos repetidos en alto volumen.** El `subjectMatcher` del ramp debería rotar por batch.

### DNS (§7)
1. **Un solo TXT SPF por dominio** con menos de 10 DNS lookups. Si el dominio ya tiene SPF de un tercero (IONOS, Mailgun), hacer merge, no agregar otro.
2. **DKIM RSA 2048 mínimo**, selector versionado (`s2026a`, `s2026b` para futuras rotaciones).
3. **DMARC `p=quarantine` o `p=reject`** una vez que pase el período de observación con `p=none` + `rua=`.
4. **PTR `smtp.<dominio>`** publicado por Webdock para CADA IP saliente.

### Postfix (§18)
1. `milter_default_action = tempfail`. Nunca `accept` — si OpenDKIM cae, el correo se difiere, no sale sin firma.
2. AUTH solo en `submission/465/587`. Nunca AUTH en `25`.
3. `relayhost =` vacío. Entrega directa.
4. Rate limits por cliente: `smtpd_client_connection_count_limit=10`, `connection_rate_limit=15`, `message_rate_limit=25`, `auth_rate_limit=10`.

### Secretos (§18)
1. **Cero passwords en Markdown.** Los handoffs viejos del CTO los tienen — deuda pendiente de rotación.
2. Mínimo 24 caracteres aleatorios.
3. Rotación trimestral o inmediata ante incidente.
4. Una credencial por aplicación, no compartidas.

---

## Brechas vs producto Delivrix completo

Lo que el informe describe como "operación manual del CTO" y Delivrix todavía NO tiene:

1. **Skill de health check de VPS post-deploy** (postfix queue, opendkim testkey, certbot renew --dry-run, fail2ban status).
2. **Skill de diagnóstico de placement completo** (no solo INBOX vs SPAM, sino Authentication-Results, FCrDNS check, blacklist check, volumen vs ventana, repetición de asunto).
3. **Skill de rotación de credenciales SMTP** sin reescribir `passwd` completo (hoy el script lo pisa).
4. **Skill de rotación de DKIM** con selectors versionados (`s2026a` → `s2026b`) y publicación DNS coordinada.
5. **Skill de cleanup de queue** para suprimir direcciones inválidas tras un 5xx.
6. **Integración Google Postmaster Tools** para reportes de reputación reales (no inferidos desde IMAP).
7. **Política de consentimiento + suppression list** por dominio.
8. **MTA-STS / TLS-RPT** para recepción (informe lo marca como baja prioridad mientras MX siga en IONOS).
9. **Multi-agente real** especializado: un agente "DNS senior", un agente "SMTP senior", un agente "Reputación senior" en lugar de `Promise.all` del mismo flow.

---

## Cómo citar este informe en commits / OPS

Convención: `Ref: REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §<sección>`.

Ejemplos:
- "Implementa `IonosDnsActuator`. Ref: §7 DNS, requiere SPF `-all` para dominios endurecidos."
- "Skill `placement-check` cubre §17.1 paso 1 (Authentication-Results visible en sample) y paso 8 (folder SPAM)."
- "Curva warmup `demo-fast` se basa en §14.2 (escalado gradual) sin reemplazarlo."

---

## Notas

- El informe se redactó sobre 7 dominios en producción (`fileyourcorp.app`, `filecorppro.net`, `nationalcorphub.app`, `swiftcorpdocs.app`, `annualcorpfilings.com`, `nfcorpreport.com`, `nfcorpreport.online`) — todos negocios de incorporación de empresas en US.
- El stack documentado es el legacy operativo del CTO antes de Delivrix. Delivrix lo reescribe como producto SaaS con audit chain + gates humanos + skills observables, pero NO debe descartar la disciplina técnica del informe.
- Cualquier skill que entre en conflicto con §19 (Checklist remediación) debe ajustarse al checklist, no al revés.
