# Threat Model — Delivrix (2026-05-27)

**Versión:** 1.0
**Autor:** Claude (PM asistente) bajo decisión CTO Juanes.
**Estado:** living document — se actualiza al final de cada sprint o cuando se descubre nueva superficie.
**Alcance:** Delivrix MVP demo viernes 29-may + roadmap de hardening post-demo.

## 1. Propósito

Consolidar en un solo documento citable el modelo de amenazas del sistema Delivrix, mapeando cada superficie de ataque contra controles aplicados y gaps abiertos. Este doc es la **tesis formal de seguridad** que faltaba — los controles individuales ya viven en 13 docs dispersos referenciados al final.

No es una auditoría externa. Es el modelo interno que define qué consideramos en scope, qué controles aplicamos, qué gaps reconocemos, y qué ejercicios de threat-hunting recomendamos antes de exponer Delivrix a internet o a usuarios reales.

## 2. Activos críticos

Ordenados por impacto si se vulneran:

1. **Reputación de envío** — dominios y IPs limpias. Si se queman, recuperar toma semanas o es imposible (blacklists permanentes). Es el activo único de valor del MVP.
2. **Credenciales AWS / Webdock / IONOS** — acceso a cuentas reales con poder de gastar dinero o provisionar infra.
3. **Audit chain** — cadena de hashes SHA-256 que prueba qué hizo cada actor cuándo. Si se corrompe, perdemos accountability y compliance.
4. **Workspace persistente del agente** — memoria del agente (`/data/.openclaw/workspace/`). Si se borra o manipula, el agente pierde aprendizaje.
5. **Datos PII de usuarios futuros** — emails de destinatarios + datos de campañas. GDPR/CAN-SPAM.
6. **Lista de supresión** — destinatarios que pidieron unsubscribe. Volver a contactarlos viola CAN-SPAM directamente.

## 3. Superficies de ataque

### 3.1 Gateway HTTP local (127.0.0.1:3000)

**Qué es:** API REST + WSS streams del gateway Node.js. Hoy bound a localhost, en producción será expuesto vía reverse proxy.

**Controles aplicados:**

- OpenClaw Permissions Matrix v2.0 (gate duro 5 categorías × ~50 acciones)
- Approval token HMAC con anti-replay (`apps/gateway-api/src/security/hmac.ts`)
- Regla de 2 personas (`requiredApprovals` por entry de matrix)
- Audit chain SHA-256 (`OPENCLAW_AUDIT_INTEGRATION.md`)
- Kill switch armable (`FASE_2_KILL_SWITCH.md`)
- Read boundary explícito (29 endpoints whitelisted en `client.test.ts`)
- Rollback snapshots persistidos por acción de escritura (`gateway.sqlite`)
- Business hours guard para acciones críticas (`security/business-hours.ts`)
- Monthly cap USD por skill costosa (`AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50`)

**Gaps abiertos:**

- **G1.** No hay rate limiting a nivel HTTP por IP/actorId. Un actor comprometido puede inundar de requests.
- **G2.** Gateway sigue corriendo HTTP plano. Si alguna vez se expone fuera de localhost (incluso vía SSH tunnel mal configurado), TLS es obligatorio.
- **G3.** Sin Web Application Firewall (CSRF, injection, XSS surface del panel admin si llegara a aceptar input rich).
- **G4.** OPENCLAW_GATEWAY_TOKEN único compartido entre componentes — comprometerlo da acceso completo. Sin rotation policy ni vencimiento documentado.

### 3.2 Panel admin (apps/admin-panel)

**Qué es:** React app servido por Vite dev (5173) o build estático en producción.

**Controles aplicados:**

- Lectura via read-boundary inmutable (`shared/api/read-boundary.ts`)
- Escrituras solo a endpoints whitelisted con approval token
- No persiste credenciales en localStorage (solo flags UI: sidebar collapsed, demo mode)
- Tokens.css con CSP-friendly inline styles, no estilos dinámicos por user input

**Gaps abiertos:**

- **G5.** Sin autenticación de usuario en el panel todavía. Quien acceda al puerto 5173 accede al panel sin login. Para demo local OK, para producción es bloqueante.
- **G6.** Sin CSP (Content Security Policy) HTTP header configurado.
- **G7.** No hay 2FA para operadores autorizados.

### 3.3 WSS streams `/v1/canvas/live/stream` + `/v1/openclaw/chat/stream`

**Qué es:** WebSocket que stream eventos del agente al panel en vivo (Canvas Live + chat OpenClaw).

**Controles aplicados:**

- Origin check del handshake
- Schema validation de cada event wire antes de aplicar (`canvas-live-client.ts`)
- Solo lectura — el panel no envía acciones por WSS, solo recibe

**Gaps abiertos:**

- **G8.** Sin auth token en el handshake WSS más allá del proceso local.
- **G9.** Mensajes WSS no firmados — si el gateway se compromete, puede inyectar eventos falsos al panel.

