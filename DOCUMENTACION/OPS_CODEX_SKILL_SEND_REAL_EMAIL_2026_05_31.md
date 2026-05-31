# OPS Codex — Skill `send_real_email`

**Fecha despacho:** 2026-05-31 domingo 14:30 COT.
**Fecha ejecución:** **HOY MISMO. ÚLTIMO paso del flow E2E — corre DESPUÉS de OPS 1 + OPS 2 implementados.**
**Severidad:** P0 CRITICAL — esta skill envía email REAL desde IP de Delivrix. Cualquier bug afecta reputación IP del pool entero.
**Owner:** Codex backend senior (con peer-review obligatorio del CTO Juanes antes de merge).
**PM:** Claude.
**Modo:** URGENT con extra cuidado en pre-validaciones.

---

## Síntoma / Motivación

El flow E2E SMTP autónomo termina cuando OpenClaw puede demostrar que el servidor recién provisionado envía un email LEGÍTIMO a Gmail/Outlook y llega a inbox (no spam). Sin esta skill el flow se queda en *"todo configurado, falta probar"* — y los smokes anteriores quedaron a medio camino.

Esta skill es la prueba final del happy path E2E. Pero también es la skill que más fácil puede quemar reputación si OpenClaw alucina o el operador firma algo flag-spam. Por eso lleva pre-validaciones agresivas + audit redactado + categoría CRITICAL.

Memoria operativa Juanes (2026-05-31): nada de subjects `test`, `demo`, `prueba`, `lorem`, `smoke`. Tampoco `notify`, `bulk`, `blast`.

---

## Decisión arquitectónica

- **Categoría matrix:** `supervised_local_state` con flag interno `CRITICAL_RISK_REPUTATION`. 1 firma operador, pero el ApprovalGate muestra warning rojo: *"Esto envía email REAL desde tu IP. Confirma que el cuerpo NO es flag-spam."*
- **Pre-validaciones bloqueantes:** 4 chequeos sincrónicos antes de tocar el VPS. Si CUALQUIERA falla → rechazo HTTP 400 sin ejecutar.
- **Ejecución:** SSH al VPS Postfix activo + `swaks` (preferido) o `mail` fallback.
- **Audit event REDACTADO:** solo `subject + recipient + messageId + deliveryStatus`. NO body completo en audit chain (puede contener info confidencial).
- **Auto-rollback:** no aplica (email ya enviado no se puede retraer). Pero se emite `oc.smtp.delivery_status` follow-up event si hay bounce detectado en 5 min.
- **Rate-limit duro:** **máximo 5 emails por hora por VPS** en la primera implementación. Hard-coded, sin override por env.

---

## Tarea 1 — Schema zod

**Archivo nuevo:** `apps/gateway-api/src/routes/send-email.ts`.

```typescript
import { z } from "zod";

// Palabras flag-spam (case-insensitive)
const SPAM_FLAG_WORDS = [
  "test", "demo", "prueba", "lorem", "smoke", "ipsum",
  "notify", "noreply", "no-reply", "bulk", "blast",
  "unsubscribe me", "click here", "act now", "limited time",
  "free money", "viagra", "winner", "congratulations you"
];

const RFC5322_EMAIL =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export const sendRealEmailParamSchema = z.object({
  fromAddress: z.string().regex(RFC5322_EMAIL, "from_invalid_format").max(254),
  toAddress: z.string().regex(RFC5322_EMAIL, "to_invalid_format").max(254),
  subject: z
    .string()
    .min(3)
    .max(200)
    .refine((s) => !SPAM_FLAG_WORDS.some((w) => s.toLowerCase().includes(w)), {
      message: "subject_contains_spam_flag_word"
    }),
  body: z
    .string()
    .min(20)
    .max(8000)
    .refine((b) => !SPAM_FLAG_WORDS.some((w) => b.toLowerCase().includes(w)), {
      message: "body_contains_spam_flag_word"
    }),
  serverSlug: z.string().min(3).max(120),
  actorId: z.string().min(1).max(120),
  approvalToken: z.string().min(1).max(200)
});

export type SendRealEmailParams = z.infer<typeof sendRealEmailParamSchema>;

export interface SendRealEmailResult {
  ok: boolean;
  messageId: string | null;
  deliveryStatus: "queued" | "sent" | "rejected" | "deferred" | "unknown";
  postfixLogTail: string;          // últimas ~20 líneas /var/log/mail.log redactadas
  preValidations: {
    spfPresent: boolean;
    dkimPresent: boolean;
    dmarcPresent: boolean;
    postfixRunning: boolean;
    rateLimitOk: boolean;
  };
  eventId: string;
  durationMs: number;
  error?: string;
}
```

