#!/usr/bin/env python3
"""Evaluate Delivrix OpenClaw KB recall@5."""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import chromadb

_INDEX_PATH = Path(__file__).with_name("index-kb-capa2.py")
_SPEC = importlib.util.spec_from_file_location("index_kb_capa2", _INDEX_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot import {_INDEX_PATH}")
_INDEX = importlib.util.module_from_spec(_SPEC)
sys.modules["index_kb_capa2"] = _INDEX
_SPEC.loader.exec_module(_INDEX)

COLLECTION_NAME = _INDEX.COLLECTION_NAME
DEFAULT_AUDIT_PATH = _INDEX.DEFAULT_AUDIT_PATH
DEFAULT_CHROMA_PATH = _INDEX.DEFAULT_CHROMA_PATH
hash_embedding = _INDEX.hash_embedding


TEST_SET = [
    ("qué dice el norte sobre SMTP real", ["NORTE_OPERATIVO_DELIVRIX.md"]),
    ("cómo funciona el kill switch", ["FASE_2_KILL_SWITCH.md", "HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md"]),
    ("qué pasos tiene el warming step runbook", ["runbooks/warming-step-runbook.md"]),
    ("cuántas firmas necesita pausar una IP", ["runbooks/pause-ip-runbook.md"]),
    ("qué hace la skill drift-monitor", ["skills/drift-monitor/SKILL.md"]),
    ("qué categorías tiene la permissions matrix", ["OPENCLAW_PERMISSIONS_MATRIX.md"]),
    ("cuál es el formato del audit event", ["OPENCLAW_AUDIT_INTEGRATION.md"]),
    ("qué endpoints expone el contrato API", ["OPENCLAW_DELIVRIX_API_CONTRACT.md"]),
    ("cómo se cargan los docs al system prompt", ["OPENCLAW_KNOWLEDGE_BASE_INDEX.md"]),
    ("qué hace fleet-ops", ["skills/delivrix-fleet-ops/SKILL.md", "OPENCLAW_SKILLS_CATALOG.md"]),
    ("cómo se aprueba una acción supervised_local_state", ["OPENCLAW_PERMISSIONS_MATRIX.md"]),
    ("qué retorna delivrix-alert-ops", ["skills/delivrix-alert-ops/SKILL.md", "OPENCLAW_SKILLS_CATALOG.md"]),
    ("qué pasa con rotate-dns en hito 5.11.B", ["runbooks/rotate-dns-record-runbook.md"]),
    ("cuál es el cronograma del hito 5.11.B", ["HITO_5_11_OPENCLAW_AGENT_HOSTINGER.md"]),
    ("qué dice el bloque 8 del system prompt", ["OPENCLAW_SYSTEM_PROMPT.md"]),
    ("cómo se replica el audit log al gateway", ["OPENCLAW_AUDIT_INTEGRATION.md"]),
    ("qué hace el daily report runbook", ["runbooks/daily-report-runbook.md"]),
    ("cómo se mide recall del RAG", ["OPENCLAW_KNOWLEDGE_BASE_INDEX.md"]),
    ("qué pasa en cuarentena de incidente", ["runbooks/incident-quarantine-runbook.md"]),
    ("cuál es el flujo onboarding OpenClaw", ["HITO_4_1_OPENCLAW_ONBOARDING.md"]),
    ("cómo se genera el topology plan", ["HITO_4_2_CLUSTER_TOPOLOGY_PLANNER.md"]),
    ("cuáles son las acciones prohibidas en fase 4", ["FASE_4_OPENCLAW_INFRAESTRUCTURA.md", "NORTE_OPERATIVO_DELIVRIX.md"]),
    ("cómo funciona el scheduler de OpenClaw", ["HITO_4_4_OPENCLAW_SCHEDULER_SKILLS.md"]),
    ("cuál es la matriz de permisos del runbook 4.5", ["HITO_4_5_RUNBOOK_PERMISOS_KILL_SWITCH.md", "OPENCLAW_PERMISSIONS_MATRIX.md"]),
    ("qué tiene el canvas operativo", ["HITO_5_5A_CANVAS_OPENCLAW_TELEMETRIA_HARDWARE.md"]),
    ("cómo registra un sender node nuevo", ["runbooks/register-sender-node-local-runbook.md"]),
    ("qué hace webdock-inventory-sync", ["skills/webdock-inventory-sync/SKILL.md", "OPENCLAW_SKILLS_CATALOG.md"]),
    ("cómo se valida un approval token", ["OPENCLAW_PERMISSIONS_MATRIX.md"]),
    ("qué metadata trae cada chunk", ["OPENCLAW_KNOWLEDGE_BASE_INDEX.md"]),
    ("cuál es el handshake WebSocket", ["OPENCLAW_DELIVRIX_API_CONTRACT.md"]),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_audit(audit_path: Path, metadata: dict) -> None:
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "id": str(uuid.uuid4()),
        "occurredAt": utc_now(),
        "actorType": "system",
        "actorId": "codex@host",
        "action": "oc.kb.quality_check",
        "targetType": "openclaw_kb_capa2",
        "targetId": COLLECTION_NAME,
        "decision": "n/a",
        "humanApproved": True,
        "approverIds": ["juanes@delivrix"],
        "schemaVersion": "2026-05-18.v1",
        "metadata": metadata,
        "prevHash": "PENDING_CHAIN_BOOTSTRAP",
        "hash": "PENDING_CHAIN_BOOTSTRAP",
    }
    with audit_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chroma-path", default=str(DEFAULT_CHROMA_PATH))
    parser.add_argument("--audit-path", default=str(DEFAULT_AUDIT_PATH))
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    client = chromadb.PersistentClient(path=args.chroma_path)
    collection = client.get_collection(COLLECTION_NAME)

    hits = 0
    misses = []
    latencies_ms = []
    results_rows = []

    for query, expected_docs in TEST_SET:
        start = time.perf_counter()
        result = collection.query(query_embeddings=[hash_embedding(query)], n_results=5)
        latency_ms = (time.perf_counter() - start) * 1000
        latencies_ms.append(latency_ms)
        top5_docs = [meta["docPath"] for meta in result["metadatas"][0]]
        ok = any(expected in top5_docs for expected in expected_docs)
        if ok:
            hits += 1
        else:
            misses.append({"query": query, "expected": expected_docs, "got": top5_docs})
        results_rows.append({"query": query, "expected": expected_docs, "top5": top5_docs, "hit": ok})

    recall = hits / len(TEST_SET)
    latency_p95 = sorted(latencies_ms)[int(len(latencies_ms) * 0.95) - 1]
    metadata = {
        "recall_at_5": round(recall, 4),
        "hits": hits,
        "totalQueries": len(TEST_SET),
        "misses": misses,
        "latency_avg_ms": round(statistics.mean(latencies_ms), 3),
        "latency_p95_ms": round(latency_p95, 3),
        "chunks_total": collection.count(),
        "status": "PASS" if recall >= 0.80 else "FAIL",
    }
    append_audit(Path(args.audit_path), metadata)

    if args.json_out:
        Path(args.json_out).write_text(json.dumps({"metadata": metadata, "results": results_rows}, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== Recall@5 ===")
    print(f"Hits: {hits} / {len(TEST_SET)}")
    print(f"Recall: {recall:.2%}")
    print("Threshold: 80.00%")
    print(f"Status: {'PASS' if recall >= 0.80 else 'FAIL'}")
    print(f"Latency p95: {latency_p95:.3f} ms")
    print(f"Chunks total: {collection.count()}")
    if misses:
        print(f"Misses ({len(misses)}):")
        for miss in misses:
            print(f"- {miss['query']} | expected={miss['expected']} | got={miss['got']}")
    return 0 if recall >= 0.80 else 1


if __name__ == "__main__":
    raise SystemExit(main())