### 3.4 Runtime OpenClaw (container Hostinger 2.24.223.240:61175)

**Qué es:** Agente Python corriendo en container remoto, conectado a Bedrock Claude Sonnet 4.6, ejecuta skills vía SSH bridge al gateway.

**Controles aplicados:**

- Permissions matrix gate antes de cada llamada (matrix se evalúa server-side)
- Bedrock cross-region inference profile (no expone credentials de OpenAI/Anthropic directos)
- System prompt versionado (`build-system-context.sh`)
- Workspace path constraint (`/data/.openclaw/workspace/` only, no escape al filesystem del container)

**Gaps abiertos:**

- **G10.** SSH bridge usa `OPENCLAW_SSH_USER=root` (ver .env.local). Acceso root al container es riesgo alto si el SSH key se compromete.
- **G11.** Container Hostinger sin firewall documentado entre el container y el internet — recibe tráfico desde cualquier IP que llegue al puerto 61175.
- **G12.** Sin rate limit del agente a sí mismo. Si el sistema prompt se compromete, el agente puede invocar skills sin freno hasta que el cap mensual lo corte.

### 3.5 Adapter AWS Route53 / Route53 Domains

**Controles aplicados:**

- IAM policy mínima refinada (`DelivrixRoute53MinimalDemo`)
- `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE` flag controlado por CTO
- Monthly cap $50 USD enforced antes de RegisterDomain
- Admin contact con WHOIS privacy ON hardcodeado
- Audit event `oc.domain.register_blocked` cuando se rechaza

**Gaps abiertos:**

- **G13.** IAM credentials (`AKIAVZCP...`) en .env.local plain text. Sin AWS Secrets Manager ni KMS rotation.
- **G14.** No hay separation of duties — la misma IAM key hace discovery + registration + DNS write. Mejor: key separada para purchase con MFA hardware.

### 3.6 Adapter Webdock API

**Controles aplicados:**

- Split de keys `_PRIMARY` (read-only) vs `_OPS` (write) implementado por Codex
- Handler protege con `canWrite()` antes de llamar `createServer`, `reinstall`, etc.
- Webdock dashboard tiene 2FA disponible (sin verificar si activado por CTO)

**Gaps abiertos:**

- **G15.** Sin rotation policy de las API keys Webdock. Si se comprometen, descubrimiento manual.
- **G16.** Webdock no soporta IP allowlist para keys API hasta donde sabemos — comprometer la key da acceso desde cualquier IP.

### 3.7 VPS aprovisionados (SMTP servers)

**Qué es:** VPS Webdock con postfix + opendkim + certbot, configurados para envío SMTP.

**Controles aplicados:**

- Provisionamiento via skill idempotente `install_smtp_stack`
- Audit chain de cada comando SSH ejecutado durante install
- SPF + DKIM RSA 2048 + DMARC obligatorios antes de habilitar envío
- Port 25 protegido por política Webdock anti-spam

**Gaps abiertos:**

- **G17.** Sin gestor de secretos en los VPS (DKIM private keys viven en filesystem del VPS).
- **G18.** Sin fail2ban ni similar contra brute force SSH.
- **G19.** Sin centralized logging (logs solo locales en el VPS).
- **G20.** Sin backup automatizado de configuración del MTA.

### 3.8 Storage local (gateway.sqlite + runtime/*.json + openclaw-workspace/)

**Controles aplicados:**

- `.env.local` y `runtime/` en `.gitignore`
- Permissions 600 en archivos críticos (verificado en `ls -la`)
- SQLite con journal mode estándar Node.js

**Gaps abiertos:**

- **G21.** Sin cifrado at-rest. Si la Mac se compromete, audit chain y approval tokens HMAC quedan expuestos.
- **G22.** Sin backup del workspace persistente del agente. Si se borra `runtime/openclaw-workspace/`, perdemos toda la memoria del agente.
- **G23.** Sin RBAC para acceso a archivos — cualquier proceso corriendo bajo el user de Juanes puede leer `.env.local`.

## 4. Controles transversales

Aplicados a múltiples superficies:

| Control | Doc canónico |
|---------|--------------|
| Permissions Matrix v2.0 | `OPENCLAW_PERMISSIONS_MATRIX.md` |
| Kill Switch | `FASE_2_KILL_SWITCH.md`, `HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md` |
| Audit Chain SHA-256 | `OPENCLAW_AUDIT_INTEGRATION.md` |
| HMAC Approval Tokens | `OPS_OPENCLAW_PERMISSIONS_HMAC_D4_AM.md` |
| Read Boundary | `apps/admin-panel/src/shared/api/read-boundary.ts` + tests |
| C2 Audit Override | `OPS_OPENCLAW_C2_AUDIT_OVERRIDE_D7.md` |
| Safety Real-time | `OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md` + ports React V2 |
| Skills Catalog | `OPENCLAW_SKILLS_CATALOG.md` |

## 5. Priorización de gaps

### Bloqueantes para exposición pública (no demo viernes)

