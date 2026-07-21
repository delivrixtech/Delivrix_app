# Brief Codex - Gate de autenticacion pre-smoke + fix DNS-target en configure_complete_smtp (evitar cold sends sin autenticar)

> Track O / seguridad de envio. 2026-07-01. Prioridad ALTA (peligroso: quema reputacion de la flota).

## 0. Incidente (piloto controlcorpfiling, run configure_complete_smtp 14/14 "completado")

El smoke test entrego un correo real a Gmail (infra@delivrix.com) que **cayo en SPAM** y Gmail lo marco **"This message isn't authenticated and the sender can't be verified"**. Auditado por DoH (ground truth):

- El run PROVISIONO el SMTP en un server NUEVO: **45.136.70.174** (slug server58). Ese server quedo BIEN: Postfix, DKIM `s2026a` (RSA-2048 publicada) y **PTR `45.136.70.174` -> `smtp.controlcorpfiling.com` correcto**.
- PERO el DNS del dominio quedo apuntando al server VIEJO/MUERTO:
  - `smtp.controlcorpfiling.com` A = **193.181.213.65** (deberia ser 45.136.70.174)
  - SPF (`controlcorpfiling.com` TXT) = **v=spf1 ip4:193.181.213.65 -all** (autoriza la IP vieja)
- El correo SALIO de 45.136.70.174 pero SPF autoriza 193.181.213.65 -> **SPF FALLA** -> "not authenticated" -> spam. FCrDNS tambien roto (el A del hostname no vuelve a la IP que envia).

**Causa raiz:** `configure_complete_smtp` provisiono en una IP nueva pero **escribio smtp A + SPF con el IP viejo** (reuso el valor del A-record preexistente en vez del IP del server recien creado/elegido). NO es reputacion de IP fria; es configuracion incorrecta que garantiza fallo de auth.

**Agravante de comportamiento:** OpenClaw declaro el run "completado" y el correo "queued/delivered" sin detectar el fallo de auth ni el spam. Tratar "delivered" (handoff SMTP ok) como success es peligroso.

## 1. FIX 1 (raiz) - escribir el DNS con el IP del server provisionado

En `configure_complete_smtp` (routes/orchestrator-smtp.ts), los pasos que escriben DNS (`Configurando DNS (A/MX)` y `Configurando SPF/DKIM/DMARC`) deben usar el **IP del server provisionado en el paso create/reuse** (`runState.serverIpv4` / el `step4Ipv4`), NO el valor del A-record existente del dominio. Invariante: tras el run, `smtp.<domain>` A == IP del server y SPF `ip4:<IP del server>`. Test: run que crea server con IP X -> smtp A == X y SPF contiene ip4:X (no el IP viejo del record previo).

## 1b. FIX 1b (mismo root) - registrar la entrada de inventario del server provisionado

Segundo drift del mismo run: `configure_complete_smtp` completo (status:completed, step14) pero **NO registro la entrada `configured`** en smtp-provisioning.json para controlcorpfiling.com / server58. Por eso el Gateway bloquea toda tool suelta (send_real_email, reconcile, SASL) con `use_configure_complete_smtp`. El orquestador debe, como parte del run, **upsert la entrada de inventario** (domain, serverSlug, serverIp del server provisionado, selector, status:"configured") ANTES de marcar el run completo. Invariante: run completo => existe entrada configured con el IP real del server. (Reusar el upsert del PR#35 `upsertConfiguredSmtpInventoryEntry`.) Test: tras un run E2E, inspect_smtp_inventory devuelve la entrada configured para ese domain+server+IP.

## 2. FIX 2 (gate no negociable) - verificacion de auth ANTES del smoke

Antes del step 14 (`send_real_email` / smoke), agregar un gate que haga `dig` (resolver publico) y EXIJA, para el dominio y el IP del server provisionado:
- `smtp.<domain>` A == IP del server. 
- SPF (`<domain>` TXT) contiene `ip4:<IP del server>`.
- DKIM `<selector>._domainkey.<domain>` TXT resuelve con `p=` NO vacio.
- DMARC `_dmarc.<domain>` TXT presente.
- PTR de `<IP del server>` == `smtp.<domain>` (FCrDNS forward-confirmed: el A del hostname vuelve a la IP).

Si CUALQUIERA falla -> **BLOQUEAR el smoke** con error claro (`smoke_blocked_auth_not_ready` + detalle de que eje fallo), reintentar tras propagacion (TTL) o abortar. NUNCA enviar un correo real desde un sender que no autentica. (Esto solo habria evitado el incidente entero.)

## 3. FIX 3 - verificar la AUTENTICACION post-smoke, no solo el handoff

El resultado del smoke NO es "delivered"/"queued". Tras enviar, verificar el resultado real de autenticacion:
- Opcion a: enviar a un verificador (p.ej. check-auth@verifier.port25.com) y parsear spf=pass/dkim=pass/dmarc=pass.
- Opcion b: si se envia a un buzon propio, leer los headers `Authentication-Results`.
Reportar spf/dkim/dmarc (pass/fail) y, si es posible, placement (inbox/spam). El orquestador NO debe reportar "SMTP activo/verificado E2E" ni marcar el run success si la auth fallo.

## 4. FIX 4 - reusar server existente por slug (evitar VPS redundante)

El run creo un server NUEVO (server58) pese a `requireExistingDomain:true` y a la intencion de reusar server60. `configure_complete_smtp` deberia aceptar un `reuseServerSlug`/`serverSlug` opcional para adoptar un server existente (idempotente) en vez de crear uno cada vez. Sin esto, cada re-run gasta un VPS nuevo.

## 5. Prompt/entrenamiento de OpenClaw (build-system-context)

Agregar regla dura al system prompt de OpenClaw: "Un correo entregado que cae en spam o que no autentica NO es exito. Antes de cualquier envio real, verificar que smtp A, SPF, DKIM, DMARC y PTR/FCrDNS resuelvan consistentes con el IP que realmente envia; si no, parar y arreglar el DNS. Despues de enviar, verificar Authentication-Results (spf/dkim/dmarc pass) y placement antes de declarar success. Nunca blastear cold sends desde IP/dominio sin auth verificada - quema la reputacion de la flota."

## 6. Fix inmediato del dominio afectado (no de Codex, operativo)

controlcorpfiling.com: reconciliar el DNS al server real -> `smtp.controlcorpfiling.com` A -> 45.136.70.174, SPF -> `ip4:45.136.70.174 -all` (via reconcile_dns_to_live_smtp firmado). Luego re-verificar auth antes de dar por bueno. (server58/.174 ya tiene DKIM + PTR ok.)

## 7. DoD
- configure_complete_smtp deja smtp A + SPF apuntando al IP del server provisionado (test).
- El smoke NO se envia si el stack de auth no resuelve consistente (gate + test fail-closed).
- El run reporta auth real (spf/dkim/dmarc) y no marca success con auth fallida.
- OpenClaw (system prompt) no trata "delivered" como success.

## 8. Deploy (regla sync local + Hostinger)
tests verdes -> commit + push + merge produ -> Hostinger + scripts/openclaw/build-system-context.sh (para la regla nueva de OpenClaw) -> restart gateway.
