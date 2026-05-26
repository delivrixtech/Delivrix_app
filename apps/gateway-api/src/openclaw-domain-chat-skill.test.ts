import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainInventoryAnswer,
  isDomainInventoryIntent
} from "./openclaw-domain-chat-skill.ts";

test("domain chat skill detects Spanish domain inventory requests", () => {
  assert.equal(isDomainInventoryIntent("enlistame los 16 dominios de ionos"), true);
  assert.equal(isDomainInventoryIntent("necesito que me enlistes los 16 dominios de IONOS"), true);
  assert.equal(isDomainInventoryIntent("Como asi, no puedes enlistarme los dominios?"), true);
  assert.equal(isDomainInventoryIntent("necesito revisar DNS de dominios"), true);
  assert.equal(isDomainInventoryIntent("continua con el plan"), false);
});

test("domain chat skill builds deterministic IONOS inventory answer", () => {
  const answer = buildDomainInventoryAnswer({
    source: {
      kind: "live",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true,
      tenantConfigured: false
    },
    domains: [
      {
        id: "d-2",
        name: "filecorppro.net",
        status: "ACTIVE",
        autoRenew: true,
        expiresAt: "2027-01-01",
        nameservers: []
      },
      {
        id: "d-1",
        name: "nfcorpreport.com",
        status: "ACTIVE",
        autoRenew: false,
        nameservers: []
      }
    ]
  }, {
    source: {
      kind: "live",
      apiKind: "hosting-dns",
      apiBase: "https://api.hosting.ionos.com/dns",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true
    },
    zones: [
      {
        id: "z-1",
        name: "nfcorpreport.com",
        records: [
          { id: "a-1", name: "@", type: "A", content: "203.0.113.10" },
          { id: "mx-1", name: "@", type: "MX", content: "mail.nfcorpreport.com" }
        ]
      }
    ]
  }, new Date("2026-05-26T02:05:00.000Z"));

  assert.match(answer, /Encontré 2 dominios registrados en IONOS/);
  assert.match(answer, /1\. filecorppro\.net/);
  assert.match(answer, /2\. nfcorpreport\.com/);
  assert.match(answer, /1 dominios tienen al menos A \+ MX/);
  assert.match(answer, /No hice compras, no cambie DNS/);
});
