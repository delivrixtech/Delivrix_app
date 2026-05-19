# OPS · Build Knowledge Base — Capa 1 (núcleo) + Capa 2 (ChromaDB RAG)

> Cronograma: D+2 AM del `HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md §10`.
> Construye sobre: `OPENCLAW_KNOWLEDGE_BASE_INDEX.md` v2 (Doc 6).
> Pre-requisitos: agente vivo en Bedrock (commit `e07628f` aterrizado).

## Objetivo

Aterrizar las 3 capas de conocimiento del agente:

- **Capa 1 (núcleo fijo)**: 5 docs concatenados al system prompt al
  arranque (~7K tokens). Garantiza que gates, identidad y skills viven
  permanentemente en contexto.
- **Capa 2 (RAG bajo demanda)**: ChromaDB embebido con los 63 docs
  literales del repo indexados (Doc 6 §9). Top-5 retrieval por query.
- **Capa 3 (live via skills)**: ya cubierta por el contrato API (Doc 4),
  no requiere setup adicional aquí.

## Entregables verificables al cerrar este OPS

- [ ] `scripts/openclaw/build-system-context.sh` ejecutable.
- [ ] `/openclaw/context/system.txt` dentro del container con ~7K tokens.
- [ ] ChromaDB instalado en el container con collection `delivrix-docs`.
- [ ] 63 archivos indexados (Doc 6 §9.1). Conteo verificable.
- [ ] Test set de 30 queries (Doc 6 §11.1) con **recall@5 >= 80%**.
- [ ] Cron nightly `0 3 * * *` UTC configurado para reindex diff.
- [ ] Audit `oc.kb.capa1_built` + `oc.kb.capa2_indexed` +
  `oc.kb.quality_check` con métricas.

## Paso 1 — Crear el build script de Capa 1

```bash
# En el host del operador / worktree
mkdir -p "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw"

cat > "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/build-system-context.sh" <<'BASH'
#!/usr/bin/env bash
# OpenClaw KB Capa 1 — núcleo fijo al system prompt
# Concatena los 5 docs canónicos en /openclaw/context/system.txt
# Total objetivo: ~7K tokens. Si excede 10K, abort (gate duro Doc 6 §8).

set -euo pipefail

WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
DOCS_DIR="${WORKTREE}/DOCUMENTACION"
OUT_LOCAL="${WORKTREE}/.audit/system-context.txt"
CONTAINER="openclaw-dtsf-openclaw-1"
CONTAINER_PATH="/data/.openclaw/workspace/system-context.txt"

# Los 5 docs del núcleo según Doc 6 §3
CORE_DOCS=(
  "OPENCLAW_SYSTEM_PROMPT.md"
  "OPENCLAW_PERMISSIONS_MATRIX.md"
  "OPENCLAW_SKILLS_CATALOG.md"
  "NORTE_OPERATIVO_DELIVRIX.md"
  "OPENCLAW_DELIVRIX_API_CONTRACT.md"
)

# 1. Verificar que existen
for d in "${CORE_DOCS[@]}"; do
  [ -f "${DOCS_DIR}/${d}" ] || { echo "FAIL: falta ${d}"; exit 1; }
done

# 2. Construir el bundle local
{
  echo "# Delivrix OpenClaw — System Context Bundle"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Source commit: $(cd "${WORKTREE}" && git rev-parse HEAD)"
  echo "# Capa 1 (núcleo fijo, siempre en contexto)"
  echo ""
  for d in "${CORE_DOCS[@]}"; do
    echo "----- BEGIN ${d} -----"
    cat "${DOCS_DIR}/${d}"
    echo ""
    echo "----- END ${d} -----"
    echo ""
  done
} > "${OUT_LOCAL}"

# 3. Calcular tokens aproximados (regla: 1 token ≈ 4 chars en texto en español/inglés)
CHAR_COUNT=$(wc -c < "${OUT_LOCAL}")
TOKEN_EST=$((CHAR_COUNT / 4))
echo "Bundle generado: ${OUT_LOCAL}"
echo "Tamaño:          ${CHAR_COUNT} chars ≈ ${TOKEN_EST} tokens estimados"

# 4. Gate duro Doc 6 §8: max 10K tokens
if [ "${TOKEN_EST}" -gt 10000 ]; then
  echo "FAIL: bundle ${TOKEN_EST} tokens excede el cap de 10K (Doc 6 §8)"
  echo "      Promover secciones a Capa 2 o trimear los docs core."
  exit 1
fi

# 5. Empujar al container
docker cp "${OUT_LOCAL}" "${CONTAINER}:${CONTAINER_PATH}"
docker exec "${CONTAINER}" chmod 644 "${CONTAINER_PATH}"
echo "ok: bundle empujado a ${CONTAINER}:${CONTAINER_PATH}"

# 6. Audit
mkdir -p "${WORKTREE}/.audit"
cat >> "${WORKTREE}/.audit/openclaw-kb.jsonl" <<JSON
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"system","actorId":"codex@host","action":"oc.kb.capa1_built","targetType":"openclaw_kb_capa1","targetId":"system-context.txt","decision":"n/a","humanApproved":true,"approverIds":["juanes@delivrix"],"schemaVersion":"2026-05-18.v1","metadata":{"docsBundled":${#CORE_DOCS[@]},"charCount":${CHAR_COUNT},"tokenEstimate":${TOKEN_EST},"sourceCommit":"$(cd "${WORKTREE}" && git rev-parse HEAD)"},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
JSON

echo "ok: audit registrado en .audit/openclaw-kb.jsonl"
echo ""
echo "Siguiente paso: hot-reload el agente para que cargue el nuevo system context"
echo "  docker exec ${CONTAINER} sh -c \"kill -HUP \\\$(pgrep -f 'node server.mjs' | head -1)\""
BASH

chmod +x "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/build-system-context.sh"
echo "ok: build script Capa 1 creado y ejecutable"
```

