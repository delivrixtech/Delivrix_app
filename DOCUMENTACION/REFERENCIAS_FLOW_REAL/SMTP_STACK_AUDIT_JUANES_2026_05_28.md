# Auditoria completa del stack SMTP propio

Fecha del informe: 2026-05-28  
Zona horaria de ejecucion: America/Bogota  
Alcance: configuracion SMTP autogestionada basada en Postfix, Dovecot, OpenDKIM, Let's Encrypt, UFW, Fail2Ban, DNS IONOS y VPS Webdock.

## 1. Resumen ejecutivo

El stack SMTP actual es una base funcional para envio transaccional autenticado por dominio. En los VPS recientes se valida en vivo que estan activos Postfix, Dovecot, OpenDKIM, Fail2Ban, UFW y, donde aplica, nginx. El patron tecnico correcto ya existe:

- host dedicado por dominio: `smtp.<dominio>`
- IP dedicada por dominio
- `PTR` hacia `smtp.<dominio>` en casi todos los casos
- `A` directo de `smtp.<dominio>` hacia la IP del VPS
- SPF con IONOS y la IP propia
- DKIM con selector `default`
- DMARC alineado y estricto en la mayoria de dominios
- envio directo, sin `relayhost`
- SMTP autenticado por Dovecot SASL
- rechazo de relay no autorizado
- restriccion del remitente autenticado al dominio esperado en los VPS nuevos
- `submission` 587 con TLS obligatorio
- `submissions` 465 con TLS wrapper
- limites de conexion/mensajes/autenticacion en los VPS nuevos
- OpenDKIM en `127.0.0.1:8891`
- firewall activo que deja expuestos 465/587 y bloquea 25 entrante en la practica

La postura general es buena para correo transaccional de bajo volumen y volumen moderado, siempre que se respete la disciplina operativa: no enviar desde laptops, no hacer cold email, calentar reputacion, controlar rebotes, no usar listas compradas y monitorear Gmail/Postmaster/blacklists.

Los riesgos principales encontrados son:

1. Secretos operativos en texto plano dentro de handoffs locales.
2. `nfcorpreport.online` sigue sin PTR publico.
3. `fileyourcorp.app` sigue con DMARC `p=none` y SPF `~all`.
4. `filecorppro.net` mantiene SPF `~all`.
5. Los dos VPS antiguos (`fileyourcorp.app`, `filecorppro.net`) conservan `milter_default_action = accept`, por lo que podrian enviar sin DKIM si OpenDKIM falla.
6. `fileyourcorp.app` esta menos endurecido: sin limites de tasa visibles, sin restriccion de remitente autenticado equivalente a los VPS nuevos, SSH sin `ufw limit` y Fail2Ban reducido.
7. La documentacion de handoff dice en varios puntos que el puerto 25 esta expuesto, pero UFW en vivo no lo permite. Eso no rompe envio saliente, pero la documentacion debe corregirse.
8. No hay `rua=` en DMARC; sin reportes agregados se opera con poca visibilidad.
9. No hay evidencia de MTA-STS/TLS-RPT para recepcion. Es menor porque los MX entrantes siguen en IONOS, pero debe documentarse.
10. No hay evidencia de politicas formales de rotacion de claves DKIM, rotacion de credenciales SMTP, monitoreo de queue/bounces ni warm-up.

Conclusion: no hay senales de open relay ni de una configuracion improvisada en los VPS nuevos. Si se corrigen PTR, DMARC/SPF antiguos, secreto/rotacion y la politica de monitoreo, el stack queda en una postura solida para envio transaccional propio.

## 2. Evidencia auditada

Archivos locales revisados:

- `/Users/juanesteban/smtp_stack_provision.sh`
- `/Users/juanesteban/SMTP_DELIVERABILITY_PLAYBOOK.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_fileyourcorp.app.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_filecorppro.net.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_nationalcorphub.app.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_swiftcorpdocs.app.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_annualcorpfilings.com.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_nfcorpreport.com.md`
- `/Users/juanesteban/SMTP_DEVELOPER_HANDOFF_nfcorpreport.online.md`
- `/Users/juanesteban/INFORME_DESARROLLADOR_nationalcorphub.app.md`
- `/Users/juanesteban/smtp-backup.tar.gz`
- `/Users/juanesteban/tmp/*-site/*.conf`
- `/Users/juanesteban/annualcorpfilings_email_transactional.txt`
- `/Users/juanesteban/annualcorpfilings_email_transactional.html`
- `/Users/juanesteban/annualcorpfilings_gmail_followup.eml`

Verificaciones ejecutadas:

- DNS publico: `A`, `MX`, `TXT SPF`, `TXT DKIM`, `TXT DMARC`, `PTR`.
- Puertos publicos: 587 y 465 con `nc`.
- Revision SSH de VPS actuales: servicios, Postfix, master services, UFW, Fail2Ban, sockets, OpenDKIM y `postfix check`.
- Revision del backup historico `smtp-backup.tar.gz`.
- Contraste con requisitos actuales de Gmail, Yahoo y Microsoft para autenticacion, DNS inverso, TLS, DMARC y unsubscribe.

No se publican contrasenas, API keys ni claves privadas en este informe.

## 3. Que es este stack

Es un SMTP propio por dominio para envio saliente autenticado. No es, en su diseno actual, una plataforma completa de hosting de correo entrante para usuarios finales.

Su funcion principal:

- permitir que una app/backend envie desde `support@dominio`, `no-reply@dominio` u otro remitente del mismo dominio
- autenticar por `587 STARTTLS` o `465 SSL/TLS`
- firmar con DKIM
- autorizar la IP por SPF
- publicar DMARC para alinear el dominio visible en `From`
- entregar directamente a los MX destino desde IP propia

Entrada de correo:

- los MX de los dominios se preservan en IONOS
- el servidor SMTP propio no es el MX principal de usuario final
- UFW no expone el puerto 25 entrante en los VPS revisados, aunque Postfix escucha localmente en 25

Esto es una decision buena si el objetivo es solo envio saliente: reduce superficie de abuso sin afectar que Postfix entregue hacia afuera, porque UFW permite salida.

## 4. Arquitectura

### 4.1 Componentes

Postfix:

- MTA principal
- recibe correo autenticado por 587/465
- firma via milter OpenDKIM
- entrega directo a los MX destino
- `relayhost =` vacio

Dovecot:

- proveedor SASL para Postfix
- socket: `/var/spool/postfix/private/auth`
- usuarios en `/etc/dovecot/passwd`
- hashes `SHA512-CRYPT`

OpenDKIM:

- firma mensajes salientes
- socket `inet:8891@localhost`
- selector `default`
- clave RSA 2048 segun el script actual
- `OversignHeaders From`

Let's Encrypt:

- certificados SMTP en `/etc/letsencrypt/live/smtp.<dominio>/`
- certificados web separados para dominio raiz y `www` en los VPS con landing
- renovacion por `webroot` en VPS nuevos con nginx
- renovacion `standalone` en VPS antiguos sin nginx activo

UFW:

- entrada denegada por defecto
- salida permitida
- permite 465/587
- permite 80/443 donde hay web/nginx
- SSH limitado en VPS nuevos; `fileyourcorp.app` esta en `ALLOW`, no `LIMIT`

Fail2Ban:

- jails activos para `postfix-sasl`, `sshd` y, en VPS nuevos, tambien `dovecot` y `recidive`

nginx:

- landing web para dominios nuevos
- webroot ACME
- HTTPS del dominio raiz
- `smtp.<dominio>` responde 404 por HTTP/HTTPS donde se configuro bloque web para ese host

IONOS:

- DNS autoritativo operativo
- MX de IONOS preservados para entrada

Webdock:

- VPS por dominio/IP
- PTR configurable por IP

## 5. Flujo de envio

Flujo recomendado:

1. El backend real o el mismo VPS genera el correo.
2. El backend se conecta a `smtp.<dominio>:587` con STARTTLS o a `465` con TLS implicito.
3. Postfix exige autenticacion SASL.
4. Dovecot valida usuario/clave.
5. Postfix valida que el remitente pertenezca al dominio permitido.
6. Postfix entrega el mensaje al queue.
7. OpenDKIM firma el mensaje con `d=<dominio>` y `s=default`.
8. Postfix conecta al MX destino por puerto 25 saliente.
9. El receptor evalua:
   - IP y reputacion
   - PTR/FCrDNS
   - SPF
   - DKIM
   - DMARC
   - TLS recibido
   - contenido
   - volumen
   - quejas/rebotes

Flujo no recomendado:

- enviar pruebas desde laptop, IP residencial o hostname `.local`
- usar `From` de otro dominio
- probar con asuntos genericos repetidos
- mandar a listas frias/compradas
- escalar volumen sin warm-up

## 6. Como se aprovisiona actualmente

El script principal es `smtp_stack_provision.sh`.

Entrada esperada:

```bash
sudo ./smtp_stack_provision.sh [--skip-certbot] <smtp_fqdn> <mail_domain> <smtp_login> <smtp_password> [dmarc_rua]
```

Ejemplo conceptual:

```bash
sudo ./smtp_stack_provision.sh smtp.example.com example.com mailer@example.com '<password>' reports@example.com
```

### 6.1 Validaciones iniciales

El script:

- exige root
- instala paquetes de sistema
- detecta IPv4 publica
- consulta DNS de `smtp.<dominio>`
- aborta si DNS no resuelve y no se usa `--skip-certbot`
- aborta si `A smtp.<dominio>` no coincide con la IPv4 publica detectada

Esto evita emitir certificados contra el servidor equivocado y reduce errores de DNS.

### 6.2 Paquetes instalados

Instala:

- `certbot`
- `dnsutils`
- `dovecot-core`
- `fail2ban`
- `opendkim`
- `opendkim-tools`
- `postfix`
- `ssl-cert`
- `swaks`
- `ufw`

### 6.3 Hostname y `/etc/hosts`

Configura:

- `hostnamectl set-hostname <smtp_fqdn>`
- `/etc/mailname = <mail_domain>`
- entrada `127.0.1.1 <smtp_fqdn> <short_host> smtp`

Esto alinea el hostname local con el HELO/EHLO esperado.

### 6.4 Usuario virtual

Crea usuario de sistema:

- `vmail`
- home `/var/mail`
- shell `/usr/sbin/nologin`

Crea:

- `/var/mail/vhosts/<mail_domain>`

En el diseno auditado, ese almacenamiento no se usa como hosting completo de correo entrante. Es mas bien soporte para el modelo Dovecot/simple auth.

### 6.5 Credenciales SMTP

El script:

- calcula hash con `doveadm pw -s SHA512-CRYPT`
- escribe `/etc/dovecot/passwd`
- propietario `root:dovecot`
- permisos `640`

Hallazgo: cada ejecucion reemplaza `/etc/dovecot/passwd`. Si se quiere mas de un usuario SMTP por dominio, el script debe evolucionar para agregar/actualizar entradas sin borrar las existentes.

### 6.6 Dovecot

Configura:

- `disable_plaintext_auth = yes`
- `auth_mechanisms = plain login`
- `passdb passwd-file`
- `username_format=%u`
- `userdb static`
- socket auth para Postfix:
  - path `/var/spool/postfix/private/auth`
  - mode `0660`
  - user `postfix`
  - group `postfix`

Certificados:

- si Certbot corre: usa Let's Encrypt
- si `--skip-certbot`: usa snakeoil temporal

### 6.7 Certbot

Cuando DNS esta listo:

- emite certificado standalone para `smtp.<dominio>`
- crea hook de renovacion que recarga Postfix y Dovecot

En VPS nuevos con web/nginx se migro a `webroot`, lo cual es mas estable que standalone cuando hay servidor web activo.

### 6.8 Postfix `main.cf`

El script configura:

```text
myhostname = smtp.<dominio>
mydomain = <dominio>
myorigin = $mydomain
mydestination = $myhostname, localhost.$mydomain, localhost
relayhost =
mynetworks = 127.0.0.0/8 [::1]/128
inet_interfaces = all
inet_protocols = ipv4
smtp_helo_name = smtp.<dominio>
smtpd_banner = $myhostname ESMTP
disable_vrfy_command = yes
always_add_missing_headers = yes
strict_rfc821_envelopes = yes
smtpd_forbidden_commands = CONNECT GET POST USER PASS
```

Autenticacion y relay:

```text
smtpd_sasl_auth_enable = yes
smtpd_sasl_security_options = noanonymous
smtpd_sasl_type = dovecot
smtpd_sasl_path = private/auth
smtpd_relay_restrictions = permit_sasl_authenticated,reject_unauth_destination
smtpd_recipient_restrictions = permit_sasl_authenticated,reject_unauth_destination
```

Restriccion de remitente:

```text
smtpd_sender_login_maps = regexp:/etc/postfix/sender_login_maps
smtpd_sender_restrictions = reject_non_fqdn_sender,reject_unknown_sender_domain,check_sender_access regexp:/etc/postfix/allowed_sender_domains,reject_authenticated_sender_login_mismatch
```

Limites:

```text
anvil_rate_time_unit = 60s
smtpd_client_connection_count_limit = 10
smtpd_client_connection_rate_limit = 15
smtpd_client_message_rate_limit = 25
smtpd_client_auth_rate_limit = 10
smtpd_soft_error_limit = 10
smtpd_hard_error_limit = 20
```

