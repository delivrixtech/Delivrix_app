# Roadmap Gmail automation — placement monitoring autónomo

**Para:** Codex, OpenClaw, Juanes, futuros operadores.
**De:** Claude (PM).
**Fecha:** 2026-05-28 jueves noche.
**Status:** producto pendiente · NO para demo viernes Final.0 · activación post-MVP.

## Por qué este doc

Anoche armamos Gmail IMAP placement-check (Carril D, ya en main). Pensé que iba en el demo. Juanes lo cuestionó con razón:

1. Para el demo viernes, el operador abre Gmail en una pestaña y muestra los seeds llegando — no necesita una capa IMAP en medio.
2. Si activamos el IMAP automation a futuro, hay que diseñar BIEN qué cuenta usa, para no exponer el Gmail personal del operador al gateway.

Este doc captura **lo que tenemos hoy** y **lo que falta** para que ese skill quede de calidad producto, no improvisado.

---

## Estado actual (en main)

| Componente | Status | Ubicación |
|---|---|---|
| Backend `placement-check` skill | ✓ Implementado | `apps/gateway-api/src/email-imap/gmail-adapter.ts` + `routes/placement-check.ts` |
| Tests adapter + handler | ✓ 23 verdes | `gmail-adapter.test.ts`, `placement-check.test.ts` |
| Librería `imapflow` 1.3.3 | ✓ Instalada | `package.json` |
| Env vars del backend | ✓ Wireado, NO seteado | `GMAIL_IMAP_*` (no presentes en `.env.local`) |
| Frontend `PlacementLivePanel` | ✓ Renderizado opcional | `apps/admin-panel/src/v5/components/PlacementLivePanel.tsx` (si IMAP no configurado, retorna `null` sin error) |
| Subject matcher canónico | ✓ Derivado del `rampId` | `sender-pool-status.ts` `deriveRampSubjectMatcher()` → `[delivrix-<12chars>]` |
| Gate kill switch IMAP | ✓ `GMAIL_IMAP_ENABLE=true/false` | Handler chequea env |
| Rate limit | ✓ `GMAIL_IMAP_MAX_QUERIES_PER_MIN=4` | Mutex en singleton |

**Lo bueno**: si mañana seteamos las env vars en una cuenta dedicada, el feature funciona sin tocar código.

---

## Lo que falta (orden de prioridad)

### Fase 1 — Cuenta Gmail dedicada al agente (~30 min setup + 1h tests)

**Por qué:** no usar `jectcode@gmail.com` (personal del CTO). Razones:
- El gateway tendría visibilidad completa del inbox personal (Slack, GitHub, recibos, todo).
- Cuando sumemos más operadores, todos comparten la cuenta del agente, no la del CTO.
- Si rota la cuenta del CTO, el agente queda sin acceso aunque la cuenta del agente no cambió.

**Tareas:**

1. **Crear cuenta Gmail dedicada**: `monitor.delivrix@gmail.com` (o nombre similar disponible). No usar nombre del operador.

2. **Habilitar 2FA**: `https://myaccount.google.com/security` en la cuenta nueva. Sin 2FA no se puede generar App Password.

3. **Generar App Password**: `https://myaccount.google.com/apppasswords` → tipo "Mail" → 16 chars sin espacios.

4. **Setear env vars en `.env.local`**:
   ```
   GMAIL_IMAP_HOST=imap.gmail.com
   GMAIL_IMAP_PORT=993
   GMAIL_IMAP_USER=monitor.delivrix@gmail.com
   GMAIL_IMAP_APP_PASSWORD=<16chars>
   GMAIL_IMAP_ENABLE=true
   GMAIL_IMAP_MAX_QUERIES_PER_MIN=4
   ```

5. **Smoke test E2E**:
   - Manualmente enviar 3 emails a `monitor.delivrix+seed1@gmail.com`, `+seed2`, `+seed3` con subject `[delivrix-smoke-2026-05-XX] seed N`.
   - Llamar `POST /v1/openclaw/skills/placement-check` con `matcher="[delivrix-smoke-2026-05-XX"`.
   - Verificar `matched>=3`, `inbox>=3`, `spam==0`, samples poblados con folder badge.
   - Si OK, smoke pasa.

6. **Documentar la cuenta**: agregar a `DOCUMENTACION/SECRETS_AND_ACCOUNTS_REGISTRY.md` (crear si no existe) con: propósito, owner, fecha creación, rotación trimestral programada.

**Criterio de aceptación Fase 1**: `placement-check` devuelve resultados reales contra la cuenta dedicada. Frontend `PlacementLivePanel` muestra INBOX vs SPAM en vivo cuando hay ramp activo. Cero acceso del gateway a Gmail personal del operador.

### Fase 2 — Plus-addressing por dominio (~ya soportado, solo convención)

**Por qué:** un solo inbox del agente puede monitorear N dominios sin crear N cuentas.

**Convención:**
- Seeds para dominio `delivrix-mail.com` → `monitor.delivrix+warmup-delivrix-mail-1@gmail.com`, etc.
- Seeds para dominio `acme-corp.io` → `monitor.delivrix+warmup-acme-corp-1@gmail.com`.