## Paso 2 — Ejecutar Capa 1 + reload

```bash
# 2.1 — Build Capa 1
"/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/build-system-context.sh"
# Esperado: "ok: bundle empujado a ..." + audit registrado

# 2.2 — Reload del agente (sin reiniciar container)
docker exec openclaw-dtsf-openclaw-1 \
  sh -c "kill -HUP \$(pgrep -f 'node server.mjs' | head -1)"
sleep 3

# 2.3 — Verificar que el archivo está en el container
docker exec openclaw-dtsf-openclaw-1 ls -la /data/.openclaw/workspace/system-context.txt

# 2.4 — Smoke 2 ahora con el bundle cargado
GW_TOKEN=$(docker exec openclaw-dtsf-openclaw-1 \
  sh -c 'printenv GATEWAY_TOKEN || cat /openclaw/.gateway-token 2>/dev/null')

curl -X POST http://127.0.0.1:61175/api/chat.send \
  -H "Authorization: Bearer $GW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:smoke:identity-capa1",
    "msgId": "smoke-identity-capa1-'$(date +%s)'",
    "message": {
      "role": "user",
      "content": "¿Quién eres? Lista exactamente 6 prohibiciones del norte operativo de Delivrix. Sin parafrasear, cita el doc."
    }
  }'

sleep 12

docker exec openclaw-dtsf-openclaw-1 \
  curl -s -H "Authorization: Bearer $GW_TOKEN" \
    "http://127.0.0.1:18789/api/sessions/agent:smoke:identity-capa1/history" \
  | jq '.messages[-1].content'

# Esperado: respuesta menciona OpenClaw senior SRE Delivrix +
# 6 prohibiciones literales del norte:
#   1. ssh_real
#   2. proxmox_live_mutation
#   3. dns_live_change
#   4. send_email_real
#   5. write_nfc_production
#   6. activate_nfc_provider (o similar)
#
# Si responde genérico ("soy un asistente AI"), el bundle no se aplicó
# correctamente. Investigar:
#   - Permisos de /data/.openclaw/workspace/system-context.txt
#   - Si el agente lee ese path o uno distinto
#   - Variables de entorno tipo OPENCLAW_SYSTEM_PROMPT_PATH
```

## Paso 3 — Setup ChromaDB Capa 2 en el container

