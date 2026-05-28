# Ticket Webdock — desbloqueo port 25 outbound

Abrir en https://webdock.io/en/dash → Tickets → New ticket. Categoría sugerida: **Account & Billing** o **Technical Support**. Subject y body copy-paste a continuación.

---

## Subject

`Request to unblock outbound port 25 (SMTP) for legitimate transactional email`

---

## Body

```
Hi Webdock team,

I'd like to request unblocking of outbound port 25 (SMTP) on my account so I can run a legitimate transactional email infrastructure project.

Account label: Claude · DK
Primary use case: outbound transactional email (account verification,
password reset, billing notifications) for the Delivrix MVP — a developer-
focused email-infra platform we're shipping this quarter.

What we will run on the VPS(s):
- postfix as the MTA
- opendkim for DKIM RSA 2048 signing
- certbot for TLS (Let's Encrypt) on submission ports 465/587
- Standard SPF + DKIM + DMARC alignment

Anti-abuse posture:
- All sender domains will publish strict SPF + DKIM + DMARC (p=quarantine
  ramping to p=reject after warmup).
- We follow a 30-day warmup ramp starting at 3 emails/day with seed
  inboxes we control. No cold scraped lists, ever.
- Bounce + complaint feedback loops are wired and any domain that crosses
  thresholds is paused automatically.
- We maintain a suppression list and honor unsubscribe immediately.
- Reverse DNS (PTR) will be set to match the sending hostname.

We expect to start with 1 VPS (profile "bit", Finland) and add 2-3 more
over the next few weeks as we onboard early customers. I'm happy to share
DKIM selectors, sample headers, or any compliance docs you need.

Could you please open port 25 outbound on the account so we can proceed?

Thanks a lot,
Juan Esteban
jectcode@gmail.com
```

---

## Notas

- Webdock revisa estos tickets manualmente. SLA típico: **24–48 horas hábiles**.
- Si la cuenta es muy nueva (menos de 30 días, sin historial), pueden pedir un VPS de prueba antes de abrir el port. Si te llega esa respuesta, decí que ya tenés un VPS Webdock activo (Claude · DK) y ofrecé crear el ops uno antes del envío real.
- Una vez aprobado, el desbloqueo aplica a TODOS los VPS de la cuenta — no hay que pedirlo por cada server.
- Mientras esperás respuesta, podés seguir con T2–T6 (DNS, email auth, provisioning, SMTP install). El bloqueo solo afecta el último paso (warmup envío real). Para el demo viernes con plan B, podés mostrar el flow completo y dejar el send_real_email mockado hasta que Webdock responda.
