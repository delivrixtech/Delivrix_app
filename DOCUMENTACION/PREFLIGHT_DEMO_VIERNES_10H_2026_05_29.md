# Pre-flight checklist — Demo viernes 29-may 11h Colombia

**Para:** Juanes (operador del demo).
**De:** Claude (QA + PM).
**Cuándo:** Viernes 29-may, 10:00 COT — 1h antes del demo.
**Tiempo total:** ~30 min de verificación + 30 min de margen.

> **Regla de oro del día**: si algo falla durante esta verificación, parar el demo y diagnosticar. NO empezar el demo con red flags abiertos. Es mejor postergar 30 min que tener un demo a medias frente al CTO de Hostinger.

---

## Fase 1 — Infraestructura backend (10:00 - 10:10)

### 1.1 Gateway local
```bash
cd /Users/juanescanar/Documents/delivrix\ app
pnpm gateway:dev  # si no está corriendo ya
# Verificar puerto 3000:
curl -m 3 http://localhost:3000/health
```
- [ ] Respuesta `{"status":"ok"}` en <500ms
- [ ] Postgres OK en el response
- [ ] Redis OK en el response

### 1.2 Container Hostinger (chat OpenClaw)
```bash
ssh -i ~/.ssh/delivrix-ops root@2.24.223.240 \
  'docker ps --format "{{.Names}} | {{.Status}}" | grep openclaw'
```
- [ ] Container `openclaw-dtsf-openclaw-1` aparece como `Up`
- [ ] **Si Restarting o ausente** → Acto 3 del demo va en modo skills-directas (ver plan B abajo). NO improvisar arreglo en vivo.

### 1.3 Probar chat E2E (si 1.2 pasó)
```bash
ssh -i ~/.ssh/delivrix-ops root@2.24.223.240 \
  'docker exec openclaw-dtsf-openclaw-1 openclaw gateway call chat.send \
    --json --timeout 20 \
    --params "{\"sessionKey\":\"agent:main:operator\",\"message\":\"ping preflight\",\"idempotencyKey\":\"preflight-$(date +%s)\"}"'
```
- [ ] stdout parsea JSON con `"status":"started"`
- [ ] **Si falla** → fallback skills-directas.

### 1.4 Bedrock latency
Abrir panel admin localhost:5173 → Canvas Live → mandar prompt "Hola, ¿cómo estás?".
- [ ] Respuesta visible en <10s
- [ ] No errores en consola del navegador

---

## Fase 2 — Estado .env.local (10:10 - 10:15)

```bash
cd /Users/juanescanar/Documents/delivrix\ app
grep -E "^(WARMUP_ENABLE_SEND|WARMUP_DEFAULT_SEED_INBOXES|WEBDOCK_SSH_ACCESS_SETTLE_MS|AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE|AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD)=" .env.local
```
- [ ] `WARMUP_ENABLE_SEND=true`
- [ ] `WARMUP_DEFAULT_SEED_INBOXES=` **3 inboxes Mailtrap reales** (no `xxxxx`)
- [ ] `WEBDOCK_SSH_ACCESS_SETTLE_MS=120000`
- [ ] `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true`
- [ ] `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50`

---

## Fase 3 — Smoke test rápido (10:15 - 10:30)

> Solo si el smoke E2E completo de Codex (SMOKE_DEMO_VIERNES_RESULT.md) **NO** se corrió o falló anoche.

### 3.1 Mailtrap inbox vacío
- [ ] Login a Mailtrap → sandbox del demo → inbox vacío (limpiarlo si quedaron seeds de Codex anoche)

### 3.2 Dominio descartable preparado
Elegir un nombre nuevo NO usado antes (no reusar `delivrix-demo-d10-20260527`):
```
delivrix-demo-final-${YYYYMMDD}.click   (ej. delivrix-demo-final-20260529.click)
```
- [ ] Nombre escrito en notas (no improvisar en vivo)
- [ ] Disponibilidad verificada en Route53 (curl al endpoint discover o panel /domains)