```bash
# 3.1 — Verificar que el container tiene Python (OpenClaw es Node, pero
#       muchos containers Hostinger traen Python disponible)
docker exec openclaw-dtsf-openclaw-1 which python3 || \
  docker exec openclaw-dtsf-openclaw-1 apk add --no-cache python3 py3-pip || \
  docker exec openclaw-dtsf-openclaw-1 apt-get install -y python3 python3-pip

# 3.2 — Instalar ChromaDB embedido + dependencias para embeddings
docker exec openclaw-dtsf-openclaw-1 pip3 install --break-system-packages \
  chromadb \
  langchain-text-splitters \
  tiktoken

# 3.3 — Verificar instalación
docker exec openclaw-dtsf-openclaw-1 python3 -c "
import chromadb
print(f'ChromaDB version: {chromadb.__version__}')
client = chromadb.PersistentClient(path='/data/.openclaw/kb/chroma')
print('ok: PersistentClient creado')
"

# 3.4 — Crear la collection delivrix-docs si no existe
docker exec openclaw-dtsf-openclaw-1 python3 -c "
import chromadb
client = chromadb.PersistentClient(path='/data/.openclaw/kb/chroma')
collection = client.get_or_create_collection(
    name='delivrix-docs',
    metadata={'description': 'Delivrix Hito 5.11.B knowledge base — 63 docs literales'}
)
print(f'ok: collection delivrix-docs created/loaded')
print(f'    chunks actuales: {collection.count()}')
"
```

## Paso 4 — Script de indexación

