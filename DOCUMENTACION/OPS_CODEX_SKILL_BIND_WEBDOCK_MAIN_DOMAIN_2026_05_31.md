# OPS Codex — Skill `bind_webdock_main_domain`

**Fecha despacho:** 2026-05-31 domingo 14:30 COT.
**Fecha ejecución:** **HOY MISMO. Paralelizable con OPS 1/3/4.**
**Severidad:** P1 — bloquea cierre del flow E2E SMTP (sin Main Domain bound, Postfix banner queda con hostname genérico Webdock → flag spam).
**Owner:** Codex backend senior.
**PM:** Claude.
**Modo:** URGENT.

---

## Síntoma / Motivación

Webdock crea VPS con hostname tipo `webdock-server-abc123.webdock.cloud`. Si Postfix arranca con ese hostname:

- HELO/EHLO greeting expone `webdock.cloud` (rDNS mismatch garantizado).
- SPF align falla.
- Gmail/Outlook rechazan o mandan a spam el primer email.

Necesitamos una skill que **vincule el dominio comprado como Main Domain del VPS** (impacta hostname + rDNS/PTR si Webdock lo soporta). Esto **NO es** crear DNS records — eso lo hace `upsert_dns_route53`. Esto **es** decirle al VPS *"tu identidad ante el mundo es `<dominio>`, no el slug Webdock"*.

Memoria operativa Juanes (2026-05-30): hostname VPS = dominio directo (NO `mail.<dominio>` prefix, que es flag spam).

---

## Decisión arquitectónica

- **Categoría matrix:** `supervised_local_state` (1 firma operador via ApprovalGate).
- **Idempotente:** si el Main Domain ya está bound al mismo valor, la skill retorna `ok: true, alreadyBound: true` sin tocar nada.
- **Reversible:** sí. Auto-rollback restaura el hostname previo si la operación falla parcialmente (ej. PTR set OK pero hostname update timeout).
- **Audit event:** `oc.webdock.main_domain_bound` con metadata `{ serverSlug, previousMainDomain, newMainDomain, ptrSet, eventId }`.
- **Adapter logger:** usar el adapter mejorado del commit `4b0707c` (captura body 4xx completo).

---

## Tarea 1 — Investigar API Webdock real ANTES de implementar

**BLOQUEANTE.** Codex debe ejecutar primero:

```bash
# Webdock API docs: https://webdock.io/en/docs/webdock-api/

# 1. Listar servidores
curl -H "Authorization: Bearer $WEBDOCK_API_KEY_PRIMARY" \
  "https://api.webdock.io/v1/servers" | jq

# 2. Inspeccionar response — buscar campo "description" o "mainDomain" o "hostname" en el JSON
curl -H "Authorization: Bearer $WEBDOCK_API_KEY_PRIMARY" \
  "https://api.webdock.io/v1/servers/<slug>" | jq

# 3. Buscar endpoint PATCH/PUT para servidor
# Posibles:
#   PATCH /v1/servers/{slug}            (body: { description, mainDomain })
#   POST  /v1/servers/{slug}/main-domain
#   POST  /v1/servers/{slug}/hostname

# 4. Buscar endpoint PTR
#   GET   /v1/servers/{slug}/ptr
#   POST  /v1/servers/{slug}/ptr        (body: { ipv4, value })

# 5. Si NINGÚN endpoint expone Main Domain via API:
#    fallback = SSH a VPS y ejecutar:
#      sudo hostnamectl set-hostname <domain>
#      sudo sed -i "s/^127.0.1.1.*/127.0.1.1 <domain>/" /etc/hosts
#    Y para PTR, levantar issue: requiere acción manual en panel Webdock o ticket support.
```

**Output esperado de tarea 1:** documento corto `DOCUMENTACION/WEBDOCK_API_MAIN_DOMAIN_RESEARCH_2026_05_31.md` con:

- Endpoint exacto encontrado (o "no existe").
- Schema del body request/response.
- Si PTR es settable via API: sí/no + endpoint.
- Decisión: ruta API pura, ruta SSH fallback, o híbrida.

**No avancen a tarea 2 hasta tener este research escrito.**

---

## Tarea 2 — Schema zod

**Archivo nuevo:** `apps/gateway-api/src/routes/webdock-bind-domain.ts`.

```typescript
import { z } from "zod";

export const bindWebdockMainDomainParamSchema = z.object({
  serverSlug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/, "slug_invalid_format"),
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9-]{1,63})+$/, "domain_invalid_format")
    .refine((d) => !/^(mail|email|notify|noreply|alert|smtp|sender|inbox|bulk|blast)\./i.test(d), {
      message: "domain_has_prohibited_prefix"
    }),
  setPtr: z.boolean().default(true),
  actorId: z.string().min(1).max(120),
  approvalToken: z.string().min(1).max(200)
});

export type BindWebdockMainDomainParams = z.infer<typeof bindWebdockMainDomainParamSchema>;

export interface BindWebdockMainDomainResult {
  ok: boolean;
  serverSlug: string;
  mainDomain: string;
  previousMainDomain: string | null;
  ptrSet: boolean;
  ptrSkipReason?: "not_supported_by_api" | "ipv4_missing" | "operator_opt_out";
  alreadyBound: boolean;
  eventId: string;
  durationMs: number;
  error?: string;
}
```