---

## Tarea 2 — Pre-validaciones (4 chequeos sincrónicos)

**Antes de SSH al VPS:**

### 2.1 — Validar dominio del fromAddress tiene SPF + DKIM + DMARC

```typescript
import { promises as dns } from "node:dns";

async function validateEmailAuth(domain: string): Promise<{
  spfPresent: boolean;
  dkimPresent: boolean;
  dmarcPresent: boolean;
  details: { spf?: string; dkim?: string; dmarc?: string };
}> {
  const result = {
    spfPresent: false,
    dkimPresent: false,
    dmarcPresent: false,
    details: {} as { spf?: string; dkim?: string; dmarc?: string }
  };

  // SPF: TXT del dominio root, debe contener "v=spf1"
  try {
    const txt = await dns.resolveTxt(domain);
    const spf = txt.map((r) => r.join("")).find((s) => s.startsWith("v=spf1"));
    if (spf) {
      result.spfPresent = true;
      result.details.spf = spf;
    }
  } catch {}

  // DKIM: TXT en default._domainkey.<domain> debe contener "v=DKIM1"
  try {
    const txt = await dns.resolveTxt(`default._domainkey.${domain}`);
    const dkim = txt.map((r) => r.join("")).find((s) => s.includes("v=DKIM1"));
    if (dkim) {
      result.dkimPresent = true;
      result.details.dkim = dkim.slice(0, 80) + "...";
    }
  } catch {}

  // DMARC: TXT en _dmarc.<domain> debe contener "v=DMARC1"
  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`);
    const dmarc = txt.map((r) => r.join("")).find((s) => s.startsWith("v=DMARC1"));
    if (dmarc) {
      result.dmarcPresent = true;
      result.details.dmarc = dmarc;
    }
  } catch {}

  return result;
}
```

**Regla:** si `spfPresent === false || dkimPresent === false || dmarcPresent === false` → rechazar con HTTP 400 `email_auth_incomplete`. NO enviar.

### 2.2 — Validar Postfix corriendo en el VPS

```typescript
async function checkPostfixRunning(opts: {
  sshRunner: SshRunner;
  serverSlug: string;
  sshUsername: string;
}): Promise<{ running: boolean; statusLine: string }> {
  const result = await opts.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command: "sudo systemctl is-active postfix && sudo ss -tlnp | grep ':25'"
  });
  return {
    running: result.exitCode === 0 && result.stdout.includes("active"),
    statusLine: result.stdout.split("\n").slice(0, 3).join(" | ")
  };
}
```

**Regla:** si no corriendo → HTTP 503 `postfix_not_running`.

### 2.3 — Validar rate-limit (máximo 5 emails/hora por VPS)

```typescript
async function checkRateLimit(opts: {
  auditLog: AuditSink;
  serverSlug: string;
  windowMs: number;     // 3_600_000 = 1 hora
  maxInWindow: number;  // 5
  now: () => number;
}): Promise<{ ok: boolean; recentCount: number }> {
  const events = await opts.auditLog.list?.() ?? [];
  const cutoff = opts.now() - opts.windowMs;
  const recent = events.filter(
    (e) =>
      e.type === "oc.smtp.real_email_sent" &&
      e.metadata?.serverSlug === opts.serverSlug &&
      new Date(e.createdAt).getTime() > cutoff
  );
  return { ok: recent.length < opts.maxInWindow, recentCount: recent.length };
}
```

**Regla:** si `recentCount >= 5` → HTTP 429 `rate_limit_exceeded`. NO enviar.

### 2.4 — Validar toAddress no es un seed pool burner

```typescript
const SEED_POOL_BURNER_DOMAINS = [
  "mailinator.com", "tempmail.com", "guerrillamail.com",
  "10minutemail.com", "throwaway.email", "yopmail.com"
];

