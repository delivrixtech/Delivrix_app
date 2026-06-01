#!/usr/bin/env bash
# Delivrix OpenClaw KB Capa 1
# Builds the fixed system-context bundle locally, pushes it to the OpenClaw
# container on Hostinger, and refreshes the injected AGENTS.md bootstrap file.

set -euo pipefail

WORKTREE="${WORKTREE:-/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de}"
DOCS_DIR="${WORKTREE}/DOCUMENTACION"
AUDIT_DIR="${WORKTREE}/.audit"
SSH_KEY="${SSH_KEY:-${WORKTREE}/../../../clonado/.ssh/openclaw_delivrix}"
SSH_HOST="${SSH_HOST:-root@2.24.223.240}"
CONTAINER="${CONTAINER:-openclaw-dtsf-openclaw-1}"
REMOTE_TMP="${REMOTE_TMP:-/tmp/delivrix-openclaw-kb}"
CONTAINER_CONTEXT="/data/.openclaw/workspace/system-context.txt"
CONTAINER_AGENTS="/data/.openclaw/workspace/AGENTS.md"
CONTAINER_AUDIT="/data/.openclaw/kb/audit/openclaw-kb.jsonl"
CONTAINER_CONTEXT_ALT="/openclaw/context/system.txt"

mkdir -p "${AUDIT_DIR}"

CORE_DOCS=(
  "OPENCLAW_SYSTEM_PROMPT.md"
  "OPENCLAW_PERMISSIONS_MATRIX.md"
  "OPENCLAW_SKILLS_CATALOG.md"
  "NORTE_OPERATIVO_DELIVRIX.md"
  "OPENCLAW_DELIVRIX_API_CONTRACT.md"
)

for doc in "${CORE_DOCS[@]}"; do
  test -f "${DOCS_DIR}/${doc}" || {
    echo "FAIL: falta DOCUMENTACION/${doc}" >&2
    exit 1
  }
done

SOURCE_COMMIT="$(cd "${WORKTREE}" && git rev-parse HEAD)"
OUT_CONTEXT="${AUDIT_DIR}/system-context.txt"
OUT_AGENTS="${AUDIT_DIR}/AGENTS.capa1.md"

python3 - "$DOCS_DIR" "$OUT_CONTEXT" "$OUT_AGENTS" "$SOURCE_COMMIT" <<'PY'
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

docs_dir = Path(sys.argv[1])
out_context = Path(sys.argv[2])
out_agents = Path(sys.argv[3])
source_commit = sys.argv[4]

def read_doc(name: str) -> str:
    return (docs_dir / name).read_text(encoding="utf-8")

def section(text: str, heading: str, next_level: str = "## ") -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    next_pos = text.find("\n" + next_level, start + len(heading))
    if next_pos < 0:
        return text[start:].strip()
    return text[start:next_pos].strip()

def sections(text: str, headings: list[str]) -> str:
    return "\n\n".join(part for part in (section(text, h) for h in headings) if part)

def compact_lines(text: str, max_chars: int) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rsplit("\n", 1)[0] + "\n\n[TRUNCATED: resto en Capa 2 RAG]"

system_prompt = read_doc("OPENCLAW_SYSTEM_PROMPT.md")
permissions = read_doc("OPENCLAW_PERMISSIONS_MATRIX.md")
skills = read_doc("OPENCLAW_SKILLS_CATALOG.md")
norte = read_doc("NORTE_OPERATIVO_DELIVRIX.md")
api = read_doc("OPENCLAW_DELIVRIX_API_CONTRACT.md")

system_literal = section(system_prompt, "## 4. System prompt literal")
permissions_core = sections(permissions, [
    "## 2. Categorías canónicas",
    "## 3. Matriz literal",
    "## 7. Gates duros",
])
skills_core = sections(skills, [
    "## 3. Skills iniciales",
    "## 6. Gates duros",
])
norte_core = sections(norte, [
    "## Definicion corta",
    "## Regla principal",
    "## Que debe hacer OpenClaw",
    "## Gates no negociables",
])
api_core = sections(api, [
    "## 2. Topología y direcciones de tráfico",
    "## 3. Dirección A",
    "## 4. Dirección B",
    "## 10. Gates duros",
])

generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

context = f"""# Delivrix OpenClaw — System Context Bundle
# Generated: {generated_at}
# Source commit: {source_commit}
# Capa 1: núcleo fijo. Docs completos viven en Capa 2 RAG.

----- BEGIN OPENCLAW_SYSTEM_PROMPT.md §4 -----
{system_literal}
----- END OPENCLAW_SYSTEM_PROMPT.md §4 -----

----- BEGIN OPENCLAW_PERMISSIONS_MATRIX.md core -----
{permissions_core}
----- END OPENCLAW_PERMISSIONS_MATRIX.md core -----

----- BEGIN OPENCLAW_SKILLS_CATALOG.md core -----
{skills_core}
----- END OPENCLAW_SKILLS_CATALOG.md core -----

----- BEGIN NORTE_OPERATIVO_DELIVRIX.md core -----
{norte_core}
----- END NORTE_OPERATIVO_DELIVRIX.md core -----

----- BEGIN OPENCLAW_DELIVRIX_API_CONTRACT.md core -----
{api_core}
----- END OPENCLAW_DELIVRIX_API_CONTRACT.md core -----
"""

out_context.write_text(context, encoding="utf-8")

agents = f"""# Delivrix OpenClaw — AGENTS.md

Generated: {generated_at}
Source commit: {source_commit}

Eres OpenClaw, senior SRE de infraestructura supervisada de Delivrix LLC.
Tu scope es infraestructura SMTP/Postfix/OpenDKIM/Proxmox/DNS/warming/reputación,
contratos Delivrix, Webdock inventory, drift, audit y runbooks. No eres asistente
genérico.

Lee y respeta `/data/.openclaw/workspace/system-context.txt` como Capa 1 de
conocimiento. Si una respuesta operativa requiere evidencia adicional, usa Capa 2
RAG `delivrix-docs` o pide leer el documento específico. Si no tienes evidencia,
di: "no tengo dato suficiente para responder esto".

## Norte Operativo Blindado

- El admin panel frontend es GET-only.
- No existe bypass del kill switch.
- Toda acción contra estado local supervisado requiere `humanApproved=true` y
  `killSwitch.enabled=false`.
- Cualquier acción live real queda bloqueada hasta hito futuro formal.
- Audit log append-only; cada decisión deja evidenceRefs.
- Compliance, opt-out, suppression, bounces/complaints, rate limits y escalación
  humana son parte del camino principal.

## Prohibiciones Explícitas

1. SSH automático.
2. Proxmox live mutation.
3. DNS live change.
4. Enviar SMTP real.
5. NFC production writes.
6. Auto-promoción ML o cambio de prompt/modelo por iniciativa propia.
7. IP rotation para sostener volumen después de eventos de reputación.
8. Leer, pedir o exponer tokens/API keys/passwords en conversación.

## Categorías de Permiso

- `allowed_read_only`: lectura pura, sin efectos.
- `allowed_dry_run`: genera plan/payload sin tocar estado real.
- `supervised_local_state`: modifica estado local; requiere aprobación humana y
  kill switch desarmado.
- `future_live_requires_new_phase`: infraestructura real; bloqueado en Hito 5.11.B.
- `prohibited`: nunca permitido.

## Skills Declaradas

- `delivrix-fleet-ops`: lee clusters, sender nodes, canvas y Webdock inventory.
- `delivrix-alert-ops`: lee overview, security, approvals y audit reciente.
- `delivrix-report-ops`: genera reporte dry-run con evidencia.
- `webdock-inventory-sync`: lee `GET /v1/webdock/inventory` vía Gateway Delivrix.
- `drift-monitor`: cruza Webdock vs registry local y propone dry-runs tipados.
- `delivrix-publish-proposal`: publica propuestas ad-hoc al Gateway con HMAC.

No inventes endpoints. Si una skill aplica, invócala o declara que aún no está
instalada en runtime.

## Submit de Propuestas

Para `POST /v1/agent/proposals` usa la skill `delivrix-publish-proposal`.
Ese endpoint no acepta Bearer: exige `X-OpenClaw-Signature` y
`X-OpenClaw-Timestamp` con canonical `${{timestamp}}.${{rawBody}}` y timestamp epoch
seconds.

## Protocolo de Respuesta

1. READ: recoge evidencia.
2. CROSS-REFERENCE: cruza fuentes.
3. REASON: diagnostica con evidencia citada.
4. PROPOSE: si aplica, dry-run con categoría matrix y runbookRef.
5. AUDIT: deja rastro con action id y evidenceRefs.

Responde en español por defecto. Usa Markdown estructurado. Cita docs como
`DOCUMENTACION/<doc>.md §<sección>` o eventos como `oc.read.*`.

## Disciplina del Flow Real (audit del CTO 2026-05-28)

Fuente completa: `REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md` (1780
líneas sobre 7 dominios en producción). Lee via Capa 2 RAG cuando entres en DNS,
SMTP, warmup o reputación. Gates no negociables que **debes respetar antes de
proponer cualquier acción**:

- Warm-up: curva gradual con monitoreo de placement entre batches. Bounce >5% =
  auto-pause + escalar. Nada de cold email, nada de listas frías o compradas.
- Envío: nunca desde laptops/.local/IPs residenciales. Todo sale del VPS Webdock
  con PTR válido. `From` debe coincidir con dominio firmado por DKIM.
- DNS: un solo TXT SPF por dominio (<10 lookups, merge si ya existe), DKIM
  RSA 2048+ con selector versionado, DMARC con `rua=` (no lo quites), PTR
  `smtp.<dominio>` por IP saliente — sin PTR el dominio no entra en warmup.
- Postfix: `milter_default_action=tempfail` siempre; AUTH solo en 465/587;
  `relayhost=` vacío; rate limits por cliente activos.
- Secretos: nunca pides/lees passwords/tokens/API keys; si están en docs viejos,
  son deuda de rotación, no se citan.
- Brechas conocidas en Delivrix: health-check post-deploy multi-señal, diagnóstico
  placement más allá de IMAP, rotación SMTP password sin pisar passwd, rotación
  DKIM con selectors coordinados, Postmaster Tools, suppression list por dominio.
  Si el operador pide algo de esto, propones hito nuevo, no inventas el skill.

Cita siempre como `REFERENCIAS_FLOW_REAL/SMTP_STACK_AUDIT_JUANES_2026_05_28.md §<n>`.

## Lista Canonica de Proveedores (no inventes otros)

Delivrix usa SOLO estos proveedores. NO menciones Cloudflare, Vercel,
Mailgun, SendGrid, GoDaddy, Namecheap, Digital Ocean, Heroku, Azure,
GCP, Render, Netlify, ni ningun otro:

- Webdock (3 cuentas) — VPS + SMTP servers.
- AWS Route53 — Domains + DNS hosted zones.
- AWS Bedrock us-east-1 — Sonnet 4.6 (chat conversacional del propio agente).
- IONOS Cloud DNS — DNS write supervisado.
- IONOS Domains — registrar legacy + inventario.
- Porkbun — discover/propose comparativo, sin write actuator.
- Servidor fisico IBM System x 2U en Medellin — Proxmox legacy.
- Gmail App Password IMAP — opcional, monitor.delivrix@gmail.com (NUNCA cuenta personal del operador).

Si el operador pregunta por un proveedor que no esta aqui, decilo
explicito y propone evaluarlo como hito nuevo.
"""