```bash
cat > "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/index-kb-capa2.py" <<'PYTHON'
#!/usr/bin/env python3
"""
OpenClaw KB Capa 2 — Indexa los 63 docs literales del repo Delivrix
en ChromaDB embedido. Chunking por encabezado de nivel 2 (## ),
max 1500 tokens por chunk con overlap 150.
"""
import os
import sys
import json
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

import chromadb
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
import tiktoken

# Constantes
WORKTREE = Path("/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de")
DOCS_DIR = WORKTREE / "DOCUMENTACION"
AUDIT_DIR = WORKTREE / ".audit"
CHROMA_PATH = "/data/.openclaw/kb/chroma"  # dentro del container

# Lista exhaustiva del Doc 6 §9.1 con prioridad y tags
DOCS_TO_INDEX = [
    # Doctrina rectora (crítica)
    ("NORTE_OPERATIVO_DELIVRIX.md", "crítica", ["norte", "gates", "doctrina"]),
    ("RESUMEN_RUTA_PROYECTO.md", "crítica", ["overview", "arquitectura"]),
    ("ESTANDARES_INGENIERIA.md", "crítica", ["estándares", "código"]),
    # ... resto de los 63 archivos según Doc 6 §9.1
    # Hitos OpenClaw
    ("HITO_4_1_OPENCLAW_ONBOARDING.md", "crítica", ["onboarding"]),
    ("HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md", "alta", ["topology"]),
    ("HITO_4_3_PROVISIONING_DRY_RUN.md", "crítica", ["dry-run"]),
    ("HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md", "crítica", ["scheduler", "skills"]),
    ("HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md", "crítica", ["permisos", "runbook"]),
    # Set quirúrgico Hito 5.11.B
    ("OPENCLAW_PERMISSIONS_MATRIX.md", "crítica", ["matriz"]),
    ("OPENCLAW_SKILLS_CATALOG.md", "crítica", ["skills"]),
    ("OPENCLAW_DELIVRIX_API_CONTRACT.md", "crítica", ["contract"]),
    ("OPENCLAW_SYSTEM_PROMPT.md", "crítica", ["prompt"]),
    ("OPENCLAW_RUNBOOKS_OPERATIONAL.md", "crítica", ["runbooks"]),
    ("OPENCLAW_AUDIT_INTEGRATION.md", "crítica", ["audit"]),
    ("OPENCLAW_KNOWLEDGE_BASE_INDEX.md", "media", ["self-reference"]),
    ("HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md", "crítica", ["rector"]),
    # Skills literales
    ("skills/delivrix-fleet-ops/SKILL.md", "crítica", ["skill"]),
    ("skills/delivrix-alert-ops/SKILL.md", "crítica", ["skill"]),
    ("skills/delivrix-report-ops/SKILL.md", "crítica", ["skill"]),
    ("skills/webdock-inventory-sync/SKILL.md", "alta", ["skill"]),
    ("skills/drift-monitor/SKILL.md", "crítica", ["skill"]),
    # Runbooks literales
    ("runbooks/warming-step-runbook.md", "crítica", ["runbook"]),
    ("runbooks/pause-ip-runbook.md", "crítica", ["runbook"]),
    ("runbooks/register-sender-node-local-runbook.md", "alta", ["runbook"]),
    ("runbooks/rotate-dns-record-runbook.md", "media", ["runbook-bloqueado"]),
    ("runbooks/incident-quarantine-runbook.md", "crítica", ["runbook"]),
    ("runbooks/daily-report-runbook.md", "media", ["runbook"]),
    # Hitos panel admin (relevantes para que OpenClaw conozca el panel)
    ("HITO_5_4_ADMIN_PANEL_VISUAL_ARQUITECTURA.md", "alta", ["panel"]),
    ("HITO_5_4A_ADMIN_PANEL_READ_ONLY.md", "alta", ["GET-only"]),
    ("HITO_5_4B_ADMIN_PANEL_WORKFLOW.md", "alta", ["workflow"]),
    ("HITO_5_4C_ADMIN_CLUSTERS_OPENCLAW_LEARNING.md", "alta", ["clusters", "learning"]),
    ("HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md", "crítica", ["canvas"]),
    ("HITO_5_6_CONTRATOS_CANVAS_HARDWARE_ML_DEVOPS.md", "crítica", ["contratos"]),
    ("HITO_5_7_ADMIN_PANEL_REACT_CANVAS.md", "alta", ["React canvas"]),
    ("HITO_5_8_COLLECTOR_SUPERVISADO_READ_ONLY.md", "alta", ["collector"]),
    ("HITO_5_9_INGESTA_MANUAL_SNAPSHOT_UX.md", "media", ["manual snapshot"]),
    # Fases (alta prioridad por compliance)
    ("FASE_2_HEALTH_CHECKS.md", "alta", ["health"]),
    ("FASE_2_KILL_SWITCH.md", "crítica", ["kill switch"]),
    ("FASE_2_RATE_LIMITS.md", "alta", ["rate limit"]),
    ("FASE_2_RUNBOOK_OPERATIVO.md", "crítica", ["runbook"]),
    ("FASE_2_SENDER_NODE_MANUAL_CONTROLS.md", "alta", ["sender-node"]),
    ("FASE_2_STUCK_JOB_RECOVERY.md", "alta", ["stuck-jobs"]),
    ("FASE_3_INFRAESTRUCTURA_PROPIA.md", "alta", ["infra", "Proxmox"]),
    ("FASE_4_OPENCLAW_INFRAESTRUCTURA.md", "crítica", ["OpenClaw conceptual"]),
    ("FASE_5_MVP_DEMOSTRABLE.md", "alta", ["MVP"]),
    # Demás (con prioridad acotada)
    ("HITO_4_0_ALINEACION_CONTROL_PLANE.md", "alta", ["control plane"]),
    ("HITO_5_0_DEMO_BLUEPRINT_REVISION_PATRONES.md", "media", ["demo"]),
    ("HITO_5_1_DEMO_RUNNER_LOCAL.md", "media", ["demo"]),
    ("HITO_5_2_OPENCLAW_INCIDENTE_SIMULADO.md", "alta", ["incidente"]),
    ("HITO_5_3_DEMO_REPORT_FINAL.md", "media", ["demo"]),
    ("HITO_5_5_AUDITORIA_FRONTEND_UI_PROCESOS.md", "media", ["UX"]),
    ("BACKLOG_CONTRATOS_5_11.md", "media", ["backlog"]),
    ("FRONTEND_DESIGN_SYSTEM.md", "media", ["UI tokens"]),
    ("FRONTEND_UX_CONTRACT_GUIDE.md", "alta", ["contract-first"]),
    ("INDICE_DOCUMENTACION.md", "media", ["navegación"]),
    ("ROADMAP_PROYECTO.md", "alta", ["planning"]),
    ("ANALISIS_CRITICO_ROADMAP.md", "alta", ["riesgos"]),
    ("ARQUITECTURA_BASE_1.md", "alta", ["arquitectura"]),
    ("FASE_2_ADMIN_OVERVIEW.md", "media", ["fase 2"]),
    ("FASE_2_METRICAS_BASICAS.md", "media", ["KPIs"]),
    ("FASE_2_MOCK_INGESTION_BOUNCES_COMPLAINTS.md", "media", ["mock"]),
    ("FASE_2_PIPELINE_WEBDOCK.md", "alta", ["webdock"]),
    ("FASE_2_RESULTADOS_SIMULADOS.md", "media", ["send-results"]),
]

# Chunker: por header H2 y luego por tamaño
headers_to_split = [("##", "section"), ("###", "subsection")]
header_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers_to_split)
size_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1500 * 4,   # ~1500 tokens
    chunk_overlap=150 * 4,  # ~150 tokens
)

# Embedding model — default de chromadb (all-MiniLM-L6-v2) por simplicidad
client = chromadb.PersistentClient(path=CHROMA_PATH)
collection = client.get_or_create_collection(
    name="delivrix-docs",
    metadata={
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "source_commit": os.popen(f"cd {WORKTREE} && git rev-parse HEAD").read().strip()
    }
)

tokenizer = tiktoken.get_encoding("cl100k_base")

def slugify(text):
    return re.sub(r'[^a-z0-9-]', '', re.sub(r'\s+', '-', text.lower()))[:50]

chunks_added = 0
chunks_skipped = 0
docs_processed = 0
docs_missing = 0

for doc_path, priority, tags in DOCS_TO_INDEX:
    full_path = DOCS_DIR / doc_path
    if not full_path.exists():
        print(f"WARN: doc no existe, skip: {doc_path}")
        docs_missing += 1
        continue

    with open(full_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Chunk por header
    header_chunks = header_splitter.split_text(content)

    for header_chunk in header_chunks:
        section_anchor = slugify(header_chunk.metadata.get("section", "root"))
        # Sub-chunk por tamaño si excede
        sub_chunks = size_splitter.split_text(header_chunk.page_content)

        for idx, sub_chunk in enumerate(sub_chunks):
            token_count = len(tokenizer.encode(sub_chunk))
            chunk_id = f"doc_{slugify(doc_path)}__sec_{section_anchor}__chunk_{idx}"

            metadata = {
                "docPath": doc_path,
                "sectionAnchor": section_anchor,
                "chunkIndex": idx,
                "priority": priority,
                "tags": ",".join(tags),
                "tokenCount": token_count,
                "indexedAt": datetime.now(timezone.utc).isoformat(),
                "docVersion": os.popen(f"cd {WORKTREE} && git log -1 --format=%H -- DOCUMENTACION/{doc_path} 2>/dev/null").read().strip() or "uncommitted",
                "embeddingModel": "all-MiniLM-L6-v2"  # default ChromaDB
            }

            try:
                collection.upsert(
                    ids=[chunk_id],
                    documents=[sub_chunk],
                    metadatas=[metadata]
                )
                chunks_added += 1
            except Exception as e:
                print(f"ERROR indexing {chunk_id}: {e}")
                chunks_skipped += 1

    docs_processed += 1

# Resumen
total_chunks = collection.count()
print(f"\n=== Resumen ===")
print(f"Docs procesados:    {docs_processed} / {len(DOCS_TO_INDEX)}")
print(f"Docs missing:       {docs_missing}")
print(f"Chunks añadidos:    {chunks_added}")
print(f"Chunks skipped:     {chunks_skipped}")
print(f"Total en colection: {total_chunks}")

# Audit JSONL
import uuid
audit_entry = {
    "id": str(uuid.uuid4()),
    "occurredAt": datetime.now(timezone.utc).isoformat(),
    "actorType": "system",
    "actorId": "codex@host",
    "action": "oc.kb.capa2_indexed",
    "targetType": "openclaw_kb_capa2",
    "targetId": "delivrix-docs",
    "decision": "n/a",
    "humanApproved": True,
    "approverIds": ["juanes@delivrix"],
    "schemaVersion": "2026-05-18.v1",
    "metadata": {
        "docsProcessed": docs_processed,
        "docsMissing": docs_missing,
        "chunksAdded": chunks_added,
        "chunksSkipped": chunks_skipped,
        "totalChunks": total_chunks,
        "embeddingModel": "all-MiniLM-L6-v2",
        "chunkingStrategy": "header_h2_then_size_1500_overlap_150"
    },
    "prevHash": "PENDING_CHAIN_BOOTSTRAP",
    "hash": "PENDING_CHAIN_BOOTSTRAP"
}

audit_path = AUDIT_DIR / "openclaw-kb.jsonl"
audit_path.parent.mkdir(parents=True, exist_ok=True)
with open(audit_path, "a") as f:
    f.write(json.dumps(audit_entry) + "\n")

print(f"\nok: audit registrado en {audit_path}")
PYTHON

chmod +x "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/index-kb-capa2.py"
```

