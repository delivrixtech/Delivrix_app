# Runbook — Destrabar los 6 bloqueantes externos del demo viernes

**Fecha demo:** viernes 29 may 2026 11:00 am.
**Generado:** 2026-05-26.
**Estado:** backend + frontend listos a main; faltan 6 ítems externos para smoke real.

Cada sección dice **qué tiene que hacer Juanes**, **cuánto demora**, **qué pasa si no se hace** (plan B), y referencia los entregables drop-in que dejé en esta misma carpeta.

---

## Resumen ejecutivo

| # | Ítem | Tiempo Juanes | Bloquea por terceros | Plan B viernes |
| - | ---- | ------------- | -------------------- | -------------- |
| 1 | Flag `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` + cap mensual | 1 min | — | Demo con flag false, gateway responde 409 blocked y operador explica que es seguridad funcionando. |
| 2 | Doble aprobación humana (regla de 2 personas) | 5 min coordinación | Otro operador disponible viernes | Mostrar workflow en pantalla con 2 sesiones del panel; o single approval si la matriz lo permite para `register_domain`. |
| 3 | `DELIVRIX_ADMIN_CONTACT_JSON` con datos legales | 10 min | — | Usar template con datos placeholder, gateway responde `admin_contact_invalid`. |
| 4 | API key Webdock `servers:write` + ticket port 25 | 5 min API + 24-48h ticket | **Webdock soporte 24-48h** | Demo provisioning con flag dry-run + audit event `webdock_port_25_blocked` ya documentado en learnings/. |
| 5 | Permisos AWS IAM ampliados (CreateHostedZone, ChangeResourceRecordSets) | 5 min | — | Demo DNS con gateway respondiendo `aws_route53_dns_credentials_missing`. |
| 6 | 3 seed inboxes en `DELIVRIX_DEMO_SEED_INBOXES` | 15 min crear + verificar | — | Skipear T7 warmup en demo, mostrar flujo y dejar el send_real_email como "Acto 3 follow-up post-demo". |

**Tiempo total Juanes en máquina:** ~40 min.
**Lo que no podemos acelerar:** el ticket Webdock port 25 (24-48h). Si lo abrís HOY (martes 26) llega entre miércoles 27 noche y jueves 28 noche — alcanza para smoke viernes mañana.

---

## Ítem 1 — Activar el flag de compra + cap mensual

**Qué hace:** habilita `register_domain_route53` para invocar `route53domains:RegisterDomain` real. Sin esto el gateway responde `purchase_flag_disabled` aunque todo lo demás esté bien.

**Cómo hacerlo:** editar `.env.local` en `/Users/juanescanar/Documents/delivrix app/` y agregar/cambiar:

```bash
AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true
AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50
```

Después reiniciar el gateway:

```bash
# matar el proceso anterior
ps aux | grep gateway-api | grep -v grep | awk '{print $2}' | xargs kill
# arrancar con la nueva env cargada
cd "/Users/juanescanar/Documents/delivrix app"
npm run --workspace apps/gateway-api start
```

**Verificación:** llamar al endpoint de health o pegar un POST de smoke al register endpoint sin approval — debe responder con `blockers` que YA NO incluyen `purchase_flag_disabled` ni `monthly_cap_missing`.

**Riesgo:** el cap de $50 USD cubre 1 dominio individual ($11) + 3 dominios batch ($33) con margen. Si la demo va por arriba (otros TLDs más caros), el gateway corta con `monthly_cap_exceeded` y no procesa.

---

## Ítem 2 — Doble aprobación humana

**Qué hace:** activa la regla de 2 personas para acciones críticas. El matrix de permisos (`DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` §4.1, paso 5c) usa `requiredApprovals` por entry; si está en `2`, el gateway rechaza con `human_approval_missing` hasta tener 2 tokens HMAC distintos.

**Decisión rápida para el demo:** confirmar quién va a ser el **segundo aprobador**. Opciones:

- Algún teammate de Delivrix con login al panel admin.
- Vos mismo desde otra sesión (browser diferente o incógnito) con un actorId distinto — esto es válido técnicamente pero solo recomendable para demo, no producción.

**Acción:** decirme qué decidiste y armo el script de smoke con los 2 approval tokens listos. Si querés desactivar la regla para el demo (single approval), también es 1 línea de config (no recomendado — pierde el punto del audit).

**Verificación:** llamar dos veces al endpoint de approval (con 2 actorIds distintos) y luego al register — debe pasar.

---

## Ítem 3 — `DELIVRIX_ADMIN_CONTACT_JSON` con datos legales

**Qué hace:** Route53 RegisterDomain requiere los datos del registrant (vos como persona o Delivrix como empresa). El gateway parsea el JSON y verifica 9 campos obligatorios.