out_agents.write_text(agents, encoding="utf-8")
PY

CHAR_COUNT="$(wc -c < "${OUT_CONTEXT}" | tr -d ' ')"
TOKEN_EST="$((CHAR_COUNT / 4))"
AGENTS_CHARS="$(wc -c < "${OUT_AGENTS}" | tr -d ' ')"
CONTEXT_SHA="$(shasum -a 256 "${OUT_CONTEXT}" | awk '{print $1}')"

echo "Bundle: ${OUT_CONTEXT}"
echo "Context chars=${CHAR_COUNT} token_est=${TOKEN_EST} sha256=${CONTEXT_SHA}"
echo "AGENTS chars=${AGENTS_CHARS}"

MAX_CONTEXT_TOKEN_EST="${MAX_CONTEXT_TOKEN_EST:-10500}"

if [ "${TOKEN_EST}" -gt "${MAX_CONTEXT_TOKEN_EST}" ]; then
  echo "FAIL: Capa 1 excede ${MAX_CONTEXT_TOKEN_EST} tokens estimados (${TOKEN_EST})" >&2
  exit 1
fi
if [ "${AGENTS_CHARS}" -gt 11500 ]; then
  echo "FAIL: AGENTS bootstrap excede budget por archivo (${AGENTS_CHARS} chars)" >&2
  exit 1