TLS:

```text
smtpd_tls_security_level = may
smtpd_tls_protocols = >=TLSv1.2
smtpd_tls_mandatory_protocols = >=TLSv1.2
smtp_tls_security_level = may
smtp_tls_protocols = >=TLSv1.2
smtp_tls_mandatory_protocols = >=TLSv1.2
```

DKIM:

```text
milter_default_action = tempfail
milter_protocol = 6
smtpd_milters = inet:localhost:8891
non_smtpd_milters = $smtpd_milters
```

### 6.9 Postfix `master.cf`

El script reconstruye `master.cf` desde la plantilla de distro y activa:

587:

```text
submission inet n - y - - smtpd
  -o smtpd_tls_security_level=encrypt
  -o smtpd_tls_mandatory_protocols=>=TLSv1.2
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_security_options=noanonymous
  -o smtpd_tls_auth_only=yes
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
```

465:

```text
submissions inet n - y - - smtpd
  -o smtpd_tls_wrappermode=yes
  -o smtpd_tls_mandatory_protocols=>=TLSv1.2
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_security_options=noanonymous
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o milter_macro_daemon_name=ORIGINATING
```

Este es un punto fuerte: la configuracion moderna esta mucho mejor que el backup historico, donde las opciones de `submission` estaban comentadas.

### 6.10 Header checks

El script define `submission_header_checks` para limpiar:

- `Message-Id`
- `X-Mailer`
- `User-Agent`
- `X-Originating-IP`
- `X-PHP-Originating-Script`
- `X-MimeOLE`

Objetivo:

- reducir headers ruidosos
- evitar que pruebas desde clientes malos dejen senales como hostname `.local`
- regenerar `Message-ID` desde Postfix

Nota: esto ayuda, pero no reemplaza la regla operativa principal: no originar envios desde laptops, IPs residenciales o hostnames `.local`.

### 6.11 OpenDKIM

Configura:

```text
Canonicalization relaxed/relaxed
Mode s
SubDomains no
OversignHeaders From
SignatureAlgorithm rsa-sha256
Socket inet:8891@localhost
KeyTable /etc/opendkim/key.table
SigningTable refile:/etc/opendkim/signing.table
ExternalIgnoreList /etc/opendkim/trusted.hosts
InternalHosts /etc/opendkim/trusted.hosts
```

Genera clave:

```bash
opendkim-genkey -b 2048 -d "$MAIL_DOMAIN" -D "/etc/opendkim/keys/$MAIL_DOMAIN" -s default -v
```

Esto cumple el minimo moderno para Gmail, que recomienda 2048 bits si el proveedor DNS lo soporta.

### 6.12 UFW

El script:

```text
ufw default deny incoming
ufw default allow outgoing
ufw limit OpenSSH
ufw allow 80/tcp
ufw allow 465/tcp
ufw allow 587/tcp
ufw --force enable
```

Luego, en los VPS con web, tambien aparece 443 permitido.

Punto importante: el script no permite 25 entrante. Eso es correcto si los MX entrantes siguen en IONOS. Postfix escucha 25 en el host, pero UFW bloquea acceso publico entrante.

### 6.13 Fail2Ban

El script define:

- `postfix-sasl`
- `dovecot`
- `recidive`

Politica:

```text
bantime = 1h
findtime = 10m
maxretry = 5
recidive bantime = 1w
```

Los VPS nuevos tienen 4 jails: `dovecot`, `postfix-sasl`, `recidive`, `sshd`.

## 7. Inventario actual por dominio

### 7.1 Matriz DNS y entrega

| Dominio | SMTP host | IP | SPF actual | DMARC actual | DKIM | MX entrante | PTR | Estado |
|---|---|---:|---|---|---|---|---|---|
| `fileyourcorp.app` | `smtp.fileyourcorp.app` | `193.181.209.173` | `~all` | `p=none` | presente | IONOS | correcto | funcional, pero antiguo/debil |
| `filecorppro.net` | `smtp.filecorppro.net` | `193.181.209.188` | `~all` | `p=quarantine` | presente | IONOS | correcto | funcional, corregir SPF/milter |
| `nationalcorphub.app` | `smtp.nationalcorphub.app` | `193.181.211.23` | `-all` | `p=quarantine` | presente | IONOS | correcto | sano |
| `swiftcorpdocs.app` | `smtp.swiftcorpdocs.app` | `217.78.237.134` | `-all` | `p=quarantine` | presente | IONOS | correcto | sano |
| `annualcorpfilings.com` | `smtp.annualcorpfilings.com` | `193.181.211.77` | `-all` | `p=quarantine` | presente | IONOS | correcto | sano |
| `nfcorpreport.com` | `smtp.nfcorpreport.com` | `193.181.211.99` | `-all` | `p=quarantine` | presente | IONOS | correcto | sano |
| `nfcorpreport.online` | `smtp.nfcorpreport.online` | `45.136.70.172` | `-all` | `p=quarantine` | presente | IONOS | faltante | funcional pero PTR critico pendiente |

### 7.2 Puertos publicos probados desde esta maquina

Puerto 587:

- abierto en los 7 dominios

Puerto 465:

- abierto en los 7 dominios

Puerto 25:

- las pruebas desde esta maquina quedaron colgadas
- la evidencia SSH muestra Postfix escuchando en 25, pero UFW no lista regla `25/tcp`
- interpretacion: el puerto 25 esta bloqueado entrante por UFW, lo cual es coherente con el diseno de envio saliente + MX en IONOS

### 7.3 Estado vivo de VPS

`nationalcorphub.app`:

- Ubuntu 24.04.4 LTS
- Postfix activo
- Dovecot activo
- OpenDKIM activo
- Fail2Ban activo
- nginx activo
- UFW activo
- `milter_default_action = tempfail`
- rate limits activos
- `submission` 587 con TLS obligatorio
- `submissions` 465 con wrapper TLS
- UFW con SSH limitado
- Fail2Ban: `dovecot`, `postfix-sasl`, `recidive`, `sshd`
- DKIM test: key OK

`swiftcorpdocs.app`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/nginx/UFW activos
- `milter_default_action = tempfail`
- rate limits activos
- PTR correcto
- DKIM test: key OK

`annualcorpfilings.com`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/nginx/UFW activos
- `milter_default_action = tempfail`
- rate limits activos
- `sender_canonical_maps` activo para corregir `Return-Path` en envios locales
- PTR correcto
- DKIM test: key OK

`nfcorpreport.com`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/nginx/UFW activos
- `milter_default_action = tempfail`
- rate limits activos
- PTR correcto
- DKIM test: key OK

`nfcorpreport.online`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/nginx/UFW activos
- `milter_default_action = tempfail`
- rate limits activos
- DKIM test: key OK
- PTR publico faltante: riesgo alto de entregabilidad

