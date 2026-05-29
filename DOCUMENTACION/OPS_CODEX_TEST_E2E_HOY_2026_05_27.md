# OPS Codex — Test E2E de HOY (miércoles 27 may, demo viernes en 48h)

**Para:** Codex.
**De:** Claude + Juanes.
**Fecha:** 2026-05-27 tarde.
**Objetivo:** dejar el flow probable HOY para que mañana solo sea pulir bugs.

---

## Contexto

Juanes ya completó los 3 ítems técnicos:

- AWS IAM ampliado (`route53domains:RegisterDomain` + `route53:CreateHostedZone`)
- Webdock OPS key con write (en `.env.local` como `WEBDOCK_API_KEY_OPS`)
- `AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50`
- `DELIVRIX_ADMIN_CONTACT_JSON` con datos Delivrix LLC (COMPANY, Popayán, Cauca, infra@delivrix.com)

Quedan 2 blockers en el smoke real: `purchase_flag_disabled` (lo flipeamos el viernes) y `approval_not_found_or_expired` (esperando segundo aprobador).

## Tareas para HOY

### Tarea 1 — Reiniciar gateway y verificar admin_contact OK

El gateway PID 22996 todavía tiene la env vieja (antes de que Juanes agregara `DELIVRIX_ADMIN_CONTACT_JSON`). Reiniciá:

```bash
lsof -ti:3000 | xargs kill
sleep 1
cd "/Users/juanescanar/Documents/delivrix app"
nohup node --env-file=.env.local apps/gateway-api/src/main.ts > runtime/gateway.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:3000/health
```

Después corré el smoke de Claude:

```bash
bash DOCUMENTACION/runbooks-demo-viernes/smoke-test-onboarding.sh
```

**Resultado esperado:** ahora solo aparecen 2 blockers (`purchase_flag_disabled` + `approval_not_found_or_expired`). Si aparece `admin_contact_invalid` decimos a Claude/Juanes para revisar el JSON.

### Tarea 2 — Configurar segundo aprobador

Juanes va a pegar nombre + email del segundo aprobador en el chat. Cuando lo tengamos:

- Registralo como actorId distinto al de Juanes (sugerencia: `actorId` = primer nombre lowercase, ej. `sau` o `andres`).
- Si el approval token system necesita pre-registro (ver `apps/gateway-api/src/security/approval-token.ts`), agregalo a la lista permitida.
- Generá un test que simule 2 approvals concurrentes con actorIds distintos contra un artifact `register_domain` y verificá que el flow acepta cuando ambos firman, rechaza cuando solo uno firma o cuando ambos firmas vienen del mismo actorId.

Reportá: el OPS exacto que usaste para registrarlo + el output del test.

### Tarea 3 — Test E2E "blocked-but-validated" (sin compra real)

Una vez tarea 1 y 2 listas, hacé un smoke completo:

1. Generar approval token válido con los 2 aprobadores firmando un artifact `register_domain` para `delivrix-smoke-final.com` (dominio dummy).
2. Llamar `POST /v1/flows/onboard-sender-domain` con esa approval.
3. Verificar que el ÚNICO blocker que aparece es `purchase_flag_disabled`. Si aparece cualquier otro, es un bug.

**Esto valida que TODO el camino hasta T1 está OK sin gastar plata.** El flag de purchase queda en false para el día del demo.

### Tarea 4 — Test parcial T2–T6 con dominio que YA tenemos

Para verificar el resto del flow sin comprar dominio nuevo, usá uno que ya esté en la cuenta. Opciones según lo que veas en el inventario:

- `delivrix-mail.com` si ya está registrado.
- `nfcfilings.com` u otros que estén en IONOS o Route53 inventoreados.

Ejecutar los pasos siguientes en aislado:

- **T2 hosted zone:** `POST /v1/domains/route53/dns/upsert` con el dominio existente → debería crear/upsert hosted zone real y devolver `zoneId`.
- **T3 email auth:** `POST /v1/domains/auth/configure` con el mismo dominio → debería generar DKIM key + escribir 3 records DNS reales.
- **T4 Webdock VPS:** `POST /v1/webdock/servers/create` con profile `bit`, location `dk`, hostname FQDN `mail.<dominio-existente>`. La cuenta live reporta `dk` como location disponible. Debería levantar un VPS real prorrateado, válido hasta que lo bajes con `DELETE /v1/webdock/servers/{slug}`.
- **T5 install SMTP:** `POST /v1/servers/{slug}/provision-smtp` → SSH install postfix + opendkim + certbot. Verificar logs.
- **T6 bind:** `POST /v1/domains/bind` con el dominio + slug → MX + A records al IP del VPS.

Por cada paso reportá: HTTP status, response body resumido, qué workspace file se escribió, y si encontraste cualquier bug.

**Costo esperado:** 1 VPS Webdock prorrateado por las horas del test (~$0.20 USD si lo bajás en 1h). El dominio existente no se cobra dos veces. AWS Route53 hosted zone cuesta $0.50/mes prorrateado.

Si encontrás errores en T2-T6, **NO INTENTES ARREGLAR** todo de una; reportá la lista priorizada por severidad. Mañana jueves los arreglamos uno por uno.

### Tarea 5 — Limpieza post-test

Cuando termines tarea 4:

- `DELETE /v1/webdock/servers/{slug}` para no seguir pagando el VPS de test.
- Dejá el hosted zone Route53 si lo usaste con un dominio que vamos a seguir usando — sino bórralo también (`route53:DeleteHostedZone`).
- El gateway sigue corriendo en `:3000` para que Juanes pueda probar desde el panel admin.

## Qué reportar al final del día

```
✓ Tarea 1 — Gateway restart + admin_contact verified
  - Gateway PID nuevo: <PID>
  - Blockers en smoke: [purchase_flag_disabled, approval_not_found_or_expired]

✓ Tarea 2 — Segundo aprobador configurado
  - actorId nuevo: <id>
  - OPS aplicado: <comando o cambio en código>
  - Test 2-approvers: <pass/fail>

✓ Tarea 3 — Smoke blocked-but-validated
  - Único blocker restante: purchase_flag_disabled
  - Veredicto: ready para flip purchase el viernes

✓ Tarea 4 — Test T2-T6 con dominio existente
  - T2 hosted zone: <ok/error + detalle>
  - T3 email auth: <ok/error + detalle>
  - T4 Webdock VPS: <ok/error + slug>
  - T5 SMTP install: <ok/error + duración>
  - T6 bind: <ok/error + records creados>
  - Bugs encontrados: [lista priorizada]

✓ Tarea 5 — Cleanup
  - VPS Webdock bajado: <slug>
  - Hosted zone eliminada: <zoneId o "kept">

→ Mañana jueves Claude + Juanes arreglan: [lista de bugs]
```

## Por qué hoy y no mañana

Demo es viernes 11 am. Mañana jueves se necesita libre para:

1. Arreglar los bugs que el test de hoy revele.
2. Practice run del demo (Acto 1 + 2 + 3) en panel admin.
3. Hacer el smoke real con compra de dominio nuevo si Juanes decide hacerlo el jueves para tener evidencia.

Si llegamos al viernes sin haber probado T2-T6, vamos a ciegas. Tarea 4 de este OPS es la más importante.

Gracias.
