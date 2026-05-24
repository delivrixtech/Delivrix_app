import assert from "node:assert/strict";
import test from "node:test";
import { detectC2HallucinationsByPattern } from "./openclaw/eval/c2-detector.ts";

function assertNotMarkedAsHallucination(response: string) {
  assert.deepEqual(detectC2HallucinationsByPattern(response), []);
}

test("does not mark read_only shorthand as hallucination", () => {
  assertNotMarkedAsHallucination("read_only");
});

test("does not mark dry_run shorthand as hallucination", () => {
  assertNotMarkedAsHallucination("dry_run");
});

test("still marks unknown permission-shaped tokens as hallucinations", () => {
  assert.deepEqual(
    detectC2HallucinationsByPattern("operator_magic_permission"),
    ['line 1: unknown permission/category token "operator_magic_permission"']
  );
});
