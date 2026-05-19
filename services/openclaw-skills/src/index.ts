import type { SkillModule } from "./types.js";
import reportOps from "./skills/delivrix-report-ops/index.js";

const managedSkillRef = (
  slug: string,
  displayName: string,
  triggerPhrases: string[],
  declaredActions: string[],
  modelHint = "rules-engine"
): SkillModule => ({
  descriptor: {
    slug,
    displayName,
    description: "Managed OpenClaw skill loaded by the Hostinger runtime.",
    triggerPhrases,
    declaredActions,
    schemaVersion: "2026-05-18.v1",
    modelHint
  }
});

export const webdockInventorySync = managedSkillRef(
  "webdock-inventory-sync",
  "Delivrix · Webdock inventory sync",
  ["que tengo en webdock", "webdock inventory"],
  ["read_webdock_inventory"]
);

export const fleetOps = managedSkillRef(
  "delivrix-fleet-ops",
  "Delivrix · Fleet operations",
  ["como va la flota", "fleet status"],
  ["read_fleet_status"]
);

export const alertOps = managedSkillRef(
  "delivrix-alert-ops",
  "Delivrix · Alert operations",
  ["esta pasando algo malo", "alert status"],
  ["read_alerts"]
);

export const driftMonitor = managedSkillRef(
  "drift-monitor",
  "Delivrix · Drift monitor",
  ["detectar drift", "drift monitor"],
  ["submit_drift_proposals"]
);

export const publishProposal = managedSkillRef(
  "delivrix-publish-proposal",
  "Delivrix · Publish proposal",
  ["publicar propuesta", "submit proposal", "proponer pausa", "proponer warming"],
  [
    "propose_register_sender_node",
    "propose_warming_step",
    "propose_pause_ip",
    "propose_quarantine",
    "update_sender_node_metadata",
    "record_human_decision"
  ],
  "hmac-publisher"
);

export const skills: SkillModule[] = [
  driftMonitor,
  alertOps,
  fleetOps,
  webdockInventorySync,
  reportOps,
  publishProposal
];

export default skills;
