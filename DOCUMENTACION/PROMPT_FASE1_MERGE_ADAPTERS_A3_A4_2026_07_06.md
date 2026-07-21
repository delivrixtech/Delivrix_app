# Brief — Fase 1: consolidar y mergear adapters A3 (Proxmox) + A4 (Contabo)

> Prompt accionable para el agente de desarrollo (VS Code / bash). Pegar y ejecutar por fases.
> Fecha: 2026-07-06 · Sprint: Own the Rails · Track A · Fase 1 del orden de construccion.
> Hito objetivo: **OpenClaw crea 1 SMTP en Cool (Proxmox) con run firmado**, provider "proxmox" explicito.

---

## 0. Objetivo

Cerrar los rieles sobre infra propia: los dos adapters ya existen en rama, falta **consolidarlos,
volverlos provider-aware de punta a punta, pasar el E2E y mergear a produ**. No se construye de cero.

Este NO re-especifica A3: ya existe `DOCUMENTACION/BRIEF_CODEX_A3_PROXMOX_ADAPTER_2026_06_29.md`.
Leerlo primero. Este brief se enfoca en **consolidar + mergear A3 y A4**.

---

## 1. Ground truth (LEER antes de tocar; no adivinar)

Regla: no mutar `main`/`produ`. Leer otras ramas con `git show <rama>:<ruta>`, nunca checkout sobre el
working tree compartido.

Interfaz y patron de referencia:
- `packages/adapters/src/vps-provider.ts` — `VpsProvider` (interface), `VpsProviderEntry`. Contrato comun.
- `packages/adapters/src/contabo-adapter.ts` — `ContaboAdapter implements VpsProvider`, `createContaboAdaptersFromEnv(...)`. **Patron a espejar** para Proxmox.

Proxmox (A3):
- `packages/adapters/src/proxmox-adapter.ts` — `ProxmoxAdapter` (mock).
- `packages/adapters/src/proxmox-real-adapter.ts` — impl real.
- Rama actual: `codex/a3-proxmox-adapter` (HEAD). Tiene cambios sin commitear (`git status`: `.audit/...`, `CHECKLIST_...md`, `admin-panel/vite.config.ts`) y hubo un stash obsoleto (`a3-wip-obsoleto-duplicado-produ`). Limpiar antes de consolidar.

Contabo (A4) — repartido en varias ramas, consolidar en un solo estado:
- `feature/contabo-provider`, `codex/contabo-ssh-provider-aware`, `codex/contabo-ptr-api`, `feat/contabo-run-robustez`.

Puntos de wiring provider-aware (verificar los 5): `packages/adapters/src/index.ts`,
`apps/gateway-api/src/openclaw-tools-builder.ts`, `apps/gateway-api/src/server-running-wait.ts`,
`apps/gateway-api/src/skill-schemas.ts`, `apps/gateway-api/src/main.ts`.

---

## 2. Alcance — que hacer

### T1. Consolidar A3 (Proxmox)
- Limpiar la rama `codex/a3-proxmox-adapter` (commitear/descartar lo pendiente con criterio; descartar el WIP obsoleto).
- `proxmox-real-adapter.ts` debe `implements VpsProvider` con la misma superficie que `ContaboAdapter` (mismos metodos/errores tipados). Factory `createProxmoxAdaptersFromEnv(...)` al estilo Contabo.
- El registro de providers debe poder seleccionar `"proxmox"` explicito (multi-host).

### T2. Consolidar A4 (Contabo)
- Unificar las 4 ramas Contabo en un solo estado coherente: PTR API + SSH provider-aware + run-robustez sobre `feature/contabo-provider`.
- Todos los pasos del flujo (provision -> install -> DNS/PTR -> smoke) deben ser **provider-aware**: el provider viaja explicito en el run, nunca se asume ni se cae a un VPS accidental.

### T3. E2E en Cool
- Correr `configure_complete_smtp` (u orquestador) con provider `"proxmox"` contra el bestion Cool.
- Resultado: 1 SMTP creado en Cool, run firmado, DKIM/PTR OK, smoke a inbox. Provider explicito respetado end-to-end.

### T4. Merge + deploy
- PR con reporte del QA Auditor; CI (typecheck + suite) verde.
- Merge a `produ`; deploy local + Hostinger juntos; `build-system-context.sh` si toca el prompt.

---

## 3. Guardrails (obligatorios)

- Provider **siempre explicito** (reusar guard anti-VPS-accidental y reuse-hostname scoped que ya existen).
- Run firmado + audit + kill-switch en toda escritura.
- No mezclar el working tree de ramas ajenas; leer con `git show`.

## 4. Definition of Done

- `proxmox-real-adapter` implements `VpsProvider` (paridad con Contabo); factory-from-env.
- Contabo consolidado y provider-aware en los 5 puntos; sin ramas huerfanas divergentes.
- E2E OK: 1 SMTP en Cool con provider "proxmox", run firmado, smoke a inbox.
- Tests verdes (unit adapters + E2E). PR + QA Auditor. Mergeado a produ + desplegado.
- Sin emojis en codigo (ASCII: OK/FALLO/->).

## 5. Primeros pasos

1. Leer `BRIEF_CODEX_A3_PROXMOX_ADAPTER_2026_06_29.md`, `vps-provider.ts` y `contabo-adapter.ts`.
2. `git status` en `codex/a3-proxmox-adapter`; limpiar WIP; consolidar A3 (T1).
3. `git show` de las 4 ramas Contabo; consolidar A4 (T2).
4. E2E en Cool (T3) -> PR + merge + deploy (T4).

## 6. Dependencia dura

- T3 (E2E en Cool) **requiere** que Fase 0 este lista: Proxmox instalado + template LXC + IPs/PTR en el bestion Cool (ver `CHECKLIST_FASE0_INFRA_FISICA_JUANES_2026_07_06.md`). Hasta entonces, T1/T2 (codigo + tests con mock/host de prueba) avanzan igual; solo el E2E real espera al hardware.
