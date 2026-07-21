# BRIEF CODEX — Contabo en la lista canónica del prompt de OpenClaw + correcciones

Fecha: 2026-06-16 · Solicita: Juanes (CTO) · Ejecuta: Codex (infra/DevOps)
Rama base verificada: `produ` HEAD `e7af5e7`

---

## 1. Contexto (por qué)

OpenClaw, al preguntarle si Contabo está conectado, respondió "no hay evidencia de Contabo". **No es un bug del agente: obedeció su prompt.** La sección `[11] LISTA CANÓNICA DE PROVEEDORES` del system prompt no lista Contabo y dice textual "NO inventes proveedores fuera de esta lista".

El backend (gateway) **YA tiene Contabo**: merge en `produ` (`3c9e80c` + `4c45c0e` + fix `e7af5e7`) y el registry se arma desde las 4 creds `CONTABO_*` (presentes en `.env.local` y `config/gateway.env`). Lo que faltó es el **prompt del agente**, que es un cambio de agente y por eso va a Hostinger.

Aclaración de alcance: NO se toca `grounded/verified_facts` ni la memoria episódica. Que se abstengan es correcto por diseño (no hay servidores Contabo vivos todavía) y se resuelve solo cuando se corra el E2E.

## 2. Objetivo — 3 entregables

1. **T1 (prompt):** editar `[11]` en `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md`: añadir Contabo y corregir el conteo de cuentas Webdock (hoy dice "3", desactualizado).
2. **T2 (deploy):** pushear el system-context a Hostinger con `scripts/openclaw/build-system-context.sh` (dry-run primero, revisar, luego push real).
3. **T3 (backup):** `git push` de `produ` a `origin` (22 commits locales sin respaldo remoto).

## 3. Anclas verificadas (2026-06-16, rama `produ`)

- **Archivo a editar:** `DOCUMENTACION/OPENCLAW_SYSTEM_PROMPT.md`, sección `[11]` (línea ~180).
- **Script de push:** `scripts/openclaw/build-system-context.sh`. Por defecto pushea por SSH al container (`SSH_HOST=root@2.24.223.240`, `CONTAINER=openclaw-dtsf-openclaw-1`, destino `/data/.openclaw/workspace/system-context.txt` + alt `/openclaw/context/system.txt`). Con `OPENCLAW_CONTEXT_LOCAL_ONLY=true` solo regenera local (`.audit/system-context.txt`) sin mutación remota. La key SSH vive en `clonado/.ssh/openclaw_delivrix`.
- **Registry backend (solo referencia, NO tocar):** `packages/adapters/src/contabo-adapter.ts::createContaboAdaptersFromEnv` registra `"contabo"` con `CONTABO_CLIENT_ID/SECRET/API_USER/API_PASSWORD`.
- **Estado remoto:** `produ` está 22 commits adelante de `origin/produ` (sin push).

## 4. T1 — Cambios exactos en la sección [11]

Texto actual (primera línea de la lista):
```
- Webdock (3 cuentas) — VPS + SMTP servers.
```

**Cambio A — conteo Webdock.** Reemplazar `3` por el número real de cuentas conectadas. Valor auditado: **5 cuentas distintas** (2026-06-10: serviciosinfradev/madre, pep.prz001, Host Latam, emael, InfraVPS). VERIFICAR contra la fuente viva antes de escribir (`read_webdock_inventory` / el registry `createWebdockAdaptersFromEnv`); si el "3" original se refería a write-capable, ajustar la redacción en vez del número a ciegas. No adivinar.

**Cambio B — añadir Contabo.** Insertar esta línea inmediatamente después de la de Webdock:
```
- Contabo — 2do proveedor VPS/SMTP (cuenta propia). Conectado e integrado
  (API verificada + cableado en produ). Seleccionable con vpsProviderId:"contabo".
  SEMI-autónomo: el PTR/rDNS se setea a mano en el panel Contabo (el flujo lo
  pide y el FCrDNS gatea). 0 servidores provisionados aún: sin inventario vivo
  hasta el primer E2E; NO afirmes servers/dominios Contabo que el inventario
  vivo no muestre.
```

Caveat de redacción: "Host Latam" también es el label de UNA cuenta Webdock; no lo uses para describir Contabo, para no confundir al agente. Etiqueta Contabo como "Contabo".

## 5. Procedimiento

```
# a. Dry-run local (sin tocar Hostinger)
OPENCLAW_CONTEXT_LOCAL_ONLY=true bash scripts/openclaw/build-system-context.sh
#    -> revisar .audit/system-context.txt: que [11] traiga Contabo y el conteo
#       correcto, y que pase los guards de budget (tokens/chars) sin FAIL.

# b. Push real a Hostinger (requiere la key SSH + acceso a root@2.24.223.240)
bash scripts/openclaw/build-system-context.sh

# c. Backup de produ (T3)
git push origin produ
```

## 6. Definition of Done (verificable, sin adivinar)

- `.audit/system-context.txt` contiene "Contabo" dentro de la sección `[11]` y el conteo Webdock corregido.
- En el container: `ssh -i clonado/.ssh/openclaw_delivrix root@2.24.223.240 "docker exec openclaw-dtsf-openclaw-1 grep -c Contabo /data/.openclaw/workspace/system-context.txt"` devuelve `>= 1`.
- Nueva línea de audit `oc.kb.capa1_built` en `.audit/openclaw-kb.jsonl` (local) y replicada en el container.
- **Prueba de aceptación:** preguntarle a OpenClaw "¿Contabo está conectado?" y confirmar que ya lo reconoce como proveedor — y que sigue reportando 0 servers vivos (eso es correcto, no un fallo).
- `git rev-list --count origin/produ..produ` = `0` tras el push.

## 7. Fuera de alcance (NO hacer)

- NO escribir en `grounded/verified_facts` ni en la memoria episódica.
- NO correr el E2E real (compra de VPS Contabo): cuesta dinero (~EUR 4.50) y requiere PTR manual; es decisión aparte de Juanes.
- NO modificar código del gateway/adapters (ya está en `produ`).
- NO tocar nada del camino Webdock salvo el número en el texto de `[11]` (invariante byte-idéntico).

## 8. Riesgos / notas

- El script falla si el contexto excede `MAX_CONTEXT_TOKEN_EST`. Las líneas añadidas son pocas; debería pasar. Si falla por budget, compactar la sección, no recortar el sentido de la línea Contabo.
- Confirmar el número de cuentas Webdock contra la fuente viva antes de escribirlo.
- El push a Hostinger es un cambio de estado del agente en producción: hacerlo con el dry-run revisado primero.

Referencias: `DOCUMENTACION/PROMPT_CODEX_CONTABO_PROVIDER_2026_06_11.md` (build), `DOCUMENTACION/RUNBOOK_CODEX_MERGE_DEPLOY_CONTABO_2026_06_11.md` (merge+deploy gateway).
