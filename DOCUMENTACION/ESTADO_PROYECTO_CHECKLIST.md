# Estado del Proyecto — Checklist Delivrix

Documento vivo. Espejo versionado de la base en Notion (fuente de verdad):
https://app.notion.com/p/744ede0ef667490095b9735afa38d266
Última actualización: 2026-07-06 · Mantenido con Claude (PM).

Leyenda: `[x]` Hecho · `[~]` En curso · `[ ]` Pendiente.

## SMTP & Proveedores

- [x] Contabo conectado e integrado como 2.º proveedor VPS — API verificada + provider build + en inventario; reconocido por OpenClaw.
- [x] Webdock multi-cuenta (5 cuentas reales) cableado — cuenta madre dedupeada; ~28 SMTPs auditados (IPs limpias en 4 DNSBL).
- [x] Inventario multi-proveedor en backend (buildContaboProvider + dedupe + itemTotal) — commit f13ad93 en origin/produ.
- [x] configure_complete_smtp E2E (9 pasos) operativo — dominio fresco en ~1-3h; naming smtp.<dominio>.
- [~] Plan multi-provider 5.12 (Webdock + AWS + IONOS + Porkbun + Contabo) — diversificación de ASN.
- [ ] E2E real de Contabo (comprar 1 VPS y provisionar) — ~EUR 4.50, PTR manual; valida supuestos live.
- [ ] P0 backend: no servir servidores mock en 401 — brief listo (PROMPT_CODEX_INFRA_P0_MOCK_401).
- [~] Reforzar multicuenta / multi-proveedor — hueco: write-path single-account hardcoded -> registry + VpsProvider por cuenta; write-keys per-account. (nuevo 2026-07-06)

## Admin Panel / Infraestructura

- [x] Sección Infraestructura: reorg estructural — grupos por marca, en-cola plegado, drill-down real, conteos honestos. Verificado en vivo. Commits f13ad93 + ad91b87.
- [x] Quick wins anti-confusión — conteo mock suprimido, KPIs honestos (recursos reales), rol repetido eliminado.
- [x] Rebrand B/N del panel — Montserrat + JetBrains Mono; dark theme; estética Linear/Stripe.
- [ ] Eliminar legacy `features/infrastructure/index.tsx` (código muerto, no ruteado).
- [ ] Polish estructural restante — cablear remediación real, separar IA de cómputo, etc.

## OpenClaw / Agente

- [x] OpenClaw en Bedrock (Sonnet 4.6) operativo + grounding — se abstiene de alucinar; vive en Hostinger vía bridge Bedrock.
- [x] Auto-reload del system prompt por mtime — ya no requiere restart (commit 3013fff).
- [x] Contabo reconocido por OpenClaw (prompt + lista canónica) — deployado a Hostinger.
- [~] Memoria grounded que se alimente del trabajo de dev — hueco conocido (el agente no aprende del repo/docs solo).
- [ ] Bridge Hostinger HTML/login del chat — contrato Delivrix no implementado en la imagen del contenedor.

## Memoria / Grounding

- [x] ADR memoria 2-planos RAG-gated — Mastra à la carte (Workflows+RAG) + gobierno propio; local Mac Mini.
- [ ] Remediar pgvector dead code + hueco auth `/scratch` + TTL — auditado; plan de 5 fases en DOCUMENTACION.

## Dominio & Deploy

- [x] Todo el trabajo de infra commiteado a origin/produ — f13ad93 (inventario + reorg) + ad91b87 (proxy server.mjs).
- [x] Regla operativa: deploy local + Hostinger juntos — verificar contra endpoint vivo, no solo build/tests.
- [~] Dominio producción app.delivrix.com — definir ownership de delivrix.com + host destino + hardening del control plane (auth/SSO/allowlist). GoDaddy sería solo DNS.
- [ ] Integrar Namecheap como registrar (adquisición de dominios) — discover + propose + purchase gated con firma, patrón multi-provider (junto a Route53/Porkbun). (nuevo 2026-07-06)
- [~] Ampliar límite de dominios AWS Route53 a 60 — solicitado (caso soporte #178284055000186, 30-jun); pendiente aprobación de AWS. (nuevo 2026-07-06)

## Infra propia

- [x] Informe infra propia 200-300 SMTPs (veredicto) — tesis viable: 3-4 ASN diversificados; 2U solo control plane, nunca sending.
- [~] Plan lab montaje 100 SMTPs (Popayán, metal-first) — rack x3630 M4 prod + Mac Mini dev + MikroTik con IPs de Phoenix.
- [ ] No encender 200-300 SMTPs de golpe (anti-snowshoe) — crecer gradual; SES gana a costo puro <40-60M/mes.
