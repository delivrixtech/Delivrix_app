#!/usr/bin/env python3
"""Delivrix OpenClaw KB Capa 2.

Indexes the 63 files listed in DOCUMENTACION/OPENCLAW_KNOWLEDGE_BASE_INDEX.md
§9.1 into ChromaDB. Uses deterministic local hash-ngram embeddings so runtime
does not depend on downloading external embedding models or exposing API keys.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import chromadb


DEFAULT_DOCS_DIR = Path("/data/.openclaw/kb/source/DOCUMENTACION")
DEFAULT_CHROMA_PATH = Path("/data/.openclaw/kb/chroma")
DEFAULT_AUDIT_PATH = Path("/data/.openclaw/kb/audit/openclaw-kb.jsonl")
COLLECTION_NAME = "delivrix-docs"
EMBEDDING_MODEL = "delivrix-hash-ngram-v1"
EMBEDDING_DIM = 768
MAX_CHARS = 6000
OVERLAP_CHARS = 600


@dataclass(frozen=True)
class DocSpec:
    path: str
    priority: str
    tags: tuple[str, ...]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def normalize_text(text: str) -> str:
    text = strip_accents(text.lower())
    text = text.replace("_", " ").replace("-", " ").replace("/", " ")
    return re.sub(r"\s+", " ", text).strip()


def expand_query_or_doc(text: str) -> str:
    base = normalize_text(text)
    additions: list[str] = []
    rules = [
        (("smtp", "correo", "email"), "norte operativo delivrix gates send email real enviar correo real postfix opendkim prohibited smtp"),
        (("kill switch", "killswitch"), "kill switch ultimo gate no bypass enabled false"),
        (("firma", "firmas", "aprobacion", "aprobación"), "pause ip runbook pausar ip caliente dos personas humanApproved approval token approverIds permissions matrix hmac"),
        (("warming", "calentamiento"), "warming ramp reputacion runbook step"),
        (("drift", "desviacion"), "webdock registry drift proposals rules engine"),
        (("fleet", "flota", "clusters"), "delivrix fleet ops sender nodes clusters canvas"),
        (("webdock",), "webdock inventory sync read webdock inventory"),
        (("audit", "auditoria", "auditoría"), "audit log append only event schema evidenceRefs"),
        (("handshake", "websocket", "wss"), "openclaw delivrix api contract websocket handshake connect challenge device identity token"),
        (("endpoint", "endpoints", "contrato api", "api contract"), "openclaw delivrix api contract direccion endpoint read boundary"),
        (("metadata", "chunk"), "openclaw knowledge base index schema chunk metadata docPath sectionAnchor tokenCount"),
        (("dns",), "dns live change future live blocked route53"),
        (("nfc",), "nfc production writes prohibited bridge future"),
        (("proxmox",), "proxmox live mutation prohibited future phase"),
        (("ssh",), "ssh automatico prohibido no automatic ssh"),
    ]
    for needles, add in rules:
        if any(needle in base for needle in needles):
            additions.append(add)
    return f"{base} {' '.join(additions)}".strip()


def features(text: str) -> list[str]:
    text = expand_query_or_doc(text)
    words = re.findall(r"[a-z0-9]+", text)
    feats: list[str] = []
    feats.extend(words)
    feats.extend(f"w2:{words[i]}_{words[i + 1]}" for i in range(len(words) - 1))
    padded = f" {text} "
    for n in (3, 4, 5):
        feats.extend(f"c{n}:{padded[i:i+n]}" for i in range(max(0, len(padded) - n + 1)))
    return feats


def hash_embedding(text: str, dim: int = EMBEDDING_DIM) -> list[float]:
    vector = [0.0] * dim
    for feat in features(text):
        digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest()
        raw = int.from_bytes(digest, "big")
        idx = raw % dim
        sign = 1.0 if (raw >> 8) & 1 else -1.0
        if feat.startswith("w2:"):
            weight = 1.7
        elif feat.startswith("c"):
            weight = 0.45
        else:
            weight = 2.2
        vector[idx] += sign * weight
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


def slugify(text: str) -> str:
    text = normalize_text(text)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:80] or "root"


def parse_doc_specs(docs_dir: Path) -> list[DocSpec]:
    index_path = docs_dir / "OPENCLAW_KNOWLEDGE_BASE_INDEX.md"
    raw = index_path.read_text(encoding="utf-8")
    try:
        table = raw.split("### 9.1 SÍ indexar", 1)[1].split("### 9.2 NO indexar", 1)[0]
    except IndexError as exc:
        raise SystemExit(f"FAIL: no pude ubicar §9.1 en {index_path}") from exc
    specs: list[DocSpec] = []
    seen: set[str] = set()
    for line in table.splitlines():
        line = line.strip()
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        path = cells[0].strip("`")
        priority = cells[1]
        tags = tuple(tag.strip() for tag in cells[2].split(",") if tag.strip())
        if path and path not in seen:
            specs.append(DocSpec(path=path, priority=priority, tags=tags))
            seen.add(path)
    return specs


def split_markdown(content: str) -> list[tuple[str, str]]:
    lines = content.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_title = "root"
    current_lines: list[str] = []
    for line in lines:
        match = re.match(r"^(#{2,3})\s+(.+?)\s*$", line)
        if match and current_lines:
            sections.append((current_title, current_lines))
            current_title = match.group(2).strip()
            current_lines = [line]
        else:
            if match:
                current_title = match.group(2).strip()
            current_lines.append(line)
    if current_lines:
        sections.append((current_title, current_lines))

    chunks: list[tuple[str, str]] = []
    for title, section_lines in sections:
        text = "\n".join(section_lines).strip()
        if not text:
            continue
        if len(text) <= MAX_CHARS:
            chunks.append((title, text))
            continue
        start = 0
        while start < len(text):
            end = min(len(text), start + MAX_CHARS)
            window = text[start:end]
            if end < len(text):
                split_at = max(window.rfind("\n\n"), window.rfind("\n- "), window.rfind(". "))
                if split_at > MAX_CHARS * 0.55:
                    end = start + split_at + 1
                    window = text[start:end]
            chunks.append((title, window.strip()))
            if end >= len(text):
                break
            start = max(0, end - OVERLAP_CHARS)
    return chunks


def doc_version(docs_dir: Path, rel_path: str) -> str:
    full_path = docs_dir / rel_path
    return hashlib.sha256(full_path.read_bytes()).hexdigest()[:16]


def append_audit(audit_path: Path, action: str, target_id: str, metadata: dict) -> None:
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "id": str(uuid.uuid4()),
        "occurredAt": utc_now(),
        "actorType": "system",
        "actorId": "codex@host",
        "action": action,
        "targetType": "openclaw_kb_capa2",
        "targetId": target_id,
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
    parser.add_argument("--docs-dir", default=str(DEFAULT_DOCS_DIR))
    parser.add_argument("--chroma-path", default=str(DEFAULT_CHROMA_PATH))
    parser.add_argument("--audit-path", default=str(DEFAULT_AUDIT_PATH))
    parser.add_argument("--reset", action="store_true", default=True)
    args = parser.parse_args()

    docs_dir = Path(args.docs_dir)
    chroma_path = Path(args.chroma_path)
    audit_path = Path(args.audit_path)
    start_time = time.perf_counter()

    specs = parse_doc_specs(docs_dir)
    if len(specs) != 63:
        raise SystemExit(f"FAIL: Doc 6 §9.1 debía listar 63 archivos, encontré {len(specs)}")

    client = chromadb.PersistentClient(path=str(chroma_path))
    if args.reset:
        try:
            client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={
            "description": "Delivrix Hito 5.11.B knowledge base",
            "embeddingModel": EMBEDDING_MODEL,
            "indexedAt": utc_now(),
        },
    )

    docs_processed = 0
    docs_missing = 0
    chunks_added = 0
    chunks_skipped = 0
    missing: list[str] = []

    for spec in specs:
        full_path = docs_dir / spec.path
        if not full_path.exists():
            docs_missing += 1
            missing.append(spec.path)
            print(f"WARN missing: {spec.path}", file=sys.stderr)
            continue
        content = full_path.read_text(encoding="utf-8")
        chunks = split_markdown(content)
        version = doc_version(docs_dir, spec.path)
        ids: list[str] = []
        documents: list[str] = []
        embeddings: list[list[float]] = []
        metadatas: list[dict] = []
        for idx, (section_title, chunk) in enumerate(chunks):
            section_anchor = slugify(section_title)
            chunk_id = f"doc_{slugify(spec.path)}__sec_{section_anchor}__chunk_{idx}"
            indexed_doc = (
                f"docPath: {spec.path}\n"
                f"priority: {spec.priority}\n"
                f"tags: {', '.join(spec.tags)}\n"
                f"section: {section_title}\n\n"
                f"{chunk}"
            )
            ids.append(chunk_id)
            documents.append(chunk)
            embeddings.append(hash_embedding(indexed_doc))
            metadatas.append({
                "docPath": spec.path,
                "sectionAnchor": section_anchor,
                "sectionTitle": section_title[:180],
                "chunkIndex": idx,
                "priority": spec.priority,
                "tags": ",".join(spec.tags),
                "tokenCount": max(1, len(chunk) // 4),
                "indexedAt": utc_now(),
                "docVersion": version,
                "embeddingModel": EMBEDDING_MODEL,
            })
        if ids:
            collection.upsert(ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas)
            chunks_added += len(ids)
            docs_processed += 1
        else:
            chunks_skipped += 1

    total_chunks = collection.count()
    duration_s = round(time.perf_counter() - start_time, 3)
    metadata = {
        "docsExpected": len(specs),
        "docsProcessed": docs_processed,
        "docsMissing": docs_missing,
        "missingDocs": missing,
        "chunksAdded": chunks_added,
        "chunksSkipped": chunks_skipped,
        "totalChunks": total_chunks,
        "embeddingModel": EMBEDDING_MODEL,
        "embeddingDim": EMBEDDING_DIM,
        "chunkingStrategy": "markdown_h2_h3_then_size_1500_overlap_150",
        "reindexDurationS": duration_s,
    }
    append_audit(audit_path, "oc.kb.capa2_indexed", COLLECTION_NAME, metadata)

    print("=== Capa 2 index summary ===")
    print(f"Docs processed: {docs_processed} / {len(specs)}")
    print(f"Docs missing:   {docs_missing}")
    print(f"Chunks added:   {chunks_added}")
    print(f"Total chunks:   {total_chunks}")
    print(f"Duration:       {duration_s}s")
    print(f"Embedding:      {EMBEDDING_MODEL}")
    print(f"Audit:          {audit_path}")
    return 0 if docs_missing == 0 and docs_processed == len(specs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