- **G2** TLS gateway si se expone
- **G5** Auth panel admin
- **G13** AWS credentials a Secrets Manager
- **G21** Cifrado at-rest

### Alta prioridad post-demo

- **G1** Rate limiting HTTP
- **G4** Rotation del OPENCLAW_GATEWAY_TOKEN
- **G7** 2FA operadores
- **G10** SSH no-root bridge (cambiar root por user con sudo limitado)
- **G15** Rotation Webdock keys
- **G22** Backup workspace persistente

### Media prioridad

- **G3** WAF
- **G6** CSP headers
- **G8** Auth WSS handshake
- **G9** WSS message signing
- **G11** Firewall container Hostinger
- **G14** Separation of duties AWS IAM
- **G16** IP allowlist Webdock keys
- **G17** Secrets manager en VPS
- **G18** fail2ban
- **G19** Centralized logging
- **G20** Backup MTA config
- **G23** RBAC filesystem

### Baja prioridad / opcional

- **G12** Rate limit del agente a sí mismo

## 6. Ejercicios de threat-hunting recomendados

Antes de exponer Delivrix a usuarios reales:

1. **Pentest del gateway** con OWASP ZAP o Burp Suite — escaneo automatizado de los endpoints HTTP públicos.
2. **Auditoría de la cadena de audit-events** — verificar que la cadena hash SHA-256 no tiene gaps entre commits del repo y eventos persistidos.
3. **Drill del kill switch** — simulacro: armar el kill switch en medio de un flow real, verificar que TODAS las acciones supervised_local_state quedan bloqueadas en menos de 5 segundos.
4. **Drill de aprobación con actor comprometido** — simular que un approver tiene su token HMAC robado, verificar que el detector de replay (`security/approval-token.ts`) lo rechaza.
5. **Auditoría de credenciales en repo** — `git log --all -p | grep -iE "AKIA|AWS_SECRET|API_KEY"` debe devolver vacío.
6. **Stress del rate limit cap mensual** — disparar 10 intentos de RegisterDomain en 1 minuto con approval válida, verificar que el 5to bloquea por `monthly_cap_exceeded`.
7. **Verificación de WHOIS privacy** — después del primer dominio registrado, hacer `whois <dominio>` desde IP externa y confirmar que datos personales NO aparecen.
8. **Drill de recuperación** — borrar `runtime/openclaw-workspace/` y verificar que existe backup recente para restaurar.

## 7. Compliance footprint

| Regulación | Aplicabilidad | Estado |
|------------|---------------|--------|
| **GDPR** | Aplica si destinatarios son UE | Lista supresión activa, audit log de PII access pendiente formalizar |
| **CAN-SPAM** | Aplica USA | Lista supresión activa, unsubscribe forzoso en cada envío pendiente cablear |
| **CASL** | Aplica Canadá | Mismo gap que CAN-SPAM |
| **SOC 2** | No aplica MVP | Roadmap si llegamos a vender enterprise |
| **PCI** | No aplica | No procesamos tarjetas |

## 8. Roadmap de hardening

| Sprint | Foco | Gaps cubiertos |
|--------|------|----------------|
| **Demo viernes 29-may** | Flow funcional con controles existentes | (cero nuevos, solo verificación que los existentes operan) |
| **Sprint post-demo S1** | Hardening pre-exposición | G2, G5, G13, G21 (bloqueantes públicos) |
| **Sprint S2** | Operaciones seguras | G1, G4, G7, G10, G15, G22 |
| **Sprint S3** | Defensa en profundidad | G3, G6, G8, G9, G11, G14, G16, G17 |
| **Backlog** | Operacional | G12, G18, G19, G20, G23 |

## 9. Owner y revisión

- **CTO:** Juanes — aprueba este modelo y firma asunción de riesgo de los gaps abiertos.
- **Backend / Infra / QA:** Codex — implementa controles y reporta cobertura.
- **PM asistente:** Claude — mantiene este doc vivo, actualiza al cierre de cada sprint.

**Próxima revisión:** post-demo viernes 29-may, durante la retro del sprint.

## 10. Referencias

Docs ya existentes que este threat model consolida:

1. `OPENCLAW_PERMISSIONS_MATRIX.md` v2.0
2. `FASE_2_KILL_SWITCH.md`
3. `HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md`
4. `HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md`
5. `OPENCLAW_AUDIT_INTEGRATION.md`
6. `OPS_OPENCLAW_PERMISSIONS_HMAC_D4_AM.md` (ops-historico)
7. `OPS_OPENCLAW_C2_AUDIT_OVERRIDE_D7.md`
8. `OPS_OPENCLAW_SAFETY_REALTIME_OLA1.md`
9. `OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT.md`
10. `OPS_OPENCLAW_SAFETY_REALTIME_OLA1_PORT_REACT_V2.md`
11. `OPENCLAW_SKILLS_CATALOG.md`
12. `HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md`
13. `runbooks-demo-viernes/RUNBOOK_DESTRABAR_6_ITEMS.md`