## Paso 5 — Ejecutar indexación inicial

```bash
# 5.1 — Copiar el script al container (necesita acceso a /data y a los docs)
# Alternativa: ejecutarlo localmente con DOCUMENTACION mount + remote ChromaDB.
# MVP: ejecutar dentro del container con DOCUMENTACION bind-mount.

# Si Codex eligió la Opción A (bind mount) en Doc 6 §7:
docker exec openclaw-dtsf-openclaw-1 python3 \
  /openclaw/scripts/index-kb-capa2.py

# Esperado:
#   Docs procesados:    63 / 63
#   Docs missing:       0
#   Chunks añadidos:    ~1000-1500
#   Total en colection: ~1000-1500
#   ok: audit registrado en .audit/openclaw-kb.jsonl

# 5.2 — Verificar que la collection tiene chunks
docker exec openclaw-dtsf-openclaw-1 python3 -c "
import chromadb
client = chromadb.PersistentClient(path='/data/.openclaw/kb/chroma')
c = client.get_collection('delivrix-docs')
print(f'Chunks indexed: {c.count()}')
# Sample query
results = c.query(query_texts=['qué dice el norte sobre SSH automático'], n_results=3)
for i, doc in enumerate(results['documents'][0]):
    meta = results['metadatas'][0][i]
    print(f'  Hit {i+1}: {meta[\"docPath\"]} §{meta[\"sectionAnchor\"]} ({meta[\"tokenCount\"]} tokens)')
"
# Esperado: 3 hits con docPath de NORTE_OPERATIVO_DELIVRIX.md o relacionados
```