---

## Tarea 3 — Adapter `webdock-real-adapter.ts` — método nuevo

**Archivo modificado:** `packages/adapters/src/webdock-real-adapter.ts`.

Agregar método (escoger ruta según research de tarea 1):

### Ruta A — API pura (si endpoint existe)

```typescript
async setServerMainDomain(opts: {
  serverSlug: string;
  domain: string;
}): Promise<{ ok: boolean; previousMainDomain: string | null; raw: unknown }> {
  const current = await this.getServer(opts.serverSlug);
  if (current.mainDomain === opts.domain) {
    return { ok: true, previousMainDomain: current.mainDomain, raw: { skipped: "already_bound" } };
  }
  // ENDPOINT VERIFICADO EN TAREA 1 — ajustar URL exacta
  const response = await this.fetch(`/v1/servers/${opts.serverSlug}`, {
    method: "PATCH",
    body: JSON.stringify({ description: opts.domain }) // o el campo exacto encontrado
  });
  if (!response.ok) {
    const body = await response.text(); // logger captura body 4xx
    this.logger.error("webdock.set_main_domain.failed", {
      status: response.status,
      body: body.slice(0, 2000),
      slug: opts.serverSlug
    });
    throw new WebdockAdapterError(`set_main_domain_failed_${response.status}`, { body });
  }
  return {
    ok: true,
    previousMainDomain: current.mainDomain ?? null,
    raw: await response.json()
  };
}

async setServerPtr(opts: {
  serverSlug: string;
  ipv4: string;
  ptrValue: string;
}): Promise<{ ok: boolean; supported: boolean; raw: unknown }> {
  // Si tarea 1 confirma endpoint PTR existe:
  const response = await this.fetch(`/v1/servers/${opts.serverSlug}/ptr`, {
    method: "POST",
    body: JSON.stringify({ ipv4: opts.ipv4, value: opts.ptrValue })
  });
  if (response.status === 404) {
    return { ok: false, supported: false, raw: null };
  }
  if (!response.ok) {
    const body = await response.text();
    this.logger.error("webdock.set_ptr.failed", { status: response.status, body: body.slice(0, 2000) });
    throw new WebdockAdapterError(`set_ptr_failed_${response.status}`, { body });
  }
  return { ok: true, supported: true, raw: await response.json() };
}
```

### Ruta B — SSH fallback (si API no expone Main Domain)

```typescript
async setServerHostnameViaSsh(opts: {
  serverSlug: string;
  domain: string;
  sshUsername: string;
  sshPublicKey: string;
}): Promise<{ ok: boolean; previousHostname: string | null; commandOutput: string }> {
  // Conectar SSH al VPS usando sshRunner inyectado en deps.
  const previous = await this.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command: "hostname"
  });
  const script = `
    set -euo pipefail
    sudo hostnamectl set-hostname '${opts.domain}'
    sudo sed -i 's/^127.0.1.1.*/127.0.1.1 ${opts.domain}/' /etc/hosts || \\
      echo "127.0.1.1 ${opts.domain}" | sudo tee -a /etc/hosts
    hostname
  `;
  const result = await this.sshRunner.run({
    slug: opts.serverSlug,
    username: opts.sshUsername,
    command: script
  });
  return {
    ok: result.exitCode === 0 && result.stdout.trim() === opts.domain,
    previousHostname: previous.stdout.trim() || null,
    commandOutput: result.stdout
  };
}
```

**Importante:** validar `domain` contra regex en adapter también (defensa en profundidad). NO permitir shell injection en `hostnamectl set-hostname '${domain}'`.

---

## Tarea 4 — Handler HTTP