function checkRecipientNotBurner(to: string): { ok: boolean; reason?: string } {
  const domain = to.split("@")[1]?.toLowerCase() ?? "";
  if (SEED_POOL_BURNER_DOMAINS.includes(domain)) {
    return { ok: false, reason: "recipient_is_burner_domain" };
  }
  return { ok: true };
}
```

**Regla:** si burner → HTTP 400. Gmail/Outlook personales del operador SÍ son aceptables.

---

## Tarea 3 — Envío vía `swaks` por SSH

```typescript
async function sendEmailViaSwaks(opts: {
  sshRunner: SshRunner;
  serverSlug: string;
  sshUsername: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}): Promise<{
  ok: boolean;
  messageId: string | null;
  deliveryStatus: SendRealEmailResult["deliveryStatus"];
  rawOutput: string;
}> {
  // Escape de comillas simples en subject/body para shell
  const safeSubject = opts.subject.replace(/'/g, `'\\''`);
  const safeBody = opts.body.replace(/'/g, `'\\''`);
  const safeFrom = opts.from.replace(/'/g, `'\\''`);
  const safeTo = opts.to.replace(/'/g, `'\\''`);

  // Verificar swaks instalado, sino fallback a sendmail
  const checkSwaks = await opts.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command: "which swaks || echo 'NOTFOUND'"
  });
  const useSwaks = !checkSwaks.stdout.includes("NOTFOUND");

  let command: string;
  if (useSwaks) {
    command = `swaks --to '${safeTo}' --from '${safeFrom}' --server localhost --port 25 \\
      --header 'Subject: ${safeSubject}' \\
      --body '${safeBody}' \\
      --h-Message-ID '<delivrix-$(date +%s%N)@${opts.from.split("@")[1]}>' \\
      --suppress-data 2>&1 | tail -50`;
  } else {
    // Fallback: sendmail con heredoc
    command = `cat <<'EOF' | sendmail -f '${safeFrom}' '${safeTo}'
From: ${safeFrom}
To: ${safeTo}
Subject: ${safeSubject}
Message-ID: <delivrix-$(date +%s%N)@${opts.from.split("@")[1]}>
Content-Type: text/plain; charset=UTF-8

${safeBody}
EOF
echo "EXITCODE=$?"`;
  }

  const result = await opts.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command
  });

  // Parsear messageId del log y status
  const messageIdMatch = result.stdout.match(/Message-ID:\s*<([^>]+)>/i) ??
                        result.stdout.match(/queued as ([A-F0-9]+)/i);
  const messageId = messageIdMatch?.[1] ?? null;

  let deliveryStatus: SendRealEmailResult["deliveryStatus"] = "unknown";
  if (/250.*queued|250.*ok|250.*accepted/i.test(result.stdout)) deliveryStatus = "sent";
  else if (/4\d{2}/.test(result.stdout)) deliveryStatus = "deferred";
  else if (/5\d{2}/.test(result.stdout)) deliveryStatus = "rejected";
  else if (result.exitCode === 0) deliveryStatus = "queued";

  return {
    ok: result.exitCode === 0 && deliveryStatus !== "rejected",
    messageId,
    deliveryStatus,
    rawOutput: result.stdout.slice(-4000)  // últimos 4KB
  };
}
```

---

## Tarea 4 — Capturar Postfix log tail (redactado)

```typescript
async function tailPostfixLog(opts: {
  sshRunner: SshRunner;
  serverSlug: string;
  sshUsername: string;
  messageId: string | null;
  lines: number;
}): Promise<string> {
  const grepFilter = opts.messageId ? `grep -F '${opts.messageId}'` : "tail -20";
  const command = `sudo tail -200 /var/log/mail.log | ${grepFilter} | tail -${opts.lines}`;
  const result = await opts.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command
  });
  // Redactar emails específicos del log antes de devolverlo
  return result.stdout
    .replace(/from=<[^>]+>/g, "from=<REDACTED>")
    .replace(/to=<[^>]+>/g, "to=<REDACTED>");
}
```

---

## Tarea 5 — Handler HTTP completo

```typescript
export async function handleSendRealEmail(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: SendRealEmailDeps;
}): Promise<void> {
  const body = await readJsonBody(input.request);
  const parsed = sendRealEmailParamSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;
  const startedAt = input.deps.now();

  // 1. Approval token
  const approval = await input.deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    sendJson(input.response, 403, { error: "approval_invalid" });
    return;
  }

  // 2. Pre-validación 2.4: burner check
  const burnerCheck = checkRecipientNotBurner(params.toAddress);
  if (!burnerCheck.ok) {
    sendJson(input.response, 400, { error: "recipient_burner", details: burnerCheck.reason });
    return;
  }

  // 3. Pre-validación 2.1: SPF/DKIM/DMARC
  const fromDomain = params.fromAddress.split("@")[1];
  const auth = await validateEmailAuth(fromDomain);
  if (!auth.spfPresent || !auth.dkimPresent || !auth.dmarcPresent) {
    sendJson(input.response, 400, {
      error: "email_auth_incomplete",
      details: { spf: auth.spfPresent, dkim: auth.dkimPresent, dmarc: auth.dmarcPresent }
    });
    return;
  }

  // 4. Pre-validación 2.2: Postfix corriendo
  const sshUsername = input.deps.env.WEBDOCK_OPERATOR_SSH_USERNAME ?? "delivrix-ops";
  const postfix = await checkPostfixRunning({
    sshRunner: input.deps.sshRunner,
    serverSlug: params.serverSlug,
    sshUsername
  });
  if (!postfix.running) {
    sendJson(input.response, 503, { error: "postfix_not_running", details: postfix.statusLine });
    return;
  }

  // 5. Pre-validación 2.3: rate limit
  const rate = await checkRateLimit({
    auditLog: input.deps.auditLog,
    serverSlug: params.serverSlug,
    windowMs: 3_600_000,
    maxInWindow: 5,
    now: input.deps.now
  });
  if (!rate.ok) {
    sendJson(input.response, 429, {
      error: "rate_limit_exceeded",
      details: { maxPerHour: 5, recentCount: rate.recentCount }
    });
    return;
  }

  // 6. Envío real
  const sendResult = await sendEmailViaSwaks({
    sshRunner: input.deps.sshRunner,
    serverSlug: params.serverSlug,
    sshUsername,
    from: params.fromAddress,
    to: params.toAddress,
    subject: params.subject,
    body: params.body
  });

  // 7. Tail log
  const logTail = await tailPostfixLog({
    sshRunner: input.deps.sshRunner,
    serverSlug: params.serverSlug,
    sshUsername,
    messageId: sendResult.messageId,
    lines: 20
  });

  // 8. Audit event REDACTADO (NO body completo)
  const evt = await input.deps.auditLog.append({
    type: "oc.smtp.real_email_sent",
    actorId: params.actorId,
    metadata: {
      serverSlug: params.serverSlug,
      fromAddress: params.fromAddress,
      toAddressDomain: params.toAddress.split("@")[1],   // solo dominio, no usuario
      toAddressHash: createHash("sha256").update(params.toAddress).digest("hex").slice(0, 16),
      subject: params.subject,                            // subject OK (no datos)
      bodyHash: createHash("sha256").update(params.body).digest("hex"),
      bodyLength: params.body.length,
      messageId: sendResult.messageId,
      deliveryStatus: sendResult.deliveryStatus,
      preValidations: {
        spfPresent: auth.spfPresent,
        dkimPresent: auth.dkimPresent,
        dmarcPresent: auth.dmarcPresent,
        postfixRunning: postfix.running,
        rateLimitOk: rate.ok
      },
      approvalEventId: approval.eventId ?? null
    }
  });

  sendJson(input.response, sendResult.ok ? 200 : 502, {
    ok: sendResult.ok,
    messageId: sendResult.messageId,
    deliveryStatus: sendResult.deliveryStatus,
    postfixLogTail: logTail,
    preValidations: {
      spfPresent: auth.spfPresent,
      dkimPresent: auth.dkimPresent,
      dmarcPresent: auth.dmarcPresent,
      postfixRunning: postfix.running,
      rateLimitOk: rate.ok
    },
    eventId: (evt as { id?: string }).id ?? "",
    durationMs: input.deps.now() - startedAt
  } satisfies SendRealEmailResult);
}
```

---

## Tarea 6 — Wire en `main.ts` + `skill-dispatcher.ts`

1. **main.ts:** `POST /v1/skills/send-real-email`.
2. **skill-dispatcher.ts:**

```typescript
const sendRealEmail: SkillHandlerEntry = {
  paramSchema: sendRealEmailParamSchema,
  timeoutMs: 90_000,
  canRollback: false,
  invoke: ({ request, response, deps }) =>
    handleSendRealEmail({
      request,
      response,
      deps: {
        auditLog: deps.auditLog,
        approvalGuard: deps.approvalGuard,
        sshRunner: deps.smtpSshRunner,
        env: deps.env,
        now: deps.now
      }
    })
};