### 3.3 Wallet estado
Abrir panel admin → Sender Pool → Wallet:
- [ ] Cap mensual: $50 USD
- [ ] Gastado del mes: <$15 USD (margen para el demo + plan B)
- [ ] Disponible: >$35 USD

### 3.4 Kill Switch
Panel admin → Seguridad:
- [ ] Kill Switch global: **ARMADO** (verde)
- [ ] Responsable: tu cuenta
- [ ] Sin alertas críticas activas

---

## Fase 4 — Frontend del demo (10:30 - 10:45)

### 4.1 Panel admin levanta limpio
```bash
cd /Users/juanescanar/Documents/delivrix\ app/apps/admin-panel
pnpm dev
# Abrir http://localhost:5173 en navegador
```
- [ ] Carga en <3s
- [ ] Vista General renderiza completa (KPIs visibles, banner OpenClaw, pipeline)
- [ ] Tema dark activo (modo demo)
- [ ] **NO se ven los chips pg/redis/branch en topbar** (limpieza de ayer)
- [ ] Footer minimal: `[D] Delivrix` izquierda · `● Solo lectura` derecha

### 4.2 Recorrido por las 11 vistas (1 minuto por vista)
- [ ] Vista general — KPIs + banner + pipeline OK
- [ ] Onboarding — stepper visible
- [ ] Canvas Live — chat input visible, viewport derecho con tabs
- [ ] Hardware — banner Telemetría stale, KPIs CPU/RAM
- [ ] Recolector — 4 fuentes con confidence bars
- [ ] Infraestructura — atención requerida (Webdock 401 + servidor offline) destacada
- [ ] Dominios — guardrail strip + form discover (sin "HITO 5.12")
- [ ] Sender Pool — wallet card + flow steps
- [ ] Clústeres — KPIs + cards con sparkline
- [ ] Aprendizaje — skills con sparkline
- [ ] Seguridad — Kill Switch hero + KPIs

### 4.3 Tema light/dark
- [ ] Toggle ☀️ en topbar funciona — cambio limpio sin flash
- [ ] Light mode: footer + topbar + cards renderizan OK
- [ ] Dark mode: ningún cuadrado blanco (audit de contraste de ayer cerrado)

---

## Fase 5 — Setup de pantalla (10:45 - 10:55)

- [ ] OBS o ScreenShare configurado y probado
- [ ] Resolución navegador a algo cómodo (1920x1080 o lo que use el monitor)
- [ ] Zoom navegador 100% (no 90, no 110 — Tailwind responsive optimizado para 100)
- [ ] **Pestañas que NO deben estar abiertas:** Slack, Gmail, terminal con secretos, .env files
- [ ] **Pestañas abiertas:** solo panel admin localhost:5173 + Mailtrap sandbox + opcional doc del demo
- [ ] Notificaciones Mac silenciadas (Do Not Disturb)
- [ ] Notificaciones Slack/Discord silenciadas
- [ ] Audio Mac probado (sin micro mute si el demo es con audio)
- [ ] **Wifi estable** — si hay duda, usar cable o hotspot personal estable
- [ ] Cargador conectado

---

## Fase 6 — Última corrida mental del guion (10:55 - 11:00)

### Acto 1 — Vista general + OpenClaw propone (2 min)
- [ ] Abrir / (Vista general)
- [ ] Comentar: "Delivrix gobierna infraestructura de correo en modo solo lectura. OpenClaw observa, valida y propone. Los humanos aprueban cada acción real."
- [ ] Mostrar banner OpenClaw recomendando algo (cluster A con quejas 0.18%)
- [ ] Mostrar KPIs en vivo (Reputación crítica 28.6 — eso es señal real, no demo)

### Acto 2 — Discover & propose dominio (3 min)
- [ ] Click /Dominios
- [ ] Mostrar guardrails: cap $50, WHOIS forzado, doble firma, compra real bloqueada
- [ ] Escribir keyword: "delivrix-mail"
- [ ] Click "Sugerir con OpenClaw"
- [ ] Mostrar propuestas con score (Route53 vs Porkbun comparativa)