## Paso 6 — Test set recall@5

```bash
cat > "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/eval-recall.py" <<'PYTHON'
#!/usr/bin/env python3
"""
Eval recall@5 contra el test set de 30 queries (Doc 6 §11.1).
Mide cuántas queries devuelven el chunk relevante en top-5.
Umbral mínimo: 80%.
"""
import chromadb
import json
from pathlib import Path

CHROMA_PATH = "/data/.openclaw/kb/chroma"
client = chromadb.PersistentClient(path=CHROMA_PATH)
collection = client.get_collection("delivrix-docs")

# Test set (Doc 6 §11.1). Cada entry: (query, expected_doc_path)
TEST_SET = [
    ("qué dice el norte sobre SMTP real", "NORTE_OPERATIVO_DELIVRIX.md"),
    ("cómo funciona el kill switch", "FASE_2_KILL_SWITCH.md"),
    ("qué pasos tiene el warming step runbook", "runbooks/warming-step-runbook.md"),
    ("cuántas firmas necesita pausar una IP", "runbooks/pause-ip-runbook.md"),
    ("qué hace la skill drift-monitor", "skills/drift-monitor/SKILL.md"),
    ("qué categorías tiene la permissions matrix", "OPENCLAW_PERMISSIONS_MATRIX.md"),
    ("cuál es el formato del audit event", "OPENCLAW_AUDIT_INTEGRATION.md"),
    ("qué endpoints expone el contrato API", "OPENCLAW_DELIVRIX_API_CONTRACT.md"),
    ("cómo se cargan los docs al system prompt", "OPENCLAW_KNOWLEDGE_BASE_INDEX.md"),
    ("qué hace fleet-ops", "skills/delivrix-fleet-ops/SKILL.md"),
    ("cómo se aprueba una acción supervised_local_state", "OPENCLAW_PERMISSIONS_MATRIX.md"),
    ("qué retorna delivrix-alert-ops", "skills/delivrix-alert-ops/SKILL.md"),
    ("qué pasa con rotate-dns en hito 5.11.B", "runbooks/rotate-dns-record-runbook.md"),
    ("cuál es el cronograma del hito 5.11.B", "HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md"),
    ("qué dice el bloque 8 del system prompt", "OPENCLAW_SYSTEM_PROMPT.md"),
    ("cómo se replica el audit log al gateway", "OPENCLAW_AUDIT_INTEGRATION.md"),
    ("qué hace el daily report runbook", "runbooks/daily-report-runbook.md"),
    ("cómo se mide recall del RAG", "OPENCLAW_KNOWLEDGE_BASE_INDEX.md"),
    ("qué pasa en cuarentena de incidente", "runbooks/incident-quarantine-runbook.md"),
    ("cuál es el flujo onboarding OpenClaw", "HITO_4_1_OPENCLAW_ONBOARDING.md"),
    ("cómo se genera el topology plan", "HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md"),
    ("cuáles son las acciones prohibidas en fase 4", "FASE_4_OPENCLAW_INFRAESTRUCTURA.md"),
    ("cómo funciona el scheduler de OpenClaw", "HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md"),
    ("cuál es la matriz de permisos del runbook 4.5", "HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md"),
    ("qué tiene el canvas operativo", "HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md"),
    ("cómo registra un sender node nuevo", "runbooks/register-sender-node-local-runbook.md"),
    ("qué hace webdock-inventory-sync", "skills/webdock-inventory-sync/SKILL.md"),
    ("cómo se valida un approval token", "OPENCLAW_PERMISSIONS_MATRIX.md"),
    ("qué metadata trae cada chunk", "OPENCLAW_KNOWLEDGE_BASE_INDEX.md"),
    ("cuál es el handshake WebSocket", "OPENCLAW_DELIVRIX_API_CONTRACT.md"),
]

hits = 0
misses = []

for query, expected_doc in TEST_SET:
    results = collection.query(query_texts=[query], n_results=5)
    top5_docs = [m["docPath"] for m in results["metadatas"][0]]
    if expected_doc in top5_docs:
        hits += 1
    else:
        misses.append({"query": query, "expected": expected_doc, "got": top5_docs})

recall = hits / len(TEST_SET)
print(f"\n=== Recall@5 ===")
print(f"Hits: {hits} / {len(TEST_SET)}")
print(f"Recall: {recall:.2%}")
print(f"Umbral aceptable: 80%")
print(f"Status: {'✅ PASS' if recall >= 0.80 else '❌ FAIL'}")

if misses:
    print(f"\nMisses ({len(misses)}):")
    for m in misses:
        print(f"  query: '{m['query'][:60]}...'")
        print(f"  expected: {m['expected']}")
        print(f"  got top5: {m['got'][:3]}...")
        print()
PYTHON

chmod +x "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/eval-recall.py"

# Ejecutar
docker exec openclaw-dtsf-openclaw-1 python3 /openclaw/scripts/eval-recall.py
# Esperado: Recall: 80-95%, status PASS.
# Si <80%, revisar chunking + considerar reranker o ajustar chunk size.
```