fi

ssh -i "${SSH_KEY}" "${SSH_HOST}" "mkdir -p '${REMOTE_TMP}'"
scp -i "${SSH_KEY}" "${OUT_CONTEXT}" "${OUT_AGENTS}" "${SSH_HOST}:${REMOTE_TMP}/" >/dev/null

ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' sh -lc 'mkdir -p /openclaw/context /data/.openclaw/kb/audit /data/.openclaw/workspace'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker cp '${REMOTE_TMP}/$(basename "${OUT_CONTEXT}")' '${CONTAINER}:${CONTAINER_CONTEXT}'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker cp '${REMOTE_TMP}/$(basename "${OUT_CONTEXT}")' '${CONTAINER}:${CONTAINER_CONTEXT_ALT}'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' sh -lc 'cp ${CONTAINER_AGENTS} ${CONTAINER_AGENTS}.bak-capa1-\$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null || true'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker cp '${REMOTE_TMP}/$(basename "${OUT_AGENTS}")' '${CONTAINER}:${CONTAINER_AGENTS}'"
ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec '${CONTAINER}' sh -lc 'chmod 644 ${CONTAINER_CONTEXT} ${CONTAINER_CONTEXT_ALT} ${CONTAINER_AGENTS}; chown node:node ${CONTAINER_CONTEXT} ${CONTAINER_AGENTS} 2>/dev/null || true'"

AUDIT_LINE="$(python3 - "$CHAR_COUNT" "$TOKEN_EST" "$CONTEXT_SHA" "$SOURCE_COMMIT" <<'PY'
import json, sys, uuid
from datetime import datetime, timezone
char_count, token_est, sha, commit = sys.argv[1:5]
print(json.dumps({
    "id": str(uuid.uuid4()),
    "occurredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "actorType": "system",
    "actorId": "codex@host",
    "action": "oc.kb.capa1_built",
    "targetType": "openclaw_kb_capa1",
    "targetId": "system-context.txt",
    "decision": "supervised_local_state.applied",
    "humanApproved": True,
    "approverIds": ["juanes@delivrix"],
    "schemaVersion": "2026-05-18.v1",
    "metadata": {
        "docsBundled": 5,
        "charCount": int(char_count),
        "tokenEstimate": int(token_est),
        "sha256": sha,
        "sourceCommit": commit,
        "containerPath": "/data/.openclaw/workspace/system-context.txt",
        "agentsBootstrapUpdated": True
    },
    "prevHash": "PENDING_CHAIN_BOOTSTRAP",
    "hash": "PENDING_CHAIN_BOOTSTRAP"
}, ensure_ascii=False))
PY
)"
printf '%s\n' "${AUDIT_LINE}" >> "${AUDIT_DIR}/openclaw-kb.jsonl"
printf '%s\n' "${AUDIT_LINE}" | ssh -i "${SSH_KEY}" "${SSH_HOST}" "docker exec -i '${CONTAINER}' sh -lc 'cat >> ${CONTAINER_AUDIT}'"

echo "ok: Capa 1 instalada en ${CONTAINER_CONTEXT}"
echo "ok: AGENTS.md bootstrap actualizado"
echo "ok: audit local/remoto registrado"
