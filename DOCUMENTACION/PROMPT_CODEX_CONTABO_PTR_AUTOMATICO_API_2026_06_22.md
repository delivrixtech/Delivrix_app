# BRIEF CODEX — Automatizar el PTR/rDNS de Contabo por API (elimina el paso manual del step 8)

Fecha: 2026-06-22 · OpenAPI oficial Contabo + AUDITADO adversarialmente (subagente) · Ejecuta: **Codex** · Base: **`produ`** · Despues: **merge a `produ`**

## CORRECCIONES OBLIGATORIAS (auditoría adversarial) — leer ANTES de implementar
El núcleo es correcto: endpoint `PUT /v1/dns/ptrs/{ip}`, idempotente, y **`computeFetch` (`:557-567`) YA inyecta `x-request-id`** via `randomUUID()` en `:561` (confirmado contra `produ` actual — no hace falta agregarlo). PERO el cableado tal cual NO COMPILA + rompe 2 tests + tiene 1 regresión. Aplicar:
1. **(Bloqueante — no compila) Interface:** `bindNonWebdockMainDomain` recibe `adapter: VpsProvider` (la INTERFACE, `webdock-bind-domain.ts:487`), y `VpsProvider` (`vps-provider.ts:29-50`) NO tiene `setReverseDns` → `adapter.setReverseDns(...)` da error TS. Agregar `setReverseDns?(ip, hostname): Promise<{ok;status;detail?}>` como método **OPCIONAL** a la interface `VpsProvider` (no obligar a `WebdockRealAdapter` a implementarlo).
2. **(Bloqueante) Guard en el call site:** `if (typeof adapter.setReverseDns === "function") { ...setea por API... } else { ...emit oc.bind.contabo_manual_ptr_required actual (fallback) }`. No asumir que todo `VpsProvider` lo expone.
3. **(Rompe tests) Actualizar tests:** `webdock-bind-domain.test.ts:276-279` y `:314` asertan `oc.bind.contabo_manual_ptr_required` → actualizarlos a `oc.bind.contabo_ptr_set` / `contabo_ptr_set_failed`. Y agregar `setReverseDns` al `vpsProviderMock` (`:505`, junto a `setServerPtr` `:489`), si no queda `undefined` y el guard cae al fallback siempre.
4. **(Regresión — crítico) PUT-fail debe CONTINUAR al FCrDNS, NO early-return:** si el PUT falla (400/401/red), emitir `contabo_ptr_set_failed` + operatorAction y **seguir al FCrDNS verify** (que da `fcrdns_pending` 424 reintentable, igual que el comportamiento de hoy). **NUNCA `return json(502)`** — eso rompería el camino pending-reintentable (regresión vs hoy). Agregar test de ese camino (PUT 4xx → degrada a pending, no 502).
5. **(Menor) E2E:** la prueba sobre `217.216.91.100` es un re-PUT idempotente **NO-destructivo** (re-setea el mismo hostname `smtp.nationalbizrenewal.com`); marcarlo así para que Codex no experimente con una IP equivocada.

