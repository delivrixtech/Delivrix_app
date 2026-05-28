import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDefaultCollectorSources,
  buildSupervisedCollectorPlan,
  mockSource
} from "./index.ts";

const fixedNow = new Date("2026-05-08T16:30:00.000Z");

test("supervised collector plan is read-only, audited, and blocked from live actions", () => {
  const plan = buildSupervisedCollectorPlan({ now: fixedNow });

  assert.equal(plan.mode, "read_only");
  assert.equal(plan.collectorMode, "supervised_read_only");
  assert.equal(plan.status, "needs_review");
  assert.equal(plan.ingestionPolicy.acceptsLiveMutation, false);
  assert.equal(plan.ingestionPolicy.acceptsManualSnapshot, true);
  assert.equal(plan.auditPolicy.appendOnly, true);
  assert.equal(plan.auditPolicy.redactsSecrets, true);
  assert.equal(plan.auditPolicy.snapshotHashRequired, true);
  assert.equal(plan.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(plan.safety.sshEnabled, false);
  assert.ok(plan.blockedActions.includes("ssh-connect"));
  assert.ok(plan.blockedActions.includes("proxmox-live-create"));
  assert.ok(plan.blockedActions.includes("smtp-send"));
  assert.ok(plan.sources.every((source) => source.readOnly));
  assert.ok(plan.sources.every((source) => source.safeCollection.writesEnabled === false));
});

test("supervised collector declares local, proxmox, prometheus and ipmi sources", () => {
  const plan = buildSupervisedCollectorPlan({ now: fixedNow });
  const sourceKinds = plan.sources.map((source) => source.kind);

  assert.deepEqual(sourceKinds, ["local", "proxmox", "prometheus", "ipmi"]);
  assert.ok(plan.sources.some((source) => source.id === "local_hardware_snapshot" && source.status === "needs_review"));
  assert.ok(plan.sources.some((source) => source.id === "proxmox_read_only_api" && source.blockedBy.includes("missing_read_only_token")));
  assert.ok(plan.sources.some((source) => source.id === "proxmox_read_only_api" && source.url === null && source.safeCollection.endpoint === null));
  assert.ok(plan.sources.some((source) => source.id === "proxmox_read_only_api" && source.blockedReasonOperator?.includes("Proxmox")));
  assert.ok(plan.sources.some((source) => source.id === "prometheus_node_exporter" && source.url === "http://127.0.0.1:9100/metrics" && source.safeCollection.transport === "http_scrape"));
  assert.ok(plan.sources.some((source) => source.id === "ipmi_redfish" && source.safeCollection.requiresSecret));
  assert.ok(plan.sources.some((source) => source.id === "ipmi_redfish" && source.url === null && source.safeCollection.endpoint === null && source.expectedInMvp === false));
  assert.equal(plan.sources.filter((source) => source.expectedInMvp).length, 3);
  assert.equal(plan.freshness.unknownSources, 4);
  assert.equal(plan.freshness.lastCollectedAt, null);
});

test("supervised collector can report fresh read-only evidence without raising write permissions", () => {
  const collectedAt = "2026-05-08T16:29:00.000Z";
  const sources = buildDefaultCollectorSources();
  sources[0] = {
    ...sources[0],
    status: "ready",
    blockedBy: [],
    freshness: {
      lastCollectedAt: collectedAt,
      maxAgeSeconds: 300,
      stale: false
    }
  };

  const plan = buildSupervisedCollectorPlan({
    now: fixedNow,
    sources,
    source: mockSource({
      kind: "collector",
      trusted: false,
      freshness: "fresh",
      collectedAt
    })
  });

  assert.equal(plan.source.freshness, "fresh");
  assert.equal(plan.freshness.freshSources, 1);
  assert.equal(plan.freshness.lastCollectedAt, collectedAt);
  assert.equal(plan.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(plan.sources[0]?.safeCollection.writesEnabled, false);
});