`filecorppro.net`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/UFW activos
- nginx inactivo
- `milter_default_action = accept`
- rate limits activos
- restriccion de remitente autenticado activa
- PTR correcto
- DKIM test: key OK
- SPF con `~all`, no `-all`

`fileyourcorp.app`:

- Postfix/Dovecot/OpenDKIM/Fail2Ban/UFW activos
- nginx inactivo
- `milter_default_action = accept`
- sin rate limits visibles en `postconf -n`
- sin restriccion de remitente autenticado equivalente a VPS nuevos en la salida auditada
- UFW SSH en `ALLOW`, no `LIMIT`
- Fail2Ban solo `postfix-sasl` y `sshd`
- DMARC `p=none`
- SPF `~all`
- DKIM test: key OK

## 8. Diferencias entre generaciones del stack

### 8.1 Backup historico `nvbizfilings.com`

El backup historico confirma una primera generacion:

- Postfix + Dovecot + OpenDKIM
- `relayhost =` vacio
- SASL por Dovecot
- DKIM activo
- `milter_default_action = accept`
- `submission` y `submissions` habilitados pero sin overrides endurecidos
- UFW presente pero `ENABLED=no`
- OpenDKIM con selector `default`

Ese estado era funcional, pero no suficientemente endurecido.

### 8.2 Generacion intermedia

`fileyourcorp.app` y `filecorppro.net` muestran una transicion:

- ya hay UFW activo
- ya hay Fail2Ban
- ya hay 465/587
- `filecorppro.net` ya tiene rate limits y restriccion de remitente
- ambos conservan `milter_default_action = accept`
- ambos conservan SPF `~all`
- `fileyourcorp.app` conserva DMARC `p=none`

### 8.3 Generacion actual

`nationalcorphub.app`, `swiftcorpdocs.app`, `annualcorpfilings.com`, `nfcorpreport.com` y `nfcorpreport.online` tienen la postura nueva:

- `milter_default_action = tempfail`
- `submission` endurecido
- 465 endurecido
- rate limits
- restriccion de remitente autenticado por dominio
- Fail2Ban completo
- UFW con SSH limitado
- DMARC `p=quarantine`
- SPF `-all`
- nginx/webroot para renovacion donde hay web

## 9. Controles anti-spam ya implementados

### 9.1 No open relay

Control:

```text
smtpd_relay_restrictions = permit_sasl_authenticated,reject_unauth_destination
smtpd_recipient_restrictions = permit_sasl_authenticated,reject_unauth_destination
mynetworks = 127.0.0.0/8 [::1]/128
```

Resultado:

- terceros no autenticados no pueden usar el servidor como relay
- la superficie de abuso mas peligrosa esta controlada

### 9.2 Autenticacion SMTP

Control:

- SASL por Dovecot
- hashes `SHA512-CRYPT`
- `noanonymous`
- `submission` con `smtpd_tls_auth_only=yes`

Resultado:

- evita relay anonimo
- evita credenciales sin TLS en 587

Mejora recomendada:

- deshabilitar AUTH global en puerto 25 y dejarlo solo en 587/465.
- alternativa: establecer globalmente `smtpd_tls_auth_only = yes`.

### 9.3 Restriccion de remitente

Control en VPS nuevos:

```text
smtpd_sender_login_maps = regexp:/etc/postfix/sender_login_maps
smtpd_sender_restrictions = reject_non_fqdn_sender,reject_unknown_sender_domain,check_sender_access regexp:/etc/postfix/allowed_sender_domains,reject_authenticated_sender_login_mismatch
```

Resultado:

- un usuario de `@dominio` no deberia poder enviar con `MAIL FROM` de otro dominio
- mejora alineacion SPF/DMARC
- reduce suplantacion cruzada entre dominios

### 9.4 DKIM

Control:

- OpenDKIM activo
- selector `default`
- RSA 2048
- `SigningTable refile`
- `OversignHeaders From`

Resultado:

- Gmail acepto pruebas reales en varios dominios
- `opendkim-testkey` devuelve `key OK` en los VPS vivos

Nota:

- `key not secure` en `opendkim-testkey` se refiere a ausencia de DNSSEC, no a fallo DKIM.

### 9.5 DMARC

Control:

- VPS nuevos con:

```text
v=DMARC1; p=quarantine; sp=quarantine; adkim=s; aspf=s; pct=100; fo=1
```

Resultado:

- politica estricta de alineacion
- receptores pueden cuarentenar fallos
- reduce spoofing del dominio

Brecha:

- falta `rua=mailto:...` para reportes agregados
- `fileyourcorp.app` sigue en `p=none`

### 9.6 SPF

Control:

- VPS nuevos:

```text
v=spf1 include:_spf-us.ionos.com ip4:<IP_SMTP> -all
```

Resultado:

- autoriza IONOS y la IP propia
- termina en hardfail para no autorizados

Brecha:

- `fileyourcorp.app` y `filecorppro.net` siguen con `~all`.

### 9.7 PTR y FCrDNS

Control:

- la mayoria de IPs tienen PTR hacia `smtp.<dominio>`
- el `A` de ese hostname resuelve de vuelta a la misma IP

Brecha:

- `45.136.70.172` no tiene PTR publico al momento de la auditoria.

### 9.8 TLS

Control:

- certificados Let's Encrypt
- 587 con STARTTLS obligatorio
- 465 con TLS wrapper
- TLS minimo >= 1.2 en servicios de submission

Resultado:

- cumple expectativas modernas de proveedores grandes.

### 9.9 Rate limiting

Control en VPS nuevos:

- 10 conexiones simultaneas por cliente
- 15 conexiones por minuto
- 25 mensajes por minuto
- 10 autenticaciones por minuto

Resultado:

- mitiga abuso por credencial robada
- reduce picos accidentales desde apps
- protege IPs nuevas

Brecha:

- `fileyourcorp.app` no muestra estos limites en la configuracion viva auditada.

### 9.10 Fail2Ban

Control:

- `postfix-sasl`
- `dovecot`
- `sshd`
- `recidive` en VPS nuevos

Resultado:

- mitiga brute force SMTP/SSH

Brecha:

- `fileyourcorp.app` solo muestra `postfix-sasl` y `sshd`.

### 9.11 Firewall

Control:

- UFW activo
- default deny incoming
- default allow outgoing
- 465/587 abiertos
- 80/443 abiertos en dominios con web
- 25 no permitido en UFW

Resultado:

- el servidor puede entregar saliente por 25
- no recibe SMTP publico por 25 desde internet
- reduce escaneos y ataques

### 9.12 Origen de pruebas

Control operativo documentado:

- no validar entregabilidad desde laptop o hostname `.local`
- usar el VPS o backend real
- si se usa otro backend, debe tener hostname real y estable