return {
  // ... existing
  send_real_email: sendRealEmail,
  smtp_send_real: sendRealEmail
};
```

3. **OPENCLAW_PERMISSIONS_MATRIX.md:** fila con categoría `supervised_local_state`, flag `CRITICAL_RISK_REPUTATION`, reversible `no`, rollback `no aplica (follow-up bounce tracking)`.

---

## Tarea 7 — Tests obligatorios

**Archivo:** `apps/gateway-api/src/routes/send-email.test.ts`.

Mínimo 10 tests:

1. **Happy path completo** — todas pre-validaciones OK, swaks retorna `250 queued`, audit redactado emitido → `ok: true, deliveryStatus: "sent"`.
2. **Subject con "test" → rechazado** — HTTP 400 `subject_contains_spam_flag_word`. NO se llama SSH.
3. **Body con "Lorem ipsum" → rechazado** — HTTP 400 `body_contains_spam_flag_word`.
4. **fromAddress dominio sin SPF** — `validateEmailAuth` retorna `spfPresent: false` → HTTP 400 `email_auth_incomplete`.
5. **DKIM missing** — HTTP 400 con details `{ spf: true, dkim: false, dmarc: true }`.
6. **Postfix not running** — `checkPostfixRunning` retorna `running: false` → HTTP 503 `postfix_not_running`. NO se llama swaks.
7. **Rate limit excedido** — mock auditLog retorna 5 eventos `oc.smtp.real_email_sent` en última hora → HTTP 429 `rate_limit_exceeded`.
8. **Recipient burner (mailinator.com)** → HTTP 400 `recipient_burner`. NO SSH.
9. **swaks retorna 550 rejected** — `deliveryStatus: "rejected"`, `ok: false`, HTTP 502, audit emitido.
10. **Audit event redactado** — verificar que `metadata.body` NO existe, sí existe `bodyHash` + `bodyLength`, `toAddress` redactado a hash + dominio.
11. **Approval token inválido** → HTTP 403, NO se ejecuta ninguna validación ni envío.
12. **Shell injection attempt en subject** — subject = `'; rm -rf / #` → debe ser escapado correctamente, NO ejecutado en VPS.