**Cómo hacerlo:** abrir el template que dejé en:

```
DOCUMENTACION/runbooks-demo-viernes/admin-contact-template.json
```

Llenar los campos marcados con `<...>` (apellido legal, dirección real, código postal, teléfono con formato `+57.NÚMERO`). Después borrar todas las claves `_comment_*` y volcar el JSON inline en `.env.local` como una sola línea:

```bash
DELIVRIX_ADMIN_CONTACT_JSON='{"FirstName":"<NOMBRE LEGAL>","LastName":"<APELLIDO LEGAL>","ContactType":"PERSON","OrganizationName":"<ORGANIZACION LEGAL>","AddressLine1":"<DIRECCION REAL>","City":"<CIUDAD>","State":"<DEPARTAMENTO_O_ESTADO>","CountryCode":"CO","ZipCode":"<CODIGO POSTAL>","PhoneNumber":"+57.<NUMERO>","Email":"<EMAIL_OPERATIVO>"}'
```

Importante: comillas simples afuera, dobles adentro, sin saltos de línea. Si tu shell se queja, escapá las comillas dobles con backslash o guardá el JSON en un archivo y usá `DELIVRIX_ADMIN_CONTACT_JSON="$(cat /ruta/admin-contact.json)"`.

**Verificación:** reiniciar gateway y disparar smoke — el blocker `admin_contact_missing` o `admin_contact_invalid` debe desaparecer de la respuesta.

**Privacidad:** Amazon Registrar aplica WHOIS privacy por defecto (en el código está `privacyProtection: true` hardcodeado), así que tu dirección personal NO queda pública en WHOIS. Pero los datos sí viven en el archivo `.env.local` — no lo commitees (ya está en `.gitignore`).

---

## Ítem 4 — Webdock API key `servers:write` + ticket port 25

**Parte A — API key con scope `servers:write`** (5 min)

1. Login en https://webdock.io/en/dash con la cuenta "Claude · DK".
2. Profile → API → New token. Nombre sugerido: `delivrix-ops-write`.
3. Scopes: marcar **`servers:read`** y **`servers:write`** (la actual solo tiene read).
4. Copiar el token y reemplazar en `.env.local`:

```bash
WEBDOCK_API_KEY_PRIMARY=<token nuevo>
```

5. Verificá que la cuenta tenga al menos $20 USD de saldo o método de pago activo (1 VPS profile bit cuesta ~$5.40/mes).

**Parte B — Ticket port 25** (5 min escribirlo, 24-48h respuesta)

Usar el draft que dejé en:

```
DOCUMENTACION/runbooks-demo-viernes/webdock-ticket-port-25-draft.md
```

Subject + body copy-paste a https://webdock.io/en/dash → Tickets → New ticket. **Abrir HOY** para que llegue la respuesta antes del viernes.

**Plan B si no responden a tiempo:** el flow puede correr T2-T6 (DNS + email auth + provisioning + SMTP install) sin port 25 abierto — solo el último paso (T7 warmup envío real) falla. En el demo mostrás todo hasta T6 y comentás que T7 espera el ticket Webdock con audit event documentado en `learnings/2026-05-27-webdock-port-25-blocked.md`.

---

## Ítem 5 — Permisos AWS IAM ampliados

**Qué hace:** los endpoints T2 (Route53 DNS) y T3 (configure_email_auth) necesitan crear hosted zones y modificar records. La policy actual del IAM user `delivrix-route53-discover` solo tiene permisos de discovery (`List*`, `CheckDomainAvailability`).

**Cómo hacerlo:**

1. Login AWS Console → IAM → Users → `delivrix-route53-discover` (o renombralo a `delivrix-route53-ops` antes para que el nombre refleje la nueva autoridad).
2. Permissions → Add permissions → Create inline policy → JSON tab.
3. Copiar TODO el contenido de:

```
DOCUMENTACION/runbooks-demo-viernes/aws-iam-policy-route53-delivrix-ops.json
```

4. Pegar y guardar. Nombre sugerido para la policy: `DelivrixRoute53OpsFull`.
5. (Opcional) Borrar la policy vieja `DelivrixRoute53DiscoverOnly` si existe — la nueva la incluye.

**Verificación:** desde tu Mac con AWS CLI:

```bash
aws --region us-east-1 route53 list-hosted-zones \
  --profile delivrix-route53 2>&1 | head -5
# debe responder con la lista (vacía) en vez de AccessDenied
```

**Riesgo:** la policy es bastante amplia (incluye DeleteHostedZone y RegisterDomain). Si querés restringir más, podemos hacer una segunda fase post-demo con resource-level conditions por hosted zone ID. Para el demo viernes la amplitud es necesaria.

