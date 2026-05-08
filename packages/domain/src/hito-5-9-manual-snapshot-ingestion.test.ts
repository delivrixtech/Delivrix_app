import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManualCollectorSnapshotIngestionContract,
  ingestManualCollectorSnapshot
} from "./index.ts";

const fixedNow = new Date("2026-05-08T17:00:00.000Z");

test("manual snapshot contract keeps admin panel GET-only", () => {
  const contract = buildManualCollectorSnapshotIngestionContract({ now: fixedNow });

  assert.equal(contract.mode, "read_only");
  assert.equal(contract.status, "needs_review");
  assert.equal(contract.snapshotSchemaVersion, "2026-05-08.collector-snapshot.v1");
  assert.equal(contract.manualEndpoint.method, "POST");
  assert.equal(contract.manualEndpoint.exposedInAdminPanel, false);
  assert.equal(contract.manualEndpoint.requiresHumanApproval, true);
  assert.equal(contract.manualEndpoint.storesRawPayload, false);
  assert.equal(contract.uiPolicy.adminPanelCanPost, false);
  assert.deepEqual(contract.uiPolicy.allowedPanelMethods, ["GET"]);
  assert.ok(contract.acceptedFieldPaths.some((field) => field.path === "capacity.cpuCores"));
  assert.ok(contract.gates.includes("admin_panel_remains_get_only"));
  assert.ok(contract.blockedActions.includes("admin-ui-post"));
});

test("manual snapshot ingestion redacts secrets before hashing and audit", () => {
  const ingestion = ingestManualCollectorSnapshot({
    actorId: "operator_delivrix",
    now: fixedNow,
    rawSnapshot: {
      host: {
        model: "IBM System x3630 M4",
        operatingSystem: "Ubuntu Server 24.04 LTS",
        password: "SECRET_PASSWORD"
      },
      capacity: {
        cpuCores: 24,
        memoryGb: 256,
        storageUsableGb: 4000
      },
      token: "SECRET_TOKEN"
    }
  });
  const serialized = JSON.stringify(ingestion);

  assert.equal(ingestion.status, "needs_review");
  assert.equal(ingestion.redaction.secretLikeFieldsRemoved, 2);
  assert.deepEqual(ingestion.redaction.rejectedPaths, ["host.password", "token"]);
  assert.match(ingestion.snapshotHash, /^[a-f0-9]{64}$/);
  assert.ok(!serialized.includes("SECRET_PASSWORD"));
  assert.ok(!serialized.includes("SECRET_TOKEN"));
  assert.equal(ingestion.auditEventCandidate.action, "collector.manual_snapshot_ingested");
  assert.equal(ingestion.auditEventCandidate.riskLevel, "medium");
  assert.equal(ingestion.auditEventCandidate.metadata.storesRawPayload, false);
  assert.equal(ingestion.auditEventCandidate.metadata.liveInfrastructureWritesEnabled, false);
});

test("manual snapshot parses physical host and telemetry without enabling live writes", () => {
  const ingestion = ingestManualCollectorSnapshot({
    actorId: "operator_delivrix",
    now: fixedNow,
    rawSnapshot: {
      host: {
        vendor: "IBM/Lenovo",
        model: "IBM System x3630 M4",
        operatingSystem: "Ubuntu Server 24.04 LTS",
        kernelVersion: "6.8.0",
        proxmoxVersion: "8.2",
        uptimeSeconds: 3600
      },
      capacity: {
        cpuCores: 24,
        cpuThreads: 48,
        memoryGb: 256,
        storageUsableGb: 4000,
        networkInterfaces: 4,
        ipPoolSize: 16
      },
      telemetry: {
        cpu: {
          usagePercent: 12,
          temperatureCelsius: 55,
          loadAverage: [0.4, 0.6, 0.8]
        },
        memory: {
          totalGb: 256,
          usedGb: 90,
          availableGb: 166,
          usagePercent: 35
        },
        storage: {
          totalGb: 4000,
          usedGb: 800,
          availableGb: 3200,
          usagePercent: 20,
          smartStatus: "healthy"
        },
        network: {
          rxMbps: 1.2,
          txMbps: 0.8,
          latencyMs: 3
        },
        power: {
          watts: 450,
          psuStatus: "healthy",
          fanStatus: "healthy",
          chassisTemperatureCelsius: 34
        }
      }
    }
  });

  assert.equal(ingestion.status, "accepted");
  assert.equal(ingestion.parsed.physicalHost.identity.model, "IBM System x3630 M4");
  assert.equal(ingestion.parsed.physicalHost.capacity.cpuCores, 24);
  assert.equal(ingestion.parsed.physicalHost.capacity.networkInterfaces, 4);
  assert.equal(ingestion.parsed.physicalHost.readiness.status, "ready");
  assert.equal(ingestion.parsed.telemetry.summary.stale, false);
  assert.equal(ingestion.parsed.telemetry.cpu.usagePercent, 12);
  assert.equal(ingestion.parsed.telemetry.memory.usagePercent, 35);
  assert.equal(ingestion.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(ingestion.safety.sshEnabled, false);
  assert.equal(ingestion.safety.smtpEnabled, false);
  assert.equal(ingestion.safety.nfcWritesEnabled, false);
  assert.equal(ingestion.auditEventCandidate.riskLevel, "low");
});

test("manual snapshot ingestion rejects non-object or unrecognized payloads", () => {
  const rejectedArray = ingestManualCollectorSnapshot({
    actorId: "operator_delivrix",
    now: fixedNow,
    rawSnapshot: ["not", "a", "snapshot"]
  });
  const rejectedObject = ingestManualCollectorSnapshot({
    actorId: "operator_delivrix",
    now: fixedNow,
    rawSnapshot: {
      notes: "no supported fields"
    }
  });

  assert.equal(rejectedArray.status, "rejected");
  assert.ok(rejectedArray.blockedBy.includes("snapshot_payload_must_be_object"));
  assert.equal(rejectedObject.status, "rejected");
  assert.ok(rejectedObject.blockedBy.includes("snapshot_has_no_recognized_operational_fields"));
  assert.equal(rejectedObject.auditEventCandidate.riskLevel, "high");
});