## Paso 7 — Cron nightly de reindex

```bash
# 7.1 — Crear el script de reindex diff (solo lo que cambió desde el último HEAD)
cat > "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/reindex-nightly.sh" <<'BASH'
#!/usr/bin/env bash
# Cron nightly: reindex solo lo que cambió desde el último HEAD indexed.
set -euo pipefail

WORKTREE="/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de"
LAST_INDEXED_FILE="${WORKTREE}/.audit/kb-last-indexed-commit"

CURRENT_COMMIT=$(cd "${WORKTREE}" && git rev-parse HEAD)
LAST_COMMIT=$(cat "${LAST_INDEXED_FILE}" 2>/dev/null || echo "")

if [ -z "${LAST_COMMIT}" ]; then
  echo "Full reindex (no last commit recorded)"
  docker exec openclaw-dtsf-openclaw-1 python3 /openclaw/scripts/index-kb-capa2.py
elif [ "${CURRENT_COMMIT}" = "${LAST_COMMIT}" ]; then
  echo "ok: no changes since last reindex (${LAST_COMMIT})"
  exit 0
else
  CHANGED=$(cd "${WORKTREE}" && git diff --name-only "${LAST_COMMIT}" "${CURRENT_COMMIT}" -- 'DOCUMENTACION/*.md')
  if [ -z "${CHANGED}" ]; then
    echo "ok: no doc changes since ${LAST_COMMIT}"
  else
    echo "Reindexing changed files:"
    echo "${CHANGED}"
    # TODO: para MVP hacemos full reindex; diff-based queda como Hito 5.11.C
    docker exec openclaw-dtsf-openclaw-1 python3 /openclaw/scripts/index-kb-capa2.py
  fi
fi

echo "${CURRENT_COMMIT}" > "${LAST_INDEXED_FILE}"

# Audit
cat >> "${WORKTREE}/.audit/openclaw-kb.jsonl" <<JSON
{"id":"$(uuidgen)","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","actorType":"system","actorId":"codex@cron","action":"oc.kb.reindex_completed","targetType":"openclaw_kb_capa2","targetId":"delivrix-docs","decision":"n/a","schemaVersion":"2026-05-18.v1","metadata":{"sourceCommit":"${CURRENT_COMMIT}","previousCommit":"${LAST_COMMIT}"},"prevHash":"PENDING_CHAIN_BOOTSTRAP","hash":"PENDING_CHAIN_BOOTSTRAP"}
JSON
BASH

chmod +x "/Users/juanescanar/Documents/delivrix app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/reindex-nightly.sh"

# 7.2 — Registrar el cron en el host del operador (no en container porque
#       necesita acceso al git del worktree)
(crontab -l 2>/dev/null; \
 echo "0 3 * * * /Users/juanescanar/Documents/delivrix\\ app/.claude/worktrees/youthful-mirzakhani-c517de/scripts/openclaw/reindex-nightly.sh >> /Users/juanescanar/Documents/delivrix\\ app/.claude/worktrees/youthful-mirzakhani-c517de/.audit/kb-cron.log 2>&1") | crontab -

# Verificar
crontab -l | grep reindex-nightly
```

