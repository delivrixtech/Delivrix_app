# Brief Codex - OpenClaw autonomo en Route53 (zone-discovery + iteration cap + reconcile DNS->server vivo)

> Track O (OpenClaw confiable). 2026-07-01. Prioridad ALTA.
> Norte CTO: "el mismo agente debe resolver todo tipo de problemas sin depender de Claude, Codex o el CTO". Este brief cierra la brecha exacta que lo bloqueo hoy. NO requiere cambios de IAM.

## 0. Contexto - que paso hoy (auditado en vivo)

1. **clientHold de la flota RESUELTO.** ~13 dominios estaban NXDOMAIN por email de registrante (infra@delivrix.com) no verificado -> Amazon los suspende a los 15 dias exactos. Se verifico el email una vez -> toda la flota unsuspended. (Ver memoria clienthold.)
2. **Barrido quinary/InfraVPS:** los 6 SMTP tienen el DNS mal apuntado:
   - 4 con smtp A + SPF apuntando a servers ops MUERTOS (cuenta baneada): controlcorpfiling, corpdocfiling-ledger, controlledgerdesk, corpfiling-delivery.
   - 2 sin smtp A + MX (SPF/DKIM ya en quinary): corpfilingcontrol, nationalcorpops.
3. **Piloto (repoint de controlcorpfiling.com via OpenClaw) FALLO por 2 causas - NINGUNA de permisos:**
   - **Zone IDs stale:** OpenClaw uso IDs cacheados errados: `Z0538459IQMXKXHFWXJN` (no existe -> hosted_zone_not_found) y `Z2FDTNDATAQYW2` (zona de OTRA cuenta -> "not authorized"). Nunca probo la zona REAL `Z01313019Q8DEA3UGP8G`.
   - **Iteration cap:** `maxToolIterations=10` -> agotado investigando (inspect, reachability, mxtoolbox, route53 reads) -> `bedrock_tool_loop_exceeded`, abortado sin proposal.
4. **IAM CONFIRMADO SUFICIENTE (verificado en consola, lectura):** usuario `delivrix-route53-ops`, policy inline `DelivrixRoute53Ops`, statement `Route53HostedZoneAndRecordsManagement`:
   - Actions: route53:GetHostedZone, GetHostedZoneCount, **ListHostedZones**, **ListHostedZonesByName**, **ChangeResourceRecordSets**, **ListResourceRecordSets**, GetChange, CreateHostedZone, DeleteHostedZone, UpdateHostedZoneComment, Change/ListTagsForResource.
   - **Resource: "*"** -> puede leer y escribir CUALQUIER hosted zone de la cuenta 397450413307 (incluida Z01313019).
   -> **NO tocar IAM.** El agente ya tiene la llave; solo la estaba usando mal (ID viejo en vez de descubrir la zona).

## 1. FIX 1 (raiz) - zone discovery por nombre, nunca zone ID cacheado

En el runtime de Route53 de OpenClaw (los tools que leen/escriben records: `read_route53_zone_records` y el writer de records): reemplazar el uso de un `zoneId` persistido/cacheado por descubrimiento en runtime.

- Resolver via `route53:ListHostedZonesByName` con el apex -> tomar la zona cuyo `Name == "<domain>."`.
- **Duplicados** (controldelivrix.app tiene 3 hosted zones: Z07656533JK498URWB1RN / Z03595092JW2AXJBZGN4E / Z05446832ZTEHK5OGBCZI): cuando hay >1 zona para el mismo apex, elegir la AUTORITATIVA = aquella cuyos 4 NS coinciden con los nameservers del registrador (`route53domains:GetDomainDetail` -> Nameservers). Las otras son huerfanas -> NO tocarlas, loguear para limpieza.
- Cachear el zoneId resuelto SOLO por la duracion del run (no persistir un ID que puede quedar stale). Si un write devuelve `NoSuchHostedZone` o `AccessDenied`, RE-DESCUBRIR por nombre; nunca reintentar el ID viejo.

