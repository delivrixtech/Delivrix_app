# OPS Codex — Verificar scopes Webdock + AWS IAM antes del demo viernes

**Para:** Codex.
**De:** Claude (sesión Cowork) + Juanes.
**Fecha:** 2026-05-26 tarde.
**Tiempo estimado:** 20-30 minutos.
**Prioridad:** alta — bloquea decisión de qué pedir a Juanes vs qué ya tenemos.

---

## Contexto

Pivote de scope del demo viernes acordado hoy con Juanes (ver mensaje WhatsApp con Sau): el demo se enfoca en **"OpenClaw como agente crea la infra SMTP desde 0"**. El warmup (T7) y el envío real quedan fuera del viernes — eso lo trabaja Sau la semana siguiente.

Resultado: necesitamos T1 → T6 funcionando end-to-end:
- T1 `register_domain_route53`
- T2 Route53 hosted zone + DNS upsert
- T3 `configure_email_auth` (SPF/DKIM/DMARC)
- T4 Webdock VPS provisioning
- T5 SSH install SMTP stack (postfix + opendkim + certbot)
- T6 bind domain to server (MX + A)

T7 (`start_warmup_seed`) queda OUT del viernes. → no necesitamos port 25 ni seed inboxes.

Antes de pedirle a Juanes que genere/cambie keys, **verificá si las que ya tenemos sirven** para T1-T6. Tu OPS Bloque 10 cerró el backend de los endpoints; ahora hay que validar que las credenciales tengan los scopes correctos.

---

## Tareas

### Tarea 1 — Webdock API key

`WEBDOCK_API_KEY_PRIMARY=07abb628...` está en `.env.local`. Hasta ahora se usó para inventario read-only (Hito 5.12). Para T4 necesitás `servers:write` (o `manage`, según cómo Webdock nombre el scope).

**Hacé:**

1. Loguearte a https://webdock.io/en/dash con la cuenta `Claude · DK` (Juanes te puede pasar el login si no lo tenés guardado).
2. Profile → API → API Keys. Listar todas las keys existentes con sus scopes.
3. Para la key que termina en `e1127` (la que está en `.env.local`), reportar **textualmente** qué scopes tiene asignados.
4. **Test programático en paralelo** (más confiable que la UI): intentar un dry-run de `createServer` desde tu adapter `webdock-adapter.ts` contra la cuenta real. Si responde 401/403 → no tiene write. Si responde 400 (bad params) o 422 (validation) → sí tiene write, solo le faltan params válidos. Si responde 201/200 → ¡CUIDADO! cancelar el server creado inmediatamente, pero confirmás write scope.

Sugerencia para el dry-run sin gastar plata:

```bash
curl -X POST https://api.webdock.io/v1/servers \
  -H "Authorization: Bearer $WEBDOCK_API_KEY_PRIMARY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  --max-time 10
```

Body vacío → Webdock va a devolver 400 con la lista de campos requeridos. Si te devuelve 401/403 en cambio, el problema es scope, no params.

**Resultado esperado:**

- ✅ Key actual tiene `servers:write` → no hay nada que pedirle a Juanes en este frente.
- ⚠️ Key actual solo tiene read → opciones: (a) editar scopes de la existente en el dashboard si Webdock lo permite; (b) generar una nueva con scope ampliado y avisarle a Juanes que actualice `.env.local`.

---

### Tarea 2 — AWS IAM scopes

`AWS_ROUTE53_ACCESS_KEY_ID=AKIAVZCP...` está en `.env.local`. La policy inicial era `delivrix-route53-discover` con permisos de discovery solamente (Bloque 5). Para T1-T6 necesitamos:

- `route53domains:RegisterDomain` (T1)
- `route53:CreateHostedZone` (T2)
- `route53:ChangeResourceRecordSets` (T2, T3, T6)
- `route53:GetChange` (T6 para polling DNS propagation)
- Más los discovery existentes que ya están.

**Hacé:**

