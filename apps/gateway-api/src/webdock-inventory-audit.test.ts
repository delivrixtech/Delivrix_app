import assert from "node:assert/strict";
import test from "node:test";
import { shouldAuditWebdockInventoryPoll } from "./webdock-inventory-audit.ts";

test("Webdock inventory GET remains audit-neutral for panel polls", () => {
  assert.equal(shouldAuditWebdockInventoryPoll({}), false);
  assert.equal(shouldAuditWebdockInventoryPoll({ "x-openclaw-skill-invocation": "panel" }), false);
});

test("Webdock inventory GET audits explicit fleet-ops skill invocations", () => {
  assert.equal(shouldAuditWebdockInventoryPoll({ "x-openclaw-skill-invocation": "fleet-ops" }), true);
  assert.equal(shouldAuditWebdockInventoryPoll({ "x-openclaw-skill-invocation": "delivrix-fleet-ops" }), true);
});