## Hallazgo: Contabo SÍ tiene API pública de rDNS — el "panel-only" del adapter está MAL
Hoy el PTR de cada VPS Contabo se setea **a mano** en `new.contabo.com` (Gestión de DNS inverso), lo que obliga a un flujo 2-fases por SMTP (run#1 crea VPS → step 8 falla por FCrDNS sin PTR → setear PTR manual → run#2 reusa). El comentario `contabo-adapter.ts:38-39` ("rDNS/PTR: panel-only, NO API") es **incorrecto/desactualizado**.

La API REST pública de Contabo (`api.contabo.com`, grupo DNS) expone PTR. Fuente canónica: el OpenAPI oficial del CLI `cntb` (`github.com/contabo/cntb/blob/main/openapi/api_dns.go` + `UpdatePtrRecordRequest.md`).

**Endpoint que necesitamos (editar PTR de una IPv4):**
```
PUT  https://api.contabo.com/v1/dns/ptrs/{ipAddress}
Authorization: Bearer <token OAuth2>        # MISMO token que ya usa el adapter
x-request-id: <uuid4>                        # OBLIGATORIO
Content-Type: application/json

{ "ptr": "smtp.<dominio>" }
```
- Operación `UpdatePtrRecord` ("Edit a PTR Record by ip address"). Body = un solo campo `ptr` (string requerido). La IP va en el path, no en el body.
- **IPv4: el PTR SIEMPRE existe** (default `vmiXXXX.contaboserver.net`) → solo se EDITA con PUT (mapea 1:1 al "lápiz" del panel). Idempotente: re-PUT del mismo hostname = 200/204, sin 404.
- Auth: **la misma OAuth2** (client_id + client_secret + email + password) que ya usa `ContaboAdapter`. No hace falta credencial nueva.
- Notas: Create/Delete de PTR son IPv6-only (no aplica a SMTP IPv4). cntb CLI y Terraform NO exponen rDNS (la REST API sí). No se puede setear el PTR al CREAR la instancia (el create no tiene campo ptr).

## Fix 1 — `ContaboAdapter.setReverseDns(ip, hostname)`
En `packages/adapters/src/contabo-adapter.ts`, agregar un método nuevo (additive, no toca create/list):
```ts
async setReverseDns(ip: string, hostname: string): Promise<{ ok: boolean; status: number; detail?: string }> {
  const res = await this.computeFetch(`/v1/dns/ptrs/${encodeURIComponent(ip)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ptr: hostname })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: `${res.statusText} | ${body.slice(0,300)}` };
  }
  return { ok: true, status: res.status };
}
```
- Reusa `computeFetch` (`:557`) → `ensureToken` (OAuth2) + el `x-request-id` que el adapter YA inyecta en cada request (`:561`, `randomUUID()` — confirmado contra `produ`; no agregar nada).
- Aplica los fixes de resiliencia del otro brief (retry/backoff en 401/429) a este método también.
- Actualizar el comentario `:38-39` (rDNS ahora ES automatizable por API).

## Fix 2 — Cablear en el step 8 (Contabo bind) ANTES del FCrDNS
En `apps/gateway-api/src/routes/webdock-bind-domain.ts`, `bindNonWebdockMainDomain` (`:486+`): hoy setea el hostname por SSH (`:570` `setHostnameViaSsh`), emite `oc.bind.contabo_manual_ptr_required` (`:607`), y luego verifica FCrDNS (`:626` `verifyFcrdnsWithRetry`, fallback `operatorAction` `:637`). Cambiar:
1. Tras setear el hostname por SSH, **llamar `adapter.setReverseDns(server.ipv4, identityDomain)`** (el adapter Contabo ya está disponible en este path). Auditar el resultado: `oc.bind.contabo_ptr_set` (ok) / `oc.bind.contabo_ptr_set_failed` (con status/detalle).
2. Reemplazar el `oc.bind.contabo_manual_ptr_required` (que pedía acción humana) por el set automático. Si el PUT falla, ahí sí surfacear como operatorAction (fallback manual), pero el camino feliz es 100% automático.
3. Dejar el FCrDNS verify/hybrid (PR#11) DESPUÉS — ahora valida la propagación del PTR que acabamos de setear, no espera acción humana.
- El step 8 pasa a ser: SSH set-hostname (root, PR#10) → **setReverseDns por API** → FCrDNS verify (bounded, PR#11) → done. **Un solo run, sin panel.**

## Resultado combinado (con los otros 2 briefs)
Con PTR-automático + FCrDNS-híbrido (PR#11, ya en produ) + resiliencia-token + sign-scope-fix, un SMTP Contabo NUEVO completa **en un solo run de punta a punta** (create → DNS IONOS → SSH bind → **PTR por API** → FCrDNS → Postfix → warmup → envío real → inbox), **sin ningún toque manual en el panel Contabo**. Esto es lo que destraba montar 3, 5, 100.

## DoD
- Un run sobre un dominio IONOS con VPS Contabo NUEVO completa los 14 steps SIN setear PTR a mano (el step 8 lo setea por `PUT /v1/dns/ptrs/{ip}`).
- `setReverseDns` es idempotente (re-PUT del mismo hostname no rompe) y reusa la OAuth2 + `x-request-id` existentes.
- Si el PUT falla (token/red), se surfacea como operatorAction (fallback manual), no como crash.
- Probar PRIMERO en 1 IP real (p.ej. re-setear el PTR ya existente de `217.216.91.100` → smtp.nationalbizrenewal.com): debe dar 200/204 e idempotente.
- Webdock byte-idéntico (su propio `setServerPtr` no se toca). `npm test` verde. Sin exponer secretos/token.

## Anclas
- `packages/adapters/src/contabo-adapter.ts:38-39` (comentario a corregir), `:557-567` (computeFetch — x-request-id YA inyectado via `randomUUID()` en `:561`, confirmado contra produ), `:498-551` (ensureToken OAuth2), `:470` (invalidateToken).
- `apps/gateway-api/src/routes/webdock-bind-domain.ts:486` (bindNonWebdockMainDomain), `:570` (SSH set-hostname), `:607` (emit manual-PTR a reemplazar), `:626` (FCrDNS verify, dejar después), `:637` (operatorAction fallback).
- Endpoint + modelo: `github.com/contabo/cntb/blob/main/openapi/api_dns.go`, `.../openapi/docs/UpdatePtrRecordRequest.md`.