1. Test programático rápido contra cada acción crítica usando `aws` CLI con el profile de Delivrix (si está configurado) o `awscurl` con las creds del `.env.local`. Por ejemplo:

```bash
aws route53 list-hosted-zones --profile delivrix-route53 --max-items 1
# Si responde con la lista (vacía o no): ✅ ChangeResourceRecordSets list-side OK
# Si responde AccessDenied: ⚠️ falta ampliar policy
```

```bash
aws route53domains list-domains --profile delivrix-route53 --max-items 1
# Lo mismo para Route53 Domains.
```

Para probar las acciones write sin disparar nada destructivo, usá `--dry-run` cuando esté disponible, o llamadas que validan permiso sin ejecutar (algunos endpoints AWS permiten esto vía `?dryRun=true` en SDK pero no en CLI — verificá).

2. Reportar **qué acciones de la siguiente lista funcionan y cuáles devuelven AccessDenied:**

   - `route53domains:CheckDomainAvailability` (ya sabemos que sí, Bloque 5)
   - `route53domains:RegisterDomain` (esperado: AccessDenied todavía)
   - `route53:ListHostedZones`
   - `route53:CreateHostedZone` (esperado: AccessDenied; podés simularlo con un nombre dummy y leer el error)
   - `route53:ChangeResourceRecordSets`
   - `route53:GetChange`

**Resultado esperado:**

- Confirmás qué scopes faltan exactamente.
- Si faltan, Juanes tiene en `DOCUMENTACION/runbooks-demo-viernes/aws-iam-policy-route53-delivrix-ops.json` la policy lista para pegar — verificala vos a ver si te parece bien, o ajustá si tenés mejor criterio (por ejemplo restringir `Resource` por hosted zone ID).

---

### Tarea 3 — Tester end-to-end del backend Bloque 10

Una vez confirmes los dos puntos arriba, dispará un smoke real **sin compra** (modo dry-run o flag `ENABLE_PURCHASE=false`) del endpoint `POST /v1/flows/onboard-sender-domain` contra un dominio dummy (ej. `delivrix-mail-test-2026.com`).

El objetivo: validar que el flow completo T1-T6 corre sin tropezarse con bugs de wiring entre tus 8 commits del Bloque 10.

Esperás que el gateway responda algo así:

```json
{
  "status": "blocked",
  "blockers": ["purchase_flag_disabled"],
  "phase": "t1_register_domain",
  "auditEventId": "..."
}
```

Si en cambio te devuelve un 500 o un blocker inesperado (`adapter_initialization_failed`, `workspace_unavailable`, etc.), tenemos un bug que arreglar antes del jueves.

---

## Qué reportar de vuelta (formato sugerido)

Cuando termines, contestá en el chat con Juanes algo así:

```
✓ Webdock key 07abb628...e1127:
  - scopes actuales: [lista textual del dashboard]
  - dry-run createServer: [201/400/401/403]
  - veredicto: [sirve / hay que ampliar / hay que generar nueva]

✓ AWS IAM AKIAVZCP...:
  - acciones probadas: [tabla con OK/AccessDenied]
  - veredicto: [sirve / hay que pegar policy del runbook / hay que ajustar policy]

✓ Smoke T1-T6 con dominio dummy:
  - response: [paste de los blockers]
  - bugs encontrados: [si los hubo]

→ Lo que Juanes tiene que hacer YA:
  - [lista corta y específica, o "nada por este lado, listos"]
```

---

## Por qué esto antes de cualquier otra cosa

Si Codex confirma que las keys actuales ya sirven, Juanes solo tiene que:

1. Llenar `DELIVRIX_ADMIN_CONTACT_JSON` con datos legales (10 min).
2. Activar `AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true` + cap $50 (1 min).
3. Designar segundo aprobador para la regla 2-personas (5 min coordinación).

Total Juanes: ~15 minutos. Sin esperar a soporte de terceros. Cero riesgo.

Si Codex encuentra gaps, los reportás puntuales y Juanes los resuelve sabiendo exactamente qué falta — no asumimos.

Gracias.
