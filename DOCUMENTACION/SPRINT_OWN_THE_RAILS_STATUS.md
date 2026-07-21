# SPRINT Own the Rails — STATUS (living document)

> Documento vivo. Acá se marca el progreso real, día a día. Lo abrís y actualizás cada día.
> Plan completo: `ROADMAP_OWN_THE_RAILS_DELIVRIX_2026_06_26.md`.

**Sprint:** 2026-06-26 (vie) → 2026-07-02 (jue) · 6 días
**North Star:** OpenClaw crea SMTPs 100% automáticos en infra propia (Cool) + sistema en producción bajo dominio propio.
**Última actualización:** 2026-06-26

---

## Tracks — progreso

| Track | Avance | Estado |
|---|---|---|
| A · Rieles propios (Cool/Proxmox/adapter) | 0/6 | Plan + brief listos; falta comprar IPs + montar |
| E · Cerebro IA local (Mac Studio M4 Max, Miami) | 0/4 | Mac Studio llegó; configurar remoto (inferencia local) |
| W · Warmup con IA (sobre infra propia) | 0/7 | Diseño cerrado (WARMUP_IA_DELIVRIX); Delivrix ya tiene piezas, desconectadas |
| B · Limpieza y sender pool real | 0/4 | Pendiente (resetear dominios AWS) |
| S · API de envío + entrega responsable (el SES propio) | 0/5 | Reemplaza el "motor de campañas"; S3 (compliance) es de sprint |
| D · Plataforma y deploy | 0/6 | Runbook escrito, no ejecutado |
| T · Transversal QA/CI | 0/3 | QA Auditor construido, sin mergear |

> **RE-SCOPE 2026-06-26:** Delivrix = los **rieles** (el SES propio). La app (campañas, leads, tracking, multi-tenant, front de outreach) la hace **otro SaaS** de la empresa — fuera del roadmap de Delivrix. El panel de infra se queda y se pule.
> Detalle accionable por tarea (DoD + responsable): `ROADMAP_OWN_THE_RAILS_DELIVRIX_2026_06_26.md` (sección 3) y `CHECKLIST_EJECUCION_OWN_THE_RAILS.md`.

---

## Lo logrado (2026-06-26)
- Auditoría completa del estado actual (10 frentes gap + 6 complementarios = 16): rieles sí, app no. Gap mapeado.
- Análisis de Instantly (campañas, warmup, unibox, copilot, leads, UX) para replicar.
- Auditoría complementaria cerrada: deploy/DevOps (control plane local, runbook escrito sin ejecutar), QA (núcleo bien testeado, QA Auditor sin mergear, Proxmox = stub), front (decisión HÍBRIDO), costos (~$1.000–1.050/mes), compliance (one-click unsub + suppression enforcement = requisito duro), escala (backend NO aguanta volumen sin cola+workers).
- Documentos: roadmap + status + CHECKLIST de ejecución (tareas con DoD).
- Briefs de infra listos: adapter Proxmox, plan de división del bestión, plan de reseteo de dominios.
- Verificado: puerto 25 abierto, IP base Cool limpia (0/60), dimensionamiento /26 + LXC.

---

## Lo inmediato (próximas 48h — vie/sáb)
- [ ] Comprar el bloque /26 (62 IPs) en Hivelocity. — **Juanes**
- [ ] Resetear dominios huérfanos de AWS (filing-ops, corpfiling-ops) reusándolos. — Juanes + OpenClaw
- [ ] Instalar Proxmox en el bestión + template LXC (Postfix+DKIM+DMARC). — Juanes (con guía)
- [ ] Definir el dominio propio del sistema/panel. — Juanes
- [ ] Pasar el brief del adapter Proxmox al desarrollo backend. — Juanes

---

## Bloqueos
- Esperando: asignación del /26 por Hivelocity (en compra).
- Esperando: acceso SSH al bestión / Proxmox instalado para arrancar la configuración guiada.
- Postgres/Redis local apagados → memoria episódica 503; levantar el lunes para multi-tenant.

---

## Tareas de Juanes (transversales, toda la semana)
- Comprar /26 + confirmar servidor.
- Configurar Proxmox (guiado) o dar acceso.
- PTR/rDNS manual por IP en panel Hivelocity.
- Firmar los planes que gastan (aprobaciones OpenClaw).
- Pasar briefs al desarrollo.
- Verificar IPs en blacklist antes de cargar volumen.
- Decidir dominio propio del sistema.

---

## Próximo (post-sprint)
- **Otro SaaS (NO Delivrix):** la app de outreach — campañas, secuencias, leads, unibox de prospección, copilot de ventas, tracking de engagement, multi-tenant comercial, front. Se integra a Delivrix vía la API de envío.
- **Fase futura de Delivrix:** API de envío completa a escala (Track S salvo S3), warmup avanzado (W5 seed-list multi-ESP + Postmaster/SNDS, W6 recíproco acotado, W7 health-score UI), 2º bestión (add-node), imagen de producción.
- **Tesis completa (lejana):** ASN/BGP/BYOIP, ~4500 dominios, 2× Dell, office FL, meta ene-2027.
- Onboarding 2º bestión: ver sección 9 del roadmap (evento add-node, multi-host).
