# SMTP AUTH SASL runbook

Fecha: 2026-06-23
Branch: `codex/smtp-auth-sasl`
Scope: credenciales SMTP AUTH cifradas, descarga auditada, retrofit SASL gateado.

## Invariantes

- `CREDENTIAL_ENCRYPTION_KEY` es una variable de feature: el gateway debe arrancar sin ella y reportar warning en preflight, no fatal.
- Sin `CREDENTIAL_ENCRYPTION_KEY`, la generacion y descarga de credenciales SMTP fallan cerrado.
- Puerto 25 conserva `permit_mynetworks`; SMTP AUTH se agrega de forma aditiva en 587/465.
- El password SMTP no se pega en chat, audit, Canvas, live-context ni logs operativos.
- El retrofit no corre en boot ni durante deploy. Solo corre con llamada POST explicita, read-boundary token y approval vigente.

## Bootstrap de CREDENTIAL_ENCRYPTION_KEY

Generar una key de 32 bytes en base64:

```bash
openssl rand -base64 32
```

Instalarla en `config/gateway.env`:

```bash
printf '\nCREDENTIAL_ENCRYPTION_KEY=%s\n' '<valor-generado>' >> config/gateway.env
bash scripts/gateway-restart.sh
```

Validar que no quedo duplicada:

```bash
grep -c '^CREDENTIAL_ENCRYPTION_KEY=' config/gateway.env
```

El resultado esperado es `1`.

## Preflight

El preflight debe reportar `CREDENTIAL_ENCRYPTION_KEY` como warning si falta o si no decodifica a 32 bytes. No debe impedir que el gateway arranque:

```bash
npm test -- apps/gateway-api/src/env-preflight.test.ts
```

## Retrofit SASL gateado

Endpoint:

```text
POST /v1/smtp/retrofit-sasl-batch
```

Requisitos:

- `x-delivrix-token` o `Authorization: Bearer <read-boundary-token>`.
- `approvalToken` vigente asociado a un artifact aprobado en Canvas.
- SSH runner configurado.
- `CREDENTIAL_ENCRYPTION_KEY` valida si hay candidatos sin credencial.

Ejemplo de llamada despues de approval humano:

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/smtp/retrofit-sasl-batch \
  -H "content-type: application/json" \
  -H "x-delivrix-token: $DELIVRIX_READ_BOUNDARY_TOKEN" \
  -H "x-operator-id: operator/juanes" \
  --data "{\"actorId\":\"operator/juanes\",\"approvalToken\":\"$APPROVAL_TOKEN\"}"
```

El batch degrada por servidor: un fallo SSH marca ese candidato como `failed` y sigue con los demas. Si un password fue generado pero la instalacion falla, la credencial queda en `install_failed` y no es descargable.

## Smoke manual post-deploy

Antes de entregar credenciales a clientes:

```bash
swaks --server smtp.example.com --port 587 --tls \
  --auth PLAIN --auth-user mailer@example.com --auth-password '<password-descargado>' \
  --from postmaster@example.com --to postmaster@example.com --quit-after RCPT
```

Validar tambien que el relay legado local sigue vivo:

```bash
swaks --server localhost --port 25 \
  --from postmaster@localhost --to postmaster@localhost --quit-after RCPT
```

## Rollback SMTP AUTH

Rollback de SASL/submission sin tocar DKIM ni el relay de puerto 25:

```bash
postconf -M# submission/inet || true
postconf -M# smtps/inet || true
postconf -e 'smtpd_sasl_auth_enable = no'
postconf -e 'smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination'
systemctl stop dovecot || true
systemctl restart postfix
ss -ltn | grep -E ':(25)\s'
```

Despues de rollback, cualquier credencial que ya salio por descarga debe tratarse como expuesta para clientes externos y rotarse antes de reactivar SMTP AUTH.

## Rotacion ante exposicion

En esta etapa la rotacion automatica queda fuera de scope. Si una credencial se pega en chat, ticket o canal no aprobado:

1. No repetir el password en ningun canal.
2. Pausar entrega de esa credencial.
3. Ejecutar rollback o retrofit/rotacion manual supervisada.
4. Generar una nueva credencial con approval humano.
5. Auditar el incidente sin plaintext.