### Acto 3 — Aprovisionamiento E2E (5 min) ⚠️ AQUI VA EL FLOW REAL
- [ ] Click Canvas Live
- [ ] **Si chat OK:** "OpenClaw, comprá el dominio delivrix-demo-final-20260529.click y configurá DNS + VPS + SMTP + bind."
- [ ] **Si chat NO OK (plan B skills-directas):** ir a /Sender Pool o /Onboarding → disparar las skills una por una con botones. Decir: "El operador puede disparar el flow desde botones con audit firmado; el chat conversacional con Bedrock es modo avanzado que mostramos en una segunda demo."
- [ ] Mostrar feed live de tareas (Warmup seed · Route53 hosted zone · Cleanup Webdock · Bind dominio · SMTP stack · ...)
- [ ] Mostrar viewport API/Archivos/Audit con eventos firmados

### Acto 4 — Warmup del inbox (2 min)
- [ ] Disparar `start_warmup_seed`
- [ ] Abrir Mailtrap sandbox en pestaña aparte (pre-abierta)
- [ ] Mostrar los 3 emails llegando en vivo
- [ ] Comentar: "Cada email firmado, cada acción en audit chain append-only, ningún envío real fuera de los seeds autorizados."

### Acto 5 — Kill Switch + cierre (1 min)
- [ ] /Seguridad
- [ ] Mostrar Kill Switch ARMADO + regla de 2 personas
- [ ] Comentar: "En cualquier momento, dos humanos pueden detener TODO el plano de envíos en 1 click. Esa es la barandilla final."
- [ ] Cierre: "Hoy: capacidad preparada, sin envíos reales. La diferencia con producción es solo un flag de aprobación humana."

---

## Plan B narrativo (si algo falla en vivo)

### Si el chat OpenClaw queda mudo
**NO improvisar arreglo.** Decir:
> "El chat conversacional con Bedrock está en deploy parcial — corrí la verificación del bridge hace 30 minutos. Lo que sí está al 100% es el flow vía skills directas; se los muestro y dejamos el chat para una segunda demo cuando consolidemos el deploy del bridge en el container Hostinger."

Luego ir a /Onboarding o /Sender Pool y disparar las skills una por una con botones.

### Si el SMTP install reintenta visiblemente (sshConnectAttempts > 1)
Decir:
> "Esa es la telemetría de retry transparente — el adapter espera a que cloud-init complete en el VPS recién creado. El operador no tiene que intervenir; el retry queda en evidence y se cierra solo. Vemos `sshConnectAttempts: 2` y `cloudInitSettleSeconds: 90` en audit. Es exactamente la observabilidad que queríamos."

### Si Mailtrap no muestra los seeds
Refrescar la pestaña Mailtrap. Si después de 30s no llegan, decir:
> "El audit chain confirma el envío firmado del lado nuestro. Mailtrap tiene latencia de inbox de hasta 1 minuto en sandbox; vamos a seguir y los muestro al final de la demo cuando aparezcan."

### Si TODO falla y el demo descarrila
Decir:
> "Voy a parar acá. Esto es lo que tenemos: [enumerar puntos cerrados antes de la falla]. Lo que ven en vivo es exactamente el estado del MVP día 21 de 30. Las cosas que no se mostraron están grabadas; se las puedo mandar por video después. Prefiero ser preciso con ustedes que improvisar."

Eso transmite control + transparencia, no improvisación.

---

## Después del demo

- [ ] Notas frescas: qué se preguntó, qué impresionó, qué hay que mejorar para Final.1
- [ ] Audit chain del demo guardado (no purgar)
- [ ] Mailtrap sandbox guardado (screenshot de inbox con 3 emails)
- [ ] Wallet snapshot post-demo (cuánto se gastó realmente)
- [ ] Mensaje de gracias al CTO Hostinger
- [ ] Bajón / cerveza / lo que sea

---

— Claude