**DoD Fix1:** dado `controlcorpfiling.com`, OpenClaw resuelve `Z01313019Q8DEA3UGP8G` solo (sin que nadie le pase el ID) y opera sobre esa zona.

## 2. FIX 2 - subir el iteration cap

`openclaw-bedrock-bridge`: `maxToolIterations` 10 -> 40 (mismo criterio que el fix de ventana 12->40 previo). Un reconcile multi-paso (inspect + reachability + zone discovery + read records + change + verify + test) no cabe en 10 iteraciones. Config/env con tope de seguridad; loguear cuando se acerque al limite.

## 3. FIX 3 - capacidad "reconcile DNS -> server vivo" (gated + firmado)

OpenClaw debe poder alinear el DNS de un dominio a su server SMTP vivo, reusando el server quinary existente (NO crear nuevos, NO tocar ops/quaternary):

- `smtp.<domain>` A -> IP del server vivo.
- SPF TXT -> `v=spf1 ip4:<IP viva> -all` (reemplazar la IP vieja).
- MX -> `10 smtp.<domain>` (crear si falta).
- **DKIM:** si el server destino no tiene la clave del selector `s2026a`, regenerarla en el server y publicar el TXT nuevo en `s2026a._domainkey.<domain>` (si no, la firma DKIM falla). No dejar el DKIM del server viejo.
- **Verificacion post-cambio:** dig smtp A + SPF + DKIM + envio de prueba a inbox. Verificar power state live (inspect) ANTES del cutover; no repuntar a un server sin el SMTP del dominio configurado.

## 4. Targets del barrido (cuenta quinary/InfraVPS)

| dominio | server vivo | IP viva | smtp A actual (muerto) | accion |
|---|---|---|---|---|
| controlcorpfiling.com | server60 | 193.180.211.182 | 193.181.213.65 | smtp A + SPF -> .182 |
| corpdocfiling-ledger.com | server68 | 193.180.213.197 | 193.181.213.66 | smtp A + SPF -> .197 |
| controlledgerdesk.com | server69 | 193.181.208.49 | 193.181.212.156 | smtp A + SPF -> .49 |
| corpfiling-delivery.com | server84 | 193.181.213.13 | 193.181.213.81 | smtp A + SPF -> .13 |
| corpfilingcontrol.com | server81 | 193.181.212.223 | (falta) | crear smtp A .223 + MX |
| nationalcorpops.com | server83 | 193.181.212.248 | (falta) | crear smtp A .248 + MX |

controldelivrix.app: sin SMTP + 3 zonas duplicadas -> limpiar zonas huerfanas + definir si se monta.
Zona real de referencia: controlcorpfiling.com = `Z01313019Q8DEA3UGP8G`. El resto: resolver por nombre (Fix1), NO hardcodear.

## 5. Guardrails (no negociable)

- Cada cambio DNS = firma operador + audit chain SHA-256 + kill-switch (como las demas mutaciones).
- Nunca tocar zonas ajenas ni cuentas ops/quaternary (baneadas).
- Verificar contra la fuente real (ListHostedZonesByName + dig) antes y despues.
- Dry-run del plan de records antes de firmar.

## 6. DoD

- OpenClaw resuelve la zona por nombre solo (sin ID cacheado); el piloto controlcorpfiling se auto-completa E2E (inspect -> zone discovery -> repoint smtp A+SPF -> DKIM ok -> prueba a inbox) sin escalar al operador.
- El reconcile corre los 6 dominios de quinary de a uno.
- Sin regresion (configure_complete_smtp, enable_smtp_auth, invariante P1 intactos).

## 7. Deploy (regla sync local + Hostinger)

1. tests verdes (nuevos: zone-discovery, dedup zonas, reconcile).
2. commit + push + merge a produ.
3. sync Hostinger + `scripts/openclaw/build-system-context.sh` (para que OpenClaw "vea" el cambio en su system prompt).
4. reiniciar gateway.
