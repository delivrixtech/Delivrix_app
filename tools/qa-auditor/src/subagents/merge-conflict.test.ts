import test from "node:test";
import assert from "node:assert/strict";
import { buildMergeConflictFinding } from "./merge-conflict.ts";

test("marca blocker cuando el PR esta dirty o mergeable=false", () => {
  const a = buildMergeConflictFinding({ mergeable: false, mergeableState: "dirty", number: 7 });
  assert.ok(a);
  assert.equal(a?.severity, "blocker");
  assert.equal(a?.category, "merge-conflict");
  assert.equal(a?.dimension, "qa_deploy");
  assert.ok(a?.evidence.path.includes("7"));

  const b = buildMergeConflictFinding({ mergeable: null, mergeableState: "dirty", number: 9 });
  assert.ok(b);
});

test("no marca nada cuando el PR es mergeable o el estado es desconocido", () => {
  assert.equal(buildMergeConflictFinding({ mergeable: true, mergeableState: "clean", number: 1 }), null);
  assert.equal(buildMergeConflictFinding({ mergeable: null, mergeableState: "unknown", number: 2 }), null);
  assert.equal(buildMergeConflictFinding({ mergeable: null, mergeableState: "blocked", number: 3 }), null);
});