```typescript
export async function handleBindWebdockMainDomain(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: BindWebdockMainDomainDeps;
}): Promise<void> {
  const body = await readJsonBody(input.request);
  const parsed = bindWebdockMainDomainParamSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;
  const startedAt = input.deps.now();

  // 1. Verificar firma operador
  const approval = await input.deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    sendJson(input.response, 403, { error: "approval_invalid" });
    return;
  }

  // 2. Verificar servidor existe
  let server;
  try {
    server = await input.deps.webdockAdapter.getServer(params.serverSlug);
  } catch (err) {
    sendJson(input.response, 404, { error: "server_not_found", slug: params.serverSlug });
    return;
  }

  // 3. Idempotencia
  if (server.mainDomain === params.domain) {
    const evt = await input.deps.auditLog.append({
      type: "oc.webdock.main_domain_bound",
      actorId: params.actorId,
      metadata: { serverSlug: params.serverSlug, mainDomain: params.domain, alreadyBound: true }
    });
    sendJson(input.response, 200, {
      ok: true,
      serverSlug: params.serverSlug,
      mainDomain: params.domain,
      previousMainDomain: params.domain,
      ptrSet: false,
      alreadyBound: true,
      eventId: (evt as { id?: string }).id ?? "",
      durationMs: input.deps.now() - startedAt
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  // 4. Bind Main Domain (Ruta A o B según research)
  let previousMainDomain: string | null = null;
  try {
    const bindResult = await input.deps.webdockAdapter.setServerMainDomain({
      serverSlug: params.serverSlug,
      domain: params.domain
    });
    previousMainDomain = bindResult.previousMainDomain;
  } catch (err) {
    await input.deps.auditLog.append({
      type: "oc.webdock.main_domain_bind_failed",
      actorId: params.actorId,
      metadata: { serverSlug: params.serverSlug, domain: params.domain, error: (err as Error).message }
    });
    sendJson(input.response, 502, { error: "bind_failed", details: (err as Error).message });
    return;
  }

  // 5. PTR (opcional)
  let ptrSet = false;
  let ptrSkipReason: BindWebdockMainDomainResult["ptrSkipReason"];
  if (params.setPtr) {
    if (!server.ipv4) {
      ptrSkipReason = "ipv4_missing";
    } else {
      try {
        const ptr = await input.deps.webdockAdapter.setServerPtr({
          serverSlug: params.serverSlug,
          ipv4: server.ipv4,
          ptrValue: params.domain
        });
        if (ptr.supported && ptr.ok) {
          ptrSet = true;
        } else if (!ptr.supported) {
          ptrSkipReason = "not_supported_by_api";
        }
      } catch (err) {
        // Auto-rollback main domain si PTR falla
        await input.deps.webdockAdapter.setServerMainDomain({
          serverSlug: params.serverSlug,
          domain: previousMainDomain ?? ""
        }).catch(() => {});
        await input.deps.auditLog.append({
          type: "oc.webdock.main_domain_rollback",
          actorId: params.actorId,
          metadata: { serverSlug: params.serverSlug, reason: "ptr_set_failed", error: (err as Error).message }
        });
        sendJson(input.response, 502, { error: "ptr_failed_rolled_back", details: (err as Error).message });
        return;
      }
    }
  } else {
    ptrSkipReason = "operator_opt_out";
  }

  // 6. Audit event final
  const evt = await input.deps.auditLog.append({
    type: "oc.webdock.main_domain_bound",
    actorId: params.actorId,
    metadata: {
      serverSlug: params.serverSlug,
      previousMainDomain,
      newMainDomain: params.domain,
      ptrSet,
      ptrSkipReason: ptrSkipReason ?? null,
      approvalEventId: approval.eventId ?? null
    }
  });

  sendJson(input.response, 200, {
    ok: true,
    serverSlug: params.serverSlug,
    mainDomain: params.domain,
    previousMainDomain,
    ptrSet,
    ptrSkipReason,
    alreadyBound: false,
    eventId: (evt as { id?: string }).id ?? "",
    durationMs: input.deps.now() - startedAt
  } satisfies BindWebdockMainDomainResult);
}
```

---

## Tarea 5 — Wire en `main.ts` + `skill-dispatcher.ts`

1. **main.ts:** `POST /v1/skills/bind-webdock-main-domain`.
2. **skill-dispatcher.ts:**

```typescript
const bindWebdockMainDomain: SkillHandlerEntry = {
  paramSchema: bindWebdockMainDomainParamSchema,
  timeoutMs: 120_000,
  canRollback: true,
  invoke: ({ request, response, deps }) =>
    handleBindWebdockMainDomain({
      request,
      response,
      deps: {
        auditLog: deps.auditLog,
        approvalGuard: deps.approvalGuard,
        webdockAdapter: deps.webdockAdapter,
        now: deps.now
      }
    })
};

return {
  // ... existing
  bind_webdock_main_domain: bindWebdockMainDomain,
  webdock_main_domain_bind: bindWebdockMainDomain
};
```

3. **OPENCLAW_PERMISSIONS_MATRIX.md:** agregar fila con categoría `supervised_local_state`, reversible `sí`, rollback `sí (restaura main domain previo si PTR falla)`.

---

## Tarea 6 — Tests obligatorios

**Archivo:** `apps/gateway-api/src/routes/webdock-bind-domain.test.ts`.

Mínimo 6 tests + 2 adapter tests = 8 total:

1. **Happy path completo** — bind Main Domain + PTR OK → `ok: true, ptrSet: true, alreadyBound: false`.
2. **Idempotente — ya bound** — `getServer` retorna server con `mainDomain === params.domain` → `ok: true, alreadyBound: true`, NO se llama `setServerMainDomain`.
3. **Server slug inexistente** — `getServer` throws → HTTP 404 `server_not_found`.
4. **Domain malformed (`mail.foo.com`)** → HTTP 400 `invalid_params` con `domain_has_prohibited_prefix`.
5. **PTR falla → rollback** — bind OK, PTR throw → adapter `setServerMainDomain` se llama 2da vez con `previousMainDomain`, audit event `oc.webdock.main_domain_rollback` emitido, HTTP 502.
6. **PTR no soportado por API** — `setServerPtr` retorna `{ ok: false, supported: false }` → `ok: true, ptrSet: false, ptrSkipReason: "not_supported_by_api"`.
7. **Approval token inválido** → HTTP 403, NO se llama adapter.
8. **setPtr: false (operator opt-out)** → `ptrSet: false, ptrSkipReason: "operator_opt_out"`, bind OK.

**Adapter tests** (`packages/adapters/src/webdock-real-adapter.test.ts`):

9. **`setServerMainDomain` — 4xx con body capturado** — mock fetch retorna 422 con body `{"error":"invalid"}` → adapter logger registra body completo + lanza `WebdockAdapterError`.
10. **`setServerPtr` — 404 supported=false** — mock fetch retorna 404 → adapter retorna `{ ok: false, supported: false }`, NO throw.

---

## Sign-off requerido

- [ ] Tarea 1 (research API Webdock) entregada con doc `WEBDOCK_API_MAIN_DOMAIN_RESEARCH_2026_05_31.md` antes de tocar código.
- [ ] Codex confirma SHA final del commit + push a main.
- [ ] `pnpm tsc --noEmit` clean en `apps/gateway-api` y `packages/adapters`.
- [ ] `pnpm vitest run` verde con ≥ 8 tests nuevos.
- [ ] Adapter logger captura body 4xx (verificar con test 9).
- [ ] Smoke manual: con VPS real existente (Webdock pool Pebble), bind main domain a un dominio de prueba ya comprado, verificar via `GET /v1/servers/{slug}` que `mainDomain` cambió + `hostname` via SSH cambió + rDNS via `dig -x <ip>` retorna el nuevo dominio.
- [ ] Audit chain `oc.webdock.main_domain_bound` aparece con prevHash linked.
- [ ] PM Claude revisa diff antes de merge.

---

## Entregables

1. **Research:** `DOCUMENTACION/WEBDOCK_API_MAIN_DOMAIN_RESEARCH_2026_05_31.md`.
2. **Código:**
   - `apps/gateway-api/src/routes/webdock-bind-domain.ts` (handler + schema)
   - `apps/gateway-api/src/routes/webdock-bind-domain.test.ts` (≥ 6 tests)
   - `packages/adapters/src/webdock-real-adapter.ts` (métodos `setServerMainDomain`, `setServerPtr`, opcional `setServerHostnameViaSsh`)
   - `packages/adapters/src/webdock-real-adapter.test.ts` (+ 2 tests)
   - `apps/gateway-api/src/main.ts` (wire ruta)
   - `apps/gateway-api/src/skill-dispatcher.ts` (entry + alias)
   - `DOCUMENTACION/OPENCLAW_PERMISSIONS_MATRIX.md` (fila nueva)

3. **Smoke evidence:** `runtime/webdock-bind-smoke-{timestamp}.json` con response del API antes/después.

---

## Notas finales del PM

- **NO INVENTES el endpoint Webdock.** Si tarea 1 concluye que la API no expone Main Domain, escoge **explícitamente** Ruta B (SSH fallback) y documenta esa decisión en el OPS result.
- **Verificar contra docs oficiales:** https://webdock.io/en/docs/webdock-api/ — confirma todos los endpoints antes de codificar.
- **Si el endpoint usado es PATCH /v1/servers/{slug} con body `{ description }`:** validar que ese campo realmente cambie el hostname/main domain en el VPS, no solo metadata en el panel. Si solo es metadata, declarar ruta híbrida (PATCH + SSH `hostnamectl`).
- **Rollback idempotente:** si PTR set falla, el rollback de main domain debe ser idempotente. Si el rollback también falla, emit `oc.webdock.bind_inconsistent_state` audit event de severidad CRITICAL para que el operador intervenga manualmente.
- **NO uses `mail.<domain>` ni ningún prefijo en el hostname.** El refine del schema bloquea explícitamente esos prefijos.
- **Adapter logger del commit 4b0707c** ya captura bodies 4xx — confirmá que estás usando esa versión antes de empezar.
- **Reportar a PM Claude** al terminar research + al terminar implementación.

— Claude PM
