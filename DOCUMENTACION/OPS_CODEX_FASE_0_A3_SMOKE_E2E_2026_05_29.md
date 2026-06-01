# OPS Codex — Fase 0 A3 — Smoke E2E real con 1 firma

**Para:** Codex CLI.
**De:** Claude PM.
**Fecha:** 2026-05-29 viernes ~15:30 COT.
**Tiempo límite:** 2h (cerrar antes de 17:30 COT).
**Pre-requisitos:** A1 (`cb93e2c`) + A2 (`13d9357`) cerrados + B5 wire ApprovalGate (en disco, esperando commit).
**Protocolo:** sub-agentes seniors. **Backend Senior + QA Senior + Security Senior + PM (Juanes) firman ANTES de gastar dinero.**

## Contexto

A1 + A2 endurecieron audit chain + auto-rollback + anchor + audit-batch origin. ApprovalGate.tsx + PendingApprovalsPanel wireados. Hoy validamos el flow REAL con dinero real:

- Compra dominio descartable Route53 (~$11 USD)
- Configurar DNS (SPF + DKIM + DMARC) en Route53
- Provisionar VPS Webdock (~$5 USD primer mes)
- Install SMTP stack en el VPS
- Bind dominio ↔ servidor
- Warmup seed con 3 emails a `jectcode+fase0-{1,2,3}@gmail.com`

**TOTAL costo estimado: ~$20 USD + Bedrock <$1.**

Las skills ya están en `supervised_local_state` (cambio de norte). El operador firma 1 vez con `ApprovalGate` y se ejecuta.

**LIMITACIÓN HOY:** Tool calling Bedrock NO está implementado (es Fase 1 lunes). El agente genera dry-runs en chat pero NO invoca skills automáticamente. **El smoke A3 valida la infra de skills + firma + audit chain + auto-rollback + webhook, NO la orquestación E2E full automática.** Eso queda para demo Fase 5 dentro de 7 semanas.

## Pre-flight (10 min)

### Flags operativos en `.env.local`

Confirmar que estén estos (varios ya existen):

```
AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE=true
AWS_ROUTE53_DOMAINS_MONTHLY_CAP_USD=50
AWS_ROUTE53_DNS_ENABLE_WRITES=true
WEBDOCK_SERVERS_ENABLE_CREATE=true
SMTP_PROVISIONING_ENABLE_SSH=true
WARMUP_ENABLE_SEND=true
WARMUP_RAMP_ENABLE=true
DOMAIN_BIND_ENABLE=true
EMAIL_AUTH_ENABLE_WRITES=true
AUDIT_ANCHOR_KEY=<32+ chars random ya seteado por A2>
EQUIPO_WEBHOOK_URL=        # vacío → buffer local
```

Si alguno falta, agregarlo. Si algún handler requiere un flag NUEVO que NO existe en código, **agregar el chequeo del flag con default a `false` y rejectar si no está habilitado**.

### Gateway corriendo

```bash
curl -s http://127.0.0.1:3000/health | jq .status
# "ok"

curl -s http://127.0.0.1:3000/v1/audit-chain/verify | jq .ok
# true
```

### Backup pre-smoke

```bash
cp /Users/juanescanar/Documents/delivrix\ app/.audit/audit-events.jsonl \
   /Users/juanescanar/Documents/delivrix\ app/runtime/audit-pre-smoke-fase0.jsonl
```

## Pasos del smoke (~90 min)

### Paso 1 — Dominio descartable (~10 min, ~$11 USD)

Elegir nombre fresco. Sugerencia:
```
DOMAIN="delivrix-fase0-$(date +%Y%m%d%H%M).click"
echo $DOMAIN
```