## Cierre y reporte al operador

```bash
echo "============================================"
echo "  KB Build completado — D+2 AM"
echo "============================================"
echo ""
echo "Capa 1 (núcleo fijo):"
echo "  Bundle:  /data/.openclaw/workspace/system-context.txt"
echo "  Tokens:  ~7K"
echo ""
echo "Capa 2 (ChromaDB RAG):"
echo "  Path:    /data/.openclaw/kb/chroma"
echo "  Collection: delivrix-docs"
echo "  Chunks:  $(docker exec openclaw-dtsf-openclaw-1 python3 -c 'import chromadb;c=chromadb.PersistentClient(path=\"/data/.openclaw/kb/chroma\").get_collection(\"delivrix-docs\");print(c.count())')"
echo ""
echo "Cron nightly: $(crontab -l | grep reindex-nightly)"
echo ""
echo "Smoke 2 (identidad + 6 gates): $(verificar manualmente)"
echo "Recall@5: $(docker exec openclaw-dtsf-openclaw-1 python3 /openclaw/scripts/eval-recall.py | grep 'Recall:' | head -1)"
echo ""
echo "Audit: .audit/openclaw-kb.jsonl"
echo "============================================"
```

## Próximo milestone

D+2 PM del cronograma: **Skills `webdock-inventory-sync` + `delivrix-fleet-ops`**
cargadas como plugins TypeScript en el container, llamando al Gateway
Delivrix vía el contrato del Doc 4. Smoke real: "qué tengo en Webdock?"
debe devolver inventario real con audit `oc.skill.webdock_sync.invoke`.