---

## Tarea 8 — Smoke E2E manual (después de OPS 1 + 2 + este OPS implementados)

```bash
# Pre-requisitos:
# - Dominio comprado (OPS register_domain_route53 + wait_for_dns_propagation OK)
# - VPS Webdock Pebble creado con main domain bound (OPS 2)
# - Postfix + OpenDKIM instalado (skill provision_smtp_postfix)
# - DNS records SPF/DKIM/DMARC publicados (skill configure_email_auth)

export GATEWAY_BASE=http://127.0.0.1:3000

# 1. Generar approval token
APPROVAL_TOKEN=$(curl -X POST "$GATEWAY_BASE/v1/openclaw/proposals/<id>/sign" \
  -d '{"actorId":"juanes-cto"}' | jq -r '.token')

# 2. Enviar email
curl -X POST "$GATEWAY_BASE/v1/skills/send-real-email" \
  -H "Content-Type: application/json" \
  -d '{
    "fromAddress": "ops@delivrixreporting.com",
    "toAddress": "jectcode@gmail.com",
    "subject": "Delivrix infrastructure health check 2026-05-31",
    "body": "Confirmation that the new SMTP relay finished provisioning and is online. This is a one-off verification message sent by the operator.",
    "serverSlug": "<webdock-slug>",
    "actorId": "juanes-cto",
    "approvalToken": "'$APPROVAL_TOKEN'"
  }' | jq

# 3. Confirmar inbox Gmail (no spam)
# 4. Verificar audit
curl "$GATEWAY_BASE/v1/audit-chain" | jq '.[] | select(.type=="oc.smtp.real_email_sent")'

# 5. Verificar headers del email recibido tienen:
#    - Authentication-Results: spf=pass dkim=pass dmarc=pass
#    - Received: from <vps-hostname=dominio> (correct rDNS)
```