Disparar compra:
```bash
curl -X POST http://127.0.0.1:3000/v1/domains/route53/register \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"durationYears\": 1,
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

**Aquí pasa una de dos cosas:**

**A) Si el handler exige approvalToken vigente (pre-cambio norte):** primero pegale al agente vía chat para que proponga la compra, copiá el `auditId` del dry-run, luego firmás via ApprovalGate del panel — el ApprovalGate POSTea a `/v1/openclaw/proposals/{auditId}/sign` que devuelve el approval token + dispatcha la skill.

**B) Si el handler ya acepta `actorId` + `approvalToken` derivado de la firma:** mandás la request directa y el gateway valida la firma con audit chain.

Probá A primero. Si no funciona en 5 min, fallback a B con un token manualmente generado.

**Criterio de aceptación:** dominio aparece en `runtime/openclaw-workspace/inventory/domains.json` + audit `oc.route53.domain_registered` + webhook broadcast (buffer local).

### Paso 2 — DNS records (~15 min)

```bash
# Generar DKIM key primero
DKIM_PUBKEY=$(openssl genrsa 2048 | openssl rsa -pubout 2>/dev/null | grep -v -- "-----" | tr -d "\n")

curl -X POST http://127.0.0.1:3000/v1/dns/route53/upsert \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"records\": [
      { \"type\": \"TXT\", \"name\": \"$DOMAIN\", \"value\": \"v=spf1 ip4:<IP_PLACEHOLDER> -all\", \"ttl\": 300 },
      { \"type\": \"TXT\", \"name\": \"default._domainkey.$DOMAIN\", \"value\": \"v=DKIM1; k=rsa; p=$DKIM_PUBKEY\", \"ttl\": 300 },
      { \"type\": \"TXT\", \"name\": \"_dmarc.$DOMAIN\", \"value\": \"v=DMARC1; p=quarantine; rua=mailto:dmarc@$DOMAIN\", \"ttl\": 300 }
    ],
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

**Pre-snapshot:** A2 hace captura automática antes de mutar.
**Verify propagación:** A2 levanta poll async (no bloquea). Si en 5 min no propaga, rollback automático.

**Criterio:** records visibles con `dig TXT $DOMAIN`. Si rollback se dispara, ver audit `oc.dns.auto_rolled_back`.

### Paso 3 — VPS Webdock (~20 min, ~$5 USD)

```bash
curl -X POST http://127.0.0.1:3000/v1/webdock/servers/create \
  -H "content-type: application/json" \
  -d "{
    \"label\": \"delivrix-fase0-$(date +%H%M)\",
    \"profile\": \"webdockSmallPlan\",
    \"locationId\": \"$WEBDOCK_DEFAULT_LOCATION_ID\",
    \"imageSlug\": \"ubuntu-22.04\",
    \"hostname\": \"mail.$DOMAIN\",
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

**Criterio:** server aparece en `runtime/openclaw-workspace/inventory/webdock-servers.json` + audit `oc.webdock.server_created` + IP visible para Paso 4-5.

### Paso 4 — Update SPF con IP real (~3 min)

Ahora que tenemos la IP del VPS, re-upsert el SPF:

```bash
SERVER_IP=$(jq -r '.servers[-1].ipv4' runtime/openclaw-workspace/inventory/webdock-servers.json)

curl -X POST http://127.0.0.1:3000/v1/dns/route53/upsert \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"records\": [
      { \"type\": \"TXT\", \"name\": \"$DOMAIN\", \"value\": \"v=spf1 ip4:$SERVER_IP -all\", \"ttl\": 300 },
      { \"type\": \"A\", \"name\": \"mail.$DOMAIN\", \"value\": \"$SERVER_IP\", \"ttl\": 300 },
      { \"type\": \"MX\", \"name\": \"$DOMAIN\", \"value\": \"10 mail.$DOMAIN\", \"ttl\": 300 }
    ],
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

### Paso 5 — Install SMTP stack (~15 min)

```bash
SERVER_SLUG=$(jq -r '.servers[-1].slug' runtime/openclaw-workspace/inventory/webdock-servers.json)

curl -X POST http://127.0.0.1:3000/v1/servers/$SERVER_SLUG/provision-smtp \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

Esto corre el script SMTP del CTO (postfix + dovecot + opendkim + TLS + UFW + fail2ban) via SSH. Tarda ~5-8 min.

**Criterio:** workspace execution `*-install_smtp_stack-*-success.md` con `sshConnectAttempts >= 1` + audit `oc.smtp.stack_installed`.

### Paso 6 — Bind dominio (~2 min)

```bash
curl -X POST http://127.0.0.1:3000/v1/domains/bind \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"serverSlug\": \"$SERVER_SLUG\",
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

**Criterio:** audit `oc.domain.bound`.

### Paso 7 — Warmup seed (~5 min)

```bash
curl -X POST http://127.0.0.1:3000/v1/warmup/seed \
  -H "content-type: application/json" \
  -d "{
    \"domain\": \"$DOMAIN\",
    \"serverSlug\": \"$SERVER_SLUG\",
    \"recipientPool\": [
      \"jectcode+fase0-1@gmail.com\",
      \"jectcode+fase0-2@gmail.com\",
      \"jectcode+fase0-3@gmail.com\"
    ],
    \"actorId\": \"operator/juanes\",
    \"approvalToken\": \"<TOKEN>\"
  }"
```

**Criterio:** audit `oc.warmup.seed_sent` + 3 emails llegan a Gmail (`jectcode@gmail.com` inbox, buscar por subject `[delivrix-warmup-*]`). Latencia esperada 30s-2min.

### Paso 8 — Verificación final (~10 min)

```bash
# 1. Audit chain íntegra al final del smoke
curl -s http://127.0.0.1:3000/v1/audit-chain/verify | jq

# 2. Anchor signed para guardar como prueba externa
curl -s http://127.0.0.1:3000/v1/audit-chain/anchor | jq

# 3. Webhook buffer revisión
wc -l runtime/webhook-buffer.jsonl
tail -5 runtime/webhook-buffer.jsonl | jq

# 4. Rollback snapshots disponibles (DNS)
ls -la runtime/rollback-snapshots/ | head

# 5. Gmail real: abrir y confirmar los 3 emails con DKIM/SPF/DMARC pass
```

## Reporte final

Crear `DOCUMENTACION/SMOKE_FASE_0_RESULT_2026_05_29.md` con:

1. **SHAs de commits** del día (todos los del sprint).
2. **Resultados de cada paso** (1-8) con audit ID + timestamp + costo.
3. **Costo total real** vs estimado.
4. **Audit chain stats** finales: totalEvents, lastHash, anchor signature.
5. **Webhook buffer count** (cuántos events broadcastearon o quedaron en buffer).
6. **Auto-rollback events** (si DNS rollback se disparó, ver por qué).
7. **3 emails en Gmail** con screenshot/headers DKIM/SPF/DMARC.
8. **Riesgos remanentes para Fase 1.**
9. **Sign-off** del operador Juanes.

## Reglas duras

1. **STOP si en cualquier paso el costo supera $25 USD acumulado** — pausar y avisar a Juanes.
2. **STOP si audit chain verify devuelve `ok:false`** — diagnosticar antes de seguir.
3. **STOP si el handler exige flag que no existe** — implementarlo y reiniciar gateway antes de seguir.
4. **NO destruir el dominio comprado** — queda para Fase 1 lunes (smoke siguiente reusa).
5. **Si SMTP install falla con timeout** (visto antes el 28-may), retry interno A2 debería cubrirlo. Si no, escalar.

## Commit + push

Al final, con todo verde:

```
fix(gateway): close Fase 0 smoke E2E with 1 signature

End-to-end smoke validated:
- Domain registered (Route53): $X
- DNS published (SPF/DKIM/DMARC)
- VPS provisioned (Webdock)
- SMTP stack installed (postfix + dovecot + opendkim + TLS)
- Domain bound to server
- 3 warmup seeds sent + received in Gmail with DKIM/SPF/DMARC pass

Audit chain integrity: ok, totalEvents N, lastHash <hex>
Anchor signed: <signature>
Webhook buffer: N events
Auto-rollback events: 0 (or N — explain)
Cost: $X USD (estimated $25)

1 firma del operador (Juanes), no 2 personas.

Result report: DOCUMENTACION/SMOKE_FASE_0_RESULT_2026_05_29.md
Sprint Fase 0 cerrado.
```

## Reporte a PM Claude

Pegar SHA + costo total + audit chain verify + anchor + 3 email subjects + cualquier desviación del plan.

— Claude PM