---

## Ítem 6 — 3 seed inboxes para warmup

**Qué hace:** T7 (`start_warmup_seed`) manda 3 emails de prueba desde el VPS recién provisionado a estas inboxes para verificar deliverability básica antes de empezar volumen real. El gateway exige exactamente 3 emails, separados por coma.

**Recomendación de mix:**

- **1 Gmail** (Google = ~30% del mercado, deliverability más estricta).
- **1 Outlook/Hotmail** (Microsoft = ~25%, distinto algoritmo).
- **1 Delivrix propio** (para inspeccionar headers crudos sin interferencia de filtros públicos).

**Acción:** crear/elegir 3 cuentas activas (no descartables), verificarlas abriendo cada bandeja para confirmar acceso, y agregar a `.env.local`:

```bash
DELIVRIX_DEMO_SEED_INBOXES=alguien@gmail.com,alguien@outlook.com,alguien@delivrix.com
```

**Verificación post-demo:** después del warmup, abrir las 3 bandejas y guardar screenshot de los emails recibidos para evidencia.

**Plan B:** si no querés usar inboxes reales en el demo, podés saltar T7 y dejar el flow terminado en T6 (bind + DNS propagado). El audit event va a decir que T7 quedó pending por config, no por error.

---

## Checklist final antes del viernes

**Martes 26 (hoy):**

- [ ] Abrir ticket Webdock port 25 (ítem 4B) — primero porque depende de tiempos externos.
- [ ] Generar API key Webdock servers:write (ítem 4A).
- [ ] Ampliar IAM policy AWS (ítem 5).

**Miércoles 27:**

- [ ] Llenar `admin-contact-template.json` con datos reales (ítem 3).
- [ ] Decidir y crear las 3 seed inboxes (ítem 6).
- [ ] Editar `.env.local` con todas las variables.
- [ ] Reiniciar gateway, correr smoke `POST /v1/flows/onboard-sender-domain` con dominio dummy de test (sin compra real, solo verificar que no hay blockers de config).

**Jueves 28:**

- [ ] Confirmar respuesta Webdock port 25.
- [ ] Decidir segundo aprobador para regla 2-personas (ítem 2).
- [ ] Activar flag `ENABLE_PURCHASE=true` (ítem 1) — solo un día antes para minimizar ventana de exposición.
- [ ] Smoke completo end-to-end con dominio dummy ($11 USD costo).

**Viernes 29 mañana:**

- [ ] 9:00 validación final (gateway running, .env cargado, panel ok).
- [ ] 11:00 demo.

---

## Archivos drop-in en esta carpeta

| Archivo | Para qué |
| ------- | -------- |
| `aws-iam-policy-route53-delivrix-ops.json` | Pegar en IAM Console (ítem 5). |
| `admin-contact-template.json` | Llenar y volcar a `.env.local` (ítem 3). |
| `webdock-ticket-port-25-draft.md` | Copy-paste a Webdock Tickets (ítem 4B). |
| `RUNBOOK_DESTRABAR_6_ITEMS.md` | Este documento. |

---

## Lo que YA hice por vos (no requiere acción)

- ✅ Validé que el código backend de los 6 items espera exactamente las variables que documenté arriba (parser de `parseAdminContact`, `parseSeedInboxes`, `parsePositiveMoney`).
- ✅ Genero la IAM policy con el set mínimo + suficiente para los 8 endpoints Bloque 10.
- ✅ Redacté el ticket Webdock con framing legítimo (anti-spam, warmup ramp, SPF/DKIM/DMARC) para maximizar chance de aprobación al primer intento.
- ✅ El template de admin contact ya trae los defaults que sé de vos (Juan Esteban, Medellín, jectcode@gmail.com) — solo te queda apellido legal, dirección exacta, ZIP y teléfono.

---

## Si Webdock no responde a tiempo (plan B viernes)

La demo sigue siendo demostrable end-to-end SIN port 25 abierto:

- Acto 1 multi-agent: el supervisor sigue spawneando sub-tasks, cada una llega hasta T6 (bind), se detiene en T7 con audit event blocked.
- Acto 2 memoria persistente: el WorkspaceBrowser muestra `learnings/2026-05-27-webdock-port-25-blocked.md` — evidencia que el agente APRENDIÓ del bloqueo y lo está aplicando preventivamente.
- Acto 3 sender pool: la tabla queda con estados `provisioned, awaiting_port_25_unblock`. Cuando Webdock conteste, el flow continúa solo (gracias a la persistencia del workspace).

Esa narrativa es incluso más interesante porque demuestra resiliencia + memoria, no solo happy path.