Resultado:

- evita headers tipo `Received: from macbook...local (unknown [IP residencial])`
- reduce senales negativas para Gmail/Yahoo/Microsoft

## 10. Brechas y hallazgos priorizados

### P0 - Secretos en handoff local

Se encontraron contrasenas SMTP, contrasenas SSH/sudo y API keys en archivos Markdown locales de handoff.

Impacto:

- compromiso completo de VPS si esos archivos se comparten o filtran
- abuso SMTP inmediato
- reputacion de dominios/IPs en riesgo
- posible toma de DNS si API key sigue valida

Accion:

- mover secretos a password manager
- eliminar secretos de handoffs Markdown
- rotar todas las contrasenas SMTP y SSH documentadas
- rotar API key IONOS
- reemplazar acceso password por SSH key
- dejar los handoffs con placeholders, no secretos

### P0 - Falta PTR en `nfcorpreport.online`

Evidencia:

- `dig +short -x 45.136.70.172` no devolvio PTR
- handoff ya lo marcaba como pendiente

Impacto:

- Gmail/Microsoft/Yahoo pueden filtrar o rechazar
- reputacion de IP nueva parte con desventaja fuerte

Accion:

- configurar PTR en Webdock: `45.136.70.172 -> smtp.nfcorpreport.online`
- verificar FCrDNS:

```bash
dig +short -x 45.136.70.172
dig +short smtp.nfcorpreport.online A
```

### P1 - DMARC debil en `fileyourcorp.app`

Evidencia:

```text
v=DMARC1; p=none; adkim=s; aspf=s; pct=100
```

Impacto:

- menor proteccion contra spoofing
- menor senal de enforcement
- para operaciones maduras, `p=none` solo sirve como fase de monitoreo

Accion:

```text
v=DMARC1; p=quarantine; sp=quarantine; adkim=s; aspf=s; pct=100; fo=1; rua=mailto:dmarc-reports@fileyourcorp.app
```

Luego evaluar pasar a `p=reject` cuando los reportes esten limpios.

### P1 - SPF softfail en dominios antiguos

Evidencia:

- `fileyourcorp.app`: `~all`
- `filecorppro.net`: `~all`

Impacto:

- senal menos fuerte frente a abuso
- receptores tratan emisores no autorizados como sospechosos, no fallo duro

Accion:

```text
v=spf1 include:_spf-us.ionos.com ip4:<IP> -all
```

Antes de cambiar, confirmar que no existan otros proveedores legitimos enviando como ese dominio.

### P1 - `milter_default_action = accept` en dominios antiguos

Evidencia:

- `fileyourcorp.app`: `milter_default_action = accept`
- `filecorppro.net`: `milter_default_action = accept`

Impacto:

- si OpenDKIM falla, Postfix puede seguir enviando sin firma DKIM
- riesgo de caida de DMARC y filtrado a spam

Accion:

```bash
sudo postconf -e 'milter_default_action = tempfail'
sudo systemctl reload postfix
```

### P1 - `fileyourcorp.app` menos endurecido

Evidencia:

- sin rate limits visibles
- sin `smtpd_sender_restrictions` equivalente a VPS nuevos
- UFW SSH `ALLOW` en vez de `LIMIT`
- Fail2Ban reducido a `postfix-sasl` y `sshd`

Accion:

- aplicar plantilla actual del script
- agregar rate limits
- agregar restriccion de remitente por dominio
- cambiar SSH a `ufw limit OpenSSH`
- agregar jails `dovecot` y `recidive`

### P1 - AUTH global potencialmente expuesto en puerto 25

Evidencia:

- `smtpd_sasl_auth_enable = yes` esta en configuracion global
- `submission`/`submissions` tambien lo fuerzan por override
- UFW bloquea 25 entrante, lo que reduce el riesgo externo

Impacto:

- si en el futuro se abre 25 entrante, AUTH podria anunciarse donde no se necesita

Accion recomendada:

Opcion preferida:

```bash
sudo postconf -e 'smtpd_sasl_auth_enable = no'
sudo postconf -P 'submission/inet/smtpd_sasl_auth_enable=yes'
sudo postconf -P 'submissions/inet/smtpd_sasl_auth_enable=yes'
sudo systemctl reload postfix
```

Opcion minima:

```bash
sudo postconf -e 'smtpd_tls_auth_only = yes'
sudo systemctl reload postfix
```

### P2 - Falta `rua` en DMARC

Evidencia:

- DMARC actual no contiene `rua=mailto:...`

Impacto:

- no hay telemetria agregada
- dificil detectar spoofing, proveedores no autorizados o fallos de alineacion

Accion:

- crear buzones o alias `dmarc-reports@<dominio>`
- publicar `rua=mailto:dmarc-reports@<dominio>`
- usar parser DMARC si el volumen sube

### P2 - No hay MTA-STS/TLS-RPT documentado

Impacto:

- menor proteccion/visibilidad de TLS para correo entrante
- como MX entrante esta en IONOS, esto debe coordinarse con IONOS o quedar fuera de alcance

Accion:

- si se busca endurecer recepcion, evaluar MTA-STS y TLS-RPT del dominio con el proveedor MX real
- no publicar MTA-STS apuntando a un servidor que no sea el MX efectivo

### P2 - Documentacion de puerto 25 imprecisa

Evidencia:

- handoffs dicen "puertos expuestos: 25, 80, 443, 465, 587"
- UFW en vivo no lista `25/tcp`

Impacto:

- confusion operativa
- pruebas erroneas

Accion:

- actualizar handoffs: Postfix escucha 25 localmente, pero UFW no expone 25 entrante; salida 25 permitida por politica outgoing.

### P2 - Certbot standalone en VPS antiguos

Evidencia:

- `fileyourcorp.app`: renewal authenticator `standalone`
- `filecorppro.net`: renewal authenticator `standalone`

Impacto:

- aceptable si no hay nginx activo
- si se instala nginx luego, la renovacion puede fallar por puerto 80 ocupado

Accion:

- mantener standalone si no hay web
- si se agrega landing/nginx, migrar a webroot
- ejecutar `certbot renew --dry-run` despues de cualquier cambio web

### P2 - Monitoreo operativo no formalizado

Faltan procedimientos documentados para:

- queue depth
- bounces
- deferred mail
- rate de `5xx`/`4xx`
- blacklist checks
- expiracion de certificados
- Fail2Ban bans
- spam complaint rate
- Gmail Postmaster Tools

Accion:

- crear runbook y tareas cron/health checks.

## 11. Evaluacion por dominio

### 11.1 `fileyourcorp.app`

Estado: funcional pero debe actualizarse.

Fortalezas:

- A correcto
- PTR correcto
- MX IONOS
- DKIM presente y `key OK`
- 465/587 abiertos
- UFW activo
- Fail2Ban activo
- pruebas historicas aceptadas por Gmail/Zoho

Debilidades:

- SPF `~all`
- DMARC `p=none`
- `milter_default_action = accept`
- no se observaron rate limits
- no se observo restriccion moderna de remitente autenticado
- SSH no limitado por UFW
- nginx inactivo, no hay 443
- Fail2Ban menos completo

Decision: no usar para produccion nueva hasta aplicar plantilla actual.

### 11.2 `filecorppro.net`

Estado: funcional, semi-actualizado.

Fortalezas:

- A correcto
- PTR correcto
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- rate limits activos
- restriccion de remitente autenticado activa
- Fail2Ban completo
- UFW con SSH limitado
- pruebas historicas aceptadas por Gmail

Debilidades:

- SPF `~all`
- `milter_default_action = accept`
- nginx inactivo, no hay 443

Decision: corregir SPF a `-all` y milter a `tempfail`.

### 11.3 `nationalcorphub.app`

Estado: sano.

Fortalezas:

- A correcto
- PTR correcto
- FCrDNS correcto
- SPF `-all`
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- servicios activos
- UFW activo
- Fail2Ban completo
- 465/587 abiertos
- rate limits activos
- Gmail acepto prueba real

Debilidades:

- falta `rua`
- revisar AUTH global si algun dia se abre 25

Decision: apto para envio transaccional controlado.

### 11.4 `swiftcorpdocs.app`

Estado: sano.

Fortalezas:

- A correcto
- PTR correcto
- SPF `-all`
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- servicios activos
- UFW activo
- Fail2Ban completo
- rate limits activos
- Gmail acepto prueba real

Debilidades:

- handoff decia PTR pendiente, pero DNS vivo ya lo muestra correcto
- falta `rua`

Decision: apto para envio transaccional controlado.

### 11.5 `annualcorpfilings.com`

Estado: sano y el mejor documentado.

Fortalezas:

- A correcto
- PTR correcto
- SPF `-all`
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- servicios activos
- UFW activo
- Fail2Ban completo
- rate limits activos
- `sender_canonical_maps` corrige envios locales
- pruebas Gmail aceptadas desde VPS
- plantillas transaccionales existentes

Debilidades:

- falta `rua`
- revisar si el trafico puede volverse marketing; si si, falta unsubscribe

Decision: apto para envio transaccional controlado.

### 11.6 `nfcorpreport.com`

Estado: sano.

Fortalezas:

- A correcto
- PTR correcto
- SPF `-all`
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- servicios activos
- UFW activo
- Fail2Ban completo
- rate limits activos
- Gmail acepto prueba real

Debilidades:

- handoff antiguo decia PTR pendiente; DNS vivo ya lo muestra correcto
- falta `rua`

Decision: apto para envio transaccional controlado.

### 11.7 `nfcorpreport.online`

Estado: funcional, pero no apto para escalar hasta corregir PTR.

Fortalezas:

- A correcto
- SPF `-all`
- DKIM presente y `key OK`
- DMARC `p=quarantine`
- servicios activos
- UFW activo
- Fail2Ban completo
- rate limits activos
- Gmail acepto prueba real historica

Debilidades:

- PTR publico faltante
- sin PTR no hay FCrDNS
- falta `rua`

Decision: corregir PTR antes de usar en serio.

## 12. Riesgo de spam: tecnico vs operativo

La configuracion tecnica es necesaria, pero no garantiza inbox.

### 12.1 Lo que el stack ya hace bien

- SPF/DKIM/DMARC
- TLS
- PTR en casi todos
- DKIM 2048
- no open relay
- envio directo sin relay intermedio
- rate limits
- Fail2Ban
- UFW
- restriccion de remitente
- evita pruebas desde laptop en el playbook

### 12.2 Lo que todavia puede mandar a spam

- IP nueva sin reputacion
- PTR faltante
- picos de volumen
- correos repetidos de prueba
- contenido demasiado generico
- baja interaccion
- rebotes altos
- recipients no opt-in
- quejas > 0.3%
- envios desde laptop o hostname `.local`
- usar dominios parecidos a entidades gubernamentales/corporativas sin transparencia suficiente
- falta de unsubscribe si el mensaje es marketing o suscripcion

### 12.3 Regla de oro

Para transaccional:

- enviar solo por evento real
- enviar a destinatarios que esperan el correo
- incluir identidad clara del remitente
- mantener `Reply-To` real
- no disfrazar el proposito
- no usar asuntos sensacionalistas

Para marketing o subscribed mail:

- consentimiento verificable
- `List-Unsubscribe`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- link visible de baja en el cuerpo
- supresion inmediata
- no reintentar contactos que se dieron de baja

## 13. Requisitos actuales de proveedores grandes

### 13.1 Gmail

Gmail exige, segun tipo/volumen:

- SPF o DKIM para todos los remitentes
- SPF, DKIM y DMARC para bulk senders
- alineacion DMARC con el dominio visible en `From`
- PTR/forward DNS validos
- TLS
- baja tasa de spam reportado
- one-click unsubscribe para marketing/subscribed mail de alto volumen

El stack cumple la parte tecnica en los VPS nuevos, salvo `nfcorpreport.online` por PTR y salvo ausencia de `rua` como brecha de visibilidad.

### 13.2 Yahoo

Yahoo recomienda/espera:

- DKIM en cada correo
- DMARC publicado
- SPF correcto
- baja tasa de quejas
- unsubscribe facil en correo comercial

El stack cumple la autenticacion base. La operacion debe cuidar que el trafico no parezca cold outreach.

### 13.3 Microsoft Outlook/Hotmail/Live

Microsoft aplica requisitos para remitentes de alto volumen hacia dominios consumer:

- SPF
- DKIM
- DMARC
- alineacion
- cumplimiento de politicas de envio

El stack moderno cumple la base, pero hay que vigilar volumen y reputacion.

## 14. Plantillas de correo revisadas

Plantillas `annualcorpfilings`:

- texto plano correcto
- HTML simple
- identidad clara
- `Reply-To` real
- enlace al dominio
- tono transaccional

Riesgos:

- no incluye unsubscribe, pero el contenido revisado es transaccional. Si se usa para marketing, newsletter, nurturing o listas, debe incluir unsubscribe.
- no hay informacion fisica/legal de la entidad. Para correos comerciales en EE. UU., revisar cumplimiento CAN-SPAM si aplica.
- debe evitarse envio masivo del mismo contenido a contactos frios.

Recomendacion:

- separar plantillas transaccionales de marketing.
- agregar campos auditables: evento que disparo el correo, timestamp, fuente del consentimiento o caso.

## 15. Procedimiento correcto para montar un dominio nuevo

### Paso 1. Preparar DNS