---

## Sign-off requerido

- [ ] Codex confirma SHA final del commit + push a main.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] `pnpm vitest run apps/gateway-api/src/routes/send-email.test.ts` verde con ≥ 10 tests.
- [ ] Lista palabras spam flag wordlist revisada por PM Claude (puede ampliarse).
- [ ] Smoke E2E manual: 1 email enviado a Gmail del operador, LLEGA A INBOX (no spam, no promociones tab). Headers muestran `spf=pass dkim=pass dmarc=pass`.
- [ ] Audit event redactado: confirmar que el body completo NO está guardado en `runtime/audit-log.jsonl`, solo `bodyHash + bodyLength`.
- [ ] Rate-limit funcional: 6to email en la misma hora retorna 429.
- [ ] **Peer review CTO Juanes obligatorio** antes de merge — esta skill afecta reputación IP.
- [ ] PM Claude revisa diff final.

---

## Entregables

1. **Código:**
   - `apps/gateway-api/src/routes/send-email.ts` (handler + schema + pre-validaciones + envío)
   - `apps/gateway-api/src/routes/send-email.test.ts` (≥ 10 tests)
   - `apps/gateway-api/src/main.ts` (wire ruta)
   - `apps/gateway-api/src/skill-dispatcher.ts` (entry + alias)
   - `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` (fila nueva con flag CRITICAL)

2. **Smoke evidence:**
   - `runtime/smoke-send-real-email-{timestamp}.json` con response del API
   - Screenshot inbox Gmail (headers expanded) — guardar en `runtime/smoke-email-headers.txt`

3. **Docs:** actualizar `OPENCLAW_SYSTEM_PROMPT.md` con bloque `[email_sending_protocol]` instruyendo a OpenClaw a NUNCA usar palabras flag-spam en subject/body.

---

## Notas finales del PM

- **Esta skill es la más riesgosa del MVP.** Una sola alucinación de OpenClaw + 1 firma distraída del operador = email spammy enviado desde nuestra IP. Por eso 4 pre-validaciones + rate-limit hard-coded + audit redactado + peer review.
- **NO bypass las palabras flag-spam con "casos especiales".** Si OpenClaw necesita decir "test" en un email, agregar excepción explícita en wordlist, NO bypass.
- **El SSH user debe tener sudo NOPASSWD** para `systemctl is-active postfix`, `tail /var/log/mail.log`, `swaks`. Verificar config en cloud-init.
- **swaks debe estar instalado** en la imagen base de Webdock o ser instalado por `provision_smtp_postfix`. Si no está, fallback a `sendmail` es OK pero menos verboso.
- **NO escribas el body completo en logs propios.** Logger debe truncar a 200 chars en stdout, y el audit chain solo guarda hash.
- **Si Gmail manda a spam el primer email**, NO reintenta — escala a CTO Juanes para revisar warmup pool / IP reputation.
- **Reportar a PM Claude** al terminar implementación + tests + ANTES del smoke real (Juanes confirma antes de gastar reputación).

— Claude PM
