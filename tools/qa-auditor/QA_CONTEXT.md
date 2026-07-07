# Delivrix QA Senior - Contexto de proyecto y politica de auditoria

Este archivo es la MEMORIA CURADA del auditor: el worker lo lee de la rama base
del repo y lo inyecta como contexto CONFIABLE en cada subagente. Editalo para
ensenarle al auditor las convenciones del equipo, la procedencia de los datos y
la politica de severidad. Si este archivo no existe, el worker usa un default
embebido equivalente (src/context/qa-context.ts).

Reglas de edicion: ASCII puro, sin emojis (se inyecta como prompt). Manten cada
seccion corta y accionable.

## Procedencia de datos (clave para calibrar severidad)
- Las llaves DKIM (publica y privada) las genera el propio sistema server-side con node:crypto. La DKIM publica NO es input de un atacante: tratala como dato generado, no como vector de inyeccion.
- domain, smtpHost, serverIpv4, serverSlug, serverAccountId, providerId y selector vienen del pipeline interno de aprovisionamiento (Webdock/Contabo/Route53/IONOS) y de SmtpRunState. Son estado interno del sistema, no entrada de usuario.
- El admin-panel es una UI interna read-only; exponerle identificadores operativos internos es esperado, no una fuga de seguridad.
- En el MVP no hay SMTP/DNS/SSH/Proxmox reales: el sistema valida, simula y audita (dry-run). No asumas ejecucion real de efectos.

## Politica de severidad (obligatoria)
- BLOCKER: algo que NO debe llegar a produccion: secreto real expuesto, migracion destructiva o irreversible, rompe el build o los tests, o conflicto de merge real.
- HIGH: riesgo real y explotable que requiere un dato controlado por un EXTERNO mas evidencia concreta en el diff. Si el valor lo genera el sistema (ver procedencia) o el riesgo es teorico / defensa-en-profundidad, la severidad MAXIMA es medium.
- No emitas mas de un HIGH salvo que cada uno tenga input externo + evidencia fuerte. Ante la duda, baja la severidad.
- Inyeccion, ReDoS o DoS: solo HIGH si el dato lo controla un externo y el patron es realmente explotable. Sobre datos generados por el sistema o regex lineales, es low o no-finding.

## Patrones intencionales del repo (NO reportar como defecto)
- Tipos espejo "Wire" en apps/admin-panel que duplican los de packages/domain: es un patron deliberado (mirror domain/wire), no duplicacion accidental.
- Adaptadores en modo seguro/mock (dry-run) en packages/adapters: es la postura de norte del MVP, no codigo muerto.
- TypeScript erasable + ejecucion directa de .ts (type-stripping de Node 24) y test runner nativo node:test: es la convencion. No recomiendes paso de build/tsc ni frameworks de test externos.
- Sin emojis y ASCII puro en codigo, prompts y UI es regla dura del equipo.

## Estilo de hallazgos
- Reporta SOLO problemas accionables. Las observaciones positivas ("buen trabajo", "bien cubierto") van en el summary, NO como findings. No infles el conteo con elogios.
- Si dos dimensiones ven el mismo punto en el mismo archivo y lineas, basta UN hallazgo (el de mayor severidad).
- Cita evidencia que exista en el diff. No inventes lineas ni afirmes sobre codigo que no ves; si necesitas una definicion fuera del diff, dilo como suposicion, no como hecho.