**Tareas:**
1. **Convention helper en backend**: función `buildSeedAddressesForDomain(domain: string, monitorEmail: string, n: number): string[]` que genera las direcciones canónicas.
2. **UI default en `StartWarmupRampInline`**: cuando el operador clickea "Iniciar warmup", pre-llenar el textarea con las 3 plus-addresses canónicas (puede sobreescribirlas si quiere).
3. **Subject matcher único per ramp**: ya implementado (`[delivrix-<rampId-12chars>]`). Asegurar que el adapter SMTP inyecta ese subject por cada batch.

**Criterio de aceptación Fase 2**: el operador arranca warmup sin tener que pegar direcciones — el panel las pre-llena. Cada dominio tiene placement separado en `PlacementLivePanel`.

### Fase 3 — Auto-pause por placement bajo (~2h)

**Por qué:** automatización real. El agente decide pausar si placement <70% en un batch, no espera al humano.

**Tareas:**
1. **Background poller**: cuando un ramp está corriendo, un job interno llama `placement-check` 5 min después de cada batch_sent.
2. **Decisión**: si `inbox/matched < 0.70` o `spam/matched > 0.30`, llamar `pauseRamp({reason: "low_placement"})` y emitir `oc.warmup.ramp_auto_paused` al audit chain.
3. **UI**: `WarmupRampPanel` ya muestra `state="auto_paused"` con banner crítico. Agregar `pauseReason="low_placement_inbox_X_of_Y"` visible.
4. **Escalation**: notificar al operador (toast + email opcional).

**Criterio de aceptación Fase 3**: simulamos un dominio con reputación mala (manualmente forzando subject que Gmail manda a spam). El ramp se pausa solo en <5 min sin intervención humana. Audit chain registra la decisión.

### Fase 4 — Dominio propio para inbox monitoring (~2-3h, Hito 5.13+)

**Por qué:** depender de Gmail tiene límites (rate limits, cuotas, ToS). Cuando Delivrix tenga su propio dominio (ej. `delivrix.io`), montar un MX catch-all.

**Tareas:**
1. **Postfix + Dovecot + Maildir simple** en un VPS dedicado.
2. **Catch-all en MX**: `@inbox-monitor.delivrix.io` cae todo en 1 maildir.
3. **IMAP local**: `imap.inbox-monitor.delivrix.io:993` con TLS Let's Encrypt.
4. **Migrar `GMAIL_IMAP_*` a `MONITOR_IMAP_*`** sin cambiar el adapter (mismo `imapflow`).
5. **Beneficio**: cuotas propias, plus-addressing infinito, control completo.

**Criterio de aceptación Fase 4**: el panel funciona idéntico pero contra dominio propio. Gmail queda como fallback opcional.

### Fase 5 — Multi-cuenta para placement Outlook + Yahoo (~3-4h)

**Por qué:** Gmail solo mide placement en Gmail. Para el verdadero warmup hay que probar contra Outlook/Hotmail y Yahoo también.

**Tareas:**
1. **`OutlookGraphAdapter`**: usar Microsoft Graph API (OAuth2) o IMAP con App Password.
2. **`YahooImapAdapter`**: IMAP con App Password.
3. **Endpoint `placement-check`**: acepta `provider: "gmail" | "outlook" | "yahoo"` o `auto` (consulta los 3).
4. **Frontend**: `PlacementLivePanel` muestra 3 columnas (Gmail / Outlook / Yahoo) con barras INBOX vs SPAM por proveedor.

**Criterio de aceptación Fase 5**: el operador ve placement por proveedor. Si Gmail está OK pero Outlook está mandando a spam, el panel lo destaca.

---

## Decisiones para Juanes

| Pregunta | Default propuesto | Alternativa |
|---|---|---|
| ¿Cuándo activamos Fase 1? | Post-demo viernes (sábado o lunes) | Tarde del jueves si demo se posterga |
| ¿Quién es owner de la cuenta `monitor.delivrix@gmail.com`? | Juanes (CTO) | Compartida con futuro DevOps |
| ¿Rotación de App Password? | Trimestral programada en `SECRETS_AND_ACCOUNTS_REGISTRY.md` | Ad-hoc |
| ¿Fase 4 (dominio propio) cuándo? | Hito 5.13 (post-MVP cierre día 30) | Si Hostinger pide ver "infra completa", Hito 5.14 |
| ¿Multi-cuenta Outlook/Yahoo? | Hito 6.x | Si cliente B2B lo pide explícito |

---

## Anti-patterns a evitar

1. **NO** usar el Gmail personal del operador (`jectcode@gmail.com`) como `GMAIL_IMAP_USER`. Razones arriba.
2. **NO** hardcodear las direcciones de seed en `.env.local`. El operador las define en runtime via UI (`StartWarmupRampInline`).
3. **NO** ejecutar `placement-check` si no hay subject matcher único. El regex `^\[delivrix-{rampId}\]` evita falsos positivos.
4. **NO** dar el App Password de la cuenta del agente a humanos que no necesiten leer ese inbox. Si la regla 2FA cambia, regenerar.
5. **NO** mezclar placement de demos con producción en el mismo inbox del agente. Cuando MVP cierre, separar `monitor.delivrix-demo@` vs `monitor.delivrix-prod@`.

---

## Referencias

- `REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §14, §17.1` (warm-up disciplinado + revisión Authentication-Results y placement).
- `apps/gateway-api/src/email-imap/gmail-adapter.ts` (adapter implementado).
- `apps/gateway-api/src/routes/placement-check.ts` (handler implementado).
- `apps/admin-panel/src/v5/components/PlacementLivePanel.tsx` (frontend opcional).

— Claude