Crear:

```text
A smtp.<dominio> <IP_VPS>
```

Mantener MX entrante si IONOS sigue recibiendo:

```text
MX 10 mx00.ionos.com.
MX 10 mx01.ionos.com.
```

Configurar PTR en Webdock:

```text
<IP_VPS> -> smtp.<dominio>
```

Verificar:

```bash
dig +short smtp.<dominio> A
dig +short -x <IP_VPS>
```

### Paso 2. Ejecutar provision

```bash
sudo ./smtp_stack_provision.sh smtp.<dominio> <dominio> mailer@<dominio> '<password-fuerte>' dmarc-reports@<dominio>
```

### Paso 3. Publicar DNS emitido por el script

SPF recomendado:

```text
v=spf1 include:_spf-us.ionos.com ip4:<IP_VPS> -all
```

DKIM:

```text
default._domainkey.<dominio> TXT <valor generado por opendkim-genkey>
```

DMARC recomendado inicial si ya se conoce todo emisor legitimo:

```text
v=DMARC1; p=quarantine; sp=quarantine; adkim=s; aspf=s; pct=100; fo=1; rua=mailto:dmarc-reports@<dominio>
```

DMARC temporal si aun se esta descubriendo emisores:

```text
v=DMARC1; p=none; adkim=s; aspf=s; pct=100; rua=mailto:dmarc-reports@<dominio>
```

No dejar `p=none` permanentemente si el dominio ya esta listo.

### Paso 4. Verificar servidor

```bash
sudo systemctl status postfix dovecot opendkim fail2ban --no-pager
sudo ufw status verbose
sudo fail2ban-client status
sudo ss -ltnp | egrep ':465|:587|:8891'
sudo postconf -n
sudo postconf -M submission/inet submissions/inet
sudo opendkim-testkey -d <dominio> -s default -vvv
sudo postfix check
```

### Paso 5. Probar SMTP autenticado

Desde backend real o VPS:

```bash
swaks --server smtp.<dominio> --port 587 --tls \
  --auth LOGIN \
  --auth-user 'mailer@<dominio>' \
  --auth-password '<hidden>' \
  --from support@<dominio> \
  --to prueba@example.com
```

No hacer prueba desde laptop para validar inbox/reputacion.

### Paso 6. Revisar headers finales

En Gmail:

- abrir mensaje
- "Show original"
- confirmar:
  - SPF PASS
  - DKIM PASS
  - DMARC PASS
  - DKIM `d=<dominio>`
  - Header From `@<dominio>`
  - Return-Path alineado o DKIM alineado
  - Received no contiene `.local` ni IP residencial

### Paso 7. Warm-up

Regla practica:

- dia 1-3: menos de 20 correos reales/dia
- dia 4-7: 20-50/dia
- semana 2: 50-150/dia
- semana 3: 150-300/dia
- subir solo si rebotes y quejas son bajos

No automatizar volumen alto en IP nueva sin telemetria.

## 16. Procedimiento de operacion diaria

Ver cola:

```bash
mailq
postqueue -p
```

Contar cola:

```bash
mailq | tail -n 1
```

Logs recientes:

```bash
sudo journalctl -u postfix --since '1 hour ago'
sudo journalctl -u opendkim --since '1 hour ago'
sudo journalctl -u dovecot --since '1 hour ago'
```

Errores:

```bash
sudo grep -Ei 'reject|deferred|bounced|warning|fatal|sasl|auth|dkim|milter' /var/log/mail.log | tail -n 200
```

Fail2Ban:

```bash
sudo fail2ban-client status
sudo fail2ban-client status postfix-sasl
```

Certificados:

```bash
sudo certbot certificates
sudo certbot renew --dry-run
```

DNS:

```bash
dig +short smtp.<dominio> A
dig +short -x <IP>
dig +short <dominio> TXT
dig +short default._domainkey.<dominio> TXT
dig +short _dmarc.<dominio> TXT
```

## 17. Procedimiento ante spam o baja entregabilidad

### 17.1 Si Gmail manda a spam

Revisar en este orden:

1. `Authentication-Results`.
2. SPF/DKIM/DMARC pass.
3. PTR y FCrDNS.
4. Header `Received`: no laptop, no `.local`, no IP residencial.
5. Volumen de envio del dia.
6. Rebotes recientes.
7. Repeticion de asunto/cuerpo.
8. Dominio/IP en blacklist.
9. Quejas de usuarios.
10. Si el contenido es transaccional o marketing.

### 17.2 Si hay rechazo 5xx

- no reintentar indefinidamente
- clasificar rebote
- suprimir direcciones invalidas
- si el rechazo menciona auth, revisar SPF/DKIM/DMARC/PTR
- si menciona reputacion, bajar volumen y revisar listas

### 17.3 Si DKIM falla

```bash
sudo systemctl status opendkim --no-pager
sudo ss -ltnp | grep 8891
sudo opendkim-testkey -d <dominio> -s default -vvv
sudo journalctl -u opendkim --since '1 hour ago'
```

Si OpenDKIM esta caido y `milter_default_action=tempfail`, el correo debe diferirse en vez de salir sin firma. Eso es lo correcto.

### 17.4 Si una credencial SMTP se filtra

1. Deshabilitar usuario SMTP.
2. Cambiar password.
3. Revisar queue.
4. Borrar mensajes abusivos en cola.
5. Revisar logs de auth.
6. Revisar volumen por IP origen.
7. Rotar DKIM solo si hay indicio de compromiso de clave privada.
8. Revisar blacklists.

## 18. Politica de seguridad recomendada

Credenciales:

- no almacenar passwords en Markdown
- usar password manager
- credenciales por aplicacion, no compartidas
- rotacion trimestral o inmediata ante incidente
- minimo 24 caracteres aleatorios

SSH:

- deshabilitar password login
- usar SSH keys
- `ufw limit OpenSSH`
- Fail2Ban `sshd`

DKIM:

- RSA 2048 minimo
- selector versionado para rotacion futura: `s2026a`, `s2026b`
- rotar cada 6-12 meses o ante incidente

DMARC:

- agregar `rua`
- monitorear reportes
- pasar de `quarantine` a `reject` cuando no haya fallos legitimos

SPF:

- un solo TXT SPF por dominio
- mantener menos de 10 DNS lookups
- usar `-all` cuando se conocen todos los emisores

Postfix:

- dejar AUTH solo en 465/587
- mantener 25 entrante bloqueado si MX es IONOS
- mantener `milter_default_action=tempfail`
- rate limits por cliente
- no abrir IMAP/POP si no se usan

## 19. Checklist de remediacion

Alta prioridad:

- [ ] Rotar secretos que aparecen en handoffs locales.
- [ ] Rotar API key IONOS si sigue activa.
- [ ] Mover secretos a password manager.
- [ ] Configurar PTR de `45.136.70.172` a `smtp.nfcorpreport.online`.
- [ ] Cambiar DMARC de `fileyourcorp.app` de `p=none` a `p=quarantine`.
- [ ] Cambiar SPF de `fileyourcorp.app` y `filecorppro.net` de `~all` a `-all`.
- [ ] Cambiar `milter_default_action` a `tempfail` en `fileyourcorp.app` y `filecorppro.net`.
- [ ] Aplicar rate limits y sender restrictions modernos en `fileyourcorp.app`.

Media prioridad:

- [ ] Agregar `rua=mailto:dmarc-reports@<dominio>` a todos los DMARC.
- [ ] Deshabilitar AUTH global y dejarlo solo en 465/587.
- [ ] Corregir handoffs: puerto 25 no esta expuesto por UFW.
- [ ] Migrar Certbot standalone a webroot si se instala nginx en dominios antiguos.
- [ ] Crear monitoreo de queue, bounces, certificados y Fail2Ban.
- [ ] Registrar dominios en Google Postmaster Tools cuando haya volumen suficiente.

Baja prioridad:

- [ ] Evaluar MTA-STS/TLS-RPT si se cambia recepcion fuera de IONOS.
- [ ] Evaluar BIMI solo cuando DMARC llegue a `p=quarantine`/`p=reject` estable y haya marca formal.
- [ ] Crear selectors DKIM versionados para rotacion ordenada.

## 20. Comandos exactos de correccion

### 20.1 Corregir milter en dominios antiguos

```bash
sudo postconf -e 'milter_default_action = tempfail'
sudo systemctl reload postfix
sudo postconf -h milter_default_action
```

### 20.2 Aplicar rate limits faltantes

```bash
sudo postconf -e 'anvil_rate_time_unit = 60s'
sudo postconf -e 'smtpd_client_connection_count_limit = 10'
sudo postconf -e 'smtpd_client_connection_rate_limit = 15'
sudo postconf -e 'smtpd_client_message_rate_limit = 25'
sudo postconf -e 'smtpd_client_auth_rate_limit = 10'
sudo postconf -e 'smtpd_soft_error_limit = 10'
sudo postconf -e 'smtpd_hard_error_limit = 20'
sudo systemctl reload postfix
```

### 20.3 Restringir remitente por dominio

Para cada dominio:

```bash
MAIL_DOMAIN='example.com'
SMTP_LOGIN='mailer@example.com'
MAIL_DOMAIN_REGEX='example\\.com'

sudo tee /etc/postfix/sender_login_maps >/dev/null <<EOF
/^.+@${MAIL_DOMAIN_REGEX}$/ ${SMTP_LOGIN}
EOF

sudo tee /etc/postfix/allowed_sender_domains >/dev/null <<EOF
/^$/ OK
/^.+@${MAIL_DOMAIN_REGEX}$/ OK
/.*/ REJECT Authenticated SMTP mail must use an @${MAIL_DOMAIN} envelope sender
EOF

sudo postconf -e 'smtpd_sender_login_maps = regexp:/etc/postfix/sender_login_maps'
sudo postconf -e 'smtpd_sender_restrictions = reject_non_fqdn_sender,reject_unknown_sender_domain,check_sender_access regexp:/etc/postfix/allowed_sender_domains,reject_authenticated_sender_login_mismatch'
sudo systemctl reload postfix
```

### 20.4 Limitar SSH en UFW

```bash
sudo ufw delete allow OpenSSH
sudo ufw limit OpenSSH
sudo ufw status verbose
```

### 20.5 Agregar Fail2Ban completo

```bash
sudo tee /etc/fail2ban/jail.d/mail-stack.local >/dev/null <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[postfix-sasl]
enabled = true
port = smtp,ssmtp,submission,465,587
logpath = /var/log/mail.log

[dovecot]
enabled = true
port = 465,587,submission
logpath = /var/log/mail.log

[recidive]
enabled = true
logpath = /var/log/fail2ban.log
bantime = 1w
findtime = 1d
maxretry = 5
EOF

sudo systemctl restart fail2ban
sudo fail2ban-client status
```

### 20.6 Dejar AUTH solo en submission/submissions

```bash
sudo postconf -e 'smtpd_sasl_auth_enable = no'
sudo postconf -P 'submission/inet/smtpd_sasl_auth_enable=yes'
sudo postconf -P 'submissions/inet/smtpd_sasl_auth_enable=yes'
sudo postconf -P 'submission/inet/smtpd_tls_auth_only=yes'
sudo systemctl reload postfix
```

Despues validar:

```bash
sudo postconf -h smtpd_sasl_auth_enable
sudo postconf -M submission/inet submissions/inet
```

## 21. Fuentes externas usadas

- Google Workspace Admin Help, Email sender guidelines: https://support.google.com/a/answer/81126
- Google Workspace Admin Help, Email sender guidelines FAQ: https://support.google.com/a/answer/14229414
- Yahoo Sender Hub, FAQs: https://senders.yahooinc.com/faqs/
- Yahoo Sender Hub, Sender Best Practices: https://senders.yahooinc.com/best-practices/
- Microsoft Outlook.com sender policies: https://sendersupport.olc.protection.outlook.com/pm/policies.aspx
- RFC 7208 SPF: https://www.rfc-editor.org/rfc/rfc7208
- RFC 6376 DKIM: https://www.rfc-editor.org/rfc/rfc6376
- RFC 7489 DMARC: https://www.rfc-editor.org/rfc/rfc7489
- RFC 8058 One-Click Unsubscribe: https://www.rfc-editor.org/rfc/rfc8058
- RFC 8461 MTA-STS: https://www.rfc-editor.org/rfc/rfc8461
- RFC 8460 SMTP TLS Reporting: https://www.rfc-editor.org/rfc/rfc8460

## 22. Veredicto final

La configuracion nueva de SMTP esta bien encaminada y es tecnicamente seria. No se encontro un open relay. La autenticacion, DKIM, DMARC, TLS, UFW y Fail2Ban estan presentes en los VPS recientes. El mayor problema ya no es "montar SMTP", sino operar reputacion y secretos de forma profesional.

Para considerar el stack listo como estandar interno, hay que cerrar estos puntos:

1. Secretos fuera de Markdown y rotados.
2. PTR de `nfcorpreport.online`.
3. Dominios antiguos actualizados al patron nuevo.
4. `rua` DMARC en todos los dominios.
5. Monitoreo de entregabilidad y queue.
6. Politica estricta de consentimiento, volumen y warm-up.

Con eso, el stack queda apto para correo transaccional controlado. No debe usarse para cold email masivo ni para trafico promocional sin unsubscribe, consentimiento y monitoreo de quejas.
